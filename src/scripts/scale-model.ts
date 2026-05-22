import "dotenv/config";
import dotenv from "dotenv";
import fs from "node:fs";
import { writeReceipt } from "../utils/receipt.js";

if (process.env.ENV_PATH) {
  dotenv.config({ path: process.env.ENV_PATH, override: true });
}

function num(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) throw new Error(`Invalid ${name}=${raw}`);
  return parsed;
}

function loadObservedTemplate() {
  const file = "receipts/REDEMPTION-KIMI-PROOF-IMPORT-LATEST.json";
  const cushionFile = "receipts/REDEMPTION-KIMI-CUSHION-AUDIT-LATEST.json";
  const cushion = fs.existsSync(cushionFile) ? JSON.parse(fs.readFileSync(cushionFile, "utf8")) : null;
  if (!fs.existsSync(file)) {
    return {
      avgNetUsd: 1.98,
      avgTreasuryDeltaUsdc: 4.02,
      avgGasSol: 0.0234,
      source: "fallback_observed_latest"
    };
  }
  const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
  const totalSystemNet = cushion?.stats?.avgTotalSystemNetUsdEstimate;
  return {
    avgNetUsd: Number(totalSystemNet ?? parsed.stats?.avgNetUsd ?? parsed.latest?.netUsd ?? 1.98),
    avgTreasuryDeltaUsdc: Number(parsed.stats?.avgTreasuryDeltaUsdc ?? parsed.latest?.treasuryDeltaUsdc ?? 4.02),
    avgGasSol: Number(parsed.stats?.avgGasSol ?? parsed.latest?.gasSol ?? 0.0234),
    source: totalSystemNet == null ? "receipt_observed_treasury_average" : "receipt_observed_total_system_average"
  };
}

function main() {
  const observed = loadObservedTemplate();
  const targetPerCycle = num("TARGET_NET_USD_PER_CYCLE", 1000);
  const targetPerDay = num("TARGET_NET_USD_PER_DAY", 1_000_000);
  const maxCyclesPerDay = num("MAX_CYCLES_PER_DAY", 20_000);

  const netPerCycle = observed.avgNetUsd;
  const cyclesForTargetCycle = netPerCycle > 0 ? Math.ceil(targetPerCycle / netPerCycle) : Infinity;
  const cyclesForTargetDay = netPerCycle > 0 ? Math.ceil(targetPerDay / netPerCycle) : Infinity;
  const dayAtMaxCycles = netPerCycle * maxCyclesPerDay;
  const lanesNeededAtMaxCycles = dayAtMaxCycles > 0 ? Math.ceil(targetPerDay / dayAtMaxCycles) : Infinity;

  const verdict =
    netPerCycle <= 0
      ? "SCALE_BLOCKED_NEGATIVE_TEMPLATE"
      : cyclesForTargetDay <= maxCyclesPerDay
        ? "SCALE_THEORETICALLY_REACHABLE_BY_THROUGHPUT"
        : "SCALE_NEEDS_MULTIPLIER_NOT_RAW_REPETITION";

  const receipt = {
    verdict,
    generatedAt: new Date().toISOString(),
    observed,
    targets: {
      targetPerCycle,
      targetPerDay,
      maxCyclesPerDay
    },
    rawRepetitionMath: {
      cyclesNeededForTargetPerCycle: Number.isFinite(cyclesForTargetCycle) ? cyclesForTargetCycle : null,
      cyclesNeededForTargetPerDay: Number.isFinite(cyclesForTargetDay) ? cyclesForTargetDay : null,
      netUsdPerDayAtMaxCycles: dayAtMaxCycles,
      parallelLanesNeededAtMaxCycles: Number.isFinite(lanesNeededAtMaxCycles) ? lanesNeededAtMaxCycles : null
    },
    requiredMultiplier: {
      perCycleMultiplierForTarget: netPerCycle > 0 ? targetPerCycle / netPerCycle : null,
      perDayMultiplierAtMaxCycles: dayAtMaxCycles > 0 ? targetPerDay / dayAtMaxCycles : null
    },
    engineeringConclusion: [
      "The observed Kimi treasury ledger is positive, but RedemptionArc scales only total-system profit.",
      "Thousands per cycle or millions per day require a multiplier: scalable fee source, batched independent lanes, larger controlled venue, or a new cash-settled source.",
      "Do not increase volume blindly until Token-2022 fee caps, hop liquidity, Jupiter settlement, CU, and wallet float are proven by exact no-send receipts."
    ],
    nextBuildModules: [
      "source-autopsy: decode exactly who pays each treasury USDC delta",
      "route-cap-scanner: read Token-2022 fee caps and liquidity depth",
      "batch-simulator: estimate CU/tx bytes for N lanes",
      "redemption-cycle-builder: TX0/TX2/TX3 under new wallets only"
    ]
  };

  const out = writeReceipt("REDEMPTION-SCALE-MODEL-LATEST.json", receipt);
  console.log(`${verdict} avgNet=${netPerCycle.toFixed(6)} targetDayCycles=${receipt.rawRepetitionMath.cyclesNeededForTargetPerDay} lanesNeeded=${receipt.rawRepetitionMath.parallelLanesNeededAtMaxCycles} receipt=${out}`);
}

main();
