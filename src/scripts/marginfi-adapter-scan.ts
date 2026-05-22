import "dotenv/config";
import dotenv from "dotenv";
import fs from "node:fs";
import { Keypair, PublicKey } from "@solana/web3.js";
import { MarginfiClient, getConfig } from "@mrgnlabs/marginfi-client-v2";
import { NodeWallet } from "@mrgnlabs/mrgn-common";
import { loadConfig } from "../config.js";
import { connectionFor } from "../utils/rpc.js";
import { writeReceipt } from "../utils/receipt.js";

if (process.env.ENV_PATH) {
  dotenv.config({ path: process.env.ENV_PATH, override: true });
}

function loadKeypair(file: string): Keypair {
  return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(file, "utf8")) as number[]));
}

function pubkeyOf(value: unknown): string | null {
  if (value instanceof PublicKey) return value.toBase58();
  if (value && typeof value === "object" && "toBase58" in value && typeof (value as any).toBase58 === "function") {
    return (value as any).toBase58();
  }
  return null;
}

function bankSummary(bank: any) {
  if (!bank) return null;
  return {
    address: pubkeyOf(bank.address) ?? pubkeyOf(bank.publicKey) ?? null,
    mint: pubkeyOf(bank.mint) ?? pubkeyOf(bank.mintAddress) ?? pubkeyOf(bank.tokenMint) ?? null,
    tokenSymbol: bank.tokenSymbol ?? bank.config?.tokenSymbol ?? null,
    rawKeys: Object.keys(bank).slice(0, 40)
  };
}

function pubkeyAt(data: Buffer, offset: number): PublicKey {
  return new PublicKey(data.subarray(offset, offset + 32));
}

async function rawUsdcBankFallback(args: {
  connection: ReturnType<typeof connectionFor>;
  programId: PublicKey;
  groupPk: PublicKey;
  usdcMint: PublicKey;
}) {
  const bankDiscriminator = Buffer.from([142, 49, 166, 242, 50, 66, 97, 188]);
  const accounts = await args.connection.getProgramAccounts(args.programId, {
    filters: [{ dataSize: 1864 }]
  });
  const candidates = accounts.flatMap(({ pubkey, account }) => {
    const data = account.data;
    if (!data.subarray(0, 8).equals(bankDiscriminator)) return [];
    const mint = pubkeyAt(data, 8);
    if (!mint.equals(args.usdcMint)) return [];
    const group = pubkeyAt(data, 41);
    if (!group.equals(args.groupPk)) return [];
    return [{
      address: pubkey,
      mint,
      group,
      liquidityVault: pubkeyAt(data, 112)
    }];
  });

  const withLiquidity = [];
  for (let i = 0; i < candidates.length; i += 100) {
    const batch = candidates.slice(i, i + 100);
    const infos = await args.connection.getMultipleAccountsInfo(batch.map((candidate) => candidate.liquidityVault), "confirmed");
    for (let j = 0; j < batch.length; j += 1) {
      const info = infos[j];
      const amountMicro = info?.data && info.data.length >= 72
        ? info.data.readBigUInt64LE(64)
        : 0n;
      withLiquidity.push({
        address: batch[j].address.toBase58(),
        mint: batch[j].mint.toBase58(),
        group: batch[j].group.toBase58(),
        liquidityVault: batch[j].liquidityVault.toBase58(),
        liquidityUsdc: Number(amountMicro) / 1e6
      });
    }
  }

  return withLiquidity.sort((a, b) => b.liquidityUsdc - a.liquidityUsdc);
}

async function main() {
  const config = loadConfig();
  const connection = connectionFor(config.rpcUrl);
  const crank = loadKeypair(process.env.CRANK_KEYPAIR_PATH || "keys/crank.json");
  const wallet = new NodeWallet(crank as any);
  const marginfiConfig = getConfig("production");
  const blockers: string[] = [];

  let client: MarginfiClient | null = null;
  let usdcBank: any = null;
  let authorityAccounts: any[] = [];
  let rawFallbackBanks: Awaited<ReturnType<typeof rawUsdcBankFallback>> = [];
  const localMarginfiAccountPath = process.env.MARGINFI_ACCOUNT_KEYPAIR_PATH || "keys/marginfi-account.json";
  let localMarginfiAccount: Record<string, unknown> | null = null;
  try {
    client = await MarginfiClient.fetch(marginfiConfig, wallet as any, connection as any, {
      readOnly: true
    } as any);
    usdcBank =
      client.getBankByMint(config.usdcMint as any) ??
      client.getBankByTokenSymbol("USDC") ??
      null;
    authorityAccounts = await client.getMarginfiAccountsForAuthority(crank.publicKey as any);
    if (!usdcBank) blockers.push("USDC bank not found in Marginfi production client");
  } catch (error: any) {
    blockers.push(`Marginfi fetch failed: ${error?.message ?? String(error)}`);
  }

  if (!usdcBank) {
    rawFallbackBanks = await rawUsdcBankFallback({
      connection,
      programId: marginfiConfig.programId,
      groupPk: marginfiConfig.groupPk,
      usdcMint: config.usdcMint
    });
    if (rawFallbackBanks.length > 0) {
      const missingBankIndex = blockers.indexOf("USDC bank not found in Marginfi production client");
      if (missingBankIndex >= 0) blockers.splice(missingBankIndex, 1);
    }
  }

  if (authorityAccounts.length === 0) {
    if (fs.existsSync(localMarginfiAccountPath)) {
      const localKeypair = loadKeypair(localMarginfiAccountPath);
      const info = await connection.getAccountInfo(localKeypair.publicKey, "confirmed");
      localMarginfiAccount = {
        address: localKeypair.publicKey.toBase58(),
        exists: Boolean(info),
        owner: info?.owner.toBase58() ?? null,
        lamports: info?.lamports ?? null,
        dataLength: info?.data.length ?? null
      };
      if (!info) blockers.push("local Marginfi account keypair exists but account is missing on-chain");
    } else {
      blockers.push("RedemptionArc crank has no Marginfi account yet");
    }
  }

  const sdkFetchFailed = blockers.find((blocker) => blocker.startsWith("Marginfi fetch failed:"));
  if (
    sdkFetchFailed &&
    localMarginfiAccount?.exists === true &&
    rawFallbackBanks.length > 0
  ) {
    blockers.splice(blockers.indexOf(sdkFetchFailed), 1);
  }

  const receipt = {
    verdict: blockers.length === 0
      ? "MARGINFI_ADAPTER_SCAN_READY_RAW_PATH"
      : "MARGINFI_ADAPTER_SCAN_NEEDS_ACCOUNT_OR_FIX",
    generatedAt: new Date().toISOString(),
    mode: "read-only; no transaction sent",
    marginfi: {
      environment: marginfiConfig.environment,
      groupPk: marginfiConfig.groupPk.toBase58(),
      programId: marginfiConfig.programId.toBase58()
    },
    redemptionAuthority: crank.publicKey.toBase58(),
    usdcMint: config.usdcMint.toBase58(),
    usdcBank: bankSummary(usdcBank),
    rawFallbackTopUsdcBanks: rawFallbackBanks.slice(0, 10),
    authorityAccounts: authorityAccounts.map((account: any) => ({
      address: pubkeyOf(account.address) ?? null,
      authority: pubkeyOf(account.authority) ?? null
    })),
    localMarginfiAccount,
    adapterShape: [
      "create/fetch RedemptionArc Marginfi account",
      "build begin flashloan ix with endIndex",
      "insert RedemptionArc TX body",
      "build end flashloan ix with projected active balances",
      "simulate exact v0 transaction with total-system post balances"
    ],
    blockers,
    next: blockers.length === 0
      ? "Implement raw Marginfi flash wrapper no-send around the current RedemptionArc body."
      : "Create a RedemptionArc-owned Marginfi account in a separate exact approved setup tx, or fix client fetch."
  };

  const out = writeReceipt("REDEMPTION-MARGINFI-ADAPTER-SCAN-LATEST.json", receipt);
  console.log(`${receipt.verdict} accounts=${authorityAccounts.length} usdcBank=${receipt.usdcBank?.address ?? "missing"} receipt=${out}`);
  if (blockers.length > 0) process.exitCode = 1;
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
