import "dotenv/config";
import dotenv from "dotenv";
import fs from "node:fs";
import { writeReceipt } from "../utils/receipt.js";

if (process.env.ENV_PATH) {
  dotenv.config({ path: process.env.ENV_PATH, override: true });
}

type CycleReceipt = {
  solPriceUsd: number;
  result: {
    treasuryUsdcDelta: string;
    crankSolBefore: string;
    crankSolAfter: string;
    gasSpentLamports?: string;
    feeFirstCreditMicro?: string;
    sweepMicro?: string;
    tx2Signature: string;
    tx3Signature: string | null;
  };
};

function readCycle(id: string): CycleReceipt | null {
  const file = `receipts/REDEMPTION-LIVE-CYCLE-${id}.json`;
  return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) as CycleReceipt : null;
}

async function jupiterSolUsdc(): Promise<number | null> {
  try {
    const url = "https://api.jup.ag/swap/v1/quote?inputMint=So11111111111111111111111111111111111111112&outputMint=EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v&amount=1000000000&slippageBps=10";
    const quote = await (await fetch(url)).json() as any;
    if (!quote.outAmount) return null;
    return Number(quote.outAmount) / 1e6;
  } catch {
    return null;
  }
}

function analyze(id: string, label: string, env: Record<string, string>) {
  const cycle = readCycle(id);
  if (!cycle) return null;
  const result = cycle.result;
  const treasuryUsdcDelta = Number(result.treasuryUsdcDelta) / 1e6;
  const solCost = (Number(result.crankSolBefore) - Number(result.crankSolAfter)) / 1e9;
  const netAtReceiptPrice = treasuryUsdcDelta - solCost * cycle.solPriceUsd;
  const breakEvenSolUsd = solCost > 0 ? treasuryUsdcDelta / solCost : null;
  return {
    id,
    label,
    env,
    tx2: result.tx2Signature,
    tx3: result.tx3Signature,
    treasuryUsdcDelta,
    solCost,
    netAtReceiptPrice,
    receiptSolPriceUsd: cycle.solPriceUsd,
    breakEvenSolUsd,
    feeFirstUsdc: Number(result.feeFirstCreditMicro ?? "0") / 1e6,
    sweepUsdc: Number(result.sweepMicro ?? "0") / 1e6
  };
}

async function main() {
  const currentQuote = await jupiterSolUsdc();
  const profiles = [
    analyze("003", "aggressive treasury-positive", {
      SOL_PRICE_USD: "86.75",
      ROUTE_VOLUME_USDC: "39",
      HOPS: "2",
      TX2_CUSHION_EXTRA_USDC_MICRO: "34681332",
      TX2_MIN_CUSHION_SOL_LAMPORTS: "10000000",
      TX2_CU_PRICE_MICRO_LAMPORTS: "100"
    }),
    analyze("006", "micro near-breakeven", {
      SOL_PRICE_USD: "86.75",
      ROUTE_VOLUME_USDC: "39",
      HOPS: "2",
      TX2_CUSHION_EXTRA_USDC_MICRO: "0",
      TX2_MIN_CUSHION_SOL_LAMPORTS: "9800000",
      TX2_CU_PRICE_MICRO_LAMPORTS: "100"
    })
  ].filter(Boolean);

  const bestRepeatableCandidate = profiles
    .filter((profile: any) => profile.breakEvenSolUsd != null)
    .sort((a: any, b: any) => b.netAtReceiptPrice - a.netAtReceiptPrice)[0] as any | undefined;
  const liveWindow = bestRepeatableCandidate?.breakEvenSolUsd != null && currentQuote != null
    ? currentQuote < bestRepeatableCandidate.breakEvenSolUsd
    : false;

  const receipt = {
    verdict: liveWindow ? "KAMINO_ORCA_STYLE_WINDOW_OPEN_NO_SEND" : "KAMINO_ORCA_STYLE_WINDOW_CLOSED",
    generatedAt: new Date().toISOString(),
    currentJupiterSolUsdc: currentQuote,
    rule: "For Kamino baseline, only consider live when current SOL/USDC quote is below the empirical break-even of the selected profile and no-send simulation passes.",
    orcaStyleCostControls: {
      tx2CuPriceMicroLamports: 100,
      keepWsolAtaOpen: true,
      closeEmptyAtaOnlyOutsideLoop: true,
      refillPolicy: "deficit-only; never convert a fixed large USDC amount after every cycle",
      cushionPolicy: "use empirical min cushion profile; do not over-cushion for treasury-only optics",
      slippagePolicy: "quote immediately before TX0 and reject if quote moved past break-even"
    },
    profiles,
    selected: bestRepeatableCandidate ?? null,
    liveWindow,
    next: liveWindow
      ? "Run exact no-send TX0/TX2/TX3 sim for selected profile, then one live cycle only if total-system cash gate is positive."
      : "Do not run Kamino loop now; preserve baseline and continue Marginfi/Pinocchio cost removal."
  };

  const out = writeReceipt("REDEMPTION-KAMINO-ORCA-STYLE-SCAN-LATEST.json", receipt);
  console.log(`${receipt.verdict} quote=${currentQuote?.toFixed(6) ?? "n/a"} selected=${bestRepeatableCandidate?.id ?? "none"} receipt=${out}`);
  if (!liveWindow) process.exitCode = 1;
}

main();
