/**
 * flash-deep-vol-orca-v2.ts — Multi-round-trip flash cycle. RT_COUNT swap pairs per TX.
 *
 * IX layout (N = RT_COUNT):
 *   [0]     ComputeUnitLimit
 *   [1]     ComputeUnitPrice
 *   [2]     startFlashLoan(endIndex = 7 + 2*N)
 *   [3]     lendingAccountBorrow
 *   [4]     increase_liquidity_v2
 *   [5..4+2N] N × (swap_v2 USDC→HOP, swap_v2 HOP→USDC)
 *   [5+2N]  decrease_liquidity_v2
 *   [6+2N]  lendingAccountRepay
 *   [7+2N]  endFlashLoan
 *
 * Revenue model: T22 withheld on every HOP transfer → sweep via redeem-hop-to-usdc.
 * LP fees stay in position (circular — we pay ourselves as LP+trader).
 * flashAmount = addLiqMicro + swapMicro (covers both legs, same as v1).
 *
 * Two-sim approach: sim1 measures CU, rebuilds with ceil(CU*1.1), sim2 confirms.
 *
 * ENV:
 *   RT_COUNT=1           (round-trips per TX, max 5)
 *   SOLANA_RPC_URL
 *   DRY_RUN=true
 *   ALLOW_LIVE=true
 *   ADDLIQ_USDC=700
 *   SWAP_USDC=500
 *   SLIPPAGE_BPS=100
 *   CU_PRICE=10000
 *   JITO_TIP_LAMPORTS=200000
 *   ALT_ADDRESS=EjNKyxzhMCDX63sXLNddioHNZmyyNaHUipsXR65AmwAC
 *   FORCE_T22_BPS=1
 *   SOL_PRICE_USD=150
 */

import "dotenv/config";
import fs from "node:fs";
import { createRequire } from "module";
const _require = createRequire(import.meta.url);
const _bs58 = _require("bs58") as { encode: (b: Uint8Array) => string };

import {
  Connection, Keypair, PublicKey, TransactionInstruction,
  TransactionMessage, VersionedTransaction, AddressLookupTableAccount,
  ComputeBudgetProgram, SYSVAR_INSTRUCTIONS_PUBKEY, SystemProgram,
} from "@solana/web3.js";
import {
  TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID,
  getAssociatedTokenAddressSync, getMint, getTransferFeeConfig,
} from "@solana/spl-token";
import { writeReceipt } from "../utils/receipt.js";
import { getShardConfig } from "../utils/shard.js";

// ─── Constants ────────────────────────────────────────────────────────────────

const WHIRLPOOL_PROGRAM = new PublicKey("GxRHMB9a6XE8BqGPeNb9UkJUPvbvrPoPgNTJPJJA4n8h");
const WHIRLPOOL         = new PublicKey("8aoWgf7ycbeKv6BTFCdUj4JR7Y4mXWuPZWEUhmuzN5ZL");
const TOKEN_VAULT_A     = new PublicKey("4QD4GgnjRvjETqWLT5e3x7SHtJSzs9kShUPLfyHcTu7d");
const TOKEN_VAULT_B     = new PublicKey("Qv51R47g7pMDxa3UofXaz8cNr8pwRSXaNufgnEWX8Yk");
const TICK_ARRAY_84480  = new PublicKey("be9QKj4mYB8erh6r4ZDrKxxSvSYSUNRfpTxqJUgd3jG");
const TICK_ARRAY_90112  = new PublicKey("CDMSB5e6WUgtoSLrybvYm4j58Jue3eqpzHQVLmgVkAe4");
const TICK_ARRAY_95744  = new PublicKey("MXd8HXPjcH9ZCuyr4uKKyN7GkJ5YizZQkgUndB6J8Gz");
const TICK_ARRAY_101376 = new PublicKey("2dQq4vUnzfCmmdex9ikKjF7Z7XifVsbVzoTs7d7ogaEx");
const TICK_ARRAY_107008 = new PublicKey("2BjLGkGEvB5umQjgesM5F48NGg8JVN1yHta8YZcMYann");
const ORACLE            = new PublicKey("5qhXANMqTNNzdp1N1PrMzWzSzjHTZxuLPELcmpog6bp5");
const POSITION          = new PublicKey("ErgQU48egJMNBLZeVkdjrtZrSWUQJCky3deh2B4U1YPQ");
const POSITION_TA       = new PublicKey("GgLpt3VY9vWKLnNa5Dj3FKvBn3JEDL4KTKpabCAfL54Q");
const SPL_MEMO          = new PublicKey("MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr");
const USDC_MINT         = new PublicKey("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v");
const HOP_MINT          = new PublicKey("HZF5k7h39hkysoSZ4ZfmWc55PhvW7ntVvVqdXFCyYGh3");
const MARGINFI_PROGRAM  = new PublicKey("MFv2hWf31Z9kbCa1snEPYctwafyhdvnV7FZnsebVacA");
const MARGINFI_GROUP    = new PublicKey("4qp6Fx6tnZkY5Wropq9wUYgtFxXKwE6viZxFHg3rdAG8");
const USDC_BANK         = new PublicKey("2s37akK2eyBbp8DZgCm7RtsaEz8eJP3Nxd4urLHQv7yB");
const USDC_LIQ_VAULT    = new PublicKey("7jaiZR5Sk8hdYN9MxTpczTcwbWpb5WEoxSANuUwveuat");
const MF_ACCOUNT_DEFAULT = new PublicKey("9SdjygeTAmMrgCQjBAGNAAjjYE6U35ARWcuvvxFZJHz");
const JITO_TIP_WALLET   = new PublicKey("96gYZGLnJYVFmbjzopPSU6QiEV5fGqZNyN9nmNhvrZU5");
const JITO_URL          = "https://mainnet.block-engine.jito.wtf/api/v1/bundles";

const POSITION_TICK_LOWER = 84480;
const POSITION_TICK_UPPER = 101312;
const POOL_CENTER_TICK    = 92520;
const RT_COUNT_MAX        = 5;

const IX_START           = Buffer.from([14, 131, 33, 220, 81, 186, 180, 107]);
const IX_END             = Buffer.from([105, 124, 201, 106, 153, 2, 8, 156]);
const IX_BORROW          = Buffer.from([4, 126, 116, 53, 48, 5, 212, 31]);
const IX_REPAY           = Buffer.from([79, 209, 172, 177, 222, 51, 173, 151]);
const SWAP_V2_DISC       = Buffer.from([0x2b, 0x04, 0xed, 0x0b, 0x1a, 0xc9, 0x1e, 0x62]);
const INCREASE_LIQ_DISC  = Buffer.from([0x85, 0x1d, 0x59, 0xdf, 0x45, 0xee, 0xb0, 0x0a]);
const DECREASE_LIQ_DISC  = Buffer.from([58, 127, 188, 62, 79, 82, 196, 96]);
const BANK_ORACLE_OFFSET = 610;

const Q64 = 1n << 64n;
const MIN_SQRT_PRICE = 4295048016n;
const MAX_SQRT_PRICE = 79226673515401279992447579055n;

const WP_FEE_RATE_OFFSET       = 45;
const WP_PROTO_FEE_RATE_OFFSET = 47;
const WP_LIQUIDITY_OFFSET      = 49;
const WP_SQRT_PRICE_OFFSET     = 65;
const WP_TICK_INDEX_OFFSET     = 81;

// ─── Helpers ──────────────────────────────────────────────────────────────────

function loadKeypair(p: string): Keypair {
  return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(p, "utf8")) as number[]));
}

function u64Le(n: bigint): Buffer {
  const b = Buffer.alloc(8); b.writeBigUInt64LE(n); return b;
}

function u128Le(n: bigint): Buffer {
  const b = Buffer.alloc(16);
  b.writeBigUInt64LE(n & ((1n << 64n) - 1n), 0);
  b.writeBigUInt64LE(n >> 64n, 8);
  return b;
}

function readU16LE(buf: Buffer, off: number): number { return buf.readUInt16LE(off); }
function readI32LE(buf: Buffer, off: number): number  { return buf.readInt32LE(off); }
function readU128LE(buf: Buffer, off: number): bigint {
  return buf.readBigUInt64LE(off) | (buf.readBigUInt64LE(off + 8) << 64n);
}

function tickToSqrtPriceX64(tick: number): bigint {
  const sqrtPrice = Math.pow(1.0001, tick / 2);
  const scale = 1_000_000_000n;
  return (BigInt(Math.round(sqrtPrice * Number(scale))) * Q64) / scale;
}

function liquidityFromA(amountA: bigint, sqrtP: bigint, sqrtPUpper: bigint): bigint {
  return (amountA * sqrtP * sqrtPUpper) / ((sqrtPUpper - sqrtP) * Q64);
}

function liquidityFromB(amountB: bigint, sqrtP: bigint, sqrtPLower: bigint): bigint {
  return (amountB * Q64) / (sqrtP - sqrtPLower);
}

function amountAForLiq(liq: bigint, sqrtP: bigint, sqrtPUpper: bigint): bigint {
  return (liq * (sqrtPUpper - sqrtP) * Q64) / (sqrtP * sqrtPUpper);
}

function amountBForLiq(liq: bigint, sqrtP: bigint, sqrtPLower: bigint): bigint {
  return (liq * (sqrtP - sqrtPLower)) / Q64;
}

// ─── MarginFi IX builders ─────────────────────────────────────────────────────

async function oracleForBank(conn: Connection): Promise<PublicKey> {
  const info = await conn.getAccountInfo(USDC_BANK, "confirmed");
  if (!info) throw new Error("USDC_BANK not found");
  return new PublicKey(Buffer.from(info.data).subarray(BANK_ORACLE_OFFSET, BANK_ORACLE_OFFSET + 32));
}

function startFlashIx(account: PublicKey, authority: PublicKey, endIndex: bigint): TransactionInstruction {
  return new TransactionInstruction({
    programId: MARGINFI_PROGRAM,
    keys: [
      { pubkey: account,                   isSigner: false, isWritable: true  },
      { pubkey: authority,                  isSigner: true,  isWritable: false },
      { pubkey: SYSVAR_INSTRUCTIONS_PUBKEY, isSigner: false, isWritable: false },
    ],
    data: Buffer.concat([IX_START, u64Le(endIndex)]),
  });
}

function endFlashIx(account: PublicKey, authority: PublicKey, oracle: PublicKey): TransactionInstruction {
  return new TransactionInstruction({
    programId: MARGINFI_PROGRAM,
    keys: [
      { pubkey: account,    isSigner: false, isWritable: true  },
      { pubkey: authority,  isSigner: true,  isWritable: false },
      { pubkey: USDC_BANK,  isSigner: false, isWritable: false },
      { pubkey: oracle,     isSigner: false, isWritable: false },
    ],
    data: IX_END,
  });
}

function borrowIx(account: PublicKey, authority: PublicKey, destAta: PublicKey, amount: bigint): TransactionInstruction {
  const [vaultAuth] = PublicKey.findProgramAddressSync(
    [Buffer.from("liquidity_vault_auth"), USDC_BANK.toBuffer()],
    MARGINFI_PROGRAM
  );
  return new TransactionInstruction({
    programId: MARGINFI_PROGRAM,
    keys: [
      { pubkey: MARGINFI_GROUP,    isSigner: false, isWritable: false },
      { pubkey: account,           isSigner: false, isWritable: true  },
      { pubkey: authority,         isSigner: true,  isWritable: false },
      { pubkey: USDC_BANK,         isSigner: false, isWritable: true  },
      { pubkey: destAta,           isSigner: false, isWritable: true  },
      { pubkey: vaultAuth,         isSigner: false, isWritable: false },
      { pubkey: USDC_LIQ_VAULT,    isSigner: false, isWritable: true  },
      { pubkey: TOKEN_PROGRAM_ID,  isSigner: false, isWritable: false },
    ],
    data: Buffer.concat([IX_BORROW, u64Le(amount)]),
  });
}

function repayIx(account: PublicKey, authority: PublicKey, srcAta: PublicKey, amount: bigint): TransactionInstruction {
  return new TransactionInstruction({
    programId: MARGINFI_PROGRAM,
    keys: [
      { pubkey: MARGINFI_GROUP,    isSigner: false, isWritable: false },
      { pubkey: account,           isSigner: false, isWritable: true  },
      { pubkey: authority,         isSigner: true,  isWritable: false },
      { pubkey: USDC_BANK,         isSigner: false, isWritable: true  },
      { pubkey: srcAta,            isSigner: false, isWritable: true  },
      { pubkey: USDC_LIQ_VAULT,    isSigner: false, isWritable: true  },
      { pubkey: TOKEN_PROGRAM_ID,  isSigner: false, isWritable: false },
    ],
    data: Buffer.concat([IX_REPAY, u64Le(amount), Buffer.from([0])]),
  });
}

// ─── Whirlpool IX builders ────────────────────────────────────────────────────

function swapV2Ix(args: {
  authority: PublicKey;
  ownerA: PublicKey; ownerB: PublicKey;
  ta0: PublicKey; ta1: PublicKey; ta2: PublicKey;
  amount: bigint; otherAmountThreshold: bigint;
  sqrtPriceLimit: bigint;
  amountSpecifiedIsInput: boolean; aToB: boolean;
}): TransactionInstruction {
  return new TransactionInstruction({
    programId: WHIRLPOOL_PROGRAM,
    keys: [
      { pubkey: TOKEN_PROGRAM_ID,      isSigner: false, isWritable: false },
      { pubkey: TOKEN_2022_PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: SPL_MEMO,              isSigner: false, isWritable: false },
      { pubkey: args.authority,        isSigner: true,  isWritable: false },
      { pubkey: WHIRLPOOL,             isSigner: false, isWritable: true  },
      { pubkey: USDC_MINT,             isSigner: false, isWritable: false },
      { pubkey: HOP_MINT,              isSigner: false, isWritable: true  },
      { pubkey: args.ownerA,           isSigner: false, isWritable: true  },
      { pubkey: TOKEN_VAULT_A,         isSigner: false, isWritable: true  },
      { pubkey: args.ownerB,           isSigner: false, isWritable: true  },
      { pubkey: TOKEN_VAULT_B,         isSigner: false, isWritable: true  },
      { pubkey: args.ta0,              isSigner: false, isWritable: true  },
      { pubkey: args.ta1,              isSigner: false, isWritable: true  },
      { pubkey: args.ta2,              isSigner: false, isWritable: true  },
      { pubkey: ORACLE,                isSigner: false, isWritable: true  },
    ],
    data: Buffer.concat([
      SWAP_V2_DISC,
      u64Le(args.amount),
      u64Le(args.otherAmountThreshold),
      u128Le(args.sqrtPriceLimit),
      Buffer.from([args.amountSpecifiedIsInput ? 1 : 0]),
      Buffer.from([args.aToB ? 1 : 0]),
      Buffer.from([0x00]),
    ]),
  });
}

function increaseLiqV2Ix(args: {
  authority: PublicKey; ownerA: PublicKey; ownerB: PublicKey;
  liquidityAmount: bigint; tokenMaxA: bigint; tokenMaxB: bigint;
}): TransactionInstruction {
  return new TransactionInstruction({
    programId: WHIRLPOOL_PROGRAM,
    keys: [
      { pubkey: WHIRLPOOL,             isSigner: false, isWritable: true  },
      { pubkey: TOKEN_PROGRAM_ID,      isSigner: false, isWritable: false },
      { pubkey: TOKEN_2022_PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: SPL_MEMO,              isSigner: false, isWritable: false },
      { pubkey: args.authority,        isSigner: true,  isWritable: false },
      { pubkey: POSITION,              isSigner: false, isWritable: true  },
      { pubkey: POSITION_TA,           isSigner: false, isWritable: false },
      { pubkey: USDC_MINT,             isSigner: false, isWritable: false },
      { pubkey: HOP_MINT,              isSigner: false, isWritable: false },
      { pubkey: args.ownerA,           isSigner: false, isWritable: true  },
      { pubkey: args.ownerB,           isSigner: false, isWritable: true  },
      { pubkey: TOKEN_VAULT_A,         isSigner: false, isWritable: true  },
      { pubkey: TOKEN_VAULT_B,         isSigner: false, isWritable: true  },
      { pubkey: TICK_ARRAY_84480,      isSigner: false, isWritable: true  },
      { pubkey: TICK_ARRAY_95744,      isSigner: false, isWritable: true  },
    ],
    data: Buffer.concat([
      INCREASE_LIQ_DISC,
      u128Le(args.liquidityAmount),
      u64Le(args.tokenMaxA),
      u64Le(args.tokenMaxB),
      Buffer.from([0x00]),
    ]),
  });
}

function decreaseLiqV2Ix(args: {
  authority: PublicKey; ownerA: PublicKey; ownerB: PublicKey;
  liquidityAmount: bigint; tokenMinA: bigint; tokenMinB: bigint;
}): TransactionInstruction {
  return new TransactionInstruction({
    programId: WHIRLPOOL_PROGRAM,
    keys: [
      { pubkey: WHIRLPOOL,             isSigner: false, isWritable: true  },
      { pubkey: TOKEN_PROGRAM_ID,      isSigner: false, isWritable: false },
      { pubkey: TOKEN_2022_PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: SPL_MEMO,              isSigner: false, isWritable: false },
      { pubkey: args.authority,        isSigner: true,  isWritable: false },
      { pubkey: POSITION,              isSigner: false, isWritable: true  },
      { pubkey: POSITION_TA,           isSigner: false, isWritable: false },
      { pubkey: USDC_MINT,             isSigner: false, isWritable: false },
      { pubkey: HOP_MINT,              isSigner: false, isWritable: false },
      { pubkey: args.ownerA,           isSigner: false, isWritable: true  },
      { pubkey: args.ownerB,           isSigner: false, isWritable: true  },
      { pubkey: TOKEN_VAULT_A,         isSigner: false, isWritable: true  },
      { pubkey: TOKEN_VAULT_B,         isSigner: false, isWritable: true  },
      { pubkey: TICK_ARRAY_84480,      isSigner: false, isWritable: true  },
      { pubkey: TICK_ARRAY_95744,      isSigner: false, isWritable: true  },
    ],
    data: Buffer.concat([
      DECREASE_LIQ_DISC,
      u128Le(args.liquidityAmount),
      u64Le(args.tokenMinA),
      u64Le(args.tokenMinB),
      Buffer.from([0x00]),
    ]),
  });
}

// ─── Jito ─────────────────────────────────────────────────────────────────────

async function sendJitoBundle(txB58: string): Promise<string> {
  const res = await fetch(JITO_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "sendBundle", params: [[txB58]] }),
  });
  if (!res.ok) throw new Error(`Jito ${res.status}: ${await res.text()}`);
  const data = await res.json() as { result?: string; error?: { message: string } };
  if (data.error) throw new Error(`Jito RPC: ${data.error.message}`);
  return data.result ?? "unknown";
}

// ─── TX builder helper ────────────────────────────────────────────────────────

function buildTx(
  ixs: TransactionInstruction[],
  payerKey: PublicKey,
  blockhash: string,
  altAccounts: AddressLookupTableAccount[],
): VersionedTransaction {
  const msg = new TransactionMessage({
    payerKey, recentBlockhash: blockhash, instructions: ixs,
  }).compileToV0Message(altAccounts);
  return new VersionedTransaction(msg);
}

// ─── Main ─────────────────────────────────────────────────────────────────────

export type CycleResult = {
  verdict: string;
  simOk: boolean;
  cashNetProj: number;
  bundleId?: string;
  swapDirection?: "USDC_TO_HOP" | "HOP_TO_USDC";
  fallbackFired?: boolean;
};

async function main(): Promise<CycleResult> {
  const rpcUrl      = process.env.SOLANA_RPC_URL || process.env.RPC_URL || "https://api.mainnet-beta.solana.com";
  const dryRun      = process.env.DRY_RUN !== "false";
  const allowLive   = process.env.ALLOW_LIVE === "true";
  const rtCount     = Math.min(Number(process.env.RT_COUNT || "1"), RT_COUNT_MAX);
  const addLiqUsdc  = Number(process.env.ADDLIQ_USDC || "700");
  const swapUsdc    = Number(process.env.SWAP_USDC   || "500");
  const slippageBps = Number(process.env.SLIPPAGE_BPS || "100");
  const cuPrice     = Number(process.env.CU_PRICE || "10000");
  const jitoTip     = BigInt(process.env.JITO_TIP_LAMPORTS || "200000");
  const altAddress  = process.env.ALT_ADDRESS || "EjNKyxzhMCDX63sXLNddioHNZmyyNaHUipsXR65AmwAC";
  const solPriceUsd = Number(process.env.SOL_PRICE_USD || "150");
  const receiptName        = process.env.RECEIPT_NAME || "flash-deep-vol-orca-v2.json";
  const alternateDirection = process.env.ALTERNATE_DIRECTION !== "false";

  if (Number(process.env.RT_COUNT || "1") > RT_COUNT_MAX) {
    throw new Error(`RT_COUNT max is ${RT_COUNT_MAX}, got ${process.env.RT_COUNT}`);
  }

  const conn  = new Connection(rpcUrl, "confirmed");
  const shard = getShardConfig();
  const crank = shard
    ? shard.crank
    : loadKeypair(process.env.CRANK_KEYPAIR_PATH || "keys/crank.json");
  const mfAccount = shard
    ? shard.marginfiAccountPubkey
    : (process.env.MARGINFI_ACCOUNT_PUBKEY
        ? new PublicKey(process.env.MARGINFI_ACCOUNT_PUBKEY)
        : MF_ACCOUNT_DEFAULT);

  const crankUsdcAta = getAssociatedTokenAddressSync(USDC_MINT, crank.publicKey, false, TOKEN_PROGRAM_ID);
  const crankHopAta  = getAssociatedTokenAddressSync(HOP_MINT,  crank.publicKey, false, TOKEN_2022_PROGRAM_ID);

  // ── Read on-chain state ──────────────────────────────────────────────────
  const [poolRaw, mfOracle, hopMintInfo, epochInfo, hopBal, usdcBal] = await Promise.all([
    conn.getAccountInfo(WHIRLPOOL, "confirmed"),
    oracleForBank(conn),
    getMint(conn, HOP_MINT, "confirmed", TOKEN_2022_PROGRAM_ID),
    conn.getEpochInfo(),
    conn.getTokenAccountBalance(crankHopAta,  "confirmed").catch(() => null),
    conn.getTokenAccountBalance(crankUsdcAta, "confirmed").catch(() => null),
  ]);
  if (!poolRaw) throw new Error("Whirlpool account not found");

  const d = Buffer.from(poolRaw.data);
  const feeRate        = readU16LE(d, WP_FEE_RATE_OFFSET);
  const liquidity      = readU128LE(d, WP_LIQUIDITY_OFFSET);
  const sqrtPrice      = readU128LE(d, WP_SQRT_PRICE_OFFSET);
  const tickCurrent    = readI32LE(d, WP_TICK_INDEX_OFFSET);

  const feeConfig = getTransferFeeConfig(hopMintInfo);
  if (!feeConfig) throw new Error("HOP missing TransferFeeConfig");
  const activeFee = epochInfo.epoch >= Number(feeConfig.newerTransferFee.epoch)
    ? feeConfig.newerTransferFee : feeConfig.olderTransferFee;
  const realT22Bps = activeFee.transferFeeBasisPoints;
  const forceT22   = process.env.FORCE_T22_BPS ? Number(process.env.FORCE_T22_BPS) : null;
  const t22Bps     = forceT22 ?? realT22Bps;

  const hopBalance  = BigInt(hopBal?.value.amount  ?? "0");
  const usdcBalance = BigInt(usdcBal?.value.amount ?? "0");

  // ── CLMM liquidity math ──────────────────────────────────────────────────
  const sqrtPLower = tickToSqrtPriceX64(POSITION_TICK_LOWER);
  const sqrtPUpper = tickToSqrtPriceX64(POSITION_TICK_UPPER);

  if (sqrtPrice <= sqrtPLower || sqrtPrice >= sqrtPUpper) {
    throw new Error(`Price out of range: tick=${tickCurrent}, range=[${POSITION_TICK_LOWER},${POSITION_TICK_UPPER}]`);
  }

  const addLiqMicro = BigInt(Math.floor(addLiqUsdc * 1e6));
  const swapMicro   = BigInt(Math.floor(swapUsdc   * 1e6));
  const slipBig     = BigInt(slippageBps);

  const liqFromUsdc = liquidityFromA(addLiqMicro, sqrtPrice, sqrtPUpper);
  const HOP_SAFETY_BPS = 200n;
  // When HOP→USDC first: reserve maxHopIn before sizing addLiq. Inert when aToB=true (hopReserve=0).
  const sqrtPFpEarly = Number(sqrtPrice) / Number(Q64);
  const maxHopInEst  = BigInt(Math.floor(Number(swapMicro) * sqrtPFpEarly * sqrtPFpEarly * 1.1));
  const wantHopFirst = alternateDirection && (tickCurrent - POOL_CENTER_TICK) < 0;
  const hopReserve   = (wantHopFirst && hopBalance > maxHopInEst) ? maxHopInEst : 0n;
  const hopForLiq    = hopBalance - hopReserve;
  const hopEffective = (hopForLiq * (10_000n - BigInt(realT22Bps) - HOP_SAFETY_BPS)) / 10_000n;
  const liqFromHop   = liquidityFromB(hopEffective, sqrtPrice, sqrtPLower);
  const liquidityDelta = liqFromUsdc < liqFromHop ? liqFromUsdc : liqFromHop;

  if (liquidityDelta === 0n) throw new Error("liquidityDelta=0: insufficient USDC or HOP balance");

  const usdcNeeded  = amountAForLiq(liquidityDelta, sqrtPrice, sqrtPUpper);
  const hopForVault = amountBForLiq(liquidityDelta, sqrtPrice, sqrtPLower);
  const hopToSend   = (hopForVault * 10_000n + (10_000n - BigInt(realT22Bps)) - 1n)
                      / (10_000n - BigInt(realT22Bps));

  // 0.1% of addLiq — trivial vs free flash, covers drift-induced rounding at any tick
  const ADDLIQ_BUFFER = addLiqMicro / 1000n;
  const tokenMaxA = addLiqMicro + ADDLIQ_BUFFER;
  const tokenMaxB = hopBalance;

  const flashAmount = addLiqMicro + swapMicro + ADDLIQ_BUFFER;

  const sqrtPFp    = Number(sqrtPrice) / Number(Q64);
  const hopPerUsdc = sqrtPFp * sqrtPFp;
  const hopOutRaw  = BigInt(Math.floor(Number(swapMicro) * hopPerUsdc));
  const t22OnHop   = (hopOutRaw * BigInt(realT22Bps) + 9_999n) / 10_000n;
  const hopSwap2Raw = hopOutRaw > t22OnHop ? hopOutRaw - t22OnHop : 0n;
  const hopSwap2   = (hopSwap2Raw * 7000n) / 10_000n;

  // T22-based revenue (real extractable profit via sweep)
  // HOP transfers per cycle: addLiq (hopToSend), removeLiq (hopForVault), swap1×N, swap2×N
  const t22BpsBig = BigInt(t22Bps);
  const hopXferAddRem = hopForVault * 2n;
  const hopXferSwaps  = hopSwap2 * 2n * BigInt(rtCount);
  const totalHopXfer  = hopXferAddRem + hopXferSwaps;
  const t22WithheldHop  = (totalHopXfer * t22BpsBig) / 10_000n;
  const t22WithheldUsdc = BigInt(Math.floor(Number(t22WithheldHop) / hopPerUsdc));

  // LP fees go to position (circular: we're LP+trader, not extractable as wallet gain)
  const lpFeePerSwap       = (swapMicro * BigInt(feeRate)) / 1_000_000n;
  const lpFeeDrainProjected = lpFeePerSwap * 2n * BigInt(rtCount);

  const gasUsdc = BigInt(Math.max(
    Math.ceil((Number(jitoTip + 5_000n) / 1e9) * solPriceUsd * 1e6),
    4_000,
  ));

  const cashNetIsPositive = t22WithheldUsdc >= gasUsdc;
  const cashNetProj = cashNetIsPositive
    ? Number(t22WithheldUsdc - gasUsdc) / 1e6
    : -Number(gasUsdc - t22WithheldUsdc) / 1e6;

  // ── Summary ──────────────────────────────────────────────────────────────
  console.log("=== FLASH-DEEP-VOL-ORCA-V2 ===");
  console.log(`crank:          ${crank.publicKey.toBase58()}`);
  console.log(`RT_COUNT:       ${rtCount}  (endIndex=${7 + 2 * rtCount})`);
  console.log(`tick:           ${tickCurrent}  liquidity: ${liquidity}`);
  console.log(`t22Bps:         ${t22Bps}  feeRate: ${feeRate}/1e6`);
  console.log();
  console.log(`ADDLIQ_USDC:    $${addLiqUsdc}  →  liquidityDelta: ${liquidityDelta}`);
  console.log(`  usdcNeeded:   $${(Number(usdcNeeded)/1e6).toFixed(4)}`);
  console.log(`  hopToSend:    ${(Number(hopToSend)/1e6).toFixed(4)} HOP`);
  console.log(`  hopBalance:   ${(Number(hopBalance)/1e6).toFixed(4)} HOP  [${hopBalance >= hopToSend ? "OK" : "INSUFFICIENT"}]`);
  console.log();
  console.log(`SWAP_USDC:      $${swapUsdc} × ${rtCount} pairs`);
  console.log(`  hopSwap2 est: ${(Number(hopSwap2)/1e6).toFixed(4)} HOP`);
  console.log(`  totalHopXfer: ${(Number(totalHopXfer)/1e6).toFixed(4)} HOP`);
  console.log(`  t22Withheld:  ${(Number(t22WithheldHop)/1e6).toFixed(4)} HOP ≈ $${(Number(t22WithheldUsdc)/1e6).toFixed(6)}`);
  console.log(`  lpFee drain:  $${(Number(lpFeeDrainProjected)/1e6).toFixed(6)} (circular, not wallet gain)`);
  console.log(`  gas est:      -$${(Number(gasUsdc)/1e6).toFixed(4)}`);
  console.log(`  cashNet proj: $${cashNetProj.toFixed(6)} (T22-based)`);
  console.log();

  if (hopBalance < hopToSend) {
    console.error(`ABORT: need ${(Number(hopToSend)/1e6).toFixed(2)} HOP, have ${(Number(hopBalance)/1e6).toFixed(2)}`);
    writeReceipt(receiptName, { verdict: "INSUFFICIENT_HOP", hopNeeded: Number(hopToSend)/1e6, hopBalance: Number(hopBalance)/1e6 });
    return { verdict: "INSUFFICIENT_HOP", simOk: false, cashNetProj: 0 };
  }

  // ── Direction + telemetry ────────────────────────────────────────────────
  const tickBefore     = tickCurrent;
  // Push tick toward center (92520): if above center swap USDC→HOP (price down), else HOP→USDC (price up)
  // Fallback to USDC→HOP if wallet HOP after addLiq < hopSwap2 (can't fund alternate first swap)
  const hopAfterAddLiq = hopBalance > hopToSend ? hopBalance - hopToSend : 0n;
  const tickDistance   = tickCurrent - POOL_CENTER_TICK;
  // above center → aToB=false (HOP→USDC first, output-spec) → net drift -2 toward center
  // below center → aToB=true  (USDC→HOP first, input-spec)  → net drift +2 toward center
  // Each direction's round-trip asymmetry flips: output-spec-first = net DOWN, input-spec-first = net UP
  const firstSwapAtoB  = !alternateDirection || hopAfterAddLiq < hopSwap2
    ? true
    : tickDistance < 0;
  const swapDirection: "USDC_TO_HOP" | "HOP_TO_USDC" = firstSwapAtoB ? "USDC_TO_HOP" : "HOP_TO_USDC";
  console.log(`tickBefore:     ${tickBefore}  center:${POOL_CENTER_TICK}  firstSwap:${swapDirection}`);

  // ── Tick array selection ─────────────────────────────────────────────────
  let s1ta0: PublicKey, s1ta1: PublicKey, s1ta2: PublicKey;
  let s2ta0: PublicKey, s2ta1: PublicKey, s2ta2: PublicKey;

  if (firstSwapAtoB) {
    // USDC→HOP first: price goes down; ta0 must contain the current tick
    const s1StartIdx = Math.floor(tickCurrent / (64 * 88)) * (64 * 88);
    if (s1StartIdx >= 95744) {
      s1ta0 = TICK_ARRAY_95744; s1ta1 = TICK_ARRAY_90112; s1ta2 = TICK_ARRAY_84480;
    } else {
      s1ta0 = TICK_ARRAY_90112; s1ta1 = TICK_ARRAY_84480; s1ta2 = TICK_ARRAY_84480;
    }

    const poolLiqAfterAdd = liquidity + liquidityDelta;
    const liqShifted      = poolLiqAfterAdd * Q64;
    const sqrtPPost1      = liqShifted / (liqShifted / sqrtPrice + swapMicro);
    const sqrtP_90112     = tickToSqrtPriceX64(90112);
    const sqrtP_84480     = tickToSqrtPriceX64(84480);

    if (sqrtPPost1 >= sqrtP_90112) {
      s2ta0 = TICK_ARRAY_90112; s2ta1 = TICK_ARRAY_95744; s2ta2 = TICK_ARRAY_95744;
    } else if (sqrtPPost1 >= sqrtP_84480) {
      s2ta0 = TICK_ARRAY_84480; s2ta1 = TICK_ARRAY_90112; s2ta2 = TICK_ARRAY_95744;
    } else {
      throw new Error(`post-swap1 price below position range: sqrtPPost1=${sqrtPPost1}`);
    }
  } else {
    // HOP→USDC first: price goes up; ta0 must contain current tick
    const s1bStartIdx = Math.floor(tickCurrent / (64 * 88)) * (64 * 88);
    if (s1bStartIdx >= 95744) {
      // upward swap may cross into 101376/107008 — provide full ascending sequence
      s1ta0 = TICK_ARRAY_95744; s1ta1 = TICK_ARRAY_101376; s1ta2 = TICK_ARRAY_107008;
      // downward swap2 descends from 95744 range after small hop
      s2ta0 = TICK_ARRAY_95744; s2ta1 = TICK_ARRAY_90112; s2ta2 = TICK_ARRAY_84480;
    } else {
      // ascending swap1 may cross 95744 boundary — provide full asc sequence
      s1ta0 = TICK_ARRAY_90112; s1ta1 = TICK_ARRAY_95744; s1ta2 = TICK_ARRAY_101376;
      // swap2 descends from post-swap1 tick (still in 90112 range); ta0 must match current tick array
      s2ta0 = TICK_ARRAY_90112; s2ta1 = TICK_ARRAY_84480; s2ta2 = TICK_ARRAY_84480;
    }
  }

  const minHopOut = dryRun ? 1n : (hopSwap2 * (10_000n - slipBig)) / 10_000n;
  // HOP→USDC swaps use output-specified (amount=swapMicro USDC exact out) so each round-trip
  // is USDC-neutral — the pool pulls however much HOP it needs, capped by maxHopIn.
  // This makes the flash repayment work regardless of RT_COUNT.
  const maxHopIn = hopSwap2Raw * 2n;

  // ── Build IXs ───────────────────────────────────────────────────────────
  // endIndex = 7 + 2*N (0-indexed position of endFlashLoan in the IX array)
  const endIdx = BigInt(7 + 2 * rtCount);

  const swapPairIxs: TransactionInstruction[] = [];
  for (let i = 0; i < rtCount; i++) {
    if (firstSwapAtoB) {
      swapPairIxs.push(
        // swap1: USDC→HOP, input-specified
        swapV2Ix({
          authority: crank.publicKey, ownerA: crankUsdcAta, ownerB: crankHopAta,
          ta0: s1ta0, ta1: s1ta1, ta2: s1ta2,
          amount: swapMicro, otherAmountThreshold: minHopOut,
          sqrtPriceLimit: MIN_SQRT_PRICE, amountSpecifiedIsInput: true, aToB: true,
        }),
        // swap2: HOP→USDC, output-specified (exact swapMicro USDC out)
        swapV2Ix({
          authority: crank.publicKey, ownerA: crankUsdcAta, ownerB: crankHopAta,
          ta0: s2ta0, ta1: s2ta1, ta2: s2ta2,
          amount: swapMicro, otherAmountThreshold: maxHopIn,
          sqrtPriceLimit: MAX_SQRT_PRICE, amountSpecifiedIsInput: false, aToB: false,
        }),
      );
    } else {
      swapPairIxs.push(
        // swap1: HOP→USDC, output-specified (exact swapMicro USDC out)
        swapV2Ix({
          authority: crank.publicKey, ownerA: crankUsdcAta, ownerB: crankHopAta,
          ta0: s1ta0, ta1: s1ta1, ta2: s1ta2,
          amount: swapMicro, otherAmountThreshold: maxHopIn,
          sqrtPriceLimit: MAX_SQRT_PRICE, amountSpecifiedIsInput: false, aToB: false,
        }),
        // swap2: USDC→HOP, input-specified
        swapV2Ix({
          authority: crank.publicKey, ownerA: crankUsdcAta, ownerB: crankHopAta,
          ta0: s2ta0, ta1: s2ta1, ta2: s2ta2,
          amount: swapMicro, otherAmountThreshold: minHopOut,
          sqrtPriceLimit: MIN_SQRT_PRICE, amountSpecifiedIsInput: true, aToB: true,
        }),
      );
    }
  }

  // CU_LIMIT starts at max for first sim; will be tightened after measuring actual consumption
  const ixs: TransactionInstruction[] = [
    ComputeBudgetProgram.setComputeUnitLimit({ units: 1_400_000 }),
    ComputeBudgetProgram.setComputeUnitPrice({ microLamports: cuPrice }),
    startFlashIx(mfAccount, crank.publicKey, endIdx),
    borrowIx(mfAccount, crank.publicKey, crankUsdcAta, flashAmount),
    increaseLiqV2Ix({
      authority: crank.publicKey, ownerA: crankUsdcAta, ownerB: crankHopAta,
      liquidityAmount: liquidityDelta, tokenMaxA, tokenMaxB,
    }),
    ...swapPairIxs,
    decreaseLiqV2Ix({
      authority: crank.publicKey, ownerA: crankUsdcAta, ownerB: crankHopAta,
      liquidityAmount: liquidityDelta, tokenMinA: 0n, tokenMinB: 0n,
    }),
    repayIx(mfAccount, crank.publicKey, crankUsdcAta, flashAmount),
    endFlashIx(mfAccount, crank.publicKey, mfOracle),
  ];

  // ── Load ALT ────────────────────────────────────────────────────────────
  let altAccounts: AddressLookupTableAccount[] = [];
  if (altAddress) {
    const altInfo = await conn.getAddressLookupTable(new PublicKey(altAddress), { commitment: "confirmed" });
    if (!altInfo.value) throw new Error(`ALT not found: ${altAddress}`);
    altAccounts = [altInfo.value];
    console.log(`ALT: ${altAddress} (${altInfo.value.state.addresses.length} addrs)`);
  }

  const { blockhash } = await conn.getLatestBlockhash("confirmed");

  // ── Size check ───────────────────────────────────────────────────────────
  let tx = buildTx(ixs, crank.publicKey, blockhash, altAccounts);
  let txSize = 0;
  try { txSize = tx.serialize().length; } catch { txSize = 9999; }
  console.log(`TX_SIZE=${txSize} bytes (limit 1232)${txSize > 1232 ? " — TOO LARGE" : " — OK"}`);

  if (txSize > 1232) {
    writeReceipt(receiptName, { verdict: "TOO_LARGE", txSize, rtCount });
    return { verdict: "TOO_LARGE", simOk: false, cashNetProj: 0 };
  }

  tx.sign([crank]);

  // ── Sim pass 1: measure actual CU consumption ────────────────────────────
  const sim1 = await conn.simulateTransaction(tx, {
    commitment: "confirmed", sigVerify: false, replaceRecentBlockhash: true,
  });
  const simCu1 = sim1.value.unitsConsumed ?? 0;
  let cuLimitFinal = simCu1 > 0 ? Math.ceil(simCu1 * 1.1) : 1_400_000;

  console.log(`Sim1 CU: ${simCu1} → cuLimitFinal: ${cuLimitFinal}`);

  // Rebuild with tight CU limit
  ixs[0] = ComputeBudgetProgram.setComputeUnitLimit({ units: cuLimitFinal });
  tx = buildTx(ixs, crank.publicKey, blockhash, altAccounts);
  txSize = 0;
  try { txSize = tx.serialize().length; } catch { txSize = 9999; }
  tx.sign([crank]);

  // ── Sim pass 2: final confirmation sim ──────────────────────────────────
  const sim = await conn.simulateTransaction(tx, {
    commitment: "confirmed", sigVerify: false, replaceRecentBlockhash: true,
  });

  const simOk   = !sim.value.err;
  const simErr  = sim.value.err ? JSON.stringify(sim.value.err) : null;
  const simCu   = sim.value.unitsConsumed ?? 0;
  const simLogs = sim.value.logs ?? [];

  console.log();
  console.log(`=== SIM ===`);
  console.log(`RT_COUNT=${rtCount} TX_SIZE=${txSize} bytes CU=${simCu.toLocaleString()} cuLimit=${cuLimitFinal}`);
  console.log(`OK:    ${simOk}`);
  console.log(`Error: ${simErr ?? "null"}`);
  if (!simOk) simLogs.slice(-20).forEach((l) => console.log(" ", l));

  const verdict = simOk
    ? (cashNetIsPositive ? "SIM_OK_PROFITABLE" : "SIM_OK_CHECK_ECONOMICS")
    : "SIM_FAILED";

  const tickFromCenter   = tickBefore - POOL_CENTER_TICK;
  const rangeUtilization = parseFloat(((tickBefore - POSITION_TICK_LOWER) / (POSITION_TICK_UPPER - POSITION_TICK_LOWER)).toFixed(4));

  const receiptData = {
    timestamp: new Date().toISOString(),
    rtCount,
    addLiqUsdc, swapUsdc, t22Bps,
    liquidityDelta: liquidityDelta.toString(),
    poolLiquidity: liquidity.toString(),
    usdcNeeded: Number(usdcNeeded)/1e6,
    hopToSend: Number(hopToSend)/1e6,
    totalHopXferHop: Number(totalHopXfer)/1e6,
    t22WithheldHop: Number(t22WithheldHop)/1e6,
    t22WithheldUsdc: Number(t22WithheldUsdc)/1e6,
    lpFeeDrainProjected: Number(lpFeeDrainProjected)/1e6,
    gasUsdc: Number(gasUsdc)/1e6,
    cashNetProj,
    cuConsumed: simCu,
    cuLimitFinal,
    txSize,
    simOk, simErr, verdict,
    tickBefore,
    tickFromCenter,
    rangeUtilization,
    swapDirection,
  };
  writeReceipt(receiptName, receiptData);

  console.log(`\nVERDICT: ${verdict}`);
  console.log(`cashNet proj: $${cashNetProj.toFixed(6)} (T22-only)`);
  console.log(`receipt: receipts/${receiptName}`);

  const fallbackFired = !alternateDirection || hopAfterAddLiq < hopSwap2;
  const baseResult: CycleResult = { verdict, simOk, cashNetProj, swapDirection, fallbackFired };
  if (dryRun || !allowLive || !simOk || !cashNetIsPositive) return baseResult;

  const skipJito = process.env.JITO_SKIP === "true";

  // ── Live send ────────────────────────────────────────────────────────────
  const { blockhash: fresh, lastValidBlockHeight } = await conn.getLatestBlockhash("confirmed");

  if (skipJito) {
    const directTx = buildTx(ixs, crank.publicKey, fresh, altAccounts);
    directTx.sign([crank]);
    const sig = await conn.sendRawTransaction(directTx.serialize(), { skipPreflight: false });
    const confirmation = await conn.confirmTransaction({ signature: sig, blockhash: fresh, lastValidBlockHeight }, "confirmed");
    console.log(`TX (direct): ${sig}`);

    const liveReceipt: Record<string, unknown> = { onchainSig: sig };
    if (confirmation.value.err) {
      console.error(`[CYCLE FAIL] on-chain:`, JSON.stringify(confirmation.value.err));
      liveReceipt.onchainErr    = confirmation.value.err;
      liveReceipt.onchainStatus = "reverted";
    } else {
      liveReceipt.onchainStatus = "confirmed";
      try {
        const poolAfter = await conn.getAccountInfo(WHIRLPOOL, "confirmed");
        if (poolAfter) {
          const tickAfterLive = Buffer.from(poolAfter.data).readInt32LE(WP_TICK_INDEX_OFFSET);
          liveReceipt.tickAfterLive = tickAfterLive;
          liveReceipt.tickDriftLive = tickAfterLive - tickBefore;
          console.log(`tickAfterLive: ${tickAfterLive}  drift: ${tickAfterLive - tickBefore}`);
        }
      } catch (_e) {
        console.warn("tickAfterLive fetch failed");
      }
    }
    writeReceipt(receiptName, { ...receiptData, ...liveReceipt });
    return { ...baseResult, bundleId: sig };
  }

  const liveIxs = [
    ...ixs,
    SystemProgram.transfer({ fromPubkey: crank.publicKey, toPubkey: JITO_TIP_WALLET, lamports: jitoTip }),
  ];
  const liveTx = buildTx(liveIxs, crank.publicKey, fresh, altAccounts);
  liveTx.sign([crank]);
  const bundleId = await sendJitoBundle(_bs58.encode(liveTx.serialize()));
  console.log(`Bundle: ${bundleId}`);
  return { ...baseResult, bundleId };
}

export { main as runCycle };

const _isMain = new URL(import.meta.url).pathname === new URL(process.argv[1] ?? "", "file://").pathname;
if (_isMain) main().catch((e) => { console.error(e); process.exitCode = 1; });
