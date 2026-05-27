/**
 * fee-collector.ts — Centralized fee harvester.
 *
 * Runs as a singleton (one instance, default shard 0 authority).
 * Collects:
 *   1. Protocol fees from Whirlpool (USDC + HOP)
 *   2. LP fees from position (USDC + HOP)
 *   3. T22 withheld fees (harvest → mint → withdraw to crank HOP ATA)
 *   4. Optional: swap collected HOP → USDC
 *
 * ENV:
 *   DRY_RUN=true
 *   ALLOW_LIVE=false
 *   SWAP_HOP_TO_USDC=true   (run swap_v2 HOP→USDC after collection)
 *   CU_LIMIT=400000
 *   CU_PRICE=1000
 */

import "dotenv/config";
import {
  Connection, Keypair, PublicKey, Transaction, TransactionInstruction,
  ComputeBudgetProgram, SystemProgram,
} from "@solana/web3.js";
import {
  TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID,
  getAssociatedTokenAddressSync,
  createHarvestWithheldTokensToMintInstruction,
  createWithdrawWithheldTokensFromMintInstruction,
} from "@solana/spl-token";
import { getShardConfig } from "../utils/shard.js";
import { loadKeypair } from "../utils/keypair.js";
import { writeReceipt } from "../utils/receipt.js";

// ─── Constants ───────────────────────────────────────────────────────────────

const WHIRLPOOL_PROGRAM  = new PublicKey("GxRHMB9a6XE8BqGPeNb9UkJUPvbvrPoPgNTJPJJA4n8h");
const WHIRLPOOL          = new PublicKey("8aoWgf7ycbeKv6BTFCdUj4JR7Y4mXWuPZWEUhmuzN5ZL");
const WHIRLPOOLS_CONFIG  = new PublicKey("9Nr7o1muxPfcsxv4WtTN2GdUFKhUsdR7WHejyJdesTmZ");
const TOKEN_VAULT_A      = new PublicKey("4QD4GgnjRvjETqWLT5e3x7SHtJSzs9kShUPLfyHcTu7d");
const TOKEN_VAULT_B      = new PublicKey("Qv51R47g7pMDxa3UofXaz8cNr8pwRSXaNufgnEWX8Yk");
const TICK_ARRAY_84480   = new PublicKey("be9QKj4mYB8erh6r4ZDrKxxSvSYSUNRfpTxqJUgd3jG");
const TICK_ARRAY_90112   = new PublicKey("CDMSB5e6WUgtoSLrybvYm4j58Jue3eqpzHQVLmgVkAe4");
const TICK_ARRAY_95744   = new PublicKey("MXd8HXPjcH9ZCuyr4uKKyN7GkJ5YizZQkgUndB6J8Gz");
const ORACLE             = new PublicKey("5qhXANMqTNNzdp1N1PrMzWzSzjHTZxuLPELcmpog6bp5");

const POSITION           = new PublicKey("ErgQU48egJMNBLZeVkdjrtZrSWUQJCky3deh2B4U1YPQ");
const POSITION_MINT      = new PublicKey("21GvQjZagJKZT9nVwAKnXQpSicnNj5X6UvBjZY3SRu8R");
const POSITION_TOKEN_ACCOUNT = new PublicKey("GgLpt3VY9vWKLnNa5Dj3FKvBn3JEDL4KTKpabCAfL54Q");
const TICK_ARRAY_LOWER   = TICK_ARRAY_84480;
const TICK_ARRAY_UPPER   = TICK_ARRAY_95744;
const SPL_MEMO           = new PublicKey("MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr");

const USDC_MINT = new PublicKey("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v");
const HOP_MINT  = new PublicKey("HZF5k7h39hkysoSZ4ZfmWc55PhvW7ntVvVqdXFCyYGh3");

const COLLECT_PROTOCOL_FEES_V2_DISC = Buffer.from([0x67, 0x80, 0xde, 0x86, 0x72, 0xc8, 0x16, 0xc8]);
const COLLECT_FEES_V2_DISC = Buffer.from([0xcf, 0x75, 0x5f, 0xbf, 0xe5, 0xb4, 0xe2, 0x0f]);
const SWAP_V2_DISC = Buffer.from([0x2b, 0x04, 0xed, 0x0b, 0x1a, 0xc9, 0x1e, 0x62]);

const Q64 = 1n << 64n;
const MIN_SQRT_PRICE = 4295048016n;
const MAX_SQRT_PRICE = 79226673515401279992447579055n;

// ─── Helpers ─────────────────────────────────────────────────────────────────

function u64Le(n: bigint): Buffer { const b = Buffer.alloc(8); b.writeBigUInt64LE(n); return b; }
function u128Le(n: bigint): Buffer {
  const b = Buffer.alloc(16);
  b.writeBigUInt64LE(n & ((1n << 64n) - 1n), 0);
  b.writeBigUInt64LE(n >> 64n, 8);
  return b;
}
function i32Le(n: number): Buffer { const b = Buffer.alloc(4); b.writeInt32LE(n); return b; }

function swapV2Ix(args: {
  tokenAuthority: PublicKey; tokenOwnerAccountA: PublicKey; tokenOwnerAccountB: PublicKey;
  tickArray0: PublicKey; tickArray1: PublicKey; tickArray2: PublicKey;
  amount: bigint; otherAmountThreshold: bigint; sqrtPriceLimit: bigint;
  amountSpecifiedIsInput: boolean; aToB: boolean;
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
    programId: WHIRLPOOL_PROGRAM,
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
      { pubkey: WHIRLPOOL_PROGRAM, isSigner: false, isWritable: false },
      { pubkey: args.aToB ? TOKEN_PROGRAM_ID : TOKEN_2022_PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: args.aToB ? TOKEN_2022_PROGRAM_ID : TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
    ],
    data,
  });
}

function collectProtocolFeesV2Ix(authority: PublicKey, authUsdcAta: PublicKey, authHopAta: PublicKey): TransactionInstruction {
  return new TransactionInstruction({
    programId: WHIRLPOOL_PROGRAM,
    keys: [
      { pubkey: WHIRLPOOLS_CONFIG, isSigner: false, isWritable: false },
      { pubkey: WHIRLPOOL, isSigner: false, isWritable: true },
      { pubkey: authority, isSigner: true, isWritable: false },
      { pubkey: authUsdcAta, isSigner: false, isWritable: true },
      { pubkey: authHopAta, isSigner: false, isWritable: true },
      { pubkey: TOKEN_VAULT_A, isSigner: false, isWritable: true },
      { pubkey: TOKEN_VAULT_B, isSigner: false, isWritable: true },
      { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: TOKEN_2022_PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: SPL_MEMO, isSigner: false, isWritable: false },
    ],
    data: COLLECT_PROTOCOL_FEES_V2_DISC,
  });
}

function collectFeesV2Ix(authority: PublicKey, position: PublicKey, positionTokenAccount: PublicKey, positionMint: PublicKey,
  authUsdcAta: PublicKey, authHopAta: PublicKey): TransactionInstruction {
  return new TransactionInstruction({
    programId: WHIRLPOOL_PROGRAM,
    keys: [
      { pubkey: authority, isSigner: true, isWritable: false },
      { pubkey: WHIRLPOOL, isSigner: false, isWritable: true },
      { pubkey: position, isSigner: false, isWritable: true },
      { pubkey: positionTokenAccount, isSigner: false, isWritable: false },
      { pubkey: positionMint, isSigner: false, isWritable: false },
      { pubkey: authUsdcAta, isSigner: false, isWritable: true },
      { pubkey: authHopAta, isSigner: false, isWritable: true },
      { pubkey: TOKEN_VAULT_A, isSigner: false, isWritable: true },
      { pubkey: TOKEN_VAULT_B, isSigner: false, isWritable: true },
      { pubkey: TICK_ARRAY_LOWER, isSigner: false, isWritable: true },
      { pubkey: TICK_ARRAY_UPPER, isSigner: false, isWritable: true },
      { pubkey: WHIRLPOOL_PROGRAM, isSigner: false, isWritable: false },
      { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: TOKEN_2022_PROGRAM_ID, isSigner: false, isWritable: false },
    ],
    data: COLLECT_FEES_V2_DISC,
  });
}

// ─── Main ────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const rpcUrl    = process.env.SOLANA_RPC_URL || "https://api.mainnet-beta.solana.com";
  const dryRun    = process.env.DRY_RUN !== "false";
  const allowLive = process.env.ALLOW_LIVE === "true";
  const doSwap    = process.env.SWAP_HOP_TO_USDC === "true";
  const cuLimit   = Number(process.env.CU_LIMIT || "400000");
  const cuPrice   = Number(process.env.CU_PRICE || "1000");
  const conn      = new Connection(rpcUrl, "confirmed");

  const shard = getShardConfig();
  const authority = shard ? shard.crank : loadKeypair(process.env.CRANK_KEYPAIR_PATH || "keys/crank.json");

  const authUsdcAta = getAssociatedTokenAddressSync(USDC_MINT, authority.publicKey, false, TOKEN_PROGRAM_ID);
  const authHopAta  = getAssociatedTokenAddressSync(HOP_MINT,  authority.publicKey, false, TOKEN_2022_PROGRAM_ID);

  console.log("=== FEE COLLECTOR ===");
  console.log(`authority: ${authority.publicKey.toBase58()}`);
  console.log(`USDC ATA:  ${authUsdcAta.toBase58()}`);
  console.log(`HOP ATA:   ${authHopAta.toBase58()}`);
  console.log(`swap HOP→USDC: ${doSwap}`);
  console.log();

  const ixs: TransactionInstruction[] = [];
  ixs.push(ComputeBudgetProgram.setComputeUnitLimit({ units: cuLimit }));
  ixs.push(ComputeBudgetProgram.setComputeUnitPrice({ microLamports: cuPrice }));

  // 1. Collect protocol fees
  ixs.push(collectProtocolFeesV2Ix(authority.publicKey, authUsdcAta, authHopAta));

  // 2. Collect LP fees
  ixs.push(collectFeesV2Ix(authority.publicKey, POSITION, POSITION_TOKEN_ACCOUNT, POSITION_MINT, authUsdcAta, authHopAta));

  // 3. T22 harvest + withdraw
  // Harvest from all known fee-bearing ATAs into mint (authority ATA + vaults)
  const harvestAccounts = [authHopAta, TOKEN_VAULT_B];
  ixs.push(createHarvestWithheldTokensToMintInstruction(HOP_MINT, harvestAccounts, TOKEN_2022_PROGRAM_ID));
  ixs.push(createWithdrawWithheldTokensFromMintInstruction(
    HOP_MINT, authHopAta, authority.publicKey, [], TOKEN_2022_PROGRAM_ID
  ));

  // 4. Optional swap HOP→USDC
  if (doSwap) {
    // Read HOP balance to swap all
    const hopBalance = await conn.getTokenAccountBalance(authHopAta, "confirmed")
      .then((b) => BigInt(b.value.amount))
      .catch(() => 0n);
    if (hopBalance > 0n) {
      console.log(`Swap HOP→USDC: ${hopBalance} lamports`);
      ixs.push(swapV2Ix({
        tokenAuthority: authority.publicKey,
        tokenOwnerAccountA: authUsdcAta,
        tokenOwnerAccountB: authHopAta,
        tickArray0: TICK_ARRAY_84480,
        tickArray1: TICK_ARRAY_90112,
        tickArray2: TICK_ARRAY_95744,
        amount: hopBalance,
        otherAmountThreshold: 0n,
        sqrtPriceLimit: MIN_SQRT_PRICE,
        amountSpecifiedIsInput: true,
        aToB: false,
      }));
    } else {
      console.log("No HOP to swap.");
    }
  }

  const tx = new Transaction();
  tx.add(...ixs);
  tx.recentBlockhash = (await conn.getLatestBlockhash("confirmed")).blockhash;
  tx.feePayer = authority.publicKey;

  const receipt: Record<string, unknown> = {
    timestamp: new Date().toISOString(),
    dryRun,
    authority: authority.publicKey.toBase58(),
    ixCount: ixs.length,
    doSwap,
    signature: null as string | null,
    simErr: null as string | null,
    simLogs: null as string[] | null,
    unitsConsumed: null as number | null,
  };

  if (dryRun || !allowLive) {
    tx.partialSign(authority);
    const sim = await conn.simulateTransaction(tx);
    receipt.simErr = sim.value.err ? JSON.stringify(sim.value.err) : null;
    receipt.simLogs = (sim.value.logs ?? []).slice(-20);
    receipt.unitsConsumed = sim.value.unitsConsumed ?? null;
    receipt.verdict = sim.value.err ? "SIM_FAILED" : "SIM_OK";
    console.log(`SIM ${receipt.verdict} cu=${sim.value.unitsConsumed}`);
    if (sim.value.err) console.log("ERR:", JSON.stringify(sim.value.err));
    if (sim.value.logs) console.log("LOGS:\n" + sim.value.logs.slice(-8).join("\n"));
  } else {
    const sig = await conn.sendTransaction(tx, [authority], { skipPreflight: false });
    await conn.confirmTransaction({ signature: sig, ...await conn.getLatestBlockhash("confirmed") }, "confirmed");
    receipt.signature = sig;
    receipt.verdict = "EXECUTED";
    console.log(`EXECUTED: ${sig}`);
  }

  const ts = receipt.timestamp as string;
  const receiptPath = writeReceipt(`fee-collector-${ts.replace(/[:.]/g, "-")}.json`, receipt);
  console.log(`Receipt: ${receiptPath}`);
}

main().catch((e) => { console.error(e); process.exitCode = 1; });
