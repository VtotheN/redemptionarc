/**
 * No-send multi-bot owned-fee cycle simulator.
 *
 * Consumes ORCA-OWNED-FEE-SOURCE-SCAN-LATEST.json and models STACC's
 * intended shape: many bots create/route flow through controlled fee venues.
 * It reports two ledgers:
 *
 * - collectorLedger: fee authority wallet only.
 * - totalSystemLedger: controlled bot wallets + fee authority + settlement.
 *
 * A controlled-bot-only loop is blocked unless the total system is positive.
 */
import "dotenv/config";
import dotenv from "dotenv";
import fs from "node:fs";
import path from "node:path";
import {
  ComputeBudgetProgram,
  PublicKey,
  Transaction,
  TransactionInstruction,
} from "@solana/web3.js";
import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  createAssociatedTokenAccountIdempotentInstruction,
  getAssociatedTokenAddressSync,
  TOKEN_2022_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
} from "@solana/spl-token";
import { Keypair } from "@solana/web3.js";
import { loadConfig } from "../config.js";
import { loadKeypair, publicKeyFromKeypairFile } from "../utils/keypair.js";
import { connectionFor } from "../utils/rpc.js";
import { writeReceipt } from "../utils/receipt.js";

if (process.env.ENV_PATH) {
  dotenv.config({ path: process.env.ENV_PATH, override: true });
}

const COLLECT_PROTOCOL_FEES_V2_DISC = Buffer.from([0x67, 0x80, 0xde, 0x86, 0x72, 0xc8, 0x16, 0xc8]);
const SPL_MEMO_PROGRAM_ID = new PublicKey("MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr");

type ScanPool = {
  program: string;
  programLabel: string;
  whirlpool: string;
  config: string;
  collectProtocolFeesAuthority: string | null;
  controlStatus: string;
  directLocalCollect: boolean;
  tickSpacing: number | null;
  feeRate: number | null;
  protocolFeeRate: number | null;
  liquidity: string | null;
  active: boolean;
  tokenA: {
    mint: string | null;
    vault: string | null;
    mintMeta: {
      ownerProgram: string | null;
      decimals: number | null;
      symbol: string;
      cashClass: string;
    } | null;
    protocolFeeOwedRaw: string | null;
    protocolFeeOwedUi: number | null;
    protocolFeeOwedCashUsd: number | null;
  };
  tokenB: {
    mint: string | null;
    vault: string | null;
    mintMeta: {
      ownerProgram: string | null;
      decimals: number | null;
      symbol: string;
      cashClass: string;
    } | null;
    protocolFeeOwedRaw: string | null;
    protocolFeeOwedUi: number | null;
    protocolFeeOwedCashUsd: number | null;
  };
  cashClaimableUsd: number;
  cashTvlUsd: number;
  hasClaimableProtocolFees: boolean;
  hasUnknownClaimable: boolean;
  executionClass: string;
};

type ScanReceipt = {
  verdict: string;
  generatedAt: string;
  solPriceUsd: number | null;
  pools: ScanPool[];
};

function envCsv(name: string): string[] {
  return (process.env[name] || "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
}

function numberEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) throw new Error(`Invalid ${name}=${raw}`);
  return parsed;
}

function boolEnv(name: string, fallback: boolean): boolean {
  const raw = process.env[name];
  if (!raw) return fallback;
  return ["1", "true", "yes", "y"].includes(raw.toLowerCase());
}

function readJson<T>(file: string): T {
  return JSON.parse(fs.readFileSync(file, "utf8")) as T;
}

function loadLocalSignerPubkeys(paths: string[]) {
  const out = new Map<string, { path: string; label: string }>();
  for (const keypairPath of paths) {
    if (!fs.existsSync(keypairPath)) continue;
    try {
      const pubkey = publicKeyFromKeypairFile(keypairPath).toBase58();
      out.set(pubkey, { path: keypairPath, label: path.basename(keypairPath) });
    } catch {
      // Ignore malformed/non-keypair JSON.
    }
  }
  return out;
}

function loadSignerFor(pubkey: string, signers: Map<string, { path: string; label: string }>): Keypair | null {
  const entry = signers.get(pubkey);
  if (!entry) return null;
  const signer = loadKeypair(entry.path);
  return signer.publicKey.toBase58() === pubkey ? signer : null;
}

function tokenProgram(meta: ScanPool["tokenA"]["mintMeta"]): PublicKey {
  const owner = meta?.ownerProgram;
  if (owner === TOKEN_2022_PROGRAM_ID.toBase58()) return TOKEN_2022_PROGRAM_ID;
  return TOKEN_PROGRAM_ID;
}

function collectProtocolFeesV2Ix(pool: ScanPool, authority: PublicKey, destA: PublicKey, destB: PublicKey): TransactionInstruction {
  if (!pool.tokenA.mint || !pool.tokenA.vault || !pool.tokenB.mint || !pool.tokenB.vault) {
    throw new Error(`Pool ${pool.whirlpool} is missing token/vault accounts`);
  }
  return new TransactionInstruction({
    programId: new PublicKey(pool.program),
    keys: [
      { pubkey: new PublicKey(pool.config), isSigner: false, isWritable: false },
      { pubkey: new PublicKey(pool.whirlpool), isSigner: false, isWritable: true },
      { pubkey: authority, isSigner: true, isWritable: false },
      { pubkey: new PublicKey(pool.tokenA.mint), isSigner: false, isWritable: false },
      { pubkey: new PublicKey(pool.tokenB.mint), isSigner: false, isWritable: false },
      { pubkey: new PublicKey(pool.tokenA.vault), isSigner: false, isWritable: true },
      { pubkey: new PublicKey(pool.tokenB.vault), isSigner: false, isWritable: true },
      { pubkey: destA, isSigner: false, isWritable: true },
      { pubkey: destB, isSigner: false, isWritable: true },
      { pubkey: tokenProgram(pool.tokenA.mintMeta), isSigner: false, isWritable: false },
      { pubkey: tokenProgram(pool.tokenB.mintMeta), isSigner: false, isWritable: false },
      { pubkey: SPL_MEMO_PROGRAM_ID, isSigner: false, isWritable: false },
    ],
    data: Buffer.concat([COLLECT_PROTOCOL_FEES_V2_DISC, Buffer.from([0x00])]),
  });
}

function lamportCostUsd(args: {
  txCount: number;
  cuLimit: number;
  cuPriceMicroLamports: number;
  jitoTipLamports: number;
  solPriceUsd: number;
}) {
  const priorityLamports = Math.ceil(args.cuLimit * args.cuPriceMicroLamports / 1_000_000);
  const lamportsPerTx = 5_000 + priorityLamports + args.jitoTipLamports;
  return {
    txCount: args.txCount,
    lamportsPerTx,
    totalLamports: lamportsPerTx * args.txCount,
    usd: lamportsPerTx * args.txCount / 1e9 * args.solPriceUsd,
  };
}

async function simulateExistingCollect(args: {
  pool: ScanPool;
  signer: Keypair;
  cuLimit: number;
  cuPriceMicroLamports: number;
}) {
  const connection = connectionFor(loadConfig().rpcUrl);
  if (!args.pool.tokenA.mint || !args.pool.tokenB.mint) return null;
  const authority = args.signer.publicKey;
  const mintA = new PublicKey(args.pool.tokenA.mint);
  const mintB = new PublicKey(args.pool.tokenB.mint);
  const programA = tokenProgram(args.pool.tokenA.mintMeta);
  const programB = tokenProgram(args.pool.tokenB.mintMeta);
  const destA = getAssociatedTokenAddressSync(mintA, authority, false, programA, ASSOCIATED_TOKEN_PROGRAM_ID);
  const destB = getAssociatedTokenAddressSync(mintB, authority, false, programB, ASSOCIATED_TOKEN_PROGRAM_ID);
  const [destAInfo, destBInfo] = await Promise.all([
    connection.getAccountInfo(destA, "confirmed"),
    connection.getAccountInfo(destB, "confirmed"),
  ]);
  const ixs: TransactionInstruction[] = [
    ComputeBudgetProgram.setComputeUnitLimit({ units: args.cuLimit }),
    ComputeBudgetProgram.setComputeUnitPrice({ microLamports: args.cuPriceMicroLamports }),
  ];
  if (!destAInfo) {
    ixs.push(createAssociatedTokenAccountIdempotentInstruction(authority, destA, authority, mintA, programA, ASSOCIATED_TOKEN_PROGRAM_ID));
  }
  if (!destBInfo && !destA.equals(destB)) {
    ixs.push(createAssociatedTokenAccountIdempotentInstruction(authority, destB, authority, mintB, programB, ASSOCIATED_TOKEN_PROGRAM_ID));
  }
  ixs.push(collectProtocolFeesV2Ix(args.pool, authority, destA, destB));

  const tx = new Transaction().add(...ixs);
  tx.feePayer = authority;
  tx.recentBlockhash = (await connection.getLatestBlockhash("confirmed")).blockhash;
  tx.sign(args.signer);
  const sim = await connection.simulateTransaction(tx);
  return {
    authority: authority.toBase58(),
    destinationA: destA.toBase58(),
    destinationB: destB.toBase58(),
    createdDestinationA: !destAInfo,
    createdDestinationB: !destBInfo && !destA.equals(destB),
    instructionCount: ixs.length,
    err: sim.value.err ?? null,
    unitsConsumed: sim.value.unitsConsumed ?? null,
    logs: sim.value.logs?.slice(-20) ?? [],
    serializedInstructions: ixs.map((ix) => ({
      programId: ix.programId.toBase58(),
      keys: ix.keys.map((key) => ({
        pubkey: key.pubkey.toBase58(),
        isSigner: key.isSigner,
        isWritable: key.isWritable,
      })),
      dataHex: Buffer.from(ix.data).toString("hex"),
    })),
  };
}

function candidateScore(pool: ScanPool): number {
  return (pool.cashClaimableUsd || 0) * 1_000_000 + (pool.active ? 1 : 0) * (pool.cashTvlUsd || 0) + (pool.feeRate || 0);
}

async function main() {
  const config = loadConfig();
  const scanFile = process.env.OWNED_FEE_SCAN_RECEIPT || "receipts/ORCA-OWNED-FEE-SOURCE-SCAN-LATEST.json";
  const scan = readJson<ScanReceipt>(scanFile);
  const solPriceUsd = config.solPriceUsd ?? scan.solPriceUsd ?? numberEnv("SOL_PRICE_USD", 0);
  if (!solPriceUsd) throw new Error("Missing SOL price; run source scan with Jupiter available or set SOL_PRICE_USD");

  const botCount = numberEnv("BOT_COUNT", 4);
  const rounds = numberEnv("BOT_ROUNDS", 10);
  const tradeNotionalUsd = numberEnv("BOT_TRADE_NOTIONAL_USD", 10);
  const mode = process.env.BOT_COUNTERPARTY_MODE || "controlled";
  const externalFlowShare = mode === "external"
    ? 1
    : mode === "mixed"
      ? Math.min(1, Math.max(0, numberEnv("EXTERNAL_FLOW_SHARE", 0.5)))
      : 0;
  const ownedFullLp = boolEnv("OWN_FULL_LP", false);
  const countOwnedLpFeesAsCash = boolEnv("COUNT_OWNED_LP_FEES_AS_CASH", false);
  const assumePriceNeutralBots = boolEnv("ASSUME_PRICE_NEUTRAL_BOTS", false);
  const inventoryRiskBps = process.env.INVENTORY_RISK_BPS ? numberEnv("INVENTORY_RISK_BPS", 0) : null;
  const cuLimit = numberEnv("OWNED_FEE_CU_LIMIT", 350_000);
  const cuPriceMicroLamports = numberEnv("OWNED_FEE_CU_PRICE_MICRO_LAMPORTS", 1_000);
  const jitoTipLamports = numberEnv("JITO_TIP_LAMPORTS", 0);
  const minNetUsd = numberEnv("MIN_NET_USD", config.minNetUsd);
  const targetPool = process.env.TARGET_WHIRLPOOL;
  const maxCandidates = numberEnv("OWNED_FEE_SIM_CANDIDATES", 36);

  const signerPaths = [
    "keys/crank.json",
    "keys/kpx9-authority.json",
    "keys/orca-config.json",
    ...envCsv("OWNED_FEE_KEYPAIR_PATHS"),
  ].map((value) => path.resolve(value));
  const localSigners = loadLocalSignerPubkeys(signerPaths);

  const botWallets = ["keys/bot-1.json", "keys/bot-2.json", "keys/bot-3.json", "keys/bot-4.json"]
    .map((value) => path.resolve(value))
    .filter((value) => fs.existsSync(value))
    .map((value) => {
      try {
        return { label: path.basename(value), pubkey: publicKeyFromKeypairFile(value).toBase58() };
      } catch {
        return null;
      }
    })
    .filter((value): value is { label: string; pubkey: string } => value != null)
    .slice(0, botCount);

  const pools = scan.pools
    .filter((pool) => pool.active)
    .filter((pool) => !targetPool || pool.whirlpool === targetPool)
    .filter((pool) => pool.feeRate != null && pool.protocolFeeRate != null)
    .sort((a, b) => candidateScore(b) - candidateScore(a))
    .slice(0, maxCandidates);

  const grossVolumeUsd = botCount * rounds * tradeNotionalUsd;
  const controlledFlowShare = 1 - externalFlowShare;
  const ownedBotTxCount = Math.ceil(botCount * rounds * controlledFlowShare);
  const collectTxCount = 1;
  const ownedBotTxCost = lamportCostUsd({
    txCount: ownedBotTxCount,
    cuLimit,
    cuPriceMicroLamports,
    jitoTipLamports,
    solPriceUsd,
  });
  const collectTxCost = lamportCostUsd({
    txCount: collectTxCount,
    cuLimit,
    cuPriceMicroLamports,
    jitoTipLamports: 0,
    solPriceUsd,
  });

  const candidates = [];
  for (const pool of pools) {
    const feeRate = pool.feeRate ?? 0;
    const protocolFeeRate = pool.protocolFeeRate ?? 0;
    const existingCashClaimableUsd = pool.cashClaimableUsd || 0;
    const swapFeeUsd = grossVolumeUsd * feeRate / 1_000_000;
    const protocolFeeUsd = swapFeeUsd * protocolFeeRate / 10_000;
    const protocolCaptureRate = feeRate / 1_000_000 * protocolFeeRate / 10_000;
    const requiredExternalVolumeUsdForMinNet = protocolCaptureRate > 0
      ? Math.max(0, (minNetUsd + collectTxCost.usd - existingCashClaimableUsd) / protocolCaptureRate)
      : null;
    const lpFeeUsd = swapFeeUsd - protocolFeeUsd;
    const controlledSwapFeeUsd = swapFeeUsd * controlledFlowShare;
    const externalProtocolFeeUsd = protocolFeeUsd * externalFlowShare;
    const controlledProtocolSelfTransferUsd = protocolFeeUsd * controlledFlowShare;
    const controlledExternalLpLeakageUsd = ownedFullLp ? 0 : lpFeeUsd * controlledFlowShare;
    const ownedLpFeeAccrualUsd = ownedFullLp ? lpFeeUsd * controlledFlowShare : 0;
    const ownedLpCashCreditUsd = ownedFullLp && countOwnedLpFeesAsCash ? ownedLpFeeAccrualUsd : 0;
    const inventoryRiskUsd = controlledFlowShare === 0
      ? 0
      : assumePriceNeutralBots
        ? 0
        : inventoryRiskBps == null
          ? null
          : grossVolumeUsd * controlledFlowShare * inventoryRiskBps / 10_000;
    const inventoryRiskBlocksCashProof = controlledFlowShare > 0 && inventoryRiskUsd == null;
    const collectorLedgerNetUsd =
      existingCashClaimableUsd +
      protocolFeeUsd +
      ownedLpCashCreditUsd -
      collectTxCost.usd;
    const totalSystemNetUsd = inventoryRiskUsd == null
      ? null
      : existingCashClaimableUsd +
        externalProtocolFeeUsd +
        ownedLpCashCreditUsd -
        controlledExternalLpLeakageUsd -
        ownedBotTxCost.usd -
        collectTxCost.usd -
        inventoryRiskUsd;
    const noGoReasons = [];
    if (controlledFlowShare > 0 && !ownedFullLp) {
      noGoReasons.push("controlled bot volume leaks the LP fee share outside the controlled system unless we own the active LP");
    }
    if (controlledFlowShare > 0 && !assumePriceNeutralBots && inventoryRiskBps == null) {
      noGoReasons.push("controlled bot inventory drift/price impact is unpriced; set INVENTORY_RISK_BPS or prove exact neutral route");
    }
    if (totalSystemNetUsd == null || totalSystemNetUsd < minNetUsd) {
      noGoReasons.push(`total-system cash gate below MIN_NET_USD (${minNetUsd})`);
    }
    if (pool.hasUnknownClaimable) {
      noGoReasons.push("pool also has non-cash/unpriced claimable fees; not counted until settlement route is proven");
    }
    if (!pool.collectProtocolFeesAuthority || !localSigners.has(pool.collectProtocolFeesAuthority)) {
      noGoReasons.push("collect authority is not locally signable; direct collect is not executable by this wallet set");
    }

    let collectSimulation: Awaited<ReturnType<typeof simulateExistingCollect>> | { err: string } | null = null;
    if (pool.collectProtocolFeesAuthority && localSigners.has(pool.collectProtocolFeesAuthority) && existingCashClaimableUsd > 0) {
      const signer = loadSignerFor(pool.collectProtocolFeesAuthority, localSigners);
      if (signer) {
        try {
          collectSimulation = await simulateExistingCollect({ pool, signer, cuLimit, cuPriceMicroLamports });
          if (collectSimulation?.err) noGoReasons.push("existing-fee collect simulation failed");
        } catch (error) {
          collectSimulation = { err: error instanceof Error ? error.message : String(error) };
          noGoReasons.push("existing-fee collect simulation threw before completion");
        }
      }
    }

    const cashProofPass =
      totalSystemNetUsd != null &&
      totalSystemNetUsd >= minNetUsd &&
      noGoReasons.length === 0;

    candidates.push({
      whirlpool: pool.whirlpool,
      programLabel: pool.programLabel,
      program: pool.program,
      config: pool.config,
      controlStatus: pool.controlStatus,
      collectProtocolFeesAuthority: pool.collectProtocolFeesAuthority,
      directLocalCollect: pool.directLocalCollect,
      tokenA: {
        mint: pool.tokenA.mint,
        symbol: pool.tokenA.mintMeta?.symbol ?? "UNKNOWN",
        existingFeeUi: pool.tokenA.protocolFeeOwedUi,
        existingFeeCashUsd: pool.tokenA.protocolFeeOwedCashUsd,
      },
      tokenB: {
        mint: pool.tokenB.mint,
        symbol: pool.tokenB.mintMeta?.symbol ?? "UNKNOWN",
        existingFeeUi: pool.tokenB.protocolFeeOwedUi,
        existingFeeCashUsd: pool.tokenB.protocolFeeOwedCashUsd,
      },
      activeCashTvlUsd: pool.cashTvlUsd,
      feeRate,
      protocolFeeRate,
      multiBotTraffic: {
        botCount,
        rounds,
        tradeNotionalUsd,
        grossVolumeUsd,
        botCounterpartyMode: mode,
        externalFlowShare,
        controlledFlowShare,
      },
      feeMath: {
        protocolCaptureRate,
        requiredExternalVolumeUsdForMinNet,
        swapFeeUsd,
        protocolFeeUsd,
        lpFeeUsd,
        externalProtocolFeeUsd,
        controlledProtocolSelfTransferUsd,
        controlledSwapFeePaidUsd: controlledSwapFeeUsd,
        controlledExternalLpLeakageUsd,
        ownedFullLp,
        ownedLpFeeAccrualUsd,
        ownedLpCashCreditUsd,
        countOwnedLpFeesAsCash,
      },
      costs: {
        ownedBotTxCost,
        collectTxCost,
        inventoryRiskUsd,
        inventoryRiskBps,
        inventoryRiskBlocksCashProof,
      },
      existingCashClaimableUsd,
      ledgers: {
        collectorLedgerNetUsd,
        totalSystemNetUsd,
      },
      collectSimulation,
      cashProofPass,
      noGoReasons,
    });
  }

  const passCandidates = candidates.filter((candidate) => candidate.cashProofPass);
  const best = [...candidates].sort((a, b) => {
    const ax = a.ledgers.totalSystemNetUsd ?? -Infinity;
    const bx = b.ledgers.totalSystemNetUsd ?? -Infinity;
    return bx - ax;
  })[0] ?? null;

  const receipt = {
    verdict: passCandidates.length > 0
      ? "OWNED_FEE_MULTI_BOT_CYCLE_GO_NO_SEND"
      : "OWNED_FEE_MULTI_BOT_CYCLE_NO_GO",
    generatedAt: new Date().toISOString(),
    noSend: true,
    scanReceipt: scanFile,
    scanGeneratedAt: scan.generatedAt,
    solPriceUsd,
    minNetUsd,
    botWallets,
    model: {
      thesis: "Multiple bots can create/route volume across a controlled pool mesh, but controlled bot fees are only profit on the collector ledger. Total-system profit requires an endogenous actuator/spread source, owned LP fee recapture settled to cash, existing claimable fees, or another controlled cash source.",
      collectorLedger: "fee authority wallet only",
      totalSystemLedger: "controlled bot wallets + fee authority + settlement costs",
      defaultCounterpartyMode: "controlled",
    },
    assumptions: {
      mode,
      externalFlowShare,
      ownedFullLp,
      countOwnedLpFeesAsCash,
      assumePriceNeutralBots,
      inventoryRiskBps,
      cuLimit,
      cuPriceMicroLamports,
      jitoTipLamports,
    },
    candidates,
    selected: passCandidates[0] ?? best,
    next: passCandidates.length > 0
      ? "Build exact no-send bot swap bundle for selected pool and require post-balance SOL/USDC proof before any live approval."
      : "Do not send. Either prove external flow, prove we own the active LP/settlement path, or switch to harvesting existing direct cash fees only.",
  };

  const modeReceiptName = `ORCA-OWNED-FEE-CYCLE-SIM-${mode.toUpperCase()}-LATEST.json`;
  writeReceipt(modeReceiptName, receipt);
  const out = writeReceipt("ORCA-OWNED-FEE-CYCLE-SIM-LATEST.json", receipt);
  console.log(`${receipt.verdict} candidates=${candidates.length} pass=${passCandidates.length} selected=${receipt.selected?.whirlpool ?? "none"} receipt=${out}`);
  if (passCandidates.length === 0) process.exitCode = 1;
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
