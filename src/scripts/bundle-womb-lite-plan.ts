/**
 * BUNDLE-WOMB-LITE no-send planner.
 *
 * Plans the three-transaction Jito bundle wrapper around the exact
 * FEE-SINGULARITY core. It never submits to Jito; it records the gating state
 * needed before a live bundle can be approved.
 */
import "dotenv/config";
import fs from "node:fs";
import { writeReceipt } from "../utils/receipt.js";

type FeeSingularityReceipt = {
  verdict?: string;
  generatedAt?: string;
  transaction?: {
    serializedLength?: number | null;
    instructionCount?: number;
    endFlashIndex?: number;
  };
  simulation?: {
    err?: unknown;
    unitsConsumed?: number | null;
  };
  estimates?: {
    requiredCrankUsdcCushionMicro?: string;
    extraHopInventoryRaw?: string;
    walletCashNetUsd?: number;
    totalSystemNetUsd?: number;
  };
  cashProofGate?: {
    useHopInventoryCushion?: boolean;
    pass?: boolean;
    rejectionReasons?: string[];
  };
};

type ForkReadinessReceipt = {
  verdict?: string;
  liveBlockers?: string[];
  hopTransferFee?: {
    activeBps?: number;
    targetBps?: number;
    currentEpoch?: number;
    targetFeeEpoch?: number;
    slotsUntilTargetFeeEpoch?: number;
  };
  crank?: {
    sol?: number;
    usdc?: number;
    hopTrackedNonCash?: number;
  };
  pool?: {
    protocolFeeOwedUsdcUi?: number;
    protocolFeeOwedHopUi?: number;
  };
};

function readJson<T>(path: string): T | null {
  if (!fs.existsSync(path)) return null;
  return JSON.parse(fs.readFileSync(path, "utf8")) as T;
}

function boolEnv(name: string, fallback: boolean): boolean {
  const raw = process.env[name];
  if (raw == null || raw === "") return fallback;
  return ["1", "true", "yes", "y"].includes(raw.toLowerCase());
}

function main() {
  const feePlan = readJson<FeeSingularityReceipt>("receipts/FEE-SINGULARITY-PLAN-LATEST.json");
  const forkReadiness = readJson<ForkReadinessReceipt>("receipts/FORK-READINESS-LATEST.json");
  const allowLive = boolEnv("ALLOW_LIVE", false);
  const dryRun = boolEnv("DRY_RUN", true);
  const liveTxApproved = process.env.LIVE_TX_APPROVED === "true";

  const tx1SimOk = feePlan?.simulation?.err == null;
  const tx1SizeOk = Number(feePlan?.transaction?.serializedLength ?? 999999) <= 1232;
  const tx1CashPass = feePlan?.cashProofGate?.pass === true;

  const tx0 = {
    name: "TX0_PREPARE",
    purpose: "Prepare accounts and optional cushions before the flash core.",
    noSend: true,
    plannedInstructions: [
      "create missing ATAs idempotently",
      "extend ALT with MarginFi, fork Whirlpool, ring, mint, and vault accounts if needed",
      "fund explicit USDC cushion only if approved and accounted as cost",
    ],
    requiredBecause: [
      "TX1 must stay under packet limit",
      "MarginFi repay cannot depend on unpriced wallet dust",
      "ring delegates and HOP ATAs must exist before the flash core",
    ],
  };

  const tx1 = {
    name: "TX1_FEE_SINGULARITY_CORE",
    purpose: "Single atomic flash/swap/4-hop/settle/repay transaction.",
    noSend: true,
    sourceReceipt: "receipts/FEE-SINGULARITY-PLAN-LATEST.json",
    receiptVerdict: feePlan?.verdict ?? null,
    serializedLength: feePlan?.transaction?.serializedLength ?? null,
    instructionCount: feePlan?.transaction?.instructionCount ?? null,
    endFlashIndex: feePlan?.transaction?.endFlashIndex ?? null,
    simErr: feePlan?.simulation?.err ?? null,
    unitsConsumed: feePlan?.simulation?.unitsConsumed ?? null,
    requiredCrankUsdcCushionMicro: feePlan?.estimates?.requiredCrankUsdcCushionMicro ?? null,
    extraHopInventoryRaw: feePlan?.estimates?.extraHopInventoryRaw ?? null,
    walletCashNetUsd: feePlan?.estimates?.walletCashNetUsd ?? null,
    totalSystemNetUsd: feePlan?.estimates?.totalSystemNetUsd ?? null,
  };

  const tx2 = {
    name: "TX2_SETTLE_AND_ACCOUNT",
    purpose: "Collect/settle only after TX1 proves real cash surplus.",
    noSend: true,
    plannedInstructions: [
      "collect protocol fees only if owed in USDC/SOL and locally authorized",
      "sell non-cash HOP only through a real route with exact quote/sim",
      "write post-bundle treasury snapshot",
    ],
    blockedWhen: [
      "HOP has no external USDC/SOL route",
      "claimable fees are zero",
      "cash proof uses owned inventory conversion",
    ],
  };

  const blockers = [
    feePlan ? null : "missing receipts/FEE-SINGULARITY-PLAN-LATEST.json",
    forkReadiness ? null : "missing receipts/FORK-READINESS-LATEST.json",
    tx1SizeOk ? null : "TX1 exceeds packet size limit",
    tx1SimOk ? null : "TX1 simulation is not clean",
    tx1CashPass ? null : "TX1 cash proof is not passing",
    feePlan?.cashProofGate?.useHopInventoryCushion ? "TX1 uses HOP inventory cushion; not profit" : null,
    ...(feePlan?.cashProofGate?.rejectionReasons ?? []),
    ...(forkReadiness?.liveBlockers ?? []).map((reason) => `fork readiness: ${reason}`),
    dryRun ? null : "planner must run with DRY_RUN=true",
    allowLive ? "ALLOW_LIVE=true ignored by planner; no-send only" : null,
    liveTxApproved ? "LIVE_TX_APPROVED=true ignored by planner; no-send only" : null,
  ].filter((reason): reason is string => Boolean(reason));

  const receipt = {
    verdict: blockers.length === 0 ? "BUNDLE_WOMB_LITE_READY_FOR_APPROVAL" : "BUNDLE_WOMB_LITE_NO_GO",
    generatedAt: new Date().toISOString(),
    noSend: true,
    dryRun,
    allowLive,
    liveTxApproved,
    jitoBundleShape: [tx0.name, tx1.name, tx2.name],
    tx0,
    tx1,
    tx2,
    forkReadinessSummary: forkReadiness
      ? {
        verdict: forkReadiness.verdict ?? null,
        hopTransferFee: forkReadiness.hopTransferFee ?? null,
        crank: forkReadiness.crank ?? null,
        protocolFees: forkReadiness.pool
          ? {
            usdc: forkReadiness.pool.protocolFeeOwedUsdcUi ?? null,
            hop: forkReadiness.pool.protocolFeeOwedHopUi ?? null,
          }
          : null,
      }
      : null,
    approvalGate: {
      requiresExactTx0Tx1Tx2Receipts: true,
      requiresWalletCashNetPositive: true,
      requiresTotalSystemNetPositive: true,
      requiresNoInventoryConversionAsProfit: true,
      requiresVelonExplicitApproval: true,
    },
    blockers,
  };

  const out = writeReceipt("BUNDLE-WOMB-LITE-PLAN-LATEST.json", receipt);
  console.log(`${receipt.verdict} receipt=${out}`);
  console.log(`shape=${receipt.jitoBundleShape.join(" -> ")}`);
  if (blockers.length > 0) console.log(`blocked=${blockers.join(" | ")}`);
  if (blockers.length > 0) process.exitCode = 1;
}

main();
