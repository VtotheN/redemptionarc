import { Connection, PublicKey } from "@solana/web3.js";
import {
  getAccount,
  getAssociatedTokenAddressSync,
  TOKEN_2022_PROGRAM_ID,
} from "@solana/spl-token";
import { loadConfig } from "../config.js";
import { HOP_MINT_DEFAULT, USDC_MINT_DEFAULT } from "../constants.js";
import { writeReceipt } from "../utils/receipt.js";
import { assertNoForbiddenConfigured } from "../utils/safety.js";

const OUT_RECEIPT = "HOP-CASHABILITY-GATE-LATEST.json";
const SOL_MINT = "So11111111111111111111111111111111111111112";
const USDC_DECIMALS = 6;
const HOP_DECIMALS = 6;
const SOL_DECIMALS = 9;

const DEFAULT_OWNED_AMM_KEYS = [
  // Current Raydium CP HOP/USDC pool observed in bundle-womb-lite TX.
  "6zbtkhUtxdd3gfae4QJpHe356S44wRMNxNjJq33oEL7f",
  // Earlier RedemptionArc-owned Orca Whirlpool HOP/USDC pool.
  "EwoZHyXz48vZL1TwkpQoq31brW4G4NDwmMr1DMw6qqBV",
];

const DEFAULT_OWNED_LP_MINTS = [
  // Raydium CP LP mint for pool 6zbtk...
  "J2HNL9QJYrzDQsf9g3gSnPRSfUEWqWW75H5FyVmBzYqq",
];

type RouteLeg = {
  label: string | null;
  ammKey: string | null;
  inputMint: string | null;
  outputMint: string | null;
  inAmount: string | null;
  outAmount: string | null;
  percent: number | null;
  bps: number | null;
};

type JupiterQuote = {
  inputMint: string;
  inAmount: string;
  outputMint: string;
  outAmount: string;
  otherAmountThreshold?: string;
  swapMode?: string;
  slippageBps?: number;
  priceImpactPct?: string;
  routePlan?: Array<{
    swapInfo?: {
      ammKey?: string;
      label?: string;
      inputMint?: string;
      outputMint?: string;
      inAmount?: string;
      outAmount?: string;
    };
    percent?: number;
    bps?: number;
  }>;
  error?: string;
};

type QuoteProbe = {
  outputAsset: "USDC" | "SOL";
  ok: boolean;
  status: number | null;
  error: unknown;
  inputAmountRaw: string;
  inputAmountHop: number;
  outAmountRaw: string | null;
  outAmountUi: number | null;
  outUsd: number | null;
  priceImpactPct: number | null;
  routePlan: RouteLeg[];
  routeAmmKeys: string[];
  ownedAmmKeysHit: string[];
  usesOwnedRoute: boolean;
  acceptedExternal: boolean;
  rejectionReasons: string[];
};

function csv(name: string, fallback: string[] = []): string[] {
  const raw = process.env[name];
  if (!raw) return fallback;
  return raw.split(",").map((item) => item.trim()).filter(Boolean);
}

function num(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw == null || raw === "") return fallback;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) throw new Error(`Invalid numeric env ${name}=${raw}`);
  return parsed;
}

function bool(name: string, fallback: boolean): boolean {
  const raw = process.env[name];
  if (raw == null || raw === "") return fallback;
  return ["1", "true", "yes", "y"].includes(raw.toLowerCase());
}

function decimalUiToRaw(ui: string, decimals: number): bigint {
  const normalized = ui.trim();
  if (!/^\d+(\.\d+)?$/.test(normalized)) {
    throw new Error(`Invalid decimal amount ${ui}`);
  }
  const [whole, frac = ""] = normalized.split(".");
  const padded = `${frac}${"0".repeat(decimals)}`.slice(0, decimals);
  return BigInt(whole) * 10n ** BigInt(decimals) + BigInt(padded || "0");
}

function quoteUrl(): string {
  const direct = process.env.JUPITER_QUOTE_URL || process.env.JUP_QUOTE_URL;
  if (direct) return direct;
  const base = process.env.JUPITER_API || "https://lite-api.jup.ag/swap/v1";
  return base.endsWith("/quote") ? base : `${base.replace(/\/$/, "")}/quote`;
}

function routePlan(quote: JupiterQuote): RouteLeg[] {
  return (quote.routePlan ?? []).map((leg) => ({
    label: leg.swapInfo?.label ?? null,
    ammKey: leg.swapInfo?.ammKey ?? null,
    inputMint: leg.swapInfo?.inputMint ?? null,
    outputMint: leg.swapInfo?.outputMint ?? null,
    inAmount: leg.swapInfo?.inAmount ?? null,
    outAmount: leg.swapInfo?.outAmount ?? null,
    percent: leg.percent ?? null,
    bps: leg.bps ?? null,
  }));
}

async function fetchQuote(args: {
  inputMint: string;
  outputMint: string;
  amountRaw: bigint;
  slippageBps: number;
  restrictIntermediateTokens: boolean;
}): Promise<{ ok: boolean; status: number | null; body: JupiterQuote | null; error: unknown }> {
  const url = new URL(quoteUrl());
  url.searchParams.set("inputMint", args.inputMint);
  url.searchParams.set("outputMint", args.outputMint);
  url.searchParams.set("amount", args.amountRaw.toString());
  url.searchParams.set("slippageBps", String(args.slippageBps));
  url.searchParams.set("onlyDirectRoutes", process.env.JUPITER_ONLY_DIRECT_ROUTES || "false");
  url.searchParams.set("restrictIntermediateTokens", String(args.restrictIntermediateTokens));

  const headers: Record<string, string> = { accept: "application/json" };
  if (process.env.JUP_API_KEY) headers["x-api-key"] = process.env.JUP_API_KEY;

  try {
    const response = await fetch(url, { headers });
    const body = await response.json().catch(() => null) as JupiterQuote | null;
    if (!response.ok || body?.error) {
      return { ok: false, status: response.status, body, error: body ?? { statusText: response.statusText } };
    }
    return { ok: true, status: response.status, body, error: null };
  } catch (error) {
    return {
      ok: false,
      status: null,
      body: null,
      error: error instanceof Error ? { message: error.message } : String(error),
    };
  }
}

function classifyQuote(args: {
  outputAsset: "USDC" | "SOL";
  amountRaw: bigint;
  quote: { ok: boolean; status: number | null; body: JupiterQuote | null; error: unknown };
  ownedAmmKeys: Set<string>;
  maxImpactPct: number;
  solPriceUsd: number | null;
}): QuoteProbe {
  const reasons: string[] = [];
  const body = args.quote.body;
  const legs = body ? routePlan(body) : [];
  const routeAmmKeys = legs.map((leg) => leg.ammKey).filter((key): key is string => Boolean(key));
  const ownedAmmKeysHit = routeAmmKeys.filter((key) => args.ownedAmmKeys.has(key));
  const priceImpactPct = body?.priceImpactPct == null ? null : Number(body.priceImpactPct);
  const decimals = args.outputAsset === "USDC" ? USDC_DECIMALS : SOL_DECIMALS;
  const outAmountUi = body?.outAmount == null ? null : Number(body.outAmount) / 10 ** decimals;
  const outUsd = outAmountUi == null
    ? null
    : args.outputAsset === "USDC"
      ? outAmountUi
      : args.solPriceUsd == null ? null : outAmountUi * args.solPriceUsd;

  if (!args.quote.ok) reasons.push("Jupiter quote failed or route not found");
  if (ownedAmmKeysHit.length > 0) reasons.push("route uses owned AMM key");
  if (routeAmmKeys.length === 0 && args.quote.ok) reasons.push("quote returned no route AMM keys");
  if (priceImpactPct == null || !Number.isFinite(priceImpactPct)) {
    reasons.push("priceImpactPct missing or invalid");
  } else if (priceImpactPct > args.maxImpactPct) {
    reasons.push(`priceImpactPct ${priceImpactPct.toFixed(6)} exceeds ${args.maxImpactPct}`);
  }
  if (outUsd == null) reasons.push(`${args.outputAsset} output lacks USD valuation`);

  return {
    outputAsset: args.outputAsset,
    ok: args.quote.ok,
    status: args.quote.status,
    error: args.quote.error,
    inputAmountRaw: args.amountRaw.toString(),
    inputAmountHop: Number(args.amountRaw) / 10 ** HOP_DECIMALS,
    outAmountRaw: body?.outAmount ?? null,
    outAmountUi,
    outUsd,
    priceImpactPct,
    routePlan: legs,
    routeAmmKeys,
    ownedAmmKeysHit,
    usesOwnedRoute: ownedAmmKeysHit.length > 0,
    acceptedExternal: reasons.length === 0,
    rejectionReasons: reasons,
  };
}

async function quoteAndClassify(args: {
  outputAsset: "USDC" | "SOL";
  outputMint: string;
  amountRaw: bigint;
  slippageBps: number;
  restrictIntermediateTokens: boolean;
  ownedAmmKeys: Set<string>;
  maxImpactPct: number;
  solPriceUsd: number | null;
}): Promise<QuoteProbe> {
  const quote = await fetchQuote({
    inputMint: process.env.HOP_MINT || HOP_MINT_DEFAULT,
    outputMint: args.outputMint,
    amountRaw: args.amountRaw,
    slippageBps: args.slippageBps,
    restrictIntermediateTokens: args.restrictIntermediateTokens,
  });
  return classifyQuote({ ...args, quote });
}

async function hopDeltaFromSourceTx(connection: Connection, signature: string, hopMint: string, targetOwners: Set<string>): Promise<{
  signature: string;
  selectedOwner: string | null;
  selectedDeltaRaw: string | null;
  deltas: Array<{ owner: string | null; accountIndex: number; preRaw: string; postRaw: string; deltaRaw: string }>;
}> {
  const tx = await connection.getParsedTransaction(signature, {
    commitment: "confirmed",
    maxSupportedTransactionVersion: 0,
  });
  if (!tx) throw new Error(`source tx not found: ${signature}`);

  const pre = new Map<string, { owner?: string; accountIndex: number; amount: bigint }>();
  for (const balance of tx.meta?.preTokenBalances ?? []) {
    if (balance.mint !== hopMint) continue;
    pre.set(String(balance.accountIndex), {
      owner: balance.owner,
      accountIndex: balance.accountIndex,
      amount: BigInt(balance.uiTokenAmount.amount),
    });
  }

  const deltas: Array<{ owner: string | null; accountIndex: number; preRaw: string; postRaw: string; deltaRaw: string }> = [];
  for (const balance of tx.meta?.postTokenBalances ?? []) {
    if (balance.mint !== hopMint) continue;
    const before = pre.get(String(balance.accountIndex));
    const post = BigInt(balance.uiTokenAmount.amount);
    const delta = post - (before?.amount ?? 0n);
    if (delta <= 0n) continue;
    const owner = balance.owner ?? before?.owner ?? null;
    if (targetOwners.size > 0 && (!owner || !targetOwners.has(owner))) continue;
    deltas.push({
      owner,
      accountIndex: balance.accountIndex,
      preRaw: (before?.amount ?? 0n).toString(),
      postRaw: post.toString(),
      deltaRaw: delta.toString(),
    });
  }

  deltas.sort((a, b) => {
    const left = BigInt(a.deltaRaw);
    const right = BigInt(b.deltaRaw);
    return left === right ? 0 : left > right ? -1 : 1;
  });

  return {
    signature,
    selectedOwner: deltas[0]?.owner ?? null,
    selectedDeltaRaw: deltas[0]?.deltaRaw ?? null,
    deltas,
  };
}

async function hopAmountFromInputs(connection: Connection, config: ReturnType<typeof loadConfig>, hopMint: string, targetOwners: Set<string>) {
  const sourceTx = process.env.HOP_CASHABILITY_SOURCE_TX || process.env.SOURCE_TX_SIGNATURE || "";
  if (sourceTx) {
    const source = await hopDeltaFromSourceTx(connection, sourceTx, hopMint, targetOwners);
    if (!source.selectedDeltaRaw) {
      throw new Error("source tx has no positive HOP delta for configured target owners");
    }
    return {
      amountRaw: BigInt(source.selectedDeltaRaw),
      sourceKind: "source_tx_positive_hop_delta",
      source,
    };
  }

  if (process.env.HOP_CASHABILITY_AMOUNT_RAW) {
    return {
      amountRaw: BigInt(process.env.HOP_CASHABILITY_AMOUNT_RAW),
      sourceKind: "env_raw",
      source: null,
    };
  }

  if (process.env.HOP_CASHABILITY_AMOUNT_UI) {
    return {
      amountRaw: decimalUiToRaw(process.env.HOP_CASHABILITY_AMOUNT_UI, HOP_DECIMALS),
      sourceKind: "env_ui",
      source: null,
    };
  }

  if (!config.crank) throw new Error("Set HOP_CASHABILITY_AMOUNT_RAW/UI or REDEMPTION_CRANK");
  const hopAta = getAssociatedTokenAddressSync(new PublicKey(hopMint), config.crank, false, TOKEN_2022_PROGRAM_ID);
  const account = await getAccount(connection, hopAta, "confirmed", TOKEN_2022_PROGRAM_ID);
  return {
    amountRaw: account.amount,
    sourceKind: "current_crank_hop_balance",
    source: {
      owner: config.crank.toBase58(),
      hopAta: hopAta.toBase58(),
      amountRaw: account.amount.toString(),
    },
  };
}

async function ownedLpSnapshots(connection: Connection, ownedLpMints: string[], ownedWallets: Set<string>) {
  const snapshots = [];
  for (const mint of ownedLpMints) {
    try {
      const supply = await connection.getTokenSupply(new PublicKey(mint), "confirmed");
      const largest = await connection.getTokenLargestAccounts(new PublicKey(mint), "confirmed");
      const holders = [];
      for (const holder of largest.value.slice(0, 5)) {
        const info = await connection.getParsedAccountInfo(holder.address, "confirmed");
        const parsed = info.value?.data && "parsed" in info.value.data ? info.value.data.parsed as any : null;
        const owner = parsed?.info?.owner ?? null;
        holders.push({
          tokenAccount: holder.address.toBase58(),
          owner,
          amountRaw: holder.amount,
          amountUi: holder.uiAmountString,
          ownedWallet: owner ? ownedWallets.has(owner) : false,
        });
      }
      snapshots.push({
        mint,
        supplyRaw: supply.value.amount,
        supplyUi: supply.value.uiAmountString,
        holders,
        ownedLargestHolder: holders[0]?.ownedWallet ?? false,
      });
    } catch (error) {
      snapshots.push({
        mint,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return snapshots;
}

async function maxAcceptedAmount(args: {
  targetRaw: bigint;
  slippageBps: number;
  restrictIntermediateTokens: boolean;
  ownedAmmKeys: Set<string>;
  maxImpactPct: number;
  solPriceUsd: number | null;
  minNetUsd: number;
  cycleCostUsd: number;
}) {
  if (args.targetRaw <= 0n) return null;

  const steps = Math.max(0, Math.floor(num("HOP_CASHABILITY_SEARCH_STEPS", 10)));
  if (steps === 0) return null;

  let low = 0n;
  let high = args.targetRaw;
  let best: QuoteProbe | null = null;
  const probes: QuoteProbe[] = [];

  for (let i = 0; i < steps; i++) {
    const mid = (low + high + 1n) / 2n;
    if (mid <= 0n) break;
    const probe = await quoteAndClassify({
      outputAsset: "USDC",
      outputMint: process.env.USDC_MINT || USDC_MINT_DEFAULT,
      amountRaw: mid,
      slippageBps: args.slippageBps,
      restrictIntermediateTokens: args.restrictIntermediateTokens,
      ownedAmmKeys: args.ownedAmmKeys,
      maxImpactPct: args.maxImpactPct,
      solPriceUsd: args.solPriceUsd,
    });
    probes.push(probe);
    const netUsd = (probe.outUsd ?? 0) - args.cycleCostUsd;
    if (probe.acceptedExternal && netUsd >= args.minNetUsd) {
      best = probe;
      low = mid;
    } else {
      high = mid - 1n;
    }
  }

  return {
    best,
    probes: probes.map((probe) => ({
      inputAmountRaw: probe.inputAmountRaw,
      inputAmountHop: probe.inputAmountHop,
      outUsd: probe.outUsd,
      priceImpactPct: probe.priceImpactPct,
      acceptedExternal: probe.acceptedExternal,
      rejectionReasons: probe.rejectionReasons,
      ownedAmmKeysHit: probe.ownedAmmKeysHit,
    })),
  };
}

async function main() {
  const config = loadConfig();
  assertNoForbiddenConfigured(config);

  const connection = new Connection(config.rpcUrl, "confirmed");
  const hopMint = config.hopMint.toBase58();
  const usdcMint = config.usdcMint.toBase58();
  const maxImpactPct = num("HOP_CASHABILITY_MAX_IMPACT_PCT", 1);
  const slippageBps = num("HOP_CASHABILITY_SLIPPAGE_BPS", config.jupiterSlippageBps);
  const cycleCostUsd = num("HOP_CASHABILITY_CYCLE_COST_USD", num("CYCLE_COST_USD", 0));
  const restrictIntermediateTokens = bool("HOP_CASHABILITY_RESTRICT_INTERMEDIATE_TOKENS", true);
  const solPriceUsd = config.solPriceUsd ?? null;

  const ownedAmmKeys = new Set(csv("OWNED_AMM_KEYS", DEFAULT_OWNED_AMM_KEYS));
  const ownedLpMints = csv("OWNED_LP_MINTS", DEFAULT_OWNED_LP_MINTS);
  const ownedWallets = new Set([
    ...csv("OWNED_WALLETS"),
    config.crank?.toBase58(),
    config.treasury?.toBase58(),
    config.withdrawAuthority?.toBase58(),
  ].filter((value): value is string => Boolean(value)));

  const targetOwners = new Set([
    ...csv("HOP_CASHABILITY_TARGET_OWNERS"),
    config.crank?.toBase58(),
    config.treasury?.toBase58(),
    config.withdrawAuthority?.toBase58(),
  ].filter((value): value is string => Boolean(value)));

  const amount = await hopAmountFromInputs(connection, config, hopMint, targetOwners);
  const amountRaw = amount.amountRaw;
  const amountHop = Number(amountRaw) / 10 ** HOP_DECIMALS;

  const [usdcQuote, solQuote, lpSnapshots] = await Promise.all([
    quoteAndClassify({
      outputAsset: "USDC",
      outputMint: usdcMint,
      amountRaw,
      slippageBps,
      restrictIntermediateTokens,
      ownedAmmKeys,
      maxImpactPct,
      solPriceUsd,
    }),
    quoteAndClassify({
      outputAsset: "SOL",
      outputMint: SOL_MINT,
      amountRaw,
      slippageBps,
      restrictIntermediateTokens,
      ownedAmmKeys,
      maxImpactPct,
      solPriceUsd,
    }),
    ownedLpSnapshots(connection, ownedLpMints, ownedWallets),
  ]);

  const search = await maxAcceptedAmount({
    targetRaw: amountRaw,
    slippageBps,
    restrictIntermediateTokens,
    ownedAmmKeys,
    maxImpactPct,
    solPriceUsd,
    minNetUsd: config.minNetUsd,
    cycleCostUsd,
  });

  const primaryNetCashUsd = (usdcQuote.outUsd ?? 0) - cycleCostUsd;
  const rejectionReasons = new Set<string>();
  for (const reason of usdcQuote.rejectionReasons) rejectionReasons.add(`USDC quote: ${reason}`);
  if (primaryNetCashUsd < config.minNetUsd) {
    rejectionReasons.add(`netCashUsd ${primaryNetCashUsd.toFixed(6)} below MIN_NET_USD ${config.minNetUsd}`);
  }
  if (amountRaw <= 0n) rejectionReasons.add("HOP amount is zero");

  const bestNetUsd = search?.best?.outUsd == null ? null : search.best.outUsd - cycleCostUsd;
  const verdict = rejectionReasons.size === 0
    ? "HOP_CASHABILITY_READY_NO_SEND"
    : bestNetUsd != null && bestNetUsd >= config.minNetUsd
      ? "HOP_CASHABILITY_PARTIAL_READY_NO_SEND"
      : "HOP_CASHABILITY_BLOCKED";

  const receipt = {
    verdict,
    generatedAt: new Date().toISOString(),
    readOnly: true,
    noSend: true,
    liveIntentIgnored: {
      dryRun: config.dryRun,
      allowLive: config.allowLive,
      liveTxApproved: process.env.LIVE_TX_APPROVED === "true",
      note: "hop-cashability-gate never builds or sends swap transactions",
    },
    input: {
      hopMint,
      usdcMint,
      amountRaw: amountRaw.toString(),
      amountHop,
      amountSourceKind: amount.sourceKind,
      amountSource: amount.source,
      quoteUrl: quoteUrl(),
      slippageBps,
      maxImpactPct,
      restrictIntermediateTokens,
      cycleCostUsd,
      minNetUsd: config.minNetUsd,
      solPriceUsd,
    },
    ownershipGuards: {
      ownedAmmKeys: Array.from(ownedAmmKeys),
      ownedLpMints,
      ownedWallets: Array.from(ownedWallets),
      ownedLpSnapshots: lpSnapshots,
    },
    quotes: {
      usdc: usdcQuote,
      sol: solQuote,
    },
    cashMath: {
      primaryOutUsd: usdcQuote.outUsd,
      cycleCostUsd,
      primaryNetCashUsd,
      bestExternalHopRawAtImpact: search?.best?.inputAmountRaw ?? "0",
      bestExternalHopUiAtImpact: search?.best?.inputAmountHop ?? 0,
      bestExternalOutUsdAtImpact: search?.best?.outUsd ?? null,
      bestExternalNetUsdAtImpact: bestNetUsd,
    },
    search,
    rejectionReasons: Array.from(rejectionReasons),
    next: verdict === "HOP_CASHABILITY_READY_NO_SEND" || verdict === "HOP_CASHABILITY_PARTIAL_READY_NO_SEND"
      ? "Feed the accepted external settlement amount into CashRelay with exact pre/post USDC/SOL balance simulation."
      : "Do not count harvested HOP as profit. Find non-owned liquidity or a separate SOL/USDC source.",
  };

  const out = writeReceipt(OUT_RECEIPT, receipt);
  console.log(`${verdict} hop=${amountHop.toFixed(6)} usdcOut=${(usdcQuote.outUsd ?? 0).toFixed(6)} net=${primaryNetCashUsd.toFixed(6)} receipt=${out}`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
