/**
 * add-liquidity-hop.ts — increase_liquidity_v2 on existing position.
 *
 * Adds USDC (+ proportional HOP) to position ErgQU48egJMNBLZeVkdjrtZrSWUQJCky3deh2B4U1YPQ
 * in Whirlpool 8aoWgf7ycbeKv6BTFCdUj4JR7Y4mXWuPZWEUhmuzN5ZL.
 *
 * ENV:
 *   SOLANA_RPC_URL
 *   ADD_USDC=50        (USDC to add, default $50)
 *   SLIPPAGE_BPS=200   (slippage on max amounts, default 2%)
 *   DRY_RUN=true
 *   ALLOW_LIVE=false
 */

import "dotenv/config";
import fs from "node:fs";
import {
  Connection, Keypair, PublicKey,
  TransactionInstruction, Transaction, ComputeBudgetProgram,
  sendAndConfirmTransaction,
} from "@solana/web3.js";
import {
  TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID,
  getAssociatedTokenAddressSync,
  getMint, getTransferFeeConfig,
} from "@solana/spl-token";
import { writeReceipt } from "../utils/receipt.js";

// ─── Constants ────────────────────────────────────────────────────────────────

const WHIRLPOOL_PROGRAM  = new PublicKey("GxRHMB9a6XE8BqGPeNb9UkJUPvbvrPoPgNTJPJJA4n8h");
const WHIRLPOOLS_CONFIG  = new PublicKey("9Nr7o1muxPfcsxv4WtTN2GdUFKhUsdR7WHejyJdesTmZ");
const WHIRLPOOL          = new PublicKey("8aoWgf7ycbeKv6BTFCdUj4JR7Y4mXWuPZWEUhmuzN5ZL");
const TOKEN_VAULT_A      = new PublicKey("4QD4GgnjRvjETqWLT5e3x7SHtJSzs9kShUPLfyHcTu7d");
const TOKEN_VAULT_B      = new PublicKey("Qv51R47g7pMDxa3UofXaz8cNr8pwRSXaNufgnEWX8Yk");
const TICK_ARRAY_LOWER   = new PublicKey("be9QKj4mYB8erh6r4ZDrKxxSvSYSUNRfpTxqJUgd3jG"); // 84480
const TICK_ARRAY_UPPER   = new PublicKey("MXd8HXPjcH9ZCuyr4uKKyN7GkJ5YizZQkgUndB6J8Gz"); // 95744 (covers 101312)
const ORACLE             = new PublicKey("5qhXANMqTNNzdp1N1PrMzWzSzjHTZxuLPELcmpog6bp5");
const USDC_MINT          = new PublicKey("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v");
const HOP_MINT           = new PublicKey("HZF5k7h39hkysoSZ4ZfmWc55PhvW7ntVvVqdXFCyYGh3");
const SPL_MEMO           = new PublicKey("MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr");

const POSITION            = new PublicKey("ErgQU48egJMNBLZeVkdjrtZrSWUQJCky3deh2B4U1YPQ");
const POSITION_MINT       = new PublicKey("21GvQjZagJKZT9nVwAKnXQpSicnNj5X6UvBjZY3SRu8R");
const POSITION_TOKEN_ACCT = new PublicKey("GgLpt3VY9vWKLnNa5Dj3FKvBn3JEDL4KTKpabCAfL54Q");

const POSITION_TICK_LOWER = 84480;
const POSITION_TICK_UPPER = 101312;

const INCREASE_LIQ_V2_DISC = Buffer.from([0x85, 0x1d, 0x59, 0xdf, 0x45, 0xee, 0xb0, 0x0a]);

// Whirlpool account offsets (after 8-byte discriminator)
const WP_LIQUIDITY_OFFSET  = 49;
const WP_SQRT_PRICE_OFFSET = 65;

const Q64 = 1n << 64n;

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

function readU128LE(buf: Buffer, off: number): bigint {
  return buf.readBigUInt64LE(off) | (buf.readBigUInt64LE(off + 8) << 64n);
}

function tickToSqrtPriceX64(tick: number): bigint {
  const sqrtPrice = Math.pow(1.0001, tick / 2);
  const scale = 1_000_000_000_000_000n;
  return (BigInt(Math.round(sqrtPrice * Number(scale))) * Q64) / scale;
}

// Liquidity delta from USDC amount (in-range: use current sqrtPrice and upper)
function liquidityFromAmountA(amountA: bigint, sqrtP: bigint, sqrtPUpper: bigint): bigint {
  // L = amount_a * (sqrtP * sqrtPUpper) / (sqrtPUpper - sqrtP) / 2^64
  return (amountA * sqrtP * sqrtPUpper) / ((sqrtPUpper - sqrtP) * Q64);
}

// HOP vault amount from liquidity delta (in-range: use current sqrtPrice and lower)
function amountBFromLiquidity(liquidity: bigint, sqrtP: bigint, sqrtPLower: bigint): bigint {
  return (liquidity * (sqrtP - sqrtPLower)) / Q64;
}

// ─── Instruction builder ──────────────────────────────────────────────────────

function increaseLiquidityV2Ix(args: {
  positionAuthority: PublicKey;
  ownerA: PublicKey;
  ownerB: PublicKey;
  liquidityAmount: bigint;
  tokenMaxA: bigint;
  tokenMaxB: bigint;
}): TransactionInstruction {
  return new TransactionInstruction({
    programId: WHIRLPOOL_PROGRAM,
    keys: [
      { pubkey: WHIRLPOOL,             isSigner: false, isWritable: true  },
      { pubkey: TOKEN_PROGRAM_ID,      isSigner: false, isWritable: false }, // tokenProgramA (USDC = SPL)
      { pubkey: TOKEN_2022_PROGRAM_ID, isSigner: false, isWritable: false }, // tokenProgramB (HOP = T22)
      { pubkey: SPL_MEMO,              isSigner: false, isWritable: false },
      { pubkey: args.positionAuthority, isSigner: true,  isWritable: false },
      { pubkey: POSITION,              isSigner: false, isWritable: true  },
      { pubkey: POSITION_TOKEN_ACCT,   isSigner: false, isWritable: false },
      { pubkey: USDC_MINT,             isSigner: false, isWritable: false }, // tokenMintA
      { pubkey: HOP_MINT,              isSigner: false, isWritable: false }, // tokenMintB
      { pubkey: args.ownerA,           isSigner: false, isWritable: true  }, // tokenOwnerAccountA
      { pubkey: args.ownerB,           isSigner: false, isWritable: true  }, // tokenOwnerAccountB
      { pubkey: TOKEN_VAULT_A,         isSigner: false, isWritable: true  },
      { pubkey: TOKEN_VAULT_B,         isSigner: false, isWritable: true  },
      { pubkey: TICK_ARRAY_LOWER,      isSigner: false, isWritable: true  },
      { pubkey: TICK_ARRAY_UPPER,      isSigner: false, isWritable: true  },
    ],
    data: Buffer.concat([
      INCREASE_LIQ_V2_DISC,
      u128Le(args.liquidityAmount),
      u64Le(args.tokenMaxA),
      u64Le(args.tokenMaxB),
      Buffer.from([0x00]), // remaining_accounts_info = None
    ]),
  });
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  const rpc        = process.env.SOLANA_RPC_URL || process.env.RPC_URL || "https://api.mainnet-beta.solana.com";
  const dryRun     = process.env.DRY_RUN !== "false";
  const allowLive  = process.env.ALLOW_LIVE === "true";
  const addUsdcUi  = Number(process.env.ADD_USDC    || "50");
  const slippBps   = BigInt(process.env.SLIPPAGE_BPS || "200"); // 2%

  const conn  = new Connection(rpc, "confirmed");
  const crank = loadKeypair("keys/crank.json");

  const crankUsdcAta = getAssociatedTokenAddressSync(USDC_MINT, crank.publicKey, false, TOKEN_PROGRAM_ID);
  const crankHopAta  = getAssociatedTokenAddressSync(HOP_MINT,  crank.publicKey, false, TOKEN_2022_PROGRAM_ID);

  // ─── Read pool + mint state ────────────────────────────────────────────────

  const [wpInfo, mintInfo, epochInfo, crankUsdcBal, crankHopBal] = await Promise.all([
    conn.getAccountInfo(WHIRLPOOL, "confirmed"),
    getMint(conn, HOP_MINT, "confirmed", TOKEN_2022_PROGRAM_ID),
    conn.getEpochInfo(),
    conn.getTokenAccountBalance(crankUsdcAta, "confirmed").catch(() => null),
    conn.getTokenAccountBalance(crankHopAta, "confirmed").catch(() => null),
  ]);

  if (!wpInfo) throw new Error("Whirlpool not found");
  const wpBuf = Buffer.from(wpInfo.data);
  const liquidity = readU128LE(wpBuf, WP_LIQUIDITY_OFFSET);
  const sqrtPrice = readU128LE(wpBuf, WP_SQRT_PRICE_OFFSET);

  const feeConf = getTransferFeeConfig(mintInfo);
  if (!feeConf) throw new Error("HOP missing TransferFeeConfig");
  const activeFee = epochInfo.epoch >= Number(feeConf.newerTransferFee.epoch)
    ? feeConf.newerTransferFee : feeConf.olderTransferFee;
  const t22Bps = BigInt(activeFee.transferFeeBasisPoints);

  const sqrtPLower = tickToSqrtPriceX64(POSITION_TICK_LOWER);
  const sqrtPUpper = tickToSqrtPriceX64(POSITION_TICK_UPPER);
  const clampedSqrtP = sqrtPrice < sqrtPLower ? sqrtPLower
    : sqrtPrice > sqrtPUpper ? sqrtPUpper
    : sqrtPrice;

  // ─── Compute amounts ───────────────────────────────────────────────────────

  const addUsdcRaw = BigInt(Math.round(addUsdcUi * 1e6));

  // Liquidity delta from USDC (token A)
  const liqDelta = liquidityFromAmountA(addUsdcRaw, clampedSqrtP, sqrtPUpper);

  // HOP vault needs to receive this much
  const hopVaultNeeds = amountBFromLiquidity(liqDelta, clampedSqrtP, sqrtPLower);

  // Crank must SEND more HOP so vault receives hopVaultNeeds after T22 withhold
  // vault_receive = send * (10000 - t22Bps) / 10000  →  send = vault_receive * 10000 / (10000 - t22Bps)
  const hopSendRaw = t22Bps < 10_000n
    ? (hopVaultNeeds * 10_000n + (10_000n - t22Bps - 1n)) / (10_000n - t22Bps)
    : 0n;

  // token_max_a = USDC with slippage (vault receives = crank sends for SPL token)
  const tokenMaxA = addUsdcRaw + (addUsdcRaw * slippBps) / 10_000n;
  // token_max_b = HOP crank sends (gross, after T22 withhold) with slippage
  const tokenMaxB = hopSendRaw + (hopSendRaw * slippBps) / 10_000n;

  const hopSendUi    = Number(hopSendRaw) / 1e6;
  const hopVaultUi   = Number(hopVaultNeeds) / 1e6;
  const impliedPrice = Number(sqrtPrice) / Number(Q64);
  const impliedPriceUsdc = impliedPrice * impliedPrice;

  console.log("=== ADD LIQUIDITY TO HOP/USDC POSITION ===");
  console.log(`pool:            ${WHIRLPOOL.toBase58()}`);
  console.log(`position:        ${POSITION.toBase58()}`);
  console.log(`ticks:           [${POSITION_TICK_LOWER}, ${POSITION_TICK_UPPER}]`);
  console.log(`crank:           ${crank.publicKey.toBase58()}`);
  console.log(`pool liquidity:  ${liquidity}`);
  console.log(`pool price:      $${impliedPriceUsdc.toFixed(8)}/HOP`);
  console.log(`T22 fee:         ${t22Bps} bps`);
  console.log(`crank USDC:      $${Number(crankUsdcBal?.value.amount ?? 0) / 1e6}`);
  console.log(`crank HOP:       ${Number(crankHopBal?.value.amount ?? 0) / 1e6}`);
  console.log();
  console.log(`add USDC:        $${addUsdcUi}`);
  console.log(`liq delta:       ${liqDelta}`);
  console.log(`HOP vault recv:  ${hopVaultUi.toFixed(6)} HOP`);
  console.log(`HOP crank sends: ${hopSendUi.toFixed(6)} HOP (gross, T22 takes ${t22Bps}bps)`);
  console.log(`token_max_a:     ${Number(tokenMaxA)/1e6} USDC (${slippBps}bps slippage)`);
  console.log(`token_max_b:     ${Number(tokenMaxB)/1e6} HOP (${slippBps}bps slippage)`);
  console.log(`dry run:         ${dryRun}`);
  console.log();

  // ─── Build TX ──────────────────────────────────────────────────────────────

  const ix = increaseLiquidityV2Ix({
    positionAuthority: crank.publicKey,
    ownerA: crankUsdcAta,
    ownerB: crankHopAta,
    liquidityAmount: liqDelta,
    tokenMaxA,
    tokenMaxB,
  });

  const tx = new Transaction();
  tx.add(ComputeBudgetProgram.setComputeUnitLimit({ units: 200_000 }));
  tx.add(ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 1_000 }));
  tx.add(ix);
  tx.recentBlockhash = (await conn.getLatestBlockhash("confirmed")).blockhash;
  tx.feePayer = crank.publicKey;

  // ─── Simulate ─────────────────────────────────────────────────────────────

  console.log("Simulating...");
  const sim = await conn.simulateTransaction(tx);
  const simLogs = (sim.value.logs ?? []).slice(-15);
  simLogs.forEach(l => console.log(" ", l));
  console.log(`Sim err: ${sim.value.err ? JSON.stringify(sim.value.err) : "null"}`);
  console.log(`Sim CU:  ${sim.value.unitsConsumed ?? "?"}`);

  const receipt = {
    verdict: sim.value.err ? "SIM_FAILED" : "SIM_OK",
    timestamp: new Date().toISOString(),
    position: POSITION.toBase58(),
    whirlpool: WHIRLPOOL.toBase58(),
    addUsdcUi,
    liqDelta: liqDelta.toString(),
    hopVaultRecv: hopVaultUi.toFixed(6),
    hopCrankSends: hopSendUi.toFixed(6),
    tokenMaxA: (Number(tokenMaxA) / 1e6).toFixed(6),
    tokenMaxB: (Number(tokenMaxB) / 1e6).toFixed(6),
    t22Bps: t22Bps.toString(),
    poolPrice: impliedPriceUsdc.toFixed(8),
    simCu: sim.value.unitsConsumed ?? null,
    simErr: sim.value.err ?? null,
    signature: null as string | null,
    dryRun,
  };

  if (sim.value.err) {
    writeReceipt("add-liquidity-hop", receipt);
    console.error("SIM_FAILED — aborting");
    process.exitCode = 1;
    return;
  }

  if (dryRun || !allowLive) {
    console.log("\nSIM_OK — DRY_RUN. Set DRY_RUN=false ALLOW_LIVE=true to execute.");
    writeReceipt("add-liquidity-hop", receipt);
    return;
  }

  // ─── Live send ─────────────────────────────────────────────────────────────

  const sig = await sendAndConfirmTransaction(conn, tx, [crank], { commitment: "confirmed" });
  receipt.verdict   = "EXECUTED";
  receipt.signature = sig;
  console.log(`\nEXECUTED: ${sig}`);
  console.log(`+$${addUsdcUi} USDC + ${hopSendUi.toFixed(2)} HOP added to position.`);

  writeReceipt("add-liquidity-hop", receipt);
}

main().catch(e => { console.error(e); process.exitCode = 1; });
