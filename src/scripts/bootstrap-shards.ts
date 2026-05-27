/**
 * bootstrap-shards.ts — One-time on-chain setup for all crank shards.
 *
 * Per shard:
 *   1. Create MarginFi account (if missing)
 *   2. Create USDC ATA for crank (idempotent)
 *   3. Create HOP ATA for crank (idempotent)
 *   4. Create HOP ATAs for ring1..ring4 (idempotent)
 *   5. Approve crank as delegate (u64::MAX) on each ring HOP ATA
 *
 * Requires:
 *   - crank-{id}.json funded with SOL (~0.03 SOL per shard)
 *   - ring-{id}-1..4.json accessible (to sign approve)
 *   - mint authority if minting HOP (optional)
 *
 * ENV:
 *   SHARD_IDS=0,1,2,3    (explicit, or auto-detect)
 *   DRY_RUN=true
 *   ALLOW_LIVE=false
 *   MINT_AUTH_PATH=keys/old-fee-config-auth.json
 *   MINT_AMOUNT_HOP_PER_SHARD=100000
 */

import "dotenv/config";
import {
  Connection, Keypair, PublicKey, SystemProgram,
  Transaction, TransactionInstruction, sendAndConfirmTransaction,
} from "@solana/web3.js";
import {
  TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID,
  getAssociatedTokenAddressSync,
  createAssociatedTokenAccountIdempotentInstruction,
  createApproveCheckedInstruction,
  createMintToInstruction,
} from "@solana/spl-token";
import { listShards, getShardConfig } from "../utils/shard.js";
import { loadKeypair } from "../utils/keypair.js";
import { writeReceipt } from "../utils/receipt.js";

const MARGINFI_PROGRAM = new PublicKey("MFv2hWf31Z9kbCa1snEPYctwafyhdvnV7FZnsebVacA");
const MARGINFI_GROUP   = new PublicKey("4qp6Fx6tnZkY5Wropq9wUYgtFxXKwE6viZxFHg3rdAG8");
const INIT_MARGINFI_ACCOUNT_DISCRIMINATOR = Buffer.from([43, 78, 61, 255, 148, 52, 249, 154]);

const HOP_MINT  = new PublicKey("HZF5k7h39hkysoSZ4ZfmWc55PhvW7ntVvVqdXFCyYGh3");
const HOP_DECIMALS = 6;
const USDC_MINT = new PublicKey("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v");

function marginfiInitIx(account: PublicKey, crank: PublicKey): TransactionInstruction {
  return new TransactionInstruction({
    programId: MARGINFI_PROGRAM,
    keys: [
      { pubkey: MARGINFI_GROUP, isSigner: false, isWritable: false },
      { pubkey: account, isSigner: true, isWritable: true },
      { pubkey: crank, isSigner: true, isWritable: false },
      { pubkey: crank, isSigner: true, isWritable: true },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    data: INIT_MARGINFI_ACCOUNT_DISCRIMINATOR,
  });
}

async function main(): Promise<void> {
  const rpcUrl    = process.env.SOLANA_RPC_URL || "https://api.mainnet-beta.solana.com";
  const dryRun    = process.env.DRY_RUN !== "false";
  const allowLive = process.env.ALLOW_LIVE === "true";
  const conn      = new Connection(rpcUrl, "confirmed");

  const shardIds = process.env.SHARD_IDS
    ? process.env.SHARD_IDS.split(",").map((s) => Number(s.trim()))
    : listShards();

  const doMint = process.env.MINT_AUTH_PATH && process.env.MINT_AMOUNT_HOP_PER_SHARD;
  const mintAuth = doMint ? loadKeypair(process.env.MINT_AUTH_PATH!) : null;
  const mintAmountPerShard = doMint
    ? BigInt(process.env.MINT_AMOUNT_HOP_PER_SHARD!) * BigInt(10 ** HOP_DECIMALS)
    : 0n;

  const results: Record<string, unknown>[] = [];

  for (const shardId of shardIds) {
    console.log(`\n=== Shard ${shardId} ===`);
    const shard = getShardConfig(shardId);
    if (!shard) {
      console.log(`  SKIP: config not found`);
      continue;
    }

    const crank = shard.crank;
    const mfAccount = shard.marginfiAccountPubkey;
    const rings = shard.ringPaths.map(loadKeypair);

    const ixs: TransactionInstruction[] = [];
    const signers: Keypair[] = [crank];

    // 1. MarginFi account
    const mfInfo = await conn.getAccountInfo(mfAccount, "confirmed");
    if (!mfInfo) {
      console.log(`  MarginFi account: ${mfAccount.toBase58()} — MISSING, will create`);
      ixs.push(marginfiInitIx(mfAccount, crank.publicKey));
      signers.push(loadKeypair(shard.marginfiAccountPath));
    } else {
      console.log(`  MarginFi account: ${mfAccount.toBase58()} — EXISTS`);
    }

    // 2. USDC ATA for crank
    const usdcAta = getAssociatedTokenAddressSync(USDC_MINT, crank.publicKey, false, TOKEN_PROGRAM_ID);
    ixs.push(createAssociatedTokenAccountIdempotentInstruction(
      crank.publicKey, usdcAta, crank.publicKey, USDC_MINT, TOKEN_PROGRAM_ID
    ));

    // 3. HOP ATA for crank
    const hopAtaCrank = getAssociatedTokenAddressSync(HOP_MINT, crank.publicKey, false, TOKEN_2022_PROGRAM_ID);
    ixs.push(createAssociatedTokenAccountIdempotentInstruction(
      crank.publicKey, hopAtaCrank, crank.publicKey, HOP_MINT, TOKEN_2022_PROGRAM_ID
    ));

    // 4. HOP ATAs for rings + approve crank as delegate
    for (let i = 0; i < rings.length; i++) {
      const ring = rings[i];
      const ringAta = getAssociatedTokenAddressSync(HOP_MINT, ring.publicKey, false, TOKEN_2022_PROGRAM_ID);
      ixs.push(createAssociatedTokenAccountIdempotentInstruction(
        crank.publicKey, ringAta, ring.publicKey, HOP_MINT, TOKEN_2022_PROGRAM_ID
      ));
      ixs.push(createApproveCheckedInstruction(
        ringAta, HOP_MINT, crank.publicKey, ring.publicKey,
        BigInt("18446744073709551615"), HOP_DECIMALS, [], TOKEN_2022_PROGRAM_ID
      ));
      signers.push(ring);
    }

    // 5. Optional: mint HOP to crank ATA
    if (mintAuth && mintAmountPerShard > 0n) {
      ixs.push(createMintToInstruction(
        HOP_MINT, hopAtaCrank, mintAuth.publicKey, mintAmountPerShard, [], TOKEN_2022_PROGRAM_ID
      ));
      if (!signers.some((k) => k.publicKey.equals(mintAuth.publicKey))) {
        signers.push(mintAuth);
      }
    }

    if (ixs.length === 0) {
      console.log(`  Nothing to do — all accounts exist.`);
      results.push({ shardId, verdict: "ALREADY_INITIALIZED" });
      continue;
    }

    const tx = new Transaction();
    tx.add(...ixs);
    tx.recentBlockhash = (await conn.getLatestBlockhash("confirmed")).blockhash;
    tx.feePayer = crank.publicKey;

    if (dryRun || !allowLive) {
      tx.partialSign(...signers);
      const sim = await conn.simulateTransaction(tx);
      const verdict = sim.value.err ? "SIM_FAILED" : "SIM_OK";
      console.log(`  ${verdict}${sim.value.err ? " err=" + JSON.stringify(sim.value.err) : ""}`);
      if (sim.value.logs) console.log("  logs:", sim.value.logs.slice(-4));
      results.push({ shardId, verdict, err: sim.value.err ?? null, accounts: ixs.length });
    } else {
      const sig = await sendAndConfirmTransaction(conn, tx, signers, { commitment: "confirmed" });
      console.log(`  EXECUTED: ${sig}`);
      results.push({ shardId, verdict: "EXECUTED", signature: sig, accounts: ixs.length });
    }
  }

  const receiptName = `bootstrap-shards-${new Date().toISOString().replace(/[:.]/g, "-")}.json`;
  const receiptPath = writeReceipt(receiptName, { dryRun, shardIds, results });
  console.log(`\nReceipt: ${receiptPath}`);
}

main().catch((e) => { console.error(e); process.exitCode = 1; });
