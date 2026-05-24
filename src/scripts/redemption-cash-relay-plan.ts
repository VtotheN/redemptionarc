import fs from "node:fs";
import { loadConfig, type RedemptionConfig } from "../config.js";
import { FORBIDDEN_WALLETS } from "../constants.js";
import { writeReceipt } from "../utils/receipt.js";
import { assertNoForbiddenConfigured } from "../utils/safety.js";

type CashAsset = "USDC" | "SOL";
type PayerClass = "external_protocol" | "owned_inventory" | "unknown";

type SourceClassification = {
  sourceReceiptPath: string | null;
  verdict: string | null;
  sourceClass: string | null;
  sourceName: string | null;
  payerClass: string | null;
  asset: string | null;
  decimals: number | null;
};

type CashMath = {
  beforeRaw: string | null;
  afterRaw: string | null;
  deltaRaw: string | null;
  deltaUi: number;
  assetPriceUsd: number | null;
  cashDeltaUsd: number;
  costsUsd: number;
  liabilitiesUsd: number;
  inventoryDrawUsd: number;
  totalCostsUsd: number;
  netCashUsd: number;
};

const OUT_RECEIPT = "REDEMPTION-CASH-RELAY-LATEST.json";
const NEXT_REQUIRED_EXACT_BUILD = [
  "Build a source adapter that emits the CashRelay source receipt shape from an authority-exclusive actuator.",
  "Use GGSS/UNDERWHEEL only after exact no-send simulation proves a SOL/USDC vault delta.",
  "Keep HOP/custom-token balances as control or metering only; never count them as profit.",
  "Replace this no-send planner with a reviewed live executor only after Velon approves an exact ready receipt."
];

function boolEnv(name: string, fallback: boolean): boolean {
  const raw = process.env[name];
  if (raw == null || raw === "") return fallback;
  return ["1", "true", "yes", "y"].includes(raw.toLowerCase());
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function readJson(file: string): unknown {
  return JSON.parse(fs.readFileSync(file, "utf8")) as unknown;
}

function stringField(record: Record<string, unknown>, key: string, reasons: string[]): string | null {
  const value = record[key];
  if (typeof value !== "string" || value.length === 0) {
    reasons.push(`source receipt missing exact string field ${key}`);
    return null;
  }
  return value;
}

function booleanField(record: Record<string, unknown>, key: string, reasons: string[]): boolean | null {
  const value = record[key];
  if (typeof value !== "boolean") {
    reasons.push(`source receipt missing exact boolean field ${key}`);
    return null;
  }
  return value;
}

function numberField(record: Record<string, unknown>, key: string, reasons: string[]): number {
  const value = record[key];
  if (typeof value !== "number" || !Number.isFinite(value)) {
    reasons.push(`source receipt missing exact finite number field ${key}`);
    return 0;
  }
  if (value < 0) {
    reasons.push(`source receipt field ${key} must be non-negative`);
  }
  return value;
}

function integerField(record: Record<string, unknown>, key: string, reasons: string[]): number | null {
  const value = record[key];
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
    reasons.push(`source receipt missing exact non-negative integer field ${key}`);
    return null;
  }
  return value;
}

function parseRaw(value: string | null, label: string, reasons: string[]): bigint | null {
  if (value == null || !/^[0-9]+$/.test(value)) {
    reasons.push(`source receipt field ${label} must be an unsigned integer string`);
    return null;
  }
  return BigInt(value);
}

function rawToUiNumber(raw: bigint, decimals: number): number {
  const sign = raw < 0n ? -1 : 1;
  const abs = raw < 0n ? -raw : raw;
  const base = 10n ** BigInt(decimals);
  const whole = abs / base;
  const fraction = abs % base;
  const fractionText = decimals === 0 ? "" : `.${fraction.toString().padStart(decimals, "0")}`;
  return sign * Number(`${whole.toString()}${fractionText}`);
}

function assetPriceUsd(asset: CashAsset, config: RedemptionConfig, reasons: string[]): number | null {
  if (asset === "USDC") return 1;
  if (typeof config.solPriceUsd === "number" && Number.isFinite(config.solPriceUsd) && config.solPriceUsd > 0) {
    return config.solPriceUsd;
  }
  reasons.push("SOL source requires SOL_PRICE_USD to compute exact netCashUsd");
  return null;
}

function collectForbiddenWalletHits(value: unknown, hits: Set<string>): void {
  if (typeof value === "string") {
    if (FORBIDDEN_WALLETS.has(value)) hits.add(value);
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectForbiddenWalletHits(item, hits);
    return;
  }
  if (!isRecord(value)) return;
  for (const item of Object.values(value)) collectForbiddenWalletHits(item, hits);
}

function collectSignalStrings(value: unknown, out: string[], keyPath = ""): void {
  if (typeof value === "string") {
    if (/(source|asset|token|mint|profit|payer|strategy|class|reason|risk|note|description|verdict|mode)/i.test(keyPath)) {
      out.push(value);
    }
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((item, index) => collectSignalStrings(item, out, `${keyPath}.${index}`));
    return;
  }
  if (!isRecord(value)) return;
  for (const [key, item] of Object.entries(value)) {
    collectSignalStrings(item, out, keyPath ? `${keyPath}.${key}` : key);
  }
}

function collectHardRejectFlags(value: unknown, reasons: Set<string>): void {
  if (!isRecord(value)) return;

  const booleanRejects: Array<[RegExp, string]> = [
    [/^(usesHop|hopProfit|customTokenProfit|countsHopAsProfit)$/i, "HOP/custom token counted as profit is not accepted cash"],
    [/(ownPoolUsdcRecycled|recyclesOwnPoolUsdc|ownPoolRecycle|selfFundedUsdc|ownedVaultDrain)/i, "own-pool USDC recycled into treasury is not profit"],
    [/(quoteOnly|publicRace|fasterBot|executorOnly)/i, "quote-only spread or public race assumption is not an authority-exclusive cash source"],
    [/(rentRecovery|salvage|recurringSalvage)/i, "rent recovery or salvage cannot be counted as a recurring CashRelay source"]
  ];

  for (const [key, item] of Object.entries(value)) {
    if (item === true) {
      for (const [pattern, reason] of booleanRejects) {
        if (pattern.test(key)) reasons.add(reason);
      }
    }
    if (isRecord(item) || Array.isArray(item)) collectHardRejectFlags(item, reasons);
  }

  const strings: string[] = [];
  collectSignalStrings(value, strings);
  const combined = strings.join("\n").toLowerCase();
  if (/\bhop\b|custom token|token-2022/.test(combined)) {
    reasons.add("HOP/custom token counted as profit is not accepted cash");
  }
  if (/own[-_ ]?pool|self[-_ ]?seeded|recycled .*usdc|usdc .*recycled|owned[-_ ]?vault drain/.test(combined)) {
    reasons.add("own-pool USDC recycled into treasury is not profit");
  }
  if (/quote[-_ ]?only|public race|faster bot|executor[-_ ]?only/.test(combined)) {
    reasons.add("quote-only spread or public race assumption is not an authority-exclusive cash source");
  }
  if (/rent recovery|salvage/.test(combined)) {
    reasons.add("rent recovery or salvage cannot be counted as a recurring CashRelay source");
  }
}

function buildBaseReceipt(
  config: RedemptionConfig | null,
  verdict: string,
  sourcePath: string | null,
  sourceClassification: SourceClassification,
  cashMath: CashMath,
  rejectionReasons: string[]
) {
  const allowLive = config?.allowLive ?? boolEnv("ALLOW_LIVE", false);
  const dryRun = config?.dryRun ?? boolEnv("DRY_RUN", true);
  const liveTxApproved = process.env.LIVE_TX_APPROVED === "true";
  const minNetUsd = config?.minNetUsd ?? Number(process.env.MIN_NET_USD || "0.25");

  return {
    verdict,
    generatedAt: new Date().toISOString(),
    noSend: true,
    dryRun,
    allowLive,
    liveTxApproved,
    liveIntentIgnored: allowLive || liveTxApproved
      ? "ALLOW_LIVE/LIVE_TX_APPROVED are ignored by RedemptionCashRelay V1; planner is no-send only."
      : null,
    sourceReceiptPath: sourcePath,
    minNetUsd,
    architecture: {
      hop: "control / metering only",
      ggssUnderwheel: "future actuator source",
      acceptedProfit: "USDC/SOL vault delta after all costs",
      cashRelay: "judge"
    },
    sourceClassification,
    cashMath,
    cashProofGate: {
      pass: rejectionReasons.length === 0,
      requiresAuthorityExclusiveActuator: true,
      requiresExternalProtocolPayer: true,
      requiresSolOrUsdcDelta: true,
      requiresCleanSimulation: true,
      requiresNetCashUsdAtLeastMin: true
    },
    rejectionReasons,
    nextRequiredExactBuild: NEXT_REQUIRED_EXACT_BUILD
  };
}

function emptyClassification(sourcePath: string | null): SourceClassification {
  return {
    sourceReceiptPath: sourcePath,
    verdict: null,
    sourceClass: null,
    sourceName: null,
    payerClass: null,
    asset: null,
    decimals: null
  };
}

function emptyCashMath(): CashMath {
  return {
    beforeRaw: null,
    afterRaw: null,
    deltaRaw: null,
    deltaUi: 0,
    assetPriceUsd: null,
    cashDeltaUsd: 0,
    costsUsd: 0,
    liabilitiesUsd: 0,
    inventoryDrawUsd: 0,
    totalCostsUsd: 0,
    netCashUsd: 0
  };
}

function evaluateSourceReceipt(source: unknown, sourcePath: string, config: RedemptionConfig) {
  const rejectionReasons = new Set<string>();
  const requiredFieldReasons: string[] = [];

  if (!isRecord(source)) {
    requiredFieldReasons.push("source receipt root must be a JSON object");
    return {
      sourceClassification: emptyClassification(sourcePath),
      cashMath: emptyCashMath(),
      rejectionReasons: requiredFieldReasons
    };
  }

  const verdict = stringField(source, "verdict", requiredFieldReasons);
  const noSend = booleanField(source, "noSend", requiredFieldReasons);
  const sourceClass = stringField(source, "sourceClass", requiredFieldReasons);
  const sourceName = stringField(source, "sourceName", requiredFieldReasons);
  const payerClass = stringField(source, "payerClass", requiredFieldReasons);
  const asset = stringField(source, "asset", requiredFieldReasons);
  const beforeRaw = stringField(source, "beforeRaw", requiredFieldReasons);
  const afterRaw = stringField(source, "afterRaw", requiredFieldReasons);
  const decimals = integerField(source, "decimals", requiredFieldReasons);
  const costsUsd = numberField(source, "costsUsd", requiredFieldReasons);
  const liabilitiesUsd = numberField(source, "liabilitiesUsd", requiredFieldReasons);
  const inventoryDrawUsd = numberField(source, "inventoryDrawUsd", requiredFieldReasons);

  if (noSend !== true) rejectionReasons.add("source receipt must be exact no-send evidence");
  if (sourceClass !== "authority_exclusive_actuator") {
    rejectionReasons.add("sourceClass must be authority_exclusive_actuator");
  }
  if (payerClass === "owned_inventory") {
    rejectionReasons.add("payerClass owned_inventory is a hard reject");
  } else if (payerClass !== "external_protocol") {
    rejectionReasons.add("payerClass must be external_protocol");
  }
  if (asset !== "USDC" && asset !== "SOL") {
    rejectionReasons.add("asset must be USDC or SOL; HOP/custom-token profit is rejected");
  }
  if (asset === "USDC" && decimals !== 6) rejectionReasons.add("USDC source must use 6 decimals");
  if (asset === "SOL" && decimals !== 9) rejectionReasons.add("SOL source must use 9 decimals");
  if (!Object.prototype.hasOwnProperty.call(source, "simErr")) {
    requiredFieldReasons.push("source receipt missing exact nullable field simErr");
  }
  if (source.simErr !== null) rejectionReasons.add("simErr must be null");

  const before = parseRaw(beforeRaw, "beforeRaw", requiredFieldReasons);
  const after = parseRaw(afterRaw, "afterRaw", requiredFieldReasons);
  const deltaRaw = before != null && after != null ? after - before : null;
  if (deltaRaw != null && deltaRaw <= 0n) {
    rejectionReasons.add("afterRaw must be greater than beforeRaw");
  }

  const price = asset === "USDC" || asset === "SOL"
    ? assetPriceUsd(asset, config, requiredFieldReasons)
    : null;
  const deltaUi = deltaRaw != null && decimals != null && deltaRaw > 0n
    ? rawToUiNumber(deltaRaw, decimals)
    : 0;
  const cashDeltaUsd = price == null ? 0 : deltaUi * price;
  const totalCostsUsd = costsUsd + liabilitiesUsd + inventoryDrawUsd;
  const netCashUsd = cashDeltaUsd - totalCostsUsd;

  if (netCashUsd < config.minNetUsd) {
    rejectionReasons.add(`netCashUsd ${netCashUsd.toFixed(6)} below MIN_NET_USD ${config.minNetUsd}`);
  }

  const forbiddenHits = new Set<string>();
  collectForbiddenWalletHits(source, forbiddenHits);
  for (const wallet of forbiddenHits) {
    rejectionReasons.add(`source receipt references forbidden Kimi/legacy wallet ${wallet}`);
  }
  collectHardRejectFlags(source, rejectionReasons);

  const sourceClassification: SourceClassification = {
    sourceReceiptPath: sourcePath,
    verdict,
    sourceClass,
    sourceName,
    payerClass,
    asset,
    decimals
  };

  const cashMath: CashMath = {
    beforeRaw,
    afterRaw,
    deltaRaw: deltaRaw?.toString() ?? null,
    deltaUi,
    assetPriceUsd: price,
    cashDeltaUsd,
    costsUsd,
    liabilitiesUsd,
    inventoryDrawUsd,
    totalCostsUsd,
    netCashUsd
  };

  return {
    sourceClassification,
    cashMath,
    rejectionReasons: [...requiredFieldReasons, ...rejectionReasons]
  };
}

function writeAndExit(receipt: ReturnType<typeof buildBaseReceipt>): void {
  const out = writeReceipt(OUT_RECEIPT, receipt);
  console.log(`${receipt.verdict} netCashUsd=${receipt.cashMath.netCashUsd.toFixed(6)} receipt=${out}`);
  if (receipt.rejectionReasons.length > 0) {
    console.log(`blocked=${receipt.rejectionReasons.join(" | ")}`);
    process.exitCode = 1;
  }
}

function main(): void {
  let config: RedemptionConfig | null = null;
  try {
    config = loadConfig();
    assertNoForbiddenConfigured(config);
  } catch (error) {
    const reason = `config rejected: ${errorMessage(error)}`;
    const receipt = buildBaseReceipt(
      config,
      "REDEMPTION_CASH_RELAY_BLOCKED",
      process.env.CASH_SOURCE_RECEIPT_PATH ?? null,
      emptyClassification(process.env.CASH_SOURCE_RECEIPT_PATH ?? null),
      emptyCashMath(),
      [reason]
    );
    writeAndExit(receipt);
    return;
  }

  const sourcePath = process.env.CASH_SOURCE_RECEIPT_PATH?.trim() || null;
  if (!sourcePath || !fs.existsSync(sourcePath)) {
    const reason = sourcePath
      ? `CASH_SOURCE_RECEIPT_PATH does not exist: ${sourcePath}`
      : "CASH_SOURCE_RECEIPT_PATH is required";
    const receipt = buildBaseReceipt(
      config,
      "REDEMPTION_CASH_RELAY_BLOCKED_MISSING_SOURCE",
      sourcePath,
      emptyClassification(sourcePath),
      emptyCashMath(),
      [reason]
    );
    writeAndExit(receipt);
    return;
  }

  let source: unknown;
  try {
    source = readJson(sourcePath);
  } catch (error) {
    const receipt = buildBaseReceipt(
      config,
      "REDEMPTION_CASH_RELAY_BLOCKED",
      sourcePath,
      emptyClassification(sourcePath),
      emptyCashMath(),
      [`source receipt is not readable JSON: ${errorMessage(error)}`]
    );
    writeAndExit(receipt);
    return;
  }

  const evaluation = evaluateSourceReceipt(source, sourcePath, config);
  const verdict = evaluation.rejectionReasons.length === 0
    ? "REDEMPTION_CASH_RELAY_READY_NO_LIVE"
    : "REDEMPTION_CASH_RELAY_BLOCKED";
  const receipt = buildBaseReceipt(
    config,
    verdict,
    sourcePath,
    evaluation.sourceClassification,
    evaluation.cashMath,
    evaluation.rejectionReasons
  );
  writeAndExit(receipt);
}

main();
