/**
 * flywheel-bot.ts — Main money loop on our own Whirlpool.
 *
 * Per bundle (single legacy TX, 10 IXs):
 *   [0] ComputeBudget limit
 *   [1] ComputeBudget price
 *   [2] MarginFi startFlashLoan(endIndex=9)
 *   [3] createIdempotent crankUsdcAta
 *   [4] MarginFi lendingAccountBorrow FLASH_AMOUNT_USDC
 *   [5] swap_v2 USDC→HOP  (a_to_b=true, 0.3% fee → pool)
 *   [6] swap_v2 HOP→USDC  (a_to_b=false, 0.3% fee → pool)
 *   [7] MarginFi lendingAccountRepay FLASH_AMOUNT_USDC
 *   [8] System transfer (Jito tip)
 *   [9] MarginFi endFlashLoan
 *
 * Revenue: protocol fees collected post-bundles (collect_protocol_fees_v2).
 * LP fees accrue in position (claimable via collect_fees_v2 separately).
 *
 * ENV:
 *   SOLANA_RPC_URL
 *   FLASH_AMOUNT_USDC=1000    (flash borrow size = swap size)
 *   MIN_FLASH_AMOUNT_USDC=1000
 *   GAS_USD_FLOOR=0.004
 *   BUNDLES=10                (live bundles after sim passes)
 *   JITO_TIP_LAMPORTS=10000
 *   CU_LIMIT=400000
 *   CU_PRICE=1000
 *   DRY_RUN=false
 *   ALLOW_LIVE=true
 */

import "dotenv/config";
import fs from "node:fs";
import { createRequire } from "module";
const _require = createRequire(import.meta.url);
// eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
const _bs58 = _require("bs58") as { encode: (b: Buffer) => string };
import {
  Connection, Keypair, PublicKey, Transaction, TransactionInstruction,
  SystemProgram, ComputeBudgetProgram, SYSVAR_INSTRUCTIONS_PUBKEY,
  sendAndConfirmTransaction,
} from "@solana/web3.js";
import {
  TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID,
  getAssociatedTokenAddressSync,
  createAssociatedTokenAccountIdempotentInstruction as createIdempotentAta,
  getMint, getTransferFeeConfig,
} from "@solana/spl-token";
import { writeReceipt } from "../utils/receipt.js";

// ─── Program / account constants ─────────────────────────────────────────────

const WHIRLPOOL_PROGRAM  = new PublicKey("GxRHMB9a6XE8BqGPeNb9UkJUPvbvrPoPgNTJPJJA4n8h");
const WHIRLPOOL          = new PublicKey("8aoWgf7ycbeKv6BTFCdUj4JR7Y4mXWuPZWEUhmuzN5ZL");
const WHIRLPOOLS_CONFIG  = new PublicKey("9Nr7o1muxPfcsxv4WtTN2GdUFKhUsdR7WHejyJdesTmZ");
const TOKEN_VAULT_A      = new PublicKey("4QD4GgnjRvjETqWLT5e3x7SHtJSzs9kShUPLfyHcTu7d");
const TOKEN_VAULT_B      = new PublicKey("Qv51R47g7pMDxa3UofXaz8cNr8pwRSXaNufgnEWX8Yk");
const TICK_ARRAY_84480   = new PublicKey("be9QKj4mYB8erh6r4ZDrKxxSvSYSUNRfpTxqJUgd3jG");
const TICK_ARRAY_90112   = new PublicKey("CDMSB5e6WUgtoSLrybvYm4j58Jue3eqpzHQVLmgVkAe4");
const TICK_ARRAY_95744   = new PublicKey("MXd8HXPjcH9ZCuyr4uKKyN7GkJ5YizZQkgUndB6J8Gz");
const ORACLE             = new PublicKey("5qhXANMqTNNzdp1N1PrMzWzSzjHTZxuLPELcmpog6bp5");

// LP position for fee collection
const POSITION           = new PublicKey("ErgQU48egJMNBLZeVkdjrtZrSWUQJCky3deh2B4U1YPQ");
const POSITION_MINT      = new PublicKey("21GvQjZagJKZT9nVwAKnXQpSicnNj5X6UvBjZY3SRu8R");
const POSITION_TOKEN_ACCOUNT = new PublicKey("GgLpt3VY9vWKLnNa5Dj3FKvBn3JEDL4KTKpabCAfL54Q");
const TICK_ARRAY_LOWER   = TICK_ARRAY_84480;
const TICK_ARRAY_UPPER   = TICK_ARRAY_95744;
const SPL_MEMO           = new PublicKey("MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr");

const USDC_MINT = new PublicKey("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v");
const HOP_MINT  = new PublicKey("HZF5k7h39hkysoSZ4ZfmWc55PhvW7ntVvVqdXFCyYGh3");
const HOP_DECIMALS = 6;
const USDC_DECIMALS = 6;
const TARGET_HOP_T22_BPS = 1;

const MARGINFI_PROGRAM     = new PublicKey("MFv2hWf31Z9kbCa1snEPYctwafyhdvnV7FZnsebVacA");
const MARGINFI_GROUP       = new PublicKey("4qp6Fx6tnZkY5Wropq9wUYgtFxXKwE6viZxFHg3rdAG8");
const USDC_BANK            = new PublicKey("2s37akK2eyBbp8DZgCm7RtsaEz8eJP3Nxd4urLHQv7yB");
const USDC_LIQ_VAULT       = new PublicKey("7jaiZR5Sk8hdYN9MxTpczTcwbWpb5WEoxSANuUwveuat");
const MF_ACCOUNT           = new PublicKey("9SdjygeTAmMrgCQjBAGNAAjjYE6U35ARWcuvvxFZJHz");

const JITO_TIP_WALLET = new PublicKey("96gYZGLnJYVFmbjzopPSU6QiEV5fGqZNyN9nmNhvrZU5");
const JITO_URL        = "https://mainnet.block-engine.jito.labs.io/api/v1/bundles";

// ─── Discriminators ──────────────────────────────────────────────────────────

const IX_START  = Buffer.from([14, 131, 33, 220, 81, 186, 180, 107]);
const IX_END    = Buffer.from([105, 124, 201, 106, 153, 2, 8, 156]);
const IX_BORROW = Buffer.from([4, 126, 116, 53, 48, 5, 212, 31]);
const IX_REPAY  = Buffer.from([79, 209, 172, 177, 222, 51, 173, 151]);
const SWAP_V2_DISC = Buffer.from([0x2b, 0x04, 0xed, 0x0b, 0x1a, 0xc9, 0x1e, 0x62]);
const COLLECT_PROTOCOL_FEES_V2_DISC = Buffer.from([0x67, 0x80, 0xde, 0x86, 0x72, 0xc8, 0x16, 0xc8]);
const COLLECT_FEES_V2_DISC = Buffer.from([0xcf, 0x75, 0x5f, 0xbf, 0xe5, 0xb4, 0xe2, 0x0f]);

// Bank oracle offset in MarginFi bank account data
const BANK_ORACLE_OFFSET = 610;

// Whirlpool account data offsets (after 8-byte Anchor discriminator)
const WP_FEE_RATE_OFFSET       = 45;
const WP_PROTO_FEE_RATE_OFFSET = 47;
const WP_LIQUIDITY_OFFSET      = 49;
const WP_SQRT_PRICE_OFFSET     = 65;
const WP_TICK_INDEX_OFFSET     = 81;
const WP_PROTO_FEE_A_OFFSET    = 85;
const WP_PROTO_FEE_B_OFFSET    = 93;

const MIN_SQRT_PRICE = 4295048016n;
const MAX_SQRT_PRICE = 79226673515401279992447579055n;
const Q64 = 1n << 64n;
const POSITION_TICK_LOWER = 84480;
const POSITION_TICK_UPPER = 101312;

// ─── Helpers ─────────────────────────────────────────────────────────────────

function loadKeypair(p: string): Keypair {
  return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(p, "utf8")) as number[]));
}

function u64Le(n: bigint): Buffer {
  const b = Buffer.alloc(8);
  b.writeBigUInt64LE(n);
  return b;
}

function u128Le(n: bigint): Buffer {
  const b = Buffer.alloc(16);
  b.writeBigUInt64LE(n & ((1n << 64n) - 1n), 0);
  b.writeBigUInt64LE(n >> 64n, 8);
  return b;
}

function readU16LE(buf: Buffer, offset: number): number {
  return buf.readUInt16LE(offset);
}

function readU64LE(buf: Buffer, offset: number): bigint {
  return buf.readBigUInt64LE(offset);
}

function readU128LE(buf: Buffer, offset: number): bigint {
  const lo = buf.readBigUInt64LE(offset);
  const hi = buf.readBigUInt64LE(offset + 8);
  return lo | (hi << 64n);
}

function readI32LE(buf: Buffer, offset: number): number {
  return buf.readInt32LE(offset);
}

// ─── CLMM swap math ──────────────────────────────────────────────────────────

// next_sqrt_price for a_to_b=true (amount_a in, price goes down)
// next = ceil((L * P * 2^64) / (L * 2^64 + amount_in_after_fee * P))
function nextSqrtPriceFromAmountA(sqrtP: bigint, liquidity: bigint, amountIn: bigint): bigint {
  const num = liquidity * sqrtP;
  const den = (liquidity << 64n) + amountIn * sqrtP;
  return (num * Q64 + den - 1n) / den;
}

// next_sqrt_price for a_to_b=false (amount_b in, price goes up)
// next = P + (amount_in_after_fee * 2^64 / L)  [round down]
function nextSqrtPriceFromAmountB(sqrtP: bigint, liquidity: bigint, amountIn: bigint): bigint {
  return sqrtP + (amountIn * Q64) / liquidity;
}

// amount_b from liquidity and sqrt price range (round down)
function amountDeltaB(sqrtPLow: bigint, sqrtPHigh: bigint, liquidity: bigint): bigint {
  return (liquidity * (sqrtPHigh - sqrtPLow)) >> 64n;
}

// amount_a from liquidity and sqrt price range (round down)
function amountDeltaA(sqrtPLow: bigint, sqrtPHigh: bigint, liquidity: bigint): bigint {
  return (liquidity * (sqrtPHigh - sqrtPLow) + sqrtPHigh - 1n) / sqrtPHigh * Q64 / sqrtPLow;
}

function amountDeltaARoundedUp(sqrtPLow: bigint, sqrtPHigh: bigint, liquidity: bigint): bigint {
  const num = liquidity * (sqrtPHigh - sqrtPLow) * Q64;
  const den = sqrtPHigh * sqrtPLow;
  return (num + den - 1n) / den;
}

function tickToSqrtPriceX64(tick: number): bigint {
  return BigInt(Math.floor(Math.sqrt(Math.pow(1.0001, tick)) * Number(Q64)));
}

function computeSwapAToB(sqrtP: bigint, liquidity: bigint, amountUsdc: bigint, feeRate: number): {
  hopOut: bigint; nextSqrtP: bigint;
} {
  const feeAmt = (amountUsdc * BigInt(feeRate) + 999_999n) / 1_000_000n;
  const amtAfterFee = amountUsdc - feeAmt;
  const nextSqrtP = nextSqrtPriceFromAmountA(sqrtP, liquidity, amtAfterFee);
  const hopOut = amountDeltaB(nextSqrtP, sqrtP, liquidity);
  return { hopOut, nextSqrtP };
}

function computeSwapBToA(sqrtP: bigint, liquidity: bigint, amountHop: bigint, feeRate: number): {
  usdcOut: bigint; nextSqrtP: bigint;
} {
  const feeAmt = (amountHop * BigInt(feeRate) + 999_999n) / 1_000_000n;
  const amtAfterFee = amountHop - feeAmt;
  const nextSqrtP = nextSqrtPriceFromAmountB(sqrtP, liquidity, amtAfterFee);
  const usdcOut = amountDeltaA(sqrtP, nextSqrtP, liquidity);
  return { usdcOut, nextSqrtP };
}

// ─── Whirlpool account reader ─────────────────────────────────────────────────

interface PoolState {
  feeRate: number;
  protocolFeeRate: number;
  liquidity: bigint;
  sqrtPrice: bigint;
  tickCurrentIndex: number;
  protocolFeeOwedA: bigint;
  protocolFeeOwedB: bigint;
}

async function readPoolState(connection: Connection): Promise<PoolState> {
  const info = await connection.getAccountInfo(WHIRLPOOL, "confirmed");
  if (!info) throw new Error("Whirlpool account not found");
  const d = Buffer.from(info.data);
  return {
    feeRate:          readU16LE(d, WP_FEE_RATE_OFFSET),
    protocolFeeRate:  readU16LE(d, WP_PROTO_FEE_RATE_OFFSET),
    liquidity:        readU128LE(d, WP_LIQUIDITY_OFFSET),
    sqrtPrice:        readU128LE(d, WP_SQRT_PRICE_OFFSET),
    tickCurrentIndex: readI32LE(d, WP_TICK_INDEX_OFFSET),
    protocolFeeOwedA: readU64LE(d, WP_PROTO_FEE_A_OFFSET),
    protocolFeeOwedB: readU64LE(d, WP_PROTO_FEE_B_OFFSET),
  };
}

// ─── MarginFi instruction builders ───────────────────────────────────────────

async function oracleForBank(connection: Connection, bank: PublicKey): Promise<PublicKey> {
  const info = await connection.getAccountInfo(bank, "confirmed");
  if (!info) throw new Error(`Bank not found: ${bank.toBase58()}`);
  return new PublicKey(Buffer.from(info.data).subarray(BANK_ORACLE_OFFSET, BANK_ORACLE_OFFSET + 32));
}

function startFlashIx(account: PublicKey, authority: PublicKey, endIndex: bigint): TransactionInstruction {
  return new TransactionInstruction({
    programId: MARGINFI_PROGRAM,
    keys: [
      { pubkey: account, isSigner: false, isWritable: true },
      { pubkey: authority, isSigner: true, isWritable: false },
      { pubkey: SYSVAR_INSTRUCTIONS_PUBKEY, isSigner: false, isWritable: false },
    ],
    data: Buffer.concat([IX_START, u64Le(endIndex)]),
  });
}

function endFlashIx(account: PublicKey, authority: PublicKey, oracle: PublicKey): TransactionInstruction {
  return new TransactionInstruction({
    programId: MARGINFI_PROGRAM,
    keys: [
      { pubkey: account, isSigner: false, isWritable: true },
      { pubkey: authority, isSigner: true, isWritable: false },
      { pubkey: USDC_BANK, isSigner: false, isWritable: false },
      { pubkey: oracle, isSigner: false, isWritable: false },
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
      { pubkey: MARGINFI_GROUP,  isSigner: false, isWritable: false },
      { pubkey: account,         isSigner: false, isWritable: true },
      { pubkey: authority,       isSigner: true,  isWritable: false },
      { pubkey: USDC_BANK,       isSigner: false, isWritable: true },
      { pubkey: destAta,         isSigner: false, isWritable: true },
      { pubkey: vaultAuth,       isSigner: false, isWritable: false },
      { pubkey: USDC_LIQ_VAULT,  isSigner: false, isWritable: true },
      { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
    ],
    data: Buffer.concat([IX_BORROW, u64Le(amount)]),
  });
}

function repayIx(account: PublicKey, authority: PublicKey, srcAta: PublicKey, amount: bigint): TransactionInstruction {
  return new TransactionInstruction({
    programId: MARGINFI_PROGRAM,
    keys: [
      { pubkey: MARGINFI_GROUP,  isSigner: false, isWritable: false },
      { pubkey: account,         isSigner: false, isWritable: true },
      { pubkey: authority,       isSigner: true,  isWritable: false },
      { pubkey: USDC_BANK,       isSigner: false, isWritable: true },
      { pubkey: srcAta,          isSigner: false, isWritable: true },
      { pubkey: USDC_LIQ_VAULT,  isSigner: false, isWritable: true },
      { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
    ],
    data: Buffer.concat([IX_REPAY, u64Le(amount), Buffer.from([0])]),
  });
}

// ─── Whirlpool instruction builders ──────────────────────────────────────────

function swapV2Ix(args: {
  tokenAuthority: PublicKey;
  tokenOwnerAccountA: PublicKey;
  tokenOwnerAccountB: PublicKey;
  tickArray0: PublicKey;
  tickArray1: PublicKey;
  tickArray2: PublicKey;
  amount: bigint;
  otherAmountThreshold: bigint;
  sqrtPriceLimit: bigint;
  amountSpecifiedIsInput: boolean;
  aToB: boolean;
}): TransactionInstruction {
  return new TransactionInstruction({
    programId: WHIRLPOOL_PROGRAM,
    keys: [
      { pubkey: TOKEN_PROGRAM_ID,       isSigner: false, isWritable: false },
      { pubkey: TOKEN_2022_PROGRAM_ID,  isSigner: false, isWritable: false },
      { pubkey: SPL_MEMO,               isSigner: false, isWritable: false },
      { pubkey: args.tokenAuthority,    isSigner: true,  isWritable: false },
      { pubkey: WHIRLPOOL,              isSigner: false, isWritable: true  },
      { pubkey: USDC_MINT,              isSigner: false, isWritable: false },
      { pubkey: HOP_MINT,               isSigner: false, isWritable: true  },
      { pubkey: args.tokenOwnerAccountA, isSigner: false, isWritable: true },
      { pubkey: TOKEN_VAULT_A,          isSigner: false, isWritable: true  },
      { pubkey: args.tokenOwnerAccountB, isSigner: false, isWritable: true },
      { pubkey: TOKEN_VAULT_B,          isSigner: false, isWritable: true  },
      { pubkey: args.tickArray0,        isSigner: false, isWritable: true  },
      { pubkey: args.tickArray1,        isSigner: false, isWritable: true  },
      { pubkey: args.tickArray2,        isSigner: false, isWritable: true  },
      { pubkey: ORACLE,                 isSigner: false, isWritable: true  },
    ],
    data: Buffer.concat([
      SWAP_V2_DISC,
      u64Le(args.amount),
      u64Le(args.otherAmountThreshold),
      u128Le(args.sqrtPriceLimit),
      Buffer.from([args.amountSpecifiedIsInput ? 1 : 0]),
      Buffer.from([args.aToB ? 1 : 0]),
      Buffer.from([0x00]), // remaining_accounts_info = None
    ]),
  });
}

function collectProtocolFeesV2Ix(args: {
  authority: PublicKey;
  destA: PublicKey;
  destB: PublicKey;
}): TransactionInstruction {
  return new TransactionInstruction({
    programId: WHIRLPOOL_PROGRAM,
    keys: [
      { pubkey: WHIRLPOOLS_CONFIG,    isSigner: false, isWritable: false },
      { pubkey: WHIRLPOOL,            isSigner: false, isWritable: true  },
      { pubkey: args.authority,       isSigner: true,  isWritable: false },
      { pubkey: USDC_MINT,            isSigner: false, isWritable: false },
      { pubkey: HOP_MINT,             isSigner: false, isWritable: true  },
      { pubkey: TOKEN_VAULT_A,        isSigner: false, isWritable: true  },
      { pubkey: TOKEN_VAULT_B,        isSigner: false, isWritable: true  },
      { pubkey: args.destA,           isSigner: false, isWritable: true  },
      { pubkey: args.destB,           isSigner: false, isWritable: true  },
      { pubkey: TOKEN_PROGRAM_ID,     isSigner: false, isWritable: false },
      { pubkey: TOKEN_2022_PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: SPL_MEMO,             isSigner: false, isWritable: false },
    ],
    data: Buffer.concat([COLLECT_PROTOCOL_FEES_V2_DISC, Buffer.from([0x00])]),
  });
}

function collectFeesV2Ix(args: {
  positionAuthority: PublicKey;
  tokenOwnerAccountA: PublicKey;
  tokenOwnerAccountB: PublicKey;
}): TransactionInstruction {
  return new TransactionInstruction({
    programId: WHIRLPOOL_PROGRAM,
    keys: [
      { pubkey: WHIRLPOOLS_CONFIG,    isSigner: false, isWritable: false },
      { pubkey: WHIRLPOOL,            isSigner: false, isWritable: true  },
      { pubkey: args.positionAuthority, isSigner: true, isWritable: false },
      { pubkey: POSITION,             isSigner: false, isWritable: true  },
      { pubkey: POSITION_TOKEN_ACCOUNT, isSigner: false, isWritable: false },
      { pubkey: args.tokenOwnerAccountA, isSigner: false, isWritable: true },
      { pubkey: TOKEN_VAULT_A,        isSigner: false, isWritable: true  },
      { pubkey: args.tokenOwnerAccountB, isSigner: false, isWritable: true },
      { pubkey: TOKEN_VAULT_B,        isSigner: false, isWritable: true  },
      { pubkey: TICK_ARRAY_LOWER,     isSigner: false, isWritable: false },
      { pubkey: TICK_ARRAY_UPPER,     isSigner: false, isWritable: false },
      { pubkey: ORACLE,               isSigner: false, isWritable: false },
      { pubkey: TOKEN_PROGRAM_ID,     isSigner: false, isWritable: false },
      { pubkey: TOKEN_2022_PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: SPL_MEMO,             isSigner: false, isWritable: false },
    ],
    data: Buffer.concat([COLLECT_FEES_V2_DISC, Buffer.from([0x00])]),
  });
}

// ─── Jito bundle ─────────────────────────────────────────────────────────────

async function sendJitoBundle(txBase58: string): Promise<string> {
  const res = await fetch(JITO_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "sendBundle",
      params: [[txBase58]],
    }),
  });
  if (!res.ok) throw new Error(`Jito error ${res.status}: ${await res.text()}`);
  const data = await res.json() as { result?: string; error?: { message: string } };
  if (data.error) throw new Error(`Jito RPC error: ${data.error.message}`);
  return data.result ?? "unknown";
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  const rpcUrl       = process.env.SOLANA_RPC_URL || process.env.RPC_URL || "https://api.mainnet-beta.solana.com";
  const dryRun       = process.env.DRY_RUN !== "false";
  const allowLive    = process.env.ALLOW_LIVE === "true";
  let flashUsdc    = Number(process.env.FLASH_AMOUNT_USDC || "300");
  const minFlashUsdc = Number(process.env.MIN_FLASH_AMOUNT_USDC || "1000");
  const nBundles     = Number(process.env.BUNDLES || "10");
  const jitoTip      = BigInt(process.env.JITO_TIP_LAMPORTS || "10000");
  const cuLimit      = Number(process.env.CU_LIMIT || "400000");
  const cuPrice      = Number(process.env.CU_PRICE || "1000");
  const solPriceUsd  = Number(process.env.SOL_PRICE_USD || "150");
  const gasUsdFloor  = Number(process.env.GAS_USD_FLOOR || "0.004");

  const connection   = new Connection(rpcUrl, "confirmed");
  const crank        = loadKeypair("keys/crank.json");
  const withdrawAuth = loadKeypair(process.env.WITHDRAW_AUTHORITY_KEYPAIR_PATH || "keys/crank.json");

  const crankUsdcAta  = getAssociatedTokenAddressSync(USDC_MINT, crank.publicKey, false, TOKEN_PROGRAM_ID);
  const crankHopAta   = getAssociatedTokenAddressSync(HOP_MINT,  crank.publicKey, false, TOKEN_2022_PROGRAM_ID);
  const authUsdcAta   = getAssociatedTokenAddressSync(USDC_MINT, withdrawAuth.publicKey, false, TOKEN_PROGRAM_ID);
  const authHopAta    = getAssociatedTokenAddressSync(HOP_MINT,  withdrawAuth.publicKey, false, TOKEN_2022_PROGRAM_ID);

  let flashMicro    = BigInt(Math.round(flashUsdc * 1e6));

  console.log("=== FLYWHEEL BOT ===");
  console.log(`crank:        ${crank.publicKey.toBase58()}`);
  console.log(`flash:        $${flashUsdc} USDC`);
  console.log(`bundles:      ${nBundles}`);
  console.log(`dry run:      ${dryRun}`);
  console.log();

  // ─── Read state ──────────────────────────────────────────────────────────

  const [poolState, mfOracle, mintInfo, epochInfo] = await Promise.all([
    readPoolState(connection),
    oracleForBank(connection, USDC_BANK),
    getMint(connection, HOP_MINT, "confirmed", TOKEN_2022_PROGRAM_ID),
    connection.getEpochInfo(),
  ]);

  const feeConfig = getTransferFeeConfig(mintInfo);
  if (!feeConfig) throw new Error("HOP missing TransferFeeConfig");
  const activeT22Config = epochInfo.epoch >= Number(feeConfig.newerTransferFee.epoch)
    ? feeConfig.newerTransferFee : feeConfig.olderTransferFee;
  const t22Bps = activeT22Config.transferFeeBasisPoints;

  const { feeRate, protocolFeeRate, liquidity, sqrtPrice, protocolFeeOwedA, protocolFeeOwedB } = poolState;
  const marginfiVaultBalance = await connection.getTokenAccountBalance(USDC_LIQ_VAULT, "confirmed")
    .then((balance) => BigInt(balance.value.amount))
    .catch(() => 0n);
  const marginfiAvailableUsdc = Number(marginfiVaultBalance) / 1e6;

  console.log(`Pool sqrtPrice:    ${sqrtPrice}`);
  console.log(`Pool liquidity:    ${liquidity}`);
  console.log(`fee_rate:          ${feeRate}/1e6 = ${(feeRate/10000).toFixed(4)}%`);
  console.log(`protocol_fee_rate: ${protocolFeeRate}/10000`);
  console.log(`HOP T22 fee:       ${t22Bps} bps`);
  console.log(`MarginFi USDC:     ${marginfiAvailableUsdc} available`);
  console.log(`protocolFeeOwedA:  ${Number(protocolFeeOwedA)/1e6} USDC`);
  console.log(`protocolFeeOwedB:  ${Number(protocolFeeOwedB)/1e6} HOP`);
  console.log();

  // ─── Cap flash to 80% of LP range capacity ────────────────────────────────

  {
    const lowerSqrtPx64 = tickToSqrtPriceX64(POSITION_TICK_LOWER);
    const maxUsdcInRange = sqrtPrice > lowerSqrtPx64
      ? amountDeltaARoundedUp(lowerSqrtPx64, sqrtPrice, liquidity)
      : 0n;
    const maxFlashCap = feeRate < 1_000_000
      ? (maxUsdcInRange * 1_000_000n + BigInt(1_000_000 - feeRate - 1)) / BigInt(1_000_000 - feeRate)
      : 0n;
    const capAt80 = maxFlashCap * 80n / 100n;
    if (capAt80 > 0n && flashMicro > capAt80) {
      const cappedUsdc = Number(capAt80) / 1e6;
      console.log(`WARN: $${flashUsdc} flash > 80% LP range ($${(Number(maxFlashCap)/1e6).toFixed(2)}). Autocap → $${cappedUsdc.toFixed(2)}`);
      flashMicro = capAt80;
      flashUsdc  = cappedUsdc;
    }
  }

  // ─── Compute expected swap amounts ───────────────────────────────────────

  const { hopOut, nextSqrtP: sqrtP1 } = computeSwapAToB(sqrtPrice, liquidity, flashMicro, feeRate);

  // Derive post-swap1 tick → select correct tick arrays for swap2 (a_to_b=false)
  const tickPostSwap1 = Math.floor(2 * Math.log(Number(sqrtP1) / Number(Q64)) / Math.log(1.0001));
  let swap2Ta0 = TICK_ARRAY_90112;
  let swap2Ta1 = TICK_ARRAY_95744;
  let swap2Ta2 = TICK_ARRAY_95744;
  if (tickPostSwap1 >= 90112) {
    // defaults correct
  } else if (tickPostSwap1 >= 84480) {
    swap2Ta0 = TICK_ARRAY_84480; swap2Ta1 = TICK_ARRAY_90112; swap2Ta2 = TICK_ARRAY_95744;
  } else {
    console.error(`tickPostSwap1=${tickPostSwap1} < 84480 — price out of LP range. Reduce FLASH_AMOUNT_USDC.`);
    writeReceipt("FLYWHEEL-RUN-001.json", { verdict: "PRICE_OUT_OF_RANGE", tickPostSwap1, flashUsdc });
    process.exitCode = 1;
    return;
  }
  console.log(`tick post-swap1: ${tickPostSwap1}  →  swap2 arrays: [${swap2Ta0.toBase58().slice(0,8)}..., ${swap2Ta1.toBase58().slice(0,8)}..., ${swap2Ta2.toBase58().slice(0,8)}...]`);

  // HOP received in our T22 ATA: withheld fee applies on transfer to us
  const t22FeeOnHopOut = (hopOut * BigInt(t22Bps) + 9_999n) / 10_000n;
  const hopAvailForSwap2 = hopOut > t22FeeOnHopOut ? hopOut - t22FeeOnHopOut : 0n;
  const hopSwap2 = hopAvailForSwap2; // use all available HOP (no haircut)

  const { usdcOut } = computeSwapBToA(sqrtP1, liquidity, hopSwap2, feeRate);

  const totalFeeUsdcSwap1 = (flashMicro * BigInt(feeRate) + 999_999n) / 1_000_000n;
  const totalFeeHopSwap2 = (hopSwap2 * BigInt(feeRate) + 999_999n) / 1_000_000n;
  const protocolFeeUsdcSwap1 = (totalFeeUsdcSwap1 * BigInt(protocolFeeRate)) / 10_000n;
  const protocolFeeHopSwap2 = (totalFeeHopSwap2 * BigInt(protocolFeeRate)) / 10_000n;
  const walletUsdcDeltaBeforeCollect = usdcOut - flashMicro;
  const collectableProtocolUsdc = protocolFeeUsdcSwap1;
  const estimatedLamportsPerBundle = 5_000n + jitoTip;
  const estimatedGasUsdcMicro = BigInt(Math.max(
    Math.ceil((Number(estimatedLamportsPerBundle) / 1e9) * solPriceUsd * 1e6),
    Math.ceil(gasUsdFloor * 1e6)
  ));
  // LP fees accrue in position — yours as 100% LP, collected via collect_fees_v2
  const lpFeeUsdcSwap1   = totalFeeUsdcSwap1 - protocolFeeUsdcSwap1;
  const lpFeeHopSwap2    = totalFeeHopSwap2  - protocolFeeHopSwap2;
  const sqrtPriceFp      = Number(sqrtPrice) / Number(Q64);
  const hopPerUsdcRaw    = sqrtPriceFp * sqrtPriceFp;
  const lpFeeSwap2AsUsdc = hopPerUsdcRaw > 0
    ? BigInt(Math.floor(Number(lpFeeHopSwap2) / hopPerUsdcRaw))
    : 0n;
  const cashNetUsdcMicro = walletUsdcDeltaBeforeCollect
    + collectableProtocolUsdc
    + lpFeeUsdcSwap1
    + lpFeeSwap2AsUsdc
    - estimatedGasUsdcMicro;
  const protocolFeeRoundTripRate = (feeRate / 1_000_000) * (protocolFeeRate / 10_000) * 2;
  const breakEvenFlashUsdc = protocolFeeRoundTripRate > 0
    ? (Number(estimatedGasUsdcMicro) / 1e6) / protocolFeeRoundTripRate
    : Infinity;
  const lowerSqrtPrice = tickToSqrtPriceX64(POSITION_TICK_LOWER);
  const maxUsdcAfterFeeInRange = sqrtPrice > lowerSqrtPrice
    ? amountDeltaARoundedUp(lowerSqrtPrice, sqrtPrice, liquidity)
    : 0n;
  const maxFlashMicroInRange = feeRate < 1_000_000
    ? (maxUsdcAfterFeeInRange * 1_000_000n + BigInt(1_000_000 - feeRate - 1)) / BigInt(1_000_000 - feeRate)
    : 0n;
  const maxFlashUsdcInCurrentRange = Number(maxFlashMicroInRange) / 1e6;
  const cashGateReasons = [
    flashUsdc < minFlashUsdc ? `FLASH_AMOUNT_USDC ${flashUsdc} is below minimum ${minFlashUsdc}` : null,
    flashUsdc <= breakEvenFlashUsdc ? `FLASH_AMOUNT_USDC ${flashUsdc} is at/below break-even ${breakEvenFlashUsdc.toFixed(6)}` : null,
    flashMicro > maxFlashMicroInRange ? `FLASH_AMOUNT_USDC ${flashUsdc} exceeds current LP range capacity ${maxFlashUsdcInCurrentRange.toFixed(6)}` : null,
    marginfiVaultBalance < flashMicro ? `MarginFi USDC liquidity ${marginfiAvailableUsdc} is below flash ${flashUsdc}` : null,
    t22Bps !== TARGET_HOP_T22_BPS ? `HOP Token-2022 fee is ${t22Bps}bps; target active fee is ${TARGET_HOP_T22_BPS}bps` : null,
    cashNetUsdcMicro <= 0n ? `cashNetUsdc ${Number(cashNetUsdcMicro) / 1e6} is not positive` : null,
  ].filter((reason): reason is string => Boolean(reason));
  const cashProofPass = cashGateReasons.length === 0;

  console.log(`Swap 1 (USDC→HOP): $${flashUsdc} → ${Number(hopOut)/1e6} HOP`);
  console.log(`  T22 withheld: ${Number(t22FeeOnHopOut)/1e6} HOP (${t22Bps}bps)`);
  console.log(`  HOP for swap2: ${Number(hopSwap2)/1e6} (net after T22)`);
  console.log(`Swap 2 (HOP→USDC): ${Number(hopSwap2)/1e6} HOP → ~$${Number(usdcOut)/1e6}`);
  console.log(`Protocol fees/bundle: ${Number(protocolFeeUsdcSwap1)/1e6} USDC + ${Number(protocolFeeHopSwap2)/1e6} HOP`);
  console.log(`Break-even flash: $${breakEvenFlashUsdc.toFixed(6)} USDC`);
  console.log(`Current LP range max flash: $${maxFlashUsdcInCurrentRange.toFixed(6)} USDC`);
  console.log(`Wallet USDC delta before collect: ${Number(walletUsdcDeltaBeforeCollect)/1e6}`);
  console.log(`LP fee swap1 (USDC, yours):  ${Number(lpFeeUsdcSwap1)/1e6} USDC`);
  console.log(`LP fee swap2 (HOP→est USDC): ${Number(lpFeeSwap2AsUsdc)/1e6} USDC`);
  console.log(`Cash proof net (LP+proto-gas): ${Number(cashNetUsdcMicro)/1e6} USDC`);
  if (cashGateReasons.length > 0) console.log(`Cash gate blocked: ${cashGateReasons.join("; ")}`);
  console.log();

  // ─── Build TX ────────────────────────────────────────────────────────────

  const END_IX = 8n;

  const ixs: TransactionInstruction[] = [
    ComputeBudgetProgram.setComputeUnitLimit({ units: cuLimit }),
    ComputeBudgetProgram.setComputeUnitPrice({ microLamports: cuPrice }),
    startFlashIx(MF_ACCOUNT, crank.publicKey, END_IX),
    borrowIx(MF_ACCOUNT, crank.publicKey, crankUsdcAta, flashMicro),
    // swap USDC→HOP (a_to_b=true, price goes down)
    swapV2Ix({
      tokenAuthority: crank.publicKey,
      tokenOwnerAccountA: crankUsdcAta,
      tokenOwnerAccountB: crankHopAta,
      tickArray0: TICK_ARRAY_90112,
      tickArray1: TICK_ARRAY_84480,
      tickArray2: TICK_ARRAY_84480,
      amount: flashMicro,
      otherAmountThreshold: 0n,
      sqrtPriceLimit: MIN_SQRT_PRICE,
      amountSpecifiedIsInput: true,
      aToB: true,
    }),
    // swap HOP→USDC (a_to_b=false, price goes up)
    swapV2Ix({
      tokenAuthority: crank.publicKey,
      tokenOwnerAccountA: crankUsdcAta,
      tokenOwnerAccountB: crankHopAta,
      tickArray0: swap2Ta0,
      tickArray1: swap2Ta1,
      tickArray2: swap2Ta2,
      amount: hopSwap2,
      otherAmountThreshold: 0n,
      sqrtPriceLimit: MAX_SQRT_PRICE,
      amountSpecifiedIsInput: true,
      aToB: false,
    }),
    repayIx(MF_ACCOUNT, crank.publicKey, crankUsdcAta, flashMicro),
    SystemProgram.transfer({ fromPubkey: crank.publicKey, toPubkey: JITO_TIP_WALLET, lamports: jitoTip }),
    endFlashIx(MF_ACCOUNT, crank.publicKey, mfOracle),
  ];

  if (ixs.length - 1 !== Number(END_IX)) {
    throw new Error(`endIndex mismatch: expected ${END_IX}, got ${ixs.length - 1}`);
  }

  const { blockhash } = await connection.getLatestBlockhash("confirmed");
  const tx = new Transaction({ recentBlockhash: blockhash, feePayer: crank.publicKey });
  tx.add(...ixs);
  tx.sign(crank);

  // ─── Simulate ────────────────────────────────────────────────────────────

  console.log("Simulating...");
  const sim = await connection.simulateTransaction(tx);
  const simLogs = (sim.value.logs ?? []).slice(-20);
  simLogs.forEach(l => console.log(" ", l));
  console.log(`Sim err: ${sim.value.err ? JSON.stringify(sim.value.err) : "null"}`);
  console.log(`Sim CU:  ${sim.value.unitsConsumed ?? "?"}`);

  const simOk = !sim.value.err;

  const receipt: Record<string, unknown> = {
    verdict: simOk ? "SIM_OK" : (cashGateReasons.length > 0 ? "SIM_FAILED_PRECHECK_BLOCKED" : "SIM_FAILED"),
    timestamp: new Date().toISOString(),
    dryRun,
    flashUsdc,
    nBundles,
    poolSqrtPrice: sqrtPrice.toString(),
    poolLiquidity: liquidity.toString(),
    feeRate,
    protocolFeeRate,
    t22Bps,
    targetT22Bps: TARGET_HOP_T22_BPS,
    marginfiUsdcBank: USDC_BANK.toBase58(),
    marginfiUsdcAvailable: marginfiAvailableUsdc,
    minFlashUsdc,
    breakEvenFlashUsdc,
    positionTickLower: POSITION_TICK_LOWER,
    positionTickUpper: POSITION_TICK_UPPER,
    maxFlashUsdcInCurrentRange,
    protocolFeeRoundTripRate,
    gasUsdFloor,
    swap1HopOut: hopOut.toString(),
    swap2HopIn: hopSwap2.toString(),
    swap2UsdcEstOut: usdcOut.toString(),
    protocolFeeUsdcPerBundle: (Number(protocolFeeUsdcSwap1) / 1e6).toFixed(6),
    protocolFeeHopPerBundle: (Number(protocolFeeHopSwap2) / 1e6).toFixed(6),
    protocolFeeOwedABefore: Number(protocolFeeOwedA) / 1e6,
    protocolFeeOwedBBefore: Number(protocolFeeOwedB) / 1e6,
    walletUsdcDeltaBeforeCollect: (Number(walletUsdcDeltaBeforeCollect) / 1e6).toFixed(6),
    collectableProtocolUsdc: (Number(collectableProtocolUsdc) / 1e6).toFixed(6),
    estimatedGasUsdc: (Number(estimatedGasUsdcMicro) / 1e6).toFixed(6),
    lpFeeUsdcSwap1:   (Number(lpFeeUsdcSwap1)   / 1e6).toFixed(6),
    lpFeeSwap2AsUsdc: (Number(lpFeeSwap2AsUsdc) / 1e6).toFixed(6),
    cashNetUsdc: (Number(cashNetUsdcMicro) / 1e6).toFixed(6),
    cashProofPass,
    cashGateReasons,
    simUnitsConsumed: sim.value.unitsConsumed ?? null,
    simErr: sim.value.err ?? null,
    simLogs: simLogs.slice(-5),
    bundlesSent: 0,
    bundleIds: [] as string[],
    protocolFeeOwedAAfter: null as number | null,
    protocolFeeOwedBAfter: null as number | null,
    feesCollectedUsdc: null as number | null,
    feesCollectedHop: null as number | null,
    gasCostSol: null as number | null,
    netUsdc: null as number | null,
    verdict2: "PENDING",
  };

  if (!simOk) {
    writeReceipt("FLYWHEEL-RUN-001.json", receipt);
    console.error("SIM_FAILED — fix before sending");
    process.exitCode = 1;
    return;
  }

  if (!cashProofPass) {
    receipt.verdict = "CASH_PROOF_FAILED";
    receipt.verdict2 = "NO_GO";
    writeReceipt("FLYWHEEL-RUN-001.json", receipt);
    console.error("CASH_PROOF_FAILED — live send blocked because spendable USDC/SOL net is not positive");
    process.exitCode = 1;
    return;
  }

  if (dryRun || !allowLive) {
    console.log("SIM_OK — DRY_RUN. Set DRY_RUN=false ALLOW_LIVE=true to run live.");
    writeReceipt("FLYWHEEL-RUN-001.json", receipt);
    return;
  }

  // ─── STEP 3: Send N live bundles ─────────────────────────────────────────

  console.log(`\nSending ${nBundles} live Jito bundles...`);
  const bundleIds: string[] = [];
  let gasCostLamports = 0n;

  for (let i = 0; i < nBundles; i++) {
    try {
      const { blockhash: bh } = await connection.getLatestBlockhash("confirmed");
      const freshTx = new Transaction({ recentBlockhash: bh, feePayer: crank.publicKey });
      freshTx.add(...ixs);
      freshTx.sign(crank);

      const serialized = freshTx.serialize();
      const txBase58   = _bs58.encode(serialized);
      const bundleId   = await sendJitoBundle(txBase58);
      bundleIds.push(bundleId);
      gasCostLamports += 5000n + jitoTip; // base fee + tip estimate
      console.log(`  bundle[${i}] id=${bundleId}`);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      console.error(`  bundle[${i}] FAILED: ${msg}`);
      bundleIds.push(`ERROR:${msg}`);
    }
  }

  receipt.bundlesSent = nBundles;
  receipt.bundleIds   = bundleIds;
  receipt.gasCostSol  = Number(gasCostLamports) / 1e9;

  // ─── STEP 4: Collect protocol fees ───────────────────────────────────────

  console.log("\nCollecting protocol fees...");

  const poolAfter = await readPoolState(connection);
  receipt.protocolFeeOwedAAfter = Number(poolAfter.protocolFeeOwedA) / 1e6;
  receipt.protocolFeeOwedBAfter = Number(poolAfter.protocolFeeOwedB) / 1e6;

  const feeADelta = poolAfter.protocolFeeOwedA > protocolFeeOwedA ? poolAfter.protocolFeeOwedA - protocolFeeOwedA : 0n;
  const feeBDelta = poolAfter.protocolFeeOwedB > protocolFeeOwedB ? poolAfter.protocolFeeOwedB - protocolFeeOwedB : 0n;

  if (feeADelta > 0n || feeBDelta > 0n) {
    try {
      const collectTx = new Transaction();
      collectTx.add(ComputeBudgetProgram.setComputeUnitLimit({ units: 150_000 }));

      // Create dest ATAs for withdraw-auth if needed
      collectTx.add(
        createIdempotentAta(
          crank.publicKey, authUsdcAta, withdrawAuth.publicKey, USDC_MINT
        )
      );
      collectTx.add(
        createIdempotentAta(
          crank.publicKey, authHopAta, withdrawAuth.publicKey, HOP_MINT, TOKEN_2022_PROGRAM_ID
        )
      );

      collectTx.add(
        collectProtocolFeesV2Ix({
          authority: withdrawAuth.publicKey,
          destA: authUsdcAta,
          destB: authHopAta,
        })
      );

      // Collect LP position fees (crank is position authority)
      collectTx.add(
        collectFeesV2Ix({
          positionAuthority: crank.publicKey,
          tokenOwnerAccountA: crankUsdcAta,
          tokenOwnerAccountB: crankHopAta,
        })
      );

      collectTx.recentBlockhash = (await connection.getLatestBlockhash("confirmed")).blockhash;
      collectTx.feePayer = crank.publicKey;

      const collectSig = await sendAndConfirmTransaction(
        connection, collectTx, [crank, withdrawAuth], { commitment: "confirmed" }
      );
      receipt.feesCollectedUsdc = Number(feeADelta) / 1e6;
      receipt.feesCollectedHop  = Number(feeBDelta) / 1e6;
      console.log(`Collected protocol: ${Number(feeADelta)/1e6} USDC + ${Number(feeBDelta)/1e6} HOP | sig=${collectSig}`);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      console.error(`Collect failed: ${msg}`);
      receipt.feesCollectedUsdc = 0;
      receipt.feesCollectedHop  = 0;
    }
  } else {
    console.log("No protocol fees accumulated yet (may need time to settle).");
    receipt.feesCollectedUsdc = 0;
    receipt.feesCollectedHop  = 0;
  }

  // ─── STEP 5: Write receipt ────────────────────────────────────────────────

  const feesUsd    = Number(receipt.feesCollectedUsdc ?? 0);
  const gasCostUsd = Number(receipt.gasCostSol ?? 0) * 150;
  const netUsdc    = feesUsd - gasCostUsd;
  receipt.netUsdc = netUsdc;
  receipt.verdict2 = netUsdc > 0 ? "PROFITABLE" : "LOSS";

  // ─── STEP 6: Projection ───────────────────────────────────────────────────

  const protocolFeePerBundleUsdc = Number(protocolFeeUsdcSwap1) / 1e6;
  const lpFeePerBundleUsdc = Number(totalFeeUsdcSwap1 - protocolFeeUsdcSwap1) / 1e6;
  const lpFeePerBundleHop  = Number(totalFeeHopSwap2 - protocolFeeHopSwap2) / 1e6;
  const gasPerBundleSol = Number(gasCostLamports) / 1e9 / nBundles;
  const gasPerBundleUsd = gasPerBundleSol * 150;
  const netPerBundle    = protocolFeePerBundleUsdc + lpFeePerBundleUsdc - gasPerBundleUsd;

  console.log("\n=== PROJECTION ===");
  console.log(`Protocol fee/bundle: $${protocolFeePerBundleUsdc.toFixed(6)}`);
  console.log(`LP fee/bundle:       $${lpFeePerBundleUsdc.toFixed(6)} USDC + ${lpFeePerBundleHop.toFixed(6)} HOP`);
  console.log(`Gas/bundle:          ~$${gasPerBundleUsd.toFixed(5)}`);
  console.log(`Net/bundle:          $${netPerBundle.toFixed(6)}`);
  console.log(`At 25 TPS:           ~$${(netPerBundle * 25 * 3600).toFixed(2)}/hr (needs deeper pool)`);
  console.log(`Current pool $290 TVL → recommend scaling liquidity to $50k+ for meaningful yield`);

  receipt.projNetPerBundle  = netPerBundle;
  receipt.projHrAt25Tps     = netPerBundle * 25 * 3600;

  writeReceipt("FLYWHEEL-RUN-001.json", receipt);

  console.log(`\n${receipt.verdict2} net=${netUsdc.toFixed(6)} USDC | bundles=${nBundles}`);
}

main().catch(e => { console.error(e); process.exitCode = 1; });
