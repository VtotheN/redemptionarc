/**
 * auto-compound.ts — Atomic collect-fees + increase-liquidity for organic LP growth.
 *
 * Single atomic TX:
 *   [0] ComputeBudget limit
 *   [1] ComputeBudget price
 *   [2] createIdempotent withdrawAuth USDC ATA
 *   [3] createIdempotent withdrawAuth HOP ATA
 *   [4] collect_protocol_fees_v2  (sweeps pool protocol fees → feeAuthority ATAs)
 *   [5] collect_fees_v2           (sweeps position LP fees → crank ATAs)
 *   [6] increase_liquidity_v2     (adds swept tokens back to position)
 *
 * Revenue scaling: every cycle generates protocol + LP fees. Compounding them
 * back into the position raises max_flash_usdc_in_current_range without
 * external seed (autosufiencia rule).
 *
 * ENV:
 *   SOLANA_RPC_URL
 *   DRY_RUN=true|false
 *   ALLOW_LIVE=true|false
 *   MIN_COMPOUND_USDC=1
 *   SLIPPAGE_BPS=50
 *   CU_LIMIT=400000
 *   CU_PRICE=1000
 *   JITO_TIP_LAMPORTS=0          (no Jito tip for compounding)
 *   RECEIPT_NAME=auto-compound-<ts>.json
 */

import "dotenv/config";
import fs from "node:fs";
import {
  Connection, Keypair, PublicKey, Transaction, TransactionInstruction,
  ComputeBudgetProgram, SystemProgram,
} from "@solana/web3.js";
import {
  TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID,
  getAssociatedTokenAddressSync,
  createAssociatedTokenAccountIdempotentInstruction as createIdempotentAta,
  createHarvestWithheldTokensToMintInstruction,
  createWithdrawWithheldTokensFromMintInstruction,
} from "@solana/spl-token";
import { loadConfig } from "../config.js";
import { connectionFor } from "../utils/rpc.js";
import { writeReceipt } from "../utils/receipt.js";
import { loadKeypair, assertKeypairMatches } from "../utils/keypair.js";
import { assertNoForbiddenConfigured, assertLiveAllowed } from "../utils/safety.js";
import {
  tickToSqrtPriceX64,
  liquidityFromAmountA,
  amountBFromLiquidity,
  WHIRLPOOL_PROGRAM_ID,
} from "../utils/orca-whirlpool.js";

// ─── Constants ───────────────────────────────────────────────────────────────

const WHIRLPOOL         = new PublicKey("8aoWgf7ycbeKv6BTFCdUj4JR7Y4mXWuPZWEUhmuzN5ZL");
const WHIRLPOOLS_CONFIG = new PublicKey("9Nr7o1muxPfcsxv4WtTN2GdUFKhUsdR7WHejyJdesTmZ");
const TOKEN_VAULT_A     = new PublicKey("4QD4GgnjRvjETqWLT5e3x7SHtJSzs9kShUPLfyHcTu7d");
const TOKEN_VAULT_B     = new PublicKey("Qv51R47g7pMDxa3UofXaz8cNr8pwRSXaNufgnEWX8Yk");
const POSITION          = new PublicKey("ErgQU48egJMNBLZeVkdjrtZrSWUQJCky3deh2B4U1YPQ");
const POSITION_MINT     = new PublicKey("21GvQjZagJKZT9nVwAKnXQpSicnNj5X6UvBjZY3SRu8R");
const POSITION_TOKEN_ACCOUNT = new PublicKey("GgLpt3VY9vWKLnNa5Dj3FKvBn3JEDL4KTKpabCAfL54Q");
const TICK_ARRAY_LOWER  = new PublicKey("be9QKj4mYB8erh6r4ZDrKxxSvSYSUNRfpTxqJUgd3jG");
const TICK_ARRAY_UPPER  = new PublicKey("MXd8HXPjcH9ZCuyr4uKKyN7GkJ5YizZQkgUndB6J8Gz");
const ORACLE            = new PublicKey("5qhXANMqTNNzdp1N1PrMzWzSzjHTZxuLPELcmpog6bp5");
const SPL_MEMO          = new PublicKey("MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr");
const TICK_ARRAY_84480  = new PublicKey("be9QKj4mYB8erh6r4ZDrKxxSvSYSUNRfpTxqJUgd3jG");
const TICK_ARRAY_90112  = new PublicKey("CDMSB5e6WUgtoSLrybvYm4j58Jue3eqpzHQVLmgVkAe4");
const TICK_ARRAY_95744  = new PublicKey("MXd8HXPjcH9ZCuyr4uKKyN7GkJ5YizZQkgUndB6J8Gz");

const USDC_MINT = new PublicKey("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v");
const HOP_MINT  = new PublicKey("HZF5k7h39hkysoSZ4ZfmWc55PhvW7ntVvVqdXFCyYGh3");

const POSITION_TICK_LOWER = 84480;
const POSITION_TICK_UPPER = 101312;

// Pool data offsets (after 8-byte discriminator)
const WP_FEE_RATE_OFFSET       = 45;
const WP_PROTO_FEE_RATE_OFFSET = 47;
const WP_LIQUIDITY_OFFSET      = 49;
const WP_SQRT_PRICE_OFFSET     = 65;
const WP_TICK_INDEX_OFFSET     = 81;
const WP_PROTO_FEE_A_OFFSET    = 85;
const WP_PROTO_FEE_B_OFFSET    = 93;

// Position data offsets (after 8-byte discriminator)
const POS_LIQUIDITY_OFFSET   = 72;
const POS_FEE_OWED_A_OFFSET  = 112;
const POS_FEE_OWED_B_OFFSET  = 136;

const Q64 = 1n << 64n;

// IX discriminators
const COLLECT_PROTOCOL_FEES_V2_DISC = Buffer.from([0x67, 0x80, 0xde, 0x86, 0x72, 0xc8, 0x16, 0xc8]);
const COLLECT_FEES_V2_DISC          = Buffer.from([0xcf, 0x75, 0x5f, 0xbf, 0xe5, 0xb4, 0xe2, 0x0f]);
const SWAP_V2_DISC = Buffer.from([0x2b, 0x04, 0xed, 0x0b, 0x1a, 0xc9, 0x1e, 0x62]);
const INCREASE_LIQUIDITY_V2_DISC    = Buffer.from([0x85, 0x1d, 0x59, 0xdf, 0x45, 0xee, 0xb0, 0x0a]);

// ─── Helpers ─────────────────────────────────────────────────────────────────

function loadKp(p: string): Keypair {
  return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(p, "utf8")) as number[]));
}

function u16Le(n: number): Buffer {
  const b = Buffer.alloc(2);
  b.writeUInt16LE(n);
  return b;
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

// Amount A from liquidity (inverse of liquidityFromAmountA)
function amountAFromLiquidity(liquidity: bigint, sqrtP: bigint, sqrtPUpper: bigint): bigint {
  const num = liquidity * (sqrtPUpper - sqrtP) * Q64;
  const den = sqrtPUpper * sqrtP;
  return (num + den - 1n) / den;
}

// Liquidity from amount B
function liquidityFromAmountB(amountB: bigint, sqrtP: bigint, sqrtPLower: bigint): bigint {
  const den = sqrtP - sqrtPLower;
  if (den === 0n) return 0n;
  return (amountB * Q64) / den;
}

// ─── Account readers ─────────────────────────────────────────────────────────

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

interface PositionState {
  liquidity: bigint;
  feeOwedA: bigint;
  feeOwedB: bigint;
}

async function readPositionState(connection: Connection): Promise<PositionState> {
  const info = await connection.getAccountInfo(POSITION, "confirmed");
  if (!info) throw new Error("Position account not found");
  const d = Buffer.from(info.data);
  return {
    liquidity: readU128LE(d, POS_LIQUIDITY_OFFSET),
    feeOwedA:  readU64LE(d, POS_FEE_OWED_A_OFFSET),
    feeOwedB:  readU64LE(d, POS_FEE_OWED_B_OFFSET),
  };
}

// ─── Instruction builders ────────────────────────────────────────────────────

function collectProtocolFeesV2Ix(args: {
  authority: PublicKey;
  destA: PublicKey;
  destB: PublicKey;
}): TransactionInstruction {
  return new TransactionInstruction({
    programId: WHIRLPOOL_PROGRAM_ID,
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
    programId: WHIRLPOOL_PROGRAM_ID,
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

function increaseLiquidityV2Ix(args: {
  positionAuthority: PublicKey;
  tokenOwnerAccountA: PublicKey;
  tokenOwnerAccountB: PublicKey;
  liquidityAmount: bigint;
  tokenMaxA: bigint;
  tokenMaxB: bigint;
}): TransactionInstruction {
  const liqBuf = u128Le(args.liquidityAmount);
  const maxABuf = Buffer.alloc(8); maxABuf.writeBigUInt64LE(args.tokenMaxA);
  const maxBBuf = Buffer.alloc(8); maxBBuf.writeBigUInt64LE(args.tokenMaxB);
  return new TransactionInstruction({
    programId: WHIRLPOOL_PROGRAM_ID,
    keys: [
      { pubkey: WHIRLPOOL,            isSigner: false, isWritable: true  },
      { pubkey: TOKEN_PROGRAM_ID,     isSigner: false, isWritable: false },
      { pubkey: TOKEN_2022_PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: SPL_MEMO,             isSigner: false, isWritable: false },
      { pubkey: args.positionAuthority, isSigner: true, isWritable: false },
      { pubkey: POSITION,             isSigner: false, isWritable: true  },
      { pubkey: POSITION_TOKEN_ACCOUNT, isSigner: false, isWritable: false },
      { pubkey: USDC_MINT,            isSigner: false, isWritable: false },
      { pubkey: HOP_MINT,             isSigner: false, isWritable: false },
      { pubkey: args.tokenOwnerAccountA, isSigner: false, isWritable: true },
      { pubkey: args.tokenOwnerAccountB, isSigner: false, isWritable: true },
      { pubkey: TOKEN_VAULT_A,        isSigner: false, isWritable: true  },
      { pubkey: TOKEN_VAULT_B,        isSigner: false, isWritable: true  },
      { pubkey: TICK_ARRAY_LOWER,     isSigner: false, isWritable: true  },
      { pubkey: TICK_ARRAY_UPPER,     isSigner: false, isWritable: true  },
    ],
    data: Buffer.concat([INCREASE_LIQUIDITY_V2_DISC, liqBuf, maxABuf, maxBBuf, Buffer.from([0x00])]),
  });
}

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
  const data = Buffer.concat([
    SWAP_V2_DISC,
    u64Le(args.amount),
    u64Le(args.otherAmountThreshold),
    u128Le(args.sqrtPriceLimit),
    Buffer.from([args.amountSpecifiedIsInput ? 1 : 0]),
    Buffer.from([args.aToB ? 1 : 0]),
  ]);
  return new TransactionInstruction({
    programId: WHIRLPOOL_PROGRAM_ID,
    keys: [
      { pubkey: args.tokenAuthority, isSigner: true, isWritable: false },
      { pubkey: WHIRLPOOL, isSigner: false, isWritable: true },
      { pubkey: args.tokenOwnerAccountA, isSigner: false, isWritable: true },
      { pubkey: args.tokenOwnerAccountB, isSigner: false, isWritable: true },
      { pubkey: TOKEN_VAULT_A, isSigner: false, isWritable: true },
      { pubkey: TOKEN_VAULT_B, isSigner: false, isWritable: true },
      { pubkey: TICK_ARRAY_90112, isSigner: false, isWritable: true },
      { pubkey: args.tickArray0, isSigner: false, isWritable: true },
      { pubkey: args.tickArray1, isSigner: false, isWritable: true },
      { pubkey: args.tickArray2, isSigner: false, isWritable: true },
      { pubkey: ORACLE, isSigner: false, isWritable: true },
      { pubkey: WHIRLPOOL_PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: args.aToB ? TOKEN_PROGRAM_ID : TOKEN_2022_PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: args.aToB ? TOKEN_2022_PROGRAM_ID : TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
    ],
    data,
  });
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  const config = loadConfig();
  assertNoForbiddenConfigured(config);
  assertLiveAllowed(config);
  if (!config.crank) throw new Error("Missing REDEMPTION_CRANK");

  const rpcUrl          = config.rpcUrl;
  const dryRun          = config.dryRun;
  const allowLive       = config.allowLive;
  const minCompoundUsdc = Number(process.env.MIN_COMPOUND_USDC || "1");
  const slippageBps     = Number(process.env.SLIPPAGE_BPS || "50");
  const cuLimit         = Number(process.env.CU_LIMIT || "400000");
  const cuPrice         = Number(process.env.CU_PRICE || "1000");
  const jitoTip         = BigInt(process.env.JITO_TIP_LAMPORTS || "0");
  const receiptName     = process.env.RECEIPT_NAME || `auto-compound-${new Date().toISOString()}.json`;
  const solPriceUsd     = Number(process.env.SOL_PRICE_USD || "150");

  const connection = connectionFor(rpcUrl);
  const crank      = loadKp("keys/crank.json");
  assertKeypairMatches("crank", crank, config.crank);

  const withdrawAuthPath = process.env.WITHDRAW_AUTHORITY_KEYPAIR_PATH ||
    (config.withdrawAuthority?.equals(config.crank) ? "keys/crank.json" : "keys/withdraw-authority.json");
  const withdrawAuth = loadKp(withdrawAuthPath);
  if (config.withdrawAuthority) {
    assertKeypairMatches("withdraw authority", withdrawAuth, config.withdrawAuthority);
  }

  const crankUsdcAta = getAssociatedTokenAddressSync(USDC_MINT, crank.publicKey, false, TOKEN_PROGRAM_ID);
  const crankHopAta  = getAssociatedTokenAddressSync(HOP_MINT,  crank.publicKey, false, TOKEN_2022_PROGRAM_ID);
  const authUsdcAta  = getAssociatedTokenAddressSync(USDC_MINT, withdrawAuth.publicKey, false, TOKEN_PROGRAM_ID);
  const authHopAta   = getAssociatedTokenAddressSync(HOP_MINT,  withdrawAuth.publicKey, false, TOKEN_2022_PROGRAM_ID);

  console.log("=== AUTO-COMPOUND ===");
  console.log(`crank:        ${crank.publicKey.toBase58()}`);
  console.log(`withdrawAuth: ${withdrawAuth.publicKey.toBase58()}`);
  console.log(`dryRun:       ${dryRun}`);
  console.log();

  // ─── Read state ──────────────────────────────────────────────────────────

  const [poolState, posState] = await Promise.all([
    readPoolState(connection),
    readPositionState(connection),
  ]);

  const { sqrtPrice, liquidity: poolLiquidity } = poolState;
  const { liquidity: posLiquidity, feeOwedA: lpFeeA, feeOwedB: lpFeeB } = posState;

  const protocolFeeA = poolState.protocolFeeOwedA;
  const protocolFeeB = poolState.protocolFeeOwedB;

  const protocolFeeAUi = Number(protocolFeeA) / 1e6;
  const protocolFeeBUi = Number(protocolFeeB) / 1e6;
  const lpFeeAUi       = Number(lpFeeA) / 1e6;
  const lpFeeBUi       = Number(lpFeeB) / 1e6;

  const compoundUsdcUi = protocolFeeAUi + lpFeeAUi;
  const compoundHopUi  = protocolFeeBUi + lpFeeBUi;

  console.log(`Pool sqrtPrice:      ${sqrtPrice}`);
  console.log(`Pool liquidity:      ${poolLiquidity}`);
  console.log(`Position liquidity:  ${posLiquidity}`);
  console.log(`Protocol fee owed A: ${protocolFeeAUi.toFixed(6)} USDC`);
  console.log(`Protocol fee owed B: ${protocolFeeBUi.toFixed(6)} HOP`);
  console.log(`LP fee owed A:       ${lpFeeAUi.toFixed(6)} USDC`);
  console.log(`LP fee owed B:       ${lpFeeBUi.toFixed(6)} HOP`);
  console.log(`Compoundable USDC:   ${compoundUsdcUi.toFixed(6)}`);
  console.log(`Compoundable HOP:    ${compoundHopUi.toFixed(6)}`);
  console.log();

  // ─── Estimate current position value for sanity check ────────────────────

  const sqrtPLower = tickToSqrtPriceX64(POSITION_TICK_LOWER);
  const sqrtPUpper = tickToSqrtPriceX64(POSITION_TICK_UPPER);

  const posAmountA = amountAFromLiquidity(posLiquidity, sqrtPrice, sqrtPUpper);
  const posAmountB = amountBFromLiquidity(posLiquidity, sqrtPrice, sqrtPLower);

  const sqrtPriceFp = Number(sqrtPrice) / Number(Q64);
  const hopPerUsdc = sqrtPriceFp * sqrtPriceFp;
  const posValueUsdcApprox = Number(posAmountA) / 1e6 + (Number(posAmountB) / 1e6) / hopPerUsdc;

  console.log(`Position value (est): ${posValueUsdcApprox.toFixed(2)} USDC-equiv`);
  console.log(`  A (USDC): ${Number(posAmountA)/1e6}`);
  console.log(`  B (HOP):  ${Number(posAmountB)/1e6} @ ${hopPerUsdc.toFixed(6)} HOP/USDC`);
  console.log();

  // ─── Gate: threshold ─────────────────────────────────────────────────────

  if (compoundUsdcUi < minCompoundUsdc) {
    const receipt = {
      verdict: "BELOW_THRESHOLD",
      timestamp: new Date().toISOString(),
      dryRun,
      protocolFeeOwedABefore: protocolFeeAUi,
      protocolFeeOwedBBefore: protocolFeeBUi,
      lpFeeAClaimable: lpFeeAUi,
      lpFeeBClaimable: lpFeeBUi,
      compoundUsdcAmount: compoundUsdcUi,
      compoundHopAmount: compoundHopUi,
      liquidityDelta: null,
      newMaxFlashInRangeEstimate: null,
      minCompoundUsdc,
      posValueUsdcApprox,
    };
    writeReceipt(receiptName, receipt);
    console.log(`BELOW_THRESHOLD: compoundable USDC ${compoundUsdcUi.toFixed(6)} < min ${minCompoundUsdc}`);
    return;
  }

  // ─── Gate: sanity check vs accidental drain ──────────────────────────────

  const compoundValueUsdcApprox = compoundUsdcUi + compoundHopUi / hopPerUsdc;
  if (compoundValueUsdcApprox > posValueUsdcApprox * 0.99) {
    const receipt = {
      verdict: "SANITY_CHECK_FAILED",
      timestamp: new Date().toISOString(),
      dryRun,
      protocolFeeOwedABefore: protocolFeeAUi,
      protocolFeeOwedBBefore: protocolFeeBUi,
      lpFeeAClaimable: lpFeeAUi,
      lpFeeBClaimable: lpFeeBUi,
      compoundUsdcAmount: compoundUsdcUi,
      compoundHopAmount: compoundHopUi,
      compoundValueUsdcApprox,
      posValueUsdcApprox,
      liquidityDelta: null,
      newMaxFlashInRangeEstimate: null,
    };
    writeReceipt(receiptName, receipt);
    console.error(`SANITY_CHECK_FAILED: compound value $${compoundValueUsdcApprox.toFixed(2)} > 99% of position value $${posValueUsdcApprox.toFixed(2)}`);
    process.exitCode = 1;
    return;
  }

  // ─── Compute liquidity delta from collected amounts ──────────────────────

  const compoundUsdcMicro = BigInt(Math.round(compoundUsdcUi * 1e6));
  const compoundHopMicro  = BigInt(Math.round(compoundHopUi * 1e6));

  const liqFromA = liquidityFromAmountA(compoundUsdcMicro, sqrtPrice, sqrtPUpper);
  const liqFromB = liquidityFromAmountB(compoundHopMicro, sqrtPrice, sqrtPLower);
  let liquidityDelta = liqFromA < liqFromB ? liqFromA : liqFromB;

  const usedUsdcMicro = amountAFromLiquidity(liquidityDelta, sqrtPrice, sqrtPUpper);
  const usedHopMicro  = amountBFromLiquidity(liquidityDelta, sqrtPrice, sqrtPLower);

  const slippageMul = 10000n + BigInt(slippageBps);
  const tokenMaxA = (compoundUsdcMicro * slippageMul) / 10000n;
  let tokenMaxB = (compoundHopMicro * slippageMul) / 10000n;

  // New max flash estimate (same math as flywheel-bot.ts)
  const feeRate = poolState.feeRate;
  const maxUsdcAfterFeeInRange = sqrtPrice > sqrtPLower
    ? amountAFromLiquidity(poolLiquidity + liquidityDelta, sqrtPrice, sqrtPUpper)
    : 0n;
  const maxFlashMicroInRange = feeRate < 1_000_000
    ? (maxUsdcAfterFeeInRange * 1_000_000n + BigInt(1_000_000 - feeRate - 1)) / BigInt(1_000_000 - feeRate)
    : 0n;
  const newMaxFlashInRange = Number(maxFlashMicroInRange) / 1e6;

  console.log(`Liquidity delta:     ${liquidityDelta}`);
  console.log(`Used USDC:           ${Number(usedUsdcMicro)/1e6}`);
  console.log(`Used HOP:            ${Number(usedHopMicro)/1e6}`);
  console.log(`tokenMaxA:           ${Number(tokenMaxA)/1e6} (slippage ${slippageBps} bps)`);
  console.log(`tokenMaxB:           ${Number(tokenMaxB)/1e6} (slippage ${slippageBps} bps)`);
  console.log(`New max flash est:   $${newMaxFlashInRange.toFixed(2)}`);
  console.log();

  // ─── Build TX ────────────────────────────────────────────────────────────
  const doSwapHop = process.env.SWAP_HOP_TO_USDC === "true";

  const ixs: TransactionInstruction[] = [
    ComputeBudgetProgram.setComputeUnitLimit({ units: cuLimit }),
    ComputeBudgetProgram.setComputeUnitPrice({ microLamports: cuPrice }),
    // Ensure fee-authority ATAs exist (funder = crank pays rent if needed)
    createIdempotentAta(crank.publicKey, authUsdcAta, withdrawAuth.publicKey, USDC_MINT),
    createIdempotentAta(crank.publicKey, authHopAta,  withdrawAuth.publicKey, HOP_MINT, TOKEN_2022_PROGRAM_ID),
    collectProtocolFeesV2Ix({ authority: withdrawAuth.publicKey, destA: authUsdcAta, destB: authHopAta }),
    collectFeesV2Ix({ positionAuthority: crank.publicKey, tokenOwnerAccountA: crankUsdcAta, tokenOwnerAccountB: crankHopAta }),
    // [4.5] Harvest T22 withheld fees into mint
    createHarvestWithheldTokensToMintInstruction(HOP_MINT, [crankHopAta, TOKEN_VAULT_B], TOKEN_2022_PROGRAM_ID),
    // [5.5] Withdraw T22 withheld fees from mint to crank HOP ATA
    createWithdrawWithheldTokensFromMintInstruction(HOP_MINT, crankHopAta, crank.publicKey, [], TOKEN_2022_PROGRAM_ID),
  ];

  // Optional: swap collected HOP → USDC before re-injecting liquidity
  if (doSwapHop) {
    const Q64 = 1n << 64n;
    const MIN_SQRT_PRICE = 4295048016n;
    ixs.push(swapV2Ix({
      tokenAuthority: crank.publicKey,
      tokenOwnerAccountA: crankUsdcAta,
      tokenOwnerAccountB: crankHopAta,
      tickArray0: TICK_ARRAY_84480,
      tickArray1: TICK_ARRAY_90112,
      tickArray2: TICK_ARRAY_95744,
      amount: compoundHopMicro,
      otherAmountThreshold: 0n,
      sqrtPriceLimit: MIN_SQRT_PRICE,
      amountSpecifiedIsInput: true,
      aToB: false,
    }));
    // After swapping all HOP fees, recompute liquidityDelta using USDC-only heuristic
    // (HOP side becomes 0 — increase_liquidity will be USDC-bounded)
    const liqFromAOnly = liquidityFromAmountA(compoundUsdcMicro + compoundHopMicro /* rough: assumes 1:1 price */, sqrtPrice, sqrtPUpper);
    liquidityDelta = liqFromAOnly < liquidityDelta ? liqFromAOnly : liquidityDelta;
    tokenMaxB = 0n;
  }

  ixs.push(increaseLiquidityV2Ix({
    positionAuthority: crank.publicKey,
    tokenOwnerAccountA: crankUsdcAta,
    tokenOwnerAccountB: crankHopAta,
    liquidityAmount: liquidityDelta,
    tokenMaxA,
    tokenMaxB,
  }));

  if (jitoTip > 0n) {
    ixs.push(SystemProgram.transfer({ fromPubkey: crank.publicKey, toPubkey: new PublicKey("96gYZGLnJYVFmbjzopPSU6QiEV5fGqZNyN9nmNhvrZU5"), lamports: jitoTip }));
  }

  const { blockhash } = await connection.getLatestBlockhash("confirmed");
  const tx = new Transaction({ recentBlockhash: blockhash, feePayer: crank.publicKey });
  tx.add(...ixs);
  tx.sign(crank, withdrawAuth);

  // ─── Simulate ────────────────────────────────────────────────────────────

  const serializedSize = tx.serialize().length;
  console.log(`TX serialized size: ${serializedSize}b ${serializedSize > 1232 ? "(OVER LEGACY LIMIT)" : "OK"}`);
  console.log("Simulating compound TX...");
  const sim = await connection.simulateTransaction(tx);
  const simLogs = (sim.value.logs ?? []).slice(-20);
  simLogs.forEach(l => console.log(" ", l));
  console.log(`Sim err: ${sim.value.err ? JSON.stringify(sim.value.err) : "null"}`);
  console.log(`Sim CU:  ${sim.value.unitsConsumed ?? "?"}`);

  const simOk = !sim.value.err;
  const gasUsdFloor = 0.004;
  const estimatedLamports = 5000n + jitoTip;
  const estimatedGasUsdc = Math.max(
    (Number(estimatedLamports) / 1e9) * solPriceUsd,
    gasUsdFloor
  );

  const receipt: Record<string, unknown> = {
    verdict: simOk ? "SIM_OK" : "SIM_FAILED",
    timestamp: new Date().toISOString(),
    dryRun,
    protocolFeeOwedABefore: protocolFeeAUi,
    protocolFeeOwedBBefore: protocolFeeBUi,
    lpFeeAClaimable: lpFeeAUi,
    lpFeeBClaimable: lpFeeBUi,
    compoundUsdcAmount: compoundUsdcUi,
    compoundHopAmount: compoundHopUi,
    liquidityDelta: liquidityDelta.toString(),
    usedUsdc: Number(usedUsdcMicro) / 1e6,
    usedHop: Number(usedHopMicro) / 1e6,
    newMaxFlashInRangeEstimate: newMaxFlashInRange,
    posValueUsdcApprox,
    simUnitsConsumed: sim.value.unitsConsumed ?? null,
    simErr: sim.value.err ?? null,
    simLogs: simLogs.slice(-5),
    estimatedGasUsdc,
  };

  if (!simOk) {
    writeReceipt(receiptName, receipt);
    console.error("SIM_FAILED — fix before sending");
    process.exitCode = 1;
    return;
  }

  if (dryRun || !allowLive) {
    console.log("SIM_OK — DRY_RUN. Set DRY_RUN=false to run live.");
    writeReceipt(receiptName, receipt);
    return;
  }

  // ─── Live send ───────────────────────────────────────────────────────────

  const { blockhash: bh } = await connection.getLatestBlockhash("confirmed");
  const liveTx = new Transaction({ recentBlockhash: bh, feePayer: crank.publicKey });
  liveTx.add(...ixs);
  liveTx.sign(crank, withdrawAuth);

  const sig = await connection.sendRawTransaction(liveTx.serialize(), {
    skipPreflight: false,
    preflightCommitment: "confirmed",
  });
  console.log(`Live TX sent: ${sig}`);

  receipt.signature = sig;
  receipt.verdict = "EXECUTED";
  writeReceipt(receiptName, receipt);
}

main().catch(e => { console.error(e); process.exitCode = 1; });
