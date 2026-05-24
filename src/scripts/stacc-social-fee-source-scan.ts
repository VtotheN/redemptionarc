import "dotenv/config";
import dotenv from "dotenv";
import fs from "node:fs";
import { Connection, PublicKey } from "@solana/web3.js";
import { loadConfig } from "../config.js";
import { assertNoForbiddenConfigured } from "../utils/safety.js";
import { publicKeyFromKeypairFile } from "../utils/keypair.js";
import { writeReceipt } from "../utils/receipt.js";

if (process.env.ENV_PATH) {
  dotenv.config({ path: process.env.ENV_PATH, override: true });
}

const OUT_RECEIPT = "STACC-SOCIAL-FEE-SOURCE-LATEST.json";
const WZMA = "WzMaL78srutrF6CsxEkWuhMaDF5HZA6jNRaEPengqpb";
const BZK_MINT = "Bzkdz5AKApsqizBxzqMUqWGJbx4gHXVC6NJekmAY8Gq3";
const SOCIAL_FEE_PROGRAM = "pfeeUxB6jkeY1Hxd7CsFCAjcbHA9rWtchMGdZ6VojVZ";
const CLAIM_LOG = "ClaimSocialFeePdaV2";
const HISTORICAL_FILES = [
  "receipts/BZK_WALLET_TXS_2026-05-22_1425_to_2026-05-23_0614.json",
  "receipts/BZK_POOL_TXS_2026-05-22_1425_to_2026-05-23_0614.json",
];

type AnyRecord = Record<string, unknown>;

function numberEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw == null || raw.trim() === "") return fallback;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) throw new Error(`Invalid ${name}=${raw}`);
  return parsed;
}

function optionalNumberEnv(name: string): number | null {
  const raw = process.env[name];
  if (raw == null || raw.trim() === "") return null;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) throw new Error(`Invalid ${name}=${raw}`);
  return parsed;
}

function envCsv(name: string): string[] {
  return (process.env[name] ?? "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
}

function record(value: unknown): AnyRecord {
  return typeof value === "object" && value !== null ? value as AnyRecord : {};
}

function array(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function string(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function number(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function includesDeep(value: unknown, needle: string): boolean {
  if (typeof value === "string") return value.includes(needle);
  if (Array.isArray(value)) return value.some((entry) => includesDeep(entry, needle));
  if (typeof value === "object" && value !== null) {
    return Object.values(value).some((entry) => includesDeep(entry, needle));
  }
  return false;
}

function readHistoricalRows() {
  const txs: AnyRecord[] = [];
  for (const file of HISTORICAL_FILES) {
    if (!fs.existsSync(file)) continue;
    const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as unknown;
    const rows = Array.isArray(parsed) ? parsed : array(record(parsed).transactions);
    for (const tx of rows.map(record)) txs.push({ ...tx, sourceFile: file });
  }

  const unique = new Map<string, AnyRecord>();
  for (const tx of txs) {
    const signature = string(tx.signature);
    if (signature && !unique.has(signature)) unique.set(signature, tx);
  }

  return [...unique.values()];
}

function historicalNativeDelta(tx: AnyRecord, owner: string): number {
  let delta = 0;
  for (const transfer of array(tx.nativeTransfers).map(record)) {
    const amount = number(transfer.amount) ?? 0;
    if (transfer.fromUserAccount === owner) delta -= amount;
    if (transfer.toUserAccount === owner) delta += amount;
  }
  return delta;
}

function signerPubkeysFromEnv(): Array<{ path: string; pubkey: string }> {
  const paths = [
    ...envCsv("SOCIAL_FEE_KEYPAIR_PATHS"),
    ...envCsv("OWNED_FEE_KEYPAIR_PATHS"),
    ...envCsv("KEEPER_AUTHORITY_KEYPAIR_PATHS"),
    process.env.CRANK_KEYPAIR_PATH,
    process.env.TREASURY_KEYPAIR_PATH,
  ].filter((value): value is string => Boolean(value));

  const out: Array<{ path: string; pubkey: string }> = [];
  const seen = new Set<string>();
  for (const file of paths) {
    if (seen.has(file) || !fs.existsSync(file)) continue;
    seen.add(file);
    try {
      out.push({ path: file, pubkey: publicKeyFromKeypairFile(file).toBase58() });
    } catch {
      // Ignore malformed keypair-like files without printing contents.
    }
  }
  return out;
}

async function jupiterSolUsdc(): Promise<number | null> {
  try {
    const url = "https://lite-api.jup.ag/swap/v1/quote?inputMint=So11111111111111111111111111111111111111112&outputMint=EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v&amount=1000000000&slippageBps=10";
    const response = await fetch(url, { headers: { accept: "application/json" } });
    if (!response.ok) return null;
    const json = await response.json() as { outAmount?: string };
    return json.outAmount ? Number(json.outAmount) / 1e6 : null;
  } catch {
    return null;
  }
}

async function recentClaimRows(connection: Connection, owner: string, limit: number) {
  const ownerKey = new PublicKey(owner);
  const signatures = await connection.getSignaturesForAddress(ownerKey, { limit }, "confirmed");
  const rows = [];

  for (const sig of signatures) {
    const tx = await connection.getTransaction(sig.signature, {
      commitment: "confirmed",
      maxSupportedTransactionVersion: 0,
    }).catch(() => null);
    if (!tx) continue;

    const staticKeys = tx.transaction.message.staticAccountKeys.map((key) => key.toBase58());
    const loadedWritable = tx.meta?.loadedAddresses?.writable.map((key) => key.toBase58()) ?? [];
    const loadedReadonly = tx.meta?.loadedAddresses?.readonly.map((key) => key.toBase58()) ?? [];
    const accountKeys = [...staticKeys, ...loadedWritable, ...loadedReadonly];
    const instructions = (tx.transaction.message as unknown as { compiledInstructions?: Array<{ programIdIndex: number }> }).compiledInstructions ?? [];
    const programIds = [...new Set(instructions
      .map((ix) => accountKeys[ix.programIdIndex])
      .filter((value): value is string => typeof value === "string"))];
    const socialFeeInstructions = instructions
      .map((ix, index) => {
        const keyedIx = ix as { programIdIndex: number; accountKeyIndexes?: Iterable<number>; accounts?: Iterable<number>; data?: Uint8Array };
        const programId = accountKeys[keyedIx.programIdIndex];
        const accountIndexes = [...(keyedIx.accountKeyIndexes ?? keyedIx.accounts ?? [])].map(Number);
        return {
          index,
          programId,
          accountIndexes,
          accounts: accountIndexes.map((accountIndex) => accountKeys[accountIndex] ?? null),
          dataBase64: keyedIx.data ? Buffer.from(keyedIx.data).toString("base64") : "",
          dataHex: keyedIx.data ? Buffer.from(keyedIx.data).toString("hex") : "",
        };
      })
      .filter((ix) => ix.programId === SOCIAL_FEE_PROGRAM);
    const logs = tx.meta?.logMessages ?? [];
    const ownerIndex = staticKeys.findIndex((key) => key === owner);
    const beforeRaw = ownerIndex >= 0 ? tx.meta?.preBalances[ownerIndex] ?? null : null;
    const afterRaw = ownerIndex >= 0 ? tx.meta?.postBalances[ownerIndex] ?? null : null;
    const nativeDeltaLamports = beforeRaw != null && afterRaw != null ? afterRaw - beforeRaw : null;
    const claimLike = programIds.includes(SOCIAL_FEE_PROGRAM) || logs.some((line) => line.includes(CLAIM_LOG));

    rows.push({
      signature: sig.signature,
      slot: tx.slot,
      blockTime: sig.blockTime ?? null,
      err: tx.meta?.err ?? sig.err ?? null,
      feeLamports: tx.meta?.fee ?? null,
      beforeRaw: beforeRaw == null ? null : beforeRaw.toString(),
      afterRaw: afterRaw == null ? null : afterRaw.toString(),
      nativeDeltaLamports,
      nativeDeltaSol: nativeDeltaLamports == null ? null : nativeDeltaLamports / 1_000_000_000,
      programIds,
      socialFeeInstructions,
      claimLike,
      bzkRelated: accountKeys.includes(BZK_MINT),
      logHints: logs
        .filter((line) => line.includes(CLAIM_LOG) || line.includes("No fees available to claim"))
        .slice(0, 6),
    });
  }

  return rows;
}

async function main(): Promise<void> {
  const config = loadConfig();
  assertNoForbiddenConfigured(config);
  const connection = new Connection(config.rpcUrl, "confirmed");
  const solPriceUsd = config.solPriceUsd ?? optionalNumberEnv("SOCIAL_FEE_SOL_PRICE_USD") ?? await jupiterSolUsdc() ?? 0;
  const minNetUsd = numberEnv("MIN_NET_USD", config.minNetUsd);
  const recentLimit = numberEnv("SOCIAL_FEE_RECENT_TX_LIMIT", 50);
  const localSigners = signerPubkeysFromEnv();
  const localSignerPubkeys = new Set(localSigners.map((entry) => entry.pubkey));
  const localAuthorityAvailable = localSignerPubkeys.has(WZMA);

  const recent = await recentClaimRows(connection, WZMA, recentLimit);
  const recentClaims = recent.filter((row) => row.claimLike);
  const recentPositiveClaims = recentClaims.filter((row) => (row.nativeDeltaLamports ?? 0) > 0);
  const latestPositiveClaim = recentPositiveClaims[0] ?? null;
  const recentPositiveNetSol = recentPositiveClaims.reduce((sum, row) => sum + (row.nativeDeltaSol ?? 0), 0);
  const recentPositiveNetUsd = solPriceUsd > 0 ? recentPositiveNetSol * solPriceUsd : null;

  const historical = readHistoricalRows();
  const historicalClaimRows = historical.filter((tx) => includesDeep(tx, SOCIAL_FEE_PROGRAM) || includesDeep(tx, CLAIM_LOG));
  const historicalPositiveClaimRows = historicalClaimRows
    .map((tx) => ({
      signature: string(tx.signature),
      source: string(tx.source),
      type: string(tx.type),
      timestamp: number(tx.timestamp),
      sol: historicalNativeDelta(tx, WZMA) / 1_000_000_000,
      bzkRelated: includesDeep(tx, BZK_MINT),
    }))
    .filter((row) => row.sol > 0);

  const latestGrossClaimSol = latestPositiveClaim
    ? ((latestPositiveClaim.nativeDeltaLamports ?? 0) + (latestPositiveClaim.feeLamports ?? 0)) / 1_000_000_000
    : 0;
  const latestFeeSol = latestPositiveClaim ? (latestPositiveClaim.feeLamports ?? 0) / 1_000_000_000 : 0;
  const latestNetSol = latestPositiveClaim?.nativeDeltaSol ?? 0;

  const rejectionReasons = [
    latestPositiveClaim ? null : "no positive recent social-fee claim observed",
    localAuthorityAvailable ? null : "WzMa social-fee authority keypair is not locally configured",
    latestPositiveClaim?.bzkRelated ? null : "latest positive social-fee claim is not directly BZK-account linked",
    recentPositiveNetUsd == null ? "SOL price unavailable; USD gate recorded but not trusted" : null,
    recentPositiveNetUsd != null && recentPositiveNetUsd >= minNetUsd ? null : `recent positive social-fee net ${recentPositiveNetUsd?.toFixed(6) ?? "unknown"} USD below MIN_NET_USD ${minNetUsd}`,
    "no live path: current unclaimed amount and exact claim accounts are not simulated",
  ].filter((value): value is string => value !== null);

  const receipt = {
    verdict: latestPositiveClaim
      ? "STACC_SOCIAL_FEE_SOURCE_OBSERVED_NO_LIVE"
      : "STACC_SOCIAL_FEE_SOURCE_MONITORING_NO_LIVE",
    generatedAt: new Date().toISOString(),
    noSend: true,
    dryRun: true,
    allowLiveIgnored: process.env.ALLOW_LIVE === "true",
    liveTxApprovedIgnored: process.env.LIVE_TX_APPROVED === "true",
    sourceClass: "authority_exclusive_protocol_fee_claim",
    sourceName: "pump_social_fee_claim_pda_v2",
    payerClass: "external_protocol",
    authority: WZMA,
    authorityLocalSignerAvailable: localAuthorityAvailable,
    localSignerPubkeys: localSigners.map((entry) => entry.pubkey),
    asset: "SOL",
    decimals: 9,
    solPriceUsd,
    minNetUsd,
    latestPositiveClaim: latestPositiveClaim ? {
      signature: latestPositiveClaim.signature,
      slot: latestPositiveClaim.slot,
      blockTime: latestPositiveClaim.blockTime,
      beforeRaw: latestPositiveClaim.beforeRaw,
      afterRaw: latestPositiveClaim.afterRaw,
      netDeltaLamports: latestPositiveClaim.nativeDeltaLamports?.toString() ?? null,
      netDeltaSol: latestNetSol,
      grossClaimSol: latestGrossClaimSol,
      feeSol: latestFeeSol,
      netCashUsd: solPriceUsd > 0 ? latestNetSol * solPriceUsd : null,
      grossClaimUsd: solPriceUsd > 0 ? latestGrossClaimSol * solPriceUsd : null,
      feeUsd: solPriceUsd > 0 ? latestFeeSol * solPriceUsd : null,
      bzkRelated: latestPositiveClaim.bzkRelated,
      programIds: latestPositiveClaim.programIds,
      socialFeeInstructions: latestPositiveClaim.socialFeeInstructions,
      logHints: latestPositiveClaim.logHints,
    } : null,
    recent: {
      scannedTxs: recent.length,
      claimLikeCount: recentClaims.length,
      positiveClaimCount: recentPositiveClaims.length,
      positiveNetSol: recentPositiveNetSol,
      positiveNetUsd: recentPositiveNetUsd,
      claimSamples: recentClaims.slice(0, 8).map((row) => ({
        signature: row.signature,
        nativeDeltaSol: row.nativeDeltaSol,
        bzkRelated: row.bzkRelated,
        logHints: row.logHints,
      })),
    },
    historicalBzkWindow: {
      sourceFiles: HISTORICAL_FILES.filter((file) => fs.existsSync(file)),
      txCount: historical.length,
      claimLikeCount: historicalClaimRows.length,
      positiveClaimCount: historicalPositiveClaimRows.length,
      positiveClaimNetSol: historicalPositiveClaimRows.reduce((sum, row) => sum + row.sol, 0),
      positiveClaimSamples: historicalPositiveClaimRows.slice(0, 10),
    },
    cashRelayCompatibility: {
      pass: false,
      reason: "Observed real SOL settlement, but not yet a fresh exact executable source receipt for this local signer set.",
      wouldNeed: [
        "Configure a local WzMa signer only if Velon owns/approves that authority.",
        "Derive current social-fee claim PDA/accounts before execution.",
        "Simulate exact claim transaction and prove afterRaw > beforeRaw after costs.",
        "Then feed the exact source receipt into RedemptionCashRelay before live approval.",
      ],
    },
    rejectionReasons,
  };

  const out = writeReceipt(OUT_RECEIPT, receipt);
  console.log(`${receipt.verdict} recentPositiveClaims=${recentPositiveClaims.length} netSol=${recentPositiveNetSol.toFixed(9)} localAuthority=${localAuthorityAvailable} receipt=${out}`);
  if (rejectionReasons.length > 0) console.log(`blocked=${rejectionReasons.join(" | ")}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
