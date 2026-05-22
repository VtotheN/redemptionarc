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

function readJson(file: string): any | null {
  return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : null;
}

function main() {
  const proof = readJson("receipts/REDEMPTION-KIMI-PROOF-IMPORT-LATEST.json");
  const cap = readJson("receipts/REDEMPTION-TOKEN2022-CAP-SCAN-LATEST.json");
  const cushionAudit = readJson("receipts/REDEMPTION-KIMI-CUSHION-AUDIT-LATEST.json");

  const observedRouteVolumeUsdc = num("OBSERVED_ROUTE_VOLUME_USDC", 39);
  const targetNetPerCycle = num("TARGET_NET_USD_PER_CYCLE", 1_000);
  const targetNetPerDay = num("TARGET_NET_USD_PER_DAY", 1_000_000);
  const targetCyclesPerDay = num("TARGET_CYCLES_PER_DAY", 1_000);

  const treasuryLedgerNetUsd = Number(proof?.stats?.avgNetUsd ?? 1.8901974651065188);
  const totalSystemNetUsdEstimate = Number(cushionAudit?.stats?.avgTotalSystemNetUsdEstimate ?? treasuryLedgerNetUsd);
  const avgNetUsd = totalSystemNetUsdEstimate;
  const avgTreasuryDeltaUsdc = Number(proof?.stats?.avgTreasuryDeltaUsdc ?? 3.920380624);
  const avgGasSol = Number(proof?.stats?.avgGasSol ?? 0.023293873168);
  const cashYieldBps = (avgTreasuryDeltaUsdc / observedRouteVolumeUsdc) * 10_000;
  const netYieldBps = (avgNetUsd / observedRouteVolumeUsdc) * 10_000;

  const requiredVolumeForTargetCycle = netYieldBps > 0
    ? targetNetPerCycle * 10_000 / netYieldBps
    : Infinity;

  const requiredNetPerCycleForDayTarget = targetNetPerDay / targetCyclesPerDay;
  const requiredVolumeForDayPlan = netYieldBps > 0
    ? requiredNetPerCycleForDayTarget * 10_000 / netYieldBps
    : Infinity;

  const tokenFeeCapAllows = Boolean(cap?.scaleRead?.canGetThousandsPerSingleRingByRaisingVolume);

  const blockers = [
    "Must prove total-system ledger is positive after counting TX0 cushion as inventory conversion.",
    "Must prove new RedemptionArc wallets can control the fee/withdraw/settlement authority.",
    "Must prove hop escrow/liquidity can support required route volume without draining controlled inventory.",
    "Must prove Jupiter/Orca can settle any SOL/USDC leg at target size and slippage.",
    "Must prove TX0/TX2/TX3 CU and v0 bytes at target size, or split into bundle lanes.",
    "Must prove the same cash yield holds at size; observed 39 USDC route cannot be linearly assumed."
  ];

  const verdict = avgNetUsd <= 0
    ? "TARGET_DESIGN_BLOCKED_TOTAL_SYSTEM_NEGATIVE"
    : tokenFeeCapAllows
      ? "TARGET_DESIGN_MULTIPLIER_POSSIBLE_NEEDS_ROUTE_PROOF"
      : "TARGET_DESIGN_BLOCKED_BY_TOKEN_FEE_CAP";

  const receipt = {
    verdict,
    generatedAt: new Date().toISOString(),
    observedUnitEconomics: {
      observedRouteVolumeUsdc,
      treasuryLedgerNetUsd,
      totalSystemNetUsdEstimate,
      avgTreasuryDeltaUsdc,
      avgNetUsd,
      avgGasSol,
      cashYieldBps,
      netYieldBps
    },
    targets: {
      targetNetPerCycle,
      targetNetPerDay,
      targetCyclesPerDay,
      requiredNetPerCycleForDayTarget
    },
    theoreticalVolumeRequirements: {
      requiredVolumeForTargetCycle,
      requiredVolumeForDayPlan,
      tokenFeeCapAllows
    },
    nextProofBeforeLive: {
      routeVolumeUsdc: Math.ceil(requiredVolumeForTargetCycle),
      requiredReceipt: "exact no-send TX0/TX2/TX3 or Jito bundle simulation showing spendable SOL+USDC net positive",
      blockers
    }
  };

  const out = writeReceipt("REDEMPTION-TARGET-DESIGN-LATEST.json", receipt);
  console.log(`${verdict} netYieldBps=${netYieldBps.toFixed(2)} volumeFor1k=${requiredVolumeForTargetCycle.toFixed(2)} volumeForDayPlan=${requiredVolumeForDayPlan.toFixed(2)} receipt=${out}`);
}

main();
