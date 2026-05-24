import fs from "node:fs";
import { loadConfig } from "../config.js";
import { writeReceipt } from "../utils/receipt.js";
import { assertNoForbiddenConfigured } from "../utils/safety.js";

const OUT_RECEIPT = "CSDM-IX7-APPROVAL-PLAN-LATEST.json";
const DEFAULT_SIM_RECEIPT = "receipts/CSDM-IX7-SIM-LATEST.json";
const DEFAULT_KEEPER_ENV_PATH = "/Users/velon/gh-src-vtothen/EXPERIMENTO-lazyloop/.env.keeper";
const DEFAULT_SIM_CWD = "/Users/velon/gh-src-vtothen/EXPERIMENTO-lazyloop/enchancedblock/keeper";

type AnyRecord = Record<string, unknown>;

function strEnv(name: string, fallback: string): string {
  const raw = process.env[name];
  return raw == null || raw.trim() === "" ? fallback : raw.trim();
}

function readJson(file: string): AnyRecord {
  return JSON.parse(fs.readFileSync(file, "utf8")) as AnyRecord;
}

function record(value: unknown): AnyRecord {
  return typeof value === "object" && value !== null ? value as AnyRecord : {};
}

function bool(value: unknown): boolean {
  return value === true;
}

function string(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

async function main(): Promise<void> {
  const config = loadConfig();
  assertNoForbiddenConfigured(config);

  const simReceiptPath = strEnv("CSDM_IX7_SIM_RECEIPT", DEFAULT_SIM_RECEIPT);
  const keeperEnvPath = strEnv("CSDM_KEEPER_ENV_PATH", DEFAULT_KEEPER_ENV_PATH);
  const simCwd = strEnv("CSDM_SIM_COMMAND_CWD", DEFAULT_SIM_CWD);
  const simReceipt = readJson(simReceiptPath);
  const simulation = record(simReceipt.simulation);
  const upstream = record(simReceipt.upstreamProofs);
  const simInputs = record(simReceipt.inputs);
  const maxOracleAgeSlots = string(simInputs.maxOracleAgeSlots);
  const liveEnvPrefix = maxOracleAgeSlots
    ? `CSDM_SIM_ORACLE_AGE_SLOTS=${maxOracleAgeSlots} `
    : "";

  const exactCommand = [
    `cd ${simCwd}`,
    `set -a`,
    `source ${keeperEnvPath}`,
    `set +a`,
    `${liveEnvPrefix}CSDM_DRY_RUN=false npm run csdm:live`
  ].join("\n");

  const rejections = [
    simReceipt.verdict === "CSDM_IX7_SIM_READY_NO_LIVE" ? null : "CSDM ix7 sim receipt is not ready",
    bool(upstream.liveElfPrefixMatchesArtifact) ? null : "CSDM live program prefix does not match approved ix7 artifact",
    bool(upstream.liveShapePass) ? null : "CSDM live-shape proof is not passing",
    simulation.judge === "PASS" ? null : "CSDM ix7 simulation judge is not PASS",
    simulation.err === null ? null : "CSDM ix7 simulation has an error",
    simulation.firstLiveSig === null ? null : "simulation receipt unexpectedly contains a live signature",
    simulation.forceSimulate === false ? null : "live approval requires strict simulation with forceSimulate=false",
    simulation.gatePass === true ? null : "CSDM ix7 simulation gatePass is false",
    simulation.solvencyPass === true ? null : "CSDM ix7 simulation solvencyPass is false",
    fs.existsSync(keeperEnvPath) ? null : "keeper env file missing",
    fs.existsSync(`${simCwd}/package.json`) ? null : "simulator cwd package.json missing"
  ].filter((value): value is string => value !== null);

  const receipt = {
    verdict: rejections.length === 0
      ? "CSDM_IX7_APPROVAL_READY_NO_LIVE"
      : "CSDM_IX7_APPROVAL_BLOCKED",
    generatedAt: new Date().toISOString(),
    noSend: true,
    dryRun: true,
    allowLive: false,
    liveIntentIgnored: "This planner only emits the exact live command. It never runs npm run csdm:live.",
    requiresExplicitUserApproval: true,
    approvalPacket: {
      exactCommandNotRun: exactCommand,
      commandSafety: [
        "Do not add FORCE_CSDM_SIMULATE=true for live approval.",
        maxOracleAgeSlots
          ? `This packet pins CSDM_SIM_ORACLE_AGE_SLOTS=${maxOracleAgeSlots} to tolerate build/send slot lag.`
          : "This packet uses the keeper default CSDM max oracle age.",
        "The live script re-simulates and sends only if CSDM_LIVE=true and CSDM_DRY_RUN is not true.",
        "Run a fresh npm run csdm-ix7-sim immediately before any live send."
      ],
      expectedLiveMode: "CSDM_LIVE=true via npm run csdm:live, CSDM_DRY_RUN=false",
      signerMaterialSource: keeperEnvPath,
      signerSecretsRecorded: false
    },
    pinnedProofs: {
      simReceiptPath,
      csdmProgramId: string(upstream.csdmProgramId),
      programDataSlot: string(upstream.programDataSlot),
      liveElfPrefixSha256: string(upstream.liveElfPrefixSha256),
      liveElfPrefixMatchesArtifact: upstream.liveElfPrefixMatchesArtifact,
      lastUpgradeSignature: string(upstream.lastUpgradeSignature),
      backingRaw: string(upstream.backingRaw),
      maxAmountRaw: string(upstream.maxAmountRaw),
      minRepayDeltaRawFromConfig: string(upstream.minRepayDeltaRawFromConfig),
      runtimeBackingOracleToPass: string(upstream.runtimeBackingOracleToPass)
    },
    pinnedSimulation: {
      command: record(simReceipt.inputs).simulatorCommand,
      forceSimulate: simulation.forceSimulate,
      maxOracleAgeSlots,
      borrowerIx: simulation.borrowerIx,
      flashAmountAtoms: simulation.flashAmountAtoms,
      minRepayDeltaAtoms: simulation.minRepayDeltaAtoms,
      marketPriceUsd: simulation.marketPriceUsd,
      estimatedUsdcOut: simulation.estimatedUsdcOut,
      fairUsdcOracle: simulation.fairUsdcOracle,
      surplusVsOracle: simulation.surplusVsOracle,
      edgeOracleBps: simulation.edgeOracleBps,
      dynamicBaitBps: simulation.dynamicBaitBps,
      expectedPool1SolOutAtoms: simulation.expectedPool1SolOutAtoms,
      repayRequiredAtoms: simulation.repayRequiredAtoms,
      gatePass: simulation.gatePass,
      solvencyPass: simulation.solvencyPass,
      err: simulation.err,
      unitsConsumed: simulation.unitsConsumed,
      judge: simulation.judge
    },
    cashProofGate: {
      pass: false,
      reason: "Approval readiness is not profit. CashRelay remains blocked until a confirmed live receipt shows real SOL/USDC afterRaw > beforeRaw after costs.",
      postLiveRequiredReceipt: {
        sourceClass: "authority_exclusive_actuator",
        payerClass: "external_protocol",
        asset: "SOL or USDC",
        beforeRaw: "required",
        afterRaw: "required",
        simErr: null,
        costsUsd: "required",
        liabilitiesUsd: "required",
        inventoryDrawUsd: "required"
      }
    },
    rejections,
    nextRequiredExactBuild: rejections.length === 0
      ? [
        "Wait for explicit Velon approval before running the exact command.",
        "After live confirmation, build a post-live source receipt with SOL/USDC beforeRaw and afterRaw.",
        "Only feed that post-live source receipt into RedemptionCashRelay."
      ]
      : [
        "Fix rejections, rerun npm run csdm-ix7-sim, then regenerate this approval plan."
      ]
  };

  const file = writeReceipt(OUT_RECEIPT, receipt);
  console.log(JSON.stringify({
    verdict: receipt.verdict,
    receipt: file,
    approvalReady: rejections.length === 0,
    exactCommandNotRun: exactCommand,
    cashProofPass: receipt.cashProofGate.pass,
    rejections
  }, null, 2));

  if (rejections.length > 0) process.exit(1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
