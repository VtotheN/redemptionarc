import "dotenv/config";
import dotenv from "dotenv";
import fs from "node:fs";
import { writeReceipt } from "../utils/receipt.js";
import {
  estimateKimiStyleTreasuryCreditMicro,
  estimatePriorityFeeLamports,
  microToUsdc
} from "../math/kimi-cycle.js";
import { loadConfig } from "../config.js";

if (process.env.ENV_PATH) {
  dotenv.config({ path: process.env.ENV_PATH, override: true });
}

type CycleReceipt = {
  solPriceUsd: number;
  result: {
    treasuryUsdcDelta: string;
    crankSolBefore: string;
    crankSolAfter: string;
    feeFirstCreditMicro: string;
    sweepMicro: string;
    gasSpentLamports: string;
  };
};

function readCycles(): CycleReceipt[] {
  return fs.readdirSync("receipts")
    .filter((name) => /^REDEMPTION-LIVE-CYCLE-\d+\.json$/.test(name))
    .sort()
    .map((name) => JSON.parse(fs.readFileSync(`receipts/${name}`, "utf8")) as CycleReceipt);
}

function avg(values: number[]): number {
  return values.length === 0 ? 0 : values.reduce((sum, value) => sum + value, 0) / values.length;
}

function quantile(values: number[], q: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.floor((sorted.length - 1) * q)));
  return sorted[index];
}

function main() {
  const config = loadConfig();
  const cycles = readCycles();
  const solPriceUsd = config.solPriceUsd ?? Number(process.env.SOL_PRICE_USD || cycles.at(-1)?.solPriceUsd || "86.75");
  const routeVolumeMicro = BigInt(Math.floor(config.routeVolumeUsdc * 1e6));
  const observedSweepUsdc = cycles.map((cycle) => Number(cycle.result.sweepMicro) / 1e6);
  const observedGasLamports = cycles.map((cycle) => BigInt(cycle.result.gasSpentLamports));
  const last = cycles.at(-1);

  const sweepCases = {
    min: Math.min(...observedSweepUsdc),
    p50: quantile(observedSweepUsdc, 0.5),
    avg: avg(observedSweepUsdc),
    last: last ? Number(last.result.sweepMicro) / 1e6 : 0
  };
  const gasLamports = observedGasLamports.length > 0
    ? observedGasLamports.reduce((a, b) => a < b ? a : b)
    : 130_400n;

  const cushionExtrasUsdc = (process.env.ARC_LAB_CUSHIONS_USDC || "1,2,4,6,8,12,20,34.681332")
    .split(",")
    .map((value) => Number(value.trim()))
    .filter((value) => Number.isFinite(value) && value >= 0);
  const flashFeeBpsCases = (process.env.ARC_LAB_FLASH_FEE_BPS || "0,3,5,9,30")
    .split(",")
    .map((value) => Number(value.trim()))
    .filter((value) => Number.isFinite(value) && value >= 0);
  const cuPriceCases = (process.env.ARC_LAB_CU_PRICE_MICRO_LAMPORTS || "100,500,1000")
    .split(",")
    .map((value) => Number(value.trim()))
    .filter((value) => Number.isFinite(value) && value >= 0);

  const candidates = [];
  for (const cushionExtraUsdc of cushionExtrasUsdc) {
    const cushionExtraMicro = BigInt(Math.floor(cushionExtraUsdc * 1e6));
    for (const flashFeeBps of flashFeeBpsCases) {
      const flashFeeMicro = (routeVolumeMicro * BigInt(Math.floor(flashFeeBps))) / 10_000n;
      const feeFirstMicro = estimateKimiStyleTreasuryCreditMicro({
        routeVolumeMicro,
        kaminoFlashFeeMicro: flashFeeMicro,
        cushionExtraUsdcMicro: cushionExtraMicro
      });
      for (const cuPriceMicroLamports of cuPriceCases) {
        const modeledPriorityLamports = estimatePriorityFeeLamports({
          cuLimit: config.tx2CuLimit,
          cuPriceMicroLamports
        });
        const modeledGasUsd = Number(gasLamports + modeledPriorityLamports) / 1e9 * solPriceUsd;
        const cushionCostUsdc = microToUsdc(flashFeeMicro + cushionExtraMicro);
        const nets = Object.fromEntries(
          Object.entries(sweepCases).map(([caseName, sweepUsdc]) => {
            const treasuryDeltaUsdc = microToUsdc(feeFirstMicro) + sweepUsdc;
            return [caseName, treasuryDeltaUsdc - cushionCostUsdc - modeledGasUsd];
          })
        );
        candidates.push({
          cushionExtraUsdc,
          flashFeeBps,
          cuPriceMicroLamports,
          feeFirstUsdc: microToUsdc(feeFirstMicro),
          cushionCostUsdc,
          modeledGasUsd,
          nets
        });
      }
    }
  }

  const positive = candidates
    .filter((candidate) => Number((candidate.nets as any).min) > config.minNetUsd)
    .sort((a, b) => Number((b.nets as any).min) - Number((a.nets as any).min));
  const best = positive[0] ?? candidates.sort((a, b) => Number((b.nets as any).last) - Number((a.nets as any).last))[0] ?? null;

  const receipt = {
    verdict: positive.length > 0 ? "ARC_LAB_POSITIVE_CONFIG_FOUND_NO_LIVE" : "ARC_LAB_NO_CONSERVATIVE_POSITIVE_CONFIG",
    generatedAt: new Date().toISOString(),
    source: "RedemptionArc live receipts only; no Kimi wallet copying.",
    solPriceUsd,
    routeVolumeUsdc: config.routeVolumeUsdc,
    minNetUsd: config.minNetUsd,
    observations: {
      cycles: cycles.length,
      sweepCases,
      minObservedGasLamports: gasLamports.toString()
    },
    best,
    topPositive: positive.slice(0, 10),
    flashLoanProviderRead: {
      canReplaceKamino: true,
      reason: "Flash fee is modeled as bps. Provider replacement helps only if it lowers fee/CU or changes instruction geometry; the current dominant variable is cushion/refill geometry.",
      testedFeeBps: flashFeeBpsCases
    },
    next: positive.length > 0
      ? "Run a single no-keeper live experiment with the best config only if current float is enough."
      : "Do not run the current aggressive profile; search a different source or route geometry."
  };

  const out = writeReceipt("REDEMPTION-ARC-LAB-LATEST.json", receipt);
  console.log(`${receipt.verdict} bestMin=${best ? Number((best.nets as any).min).toFixed(6) : "n/a"} bestLast=${best ? Number((best.nets as any).last).toFixed(6) : "n/a"} receipt=${out}`);
  if (receipt.verdict !== "ARC_LAB_POSITIVE_CONFIG_FOUND_NO_LIVE") process.exitCode = 1;
}

main();
