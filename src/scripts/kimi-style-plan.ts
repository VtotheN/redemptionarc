import "dotenv/config";
import dotenv from "dotenv";
import { loadConfig } from "../config.js";
import { writeReceipt } from "../utils/receipt.js";
import {
  estimateCushionSolLamports,
  estimateKaminoFlashFeeMicro,
  estimateKimiStyleTreasuryCreditMicro,
  estimatePriorityFeeLamports,
  lamportsToSol,
  microToUsdc
} from "../math/kimi-cycle.js";

if (process.env.ENV_PATH) {
  dotenv.config({ path: process.env.ENV_PATH, override: true });
}

function main() {
  const config = loadConfig();
  const solPriceUsd = config.solPriceUsd ?? Number(process.env.SOL_PRICE_USD || "86.75");
  const routeVolumeMicro = BigInt(Math.floor(config.routeVolumeUsdc * 1e6));
  const kaminoFlashFeeMicro = estimateKaminoFlashFeeMicro(routeVolumeMicro);
  const cushionSolLamports = estimateCushionSolLamports({
    kaminoFlashFeeMicro,
    solPriceUsd,
    cushionExtraUsdcMicro: config.tx2CushionExtraUsdcMicro,
    minCushionSolLamports: config.tx2MinCushionSolLamports
  });
  const feeFirstCreditMicro = estimateKimiStyleTreasuryCreditMicro({
    routeVolumeMicro,
    kaminoFlashFeeMicro,
    cushionExtraUsdcMicro: config.tx2CushionExtraUsdcMicro
  });
  const priorityFeeLamports = estimatePriorityFeeLamports({
    cuLimit: config.tx2CuLimit,
    cuPriceMicroLamports: config.tx2CuPriceMicroLamports
  });

  const observedSweepMicro = BigInt(process.env.OBSERVED_SWEEP_USDC_MICRO || "1519527");
  const expectedTreasuryDeltaMicro = feeFirstCreditMicro + observedSweepMicro;
  const observedBurnedGasLamports = BigInt(process.env.OBSERVED_BURNED_GAS_LAMPORTS || "23406634");
  const treasuryLedgerNetUsd =
    microToUsdc(expectedTreasuryDeltaMicro) - lamportsToSol(observedBurnedGasLamports) * solPriceUsd;
  const totalSystemNetUsd =
    treasuryLedgerNetUsd - lamportsToSol(cushionSolLamports) * solPriceUsd;

  const requiredCrankFloatLamports =
    cushionSolLamports + observedBurnedGasLamports + 20_000_000n;

  const selectedNetUsd = config.ledgerMode === "treasury" ? treasuryLedgerNetUsd : totalSystemNetUsd;
  const verdict = selectedNetUsd > config.minNetUsd
    ? "KIMI_STYLE_PLAN_READY_NO_LIVE"
    : "KIMI_STYLE_PLAN_BLOCKED_NEGATIVE";

  const receipt = {
    verdict,
    generatedAt: new Date().toISOString(),
    ledgerMode: config.ledgerMode,
    solPriceUsd,
    params: {
      routeVolumeUsdc: config.routeVolumeUsdc,
      hops: config.hops,
      cushionExtraUsdc: microToUsdc(config.tx2CushionExtraUsdcMicro),
      minProfitUsd: config.minNetUsd
    },
    estimates: {
      kaminoFlashFeeUsdc: microToUsdc(kaminoFlashFeeMicro),
      cushionSol: lamportsToSol(cushionSolLamports),
      cushionUsd: lamportsToSol(cushionSolLamports) * solPriceUsd,
      feeFirstCreditUsdc: microToUsdc(feeFirstCreditMicro),
      observedSweepUsdc: microToUsdc(observedSweepMicro),
      expectedTreasuryDeltaUsdc: microToUsdc(expectedTreasuryDeltaMicro),
      observedBurnedGasSol: lamportsToSol(observedBurnedGasLamports),
      observedBurnedGasUsd: lamportsToSol(observedBurnedGasLamports) * solPriceUsd,
      priorityFeeLamports: priorityFeeLamports.toString(),
      treasuryLedgerNetUsd,
      totalSystemNetUsd,
      requiredCrankFloatSol: lamportsToSol(requiredCrankFloatLamports)
    },
    next: {
      canRunLiveNow: false,
      reason: "No live TX from planner. Fund RedemptionArc crank and run exact transaction simulation first.",
      requiredBeforeLive: [
        "RedemptionArc crank funded above requiredCrankFloatSol",
        "Treasury/crank/ring ATAs exist or are included idempotently",
        "Exact TX0/TX2/TX3 simulation succeeds",
        "Velon explicitly approves live micro-cycle"
      ]
    }
  };

  const out = writeReceipt("REDEMPTION-KIMI-STYLE-PLAN-LATEST.json", receipt);
  console.log(`${verdict} ledger=${config.ledgerMode} treasuryNet=${treasuryLedgerNetUsd.toFixed(6)} systemNet=${totalSystemNetUsd.toFixed(6)} floatSol=${receipt.estimates.requiredCrankFloatSol.toFixed(6)} receipt=${out}`);
  if (verdict !== "KIMI_STYLE_PLAN_READY_NO_LIVE") process.exitCode = 1;
}

main();
