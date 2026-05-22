import "dotenv/config";
import dotenv from "dotenv";
import { loadConfig } from "../config.js";
import { writeReceipt } from "../utils/receipt.js";
import {
  estimateCushionSolLamports,
  estimateKaminoFlashFeeMicro,
  estimateKimiStyleTreasuryCreditMicro,
  lamportsToSol,
  microToUsdc
} from "../math/kimi-cycle.js";

if (process.env.ENV_PATH) {
  dotenv.config({ path: process.env.ENV_PATH, override: true });
}

function targets(): number[] {
  return (process.env.AGGRESSIVE_TARGETS_USD || "10,25,50,100")
    .split(",")
    .map((value) => Number(value.trim()))
    .filter((value) => Number.isFinite(value) && value > 0);
}

function main() {
  const config = loadConfig();
  const solPriceUsd = config.solPriceUsd ?? Number(process.env.SOL_PRICE_USD || "86.75");
  const routeVolumeMicro = BigInt(Math.floor(config.routeVolumeUsdc * 1e6));
  const kaminoFlashFeeMicro = estimateKaminoFlashFeeMicro(routeVolumeMicro);
  const observedSweepMicro = BigInt(process.env.OBSERVED_SWEEP_USDC_MICRO || "1519527");
  const observedBurnedGasLamports = BigInt(process.env.OBSERVED_BURNED_GAS_LAMPORTS || "23406634");
  const gasUsd = lamportsToSol(observedBurnedGasLamports) * solPriceUsd;
  const cyclesPerDay = Number(process.env.AGGRESSIVE_CYCLES_PER_DAY || "1000");

  const plans = targets().map((targetNetUsd) => {
    const requiredTreasuryDeltaUsdc = targetNetUsd + gasUsd;
    const requiredFeeFirstUsdc = Math.max(0, requiredTreasuryDeltaUsdc - microToUsdc(observedSweepMicro));

    // Kimi-style feeFirst formula:
    // feeFirst = cushionExtra * 0.75 - 0.5 safety
    const requiredCushionExtraUsdc = (requiredFeeFirstUsdc + 0.5) / 0.75;
    const cushionExtraMicro = BigInt(Math.ceil(requiredCushionExtraUsdc * 1e6));
    const cushionSolLamports = estimateCushionSolLamports({
      kaminoFlashFeeMicro,
      solPriceUsd,
      cushionExtraUsdcMicro: cushionExtraMicro,
      minCushionSolLamports: config.tx2MinCushionSolLamports
    });
    const feeFirstCreditMicro = estimateKimiStyleTreasuryCreditMicro({
      routeVolumeMicro,
      kaminoFlashFeeMicro,
      cushionExtraUsdcMicro: cushionExtraMicro
    });
    const expectedTreasuryDeltaUsdc = microToUsdc(feeFirstCreditMicro + observedSweepMicro);
    const expectedNetUsd = expectedTreasuryDeltaUsdc - gasUsd;
    const requiredFloatSol = lamportsToSol(cushionSolLamports + observedBurnedGasLamports + 20_000_000n);

    return {
      targetNetUsd,
      requiredCushionExtraUsdc,
      env: {
        TX2_CUSHION_EXTRA_USDC_MICRO: cushionExtraMicro.toString()
      },
      expected: {
        feeFirstCreditUsdc: microToUsdc(feeFirstCreditMicro),
        observedSweepUsdc: microToUsdc(observedSweepMicro),
        treasuryDeltaUsdc: expectedTreasuryDeltaUsdc,
        gasUsd,
        netUsd: expectedNetUsd,
        cushionSol: lamportsToSol(cushionSolLamports),
        requiredFloatSol,
        projectedDailyNetUsd: expectedNetUsd * cyclesPerDay
      }
    };
  });

  const selected = plans.find((plan) => plan.targetNetUsd >= 25) ?? plans[0] ?? null;
  const receipt = {
    verdict: selected ? "AGGRESSIVE_PLAN_READY_NO_LIVE" : "AGGRESSIVE_PLAN_NO_TARGETS",
    generatedAt: new Date().toISOString(),
    ledgerMode: "treasury",
    solPriceUsd,
    routeVolumeUsdc: config.routeVolumeUsdc,
    cyclesPerDay,
    plans,
    selected,
    liveBoundary: [
      "No live TX from this planner.",
      "Fund RedemptionArc crank to selected.expected.requiredFloatSol or higher.",
      "Run exact TX0/TX2/TX3 simulation with selected env.",
      "Only then approve one live cycle."
    ]
  };

  const out = writeReceipt("REDEMPTION-AGGRESSIVE-PLAN-LATEST.json", receipt);
  console.log(`${receipt.verdict} selected=${selected?.targetNetUsd ?? "none"} net=${selected?.expected.netUsd.toFixed(4) ?? "n/a"} floatSol=${selected?.expected.requiredFloatSol.toFixed(6) ?? "n/a"} daily=${selected?.expected.projectedDailyNetUsd.toFixed(2) ?? "n/a"} receipt=${out}`);
  if (!selected) process.exitCode = 1;
}

main();
