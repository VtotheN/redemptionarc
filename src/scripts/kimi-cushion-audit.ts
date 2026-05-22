import "dotenv/config";
import dotenv from "dotenv";
import fs from "node:fs";
import path from "node:path";
import { writeReceipt } from "../utils/receipt.js";

if (process.env.ENV_PATH) {
  dotenv.config({ path: process.env.ENV_PATH, override: true });
}

type KimiReceipt = {
  type?: string;
  createdAt?: string;
  solPriceUsd?: number;
  result?: {
    treasuryUsdcDelta?: string;
    gasSpentLamports?: string;
    hopTotalFeesMicro?: string;
  };
};

function micro(value: string | undefined): number {
  return Number(BigInt(value ?? "0")) / 1e6;
}

function sol(value: string | undefined): number {
  return Number(BigInt(value ?? "0")) / 1e9;
}

function estimateCushionUsd(solPriceUsd: number): number {
  const routeVolumeUsdc = Number(process.env.OBSERVED_ROUTE_VOLUME_USDC || "39");
  const kaminoFeeBps = Number(process.env.KAMINO_FLASH_FEE_BPS_ESTIMATE || "9");
  const extraUsdc = Number(process.env.TX2_CUSHION_EXTRA_USDC || "4");
  const minCushionSol = Number(process.env.TX2_MIN_CUSHION_SOL || "0.01");
  const kaminoFeeUsdc = routeVolumeUsdc * kaminoFeeBps / 10_000;
  return Math.max(kaminoFeeUsdc + extraUsdc, minCushionSol * solPriceUsd);
}

function main() {
  const receiptsDir = process.env.KIMI_RECEIPTS_DIR || "/Users/velon/Desktop/DOCTORKIMI-ENGINE/receipts";
  const files = fs.existsSync(receiptsDir)
    ? fs.readdirSync(receiptsDir).filter((file) => file.endsWith(".json")).sort()
    : [];

  const cycles = files.flatMap((file) => {
    try {
      const parsed = JSON.parse(fs.readFileSync(path.join(receiptsDir, file), "utf8")) as KimiReceipt;
      if (parsed.type !== "doctorkimi-cycle" || !parsed.result || !parsed.solPriceUsd) return [];
      const treasuryDeltaUsdc = micro(parsed.result.treasuryUsdcDelta);
      const gasUsd = sol(parsed.result.gasSpentLamports) * parsed.solPriceUsd;
      const cushionUsdEstimate = estimateCushionUsd(parsed.solPriceUsd);
      return [{
        file,
        createdAt: parsed.createdAt,
        solPriceUsd: parsed.solPriceUsd,
        treasuryDeltaUsdc,
        gasUsd,
        cushionUsdEstimate,
        treasuryLedgerNetUsd: treasuryDeltaUsdc - gasUsd,
        totalSystemNetUsdEstimate: treasuryDeltaUsdc - gasUsd - cushionUsdEstimate,
        hopFeesUnits: micro(parsed.result.hopTotalFeesMicro)
      }];
    } catch {
      return [];
    }
  });

  const sum = (values: number[]) => values.reduce((a, b) => a + b, 0);
  const avg = (values: number[]) => values.length ? sum(values) / values.length : 0;
  const treasuryNets = cycles.map((cycle) => cycle.treasuryLedgerNetUsd);
  const systemNets = cycles.map((cycle) => cycle.totalSystemNetUsdEstimate);

  const receipt = {
    verdict: cycles.length > 0 ? "KIMI_CUSHION_AUDIT_COMPLETE" : "KIMI_CUSHION_AUDIT_NO_RECEIPTS",
    generatedAt: new Date().toISOString(),
    receiptsDir,
    cycleCount: cycles.length,
    model: {
      treasuryLedgerNetUsd: "treasury USDC delta - real burned SOL gas",
      totalSystemNetUsdEstimate: "treasury USDC delta - real burned SOL gas - estimated TX0 SOL cushion converted to USDC",
      limitation: "Kimi receipts do not persist exact cushionSolLamports, so cushion is estimated from route config."
    },
    stats: {
      avgTreasuryLedgerNetUsd: avg(treasuryNets),
      positiveTreasuryLedgerCycles: treasuryNets.filter((value) => value > 0).length,
      avgTotalSystemNetUsdEstimate: avg(systemNets),
      positiveTotalSystemEstimateCycles: systemNets.filter((value) => value > 0).length,
      avgCushionUsdEstimate: avg(cycles.map((cycle) => cycle.cushionUsdEstimate))
    },
    latest: cycles.at(-1) ?? null,
    conclusion: "Kimi demonstrates treasury USDC growth. RedemptionArc must separately prove total-system growth before scaling."
  };

  const out = writeReceipt("REDEMPTION-KIMI-CUSHION-AUDIT-LATEST.json", receipt);
  console.log(`${receipt.verdict} cycles=${cycles.length} treasuryAvg=${receipt.stats.avgTreasuryLedgerNetUsd.toFixed(6)} systemAvgEst=${receipt.stats.avgTotalSystemNetUsdEstimate.toFixed(6)} receipt=${out}`);
  if (cycles.length === 0) process.exitCode = 1;
}

main();
