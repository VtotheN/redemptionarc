import fs from "node:fs";
import { loadConfig } from "../config.js";
import { writeReceipt } from "../utils/receipt.js";
import { assertNoForbiddenConfigured } from "../utils/safety.js";

const OUT_RECEIPT = "HOP-ROUTE-INCENTIVE-PLAN-LATEST.json";
const DEFAULT_FLOW_RECEIPT = "receipts/HOP-EXTERNAL-FLOW-WATCH-LATEST.json";
const DEFAULT_CASHABILITY_RECEIPT = "receipts/HOP-CASHABILITY-GATE-LATEST.json";

type FlowReceipt = {
  verdict?: string;
  generatedAt?: string;
  summary?: {
    externalEvents?: number;
    affiliatedEvents?: number;
    externalQuoteInUsd?: number;
    externalEstimatedT22HopUi?: number;
    activePoolsWithExternalFlow?: string[];
    missingSecondVenue?: boolean;
  };
  hopTransferFee?: {
    activeBps?: number;
    newerBps?: number;
    newerEpoch?: string;
    currentEpoch?: number;
  };
  poolReports?: Array<{
    id?: string;
    quoteAsset?: string;
    externalEvents?: number;
    externalQuoteInUsd?: number;
    externalEstimatedT22HopUi?: number;
  }>;
};

type CashabilityReceipt = {
  verdict?: string;
  cashMath?: {
    bestExternalNetUsdAtImpact?: number | null;
    bestExternalOutUsdAtImpact?: number | null;
    primaryNetCashUsd?: number | null;
  };
  quotes?: {
    usdc?: {
      acceptedExternal?: boolean;
      outUsd?: number | null;
    };
  };
};

function readJson<T>(path: string): T | null {
  if (!fs.existsSync(path)) return null;
  return JSON.parse(fs.readFileSync(path, "utf8")) as T;
}

function num(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw == null || raw === "") return fallback;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) throw new Error(`Invalid numeric env ${name}=${raw}`);
  return parsed;
}

function str(name: string, fallback: string): string {
  const raw = process.env[name];
  return raw == null || raw === "" ? fallback : raw;
}

function bool(name: string, fallback: boolean): boolean {
  const raw = process.env[name];
  if (raw == null || raw === "") return fallback;
  return ["1", "true", "yes", "y"].includes(raw.toLowerCase());
}

function validRewardToken(token: string): "USDC" | "SOL" {
  const normalized = token.toUpperCase();
  if (normalized !== "USDC" && normalized !== "SOL") {
    throw new Error(`HOP_INCENTIVE_REWARD_TOKEN must be USDC or SOL, got ${token}`);
  }
  return normalized;
}

function positive(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0;
}

function cashabilityExternalUsd(receipt: CashabilityReceipt | null): number {
  if (!receipt) return 0;
  const verdict = receipt.verdict ?? "";
  if (!verdict.includes("READY")) return 0;
  if (receipt.quotes?.usdc?.acceptedExternal === true) {
    return positive(receipt.quotes.usdc.outUsd);
  }
  return positive(receipt.cashMath?.bestExternalNetUsdAtImpact);
}

function main() {
  const config = loadConfig();
  assertNoForbiddenConfigured(config);

  const flowPath = str("HOP_INCENTIVE_FLOW_RECEIPT_PATH", DEFAULT_FLOW_RECEIPT);
  const cashabilityPath = str("HOP_INCENTIVE_CASHABILITY_RECEIPT_PATH", DEFAULT_CASHABILITY_RECEIPT);
  const rewardToken = validRewardToken(str("HOP_INCENTIVE_REWARD_TOKEN", "USDC"));
  const rewardShareBps = num("HOP_INCENTIVE_REWARD_SHARE_BPS", 1_000);
  const lpFeeBps = num("HOP_INCENTIVE_LP_FEE_BPS", 25);
  const t22SettlementUsd = num("HOP_INCENTIVE_T22_SETTLED_USD", 0);
  const confirmedCashFeeUsd = num("HOP_INCENTIVE_CONFIRMED_CASH_FEE_USD", 0);
  const minRewardUsd = num("HOP_INCENTIVE_MIN_REWARD_USD", 0.001);
  const includeCashabilityBudget = bool("HOP_INCENTIVE_INCLUDE_CASHABILITY_BUDGET", true);

  const flow = readJson<FlowReceipt>(flowPath);
  const cashability = readJson<CashabilityReceipt>(cashabilityPath);
  const rejectionReasons = new Set<string>();

  if (!flow) rejectionReasons.add(`missing flow receipt ${flowPath}`);
  const externalEvents = positive(flow?.summary?.externalEvents);
  const externalFlowUsd = positive(flow?.summary?.externalQuoteInUsd);
  const affiliatedEvents = positive(flow?.summary?.affiliatedEvents);
  const t22FeeHop = positive(flow?.summary?.externalEstimatedT22HopUi);
  const missingSecondVenue = flow?.summary?.missingSecondVenue === true;

  const lpFeeUsdEstimate = externalFlowUsd * lpFeeBps / 10_000;
  const externalCashabilityUsd = includeCashabilityBudget ? cashabilityExternalUsd(cashability) : 0;
  const theoreticalFeeBudgetUsd = lpFeeUsdEstimate + t22SettlementUsd;
  const theoreticalMaxRewardUsd = theoreticalFeeBudgetUsd * rewardShareBps / 10_000;
  const confirmedCashBudgetUsd = confirmedCashFeeUsd + externalCashabilityUsd;
  const cashSafeRewardUsd = Math.min(theoreticalMaxRewardUsd, confirmedCashBudgetUsd);

  if (!flow) {
    // already recorded
  } else if (externalEvents <= 0) {
    rejectionReasons.add("no external signer flow observed");
  }
  if (externalFlowUsd <= 0) rejectionReasons.add("no external quote-asset inflow observed");
  if (theoreticalFeeBudgetUsd <= 0) rejectionReasons.add("no theoretical fee budget from LP fee or settled T22");
  if (confirmedCashBudgetUsd <= 0) rejectionReasons.add("no confirmed spendable USDC/SOL fee budget for rewards");
  if (cashSafeRewardUsd < minRewardUsd) {
    rejectionReasons.add(`cashSafeRewardUsd ${cashSafeRewardUsd.toFixed(9)} below HOP_INCENTIVE_MIN_REWARD_USD ${minRewardUsd}`);
  }
  if (rewardShareBps < 0 || rewardShareBps > 10_000) rejectionReasons.add("reward share bps must be between 0 and 10000");
  if (lpFeeBps < 0 || lpFeeBps > 10_000) rejectionReasons.add("LP fee bps must be between 0 and 10000");
  if (missingSecondVenue) rejectionReasons.add("only one configured HOP venue; route incentive should wait for N-pool path proof");
  if (t22FeeHop > 0 && t22SettlementUsd <= 0) {
    rejectionReasons.add("T22 HOP fee observed but not settled to USDC/SOL; not reward budget");
  }

  const cashRelayPass = rejectionReasons.size === 0;
  const verdict = cashRelayPass
    ? "HOP_ROUTE_INCENTIVE_READY_NO_SEND"
    : externalEvents > 0 && theoreticalMaxRewardUsd > 0
      ? "HOP_ROUTE_INCENTIVE_BLOCKED_NEEDS_CASH_PROOF"
      : "HOP_ROUTE_INCENTIVE_BLOCKED";

  const receipt = {
    verdict,
    generatedAt: new Date().toISOString(),
    readOnly: true,
    noSend: true,
    liveIntentIgnored: {
      dryRun: config.dryRun,
      allowLive: config.allowLive,
      liveTxApproved: process.env.LIVE_TX_APPROVED === "true",
      note: "hop-route-incentive-plan only calculates reward budgets; it never builds or sends reward transactions",
    },
    inputs: {
      flowPath,
      flowVerdict: flow?.verdict ?? null,
      flowGeneratedAt: flow?.generatedAt ?? null,
      cashabilityPath,
      cashabilityVerdict: cashability?.verdict ?? null,
      rewardToken,
      rewardShareBps,
      lpFeeBps,
      t22SettlementUsd,
      confirmedCashFeeUsd,
      minRewardUsd,
      includeCashabilityBudget,
    },
    observedFlow: {
      externalEvents,
      affiliatedEvents,
      externalFlowUsd,
      t22FeeHop,
      activePoolsWithExternalFlow: flow?.summary?.activePoolsWithExternalFlow ?? [],
      missingSecondVenue,
      hopTransferFee: flow?.hopTransferFee ?? null,
      perPool: (flow?.poolReports ?? []).map((pool) => ({
        id: pool.id ?? null,
        quoteAsset: pool.quoteAsset ?? null,
        externalEvents: positive(pool.externalEvents),
        externalQuoteInUsd: positive(pool.externalQuoteInUsd),
        externalEstimatedT22HopUi: positive(pool.externalEstimatedT22HopUi),
      })),
    },
    economics: {
      lpFeeUsdEstimate,
      t22SettlementUsd,
      externalCashabilityUsd,
      theoreticalFeeBudgetUsd,
      theoreticalMaxRewardUsd,
      confirmedCashBudgetUsd,
      cashSafeRewardUsd,
      rewardToken,
      retainedTheoreticalFeeUsd: Math.max(0, theoreticalFeeBudgetUsd - theoreticalMaxRewardUsd),
    },
    gate: {
      cashRelayPass,
      rewardAllowed: cashRelayPass,
      rejectionReasons: Array.from(rejectionReasons),
      requiredBeforeLive: [
        "N-pool route proof with external signer flow",
        "exact collect/settle receipt proving spendable USDC/SOL fee budget",
        "reward transaction simulation showing reward <= cashSafeRewardUsd",
        "post-reward owned SOL+USDC remains above pre-flow baseline plus MIN_NET_USD",
      ],
    },
    next: cashRelayPass
      ? "Build exact no-send reward transaction simulation with rewardToken and cashSafeRewardUsd cap."
      : "Keep incentives disabled. Use this receipt to size a micro-reward only after collect/settle cash proof exists.",
  };

  const out = writeReceipt(OUT_RECEIPT, receipt);
  console.log(`${verdict} externalFlowUsd=${externalFlowUsd.toFixed(6)} theoreticalRewardUsd=${theoreticalMaxRewardUsd.toFixed(9)} cashSafeRewardUsd=${cashSafeRewardUsd.toFixed(9)} receipt=${out}`);
}

main();
