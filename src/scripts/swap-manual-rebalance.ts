/**
 * SWAP MANUAL REBALANCE — one-shot USDC→HOP swap in our Orca Whirlpool fork.
 * Brings current tick from ~98034 down to ~94000 by selling USDC into the pool.
 * NOT part of the loop. Run once to rebalance tick.
 *
 * ENV:
 *   SOLANA_RPC_URL    (required)
 *   DRY_RUN=false     (default true; sim only)
 *   ALLOW_LIVE=true   (required to send)
 */

import "dotenv/config";
import fs from "node:fs";
import {
  Connection,
  Keypair,
  PublicKey,
  TransactionInstruction,
  TransactionMessage,
  VersionedTransaction,
  ComputeBudgetProgram,
} from "@solana/web3.js";
import {
  TOKEN_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ID,
  getAssociatedTokenAddressSync,
} from "@solana/spl-token";

// ─── Constants ───────────────────────────────────────────────────────────────

const WHIRLPOOL_PROGRAM = new PublicKey("GxRHMB9a6XE8BqGPeNb9UkJUPvbvrPoPgNTJPJJA4n8h");
const WHIRLPOOL         = new PublicKey("8aoWgf7ycbeKv6BTFCdUj4JR7Y4mXWuPZWEUhmuzN5ZL");
const TOKEN_VAULT_A     = new PublicKey("4QD4GgnjRvjETqWLT5e3x7SHtJSzs9kShUPLfyHcTu7d");
const TOKEN_VAULT_B     = new PublicKey("Qv51R47g7pMDxa3UofXaz8cNr8pwRSXaNufgnEWX8Yk");
const TICK_ARRAY_84480  = new PublicKey("be9QKj4mYB8erh6r4ZDrKxxSvSYSUNRfpTxqJUgd3jG");
const TICK_ARRAY_90112  = new PublicKey("CDMSB5e6WUgtoSLrybvYm4j58Jue3eqpzHQVLmgVkAe4");
const TICK_ARRAY_95744  = new PublicKey("MXd8HXPjcH9ZCuyr4uKKyN7GkJ5YizZQkgUndB6J8Gz");
const ORACLE            = new PublicKey("5qhXANMqTNNzdp1N1PrMzWzSzjHTZxuLPELcmpog6bp5");
const SPL_MEMO          = new PublicKey("MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr");
const USDC_MINT         = new PublicKey("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v");
const HOP_MINT          = new PublicKey("HZF5k7h39hkysoSZ4ZfmWc55PhvW7ntVvVqdXFCyYGh3");
const SWAP_V2_DISC      = Buffer.from([0x2b, 0x04, 0xed, 0x0b, 0x1a, 0xc9, 0x1e, 0x62]);
const TOKEN_PROGRAM_ID_PK    = new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
const TOKEN_2022_PROGRAM_ID_PK = new PublicKey("TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb");
const WP_TICK_INDEX_OFFSET   = 81;
const WP_SQRT_PRICE_OFFSET   = 65;

// ─── Helpers ─────────────────────────────────────────────────────────────────

function loadKeypair(p: string): Keypair {
  return Keypair.fromSecretKey(
    Uint8Array.from(JSON.parse(fs.readFileSync(p, "utf8")) as number[])
  );
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

function tickToSqrtPriceX64(tick: number): bigint {
  const sqrtPrice = Math.pow(1.0001, tick / 2);
  const scale = 1_000_000_000n;
  const Q64 = 1n << 64n;
  return (BigInt(Math.round(sqrtPrice * Number(scale))) * Q64) / scale;
}

function readI32LE(buf: Buffer, off: number): number { return buf.readInt32LE(off); }
function readU128LE(buf: Buffer, off: number): bigint {
  return buf.readBigUInt64LE(off) | (buf.readBigUInt64LE(off + 8) << 64n);
}

// ─── Swap IX builder ─────────────────────────────────────────────────────────

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
      { pubkey: TOKEN_PROGRAM_ID_PK,      isSigner: false, isWritable: false },
      { pubkey: TOKEN_2022_PROGRAM_ID_PK, isSigner: false, isWritable: false },
      { pubkey: SPL_MEMO,                 isSigner: false, isWritable: false },
      { pubkey: args.authority,           isSigner: true,  isWritable: false },
      { pubkey: WHIRLPOOL,                isSigner: false, isWritable: true  },
      { pubkey: USDC_MINT,                isSigner: false, isWritable: false },
      { pubkey: HOP_MINT,                 isSigner: false, isWritable: true  },
      { pubkey: args.ownerA,              isSigner: false, isWritable: true  },
      { pubkey: TOKEN_VAULT_A,            isSigner: false, isWritable: true  },
      { pubkey: args.ownerB,              isSigner: false, isWritable: true  },
      { pubkey: TOKEN_VAULT_B,            isSigner: false, isWritable: true  },
      { pubkey: args.ta0,                 isSigner: false, isWritable: true  },
      { pubkey: args.ta1,                 isSigner: false, isWritable: true  },
      { pubkey: args.ta2,                 isSigner: false, isWritable: true  },
      { pubkey: ORACLE,                   isSigner: false, isWritable: true  },
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

// ─── Main ────────────────────────────────────────────────────────────────────

async function main() {
  const rpc      = process.env.SOLANA_RPC_URL || "https://api.mainnet-beta.solana.com";
  const dryRun   = process.env.DRY_RUN !== "false";
  const allowLive = process.env.ALLOW_LIVE === "true";

  const conn  = new Connection(rpc, "confirmed");
  const crank = loadKeypair("keys/crank.json");

  console.log(`Crank: ${crank.publicKey.toBase58()}`);

  // ATAs — USDC is standard SPL, HOP is Token-2022
  const ownerA = getAssociatedTokenAddressSync(USDC_MINT, crank.publicKey, false, TOKEN_PROGRAM_ID);
  const ownerB = getAssociatedTokenAddressSync(HOP_MINT,  crank.publicKey, false, TOKEN_2022_PROGRAM_ID);

  console.log(`USDC ATA: ${ownerA.toBase58()}`);
  console.log(`HOP  ATA: ${ownerB.toBase58()}`);

  // Fetch whirlpool state
  const wpInfo = await conn.getAccountInfo(WHIRLPOOL, "confirmed");
  if (!wpInfo) throw new Error("Whirlpool account not found");
  const data = Buffer.from(wpInfo.data);

  const tickBefore     = readI32LE(data, WP_TICK_INDEX_OFFSET);
  const sqrtPriceBefore = readU128LE(data, WP_SQRT_PRICE_OFFSET);

  console.log(`Tick before:       ${tickBefore}`);
  console.log(`sqrtPrice before:  ${sqrtPriceBefore}`);

  // sqrtPriceLimit for tick 93000 — lower bound for aToB swap
  const sqrtPriceLimit = tickToSqrtPriceX64(93000);
  console.log(`sqrtPriceLimit:    ${sqrtPriceLimit} (tick 93000)`);

  // Build swap IX
  // Current tick ~98034 is in TICK_ARRAY_95744 range; going down through 90112 → 84480
  const swapIx = swapV2Ix({
    authority:              crank.publicKey,
    ownerA,
    ownerB,
    ta0:                    TICK_ARRAY_95744,
    ta1:                    TICK_ARRAY_90112,
    ta2:                    TICK_ARRAY_84480,
    amount:                 184_920_000n,
    otherAmountThreshold:   0n,
    sqrtPriceLimit,
    amountSpecifiedIsInput: true,
    aToB:                   true,
  });

  // Build VersionedTransaction
  const cu      = ComputeBudgetProgram.setComputeUnitLimit({ units: 300_000 });
  const cuPrice = ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 10_000 });

  const { blockhash } = await conn.getLatestBlockhash("confirmed");
  const msg = new TransactionMessage({
    payerKey:        crank.publicKey,
    recentBlockhash: blockhash,
    instructions:    [cu, cuPrice, swapIx],
  }).compileToV0Message();

  const vtx = new VersionedTransaction(msg);
  vtx.sign([crank]);

  // Simulate always
  console.log("\n--- SIMULATION ---");
  const sim = await conn.simulateTransaction(vtx, { commitment: "confirmed" });
  console.log("Sim error:", sim.value.err ?? "none");
  const logs = sim.value.logs ?? [];
  console.log("Last 10 logs:");
  logs.slice(-10).forEach((l) => console.log(" ", l));
  console.log("---");

  if (dryRun || !allowLive) {
    console.log("\nDRY_RUN — set DRY_RUN=false ALLOW_LIVE=true to execute");
    return;
  }

  // Send
  console.log("\nSending TX...");
  const sig = await conn.sendRawTransaction(vtx.serialize(), {
    skipPreflight: false,
    maxRetries:    3,
  });
  console.log(`Sent: ${sig}`);

  const { value: status } = await conn.confirmTransaction(
    { signature: sig, blockhash, lastValidBlockHeight: (await conn.getLatestBlockhash()).lastValidBlockHeight },
    "confirmed"
  );
  if (status.err) throw new Error(`TX failed: ${JSON.stringify(status.err)}`);

  // Post-confirm state
  const wpInfo2 = await conn.getAccountInfo(WHIRLPOOL, "confirmed");
  if (!wpInfo2) throw new Error("Whirlpool not found post-confirm");
  const data2     = Buffer.from(wpInfo2.data);
  const tickAfter = readI32LE(data2, WP_TICK_INDEX_OFFSET);

  console.log(`
=== SWAP CONFIRMED ===
TX:          ${sig}
Tick before: ${tickBefore}
Tick after:  ${tickAfter}
Tick delta:  ${tickAfter - tickBefore}
USDC sent:   $184.92
sqrtPriceLimit: ${sqrtPriceLimit}
`);
}

main().catch((e) => { console.error(e); process.exit(1); });
