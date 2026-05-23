import "dotenv/config";
import {
  ComputeBudgetProgram,
  PublicKey,
  Transaction,
  sendAndConfirmTransaction
} from "@solana/web3.js";
import {
  createAssociatedTokenAccountIdempotentInstruction,
  createWithdrawWithheldTokensFromAccountsInstruction,
  getAccount,
  getAssociatedTokenAddressSync,
  getMint,
  getTransferFeeAmount,
  getTransferFeeConfig,
  TOKEN_2022_PROGRAM_ID
} from "@solana/spl-token";
import { HOP_MINT_DEFAULT } from "../constants.js";
import { loadConfig } from "../config.js";
import { connectionFor } from "../utils/rpc.js";
import { writeReceipt } from "../utils/receipt.js";
import { assertKeypairMatches, ensureKeypair, loadKeypair } from "../utils/keypair.js";
import { assertLiveAllowed, assertNoForbiddenConfigured, uniqueSigners } from "../utils/safety.js";
import { serializableInstruction } from "../utils/orca-whirlpool.js";

async function quoteHopToUsdc(hopMint: PublicKey, usdcMint: PublicKey, amount: bigint) {
  if (amount <= 0n) return null;
  const jupiterApi = process.env.JUPITER_API || "https://quote-api.jup.ag/v6";
  try {
    const url = `${jupiterApi}/quote?inputMint=${hopMint.toBase58()}&outputMint=${usdcMint.toBase58()}&amount=${amount}&slippageBps=${process.env.JUPITER_SLIPPAGE_BPS || "100"}`;
    const res = await fetch(url, { headers: { accept: "application/json" } });
    if (!res.ok) return { ok: false, status: res.status, error: (await res.text()).slice(0, 240) };
    const json = await res.json();
    if ((json as { error?: string }).error) return { ok: false, error: (json as { error: string }).error };
    return {
      ok: true,
      outAmount: (json as { outAmount: string }).outAmount,
      outUsdc: Number((json as { outAmount: string }).outAmount) / 1e6,
      routePlanLabels: ((json as { routePlan?: Array<{ swapInfo?: { label?: string } }> }).routePlan ?? []).map((r) => r.swapInfo?.label)
    };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

async function main() {
  const config = loadConfig();
  assertNoForbiddenConfigured(config);
  assertLiveAllowed(config);
  if (!config.crank || !config.withdrawAuthority) {
    throw new Error("Missing REDEMPTION_CRANK or REDEMPTION_WITHDRAW_AUTHORITY");
  }

  const hopMint = new PublicKey(process.env.RING_HOP_MINT || process.env.HOP_MINT || HOP_MINT_DEFAULT);
  const connection = connectionFor(config.rpcUrl);
  const funder = loadKeypair(process.env.CRANK_KEYPAIR_PATH || "keys/crank.json");
  const withdrawAuthority = loadKeypair(process.env.WITHDRAW_AUTHORITY_KEYPAIR_PATH ||
    (config.withdrawAuthority.equals(config.crank) ? process.env.CRANK_KEYPAIR_PATH || "keys/crank.json" : "keys/withdraw-authority.json"));
  assertKeypairMatches("crank", funder, config.crank);
  assertKeypairMatches("withdraw authority", withdrawAuthority, config.withdrawAuthority);

  const botCount = Number(process.env.RING_BOT_COUNT || "4");
  const bots = Array.from({ length: botCount }, (_, index) =>
    ensureKeypair(process.env[`BOT_${index + 1}_KEYPAIR_PATH`] || `keys/bot-${index + 1}.json`, { useSolanaKeygen: true })
  );
  const sourceAtas = bots.map((bot) => getAssociatedTokenAddressSync(hopMint, bot.publicKey, false, TOKEN_2022_PROGRAM_ID));
  const destinationAta = getAssociatedTokenAddressSync(hopMint, withdrawAuthority.publicKey, false, TOKEN_2022_PROGRAM_ID);

  const mintInfo = await getMint(connection, hopMint, "confirmed", TOKEN_2022_PROGRAM_ID);
  const transferFeeConfig = getTransferFeeConfig(mintInfo);
  const onChainWithdrawAuthority = transferFeeConfig?.withdrawWithheldAuthority;
  if (!onChainWithdrawAuthority?.equals(withdrawAuthority.publicKey)) {
    throw new Error(
      `withdraw authority mismatch: on-chain=${onChainWithdrawAuthority?.toBase58() ?? "none"} signer=${withdrawAuthority.publicKey.toBase58()}`
    );
  }

  const sourceStates = [];
  let totalWithheld = 0n;
  const existingSources: PublicKey[] = [];
  for (const [index, ata] of sourceAtas.entries()) {
    try {
      const account = await getAccount(connection, ata, "confirmed", TOKEN_2022_PROGRAM_ID);
      const transferFeeAmount = getTransferFeeAmount(account);
      const withheld = transferFeeAmount?.withheldAmount ?? 0n;
      totalWithheld += withheld;
      existingSources.push(ata);
      sourceStates.push({
        bot: index + 1,
        owner: bots[index].publicKey.toBase58(),
        ata: ata.toBase58(),
        exists: true,
        amount: account.amount.toString(),
        withheldAmount: withheld.toString()
      });
    } catch (error) {
      sourceStates.push({
        bot: index + 1,
        owner: bots[index].publicKey.toBase58(),
        ata: ata.toBase58(),
        exists: false,
        error: error instanceof Error ? error.message : String(error)
      });
    }
  }

  const quote = await quoteHopToUsdc(hopMint, config.usdcMint, totalWithheld);
  const receipt: Record<string, unknown> = {
    verdict: "HARVEST_WITHHELD_PLAN_BUILT",
    generatedAt: new Date().toISOString(),
    dryRun: config.dryRun,
    allowLive: config.allowLive,
    liveTxApproved: process.env.LIVE_TX_APPROVED === "true",
    hopMint: hopMint.toBase58(),
    withdrawAuthority: withdrawAuthority.publicKey.toBase58(),
    destinationAta: destinationAta.toBase58(),
    hop_harvested: Number(totalWithheld) / 1e6,
    harvestedRaw: totalWithheld.toString(),
    usdc_equivalent: quote && "outUsdc" in quote ? quote.outUsdc : null,
    jupiterQuote: quote,
    sources: sourceStates
  };

  if (existingSources.length === 0 || totalWithheld === 0n) {
    receipt.verdict = existingSources.length === 0 ? "HARVEST_WITHHELD_NO_SOURCE_ACCOUNTS" : "HARVEST_WITHHELD_ZERO";
    const out = writeReceipt("HARVEST-WITHHELD-LATEST.json", receipt);
    console.log(`hop_harvested=${receipt.hop_harvested} usdc_equivalent=${receipt.usdc_equivalent} gas_cost=0 receipt=${out}`);
    return;
  }

  const cuLimit = Number(process.env.CU_LIMIT || "200000");
  const cuPrice = Number(process.env.CU_PRICE || "1000");
  const ixCreateDestination = createAssociatedTokenAccountIdempotentInstruction(
    funder.publicKey,
    destinationAta,
    withdrawAuthority.publicKey,
    hopMint,
    TOKEN_2022_PROGRAM_ID
  );
  const ixWithdraw = createWithdrawWithheldTokensFromAccountsInstruction(
    hopMint,
    destinationAta,
    withdrawAuthority.publicKey,
    [],
    existingSources,
    TOKEN_2022_PROGRAM_ID
  );
  const ixs = [
    ComputeBudgetProgram.setComputeUnitLimit({ units: cuLimit }),
    ComputeBudgetProgram.setComputeUnitPrice({ microLamports: cuPrice }),
    ixCreateDestination,
    ixWithdraw
  ];
  const tx = new Transaction().add(...ixs);
  tx.feePayer = funder.publicKey;
  tx.recentBlockhash = (await connection.getLatestBlockhash("confirmed")).blockhash;

  const signerPubkeys = new Set(ixs.flatMap((ix) => ix.keys.filter((key) => key.isSigner).map((key) => key.pubkey.toBase58())));
  const signers = uniqueSigners([funder, withdrawAuthority], signerPubkeys);
  tx.sign(...signers);
  const sim = await connection.simulateTransaction(tx);

  const priorityFeeLamports = BigInt(cuLimit) * BigInt(cuPrice) / 1_000_000n;
  const baseFeeLamports = BigInt(signers.length) * 5000n;
  const gasLamports = baseFeeLamports + priorityFeeLamports;
  receipt.gas_cost = Number(gasLamports) / 1e9;
  receipt.gasLamports = gasLamports.toString();
  receipt.simulation = {
    err: sim.value.err ?? null,
    unitsConsumed: sim.value.unitsConsumed ?? null,
    logs: sim.value.logs ?? []
  };
  receipt.instructions = ixs.map(serializableInstruction);

  if (sim.value.err) {
    receipt.verdict = "HARVEST_WITHHELD_SIM_FAILED";
    const out = writeReceipt("HARVEST-WITHHELD-LATEST.json", receipt);
    console.log(`hop_harvested=${receipt.hop_harvested} usdc_equivalent=${receipt.usdc_equivalent} gas_cost=${receipt.gas_cost} receipt=${out}`);
    process.exitCode = 1;
    return;
  }

  if (config.dryRun) {
    receipt.verdict = "HARVEST_WITHHELD_SIM_OK_DRY_RUN";
    const out = writeReceipt("HARVEST-WITHHELD-LATEST.json", receipt);
    console.log(`hop_harvested=${receipt.hop_harvested} usdc_equivalent=${receipt.usdc_equivalent} gas_cost=${receipt.gas_cost} receipt=${out}`);
    return;
  }

  const signature = await sendAndConfirmTransaction(connection, tx, signers, { commitment: "confirmed" });
  receipt.verdict = "HARVEST_WITHHELD_EXECUTED";
  receipt.signature = signature;
  const out = writeReceipt("HARVEST-WITHHELD-LATEST.json", receipt);
  console.log(`hop_harvested=${receipt.hop_harvested} usdc_equivalent=${receipt.usdc_equivalent} gas_cost=${receipt.gas_cost} sig=${signature} receipt=${out}`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
