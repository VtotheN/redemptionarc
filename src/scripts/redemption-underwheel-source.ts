import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { loadConfig } from "../config.js";
import { writeReceipt } from "../utils/receipt.js";
import { assertNoForbiddenConfigured } from "../utils/safety.js";

const OUT_RECEIPT = "REDEMPTION-UNDERWHEEL-CASH-SOURCE-LATEST.json";

type CashRelaySourceReceipt = {
  verdict: string;
  noSend: boolean;
  sourceClass: string;
  sourceName: string;
  payerClass: "external_protocol" | "owned_inventory" | "unknown";
  asset: "USDC" | "SOL";
  beforeRaw: string;
  afterRaw: string;
  decimals: number;
  costsUsd: number;
  liabilitiesUsd: number;
  inventoryDrawUsd: number;
  simErr: null | unknown;
  [key: string]: unknown;
};

type AdapterResult = {
  path: string;
  receipt: CashRelaySourceReceipt;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readJson(file: string): unknown {
  return JSON.parse(fs.readFileSync(file, "utf8")) as unknown;
}

function numberValue(value: unknown, fallback = 0): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function stringValue(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}

function boolValue(value: unknown, fallback = false): boolean {
  return typeof value === "boolean" ? value : fallback;
}

function getRecord(record: Record<string, unknown>, key: string): Record<string, unknown> | null {
  const value = record[key];
  return isRecord(value) ? value : null;
}

function getPath(record: Record<string, unknown>, keys: string[]): unknown {
  let current: unknown = record;
  for (const key of keys) {
    if (!isRecord(current)) return undefined;
    current = current[key];
  }
  return current;
}

function usdToUsdcRaw(value: number): string {
  return Math.max(0, Math.round(value * 1_000_000)).toString();
}

function defaultUnderwheelReceiptPath(): string | null {
  const explicit = process.env.UNDERWHEEL_RECEIPT_PATH?.trim();
  if (explicit) return explicit;

  const repoPath = process.env.UNDERWHEEL_REPO_PATH?.trim() || "/Users/velon/gh-src-vtothen/UNDERWHEEL";
  const candidates = [
    path.join(repoPath, "receipts/latest-plan.json"),
    "/Users/velon/Desktop/UNDERWHEEL/receipts/latest-plan.json",
  ];
  return candidates.find((candidate) => fs.existsSync(candidate)) ?? candidates[0] ?? null;
}

function missingReceipt(pathValue: string | null, reason: string): CashRelaySourceReceipt {
  return {
    verdict: "UNDERWHEEL_CASH_SOURCE_BLOCKED_MISSING_RECEIPT",
    noSend: true,
    sourceClass: "missing_underwheel_receipt",
    sourceName: "UNDERWHEEL/GGSS adapter",
    payerClass: "unknown",
    asset: "USDC",
    beforeRaw: "0",
    afterRaw: "0",
    decimals: 6,
    costsUsd: 0,
    liabilitiesUsd: 0,
    inventoryDrawUsd: 0,
    simErr: reason,
    adapter: {
      sourceReceiptPath: pathValue,
      rejectionReasons: [reason],
      nextRequiredExactBuild: [
        "Run UNDERWHEEL dry-run so receipts/latest-plan.json exists.",
        "Require an exact no-send receipt with simulated USDC/SOL beforeRaw and afterRaw.",
      ],
    },
  };
}

function passThroughCashRelaySource(source: Record<string, unknown>, sourcePath: string): CashRelaySourceReceipt | null {
  const nested = getRecord(source, "cashRelaySource");
  if (!nested) return null;

  return {
    verdict: stringValue(nested.verdict, "UNDERWHEEL_CASH_SOURCE_IMPORTED"),
    noSend: boolValue(nested.noSend, false),
    sourceClass: stringValue(nested.sourceClass, "unknown"),
    sourceName: stringValue(nested.sourceName, "UNDERWHEEL/GGSS cashRelaySource"),
    payerClass: stringValue(nested.payerClass, "unknown") as CashRelaySourceReceipt["payerClass"],
    asset: stringValue(nested.asset, "USDC") === "SOL" ? "SOL" : "USDC",
    beforeRaw: stringValue(nested.beforeRaw, "0"),
    afterRaw: stringValue(nested.afterRaw, "0"),
    decimals: numberValue(nested.decimals, stringValue(nested.asset, "USDC") === "SOL" ? 9 : 6),
    costsUsd: numberValue(nested.costsUsd),
    liabilitiesUsd: numberValue(nested.liabilitiesUsd),
    inventoryDrawUsd: numberValue(nested.inventoryDrawUsd),
    simErr: Object.prototype.hasOwnProperty.call(nested, "simErr") ? nested.simErr : "missing simErr",
    adapter: {
      sourceReceiptPath: sourcePath,
      mode: "pass-through cashRelaySource",
    },
    underwheelRawSummary: summarizeSource(source),
  };
}

function summarizeSource(source: Record<string, unknown>): Record<string, unknown> {
  return {
    type: source.type ?? null,
    createdAt: source.createdAt ?? null,
    verdict: source.verdict ?? null,
    sourceClass: source.sourceClass ?? null,
    gate: source.gate ?? null,
    executionGate: source.executionGate ?? null,
    economics: source.economics ?? null,
    result: source.result ?? null,
    addresses: source.addresses ?? null,
    accounts: source.accounts ?? null,
  };
}

function classifyUnderwheel(source: Record<string, unknown>): {
  payerClass: CashRelaySourceReceipt["payerClass"];
  sourceClass: string;
  reasons: string[];
} {
  const reasons: string[] = [];
  const rawSourceClass = stringValue(source.sourceClass).toLowerCase();
  const receiptKind = [
    stringValue(source.type),
    stringValue(source.verdict),
    stringValue(getPath(source, ["feeFirst", "sourceClass"])),
    stringValue(getPath(source, ["collectedEvidence", "sourceClass"])),
  ].join(" ").toLowerCase();
  const economics = getRecord(source, "economics");
  const classification = stringValue(economics?.classification);
  const objectivePass = boolValue(economics?.objectivePass);
  const markToMarketPass = boolValue(economics?.markToMarketPass);
  const localMechanicalOnly =
    boolValue(getPath(source, ["plan", "sameGgssTest"])) ||
    boolValue(getPath(source, ["result", "localMechanicalOnly"]));
  const gateCanExecute =
    boolValue(getPath(source, ["gate", "canExecute"])) ||
    boolValue(getPath(source, ["executionGate", "canExecute"]));

  if (localMechanicalOnly) {
    reasons.push("local SAME_GGSS/mechanical receipt is not cash profit");
  }
  if (/owned|inventory|preloaded|solvency|fee-first|controlled/.test(rawSourceClass)) {
    reasons.push(`sourceClass is not external cash: ${source.sourceClass}`);
  }
  if (/controlled|fee-first|already-collected|owned[-_ ]?vault|owned[-_ ]?fee/.test(receiptKind)) {
    reasons.push("receipt is controlled/fee-first/owned-vault evidence, not external cash");
  }
  if (classification === "cash-out") {
    reasons.push("UNDERWHEEL classification is cash-out, not net system profit");
  }
  if (classification === "loss") {
    reasons.push("UNDERWHEEL classification is loss");
  }
  if (!gateCanExecute) {
    reasons.push("UNDERWHEEL gate cannot execute");
  }
  if (!objectivePass || !markToMarketPass) {
    reasons.push("UNDERWHEEL economics do not pass profit/mark-to-market gates");
  }

  if (
    gateCanExecute &&
    objectivePass &&
    markToMarketPass &&
    classification === "profit" &&
    !localMechanicalOnly &&
    !/owned|inventory|preloaded|solvency|fee-first|controlled/.test(rawSourceClass)
  ) {
    return {
      payerClass: "external_protocol",
      sourceClass: "authority_exclusive_actuator",
      reasons,
    };
  }

  const payerClass = reasons.some((reason) => /owned|inventory|cash-out|mechanical|fee-first|controlled/i.test(reason))
    ? "owned_inventory"
    : "unknown";
  return {
    payerClass,
    sourceClass: "underwheel_unproven_cash_source",
    reasons,
  };
}

function deriveExactUsdcDelta(source: Record<string, unknown>): {
  beforeRaw: string;
  afterRaw: string;
  reason: string | null;
} {
  const cashProof = getRecord(source, "cashProof") ?? getRecord(source, "cashProofGate");
  if (cashProof) {
    const beforeRaw = stringValue(cashProof.beforeRaw);
    const afterRaw = stringValue(cashProof.afterRaw);
    if (beforeRaw && afterRaw) return { beforeRaw, afterRaw, reason: null };
  }

  const result = getRecord(source, "result");
  const beforeRaw = result?.usdcBeforeRaw;
  const afterRaw = result?.usdcAfterRaw;
  if (typeof beforeRaw === "number" && typeof afterRaw === "number") {
    return {
      beforeRaw: Math.max(0, Math.floor(beforeRaw)).toString(),
      afterRaw: Math.max(0, Math.floor(afterRaw)).toString(),
      reason: null,
    };
  }
  if (typeof beforeRaw === "string" && typeof afterRaw === "string") {
    return { beforeRaw, afterRaw, reason: null };
  }

  const beforeOwnedFeeVault = numberValue(getPath(source, ["before", "ownedUsdcFeeVault"]), NaN);
  const afterOwnedFeeVault = numberValue(getPath(source, ["after", "ownedUsdcFeeVault"]), NaN);
  if (Number.isFinite(beforeOwnedFeeVault) && Number.isFinite(afterOwnedFeeVault)) {
    return {
      beforeRaw: usdToUsdcRaw(beforeOwnedFeeVault),
      afterRaw: usdToUsdcRaw(afterOwnedFeeVault),
      reason: "using owned USDC fee vault delta only; CashRelay must still reject owned inventory",
    };
  }

  const availableFees = numberValue(getPath(source, ["feeMath", "availableFeeFirstUsdcFees"]), NaN);
  if (Number.isFinite(availableFees) && availableFees > 0) {
    return {
      beforeRaw: "0",
      afterRaw: usdToUsdcRaw(availableFees),
      reason: "fee-first gate is solvency evidence, not an exact same-cycle cash delta",
    };
  }

  return {
    beforeRaw: "0",
    afterRaw: "0",
    reason: "UNDERWHEEL receipt does not expose exact USDC/SOL beforeRaw and afterRaw",
  };
}

function deriveInventoryDrawUsd(source: Record<string, unknown>): number {
  const treasurySpend = numberValue(getPath(source, ["collectedEvidence", "treasurySpendUsdc"]), NaN);
  if (Number.isFinite(treasurySpend) && treasurySpend > 0) return treasurySpend;

  const nestedTreasurySpend = numberValue(getPath(source, ["feeFirst", "collectedEvidence", "treasurySpendUsdc"]), NaN);
  if (Number.isFinite(nestedTreasurySpend) && nestedTreasurySpend > 0) return nestedTreasurySpend;

  const planAmountIn = numberValue(getPath(source, ["plan", "amountInUsdc"]), NaN);
  if (Number.isFinite(planAmountIn) && planAmountIn > 0) return planAmountIn;

  const treasuryUsdcDelta = numberValue(getPath(source, ["deltas", "treasuryUsdc"]), NaN);
  if (Number.isFinite(treasuryUsdcDelta) && treasuryUsdcDelta < 0) return Math.abs(treasuryUsdcDelta);

  const ownedSource = numberValue(getPath(source, ["tx2MathUsd", "ownedSourcePulledFromVault"]), NaN);
  if (Number.isFinite(ownedSource) && ownedSource > 0) return ownedSource;

  const economics = getRecord(source, "economics");
  const systemSolDelta = numberValue(economics?.systemSolDelta, 0);
  const marketPrice =
    numberValue(getPath(source, ["plan", "marketPrice"]), 0) ||
    numberValue(getPath(source, ["inputs", "marketPrice"]), 0);
  if (systemSolDelta < 0 && marketPrice > 0) return Math.abs(systemSolDelta) * marketPrice;

  return 0;
}

function deriveSimErr(source: Record<string, unknown>): unknown {
  if (Object.prototype.hasOwnProperty.call(source, "simErr")) return source.simErr;
  const simulation = getRecord(source, "simulation");
  if (simulation) return Object.prototype.hasOwnProperty.call(simulation, "err") ? simulation.err : null;
  const simulations = source.simulations;
  if (Array.isArray(simulations)) {
    const failed = simulations.find((item) => isRecord(item) && item.err != null);
    return failed && isRecord(failed) ? failed.err : null;
  }
  const collectAttempt = getRecord(source, "collectAttempt");
  if (collectAttempt && Object.prototype.hasOwnProperty.call(collectAttempt, "err")) return collectAttempt.err;
  return "missing exact simulation result";
}

function adaptUnderwheelReceipt(source: Record<string, unknown>, sourcePath: string): CashRelaySourceReceipt {
  const passThrough = passThroughCashRelaySource(source, sourcePath);
  if (passThrough) return passThrough;

  const classification = classifyUnderwheel(source);
  const exactDelta = deriveExactUsdcDelta(source);
  const costsUsd = numberValue(getPath(source, ["economics", "txCostUsdEst"]));
  const inventoryDrawUsd = deriveInventoryDrawUsd(source);
  const simErr = deriveSimErr(source);
  const sends = source.sends;
  const sourceHasLiveSends = Array.isArray(sends) && sends.length > 0;
  const noSend = boolValue(source.noSend, !sourceHasLiveSends && !source.success);
  const sourceName = [
    "UNDERWHEEL/GGSS",
    stringValue(source.type, "unknown-receipt"),
    stringValue(source.verdict),
  ].filter(Boolean).join(" ");

  const rejectionReasons = [
    ...classification.reasons,
    exactDelta.reason,
    noSend ? null : "source receipt is live/executed evidence; CashRelay V1 accepts no-send receipts only",
    simErr == null ? null : "source receipt simulation is missing or failed",
  ].filter((reason): reason is string => Boolean(reason));

  return {
    verdict: rejectionReasons.length === 0
      ? "UNDERWHEEL_CASH_SOURCE_READY_FOR_RELAY"
      : "UNDERWHEEL_CASH_SOURCE_BLOCKED",
    noSend,
    sourceClass: rejectionReasons.length === 0 ? "authority_exclusive_actuator" : classification.sourceClass,
    sourceName,
    payerClass: rejectionReasons.length === 0 ? "external_protocol" : classification.payerClass,
    asset: "USDC",
    beforeRaw: exactDelta.beforeRaw,
    afterRaw: exactDelta.afterRaw,
    decimals: 6,
    costsUsd,
    liabilitiesUsd: 0,
    inventoryDrawUsd,
    simErr,
    adapter: {
      sourceReceiptPath: sourcePath,
      adapterVerdict: rejectionReasons.length === 0 ? "READY" : "BLOCKED",
      rejectionReasons,
      requires: [
        "noSend=true",
        "UNDERWHEEL gate.canExecute=true",
        "economics.classification=profit",
        "economics.markToMarketPass=true",
        "exact simulated beforeRaw/afterRaw for USDC or SOL",
        "no owned inventory draw counted as profit",
      ],
      nextRequiredExactBuild: [
        "Patch UNDERWHEEL dry-run receipts to include cashRelaySource.beforeRaw/afterRaw from simulated post balances.",
        "Use payerClass=external_protocol only when external Raydium/protocol settlement increases wallet USDC/SOL after costs.",
        "Keep fee-first/preloaded GGSS USDC as solvency runway unless a fresh external payer funds it.",
      ],
    },
    underwheelRawSummary: summarizeSource(source),
  };
}

export function writeUnderwheelCashSourceReceipt(): AdapterResult {
  const config = loadConfig();
  assertNoForbiddenConfigured(config);

  const sourcePath = defaultUnderwheelReceiptPath();
  if (!sourcePath || !fs.existsSync(sourcePath)) {
    const receipt = missingReceipt(sourcePath, `UNDERWHEEL receipt missing: ${sourcePath ?? "not configured"}`);
    const out = writeReceipt(OUT_RECEIPT, receipt);
    return { path: out, receipt };
  }

  let source: unknown;
  try {
    source = readJson(sourcePath);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const receipt = missingReceipt(sourcePath, `UNDERWHEEL receipt unreadable JSON: ${message}`);
    const out = writeReceipt(OUT_RECEIPT, receipt);
    return { path: out, receipt };
  }

  const receipt = isRecord(source)
    ? adaptUnderwheelReceipt(source, sourcePath)
    : missingReceipt(sourcePath, "UNDERWHEEL receipt root is not a JSON object");
  const out = writeReceipt(OUT_RECEIPT, receipt);
  return { path: out, receipt };
}

function main(): void {
  const result = writeUnderwheelCashSourceReceipt();
  console.log(`${result.receipt.verdict} payerClass=${result.receipt.payerClass} receipt=${result.path}`);
  const rejectionReasons = isRecord(result.receipt.adapter) && Array.isArray(result.receipt.adapter.rejectionReasons)
    ? result.receipt.adapter.rejectionReasons
    : [];
  if (rejectionReasons.length > 0) {
    console.log(`sourceBlocked=${rejectionReasons.join(" | ")}`);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
