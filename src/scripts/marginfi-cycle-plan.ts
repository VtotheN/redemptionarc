import "dotenv/config";
import dotenv from "dotenv";
import fs from "node:fs";
import { writeReceipt } from "../utils/receipt.js";
import {
  estimateMarginfiFlashFeeMicro,
  estimateCushionSolLamportsMarginfi,
  marginfiFlashFeeSavingsMicro,
  estimateKaminoFlashFeeMicro,
  estimatePriorityFeeLamports,
  microToUsdc,
  lamportsToSol,
} from "../math/kimi-cycle.js";

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

function readCycle008() {
  const file = "receipts/REDEMPTION-LIVE-CYCLE-008.json";
  if (!fs.existsSync(file)) {
    return {
      solPriceUsd: 90,
      treasuryUsdcDeltaMicro: 995422n,
      gasSpentLamports: 11631151n,
      feeFirstCreditMicro: 250000n,
      sweepMicro: 745422n,
      hopTotalFeesMicro: 7528775n,
      source: "fallback",
    };
  }
  const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
  const r = parsed.result;
  return {
    solPriceUsd: Number(parsed.solPriceUsd ?? 90),
    treasuryUsdcDeltaMicro: BigInt(r.treasuryUsdcDelta ?? 995422),
    gasSpentLamports: BigInt(r.gasSpentLamports ?? 11631151),
    feeFirstCreditMicro: BigInt(r.feeFirstCreditMicro ?? 250000),
    sweepMicro: BigInt(r.sweepMicro ?? 745422),
    hopTotalFeesMicro: BigInt(r.hopTotalFeesMicro ?? 7528775),
    source: "cycle-008",
  };
}

function main() {
  const base = readCycle008();
  const routeVolumeUsdc = num("ROUTE_VOLUME_USDC", 39);
  const routeVolumeMicro = BigInt(Math.floor(routeVolumeUsdc * 1e6));
  const cuLimit = num("CU_LIMIT", 400_000);
  const cuPrice = num("CU_PRICE_MICRO_LAMPORTS", 1_000);

  // --- Kamino baseline (cycle 008) ---
  const kaminoFlashFeeMicro = estimateKaminoFlashFeeMicro(routeVolumeMicro);
  const kaminoGasLamports = base.gasSpentLamports;
  const kaminoNetMicro = base.treasuryUsdcDeltaMicro;

  // --- MarginFi scenario ---
  const marginfiFlashFeeMicro = estimateMarginfiFlashFeeMicro(routeVolumeMicro);
  const savingsMicro = marginfiFlashFeeSavingsMicro(routeVolumeMicro);
  // MarginFi flash uses fewer IXs (no Kamino open/close IX), estimate ~100k CU saved
  const cuSavedMarginfi = 100_000;
  const gasSavedLamports =
    (BigInt(cuSavedMarginfi) * BigInt(cuPrice)) / 1_000_000n;
  const marginfiGasLamports = kaminoGasLamports > gasSavedLamports
    ? kaminoGasLamports - gasSavedLamports
    : kaminoGasLamports;
  // Net = Kamino net + flash fee saving (USDC side) + gas saving (converted to USDC)
  const solPriceUsd = num("SOL_PRICE_USD", base.solPriceUsd);
  const gasSavingUsdcMicro =
    (gasSavedLamports * BigInt(Math.floor(solPriceUsd * 1e6))) / 1_000_000_000n;
  const marginfiNetMicro = kaminoNetMicro + savingsMicro + gasSavingUsdcMicro;

  // --- Break-even SOL price ---
  // At break-even: net >= minNetUsd ($0.25 default)
  // marginfiNetMicro is already > 0 if cycle 008 was profitable
  // Break-even SOL = price where (gasLamports * solPrice / 1e9) = treasuryDelta
  // i.e. solBreakEven = treasuryUsdcDeltaMicro / gasLamports * 1e3  (micro * lamports → USD)
  const breakEvenSolPrice =
    (Number(marginfiNetMicro) / 1e6) / (Number(marginfiGasLamports) / 1e9);

  const cushionLamports = estimateCushionSolLamportsMarginfi();

  const receipt = {
    verdict: marginfiNetMicro > 0n
      ? "MARGINFI_CYCLE_PLAN_PROFITABLE"
      : "MARGINFI_CYCLE_PLAN_UNPROFITABLE",
    generatedAt: new Date().toISOString(),
    baseline: {
      source: base.source,
      solPriceUsd: base.solPriceUsd,
      routeVolumeUsdc,
      kamino: {
        flashFeeMicro: kaminoFlashFeeMicro.toString(),
        flashFeeUsdc: microToUsdc(kaminoFlashFeeMicro),
        gasLamports: kaminoGasLamports.toString(),
        gasSol: lamportsToSol(kaminoGasLamports),
        netMicro: kaminoNetMicro.toString(),
        netUsdc: microToUsdc(kaminoNetMicro),
      },
    },
    marginfi: {
      flashFeeMicro: marginfiFlashFeeMicro.toString(),
      flashFeeUsdc: microToUsdc(marginfiFlashFeeMicro),
      flashFeeSavingsMicro: savingsMicro.toString(),
      flashFeeSavingsUsdc: microToUsdc(savingsMicro),
      estimatedGasLamports: marginfiGasLamports.toString(),
      estimatedGasSol: lamportsToSol(marginfiGasLamports),
      gasSavingsLamports: gasSavedLamports.toString(),
      gasSavingUsdcMicro: gasSavingUsdcMicro.toString(),
      netMicro: marginfiNetMicro.toString(),
      netUsdc: microToUsdc(marginfiNetMicro),
      cushionSolLamports: cushionLamports.toString(),
    },
    economics: {
      totalSavingsPerCycleMicro: (savingsMicro + gasSavingUsdcMicro).toString(),
      totalSavingsPerCycleUsdc: microToUsdc(savingsMicro + gasSavingUsdcMicro),
      breakEvenSolPrice,
      projectedDailyAtOneCyclePerSec:
        microToUsdc(marginfiNetMicro) * 86400,
    },
  };

  const out = writeReceipt("REDEMPTION-MARGINFI-CYCLE-PLAN-LATEST.json", receipt);
  console.log(
    `${receipt.verdict} net=${receipt.marginfi.netUsdc.toFixed(6)} breakEvenSOL=${breakEvenSolPrice.toFixed(2)} receipt=${out}`
  );
}

main();
