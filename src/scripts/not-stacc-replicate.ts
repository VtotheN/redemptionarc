/**
 * FASE 1: Replica exacta del TX de not stacc (2026-05-22).
 * Proof TX: 2jgoM1pFSH7FRqnLixMs3GAYrNQWDiJyMf1G284FTBWNjXqFy7MAV9cA1uyg4KDLw3dQsYN9xKvTimmRbscMGaLe
 *
 * Estructura (LEGACY mode, 1 sola TX):
 *   ComputeBudget × 2
 *   MarginFi startFlashLoan
 *   Token2022 transferCheckedWithFee × 4 (ring)
 *   Token2022 harvestWithheldTokensToMint
 *   Token2022 withdrawWithheldTokensFromMint → treasury
 *   AToken createIdempotent (USDC ATA)
 *   MarginFi lendingAccountBorrow
 *   MarginFi lendingAccountRepay
 *   System transfer (Jito tip)
 *   MarginFi endFlashLoan
 *
 * PRE-REQUISITO: HOP fee debe ser 1bps (run set-hop-fee first)
 *
 * ENV:
 *   FLASH_AMOUNT_USDC=1       (start small, scale later)
 *   HOP_AMOUNT_PER_HOP=1000   (tokens per hop)
 *   DRY_RUN=true
 *   ALLOW_LIVE=false
 *   JITO_TIP_LAMPORTS=200000  (0.0002 SOL, same as not stacc)
 */

import "dotenv/config";
import dotenv from "dotenv";
import fs from "node:fs";
import {
  Connection,
  Keypair,
  PublicKey,
  Transaction,
  TransactionInstruction,
  SystemProgram,
  ComputeBudgetProgram,
  sendAndConfirmTransaction,
  SYSVAR_INSTRUCTIONS_PUBKEY,
} from "@solana/web3.js";
import {
  TOKEN_2022_PROGRAM_ID,
  createTransferCheckedWithFeeInstruction,
  createHarvestWithheldTokensToMintInstruction,
  createWithdrawWithheldTokensFromMintInstruction,
  getAssociatedTokenAddressSync,
  createAssociatedTokenAccountIdempotentInstruction,
  TOKEN_PROGRAM_ID,
} from "@solana/spl-token";
import { writeReceipt } from "../utils/receipt.js";

if (process.env.ENV_PATH) {
  dotenv.config({ path: process.env.ENV_PATH, override: true });
}

// ─── Constants ────────────────────────────────────────────────────────────────

const HOP_MINT = new PublicKey("HZF5k7h39hkysoSZ4ZfmWc55PhvW7ntVvVqdXFCyYGh3");
const HOP_DECIMALS = 6;
const HOP_FEE_BPS = 1; // MUST be set via set-hop-fee first

const USDC_MINT = new PublicKey("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v");

const MARGINFI_PROGRAM = new PublicKey("MFv2hWf31Z9kbCa1snEPYctwafyhdvnV7FZnsebVacA");
const MARGINFI_GROUP = new PublicKey("4qp6Fx6tnZkY5Wropq9wUYgtFxXKwE6viZxFHg3rdAG8");
const USDC_BANK = new PublicKey("2s37akK2eyBbp8DZgCm7RtsaEz8eJP3Nxd4urLHQv7yB");
const USDC_LIQUIDITY_VAULT = new PublicKey("7jaiZR5Sk8hdYN9MxTpczTcwbWpb5WEoxSANuUwveuat");

// Jito tip accounts (any one of them)
const JITO_TIP = new PublicKey("96gYZGLnJYVFmbjzopPSU6QiEV5fGqZNyN9nmNhvrZU5");

const IX_START = Buffer.from([14, 131, 33, 220, 81, 186, 180, 107]);
const IX_END   = Buffer.from([105, 124, 201, 106, 153, 2, 8, 156]);
const IX_BORROW = Buffer.from([4, 126, 116, 53, 48, 5, 212, 31]);
const IX_REPAY  = Buffer.from([79, 209, 172, 177, 222, 51, 173, 151]);
const BANK_ORACLE_OFFSET = 610;

// ─── Helpers ──────────────────────────────────────────────────────────────────

function loadKeypair(path: string): Keypair {
  return Keypair.fromSecretKey(
    Uint8Array.from(JSON.parse(fs.readFileSync(path, "utf8")) as number[])
  );
}

function u64Le(n: bigint): Buffer {
  const b = Buffer.alloc(8);
  b.writeBigUInt64LE(n);
  return b;
}

function marginfiAccountPubkey(path: string): PublicKey {
  const raw = Uint8Array.from(JSON.parse(fs.readFileSync(path, "utf8")) as number[]);
  return new PublicKey(raw.slice(32, 64));
}

async function oracleForBank(connection: Connection, bank: PublicKey): Promise<PublicKey> {
  const info = await connection.getAccountInfo(bank, "confirmed");
  if (!info) throw new Error(`Bank not found: ${bank.toBase58()}`);
  return new PublicKey(Buffer.from(info.data).subarray(BANK_ORACLE_OFFSET, BANK_ORACLE_OFFSET + 32));
}


// ─── Instruction builders ─────────────────────────────────────────────────────

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
      { pubkey: MARGINFI_GROUP, isSigner: false, isWritable: false },
      { pubkey: account, isSigner: false, isWritable: true },
      { pubkey: authority, isSigner: true, isWritable: false },
      { pubkey: USDC_BANK, isSigner: false, isWritable: true },
      { pubkey: destAta, isSigner: false, isWritable: true },
      { pubkey: vaultAuth, isSigner: false, isWritable: false },
      { pubkey: USDC_LIQUIDITY_VAULT, isSigner: false, isWritable: true },
      { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
    ],
    data: Buffer.concat([IX_BORROW, u64Le(amount)]),
  });
}

function repayIx(account: PublicKey, authority: PublicKey, srcAta: PublicKey, amount: bigint): TransactionInstruction {
  return new TransactionInstruction({
    programId: MARGINFI_PROGRAM,
    keys: [
      { pubkey: MARGINFI_GROUP, isSigner: false, isWritable: false },
      { pubkey: account, isSigner: false, isWritable: true },
      { pubkey: authority, isSigner: true, isWritable: false },
      { pubkey: USDC_BANK, isSigner: false, isWritable: true },
      { pubkey: srcAta, isSigner: false, isWritable: true },
      { pubkey: USDC_LIQUIDITY_VAULT, isSigner: false, isWritable: true },
      { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
    ],
    data: Buffer.concat([IX_REPAY, u64Le(amount), Buffer.from([0])]), // repay_all=None
  });
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  const rpcUrl = process.env.SOLANA_RPC_URL || process.env.RPC_URL || "https://api.mainnet-beta.solana.com";
  const dryRun = process.env.DRY_RUN !== "false";
  const allowLive = process.env.ALLOW_LIVE === "true";
  const flashAmountUsdc = Number(process.env.FLASH_AMOUNT_USDC || "1");
  const hopAmountPerHop = BigInt(Math.floor(Number(process.env.HOP_AMOUNT_PER_HOP || "1000") * 10 ** HOP_DECIMALS));
  const jitoTipLamports = BigInt(process.env.JITO_TIP_LAMPORTS || "200000");
  const cuLimit = Number(process.env.CU_LIMIT || "80000");
  const cuPrice = Number(process.env.CU_PRICE || "1000");

  const connection = new Connection(rpcUrl, "confirmed");

  // Load wallets
  const crankPath = process.env.CRANK_KEYPAIR_PATH || "keys/crank.json";
  const crank = loadKeypair(crankPath);
  const mfAccountPath = process.env.MARGINFI_ACCOUNT_KEYPAIR_PATH || "keys/marginfi-account.json";
  const mfAccount = marginfiAccountPubkey(mfAccountPath);

  // Ring wallets A, B, C, D (crank = wallet A, ring wallets B/C/D need separate keys)
  // For now, crank is wallet A. B/C/D loaded from ring keypairs.
  const ringBPath = process.env.RING_B_KEYPAIR_PATH || "keys/ring-b.json";
  const ringCPath = process.env.RING_C_KEYPAIR_PATH || "keys/ring-c.json";
  const ringDPath = process.env.RING_D_KEYPAIR_PATH || "keys/ring-d.json";

  const walletA = crank.publicKey;
  const walletB = loadKeypair(ringBPath).publicKey;
  const walletC = loadKeypair(ringCPath).publicKey;
  const walletD = loadKeypair(ringDPath).publicKey;

  // ATAs for HOP ring
  const ataA = getAssociatedTokenAddressSync(HOP_MINT, walletA, false, TOKEN_2022_PROGRAM_ID);
  const ataB = getAssociatedTokenAddressSync(HOP_MINT, walletB, false, TOKEN_2022_PROGRAM_ID);
  const ataC = getAssociatedTokenAddressSync(HOP_MINT, walletC, false, TOKEN_2022_PROGRAM_ID);
  const ataD = getAssociatedTokenAddressSync(HOP_MINT, walletD, false, TOKEN_2022_PROGRAM_ID);

  // Treasury HOP ATA (withdraw_withheld destination)
  const treasuryPubkey = new PublicKey(process.env.REDEMPTION_TREASURY || walletA.toBase58());
  const treasuryHopAta = getAssociatedTokenAddressSync(HOP_MINT, treasuryPubkey, false, TOKEN_2022_PROGRAM_ID);

  // USDC ATA for flash (crank)
  const crankUsdcAta = getAssociatedTokenAddressSync(USDC_MINT, walletA, false, TOKEN_PROGRAM_ID);

  // Flash amount
  const flashAmountMicro = BigInt(Math.floor(flashAmountUsdc * 1e6));

  // Get oracle for MarginFi end flash
  const oracle = await oracleForBank(connection, USDC_BANK);

  // Calculate fee per hop (1 bps of hopAmountPerHop)
  const feePerHop = hopAmountPerHop / 10_000n; // 1 bps

  console.log("=== NOT STACC REPLICATE ===");
  console.log(`crank:         ${walletA.toBase58()}`);
  console.log(`marginfi acct: ${mfAccount.toBase58()}`);
  console.log(`flash amount:  $${flashAmountUsdc} USDC`);
  console.log(`hop amount:    ${Number(hopAmountPerHop) / 10 ** HOP_DECIMALS} HOP per hop`);
  console.log(`fee per hop:   ${Number(feePerHop) / 10 ** HOP_DECIMALS} HOP (1 bps)`);
  console.log(`ring:          ${walletA.toBase58().slice(0, 8)} → ${walletB.toBase58().slice(0, 8)} → ${walletC.toBase58().slice(0, 8)} → ${walletD.toBase58().slice(0, 8)} → A`);
  console.log(`dry run:       ${dryRun}`);
  console.log();

  // ─── Build instructions ───────────────────────────────────────────────────

  const hop1Amount = hopAmountPerHop;
  const hop2Amount = hopAmountPerHop - feePerHop;
  const hop3Amount = hop2Amount - (hop2Amount / 10_000n);
  const hop4Amount = hop3Amount - (hop3Amount / 10_000n);

  // endIndex = position of endFlashLoan instruction (IX[13] = index 13)
  const END_IX_INDEX = 13n;

  const ixs: TransactionInstruction[] = [
    // IX[0-1] compute budget
    ComputeBudgetProgram.setComputeUnitLimit({ units: cuLimit }),
    ComputeBudgetProgram.setComputeUnitPrice({ microLamports: cuPrice }),
    // IX[2] MarginFi start flash
    startFlashIx(mfAccount, walletA, END_IX_INDEX),
    // IX[3-6] T22 ring
    createTransferCheckedWithFeeInstruction(
      ataA, HOP_MINT, ataB, walletA, hop1Amount, HOP_DECIMALS, feePerHop, [], TOKEN_2022_PROGRAM_ID
    ),
    createTransferCheckedWithFeeInstruction(
      ataB, HOP_MINT, ataC, walletB, hop2Amount, HOP_DECIMALS, hop2Amount / 10_000n, [], TOKEN_2022_PROGRAM_ID
    ),
    createTransferCheckedWithFeeInstruction(
      ataC, HOP_MINT, ataD, walletC, hop3Amount, HOP_DECIMALS, hop3Amount / 10_000n, [], TOKEN_2022_PROGRAM_ID
    ),
    createTransferCheckedWithFeeInstruction(
      ataD, HOP_MINT, ataA, walletD, hop4Amount, HOP_DECIMALS, hop4Amount / 10_000n, [], TOKEN_2022_PROGRAM_ID
    ),
    // IX[7] harvest withheld → mint
    createHarvestWithheldTokensToMintInstruction(HOP_MINT, [ataA, ataB, ataC, ataD], TOKEN_2022_PROGRAM_ID),
    // IX[8] withdraw withheld → treasury
    createWithdrawWithheldTokensFromMintInstruction(
      HOP_MINT, treasuryHopAta, walletA, [], TOKEN_2022_PROGRAM_ID
    ),
    // IX[9] create USDC ATA idempotent
    createAssociatedTokenAccountIdempotentInstruction(walletA, crankUsdcAta, walletA, USDC_MINT),
    // IX[10] borrow
    borrowIx(mfAccount, walletA, crankUsdcAta, flashAmountMicro),
    // IX[11] repay
    repayIx(mfAccount, walletA, crankUsdcAta, flashAmountMicro),
    // IX[12] Jito tip
    SystemProgram.transfer({ fromPubkey: walletA, toPubkey: JITO_TIP, lamports: jitoTipLamports }),
    // IX[13] end flash (= END_IX_INDEX)
    endFlashIx(mfAccount, walletA, oracle),
  ];

  if (ixs.length - 1 !== Number(END_IX_INDEX)) {
    throw new Error(`endIndex mismatch: expected ${END_IX_INDEX}, endFlash at ${ixs.length - 1}`);
  }

  // Build LEGACY transaction (not v0)
  const { blockhash } = await connection.getLatestBlockhash("confirmed");
  const tx = new Transaction({ recentBlockhash: blockhash, feePayer: walletA });
  tx.add(...ixs);

  // Note: need all signers (crank + ring wallets B/C/D)
  const ringB = loadKeypair(ringBPath);
  const ringC = loadKeypair(ringCPath);
  const ringD = loadKeypair(ringDPath);
  const signers = [crank, ringB, ringC, ringD];

  const receipt: Record<string, unknown> = {
    verdict: "",
    flashAmountUsdc,
    hopAmountPerHop: Number(hopAmountPerHop) / 10 ** HOP_DECIMALS,
    feeBpsPerHop: HOP_FEE_BPS,
    totalFeeBps: HOP_FEE_BPS * 4,
    expectedFeeHop: Number(feePerHop) / 10 ** HOP_DECIMALS,
    jitoTipLamports: Number(jitoTipLamports),
    dryRun,
    signature: null,
  };

  if (dryRun || !allowLive) {
    tx.partialSign(...signers);
    const sim = await connection.simulateTransaction(tx);
    receipt.verdict = sim.value.err ? "SIM_FAILED" : "SIM_OK";
    receipt.err = sim.value.err ?? null;
    receipt.unitsConsumed = sim.value.unitsConsumed ?? null;
    receipt.logs = (sim.value.logs ?? []).slice(-10);
    console.log(`SIM: ${receipt.verdict}  cu=${receipt.unitsConsumed}`);
    if (sim.value.err) {
      console.log("ERR:", JSON.stringify(sim.value.err));
      console.log("LOGS:", (sim.value.logs ?? []).slice(-5).join("\n"));
    }
  } else {
    const sig = await sendAndConfirmTransaction(connection, tx, signers, { commitment: "confirmed" });
    receipt.verdict = "EXECUTED";
    receipt.signature = sig;
    console.log(`EXECUTED: ${sig}`);
    console.log(`Net: ~${(Number(hopAmountPerHop) / 10 ** HOP_DECIMALS * 0.0004).toFixed(6)} HOP fees harvested`);
    console.log(`Gas: ~$0.004`);
  }

  writeReceipt("not-stacc-replicate", receipt);
}

main().catch((e) => { console.error(e); process.exitCode = 1; });
