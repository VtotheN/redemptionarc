import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import dotenv from "dotenv";
import { loadConfig } from "../config.js";
import { writeReceipt } from "../utils/receipt.js";
import { assertNoForbiddenConfigured } from "../utils/safety.js";

const OUT_RECEIPT = "CSDM-IX7-SIM-LATEST.json";
const DEFAULT_KEEPER_ENV_PATH = "/Users/velon/gh-src-vtothen/EXPERIMENTO-lazyloop/.env.keeper";
const DEFAULT_SIM_CWD = "/Users/velon/gh-src-vtothen/EXPERIMENTO-lazyloop/enchancedblock/keeper";
const DEFAULT_PREFLIGHT = "receipts/CSDM-UPGRADE-PREFLIGHT-LATEST.json";
const DEFAULT_LIVE_SHAPE = "receipts/CSDM-LIVE-SHAPE-SCAN-LATEST.json";

type AnyRecord = Record<string, unknown>;

function strEnv(name: string, fallback: string): string {
  const raw = process.env[name];
  return raw == null || raw.trim() === "" ? fallback : raw.trim();
}

function readJson(file: string): AnyRecord {
  return JSON.parse(fs.readFileSync(file, "utf8")) as AnyRecord;
}

function asRecord(value: unknown): AnyRecord {
  return typeof value === "object" && value !== null ? value as AnyRecord : {};
}

function tail(value: string, lines = 40): string[] {
  return value.split(/\r?\n/).filter(Boolean).slice(-lines);
}

function outputText(value: string | Buffer | null | undefined): string {
  if (value == null) return "";
  return typeof value === "string" ? value : value.toString("utf8");
}

function parseLastJsonObject(stdout: string): AnyRecord | null {
  const lineStartMatches = [...stdout.matchAll(/(?:^|\n)\{/g)];
  const start = lineStartMatches.length > 0
    ? lineStartMatches[lineStartMatches.length - 1].index! + (lineStartMatches[lineStartMatches.length - 1][0].startsWith("\n") ? 1 : 0)
    : stdout.indexOf("{");
  if (start < 0) return null;
  const candidate = stdout.slice(start).trim();
  try {
    return JSON.parse(candidate) as AnyRecord;
  } catch {
    return null;
  }
}

function loadEnvFile(file: string): NodeJS.ProcessEnv {
  if (!fs.existsSync(file)) return {};
  const parsed = dotenv.parse(fs.readFileSync(file, "utf8"));
  return Object.fromEntries(Object.entries(parsed));
}

function boolField(record: AnyRecord, name: string): boolean {
  return record[name] === true;
}

function stringField(record: AnyRecord, name: string): string | null {
  const value = record[name];
  return typeof value === "string" ? value : null;
}

function boolEnv(name: string, fallback: boolean): boolean {
  const raw = process.env[name];
  if (raw == null || raw.trim() === "") return fallback;
  return ["1", "true", "yes", "y"].includes(raw.toLowerCase());
}

async function main(): Promise<void> {
  const config = loadConfig();
  assertNoForbiddenConfigured(config);

  const keeperEnvPath = strEnv("CSDM_KEEPER_ENV_PATH", DEFAULT_KEEPER_ENV_PATH);
  const simCwd = strEnv("CSDM_SIM_COMMAND_CWD", DEFAULT_SIM_CWD);
  const preflightPath = strEnv("CSDM_UPGRADE_PREFLIGHT_RECEIPT", DEFAULT_PREFLIGHT);
  const liveShapePath = strEnv("CSDM_LIVE_SHAPE_RECEIPT", DEFAULT_LIVE_SHAPE);
  const forceSimulate = boolEnv("CSDM_IX7_FORCE_SIMULATE", false);
  const maxOracleAgeSlots = process.env.CSDM_IX7_MAX_ORACLE_AGE_SLOTS?.trim()
    || process.env.CSDM_SIM_ORACLE_AGE_SLOTS?.trim()
    || null;
  const flashAmountAtoms = process.env.CSDM_IX7_FLASH_AMOUNT_ATOMS?.trim()
    || process.env.CSDM_FLASH_AMOUNT_ATOMS?.trim()
    || null;
  const minRepayDeltaAtoms = process.env.CSDM_IX7_MIN_REPAY_DELTA_ATOMS?.trim()
    || process.env.CSDM_MIN_REPAY_DELTA_ATOMS?.trim()
    || null;
  const preflight = readJson(preflightPath);
  const liveShape = readJson(liveShapePath);
  const preflightProgram = asRecord(preflight.program);
  const liveShapeGate = asRecord(liveShape.liveShape);

  const preflightReady =
    preflight.verdict === "CSDM_UPGRADE_PREFLIGHT_READY_NO_LIVE"
    && boolField(preflightProgram, "liveElfPrefixMatchesArtifact");
  const liveShapeReady =
    liveShape.verdict === "CSDM_LIVE_SHAPE_READY_NO_LIVE"
    && boolField(liveShapeGate, "pass");

  const envFileVars = loadEnvFile(keeperEnvPath);
  const commandEnv: NodeJS.ProcessEnv = {
    ...process.env,
    ...envFileVars,
    CSDM_DRY_RUN: "true"
  };
  if (forceSimulate) commandEnv.FORCE_CSDM_SIMULATE = "true";
  else delete commandEnv.FORCE_CSDM_SIMULATE;
  if (maxOracleAgeSlots) commandEnv.CSDM_SIM_ORACLE_AGE_SLOTS = maxOracleAgeSlots;
  if (flashAmountAtoms) commandEnv.CSDM_FLASH_AMOUNT_ATOMS = flashAmountAtoms;
  if (minRepayDeltaAtoms) commandEnv.CSDM_MIN_REPAY_DELTA_ATOMS = minRepayDeltaAtoms;
  delete commandEnv.CSDM_LIVE;
  delete commandEnv.LIVE_TX_APPROVED;
  commandEnv.ALLOW_LIVE = "false";

  const simulatorEnvPrefix = [
    maxOracleAgeSlots ? `CSDM_SIM_ORACLE_AGE_SLOTS=${maxOracleAgeSlots}` : null,
    flashAmountAtoms ? `CSDM_FLASH_AMOUNT_ATOMS=${flashAmountAtoms}` : null,
    minRepayDeltaAtoms ? `CSDM_MIN_REPAY_DELTA_ATOMS=${minRepayDeltaAtoms}` : null
  ].filter((value): value is string => value !== null).join(" ");
  const simulatorCommandPrefix = simulatorEnvPrefix ? `${simulatorEnvPrefix} ` : "";

  const commandReady = fs.existsSync(path.join(simCwd, "package.json"))
    && fs.existsSync(path.join(simCwd, "node_modules"))
    && Boolean(commandEnv.KEEPER_PRIVATE_KEY);

  let result: ReturnType<typeof spawnSync> | null = null;
  let parsed: AnyRecord | null = null;
  if (preflightReady && liveShapeReady && commandReady) {
    result = spawnSync("npm", ["run", "csdm:simulate"], {
      cwd: simCwd,
      env: commandEnv,
      encoding: "utf8",
      maxBuffer: 16 * 1024 * 1024
    });
    parsed = parseLastJsonObject(outputText(result.stdout));
  }

  const simPass =
    result?.status === 0
    && parsed !== null
    && parsed.judge === "PASS"
    && parsed.err === null
    && parsed.simulated === true
    && parsed.first_live_sig === null;

  const rejections = [
    preflightReady ? null : "CSDM post-upgrade preflight does not prove live prefix matches artifact",
    liveShapeReady ? null : "CSDM live-shape scan is not ready",
    fs.existsSync(keeperEnvPath) ? null : "CSDM keeper env file missing",
    fs.existsSync(path.join(simCwd, "package.json")) ? null : "CSDM simulator package.json missing",
    fs.existsSync(path.join(simCwd, "node_modules")) ? null : "CSDM simulator dependencies missing; run npm ci in simulator cwd",
    commandEnv.KEEPER_PRIVATE_KEY ? null : "CSDM simulator keeper key env missing",
    result === null || result.status === 0 ? null : `CSDM simulator exited ${result.status}`,
    parsed !== null || result === null ? null : "CSDM simulator stdout did not contain parseable JSON",
    simPass || result === null ? null : "CSDM ix7 simulation did not PASS with no live signature"
  ].filter((value): value is string => value !== null);

  const receipt = {
    verdict: rejections.length === 0
      ? "CSDM_IX7_SIM_READY_NO_LIVE"
      : "CSDM_IX7_SIM_BLOCKED",
    generatedAt: new Date().toISOString(),
    noSend: true,
    dryRun: true,
    allowLive: false,
    liveIntentIgnored: "This script forces CSDM_DRY_RUN=true, removes CSDM_LIVE, and never sends a transaction.",
    inputs: {
      keeperEnvPath,
      simCwd,
      preflightPath,
      liveShapePath,
      simulatorCommand: forceSimulate
        ? `${simulatorCommandPrefix}CSDM_DRY_RUN=true FORCE_CSDM_SIMULATE=true npm run csdm:simulate`
        : `${simulatorCommandPrefix}CSDM_DRY_RUN=true npm run csdm:simulate`,
      forceSimulate,
      maxOracleAgeSlots,
      flashAmountAtoms,
      minRepayDeltaAtoms,
      envSecretsRecorded: false
    },
    upstreamProofs: {
      csdmProgramId: stringField(preflightProgram, "programId"),
      programDataSlot: stringField(preflightProgram, "programDataSlot"),
      liveElfPrefixSha256: stringField(preflightProgram, "liveElfPrefixSha256"),
      liveElfPrefixMatchesArtifact: preflightProgram.liveElfPrefixMatchesArtifact,
      lastUpgradeSignature: stringField(preflightProgram, "lastUpgradeSignature"),
      liveShapePass: liveShapeGate.pass,
      backingRaw: stringField(liveShapeGate, "backingRaw"),
      maxAmountRaw: stringField(liveShapeGate, "maxAmountRaw"),
      minRepayDeltaRawFromConfig: stringField(liveShapeGate, "minRepayDeltaRawFromConfig"),
      runtimeBackingOracleToPass: stringField(liveShapeGate, "runtimeBackingOracleToPass")
    },
    simulation: parsed ? {
      mode: parsed.mode,
      csdmProgram: parsed.csdmProgram,
      borrowerIx: parsed.borrowerIx,
      flashAmountAtoms: parsed.flashAmountAtoms,
      forceSimulate: parsed.forceSimulate,
      minRepayDeltaAtoms: parsed.minRepayDeltaAtoms,
      marketPriceUsd: parsed.marketPriceUsd,
      estimatedUsdcOut: parsed.estimatedUsdcOut,
      fairUsdcOracle: parsed.fairUsdcOracle,
      surplusVsOracle: parsed.surplusVsOracle,
      edgeOracleBps: parsed.edgeOracleBps,
      dynamicBaitBps: parsed.dynamicBaitBps,
      expectedPool1SolOutAtoms: parsed.expectedPool1SolOutAtoms,
      repayRequiredAtoms: parsed.repayRequiredAtoms,
      gatePass: parsed.gatePass,
      solvencyPass: parsed.solvencyPass,
      err: parsed.err,
      unitsConsumed: parsed.unitsConsumed,
      judge: parsed.judge,
      firstLiveSig: parsed.first_live_sig,
      logTail: parsed.logTail
    } : null,
    commandResult: result ? {
      status: result.status,
      signal: result.signal,
      stdoutTail: tail(outputText(result.stdout), 12),
      stderrTail: tail(outputText(result.stderr), 12)
    } : null,
    cashProofGate: {
      pass: false,
      reason: "Simulation proves ix7 mechanics only. It is not spendable SOL/USDC wallet growth until a separately approved live transaction confirms post balances after all costs.",
      requiredForCashRelay: [
        "exact live approval receipt for one ix7 transaction or bundle",
        "confirmed signature",
        "beforeRaw/afterRaw for SOL or USDC authority-exclusive vault/wallet",
        "costsUsd, liabilitiesUsd, and inventoryDrawUsd priced",
        "RedemptionCashRelay source receipt with payerClass=external_protocol"
      ]
    },
    rejections,
    nextRequiredExactBuild: rejections.length === 0
      ? [
        "Create a one-shot live approval planner for ix7 using the exact simulated accounts and signers.",
        "Live approval must still be manual; do not send from this simulator.",
        "After confirmation, emit a CashRelay source receipt with real SOL/USDC beforeRaw and afterRaw."
      ]
      : [
        "Fix rejections, rerun CSDM post-upgrade preflight and live-shape scan, then rerun this simulator."
      ]
  };

  const file = writeReceipt(OUT_RECEIPT, receipt);
  console.log(JSON.stringify({
    verdict: receipt.verdict,
    receipt: file,
    simPass,
    judge: parsed?.judge ?? null,
    err: parsed?.err ?? null,
    unitsConsumed: parsed?.unitsConsumed ?? null,
    cashProofPass: receipt.cashProofGate.pass,
    rejections
  }, null, 2));

  if (rejections.length > 0) process.exit(1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
