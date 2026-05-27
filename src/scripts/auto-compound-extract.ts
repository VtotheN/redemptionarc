/**
 * auto-compound-extract.ts — Collect LP fees + protocol fees to crank/auth wallets. NO reinvest.
 *
 * TX:
 *   [0] ComputeBudget limit
 *   [1] ComputeBudget price
 *   [2] createIdempotent withdrawAuth USDC ATA
 *   [3] createIdempotent withdrawAuth HOP ATA
 *   [4] collect_protocol_fees_v2  → withdrawAuth ATAs
 *   [5] collect_fees_v2           → crank ATAs (feeOwedA/B stay as spendable tokens)
 *   (no increase_liquidity_v2 — tokens stay extracted in wallet)
 *
 * Difference from auto-compound.ts: no reinvestment. Extracted fees remain in crank ATAs
 * and grow wallet USDC balance for next flash cycle or manual use.
 *
 * ENV:
 *   SOLANA_RPC_URL
 *   DRY_RUN=true|false
 *   ALLOW_LIVE=true|false
 *   MIN_EXTRACT_USDC=0.01    (skip if less than this claimable)
 *   CU_LIMIT=300000
 *   CU_PRICE=1000
 */

import "dotenv/config";
import fs from "node:fs";
import {
  Connection, Keypair, PublicKey, Transaction, TransactionInstruction,
  ComputeBudgetProgram,
} from "@solana/web3.js";
import {
  TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID,
  getAssociatedTokenAddressSync,
  createAssociatedTokenAccountIdempotentInstruction as createIdempotentAta,
} from "@solana/spl-token";
import { writeReceipt } from "../utils/receipt.js";

// ─── Constants ───────────────────────────────────────────────────────────────

const WHIRLPOOL_PROGRAM  = new PublicKey("GxRHMB9a6XE8BqGPeNb9UkJUPvbvrPoPgNTJPJJA4n8h");
const WHIRLPOOL          = new PublicKey("8aoWgf7ycbeKv6BTFCdUj4JR7Y4mXWuPZWEUhmuzN5ZL");
const WHIRLPOOLS_CONFIG  = new PublicKey("9Nr7o1muxPfcsxv4WtTN2GdUFKhUsdR7WHejyJdesTmZ");
const TOKEN_VAULT_A      = new PublicKey("4QD4GgnjRvjETqWLT5e3x7SHtJSzs9kShUPLfyHcTu7d");
const TOKEN_VAULT_B      = new PublicKey("Qv51R47g7pMDxa3UofXaz8cNr8pwRSXaNufgnEWX8Yk");
const POSITION           = new PublicKey("ErgQU48egJMNBLZeVkdjrtZrSWUQJCky3deh2B4U1YPQ");
const SPL_MEMO           = new PublicKey("MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr");

const USDC_MINT = new PublicKey("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v");
const HOP_MINT  = new PublicKey("HZF5k7h39hkysoSZ4ZfmWc55PhvW7ntVvVqdXFCyYGh3");

// Pool data offsets
const WP_PROTO_FEE_A_OFFSET = 85;
const WP_PROTO_FEE_B_OFFSET = 93;

// Position data offsets
const POS_FEE_OWED_A_OFFSET = 112;
const POS_FEE_OWED_B_OFFSET = 136;

const POSITION_MINT              = new PublicKey("21GvQjZagJKZT9nVwAKnXQpSicnNj5X6UvBjZY3SRu8R");

const COLLECT_PROTOCOL_FEES_V2_DISC = Buffer.from([0x67, 0x80, 0xde, 0x86, 0x72, 0xc8, 0x16, 0xc8]);
const COLLECT_FEES_V2_DISC          = Buffer.from([0xcf, 0x75, 0x5f, 0xbf, 0xe5, 0xb4, 0xe2, 0x0f]);

// ─── Helpers ─────────────────────────────────────────────────────────────────

function loadKp(p: string): Keypair {
  return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(p, "utf8")) as number[]));
}

function readU64LE(buf: Buffer, offset: number): bigint {
  return buf.readBigUInt64LE(offset);
}

// ─── Instruction builders ────────────────────────────────────────────────────

function collectProtocolFeesV2Ix(args: {
  authority: PublicKey;
  destA: PublicKey;
  destB: PublicKey;
}): TransactionInstruction {
  return new TransactionInstruction({
    programId: WHIRLPOOL_PROGRAM,
    keys: [
      { pubkey: WHIRLPOOLS_CONFIG,     isSigner: false, isWritable: false },
      { pubkey: WHIRLPOOL,             isSigner: false, isWritable: true  },
      { pubkey: args.authority,        isSigner: true,  isWritable: false },
      { pubkey: USDC_MINT,             isSigner: false, isWritable: false },
      { pubkey: HOP_MINT,              isSigner: false, isWritable: true  },
      { pubkey: TOKEN_VAULT_A,         isSigner: false, isWritable: true  },
      { pubkey: TOKEN_VAULT_B,         isSigner: false, isWritable: true  },
      { pubkey: args.destA,            isSigner: false, isWritable: true  },
      { pubkey: args.destB,            isSigner: false, isWritable: true  },
      { pubkey: TOKEN_PROGRAM_ID,      isSigner: false, isWritable: false },
      { pubkey: TOKEN_2022_PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: SPL_MEMO,              isSigner: false, isWritable: false },
    ],
    data: Buffer.concat([COLLECT_PROTOCOL_FEES_V2_DISC, Buffer.from([0x00])]),
  });
}

function collectFeesV2Ix(args: {
  positionAuthority: PublicKey;
  positionTokenAccount: PublicKey;
  tokenOwnerAccountA: PublicKey;
  tokenOwnerAccountB: PublicKey;
}): TransactionInstruction {
  return new TransactionInstruction({
    programId: WHIRLPOOL_PROGRAM,
    keys: [
      { pubkey: WHIRLPOOL,                   isSigner: false, isWritable: true  },
      { pubkey: args.positionAuthority,      isSigner: true,  isWritable: false },
      { pubkey: POSITION,                    isSigner: false, isWritable: true  },
      { pubkey: args.positionTokenAccount,   isSigner: false, isWritable: false },
      { pubkey: USDC_MINT,                   isSigner: false, isWritable: false },
      { pubkey: HOP_MINT,                    isSigner: false, isWritable: true  },
      { pubkey: args.tokenOwnerAccountA,     isSigner: false, isWritable: true  },
      { pubkey: TOKEN_VAULT_A,               isSigner: false, isWritable: true  },
      { pubkey: args.tokenOwnerAccountB,     isSigner: false, isWritable: true  },
      { pubkey: TOKEN_VAULT_B,               isSigner: false, isWritable: true  },
      { pubkey: TOKEN_PROGRAM_ID,            isSigner: false, isWritable: false },
      { pubkey: TOKEN_2022_PROGRAM_ID,       isSigner: false, isWritable: false },
      { pubkey: SPL_MEMO,                    isSigner: false, isWritable: false },
    ],
    data: Buffer.concat([COLLECT_FEES_V2_DISC, Buffer.from([0x00])]),
  });
}

// ─── Main ─────────────────────────────────────────────────────────────────────

export type ExtractResult = {
  verdict: string;
  simOk: boolean;
  lpFeesExtractedUsdcUi: number;
  lpFeesExtractedHopUi: number;
  protoFeesExtractedUsdcUi: number;
  protoFeesExtractedHopUi: number;
};

async function runExtract(): Promise<ExtractResult> {
  const rpcUrl        = process.env.SOLANA_RPC_URL || process.env.RPC_URL || "https://api.mainnet-beta.solana.com";
  const dryRun        = process.env.DRY_RUN !== "false";
  const allowLive     = process.env.ALLOW_LIVE === "true";
  const minExtractUsd = Number(process.env.MIN_EXTRACT_USDC || "0.01");
  const cuLimit       = Number(process.env.CU_LIMIT || "300000");
  const cuPrice       = Number(process.env.CU_PRICE || "1000");
  const receiptName   = process.env.RECEIPT_NAME || `auto-compound-extract-${Date.now()}.json`;

  const conn  = new Connection(rpcUrl, "confirmed");
  const crank = loadKp(process.env.CRANK_KEYPAIR_PATH || "keys/crank.json");

  // Use crank as fee authority (same key, simpler than separate withdraw-authority)
  const withdrawAuth = loadKp(
    process.env.WITHDRAW_AUTHORITY_KEYPAIR_PATH || "keys/crank.json"
  );

  const crankUsdcAta = getAssociatedTokenAddressSync(USDC_MINT, crank.publicKey,         false, TOKEN_PROGRAM_ID);
  const crankHopAta  = getAssociatedTokenAddressSync(HOP_MINT,  crank.publicKey,         false, TOKEN_2022_PROGRAM_ID);
  const authUsdcAta  = getAssociatedTokenAddressSync(USDC_MINT, withdrawAuth.publicKey,  false, TOKEN_PROGRAM_ID);
  const authHopAta   = getAssociatedTokenAddressSync(HOP_MINT,  withdrawAuth.publicKey,  false, TOKEN_2022_PROGRAM_ID);

  console.log("=== AUTO-COMPOUND-EXTRACT ===");
  console.log(`crank:        ${crank.publicKey.toBase58()}`);
  console.log(`withdrawAuth: ${withdrawAuth.publicKey.toBase58()}`);
  console.log(`dryRun:       ${dryRun}`);
  console.log();

  // ─── Read state ──────────────────────────────────────────────────────────
  const [poolInfo, posInfo] = await Promise.all([
    conn.getAccountInfo(WHIRLPOOL, "confirmed"),
    conn.getAccountInfo(POSITION,  "confirmed"),
  ]);
  if (!poolInfo) throw new Error("Whirlpool account not found");
  if (!posInfo)  throw new Error("Position account not found");

  const pd = Buffer.from(poolInfo.data);
  const pp = Buffer.from(posInfo.data);

  const protocolFeeA = readU64LE(pd, WP_PROTO_FEE_A_OFFSET);
  const protocolFeeB = readU64LE(pd, WP_PROTO_FEE_B_OFFSET);
  const lpFeeA       = readU64LE(pp, POS_FEE_OWED_A_OFFSET);
  const lpFeeB       = readU64LE(pp, POS_FEE_OWED_B_OFFSET);

  const protoFeesExtractedUsdcUi = Number(protocolFeeA) / 1e6;
  const protoFeesExtractedHopUi  = Number(protocolFeeB) / 1e6;
  const lpFeesExtractedUsdcUi    = Number(lpFeeA) / 1e6;
  const lpFeesExtractedHopUi     = Number(lpFeeB) / 1e6;

  const totalExtractableUsdc = protoFeesExtractedUsdcUi + lpFeesExtractedUsdcUi;

  console.log(`Protocol fee owed A: ${protoFeesExtractedUsdcUi.toFixed(6)} USDC`);
  console.log(`Protocol fee owed B: ${protoFeesExtractedHopUi.toFixed(6)} HOP`);
  console.log(`LP fee owed A:       ${lpFeesExtractedUsdcUi.toFixed(6)} USDC`);
  console.log(`LP fee owed B:       ${lpFeesExtractedHopUi.toFixed(6)} HOP`);
  console.log(`Total extractable:   ${totalExtractableUsdc.toFixed(6)} USDC + ${(protoFeesExtractedHopUi + lpFeesExtractedHopUi).toFixed(6)} HOP`);
  console.log();

  const baseExtractResult: ExtractResult = {
    verdict: "BELOW_THRESHOLD",
    simOk: false,
    lpFeesExtractedUsdcUi,
    lpFeesExtractedHopUi,
    protoFeesExtractedUsdcUi,
    protoFeesExtractedHopUi,
  };

  if (totalExtractableUsdc < minExtractUsd) {
    console.log(`BELOW_THRESHOLD: ${totalExtractableUsdc.toFixed(6)} USDC < min ${minExtractUsd}`);
    writeReceipt(receiptName, { ...baseExtractResult, timestamp: new Date().toISOString() });
    return baseExtractResult;
  }

  // ─── Build TX ────────────────────────────────────────────────────────────
  const ixs: TransactionInstruction[] = [
    ComputeBudgetProgram.setComputeUnitLimit({ units: cuLimit }),
    ComputeBudgetProgram.setComputeUnitPrice({ microLamports: cuPrice }),
    // Ensure fee-authority ATAs exist
    createIdempotentAta(crank.publicKey, authUsdcAta, withdrawAuth.publicKey, USDC_MINT),
    createIdempotentAta(crank.publicKey, authHopAta,  withdrawAuth.publicKey, HOP_MINT, TOKEN_2022_PROGRAM_ID),
    // Sweep protocol fees → withdrawAuth ATAs
    collectProtocolFeesV2Ix({ authority: withdrawAuth.publicKey, destA: authUsdcAta, destB: authHopAta }),
  ];

  // Collect LP fees (feeOwedA/B) → crank ATAs
  const positionTokenAccount = getAssociatedTokenAddressSync(POSITION_MINT, crank.publicKey, false, TOKEN_PROGRAM_ID);
  ixs.push(collectFeesV2Ix({
    positionAuthority:    crank.publicKey,
    positionTokenAccount,
    tokenOwnerAccountA:   crankUsdcAta,
    tokenOwnerAccountB:   crankHopAta,
  }));

  const { blockhash } = await conn.getLatestBlockhash("confirmed");
  const tx = new Transaction({ recentBlockhash: blockhash, feePayer: crank.publicKey });
  tx.add(...ixs);

  const signers = crank.publicKey.equals(withdrawAuth.publicKey)
    ? [crank]
    : [crank, withdrawAuth];
  tx.sign(...signers);

  // ─── Simulate ────────────────────────────────────────────────────────────
  const serializedSize = tx.serialize().length;
  console.log(`TX size: ${serializedSize}b`);
  console.log("Simulating extract TX...");

  const sim = await conn.simulateTransaction(tx);
  const simLogs = (sim.value.logs ?? []).slice(-20);
  const simOk   = !sim.value.err;

  if (!simOk) {
    simLogs.forEach(l => console.log(" ", l));
  }
  console.log(`Sim err: ${sim.value.err ? JSON.stringify(sim.value.err) : "null"}`);
  console.log(`Sim CU:  ${sim.value.unitsConsumed ?? "?"}`);

  const receipt = {
    verdict: simOk ? "SIM_OK" : "SIM_FAILED",
    timestamp: new Date().toISOString(),
    dryRun,
    lpFeesExtractedUsdcUi,
    lpFeesExtractedHopUi,
    protoFeesExtractedUsdcUi,
    protoFeesExtractedHopUi,
    totalExtractableUsdc,
    simOk,
    simErr: sim.value.err ?? null,
    simCu:  sim.value.unitsConsumed ?? null,
    txSize: serializedSize,
  };

  writeReceipt(receiptName, receipt);

  if (!simOk) {
    console.error("SIM_FAILED — fix before sending");
    return { ...baseExtractResult, verdict: "SIM_FAILED", simOk: false };
  }

  console.log(`SIM_OK — would extract: $${(protoFeesExtractedUsdcUi + lpFeesExtractedUsdcUi).toFixed(6)} USDC + ${(protoFeesExtractedHopUi + lpFeesExtractedHopUi).toFixed(4)} HOP`);
  console.log(`  protocol fees: $${protoFeesExtractedUsdcUi.toFixed(6)} USDC + ${protoFeesExtractedHopUi.toFixed(4)} HOP`);
  console.log(`  LP fees:       $${lpFeesExtractedUsdcUi.toFixed(6)} USDC + ${lpFeesExtractedHopUi.toFixed(4)} HOP`);

  const okResult: ExtractResult = {
    verdict: "SIM_OK",
    simOk: true,
    lpFeesExtractedUsdcUi,
    lpFeesExtractedHopUi,
    protoFeesExtractedUsdcUi,
    protoFeesExtractedHopUi,
  };

  if (dryRun || !allowLive) {
    console.log("DRY_RUN. Set DRY_RUN=false ALLOW_LIVE=true to execute.");
    return okResult;
  }

  // ─── Live send ───────────────────────────────────────────────────────────
  const { blockhash: bh } = await conn.getLatestBlockhash("confirmed");
  const liveTx = new Transaction({ recentBlockhash: bh, feePayer: crank.publicKey });
  liveTx.add(...ixs);
  liveTx.sign(...signers);

  const sig = await conn.sendRawTransaction(liveTx.serialize(), { skipPreflight: false, preflightCommitment: "confirmed" });
  console.log(`Live TX: ${sig}`);

  writeReceipt(receiptName, { ...receipt, verdict: "EXECUTED", signature: sig });
  return { ...okResult, verdict: "EXECUTED" };
}

export { runExtract };

const _isMain = new URL(import.meta.url).pathname === new URL(process.argv[1] ?? "", "file://").pathname;
if (_isMain) runExtract().catch((e) => { console.error(e); process.exitCode = 1; });
