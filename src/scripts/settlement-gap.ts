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

function readProof() {
  const file = "receipts/REDEMPTION-KIMI-PROOF-IMPORT-LATEST.json";
  if (!fs.existsSync(file)) {
    return {
      avgNetUsd: 1.8901974651065188,
      avgTreasuryDeltaUsdc: 3.920380624,
      latestHopFeesUnits: 4.86305,
      source: "fallback"
    };
  }
  const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
  return {
    avgNetUsd: Number(parsed.stats?.avgNetUsd ?? 1.8901974651065188),
    avgTreasuryDeltaUsdc: Number(parsed.stats?.avgTreasuryDeltaUsdc ?? 3.920380624),
    latestHopFeesUnits: Number(parsed.latest?.hopTotalFeesUnits ?? 4.86305),
    source: "imported-proof"
  };
}

function main() {
  const proof = readProof();
  const targetNetPerCycle = num("TARGET_NET_USD_PER_CYCLE", 1_000);
  const assumedHopToUsdcRate = num("ASSUMED_HOP_TO_USDC_RATE", 0);
  const currentCashNet = proof.avgNetUsd;
  const missingCashUsd = Math.max(0, targetNetPerCycle - currentCashNet);

  const hopUnitsNeededAtAssumedRate = assumedHopToUsdcRate > 0
    ? missingCashUsd / assumedHopToUsdcRate
    : null;

  const verdict = assumedHopToUsdcRate > 0
    ? "SETTLEMENT_GAP_PRICED_BY_ASSUMPTION_NEEDS_ROUTE_PROOF"
    : "SETTLEMENT_GAP_UNPRICED_NEEDS_HOP_TO_USDC_ROUTE";

  const receipt = {
    verdict,
    generatedAt: new Date().toISOString(),
    proof,
    targetNetPerCycle,
    currentCashNet,
    missingCashUsd,
    hopSettlement: {
      assumedHopToUsdcRate,
      hopUnitsNeededAtAssumedRate,
      requiredProof: [
        "controlled withdraw authority can collect withheld HOP",
        "HOP has an executable route to USDC/SOL at target size",
        "settlement route includes slippage, gas, priority fee, and ATA/rent",
        "post-settlement treasury SOL+USDC exceeds pre-cycle by target"
      ]
    },
    conclusion: "Route volume is not the cash multiplier unless HOP fees settle into SOL/USDC."
  };

  const out = writeReceipt("REDEMPTION-SETTLEMENT-GAP-LATEST.json", receipt);
  console.log(`${verdict} currentNet=${currentCashNet.toFixed(6)} missingCash=${missingCashUsd.toFixed(6)} receipt=${out}`);
}

main();
