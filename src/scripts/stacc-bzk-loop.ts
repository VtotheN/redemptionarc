import { spawnSync } from "node:child_process";
import fs from "node:fs";
import { Connection, PublicKey } from "@solana/web3.js";
import { loadConfig } from "../config.js";
import { writeReceipt } from "../utils/receipt.js";
import { assertNoForbiddenConfigured } from "../utils/safety.js";

const OUT_RECEIPT = "STACC-BZK-LOOP-LATEST.json";
const HISTORY_RECEIPT = "STACC-BZK-LOOP-HISTORY.jsonl";
const BZK_POOL = "9edoD8zkgyjTf8YdBQymUNvhWp4FyMPuiwALHyDk2538";
const BZK_MINT = "Bzkdz5AKApsqizBxzqMUqWGJbx4gHXVC6NJekmAY8Gq3";
const WZMA = "WzMaL78srutrF6CsxEkWuhMaDF5HZA6jNRaEPengqpb";
const PUMP_AMM = "pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA";
const JUPITER = "JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4";

type AnyRecord = Record<string, unknown>;

function boolEnv(name: string, fallback: boolean): boolean {
  const raw = process.env[name];
  if (raw == null || raw.trim() === "") return fallback;
  return ["1", "true", "yes", "y"].includes(raw.toLowerCase());
}

function numberEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw == null || raw.trim() === "") return fallback;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) throw new Error(`Invalid ${name}=${raw}`);
  return parsed;
}

function readJson(path: string): AnyRecord | null {
  if (!fs.existsSync(path)) return null;
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

function tail(text: string, lines = 16): string[] {
  return text.split(/\r?\n/).filter(Boolean).slice(-lines);
}

function runStep(name: string, command: string, extraEnv: Record<string, string> = {}) {
  const result = spawnSync("bash", ["-lc", command], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      DRY_RUN: "true",
      ALLOW_LIVE: "false",
      ...extraEnv
    },
    encoding: "utf8",
    maxBuffer: 32 * 1024 * 1024
  });
  return {
    name,
    command,
    status: result.status,
    signal: result.signal,
    ok: result.status === 0,
    stdoutTail: tail(result.stdout),
    stderrTail: tail(result.stderr)
  };
}

function topBzkPool(scan: AnyRecord | null) {
  const pools = array(scan?.pools).map(record);
  return pools.find((pool) => string(pool.whirlpool) === BZK_POOL) ?? null;
}

function routeSummary(jupiter: AnyRecord | null) {
  const results = array(jupiter?.results).map(record);
  const found = results.filter((result) => result.routeFound === true);
  return {
    routeFound: found.length > 0,
    routeCount: found.length,
    routes: found.map((result) => ({
      inputMint: string(result.inputMint),
      outputMint: string(result.outputMint),
      amount: string(result.amount),
      baseUrl: string(result.baseUrl),
      routeSummary: result.routeSummary ?? null
    }))
  };
}

function appendHistory(receipt: unknown): void {
  fs.mkdirSync("receipts", { recursive: true });
  fs.appendFileSync(`receipts/${HISTORY_RECEIPT}`, `${JSON.stringify(receipt)}\n`);
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function recentNativeInflows(connection: Connection, owner: string, limit: number) {
  const pubkey = new PublicKey(owner);
  const signatures = await connection.getSignaturesForAddress(pubkey, { limit }, "confirmed");
  const txs = await Promise.all(signatures.map(async (sig) => {
    const tx = await connection.getTransaction(sig.signature, {
      commitment: "confirmed",
      maxSupportedTransactionVersion: 0
    }).catch(() => null);
    if (!tx) {
      return {
        signature: sig.signature,
        slot: sig.slot,
        err: sig.err ?? null,
        blockTime: sig.blockTime ?? null,
        nativeDeltaLamports: null,
        nativeDeltaSol: null
      };
    }
    const staticKeys = tx.transaction.message.staticAccountKeys.map((key) => key.toBase58());
    const loadedWritable = tx.meta?.loadedAddresses?.writable.map((key) => key.toBase58()) ?? [];
    const loadedReadonly = tx.meta?.loadedAddresses?.readonly.map((key) => key.toBase58()) ?? [];
    const accountKeys = [...staticKeys, ...loadedWritable, ...loadedReadonly];
    const instructions = (tx.transaction.message as unknown as { compiledInstructions?: Array<{ programIdIndex: number }> }).compiledInstructions ?? [];
    const programIds = [...new Set(instructions
      .map((ix) => accountKeys[ix.programIdIndex])
      .filter((value): value is string => typeof value === "string"))];
    const index = staticKeys.findIndex((key) => key === owner);
    const pre = index >= 0 ? tx.meta?.preBalances[index] ?? null : null;
    const post = index >= 0 ? tx.meta?.postBalances[index] ?? null : null;
    const delta = pre != null && post != null ? post - pre : null;
    const bzkRelated = accountKeys.includes(BZK_MINT) || accountKeys.includes(BZK_POOL) || programIds.includes(PUMP_AMM) || programIds.includes(JUPITER);
    return {
      signature: sig.signature,
      slot: tx.slot,
      err: tx.meta?.err ?? sig.err ?? null,
      blockTime: sig.blockTime ?? null,
      nativeDeltaLamports: delta,
      nativeDeltaSol: delta == null ? null : delta / 1_000_000_000,
      programIds,
      bzkRelated
    };
  }));
  const positive = txs.filter((tx) => typeof tx.nativeDeltaLamports === "number" && tx.nativeDeltaLamports > 0);
  const positiveBzkRelated = positive.filter((tx) => tx.bzkRelated);
  return {
    owner,
    limit,
    fetched: txs.length,
    positiveCount: positive.length,
    positiveSolTotal: positive.reduce((sum, tx) => sum + (tx.nativeDeltaSol ?? 0), 0),
    positiveBzkRelatedCount: positiveBzkRelated.length,
    positiveBzkRelatedSolTotal: positiveBzkRelated.reduce((sum, tx) => sum + (tx.nativeDeltaSol ?? 0), 0),
    latest: txs.slice(0, 10),
    positive: positive.slice(0, 10),
    positiveBzkRelated: positiveBzkRelated.slice(0, 10)
  };
}

async function runOnce(iteration: number) {
  const config = loadConfig();
  assertNoForbiddenConfigured(config);
  const connection = new Connection(config.rpcUrl, "confirmed");

  const minNetUsd = numberEnv("MIN_NET_USD", config.minNetUsd);
  const steps = [
    runStep("stacc-bzk-security-plan", "npm run stacc-bzk-security-plan"),
    runStep("stacc-social-fee-source-scan", "npm run stacc-social-fee-source-scan"),
    runStep("orca-owned-fee-source-scan", "npm run orca-owned-fee-source-scan", {
      INCLUDE_STACC_SCREENSHOT_AUTHORITIES: "true",
      OWNED_FEE_MAX_CONFIGS: process.env.OWNED_FEE_MAX_CONFIGS ?? "12"
    }),
    runStep("jupiter-index-watch", "npm run jupiter-index-watch", {
      TOKEN_MINT: BZK_MINT,
      QUOTE_AMOUNT_RAW: process.env.BZK_QUOTE_AMOUNT_RAW ?? "1000000",
      SOL_QUOTE_AMOUNT_RAW: process.env.BZK_SOL_QUOTE_AMOUNT_RAW ?? "1000000",
      USDC_QUOTE_AMOUNT_RAW: process.env.BZK_USDC_QUOTE_AMOUNT_RAW ?? "1000000"
    }),
    runStep("orca-owned-fee-cycle-sim-external", "npm run orca-owned-fee-cycle-sim", {
      BOT_COUNTERPARTY_MODE: "external",
      TARGET_WHIRLPOOL: BZK_POOL,
      BOT_COUNT: "0",
      BOT_ROUNDS: "0",
      BOT_TRADE_NOTIONAL_USD: "0"
    })
  ];

  const security = readJson("receipts/STACC-BZK-SECURITY-PLAN-LATEST.json");
  const feeScan = readJson("receipts/ORCA-OWNED-FEE-SOURCE-SCAN-LATEST.json");
  const socialFee = readJson("receipts/STACC-SOCIAL-FEE-SOURCE-LATEST.json");
  const jupiter = readJson("receipts/JUPITER-INDEX-WATCH-LATEST.json");
  const cycleSim = readJson("receipts/ORCA-OWNED-FEE-CYCLE-SIM-LATEST.json");
  const wzmaPulse = await recentNativeInflows(connection, WZMA, numberEnv("STACC_BZK_WZMA_TX_LIMIT", 20));
  const bzkPool = topBzkPool(feeScan);
  const bzkClaimableUsd = number(bzkPool?.cashClaimableUsd) ?? 0;
  const bzkExecutionClass = string(bzkPool?.executionClass);
  const bzkControlStatus = string(bzkPool?.controlStatus);
  const bzkActive = bzkPool?.active === true;
  const jupiterRoutes = routeSummary(jupiter);
  const cycleSelected = record(cycleSim?.selected);
  const cycleNoGoReasons = array(cycleSelected.noGoReasons).map(String);
  const solPriceForPulse = config.solPriceUsd ?? number(feeScan?.solPriceUsd) ?? 0;

  const securityReady = security?.verdict === "STACC_BZK_SECURITY_PATH_READY_NO_LIVE";
  const feeCollectReady = bzkClaimableUsd >= minNetUsd && bzkExecutionClass === "DIRECT_COLLECTABLE_CASH";
  const partnerFeeCandidate = bzkClaimableUsd >= minNetUsd && bzkExecutionClass === "PARTNER_OR_UNVERIFIED_CLAIMABLE_CASH";
  const routeCandidate = jupiterRoutes.routeFound && bzkActive;
  const freshWzmaCashPulse = wzmaPulse.positiveBzkRelatedSolTotal * solPriceForPulse >= minNetUsd;
  const socialFeeRecent = record(socialFee?.recent);
  const socialFeeCompatibility = record(socialFee?.cashRelayCompatibility);
  const socialFeeObservedUsd = number(socialFeeRecent.positiveNetUsd);
  const socialFeeObserved = socialFee?.verdict === "STACC_SOCIAL_FEE_SOURCE_OBSERVED_NO_LIVE";
  const anyStepFailed = steps.some((step) => !step.ok && step.name !== "orca-owned-fee-cycle-sim-external");

  const rejectionReasons = [
    securityReady ? null : "STACC/BZK security plan is not ready",
    anyStepFailed ? "one or more required monitor steps failed" : null,
    bzkActive ? null : "BZK Whirlpool is inactive or empty",
    jupiterRoutes.routeFound ? null : "Jupiter has no current BZK route",
    bzkClaimableUsd >= minNetUsd ? null : `BZK claimable cash fees ${bzkClaimableUsd.toFixed(6)} below MIN_NET_USD ${minNetUsd}`,
    feeCollectReady ? null : "no direct local signer cash-fee collect is currently ready",
    partnerFeeCandidate ? "claimable BZK cash fees require partner/unverified authority, not local direct collect" : null,
    routeCandidate ? null : "no active route candidate for settlement simulation",
    freshWzmaCashPulse ? "recent BZK/Pump/Jupiter-related WzMa SOL inflow detected; classify only after exact source receipt" : null,
    socialFeeObserved
      ? `social-fee SOL source observed (${socialFeeObservedUsd?.toFixed(6) ?? "unknown"} USD net), but not executable by CashRelay yet`
      : null,
    socialFeeCompatibility.pass === true ? null : "social-fee source is not yet a fresh exact executable receipt",
    cycleNoGoReasons.length > 0 ? `cycle sim not cash-positive: ${cycleNoGoReasons.join(" | ")}` : null
  ].filter((value): value is string => value !== null);

  const opportunityReady = securityReady && feeCollectReady && rejectionReasons.length === 0;
  const monitorReceipt = {
    verdict: opportunityReady
      ? "STACC_BZK_LOOP_OPPORTUNITY_READY_NO_LIVE"
      : "STACC_BZK_LOOP_MONITORING_NO_LIVE",
    generatedAt: new Date().toISOString(),
    iteration,
    noSend: true,
    dryRun: true,
    allowLive: false,
    minNetUsd,
    steps,
    security: {
      verdict: security?.verdict ?? null,
      bzkIsLegacySpl: record(security?.bzkSecurityState).bzkIsLegacySpl ?? null,
      whirlpoolControlHeld: record(security?.bzkSecurityState).whirlpoolControlHeld ?? null,
    },
    bzkPool: bzkPool ? {
      whirlpool: string(bzkPool.whirlpool),
      active: bzkActive,
      controlStatus: bzkControlStatus,
      executionClass: bzkExecutionClass,
      cashClaimableUsd: bzkClaimableUsd,
      tokenA: bzkPool.tokenA ?? null,
      tokenB: bzkPool.tokenB ?? null,
      feeRate: bzkPool.feeRate ?? null,
      protocolFeeRate: bzkPool.protocolFeeRate ?? null,
      cashTvlUsd: bzkPool.cashTvlUsd ?? null
    } : null,
    jupiter: jupiterRoutes,
    socialFee: {
      verdict: socialFee?.verdict ?? null,
      sourceClass: socialFee?.sourceClass ?? null,
      sourceName: socialFee?.sourceName ?? null,
      payerClass: socialFee?.payerClass ?? null,
      authorityLocalSignerAvailable: socialFee?.authorityLocalSignerAvailable ?? null,
      recent: socialFee?.recent ?? null,
      latestPositiveClaim: socialFee?.latestPositiveClaim ?? null,
      cashRelayCompatibility: socialFee?.cashRelayCompatibility ?? null
    },
    wzmaPulse,
    cycleSim: {
      verdict: cycleSim?.verdict ?? null,
      selected: cycleSelected,
      noGoReasons: cycleNoGoReasons
    },
    cashProofGate: {
      pass: opportunityReady,
      reason: opportunityReady
        ? "A direct local-signable BZK cash-fee collect candidate is above MIN_NET_USD. Build exact post-balance source receipt before live."
        : "Monitoring only. No live-safe cash-settled BZK opportunity is ready yet.",
      liveStillRequiresExplicitApproval: true
    },
    rejectionReasons,
    nextRequiredExactBuild: opportunityReady
      ? [
        "Build exact collect/sell transaction simulation for selected BZK pool.",
        "Emit CashRelay source receipt with SOL/USDC beforeRaw and afterRaw after costs.",
        "Ask Velon for explicit approval before any live send."
      ]
      : [
        "Keep monitoring BZK route/indexing and protocol fees.",
        "If partner authority signs are available, configure OWNED_FEE_KEYPAIR_PATHS and rerun.",
        "If WzMa social-fee authority is approved and local, configure SOCIAL_FEE_KEYPAIR_PATHS and build exact claim sim.",
        "If external flow appears, run settlement sim before any live action."
      ]
  };

  const out = writeReceipt(OUT_RECEIPT, monitorReceipt);
  appendHistory(monitorReceipt);
  console.log(`${monitorReceipt.verdict} iteration=${iteration} bzkActive=${bzkActive} route=${jupiterRoutes.routeFound} claimableUsd=${bzkClaimableUsd.toFixed(6)} receipt=${out}`);
  if (rejectionReasons.length > 0) console.log(`blocked=${rejectionReasons.join(" | ")}`);
  return monitorReceipt;
}

async function main(): Promise<void> {
  const once = boolEnv("STACC_BZK_LOOP_ONCE", true);
  const maxIterations = numberEnv("STACC_BZK_LOOP_MAX_ITERATIONS", once ? 1 : 0);
  const intervalMs = numberEnv("STACC_BZK_LOOP_INTERVAL_MS", 60_000);
  let iteration = 0;

  while (maxIterations === 0 || iteration < maxIterations) {
    iteration += 1;
    const receipt = await runOnce(iteration);
    if (receipt.verdict === "STACC_BZK_LOOP_OPPORTUNITY_READY_NO_LIVE") return;
    if (once || (maxIterations !== 0 && iteration >= maxIterations)) break;
    await sleep(intervalMs);
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
