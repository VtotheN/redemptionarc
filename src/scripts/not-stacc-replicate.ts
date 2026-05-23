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
 *   CU_LIMIT=300000           (MarginFi borrow/repay needs ~200k CU in sim)
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
  getMint,
  getTransferFeeConfig,
} from "@solana/spl-token";
import { writeReceipt } from "../utils/receipt.js";

if (process.env.ENV_PATH) {
  dotenv.config({ path: process.env.ENV_PATH, override: true });
}

// ─── Constants ────────────────────────────────────────────────────────────────

const HOP_MINT = new PublicKey("HZF5k7h39hkysoSZ4ZfmWc55PhvW7ntVvVqdXFCyYGh3");
const HOP_DECIMALS = 6;
const TARGET_ACTIVE_FEE_BPS = 1;
// Fee bps is read dynamically from on-chain mint (newerTransferFee activates at a future epoch)

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
  const cuLimit = Number(process.env.CU_LIMIT || "300000");
  const cuPrice = Number(process.env.CU_PRICE || "1000");
  const settlementConfirmed = process.env.SETTLEMENT_CONFIRMED === "true";
  const settlementPath = process.env.SETTLEMENT_PATH || null;

  const connection = new Connection(rpcUrl, "confirmed");

  // Load wallets
  const crankPath = process.env.CRANK_KEYPAIR_PATH || "keys/crank.json";
  const crank = loadKeypair(crankPath);
  const mfAccountPath = process.env.MARGINFI_ACCOUNT_KEYPAIR_PATH || "keys/marginfi-account.json";
  const mfAccount = marginfiAccountPubkey(mfAccountPath);

  // Ring wallets A, B, C, D.
  // crank = wallet A (owner of ataA).
  // B/C/D: crank is DELEGATE (via init-ring-delegates) — no signing needed from B/C/D.
  // This keeps the TX single-signer → fits in 1232 bytes.
  const ringBPath = process.env.RING_B_KEYPAIR_PATH || "keys/ring1.json";
  const ringCPath = process.env.RING_C_KEYPAIR_PATH || "keys/ring2.json";
  const ringDPath = process.env.RING_D_KEYPAIR_PATH || "keys/ring3.json";

  const walletA = crank.publicKey;
  // Only need pubkeys for ATA derivation — crank is delegate authority
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

  // Fetch active fee bps from on-chain mint (newer activates at epoch, older still valid until then)
  const mintInfo = await getMint(connection, HOP_MINT, "confirmed", TOKEN_2022_PROGRAM_ID);
  const feeConfig = getTransferFeeConfig(mintInfo);
  if (!feeConfig) throw new Error("HOP has no TransferFeeConfig extension");
  const epochInfo = await connection.getEpochInfo();
  const activeFeeConfig = epochInfo.epoch >= Number(feeConfig.newerTransferFee.epoch)
    ? feeConfig.newerTransferFee
    : feeConfig.olderTransferFee;
  const activeFeeBps = activeFeeConfig.transferFeeBasisPoints;

  // T22 fee = ceil(amount * bps / 10_000)
  const calcFee = (amount: bigint) => {
    const raw = amount * BigInt(activeFeeBps);
    return raw / 10_000n + (raw % 10_000n > 0n ? 1n : 0n);
  };

  console.log("=== NOT STACC REPLICATE ===");
  console.log(`crank:         ${walletA.toBase58()}`);
  console.log(`marginfi acct: ${mfAccount.toBase58()}`);
  console.log(`flash amount:  $${flashAmountUsdc} USDC`);
  console.log(`hop amount:    ${Number(hopAmountPerHop) / 10 ** HOP_DECIMALS} HOP per hop`);
  console.log(`active fee:    ${activeFeeBps} bps (1bps active epoch ${feeConfig.newerTransferFee.epoch}, current ${epochInfo.epoch})`);
  console.log(`ring:          ${walletA.toBase58().slice(0, 8)} → ${walletB.toBase58().slice(0, 8)} → ${walletC.toBase58().slice(0, 8)} → ${walletD.toBase58().slice(0, 8)} → A`);
  console.log(`dry run:       ${dryRun}`);
  console.log();

  // ─── Build instructions ───────────────────────────────────────────────────

  const hop1Amount = hopAmountPerHop;
  const hop1Fee = calcFee(hop1Amount);
  const hop2Amount = hop1Amount - hop1Fee;
  const hop2Fee = calcFee(hop2Amount);
  const hop3Amount = hop2Amount - hop2Fee;
  const hop3Fee = calcFee(hop3Amount);
  const hop4Amount = hop3Amount - hop3Fee;
  const hop4Fee = calcFee(hop4Amount);
  const totalWithheldHop = hop1Fee + hop2Fee + hop3Fee + hop4Fee;
  const cashGateReasons = [
    activeFeeBps !== TARGET_ACTIVE_FEE_BPS ? `active HOP fee is ${activeFeeBps}bps, target is ${TARGET_ACTIVE_FEE_BPS}bps` : null,
    !settlementConfirmed ? "withheld fees settle as HOP, not spendable USDC/SOL" : null,
    !settlementConfirmed ? "FLASH_AMOUNT_USDC is only the MarginFi wrapper amount; it does not determine HOP fee revenue" : null,
  ].filter((x): x is string => Boolean(x));
  const cashGate = {
    targetActiveFeeBps: TARGET_ACTIVE_FEE_BPS,
    activeFeeOk: activeFeeBps === TARGET_ACTIVE_FEE_BPS,
    currentEpoch: epochInfo.epoch,
    newerFeeBps: feeConfig.newerTransferFee.transferFeeBasisPoints,
    newerFeeEpoch: Number(feeConfig.newerTransferFee.epoch),
    settlementConfirmed,
    settlementPath,
    feeToken: HOP_MINT.toBase58(),
    outputCashToken: settlementConfirmed ? "USDC/SOL via declared settlement path" : null,
    flashAmountIsRevenueSource: false,
    canExecuteLive: cashGateReasons.length === 0,
    reasons: cashGateReasons,
  };

  console.log(`fees withheld: ${Number(totalWithheldHop) / 10 ** HOP_DECIMALS} HOP total (${activeFeeBps} bps active)`);
  if (!cashGate.canExecuteLive) console.log(`cash gate:     BLOCKED — ${cashGateReasons.join("; ")}`);

  // endIndex = position of endFlashLoan instruction (IX[13] = index 13)
  const END_IX_INDEX = 13n;

  const ixs: TransactionInstruction[] = [
    // IX[0-1] compute budget
    ComputeBudgetProgram.setComputeUnitLimit({ units: cuLimit }),
    ComputeBudgetProgram.setComputeUnitPrice({ microLamports: cuPrice }),
    // IX[2] MarginFi start flash
    startFlashIx(mfAccount, walletA, END_IX_INDEX),
    // IX[3-6] T22 ring — crank is authority for ALL hops (owner of ataA, delegate on ataB/C/D)
    createTransferCheckedWithFeeInstruction(
      ataA, HOP_MINT, ataB, walletA, hop1Amount, HOP_DECIMALS, hop1Fee, [], TOKEN_2022_PROGRAM_ID
    ),
    createTransferCheckedWithFeeInstruction(
      ataB, HOP_MINT, ataC, walletA, hop2Amount, HOP_DECIMALS, hop2Fee, [], TOKEN_2022_PROGRAM_ID
    ),
    createTransferCheckedWithFeeInstruction(
      ataC, HOP_MINT, ataD, walletA, hop3Amount, HOP_DECIMALS, hop3Fee, [], TOKEN_2022_PROGRAM_ID
    ),
    createTransferCheckedWithFeeInstruction(
      ataD, HOP_MINT, ataA, walletA, hop4Amount, HOP_DECIMALS, hop4Fee, [], TOKEN_2022_PROGRAM_ID
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

  // Single signer — crank is delegate on ataB/C/D (set up by init-ring-delegates)
  const signers = [crank];

  const receipt: Record<string, unknown> = {
    verdict: "",
    flashAmountUsdc,
    hopAmountPerHop: Number(hopAmountPerHop) / 10 ** HOP_DECIMALS,
    feeBpsPerHop: activeFeeBps,
    expectedFeeHopPerLeg: [
      Number(hop1Fee) / 10 ** HOP_DECIMALS,
      Number(hop2Fee) / 10 ** HOP_DECIMALS,
      Number(hop3Fee) / 10 ** HOP_DECIMALS,
      Number(hop4Fee) / 10 ** HOP_DECIMALS,
    ],
    expectedTotalWithheldHop: Number(totalWithheldHop) / 10 ** HOP_DECIMALS,
    jitoTipLamports: Number(jitoTipLamports),
    cashGate,
    dryRun,
    signature: null,
  };

  if (!dryRun && allowLive && !cashGate.canExecuteLive) {
    receipt.verdict = "LIVE_BLOCKED_CASH_GATE";
    writeReceipt("not-stacc-replicate", receipt);
    console.error(`LIVE_BLOCKED_CASH_GATE: ${cashGateReasons.join("; ")}`);
    process.exitCode = 1;
    return;
  }

  if (dryRun || !allowLive) {
    tx.partialSign(...signers);
    const sim = await connection.simulateTransaction(tx);
    receipt.verdict = sim.value.err
      ? "SIM_FAILED"
      : cashGate.canExecuteLive
        ? "SIM_OK_LIVE_GATE_READY"
        : "SIM_OK_CASH_GATE_BLOCKED";
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
    console.log(`Withheld: ~${(Number(totalWithheldHop) / 10 ** HOP_DECIMALS).toFixed(6)} HOP harvested`);
    console.log(`Gas: ~$0.004`);
  }

  writeReceipt("not-stacc-replicate", receipt);
}

main().catch((e) => { console.error(e); process.exitCode = 1; });
