import fs from "node:fs";
import { loadConfig } from "../config.js";
import { writeReceipt } from "../utils/receipt.js";
import { assertNoForbiddenConfigured } from "../utils/safety.js";

const OUT_RECEIPT = "STACC-BZK-SECURITY-PLAN-LATEST.json";
const DEFAULT_AUTOPSY = "receipts/STACC-AUTOPSY-LATEST.json";
const DEFAULT_CASH_MODEL = "receipts/STACC-BZK-CASH-MODEL-LATEST.json";
const DEFAULT_TX_DECODE = "receipts/STACC-TX-DECODE.json";

type AnyRecord = Record<string, unknown>;

function envString(name: string, fallback: string): string {
  const raw = process.env[name];
  return raw == null || raw.trim() === "" ? fallback : raw.trim();
}

function readJson(path: string): AnyRecord {
  return JSON.parse(fs.readFileSync(path, "utf8")) as AnyRecord;
}

function record(value: unknown): AnyRecord {
  return typeof value === "object" && value !== null ? value as AnyRecord : {};
}

function array(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function string(value: unknown): string | null {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : null;
}

function number(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function boolean(value: unknown): boolean | null {
  return typeof value === "boolean" ? value : null;
}

function txNames(sequence: unknown): string[] {
  return array(sequence)
    .map((ix) => string(record(ix).name) ?? string(record(ix).typeOrName))
    .filter((name): name is string => name !== null);
}

function main(): void {
  const config = loadConfig();
  assertNoForbiddenConfigured(config);

  const autopsyPath = envString("STACC_AUTOPSY_RECEIPT", DEFAULT_AUTOPSY);
  const cashModelPath = envString("STACC_BZK_CASH_MODEL", DEFAULT_CASH_MODEL);
  const txDecodePath = envString("STACC_TX_DECODE", DEFAULT_TX_DECODE);

  const autopsy = readJson(autopsyPath);
  const cashModel = readJson(cashModelPath);
  const txDecode = readJson(txDecodePath);
  const probe = record(autopsy.bzkTokenBadgeProbe);
  const pool = record(record(probe.observedBzkPool).decoded);
  const configAccount = record(record(probe.configAccount).decoded);
  const configExtension = record(record(probe.configExtensionAccount).decoded);
  const tokenBadge = record(probe.tokenBadgeAccount);
  const pump = record(cashModel.pump);
  const firstCashTx = record(pump.firstCashTx);
  const walletInflows = record(cashModel.walletNativeInflows);
  const externalRouting = record(cashModel.externalOrcaRouting);

  const instructionNames = txNames(record(autopsy.reference).sequence);
  const token2022RingTransfers = array(txDecode.token2022RingTransfers);
  const referenceFlashAmountUsdc = token2022RingTransfers.length > 0
    ? number(record(record(token2022RingTransfers[0]).tokenAmount).uiAmount)
    : null;

  const bzkMintOwner = string(record(probe.bzkMintAccount).owner);
  const tokenBadgeExists = boolean(tokenBadge.exists) === true;
  const bzkIsLegacySpl = bzkMintOwner === "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
  const whirlpoolControlHeld =
    string(configAccount.feeAuthority) === string(configAccount.collectProtocolFeesAuthority)
    && string(configAccount.feeAuthority) === string(configAccount.rewardEmissionsSuperAuthority)
    && string(configExtension.configExtensionAuthority) === string(configAccount.feeAuthority)
    && string(configExtension.tokenBadgeAuthority) === string(configAccount.feeAuthority);
  const externalSwapCount = number(externalRouting.externalSwapCount) ?? 0;
  const firstPumpSol = number(firstCashTx.wzmaNativeGainSol) ?? 0;
  const positiveSolTotal = number(walletInflows.positiveSolTotal) ?? 0;
  const ringMechanicallyDecoded =
    instructionNames.includes("marginfi.start_flashloan")
    && instructionNames.includes("marginfi.end_flashloan")
    && token2022RingTransfers.length === 4;

  const rejections = [
    bzkIsLegacySpl || tokenBadgeExists ? null : "BZK is not legacy SPL and TokenBadge account is not initialized",
    whirlpoolControlHeld ? null : "WzMa does not control the decoded Whirlpool config authorities",
    externalSwapCount > 0 ? null : "no external BZK pool swap found in local cash model",
    firstPumpSol > 0 || positiveSolTotal > 0 ? null : "no direct SOL inflow found for WzMa in local BZK cash model",
    ringMechanicallyDecoded ? null : "reference STACC flash/ring transaction was not mechanically decoded",
    "this is still a no-send plan; live execution requires a fresh exact sim and explicit approval"
  ].filter((value): value is string => value !== null);

  const receipt = {
    verdict: rejections.length === 1
      ? "STACC_BZK_SECURITY_PATH_READY_NO_LIVE"
      : "STACC_BZK_SECURITY_PATH_BLOCKED",
    generatedAt: new Date().toISOString(),
    noSend: true,
    dryRun: config.dryRun,
    allowLive: false,
    sourceInterpretation: {
      userClarification: "STACC config means the BZK security/pool/listing path, not the CSDM 267 SOL scale preset.",
      birdeyeTokenUrl: "https://birdeye.so/solana/token/Bzkdz5AKApsqizBxzqMUqWGJbx4gHXVC6NJekmAY8Gq3?tab=security",
      bzkMint: string(probe.mint),
      whatCanBeReplicated: [
        "authority-owned Whirlpool config and pool setup",
        "BZK external route/listing/security posture",
        "cash source adapter that accepts only external SOL/USDC inflows or collectable protocol/LP fees"
      ],
      whatCannotBeCountedAsCash: [
        "nominal flash volume",
        "Token-2022 ring fees before conversion",
        "self-volume used only to make a chart look active"
      ]
    },
    bzkSecurityState: {
      mintOwner: bzkMintOwner,
      bzkIsLegacySpl,
      derivedTokenBadge: string(probe.derivedTokenBadge),
      tokenBadgeExists,
      tokenBadgeRequirementInterpretation: bzkIsLegacySpl
        ? "TokenBadge is not required for a legacy SPL mint; Orca docs require TokenBadge for selected Token-2022/restricted cases."
        : "TokenBadge must exist before treating this as Orca-safe.",
      whirlpoolConfig: string(probe.config),
      configExtension: string(probe.configExtension),
      feeAuthority: string(configAccount.feeAuthority),
      collectProtocolFeesAuthority: string(configAccount.collectProtocolFeesAuthority),
      rewardEmissionsSuperAuthority: string(configAccount.rewardEmissionsSuperAuthority),
      configExtensionAuthority: string(configExtension.configExtensionAuthority),
      tokenBadgeAuthority: string(configExtension.tokenBadgeAuthority),
      whirlpoolControlHeld,
      observedPool: {
        address: "9edoD8zkgyjTf8YdBQymUNvhWp4FyMPuiwALHyDk2538",
        tokenMintA: string(pool.tokenMintA),
        tokenMintB: string(pool.tokenMintB),
        feeRate: pool.feeRate,
        protocolFeeRate: pool.protocolFeeRate,
        protocolFeeOwedA: string(pool.protocolFeeOwedA),
        protocolFeeOwedB: string(pool.protocolFeeOwedB),
        liquidity: string(pool.liquidity)
      }
    },
    localCashEvidence: {
      cashModelPath,
      cashModelVerdict: string(cashModel.verdict),
      firstPumpCashTx: firstCashTx,
      externalSwapCount,
      positiveSolTotal,
      note: "These are read-only historical receipts. They prove the path shape; they are not a current spendable-profit receipt."
    },
    referenceStaccTx: {
      txDecodePath,
      signature: string(txDecode.signature),
      err: txDecode.err ?? null,
      feeLamports: txDecode.feeLamports ?? null,
      computeUnitsConsumed: txDecode.computeUnitsConsumed ?? null,
      token2022TransferCheckedWithFeeCount: token2022RingTransfers.length,
      referenceFlashAmountUsdc,
      interpretationOf100k: "A 100k flash/borrow simulation passing only proves MarginFi capacity and transaction mechanics. CashRelay still needs post-settlement SOL/USDC growth."
    },
    implementationPlan: {
      sourceClass: "external_flow_fee_or_sell_settlement",
      eligibilityProof: [
        "WzMa controls Whirlpool fee/protocol authorities for the decoded BZK config.",
        "External BZK route exists in local Helius receipts.",
        "Pump/PumpSwap/Jupiter historical receipts show direct SOL inflows to WzMa."
      ],
      instructionPathOptions: [
        "collect_protocol_fees_v2 from the BZK Whirlpool when protocolFeeOwedA/B > costs",
        "collect LP fees/decrease-liquidity only if owned position NFT proves fee ownership",
        "sell already-owned BZK via Pump/Jupiter only if quote + simulation settle into more SOL/USDC than inventory basis and costs"
      ],
      settlementPathToSolUsdc: [
        "BZK/fee token -> Jupiter/Pump/Raydium route -> SOL or USDC",
        "write CashRelay source receipt with beforeRaw/afterRaw on the receiving SOL/USDC account",
        "reject if only BZK balance, chart volume, or T22 withheld amount increases"
      ],
      nextImplementationFiles: [
        "src/scripts/stacc-bzk-fee-source-scan.ts",
        "src/scripts/stacc-bzk-settlement-sim.ts",
        "src/scripts/stacc-bzk-postlive-source.ts"
      ]
    },
    noSendCommands: {
      refreshAutopsy: "DRY_RUN=true ALLOW_LIVE=false npm run stacc-autopsy",
      refreshCashModel: "DRY_RUN=true ALLOW_LIVE=false npm run stacc-bzk-cash-analysis",
      nextSourceScanToBuild: "DRY_RUN=true ALLOW_LIVE=false npm run stacc-bzk-fee-source-scan"
    },
    cashProofGate: {
      pass: false,
      reason: "This plan proves the STACC/BZK mechanism shape only. It becomes cash when a fresh source scan emits SOL/USDC afterRaw > beforeRaw after all costs.",
      requiredReceiptShape: {
        sourceClass: "authority_exclusive_actuator",
        payerClass: "external_protocol",
        asset: "SOL or USDC",
        simErr: null,
        costsUsd: "priced",
        liabilitiesUsd: "priced",
        inventoryDrawUsd: "priced"
      }
    },
    rejections,
    nextRequiredExactBuild: [
      "Build the BZK fee/source scanner against the decoded pool and WzMa authorities.",
      "Only collect/sell if exact simulation shows SOL/USDC net increase.",
      "Use the 100k flash setting only as execution capacity; do not book it as revenue."
    ]
  };

  const out = writeReceipt(OUT_RECEIPT, receipt);
  console.log(JSON.stringify({
    verdict: receipt.verdict,
    receipt: out,
    bzkIsLegacySpl,
    tokenBadgeExists,
    whirlpoolControlHeld,
    externalSwapCount,
    firstPumpSol,
    positiveSolTotal,
    ringMechanicallyDecoded,
    rejections
  }, null, 2));

  if (receipt.verdict === "STACC_BZK_SECURITY_PATH_BLOCKED") process.exitCode = 1;
}

main();
