import { Connection, ParsedTransactionWithMeta, PublicKey } from "@solana/web3.js";
import { getMint, getTransferFeeConfig, TOKEN_2022_PROGRAM_ID } from "@solana/spl-token";
import { loadConfig } from "../config.js";
import { FORBIDDEN_WALLETS, HOP_MINT_DEFAULT, USDC_MINT_DEFAULT } from "../constants.js";
import { writeReceipt } from "../utils/receipt.js";
import { assertNoForbiddenConfigured } from "../utils/safety.js";

const OUT_RECEIPT = "HOP-EXTERNAL-FLOW-WATCH-LATEST.json";
const SOL_MINT = "So11111111111111111111111111111111111111112";
const USDT_MINT = "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB";
const DEFAULT_RAYDIUM_POOL_AUTHORITY = "GpMZbSM2GgvTKHJirzeGfMFoaZ8UR2X7F4v8vHTvxFbL";

type PoolConfig = {
  id: string;
  pool: string;
  quoteMint: string;
  quoteAsset: string;
  label?: string;
  lpMint?: string;
  vaultOwner?: string;
  hopVault?: string;
  quoteVault?: string;
};

type TokenDelta = {
  accountIndex: number;
  tokenAccount: string;
  owner: string | null;
  mint: string;
  decimals: number;
  preRaw: string;
  postRaw: string;
  deltaRaw: string;
  deltaUi: number;
};

const DEFAULT_POOLS: PoolConfig[] = [
  {
    id: "hop-usdc-raydium-cp",
    label: "HOP/USDC Raydium CP",
    pool: "6zbtkhUtxdd3gfae4QJpHe356S44wRMNxNjJq33oEL7f",
    quoteMint: USDC_MINT_DEFAULT,
    quoteAsset: "USDC",
    lpMint: "J2HNL9QJYrzDQsf9g3gSnPRSfUEWqWW75H5FyVmBzYqq",
    vaultOwner: DEFAULT_RAYDIUM_POOL_AUTHORITY,
  },
];

function csv(name: string): string[] {
  const raw = process.env[name];
  if (!raw) return [];
  return raw.split(",").map((item) => item.trim()).filter(Boolean);
}

function num(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw == null || raw === "") return fallback;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) throw new Error(`Invalid numeric env ${name}=${raw}`);
  return parsed;
}

function readPools(): PoolConfig[] {
  const raw = process.env.HOP_FLOW_POOLS_JSON;
  if (!raw) return DEFAULT_POOLS;
  const parsed = JSON.parse(raw) as PoolConfig[];
  if (!Array.isArray(parsed) || parsed.length === 0) {
    throw new Error("HOP_FLOW_POOLS_JSON must be a non-empty JSON array");
  }
  for (const pool of parsed) {
    if (!pool.id || !pool.pool || !pool.quoteMint || !pool.quoteAsset) {
      throw new Error("Each HOP_FLOW_POOLS_JSON item requires id, pool, quoteMint, quoteAsset");
    }
    new PublicKey(pool.pool);
    new PublicKey(pool.quoteMint);
    if (pool.lpMint) new PublicKey(pool.lpMint);
    if (pool.vaultOwner) new PublicKey(pool.vaultOwner);
    if (pool.hopVault) new PublicKey(pool.hopVault);
    if (pool.quoteVault) new PublicKey(pool.quoteVault);
  }
  return parsed;
}

function ui(raw: bigint, decimals: number): number {
  return Number(raw) / 10 ** decimals;
}

function accountKeys(tx: ParsedTransactionWithMeta): string[] {
  return tx.transaction.message.accountKeys.map((key) => key.pubkey.toBase58());
}

function signers(tx: ParsedTransactionWithMeta): string[] {
  return tx.transaction.message.accountKeys
    .filter((key) => key.signer)
    .map((key) => key.pubkey.toBase58());
}

function tokenDeltas(tx: ParsedTransactionWithMeta): TokenDelta[] {
  const keys = accountKeys(tx);
  const byIndex = new Map<string, {
    accountIndex: number;
    tokenAccount: string;
    owner: string | null;
    mint: string;
    decimals: number;
    preRaw: bigint;
    postRaw: bigint;
  }>();

  for (const balance of tx.meta?.preTokenBalances ?? []) {
    const key = `${balance.accountIndex}:${balance.mint}`;
    byIndex.set(key, {
      accountIndex: balance.accountIndex,
      tokenAccount: keys[balance.accountIndex] ?? String(balance.accountIndex),
      owner: balance.owner ?? null,
      mint: balance.mint,
      decimals: balance.uiTokenAmount.decimals,
      preRaw: BigInt(balance.uiTokenAmount.amount),
      postRaw: 0n,
    });
  }

  for (const balance of tx.meta?.postTokenBalances ?? []) {
    const key = `${balance.accountIndex}:${balance.mint}`;
    const existing = byIndex.get(key);
    if (existing) {
      existing.owner = balance.owner ?? existing.owner;
      existing.decimals = balance.uiTokenAmount.decimals;
      existing.postRaw = BigInt(balance.uiTokenAmount.amount);
      continue;
    }
    byIndex.set(key, {
      accountIndex: balance.accountIndex,
      tokenAccount: keys[balance.accountIndex] ?? String(balance.accountIndex),
      owner: balance.owner ?? null,
      mint: balance.mint,
      decimals: balance.uiTokenAmount.decimals,
      preRaw: 0n,
      postRaw: BigInt(balance.uiTokenAmount.amount),
    });
  }

  return Array.from(byIndex.values())
    .map((item) => {
      const delta = item.postRaw - item.preRaw;
      return {
        accountIndex: item.accountIndex,
        tokenAccount: item.tokenAccount,
        owner: item.owner,
        mint: item.mint,
        decimals: item.decimals,
        preRaw: item.preRaw.toString(),
        postRaw: item.postRaw.toString(),
        deltaRaw: delta.toString(),
        deltaUi: ui(delta, item.decimals),
      };
    })
    .filter((item) => item.deltaRaw !== "0");
}

function sumRaw(deltas: TokenDelta[]): bigint {
  return deltas.reduce((sum, delta) => sum + BigInt(delta.deltaRaw), 0n);
}

function matchingVaultDeltas(pool: PoolConfig, deltas: TokenDelta[], hopMint: string): TokenDelta[] {
  const exactVaults = new Set([pool.hopVault, pool.quoteVault].filter((value): value is string => Boolean(value)));
  if (exactVaults.size > 0) {
    return deltas.filter((delta) => exactVaults.has(delta.tokenAccount));
  }
  if (pool.vaultOwner) {
    return deltas.filter((delta) => delta.owner === pool.vaultOwner && (delta.mint === hopMint || delta.mint === pool.quoteMint));
  }
  return [];
}

async function quoteUsdPrice(mint: string, decimals: number): Promise<number | null> {
  if (mint === USDC_MINT_DEFAULT || mint === USDT_MINT) return 1;
  const amount = 10n ** BigInt(decimals);
  const url = new URL(process.env.HOP_FLOW_JUPITER_QUOTE_URL || "https://lite-api.jup.ag/swap/v1/quote");
  url.searchParams.set("inputMint", mint);
  url.searchParams.set("outputMint", USDC_MINT_DEFAULT);
  url.searchParams.set("amount", amount.toString());
  url.searchParams.set("slippageBps", "100");
  url.searchParams.set("restrictIntermediateTokens", "true");
  try {
    const response = await fetch(url, { headers: { accept: "application/json" } });
    const body = await response.json().catch(() => null) as { outAmount?: string; error?: string } | null;
    if (!response.ok || !body?.outAmount || body.error) return null;
    return Number(body.outAmount) / 1e6;
  } catch {
    return null;
  }
}

async function lpSnapshot(connection: Connection, pool: PoolConfig, affiliatedWallets: Set<string>) {
  if (!pool.lpMint) return null;
  try {
    const [supply, largest] = await Promise.all([
      connection.getTokenSupply(new PublicKey(pool.lpMint), "confirmed"),
      connection.getTokenLargestAccounts(new PublicKey(pool.lpMint), "confirmed"),
    ]);
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
        affiliated: owner ? affiliatedWallets.has(owner) : false,
      });
    }
    return {
      lpMint: pool.lpMint,
      supplyRaw: supply.value.amount,
      supplyUi: supply.value.uiAmountString,
      holders,
      largestHolderAffiliated: holders[0]?.affiliated ?? false,
    };
  } catch (error) {
    return {
      lpMint: pool.lpMint,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

async function activeHopFee(connection: Connection, hopMint: string) {
  const [mintInfo, epochInfo] = await Promise.all([
    getMint(connection, new PublicKey(hopMint), "confirmed", TOKEN_2022_PROGRAM_ID),
    connection.getEpochInfo("confirmed"),
  ]);
  const config = getTransferFeeConfig(mintInfo);
  if (!config) return null;
  const active = BigInt(epochInfo.epoch) >= config.newerTransferFee.epoch
    ? config.newerTransferFee
    : config.olderTransferFee;
  return {
    currentEpoch: epochInfo.epoch,
    activeBps: active.transferFeeBasisPoints,
    maximumFeeRaw: active.maximumFee.toString(),
    olderBps: config.olderTransferFee.transferFeeBasisPoints,
    olderEpoch: config.olderTransferFee.epoch.toString(),
    newerBps: config.newerTransferFee.transferFeeBasisPoints,
    newerEpoch: config.newerTransferFee.epoch.toString(),
    mintWithheldAmountRaw: config.withheldAmount.toString(),
  };
}

function estimateT22FromVaultMove(hopVaultDeltaRaw: bigint, activeBps: number | null): bigint {
  if (!activeBps || hopVaultDeltaRaw === 0n) return 0n;
  const bps = BigInt(activeBps);
  const abs = hopVaultDeltaRaw < 0n ? -hopVaultDeltaRaw : hopVaultDeltaRaw;
  // Inbound-to-vault deltas are net of fee. Outbound vault deltas are closer to gross.
  if (hopVaultDeltaRaw > 0n && activeBps < 10_000) {
    return (abs * bps) / BigInt(10_000 - activeBps);
  }
  return (abs * bps) / 10_000n;
}

async function inspectPool(connection: Connection, pool: PoolConfig, args: {
  hopMint: string;
  limit: number;
  lookbackMs: number;
  affiliatedWallets: Set<string>;
  activeHopFeeBps: number | null;
  quoteUsdPrice: number | null;
}) {
  const poolKey = new PublicKey(pool.pool);
  const signatures = await connection.getSignaturesForAddress(poolKey, { limit: args.limit }, "confirmed");
  const now = Date.now();
  const events = [];

  for (const item of signatures) {
    const blockTimeMs = item.blockTime ? item.blockTime * 1000 : null;
    if (blockTimeMs && now - blockTimeMs > args.lookbackMs) continue;
    const tx = await connection.getParsedTransaction(item.signature, {
      commitment: "confirmed",
      maxSupportedTransactionVersion: 0,
    });
    if (!tx || tx.meta?.err) continue;

    const keys = new Set(accountKeys(tx));
    if (!keys.has(pool.pool) && (!pool.hopVault || !keys.has(pool.hopVault)) && (!pool.quoteVault || !keys.has(pool.quoteVault))) {
      continue;
    }

    const txSigners = signers(tx);
    const affiliatedSigners = txSigners.filter((signer) => args.affiliatedWallets.has(signer));
    const flowClass = affiliatedSigners.length > 0 ? "AFFILIATED_FLOW_REJECTED" : "EXTERNAL_FLOW_CANDIDATE";
    const deltas = tokenDeltas(tx);
    const vaultDeltas = matchingVaultDeltas(pool, deltas, args.hopMint);
    const hopVaultDeltaRaw = sumRaw(vaultDeltas.filter((delta) => delta.mint === args.hopMint));
    const quoteVaultDeltaRaw = sumRaw(vaultDeltas.filter((delta) => delta.mint === pool.quoteMint));
    const quoteDecimals = vaultDeltas.find((delta) => delta.mint === pool.quoteMint)?.decimals ?? (pool.quoteMint === SOL_MINT ? 9 : 6);
    const quoteVaultDeltaUi = ui(quoteVaultDeltaRaw, quoteDecimals);
    const quoteVaultDeltaUsd = args.quoteUsdPrice == null ? null : quoteVaultDeltaUi * args.quoteUsdPrice;
    const allHopDeltaRaw = sumRaw(deltas.filter((delta) => delta.mint === args.hopMint));
    const observedWithheldRaw = allHopDeltaRaw < 0n ? -allHopDeltaRaw : 0n;
    const estimatedT22Raw = estimateT22FromVaultMove(hopVaultDeltaRaw, args.activeHopFeeBps);

    events.push({
      signature: item.signature,
      slot: item.slot,
      blockTime: item.blockTime,
      flowClass,
      signers: txSigners,
      affiliatedSigners,
      vaultDeltaSummary: {
        hopVaultDeltaRaw: hopVaultDeltaRaw.toString(),
        hopVaultDeltaUi: ui(hopVaultDeltaRaw, 6),
        quoteVaultDeltaRaw: quoteVaultDeltaRaw.toString(),
        quoteVaultDeltaUi,
        quoteVaultDeltaUsd,
      },
      t22: {
        allHopAccountDeltaRaw: allHopDeltaRaw.toString(),
        observedWithheldRaw: observedWithheldRaw.toString(),
        observedWithheldUi: ui(observedWithheldRaw, 6),
        estimatedFromVaultMoveRaw: estimatedT22Raw.toString(),
        estimatedFromVaultMoveUi: ui(estimatedT22Raw, 6),
      },
      poolVaultDeltas: vaultDeltas,
      relevantTokenDeltas: deltas.filter((delta) => delta.mint === args.hopMint || delta.mint === pool.quoteMint),
    });
  }

  const externalEvents = events.filter((event) => event.flowClass === "EXTERNAL_FLOW_CANDIDATE");
  const affiliatedEvents = events.filter((event) => event.flowClass === "AFFILIATED_FLOW_REJECTED");
  const externalQuoteInUsd = externalEvents.reduce((sum, event) => {
    const value = event.vaultDeltaSummary.quoteVaultDeltaUsd;
    return sum + (value && value > 0 ? value : 0);
  }, 0);
  const externalQuoteOutUsd = externalEvents.reduce((sum, event) => {
    const value = event.vaultDeltaSummary.quoteVaultDeltaUsd;
    return sum + (value && value < 0 ? Math.abs(value) : 0);
  }, 0);
  const externalQuoteNetUsd = externalEvents.reduce((sum, event) => {
    const value = event.vaultDeltaSummary.quoteVaultDeltaUsd;
    return sum + (value ?? 0);
  }, 0);
  const externalHopVaultInUi = externalEvents.reduce((sum, event) => {
    const value = event.vaultDeltaSummary.hopVaultDeltaUi;
    return sum + (value > 0 ? value : 0);
  }, 0);
  const externalHopVaultOutUi = externalEvents.reduce((sum, event) => {
    const value = event.vaultDeltaSummary.hopVaultDeltaUi;
    return sum + (value < 0 ? Math.abs(value) : 0);
  }, 0);
  const externalHopVaultNetUi = externalEvents.reduce((sum, event) => sum + event.vaultDeltaSummary.hopVaultDeltaUi, 0);
  const externalT22Ui = externalEvents.reduce((sum, event) => sum + event.t22.estimatedFromVaultMoveUi, 0);
  const affiliatedQuoteInUsd = affiliatedEvents.reduce((sum, event) => {
    const value = event.vaultDeltaSummary.quoteVaultDeltaUsd;
    return sum + (value && value > 0 ? value : 0);
  }, 0);
  const affiliatedQuoteOutUsd = affiliatedEvents.reduce((sum, event) => {
    const value = event.vaultDeltaSummary.quoteVaultDeltaUsd;
    return sum + (value && value < 0 ? Math.abs(value) : 0);
  }, 0);
  const latestExternalEvent = externalEvents
    .slice()
    .sort((a, b) => (b.blockTime ?? 0) - (a.blockTime ?? 0))[0] ?? null;

  return {
    ...pool,
    signaturesScanned: signatures.length,
    eventsClassified: events.length,
    externalEvents: externalEvents.length,
    affiliatedEvents: affiliatedEvents.length,
    externalQuoteInUsd,
    externalQuoteOutUsd,
    externalQuoteNetUsd,
    externalHopVaultInUi,
    externalHopVaultOutUi,
    externalHopVaultNetUi,
    affiliatedQuoteInUsd,
    affiliatedQuoteOutUsd,
    externalEstimatedT22HopUi: externalT22Ui,
    latestExternalEvent: latestExternalEvent ? {
      signature: latestExternalEvent.signature,
      blockTime: latestExternalEvent.blockTime,
      quoteVaultDeltaUsd: latestExternalEvent.vaultDeltaSummary.quoteVaultDeltaUsd,
      hopVaultDeltaUi: latestExternalEvent.vaultDeltaSummary.hopVaultDeltaUi,
    } : null,
    events,
  };
}

async function main() {
  const config = loadConfig();
  assertNoForbiddenConfigured(config);

  const connection = new Connection(config.rpcUrl, "confirmed");
  const hopMint = config.hopMint.toBase58();
  const pools = readPools();
  const limit = Math.max(1, Math.floor(num("HOP_FLOW_LIMIT_PER_POOL", 25)));
  const lookbackHours = Math.max(0.01, num("HOP_FLOW_LOOKBACK_HOURS", 24));

  const affiliatedWallets = new Set([
    ...FORBIDDEN_WALLETS,
    ...csv("OWNED_WALLETS"),
    ...csv("AFFILIATED_WALLETS"),
    config.crank?.toBase58(),
    config.treasury?.toBase58(),
    config.withdrawAuthority?.toBase58(),
  ].filter((value): value is string => Boolean(value)));

  const [hopFee, lpSnapshots] = await Promise.all([
    activeHopFee(connection, hopMint),
    Promise.all(pools.map((pool) => lpSnapshot(connection, pool, affiliatedWallets))),
  ]);

  const quotePriceByMint = new Map<string, number | null>();
  for (const pool of pools) {
    if (!quotePriceByMint.has(pool.quoteMint)) {
      const decimals = pool.quoteMint === SOL_MINT ? 9 : 6;
      quotePriceByMint.set(pool.quoteMint, await quoteUsdPrice(pool.quoteMint, decimals));
    }
  }

  const poolReports = [];
  for (const pool of pools) {
    poolReports.push(await inspectPool(connection, pool, {
      hopMint,
      limit,
      lookbackMs: lookbackHours * 60 * 60 * 1000,
      affiliatedWallets,
      activeHopFeeBps: hopFee?.activeBps ?? null,
      quoteUsdPrice: quotePriceByMint.get(pool.quoteMint) ?? null,
    }));
  }

  const externalEvents = poolReports.reduce((sum, pool) => sum + pool.externalEvents, 0);
  const affiliatedEvents = poolReports.reduce((sum, pool) => sum + pool.affiliatedEvents, 0);
  const externalQuoteInUsd = poolReports.reduce((sum, pool) => sum + pool.externalQuoteInUsd, 0);
  const externalQuoteOutUsd = poolReports.reduce((sum, pool) => sum + pool.externalQuoteOutUsd, 0);
  const externalQuoteNetUsd = poolReports.reduce((sum, pool) => sum + pool.externalQuoteNetUsd, 0);
  const externalHopVaultInUi = poolReports.reduce((sum, pool) => sum + pool.externalHopVaultInUi, 0);
  const externalHopVaultOutUi = poolReports.reduce((sum, pool) => sum + pool.externalHopVaultOutUi, 0);
  const externalHopVaultNetUi = poolReports.reduce((sum, pool) => sum + pool.externalHopVaultNetUi, 0);
  const externalEstimatedT22HopUi = poolReports.reduce((sum, pool) => sum + pool.externalEstimatedT22HopUi, 0);
  const activePoolsWithExternalFlow = poolReports.filter((pool) => pool.externalEvents > 0).map((pool) => pool.id);
  const missingSecondVenue = pools.length < 2;

  const verdict = externalQuoteInUsd > 0
    ? "HOP_EXTERNAL_FLOW_DETECTED_READ_ONLY"
    : externalEvents > 0
      ? "HOP_EXTERNAL_SIGNERS_NO_QUOTE_INFLOW_READ_ONLY"
      : affiliatedEvents > 0
        ? "HOP_ONLY_AFFILIATED_FLOW_READ_ONLY"
        : "HOP_EXTERNAL_FLOW_NOT_DETECTED_READ_ONLY";

  const receipt = {
    verdict,
    generatedAt: new Date().toISOString(),
    readOnly: true,
    noSend: true,
    liveIntentIgnored: {
      dryRun: config.dryRun,
      allowLive: config.allowLive,
      liveTxApproved: process.env.LIVE_TX_APPROVED === "true",
      note: "hop-external-flow-watch only reads confirmed transactions",
    },
    input: {
      hopMint,
      poolCount: pools.length,
      limitPerPool: limit,
      lookbackHours,
      affiliatedWallets: Array.from(affiliatedWallets),
      poolConfigSource: process.env.HOP_FLOW_POOLS_JSON ? "HOP_FLOW_POOLS_JSON" : "default_pool_a_only",
    },
    hopTransferFee: hopFee,
    quoteUsdPrices: Object.fromEntries(quotePriceByMint),
    lpSnapshots,
    summary: {
      externalEvents,
      affiliatedEvents,
      externalQuoteInUsd,
      externalQuoteOutUsd,
      externalQuoteNetUsd,
      externalHopVaultInUi,
      externalHopVaultOutUi,
      externalHopVaultNetUi,
      externalEstimatedT22HopUi,
      activePoolsWithExternalFlow,
      missingSecondVenue,
    },
    poolReports,
    cashRule: "External signer flow is only a candidate. CashRelay still requires exact owned SOL/USDC after > before after harvesting, LP fee collect/remove, and settlement costs.",
    next: missingSecondVenue
      ? "Add more HOP venues to HOP_FLOW_POOLS_JSON after creating them; one pool cannot prove two-venue arb flow."
      : externalQuoteInUsd > 0
        ? "Run exact collect/settle simulation for external-flow events and feed SOL/USDC post-balance proof to CashRelay."
        : "Wait for external flow or seed different quote pairs; affiliated/self flow remains rejected as profit.",
  };

  const out = writeReceipt(OUT_RECEIPT, receipt);
  console.log(`${verdict} pools=${pools.length} externalEvents=${externalEvents} externalQuoteInUsd=${externalQuoteInUsd.toFixed(6)} receipt=${out}`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
