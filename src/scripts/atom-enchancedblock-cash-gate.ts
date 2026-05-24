import fs from "node:fs";
import path from "node:path";
import { Connection, PublicKey } from "@solana/web3.js";
import { loadConfig } from "../config.js";
import { writeReceipt } from "../utils/receipt.js";
import { assertNoForbiddenConfigured } from "../utils/safety.js";

const OUT_RECEIPT = "ATOM-ENCHANCEDBLOCK-CASH-GATE-LATEST.json";

const DEFAULT_ATOM_PROGRAM_ID = "BxJMJLxXJhKvuhvvxY57wYY69CAs9RCQWBv9JPCtm9Kx";
const DEFAULT_ENCHANCEDBLOCK_PROGRAM_ID = "61hviwfoDk6ygzJHJaDG2tsoWbBpUYWdNJnSSfRA1vPh";
const DEFAULT_CSDM_PROGRAM_ID = "Q9FMc5YLqjJe96geFtg43ocfyrpJYM2WDHkQEqh8aNv";

type AccountProbe = {
  pubkey: string;
  exists: boolean;
  executable: boolean;
  ownerProgram: string | null;
  dataLen: number;
};

type LocalAtomInspection = {
  repoPath: string;
  exists: boolean;
  flashOpenFound: boolean;
  borrowerExitFound: boolean;
  keeperLiquidateFound: boolean;
  hasTokenMintConstraint: boolean;
  hasTokenVaultConstraint: boolean;
  rejectsZeroBorrow: boolean;
  enforcesMaxDeadlineSlots: boolean;
  enforcesBorrowerExitBeforeDeadline: boolean;
  hasPermissionlessLiquidationAfterDeadline: boolean;
  supportsMultiSlotWindow: boolean;
  deployableLocalPrimitive: boolean;
};

type EnchancedblockInspection = {
  repoPath: string;
  exists: boolean;
  hasRealOrcaExecutor: boolean;
  hasForwardCycle: boolean;
  hasInverseCycle: boolean;
  hasJitoBundleBuilder: boolean;
  hasAdminRebalance: boolean;
  externalSourceClass: "external_orca_whirlpool" | "missing";
};

type GateReceiptSummary = {
  path: string | null;
  exists: boolean;
  verdict: string | null;
  pass: boolean;
  gatePass: boolean | null;
  simErr: unknown;
  forwardEdgeBps: number | null;
  inverseEdgeBps: number | null;
  chosenDirection: string | null;
  rejectionReasons: string[];
};

type HopRedeemInspection = {
  receiptPath: string | null;
  receiptExists: boolean;
  redeemable: boolean;
  backingAsset: string | null;
  vaultExists: boolean;
  redeemInstruction: string | null;
  exactBurnForCashProof: boolean;
  localHopRedeemProgramFound: boolean;
  bhivePatternFound: boolean;
  rejectionReasons: string[];
};

type CashRelayInspection = {
  receiptPath: string;
  exists: boolean;
  verdict: string | null;
  pass: boolean;
  netCashUsd: number | null;
  rejectionReasons: string[];
};

function strEnv(name: string, fallback: string): string {
  const raw = process.env[name];
  return raw == null || raw.trim() === "" ? fallback : raw.trim();
}

function optionalEnv(name: string): string | null {
  const raw = process.env[name];
  return raw == null || raw.trim() === "" ? null : raw.trim();
}

function readText(file: string): string {
  return fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "";
}

function readJson(file: string | null): unknown | null {
  if (!file || !fs.existsSync(file)) return null;
  return JSON.parse(fs.readFileSync(file, "utf8")) as unknown;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function bool(value: unknown): boolean | null {
  return typeof value === "boolean" ? value : null;
}

function num(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function string(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function findRepo(preferred: string, fallback: string): string {
  if (fs.existsSync(preferred)) return preferred;
  return fallback;
}

function inspectAtom(repoPath: string): LocalAtomInspection {
  const flashOpen = readText(path.join(repoPath, "programs/atom_ickk/src/instructions/flash_open.rs"));
  const borrowerExit = readText(path.join(repoPath, "programs/atom_ickk/src/instructions/borrower_exit.rs"));
  const keeperLiquidate = readText(path.join(repoPath, "programs/atom_ickk/src/instructions/keeper_liquidate.rs"));
  const poolState = readText(path.join(repoPath, "programs/atom_ickk/src/state/pool.rs"));

  const flashOpenFound = flashOpen.length > 0;
  const borrowerExitFound = borrowerExit.length > 0;
  const keeperLiquidateFound = keeperLiquidate.length > 0;
  const hasTokenMintConstraint = /has_one\s*=\s*token_mint/.test(flashOpen);
  const hasTokenVaultConstraint = /has_one\s*=\s*token_vault/.test(flashOpen);
  const rejectsZeroBorrow = /borrow_amount\s*>\s*0/.test(flashOpen);
  const enforcesMaxDeadlineSlots = /deadline_slots\s*<=\s*pool\.max_deadline_slots/.test(flashOpen) &&
    /max_deadline_slots/.test(poolState);
  const enforcesBorrowerExitBeforeDeadline = /current_slot\s*<=\s*position\.deadline_slot/.test(borrowerExit);
  const hasPermissionlessLiquidationAfterDeadline = /current_slot\s*>\s*position\.deadline_slot/.test(keeperLiquidate);
  const supportsMultiSlotWindow = /deadline_slots/.test(flashOpen) &&
    /Clock::get\(\)\?\.slot\.checked_add\(deadline_slots\)/.test(flashOpen);

  return {
    repoPath,
    exists: fs.existsSync(repoPath),
    flashOpenFound,
    borrowerExitFound,
    keeperLiquidateFound,
    hasTokenMintConstraint,
    hasTokenVaultConstraint,
    rejectsZeroBorrow,
    enforcesMaxDeadlineSlots,
    enforcesBorrowerExitBeforeDeadline,
    hasPermissionlessLiquidationAfterDeadline,
    supportsMultiSlotWindow,
    deployableLocalPrimitive: [
      flashOpenFound,
      borrowerExitFound,
      keeperLiquidateFound,
      hasTokenMintConstraint,
      hasTokenVaultConstraint,
      rejectsZeroBorrow,
      enforcesMaxDeadlineSlots,
      enforcesBorrowerExitBeforeDeadline,
      hasPermissionlessLiquidationAfterDeadline,
      supportsMultiSlotWindow
    ].every(Boolean)
  };
}

function inspectEnchancedblock(repoPath: string): EnchancedblockInspection {
  const orca = readText(path.join(repoPath, "keeper/src/orca/whirlpool.ts"));
  const loop = readText(path.join(repoPath, "keeper/src/strategies/selfArbLoop.ts"));
  const program = readText(path.join(repoPath, "programs/enchanced-cpmm/src/lib.rs"));
  const hasRealOrcaExecutor = /WHIRLPOOL_SOL_USDC_30BPS|OrcaWhirlpoolExecutor|swapQuoteByInputToken/.test(orca);
  const hasForwardCycle = /executeForwardCycle|executeForwardBundle/.test(loop);
  const hasInverseCycle = /executeInverseCycle|executeInverseBundle/.test(loop);
  const hasJitoBundleBuilder = /sendBundle|buildSellSolTx|buildBuySolTx/.test(loop);
  const hasAdminRebalance = /ix_admin_rebalance|0x05/.test(program);

  return {
    repoPath,
    exists: fs.existsSync(repoPath),
    hasRealOrcaExecutor,
    hasForwardCycle,
    hasInverseCycle,
    hasJitoBundleBuilder,
    hasAdminRebalance,
    externalSourceClass: hasRealOrcaExecutor ? "external_orca_whirlpool" : "missing"
  };
}

function summarizeGateReceipt(receiptPath: string | null): GateReceiptSummary {
  const rejectionReasons: string[] = [];
  const receipt = readJson(receiptPath);
  if (!receiptPath) rejectionReasons.push("ENCHANCEDBLOCK_GATE_RECEIPT_PATH is required for exact current edge proof");
  if (receiptPath && !receipt) rejectionReasons.push(`missing ENCHANCEDBLOCK gate receipt ${receiptPath}`);
  if (!isRecord(receipt)) {
    return {
      path: receiptPath,
      exists: Boolean(receipt),
      verdict: null,
      pass: false,
      gatePass: null,
      simErr: null,
      forwardEdgeBps: null,
      inverseEdgeBps: null,
      chosenDirection: null,
      rejectionReasons
    };
  }

  const gate = isRecord(receipt.gate) ? receipt.gate : receipt;
  const verdict = string(receipt.verdict);
  const gatePass = bool(gate.gatePass) ?? bool(gate.pass) ?? bool(receipt.pass);
  const simErr = Object.prototype.hasOwnProperty.call(receipt, "simErr")
    ? receipt.simErr
    : Object.prototype.hasOwnProperty.call(gate, "simErr")
      ? gate.simErr
      : null;
  const forwardEdgeBps = num(gate.forwardEdgeBps) ?? num(receipt.forwardEdgeBps);
  const inverseEdgeBps = num(gate.inverseEdgeBps) ?? num(receipt.inverseEdgeBps);
  const chosenDirection = string(gate.chosenDirection) ?? string(receipt.chosenDirection);

  if (gatePass !== true) rejectionReasons.push("ENCHANCEDBLOCK exact gate is not passing now");
  if (simErr !== null) rejectionReasons.push("ENCHANCEDBLOCK exact simulation has simErr");
  if (!chosenDirection || chosenDirection === "none") rejectionReasons.push("ENCHANCEDBLOCK has no chosen profitable direction");
  if ((forwardEdgeBps ?? 0) <= 0 && (inverseEdgeBps ?? 0) <= 0) {
    rejectionReasons.push("ENCHANCEDBLOCK edge bps is not positive");
  }

  return {
    path: receiptPath,
    exists: true,
    verdict,
    pass: rejectionReasons.length === 0,
    gatePass,
    simErr,
    forwardEdgeBps,
    inverseEdgeBps,
    chosenDirection,
    rejectionReasons
  };
}

function inspectHopRedeem(receiptPath: string | null): HopRedeemInspection {
  const rejectionReasons: string[] = [];
  const receipt = readJson(receiptPath);
  const localHopRedeemProgramFound = fs.existsSync("src/scripts/redeem-hop.ts") ||
    fs.existsSync("programs/hop-redeem/src/lib.rs");
  const bhivePatternFound = fs.existsSync("/Users/velon/gh-src-vtothen/EXPERIMENTO-bhivepool/bhive-pinocchio-sweeper/src/instructions/redeem_for_backing.rs");

  if (!receiptPath) rejectionReasons.push("HOP_REDEEM_RECEIPT_PATH is required; no HOP burn/redeem vault proof is wired");
  if (receiptPath && !receipt) rejectionReasons.push(`missing HOP redeem receipt ${receiptPath}`);

  if (!isRecord(receipt)) {
    if (!localHopRedeemProgramFound) {
      rejectionReasons.push("no local HOP redeem program found in RedemptionArc");
    }
    return {
      receiptPath,
      receiptExists: Boolean(receipt),
      redeemable: false,
      backingAsset: null,
      vaultExists: false,
      redeemInstruction: null,
      exactBurnForCashProof: false,
      localHopRedeemProgramFound,
      bhivePatternFound,
      rejectionReasons
    };
  }

  const redeemable = bool(receipt.redeemable) === true || bool(receipt.hopRedeemable) === true;
  const backingAsset = string(receipt.backingAsset) ?? string(receipt.asset);
  const vaultExists = bool(receipt.vaultExists) === true;
  const redeemInstruction = string(receipt.redeemInstruction) ?? string(receipt.instructionPath);
  const exactBurnForCashProof = bool(receipt.exactBurnForCashProof) === true ||
    (bool(receipt.noSend) === true && redeemable && vaultExists && Boolean(redeemInstruction));

  if (!redeemable) rejectionReasons.push("HOP is not marked redeemable in an exact receipt");
  if (backingAsset !== "USDC" && backingAsset !== "SOL") {
    rejectionReasons.push("HOP backing asset must be USDC or SOL");
  }
  if (!vaultExists) rejectionReasons.push("HOP backing vault existence not proven");
  if (!redeemInstruction) rejectionReasons.push("HOP redeem instruction path not declared");
  if (!exactBurnForCashProof) rejectionReasons.push("missing exact HOP burn/redeem no-send proof");

  return {
    receiptPath,
    receiptExists: true,
    redeemable,
    backingAsset,
    vaultExists,
    redeemInstruction,
    exactBurnForCashProof,
    localHopRedeemProgramFound,
    bhivePatternFound,
    rejectionReasons
  };
}

function inspectCashRelay(receiptPath: string): CashRelayInspection {
  const rejectionReasons: string[] = [];
  const receipt = readJson(receiptPath);
  if (!receipt) {
    rejectionReasons.push(`missing CashRelay receipt ${receiptPath}`);
    return { receiptPath, exists: false, verdict: null, pass: false, netCashUsd: null, rejectionReasons };
  }
  if (!isRecord(receipt)) {
    rejectionReasons.push("CashRelay receipt root is not a JSON object");
    return { receiptPath, exists: true, verdict: null, pass: false, netCashUsd: null, rejectionReasons };
  }

  const verdict = string(receipt.verdict);
  const cashMath = isRecord(receipt.cashMath) ? receipt.cashMath : {};
  const netCashUsd = num(cashMath.netCashUsd);
  const pass = verdict === "REDEMPTION_CASH_RELAY_READY_NO_LIVE";
  if (!pass) rejectionReasons.push(`CashRelay is not ready: ${verdict ?? "missing verdict"}`);

  return { receiptPath, exists: true, verdict, pass, netCashUsd, rejectionReasons };
}

async function probeAccounts(connection: Connection, pubkeys: string[]): Promise<Record<string, AccountProbe>> {
  const keys = pubkeys.map((pubkey) => new PublicKey(pubkey));
  const infos = await connection.getMultipleAccountsInfo(keys, "confirmed");
  const out: Record<string, AccountProbe> = {};
  for (let i = 0; i < pubkeys.length; i++) {
    const info = infos[i];
    out[pubkeys[i]] = {
      pubkey: pubkeys[i],
      exists: Boolean(info),
      executable: info?.executable ?? false,
      ownerProgram: info?.owner.toBase58() ?? null,
      dataLen: info?.data.length ?? 0
    };
  }
  return out;
}

function accountRejections(
  probes: Record<string, AccountProbe>,
  atomProgramId: string,
  enchancedblockProgramId: string,
  csdmProgramId: string
): string[] {
  const reasons: string[] = [];
  if (!probes[atomProgramId]?.executable) {
    reasons.push("atom_ickk is not confirmed executable on mainnet; deploy/redeploy receipt required before live");
  }
  if (!probes[enchancedblockProgramId]?.executable) {
    reasons.push("ENCHANCEDBLOCK program is not confirmed executable on mainnet");
  }
  if (!probes[csdmProgramId]?.executable) {
    reasons.push("CSDM/flash backing program is not confirmed executable on mainnet");
  }
  return reasons;
}

async function main(): Promise<void> {
  const config = loadConfig();
  assertNoForbiddenConfigured(config);

  const atomRepo = strEnv(
    "ATOM_REPO_PATH",
    findRepo("/Users/velon/Desktop/atom_ickk", "/Users/velon/gh-src-vtothen/CASI-READY-PARA-MAINNET-atom_ickk")
  );
  const enchancedblockRepo = strEnv(
    "ENCHANCEDBLOCK_REPO_PATH",
    findRepo("/Users/velon/gh-src-vtothen/EXPERIMENTO-ENCHANCEDBLOCK", "/Users/velon/Desktop/ENCHANCEDBLOCK")
  );
  const atomProgramId = strEnv("ATOM_PROGRAM_ID", DEFAULT_ATOM_PROGRAM_ID);
  const enchancedblockProgramId = strEnv("ENCHANCEDBLOCK_PROGRAM_ID", DEFAULT_ENCHANCEDBLOCK_PROGRAM_ID);
  const csdmProgramId = strEnv("CSDM_PROGRAM_ID", DEFAULT_CSDM_PROGRAM_ID);
  const enchancedblockGatePath = optionalEnv("ENCHANCEDBLOCK_GATE_RECEIPT_PATH");
  const hopRedeemPath = optionalEnv("HOP_REDEEM_RECEIPT_PATH");
  const cashRelayPath = strEnv("CASH_RELAY_RECEIPT_PATH", "receipts/REDEMPTION-CASH-RELAY-LATEST.json");

  const atom = inspectAtom(atomRepo);
  const enchancedblock = inspectEnchancedblock(enchancedblockRepo);
  const enchancedblockGate = summarizeGateReceipt(enchancedblockGatePath);
  const hopRedeem = inspectHopRedeem(hopRedeemPath);
  const cashRelay = inspectCashRelay(cashRelayPath);
  const accountProbes = await probeAccounts(
    new Connection(config.rpcUrl, "confirmed"),
    [atomProgramId, enchancedblockProgramId, csdmProgramId]
  );

  const rejectionReasons = [
    ...accountRejections(accountProbes, atomProgramId, enchancedblockProgramId, csdmProgramId),
    ...enchancedblockGate.rejectionReasons,
    ...hopRedeem.rejectionReasons,
    ...cashRelay.rejectionReasons
  ];

  if (!atom.deployableLocalPrimitive) rejectionReasons.push("local atom_ickk primitive is incomplete");
  if (enchancedblock.externalSourceClass !== "external_orca_whirlpool") {
    rejectionReasons.push("ENCHANCEDBLOCK external Orca source is not present locally");
  }

  const receipt = {
    verdict: rejectionReasons.length === 0
      ? "ATOM_ENCHANCEDBLOCK_CASH_GATE_READY_NO_LIVE"
      : "ATOM_ENCHANCEDBLOCK_CASH_GATE_BLOCKED",
    generatedAt: new Date().toISOString(),
    noSend: true,
    dryRun: config.dryRun,
    allowLive: config.allowLive,
    liveIntentIgnored: "This planner never sends transactions. Deploys, closes, upgrades, bundles, and retrieves require separate exact approval.",
    architecture: {
      atomIckk: "multi-slot capital window; deployable actuator, not the cash source",
      enchancedblock: "authority-controlled internal price plus external Orca Whirlpool settlement source",
      hopRedeemVault: "required bridge from HOP/accounting units to spendable SOL/USDC",
      cashRelay: "final judge; only SOL/USDC delta after costs passes"
    },
    deploymentPosition: {
      userClaimAccepted: "An unused program can be closed/upgraded/redeployed if its authority and program keypair/data length allow it.",
      deploymentDoesNotChangeCashGate: "Deployability removes an engineering blocker, not the HOP redeem/CashRelay proof requirement.",
      atomProgramId,
      enchancedblockProgramId,
      csdmProgramId,
      accountProbes
    },
    investigations: {
      atom,
      enchancedblock,
      enchancedblockGate,
      hopRedeem,
      cashRelay
    },
    answers: {
      atomIckk: atom.deployableLocalPrimitive
        ? "YES as local/deployable primitive; mainnet executable proof still required before live."
        : "NO until local primitive checks pass.",
      enchancedblock: enchancedblock.externalSourceClass === "external_orca_whirlpool"
        ? "YES as an external-source design; current positive edge still needs an exact passing gate receipt."
        : "NO external Orca path found.",
      hopRedeemVault: hopRedeem.redeemable
        ? "Potentially yes; verify exact burn/redeem receipt and vault balance."
        : "NOT PROVEN. RedemptionArc HOP is still non-cash until a HOP redeem vault or external settlement route exists.",
      cashRelayInvariant: cashRelay.pass
        ? "CashRelay is ready for the provided source."
        : "NOT PROVEN. A unified receipt must show spendable SOL/USDC after atom_ickk, ENCHANCEDBLOCK, repay, retrieve, costs, and inventory liabilities."
    },
    cashProofGate: {
      pass: rejectionReasons.length === 0,
      requiresAtomExecutableOrDeployReceipt: true,
      requiresCurrentEnchancedblockEdgeReceipt: true,
      requiresHopBurnRedeemToSolUsdc: true,
      requiresCashRelayReadyNoLive: true,
      requiresNoHopCustomTokenProfit: true
    },
    rejectionReasons,
    nextRequiredExactBuild: [
      "Deploy or redeploy atom_ickk only behind separate approval; record program ID, pool, maxDeadlineSlots, flash fee, and vault liquidity.",
      "Emit an ENCHANCEDBLOCK no-send source receipt with chosen direction, exact route, simErr=null, positive SOL/USDC post balances, and all costs.",
      "Build or wire a HOP redeem vault receipt: burn/lock HOP -> SOL/USDC from backing vault, with liabilities priced.",
      "Feed the resulting SOL/USDC source receipt into RedemptionCashRelay and require REDEMPTION_CASH_RELAY_READY_NO_LIVE before any live path."
    ]
  };

  const out = writeReceipt(OUT_RECEIPT, receipt);
  console.log(`${receipt.verdict} receipt=${out}`);
  if (rejectionReasons.length > 0) {
    console.log(`blocked=${rejectionReasons.join(" | ")}`);
    process.exitCode = 1;
  }
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  const out = writeReceipt(OUT_RECEIPT, {
    verdict: "ATOM_ENCHANCEDBLOCK_CASH_GATE_BLOCKED",
    generatedAt: new Date().toISOString(),
    noSend: true,
    rejectionReasons: [`planner error: ${message}`]
  });
  console.error(`ATOM_ENCHANCEDBLOCK_CASH_GATE_BLOCKED receipt=${out}`);
  console.error(message);
  process.exitCode = 1;
});
