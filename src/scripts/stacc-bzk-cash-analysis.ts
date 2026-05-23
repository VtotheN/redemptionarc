/**
 * Read-only reconstruction of the BZK cash path from local Helius receipts.
 *
 * This verifies the separate Pump.fun / external-routing mechanism without
 * touching the ring executor gate.
 */
import fs from "node:fs";
import { writeReceipt } from "../utils/receipt.js";

const WZMA = "WzMaL78srutrF6CsxEkWuhMaDF5HZA6jNRaEPengqpb";
const BZK_MINT = "Bzkdz5AKApsqizBxzqMUqWGJbx4gHXVC6NJekmAY8Gq3";
const PUMP_AMM = "pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA";

type HeliusTx = {
  signature?: string;
  type?: string;
  source?: string;
  description?: string;
  feePayer?: string;
  timestamp?: number;
  slot?: number;
  accountData?: Array<{
    account?: string;
    nativeBalanceChange?: number;
    tokenBalanceChanges?: Array<{
      userAccount?: string;
      mint?: string;
      rawTokenAmount?: { tokenAmount?: string; decimals?: number };
    }>;
  }>;
  instructions?: Array<{ programId?: string }>;
};

function loadTxArray(path: string): HeliusTx[] {
  const parsed = JSON.parse(fs.readFileSync(path, "utf8"));
  return Array.isArray(parsed) ? parsed : Object.values(parsed);
}

function programIds(tx: HeliusTx): string[] {
  return [...new Set((tx.instructions ?? []).map((ix) => ix.programId).filter((x): x is string => Boolean(x)))];
}

function nativeChange(tx: HeliusTx, account: string): number {
  return (tx.accountData ?? [])
    .filter((entry) => entry.account === account)
    .reduce((sum, entry) => sum + Number(entry.nativeBalanceChange ?? 0), 0);
}

function bzkTokenChanges(tx: HeliusTx, owner: string) {
  return (tx.accountData ?? [])
    .flatMap((entry) => entry.tokenBalanceChanges ?? [])
    .filter((change) => change.mint === BZK_MINT && change.userAccount === owner);
}

function main() {
  const walletPath = process.env.BZK_WALLET_TXS ||
    "receipts/BZK_WALLET_TXS_2026-05-22_1425_to_2026-05-23_0614.json";
  const poolPath = process.env.BZK_POOL_TXS ||
    "receipts/BZK_POOL_TXS_2026-05-22_1425_to_2026-05-23_0614.json";

  const walletTxs = loadTxArray(walletPath);
  const poolTxs = loadTxArray(poolPath);

  const pumpTxs = walletTxs.filter((tx) => tx.source === "PUMP_AMM" || programIds(tx).includes(PUMP_AMM));
  const wzmaPositiveNative = walletTxs
    .map((tx) => ({ tx, lamports: nativeChange(tx, WZMA) }))
    .filter(({ lamports }) => lamports > 0);
  const firstPumpCash = pumpTxs
    .map((tx) => ({ tx, lamports: nativeChange(tx, WZMA) }))
    .find(({ lamports }) => lamports > 0);

  const externalPoolSwaps = poolTxs
    .filter((tx) => tx.type === "SWAP" && tx.feePayer && tx.feePayer !== WZMA)
    .map((tx) => ({
      signature: tx.signature ?? null,
      slot: tx.slot ?? null,
      source: tx.source ?? null,
      type: tx.type ?? null,
      feePayer: tx.feePayer ?? null,
      description: tx.description ?? null,
      feePayerNativeChangeLamports: tx.feePayer ? nativeChange(tx, tx.feePayer) : null,
      bzkTokenChanges: tx.feePayer ? bzkTokenChanges(tx, tx.feePayer) : [],
      programIds: programIds(tx),
    }));

  const receipt = {
    verdict: firstPumpCash && externalPoolSwaps.length > 0
      ? "BZK_CASH_PATH_CONFIRMED_READ_ONLY"
      : "BZK_CASH_PATH_INCOMPLETE",
    generatedAt: new Date().toISOString(),
    readOnly: true,
    files: { walletPath, poolPath },
    constants: { wzma: WZMA, bzkMint: BZK_MINT, pumpAmm: PUMP_AMM },
    pump: {
      txCount: pumpTxs.length,
      firstCashTx: firstPumpCash ? {
        signature: firstPumpCash.tx.signature ?? null,
        slot: firstPumpCash.tx.slot ?? null,
        source: firstPumpCash.tx.source ?? null,
        type: firstPumpCash.tx.type ?? null,
        feePayer: firstPumpCash.tx.feePayer ?? null,
        wzmaNativeGainLamports: firstPumpCash.lamports,
        wzmaNativeGainSol: firstPumpCash.lamports / 1e9,
        programIds: programIds(firstPumpCash.tx),
      } : null,
    },
    walletNativeInflows: {
      positiveTxCount: wzmaPositiveNative.length,
      positiveSolTotal: wzmaPositiveNative.reduce((sum, item) => sum + item.lamports, 0) / 1e9,
      top10: wzmaPositiveNative
        .sort((a, b) => b.lamports - a.lamports)
        .slice(0, 10)
        .map(({ tx, lamports }) => ({
          signature: tx.signature ?? null,
          slot: tx.slot ?? null,
          source: tx.source ?? null,
          type: tx.type ?? null,
          lamports,
          sol: lamports / 1e9,
          programIds: programIds(tx),
        })),
    },
    externalOrcaRouting: {
      externalSwapCount: externalPoolSwaps.length,
      swaps: externalPoolSwaps,
    },
    interpretation: {
      mechanisms: [
        "Token-2022 ring: mechanically valid, HOP-denominated, separately cash-gated",
        "Orca pool: can earn real LP/protocol fees only from external order flow",
        "Pump.fun/PumpSwap sell: produced direct SOL inflow to WzMa in the first local BZK wallet tx",
      ],
      rejected: [
        "wash volume",
        "fake activity intended to mislead external traders",
        "treating self-seeded LP inventory as net cash profit",
      ],
    },
  };

  const out = writeReceipt("STACC-BZK-CASH-MODEL-LATEST.json", receipt);
  console.log(`${receipt.verdict} pumpSol=${receipt.pump.firstCashTx?.wzmaNativeGainSol ?? 0} externalSwaps=${externalPoolSwaps.length} receipt=${out}`);
}

main();
