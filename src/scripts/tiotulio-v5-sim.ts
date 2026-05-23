/**
 * TIOTULIO phase-5 zero-capital simulator.
 *
 * This is a no-send economic gate for the presentation target:
 * flash-funded GHOST-LP, PHANTOM-LITE scale from 4 to 8 hops, no Velon
 * principal, and cash proof only when the fee sink settles to SOL/USDC.
 */
import "dotenv/config";
import dotenv from "dotenv";
import { writeReceipt } from "../utils/receipt.js";

if (process.env.ENV_PATH) {
  dotenv.config({ path: process.env.ENV_PATH, override: true });
}

type HopResult = {
  hops: number;
  flashUsd: number;
  effectiveFeeBps: number;
  protocolSplitBps: number;
  compoundedFeeUsd: number;
  grossExtractUsd: number;
  flashFeeUsd: number;
  ilProxyUsd: number;
  gasUsd: number;
  jitoTipUsd: number;
  crankRewardUsd: number;
  netToTreasuryUsd: number;
  dailyNetUsd: number;
};

function numEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw == null || raw === "") return fallback;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) throw new Error(`Invalid ${name}=${raw}`);
  return parsed;
}

function intEnv(name: string, fallback: number): number {
  const value = numEnv(name, fallback);
  if (!Number.isInteger(value)) throw new Error(`Invalid ${name}=${value}; expected integer`);
  return value;
}

function boolEnv(name: string, fallback: boolean): boolean {
  const raw = process.env[name];
  if (raw == null || raw === "") return fallback;
  return ["1", "true", "yes", "y"].includes(raw.toLowerCase());
}

function strEnv(name: string, fallback: string): string {
  const raw = process.env[name];
  return raw == null || raw === "" ? fallback : raw;
}

function roundUsd(value: number): number {
  return Math.round(value * 1_000_000) / 1_000_000;
}

function simulateHopResult(args: {
  hops: number;
  flashUsd: number;
  effectiveFeeBps: number;
  protocolSplitBps: number;
  flashFeeBps: number;
  ilProxyBps: number;
  gasUsd: number;
  jitoTipUsd: number;
  crankRewardBps: number;
  cyclesPerDay: number;
}): HopResult {
  const feeRate = args.effectiveFeeBps / 10_000;
  const protocolSplit = args.protocolSplitBps / 10_000;
  const compoundedFeeUsd = args.flashUsd * (1 - (1 - feeRate) ** args.hops);
  const grossExtractUsd = compoundedFeeUsd * protocolSplit;
  const flashFeeUsd = args.flashUsd * (args.flashFeeBps / 10_000);
  const ilProxyUsd = args.flashUsd * (args.ilProxyBps / 10_000);
  const preCrankNet = grossExtractUsd - flashFeeUsd - ilProxyUsd - args.gasUsd - args.jitoTipUsd;
  const crankRewardUsd = Math.max(preCrankNet, 0) * (args.crankRewardBps / 10_000);
  const netToTreasuryUsd = preCrankNet - crankRewardUsd;

  return {
    hops: args.hops,
    flashUsd: args.flashUsd,
    effectiveFeeBps: args.effectiveFeeBps,
    protocolSplitBps: args.protocolSplitBps,
    compoundedFeeUsd: roundUsd(compoundedFeeUsd),
    grossExtractUsd: roundUsd(grossExtractUsd),
    flashFeeUsd: roundUsd(flashFeeUsd),
    ilProxyUsd: roundUsd(ilProxyUsd),
    gasUsd: roundUsd(args.gasUsd),
    jitoTipUsd: roundUsd(args.jitoTipUsd),
    crankRewardUsd: roundUsd(crankRewardUsd),
    netToTreasuryUsd: roundUsd(netToTreasuryUsd),
    dailyNetUsd: roundUsd(netToTreasuryUsd * args.cyclesPerDay),
  };
}

function main() {
  const flashUsd = numEnv("TIOTULIO_FLASH_USD", 200_000);
  const startHops = intEnv("TIOTULIO_START_HOPS", 4);
  const targetHops = intEnv("TIOTULIO_TARGET_HOPS", 8);
  const effectiveFeeBps = numEnv("TIOTULIO_EFFECTIVE_FEE_BPS", 10);
  const tokenTransferFeeBps = numEnv("TIOTULIO_TOKEN_TRANSFER_FEE_BPS", effectiveFeeBps);
  const protocolSplitBps = numEnv("TIOTULIO_PROTOCOL_SPLIT_BPS", 5_000);
  const flashFeeBps = numEnv("TIOTULIO_FLASH_FEE_BPS", 0);
  const ilProxyBps = numEnv("TIOTULIO_IL_PROXY_BPS", 0);
  const gasUsd = numEnv("TIOTULIO_GAS_USD", 0);
  const jitoTipUsd = numEnv("TIOTULIO_JITO_TIP_USD", 0);
  const crankRewardBps = numEnv("TIOTULIO_CRANK_REWARD_BPS", 1);
  const cyclesPerDay = intEnv("TIOTULIO_CYCLES_PER_DAY", 96);
  const minDailyUsd = numEnv("TIOTULIO_MIN_DAILY_USD", 10_000);
  const seedLiquidityUsd = numEnv("TIOTULIO_SEED_LIQUIDITY_USD", 0);
  const deployCostVelonUsd = numEnv("TIOTULIO_DEPLOY_COST_VELON_USD", 0);

  const ghostLpSource = strEnv("TIOTULIO_GHOST_LP_SOURCE", "flash");
  const gasPayer = strEnv("TIOTULIO_GAS_PAYER", "phantom_treasury_or_sponsor");
  const deployPayer = strEnv("TIOTULIO_DEPLOY_PAYER", "lazy_or_treasury");
  const settlementPath = strEnv("SETTLEMENT_PATH", "UNCONFIRMED");
  const dryRun = boolEnv("DRY_RUN", true);
  const allowLive = boolEnv("ALLOW_LIVE", false);
  const liveTxApproved = boolEnv("LIVE_TX_APPROVED", false);
  const feeSinkOwned = boolEnv("FEE_SINK_OWNED", true);
  const settlementConfirmed = boolEnv("SETTLEMENT_CONFIRMED", false);
  const exactTxReceiptConfirmed = boolEnv("EXACT_TX_RECEIPT_CONFIRMED", false);
  const velonSignerAllowed = boolEnv("VELON_SIGNER_ALLOWED", false);

  if (startHops < 4 || startHops > 8) {
    throw new Error(`TIOTULIO_START_HOPS must be between 4 and 8, got ${startHops}`);
  }
  if (targetHops < 4 || targetHops > 8) {
    throw new Error(`TIOTULIO_TARGET_HOPS must be between 4 and 8, got ${targetHops}`);
  }
  if (targetHops < startHops) {
    throw new Error(`TIOTULIO_TARGET_HOPS ${targetHops} must be >= TIOTULIO_START_HOPS ${startHops}`);
  }

  const common = {
    flashUsd,
    effectiveFeeBps,
    protocolSplitBps,
    flashFeeBps,
    ilProxyBps,
    gasUsd,
    jitoTipUsd,
    crankRewardBps,
    cyclesPerDay,
  };
  const phase4 = simulateHopResult({ ...common, hops: startHops });
  const phase5 = simulateHopResult({ ...common, hops: targetHops });

  const velonCapitalRequiredUsd = seedLiquidityUsd + deployCostVelonUsd;
  const zeroCapitalReasons = [
    ghostLpSource === "flash" ? null : `GHOST-LP source is ${ghostLpSource}, expected flash`,
    gasPayer === "velon" ? "gas payer is Velon" : null,
    deployPayer === "velon" ? "deploy payer is Velon" : null,
    seedLiquidityUsd === 0 ? null : `seed liquidity requires Velon USD ${seedLiquidityUsd}`,
    deployCostVelonUsd === 0 ? null : `deploy cost requires Velon USD ${deployCostVelonUsd}`,
    velonSignerAllowed ? "Velon signer is allowed by config" : null,
  ].filter((reason): reason is string => reason != null);
  const zeroCapitalPass = velonCapitalRequiredUsd === 0 && zeroCapitalReasons.length === 0;

  const modelReasons = [
    phase5.netToTreasuryUsd > 0 ? null : "phase-5 net per cycle is not positive",
    phase5.dailyNetUsd >= minDailyUsd ? null : `daily net ${phase5.dailyNetUsd} below MILLIONS-GATE ${minDailyUsd}`,
    zeroCapitalPass ? null : "zero-capital gate failed",
    feeSinkOwned ? null : "fee sink ownership is not confirmed",
  ].filter((reason): reason is string => reason != null);
  const modelPass = modelReasons.length === 0;

  const cashReasons = [
    modelPass ? null : "phase-5 model gate is not passing",
    settlementConfirmed ? null : "SETTLEMENT_CONFIRMED=false: fee output is not proven spendable SOL/USDC",
    exactTxReceiptConfirmed ? null : "EXACT_TX_RECEIPT_CONFIRMED=false: no exact no-send TX/bundle receipt yet",
    dryRun ? null : "DRY_RUN=false ignored by this simulator; no-send only",
    allowLive ? "ALLOW_LIVE=true ignored by this simulator; no-send only" : null,
    liveTxApproved ? "LIVE_TX_APPROVED=true ignored by this simulator; no-send only" : null,
  ].filter((reason): reason is string => reason != null);
  const cashProofPass = cashReasons.length === 0;

  const verdict = cashProofPass
    ? "TIOTULIO_V5_CASH_READY_NO_SEND"
    : modelPass
      ? "TIOTULIO_V5_MODEL_PASS_EXACT_TX_BLOCKED"
      : "TIOTULIO_V5_NO_GO";

  const receipt = {
    verdict,
    generatedAt: new Date().toISOString(),
    noSend: true,
    source: {
      presentation: "/Users/velon/Desktop/VELON-PRESENTACION.html",
      slideModel: "extract = flash * (1 - (1 - feeRate)^hops) * protocolSplit - flashFee - ilProxy - gas",
      sourceClass: "owned_fee_sink_model",
      eligibilityProof: [
        "PHANTOM-TREASURY or configured authority owns the fee sink",
        "GHOST-LP principal is flash-funded inside the bundle",
        "Velon wallet is not a required signer or capital source",
        "fee output must settle to wallet-controlled SOL/USDC before live",
      ],
    },
    config: {
      flashUsd,
      startHops,
      targetHops,
      effectiveFeeBps,
      tokenTransferFeeBps,
      protocolSplitBps,
      flashFeeBps,
      ilProxyBps,
      gasUsd,
      jitoTipUsd,
      crankRewardBps,
      cyclesPerDay,
      minDailyUsd,
      ghostLpSource,
      gasPayer,
      deployPayer,
      settlementPath,
    },
    phaseScale: {
      phase4,
      phase5,
      netMultiplier: phase4.netToTreasuryUsd > 0 ? roundUsd(phase5.netToTreasuryUsd / phase4.netToTreasuryUsd) : null,
      dailyMultiplier: phase4.dailyNetUsd > 0 ? roundUsd(phase5.dailyNetUsd / phase4.dailyNetUsd) : null,
    },
    zeroCapitalGate: {
      pass: zeroCapitalPass,
      velonCapitalRequiredUsd: roundUsd(velonCapitalRequiredUsd),
      velonUsdcSpentUsd: 0,
      velonSolOngoingUsd: 0,
      reasons: zeroCapitalReasons,
    },
    modelGate: {
      pass: modelPass,
      reasons: modelReasons,
    },
    cashProofGate: {
      pass: cashProofPass,
      settlementConfirmed,
      exactTxReceiptConfirmed,
      feeSinkOwned,
      rejectionReasons: cashReasons,
    },
    instructionPathTarget: [
      "TX0_PREPARE: create/extend ALT and idempotent ATAs only if paid by treasury/sponsor",
      "TX1_BORROW: multi-flash borrow USDC",
      "TX1_FLASH_BIRTH: create or select ephemeral owned venue",
      "TX1_GHOST_LP_ADD: add flash-funded liquidity, not Velon principal",
      `TX1_PHANTOM_LITE: execute ${targetHops} fee hops with FEE-FIRST extraction`,
      "TX1_GHOST_LP_REMOVE: remove flash-funded LP before repay",
      "TX1_VENUE_DEATH: zero ephemeral state",
      "TX1_REPAY: repay flash principal plus fee",
      "TX1_CREDIT: credit PHANTOM-TREASURY and crank reward",
      "TX2_SETTLE: prove treasury SOL/USDC after is greater than before",
    ],
    phaseRoadmap: [
      { phase: 0, deliverable: "phantom-sim.ts + GO/NO-GO", costVelonUsd: 0, status: "implemented_by_tiotulio_v5_sim" },
      { phase: 1, deliverable: "TS PHANTOM-LITE orchestrator", costVelonUsd: 0, status: "next_exact_builder" },
      { phase: 2, deliverable: "first bundle to treasury", costVelonUsd: 0, status: "blocked_until_exact_tx_cash_proof" },
      { phase: 3, deliverable: "velon-core deploy", costVelonUsd: 0, status: "treasury_or_lazy_deploy_only" },
      { phase: 4, deliverable: "SWARM-200 autonomy", costVelonUsd: 0, status: "requires_phase2_cash_receipt" },
      { phase: 5, deliverable: "scale 4 to 8 hops", costVelonUsd: 0, status: modelPass ? "model_pass" : "model_blocked" },
    ],
    nextRequiredBuild: [
      "Replace the economic model with exact TX0/TX1/TX2 account and instruction receipts.",
      "Prove GHOST-LP add/remove uses flash principal and leaves no Velon inventory liability.",
      "Prove fee output settles to SOL/USDC; do not count HOP/custom tokens as profit.",
      "Only after exact receipt passes, request explicit Velon approval for any live send.",
    ],
  };

  const out = writeReceipt("TIOTULIO-V5-ZERO-CAPITAL-SIM-LATEST.json", receipt);
  console.log(
    `${verdict} phase5Net=${phase5.netToTreasuryUsd.toFixed(6)} daily=${phase5.dailyNetUsd.toFixed(2)} zeroCapital=${zeroCapitalPass} cashProof=${cashProofPass} receipt=${out}`,
  );
}

main();
