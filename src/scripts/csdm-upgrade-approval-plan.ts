import fs from "node:fs";
import { loadConfig } from "../config.js";
import { writeReceipt } from "../utils/receipt.js";
import { assertNoForbiddenConfigured } from "../utils/safety.js";

const OUT_RECEIPT = "CSDM-UPGRADE-APPROVAL-PLAN-LATEST.json";
const DEFAULT_PREFLIGHT = "receipts/CSDM-UPGRADE-PREFLIGHT-LATEST.json";
const DEFAULT_LIVE_SHAPE = "receipts/CSDM-LIVE-SHAPE-SCAN-LATEST.json";
const DEFAULT_FEE_PAYER = "keys/crank.json";

function strEnv(name: string, fallback: string): string {
  const raw = process.env[name];
  return raw == null || raw.trim() === "" ? fallback : raw.trim();
}

function readJson(file: string): unknown {
  return JSON.parse(fs.readFileSync(file, "utf8")) as unknown;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function record(value: unknown, name: string): Record<string, unknown> {
  if (!isRecord(value)) throw new Error(`${name} is not an object`);
  return value;
}

function string(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function bool(value: unknown): boolean | null {
  return typeof value === "boolean" ? value : null;
}

function number(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

async function main(): Promise<void> {
  const config = loadConfig();
  assertNoForbiddenConfigured(config);

  const preflightPath = strEnv("CSDM_UPGRADE_PREFLIGHT_RECEIPT", DEFAULT_PREFLIGHT);
  const liveShapePath = strEnv("CSDM_LIVE_SHAPE_RECEIPT", DEFAULT_LIVE_SHAPE);
  const feePayerPath = strEnv("CSDM_UPGRADE_FEE_PAYER_KEYPAIR_PATH", DEFAULT_FEE_PAYER);
  const preflight = record(readJson(preflightPath), preflightPath);
  const liveShape = record(readJson(liveShapePath), liveShapePath);
  const program = record(preflight.program, "preflight.program");
  const localInputs = record(preflight.localInputs, "preflight.localInputs");
  const upgradeReadiness = record(preflight.upgradeReadiness, "preflight.upgradeReadiness");
  const liveShapeBlock = record(liveShape.liveShape, "liveShape.liveShape");
  const cashProofGate = record(liveShape.cashProofGate, "liveShape.cashProofGate");

  const programId = string(program.programId);
  const programDataAddress = string(program.programDataAddress);
  const programDataSlot = string(program.programDataSlot);
  const upgradeAuthority = string(program.upgradeAuthority);
  const liveElfSha256 = string(program.liveElfSha256);
  const artifactPath = string(localInputs.artifactPath);
  const artifactSha256 = string(localInputs.artifactSha256);
  const artifactBytes = number(localInputs.artifactBytes);
  const liveElfBytes = number(program.liveElfBytes);
  const byteHeadroom = number(localInputs.byteHeadroom);
  const programKeypair = record(localInputs.programKeypair, "localInputs.programKeypair");
  const authorityKeypair = record(localInputs.authorityKeypair, "localInputs.authorityKeypair");
  const programKeypairPath = string(programKeypair.path);
  const authorityKeypairPath = string(authorityKeypair.path);

  const readinessPass = bool(upgradeReadiness.pass) === true;
  const liveShapePass = bool(liveShapeBlock.pass) === true;
  const cashProofPass = bool(cashProofGate.pass) === true;

  const exactCommand = [
    "solana program deploy",
    "--url", "\"$SOLANA_RPC_URL\"",
    "--fee-payer", feePayerPath,
    "--program-id", programKeypairPath ?? "<missing-program-keypair>",
    "--upgrade-authority", authorityKeypairPath ?? "<missing-authority-keypair>",
    "--no-auto-extend",
    artifactPath ?? "<missing-artifact>"
  ].join(" ");

  const blockers = [
    readinessPass ? null : "CSDM upgrade preflight is not passing",
    liveShapePass ? null : "CSDM live-shape scan is not passing",
    programId ? null : "missing programId",
    programDataAddress ? null : "missing ProgramData address",
    upgradeAuthority ? null : "missing upgrade authority",
    programKeypairPath ? null : "missing local program keypair path",
    authorityKeypairPath ? null : "missing local authority keypair path",
    artifactPath ? null : "missing artifact path",
    artifactSha256 ? null : "missing artifact hash",
    liveElfSha256 ? null : "missing live ELF hash"
  ].filter((value): value is string => value !== null);

  const receipt = {
    verdict: blockers.length === 0
      ? "CSDM_UPGRADE_APPROVAL_READY_NO_LIVE"
      : "CSDM_UPGRADE_APPROVAL_BLOCKED",
    generatedAt: new Date().toISOString(),
    noSend: true,
    dryRun: config.dryRun,
    allowLive: config.allowLive,
    liveIntentIgnored: "This planner only emits the exact upgrade packet. It never runs solana program deploy.",
    approvalPacket: {
      requiresExplicitUserApproval: true,
      exactCommandNotRun: exactCommand,
      programId,
      programDataAddress,
      programDataSlot,
      upgradeAuthority,
      programKeypairPath,
      authorityKeypairPath,
      feePayerPath,
      artifactPath,
      artifactBytes,
      liveElfBytes,
      byteHeadroom,
      artifactSha256,
      liveElfSha256,
      noAutoExtend: true
    },
    sourceReceipts: {
      preflightPath,
      preflightVerdict: string(preflight.verdict),
      liveShapePath,
      liveShapeVerdict: string(liveShape.verdict)
    },
    postUpgradeRequiredImmediately: [
      "Run npm run csdm-upgrade-preflight again and verify ProgramData slot/hash changed to the pinned artifact.",
      "Run ix7 flash_lend_backing simulation against CSDM live-shape accounts.",
      "Emit a CashRelay source receipt with spendable SOL/USDC beforeRaw/afterRaw after all costs.",
      "Do not count CSDM receipt mint, HOP, T22 fees, or self-fees as profit."
    ],
    cashProofGate: {
      pass: false,
      upstreamCashProofPass: cashProofPass,
      reason: "This packet only approves an engineering upgrade. Profit remains blocked until SOL/USDC wallet/vault delta passes RedemptionCashRelay."
    },
    blockers
  };

  const file = writeReceipt(OUT_RECEIPT, receipt);
  console.log(JSON.stringify({
    verdict: receipt.verdict,
    receipt: file,
    approvalReady: blockers.length === 0,
    programId,
    artifactSha256,
    byteHeadroom,
    cashProofPass: receipt.cashProofGate.pass
  }, null, 2));

  if (blockers.length > 0) process.exit(1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
