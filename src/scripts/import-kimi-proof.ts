import fs from "node:fs";
import path from "node:path";
import { writeReceipt } from "../utils/receipt.js";

type KimiReceipt = {
  type?: string;
  createdAt?: string;
  solPriceUsd?: number;
  liveGate?: {
    expectedNetUsd?: number;
    expectedProfitUsd?: number;
    gasEstLamports?: string;
  };
  result?: {
    treasuryUsdcDelta?: string;
    gasSpentLamports?: string;
    feeFirstCreditMicro?: string;
    sweepMicro?: string;
    hopTotalFeesMicro?: string;
    profitPass?: boolean;
    tx2Signature?: string;
    tx3Signature?: string | null;
  };
};

function toNumberMicro(value: string | undefined): number {
  return Number(BigInt(value ?? "0")) / 1e6;
}

function toSol(value: string | undefined): number {
  return Number(BigInt(value ?? "0")) / 1e9;
}

function percentile(values: number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.floor((sorted.length - 1) * p)));
  return sorted[index];
}

function main() {
  const receiptsDir = process.env.KIMI_RECEIPTS_DIR || "/Users/velon/Desktop/DOCTORKIMI-ENGINE/receipts";
  const files = fs.existsSync(receiptsDir)
    ? fs.readdirSync(receiptsDir).filter((file) => file.endsWith(".json")).sort()
    : [];

  const cycles = files.flatMap((file) => {
    try {
      const parsed = JSON.parse(fs.readFileSync(path.join(receiptsDir, file), "utf8")) as KimiReceipt;
      if (parsed.type !== "doctorkimi-cycle" || !parsed.result) return [];
      const treasuryDeltaUsdc = toNumberMicro(parsed.result.treasuryUsdcDelta);
      const gasSol = toSol(parsed.result.gasSpentLamports);
      const solPriceUsd = parsed.solPriceUsd ?? 0;
      const gasUsd = gasSol * solPriceUsd;
      const netUsd = treasuryDeltaUsdc - gasUsd;
      return [{
        file,
        createdAt: parsed.createdAt,
        solPriceUsd,
        treasuryDeltaUsdc,
        gasSol,
        gasUsd,
        netUsd,
        feeFirstUsdc: toNumberMicro(parsed.result.feeFirstCreditMicro),
        sweepUsdc: toNumberMicro(parsed.result.sweepMicro),
        hopTotalFeesUnits: toNumberMicro(parsed.result.hopTotalFeesMicro),
        profitPass: Boolean(parsed.result.profitPass),
        tx2Signature: parsed.result.tx2Signature,
        tx3Signature: parsed.result.tx3Signature
      }];
    } catch {
      return [];
    }
  });

  const positive = cycles.filter((cycle) => cycle.netUsd > 0 && cycle.profitPass);
  const netValues = cycles.map((cycle) => cycle.netUsd);
  const deltas = cycles.map((cycle) => cycle.treasuryDeltaUsdc);
  const gasSol = cycles.map((cycle) => cycle.gasSol);

  const sum = (values: number[]) => values.reduce((a, b) => a + b, 0);
  const avg = (values: number[]) => values.length ? sum(values) / values.length : 0;

  const latest = cycles.at(-1) ?? null;
  const receipt = {
    verdict: cycles.length > 0 ? "KIMI_PROOF_IMPORTED_READ_ONLY" : "KIMI_PROOF_NOT_FOUND",
    generatedAt: new Date().toISOString(),
    receiptsDir,
    cycleCount: cycles.length,
    positiveCount: positive.length,
    stats: {
      totalNetUsd: sum(netValues),
      avgNetUsd: avg(netValues),
      medianNetUsd: percentile(netValues, 0.5),
      p10NetUsd: percentile(netValues, 0.1),
      p90NetUsd: percentile(netValues, 0.9),
      avgTreasuryDeltaUsdc: avg(deltas),
      avgGasSol: avg(gasSol)
    },
    latest,
    classification: {
      cashCounted: "treasury USDC delta minus crank SOL gas valued at receipt SOL price",
      nonCashNotCounted: "HOP/custom token units are evidence only until settled to SOL/USDC",
      executionUse: "read-only evidence; forbidden as wallet source for RedemptionArc"
    }
  };

  const out = writeReceipt("REDEMPTION-KIMI-PROOF-IMPORT-LATEST.json", receipt);
  console.log(`${receipt.verdict} cycles=${cycles.length} positive=${positive.length} avgNet=${receipt.stats.avgNetUsd.toFixed(6)} latestNet=${latest?.netUsd.toFixed(6) ?? "n/a"} receipt=${out}`);
  if (cycles.length === 0) process.exitCode = 1;
}

main();
