import fs from "node:fs";
import { Connection } from "@solana/web3.js";
import { loadConfig } from "../config.js";
import { writeReceipt } from "../utils/receipt.js";
import { assertNoForbiddenConfigured } from "../utils/safety.js";

const OUT_RECEIPT = "CSDM-IX7-SOURCE-LATEST.json";
const DEFAULT_PRE = "receipts/CSDM-IX7-PRELIVE-SNAPSHOT-LATEST.json";
const DEFAULT_POST = "receipts/CSDM-IX7-POSTLIVE-SNAPSHOT-LATEST.json";
const DEFAULT_LIVE_SIG = "";

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

function stringField(value: unknown): string {
  if (typeof value !== "string") throw new Error("missing string field");
  return value;
}

function optionalString(value: unknown): string | null {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : null;
}

function numberField(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function tokenAccountDelta(pre: AnyRecord, post: AnyRecord, name: string) {
  const preAccount = record(record(pre.accounts)[name]);
  const postAccount = record(record(post.accounts)[name]);
  const beforeRaw = optionalString(preAccount.amountRaw);
  const afterRaw = optionalString(postAccount.amountRaw);
  const decimals = numberField(postAccount.decimals, numberField(preAccount.decimals, NaN));
  if (beforeRaw == null || afterRaw == null || !Number.isInteger(decimals)) return null;
  const deltaRaw = BigInt(afterRaw) - BigInt(beforeRaw);
  return {
    name,
    address: optionalString(postAccount.address) ?? optionalString(preAccount.address),
    beforeRaw,
    afterRaw,
    deltaRaw: deltaRaw.toString(),
    decimals
  };
}

function rawDeltaToUsd(deltaRaw: string, decimals: number, priceUsd: number): number {
  return Number(BigInt(deltaRaw)) / (10 ** decimals) * priceUsd;
}

async function main(): Promise<void> {
  const config = loadConfig();
  assertNoForbiddenConfigured(config);

  const prePath = strEnv("CSDM_IX7_PRELIVE_SNAPSHOT", DEFAULT_PRE);
  const postPath = strEnv("CSDM_IX7_POSTLIVE_SNAPSHOT", DEFAULT_POST);
  const pre = readJson(prePath);
  const post = readJson(postPath);
  const signature = strEnv(
    "CSDM_IX7_LIVE_SIGNATURE",
    optionalString(post.liveAttemptSignature) ?? DEFAULT_LIVE_SIG
  );
  const preBacking = record(record(pre.accounts).csdmBackingWsol);
  const postBacking = record(record(post.accounts).csdmBackingWsol);
  const simReceipt = readJson("receipts/CSDM-IX7-SIM-LATEST.json");
  const sim = record(simReceipt.simulation);

  const connection = new Connection(config.rpcUrl, "confirmed");
  const tx = signature === ""
    ? null
    : await connection.getTransaction(signature, {
      commitment: "confirmed",
      maxSupportedTransactionVersion: 0
    });
  const txErr = tx ? tx.meta?.err ?? null : { missingTransaction: true };
  const feeLamports = BigInt(tx?.meta?.fee ?? 0);
  const solPriceUsd = config.solPriceUsd ?? numberField(sim.marketPriceUsd, 0);
  const costsUsd = solPriceUsd > 0 ? Number(feeLamports) / 1_000_000_000 * solPriceUsd : 0;

  const beforeRaw = stringField(preBacking.amountRaw);
  const afterRaw = stringField(postBacking.amountRaw);
  const before = BigInt(beforeRaw);
  const after = BigInt(afterRaw);
  const deltaRaw = after - before;
  const txSucceeded = tx != null && tx.meta?.err == null;
  const backingCashDeltaUsd = solPriceUsd > 0 ? Number(deltaRaw) / 1_000_000_000 * solPriceUsd : 0;
  const poolSolDelta = tokenAccountDelta(pre, post, "pool1SolVault");
  const poolUsdcDelta = tokenAccountDelta(pre, post, "pool1UsdcVault");
  const poolSolDeltaUsd = poolSolDelta != null && solPriceUsd > 0
    ? rawDeltaToUsd(poolSolDelta.deltaRaw, poolSolDelta.decimals, solPriceUsd)
    : null;
  const poolUsdcDeltaUsd = poolUsdcDelta != null
    ? rawDeltaToUsd(poolUsdcDelta.deltaRaw, poolUsdcDelta.decimals, 1)
    : null;
  const ownedPoolNetUsd = (poolSolDeltaUsd ?? 0) + (poolUsdcDeltaUsd ?? 0);
  const inventoryDrawUsd = ownedPoolNetUsd < 0 ? Math.abs(ownedPoolNetUsd) : 0;
  const netCashUsd = backingCashDeltaUsd - costsUsd - inventoryDrawUsd;

  const rejectionReasons = [
    signature !== "" ? null : "CSDM_IX7_LIVE_SIGNATURE or post snapshot liveAttemptSignature is required",
    tx ? null : "live transaction not found",
    txSucceeded ? null : "live transaction failed",
    deltaRaw > 0n ? null : "CSDM backing did not increase",
    solPriceUsd > 0 ? null : "SOL price missing for cost math"
  ].filter((value): value is string => value !== null);

  const receipt = {
    verdict: rejectionReasons.length === 0
      ? "CSDM_IX7_SOURCE_READY_FOR_CASH_RELAY"
      : "CSDM_IX7_SOURCE_BLOCKED",
    generatedAt: new Date().toISOString(),
    noSend: true,
    sourceClass: "authority_exclusive_actuator",
    sourceName: "CSDM ix7 flash_lend_backing via ENCHANCEDBLOCK 0x0A",
    payerClass: "external_protocol",
    asset: "SOL",
    beforeRaw,
    afterRaw,
    decimals: 9,
    costsUsd,
    liabilitiesUsd: 0,
    inventoryDrawUsd,
    simErr: txSucceeded ? null : txErr,
    liveAttempt: {
      signature,
      slot: tx?.slot ?? null,
      txErr,
      feeLamports: feeLamports.toString(),
      logs: tx?.meta?.logMessages ?? null
    },
    cashDelta: {
      beforeRaw,
      afterRaw,
      deltaRaw: deltaRaw.toString(),
      solPriceUsd,
      cashDeltaUsd: backingCashDeltaUsd,
      totalCostsUsd: costsUsd + inventoryDrawUsd,
      inventoryDrawUsd,
      netCashUsd
    },
    supportingVaultDeltas: {
      note: "Owned pool vaults are included to catch hidden inventory draw; only CSDM backing delta is counted as cashDeltaUsd.",
      poolSolDelta,
      poolSolDeltaUsd,
      poolUsdcDelta,
      poolUsdcDeltaUsd,
      ownedPoolNetUsd,
      systemNetUsdBeforeTxFee: backingCashDeltaUsd + ownedPoolNetUsd,
      systemNetUsdAfterTxFee: backingCashDeltaUsd + ownedPoolNetUsd - costsUsd
    },
    preSnapshotPath: prePath,
    postSnapshotPath: postPath,
    rejectionReasons,
    nextRequiredExactBuild: rejectionReasons.length === 0
      ? [
        "Run RedemptionCashRelay with this source receipt.",
        "If netCashUsd is below MIN_NET_USD, scale minRepayDelta or lower threshold only with explicit policy."
      ]
      : [
        "Fix live failure, rerun strict simulation, create a new approval packet, then retry live only after explicit approval."
      ]
  };

  const file = writeReceipt(OUT_RECEIPT, receipt);
  console.log(JSON.stringify({
    verdict: receipt.verdict,
    receipt: file,
    signature,
    beforeRaw,
    afterRaw,
    deltaRaw: deltaRaw.toString(),
    txErr,
    costsUsd,
    rejectionReasons
  }, null, 2));

  if (rejectionReasons.length > 0) process.exitCode = 1;
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
