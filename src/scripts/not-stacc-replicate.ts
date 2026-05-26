/**
 * Full-cycle TX: MarginFi flash wrapper + T22 ring + harvest/withdraw + swapV2 HOP→USDC.
 *
 * TX structure (legacy, single-signer):
 *   IX[0]  ComputeBudget setComputeUnitLimit
 *   IX[1]  ComputeBudget setComputeUnitPrice
 *   IX[2]  MarginFi startFlashLoan(endIndex=14)
 *   IX[3]  T22 transferCheckedWithFee A→B
 *   IX[4]  T22 transferCheckedWithFee B→C
 *   IX[5]  T22 transferCheckedWithFee C→D
 *   IX[6]  T22 transferCheckedWithFee D→A
 *   IX[7]  T22 harvestWithheldTokensToMint
 *   IX[8]  T22 withdrawWithheldTokensFromMint → crank ataA
 *   IX[9]  AToken createIdempotent (USDC ATA) — dropped if TX too large
 *   IX[10] MarginFi lendingAccountBorrow
 *   IX[11] Whirlpool swapV2 HOP→USDC (crank ataA → crank USDC ATA)
 *   IX[12] MarginFi lendingAccountRepay
 *   IX[13] System transfer → Jito tip
 *   IX[14] MarginFi endFlashLoan
 *
 * ENV:
 *   FLASH_AMOUNT_USDC=1
 *   HOP_AMOUNT_PER_HOP=1000000   (1M HOP per hop; at 1bps → 400 HOP withheld/4 hops)
 *   DRY_RUN=true
 *   ALLOW_LIVE=false
 *   SETTLEMENT_CONFIRMED=true
 *   SETTLEMENT_PATH=whirlpool_fork
 *   JITO_TIP_LAMPORTS=200000
 *   CU_LIMIT=400000
 *   CU_PRICE=50000
 */

import "dotenv/config";
import dotenv from "dotenv";
import fs from "node:fs";
import {
  Connection,
  Keypair,
  PublicKey,
  TransactionInstruction,
  TransactionMessage,
  VersionedTransaction,
  AddressLookupTableAccount,
  SystemProgram,
  ComputeBudgetProgram,
  SYSVAR_INSTRUCTIONS_PUBKEY,
} from "@solana/web3.js";
import {
  TOKEN_2022_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  createTransferCheckedWithFeeInstruction,
  createHarvestWithheldTokensToMintInstruction,
  createWithdrawWithheldTokensFromMintInstruction,
  createAssociatedTokenAccountIdempotentInstruction,
  getAssociatedTokenAddressSync,
  getMint,
  getTransferFeeConfig,
  getAccount,
} from "@solana/spl-token";
import { writeReceipt } from "../utils/receipt.js";

if (process.env.ENV_PATH) {
  dotenv.config({ path: process.env.ENV_PATH, override: true });
}

// ─── Constants ────────────────────────────────────────────────────────────────

const HOP_MINT     = new PublicKey("HZF5k7h39hkysoSZ4ZfmWc55PhvW7ntVvVqdXFCyYGh3");
const USDC_MINT    = new PublicKey("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v");
const HOP_DECIMALS = 6;

// MarginFi
const MARGINFI_PROGRAM     = new PublicKey("MFv2hWf31Z9kbCa1snEPYctwafyhdvnV7FZnsebVacA");
const MARGINFI_GROUP       = new PublicKey("4qp6Fx6tnZkY5Wropq9wUYgtFxXKwE6viZxFHg3rdAG8");
const USDC_BANK            = new PublicKey("2s37akK2eyBbp8DZgCm7RtsaEz8eJP3Nxd4urLHQv7yB");
const USDC_LIQUIDITY_VAULT = new PublicKey("7jaiZR5Sk8hdYN9MxTpczTcwbWpb5WEoxSANuUwveuat");
const BANK_ORACLE_OFFSET   = 610;

// Whirlpool fork
const WHIRLPOOL_PROGRAM = new PublicKey("GxRHMB9a6XE8BqGPeNb9UkJUPvbvrPoPgNTJPJJA4n8h");
const WHIRLPOOL         = new PublicKey("8aoWgf7ycbeKv6BTFCdUj4JR7Y4mXWuPZWEUhmuzN5ZL");
const TOKEN_VAULT_A     = new PublicKey("4QD4GgnjRvjETqWLT5e3x7SHtJSzs9kShUPLfyHcTu7d"); // USDC
const TOKEN_VAULT_B     = new PublicKey("Qv51R47g7pMDxa3UofXaz8cNr8pwRSXaNufgnEWX8Yk");  // HOP
const TICK_ARRAY_90112  = new PublicKey("CDMSB5e6WUgtoSLrybvYm4j58Jue3eqpzHQVLmgVkAe4");
const TICK_ARRAY_95744  = new PublicKey("MXd8HXPjcH9ZCuyr4uKKyN7GkJ5YizZQkgUndB6J8Gz");
const WP_ORACLE         = new PublicKey("5qhXANMqTNNzdp1N1PrMzWzSzjHTZxuLPELcmpog6bp5");
const SPL_MEMO          = new PublicKey("MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr");

// Jito
const JITO_TIP = new PublicKey("96gYZGLnJYVFmbjzopPSU6QiEV5fGqZNyN9nmNhvrZU5");

// MarginFi discriminators
const IX_START  = Buffer.from([14, 131, 33, 220, 81, 186, 180, 107]);
const IX_END    = Buffer.from([105, 124, 201, 106, 153, 2, 8, 156]);
const IX_BORROW = Buffer.from([4, 126, 116, 53, 48, 5, 212, 31]);
const IX_REPAY  = Buffer.from([79, 209, 172, 177, 222, 51, 173, 151]);

// Whirlpool swapV2 discriminator (verified on-chain)
const SWAP_V2_DISC   = Buffer.from([0x2b, 0x04, 0xed, 0x0b, 0x1a, 0xc9, 0x1e, 0x62]);
const MAX_SQRT_PRICE = 79226673515401279992447579055n;

const TARGET_ACTIVE_FEE_BPS = 1;
const SOL_USD = 165.0;

// ─── Helpers ──────────────────────────────────────────────────────────────────

function loadKeypair(path: string): Keypair {
  return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(path, "utf8"))));
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

function marginfiAccountPubkey(path: string): PublicKey {
  const raw = Uint8Array.from(JSON.parse(fs.readFileSync(path, "utf8")));
  return new PublicKey(raw.slice(32, 64));
}

async function oracleForBank(conn: Connection, bank: PublicKey): Promise<PublicKey> {
  const info = await conn.getAccountInfo(bank, "confirmed");
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
      { pubkey: MARGINFI_GROUP,       isSigner: false, isWritable: false },
      { pubkey: account,              isSigner: false, isWritable: true },
      { pubkey: authority,            isSigner: true,  isWritable: false },
      { pubkey: USDC_BANK,            isSigner: false, isWritable: true },
      { pubkey: destAta,              isSigner: false, isWritable: true },
      { pubkey: vaultAuth,            isSigner: false, isWritable: false },
      { pubkey: USDC_LIQUIDITY_VAULT, isSigner: false, isWritable: true },
      { pubkey: TOKEN_PROGRAM_ID,     isSigner: false, isWritable: false },
    ],
    data: Buffer.concat([IX_BORROW, u64Le(amount)]),
  });
}

function repayIx(account: PublicKey, authority: PublicKey, srcAta: PublicKey, amount: bigint): TransactionInstruction {
  return new TransactionInstruction({
    programId: MARGINFI_PROGRAM,
    keys: [
      { pubkey: MARGINFI_GROUP,       isSigner: false, isWritable: false },
      { pubkey: account,              isSigner: false, isWritable: true },
      { pubkey: authority,            isSigner: true,  isWritable: false },
      { pubkey: USDC_BANK,            isSigner: false, isWritable: true },
      { pubkey: srcAta,               isSigner: false, isWritable: true },
      { pubkey: USDC_LIQUIDITY_VAULT, isSigner: false, isWritable: true },
      { pubkey: TOKEN_PROGRAM_ID,     isSigner: false, isWritable: false },
    ],
    data: Buffer.concat([IX_REPAY, u64Le(amount), Buffer.from([0])]),
  });
}

function swapV2HopToUsdc(authority: PublicKey, crankUsdcAta: PublicKey, crankHopAta: PublicKey, hopAmount: bigint): TransactionInstruction {
  return new TransactionInstruction({
    programId: WHIRLPOOL_PROGRAM,
    keys: [
      { pubkey: TOKEN_PROGRAM_ID,      isSigner: false, isWritable: false },
      { pubkey: TOKEN_2022_PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: SPL_MEMO,              isSigner: false, isWritable: false },
      { pubkey: authority,             isSigner: true,  isWritable: false },
      { pubkey: WHIRLPOOL,             isSigner: false, isWritable: true  },
      { pubkey: USDC_MINT,             isSigner: false, isWritable: false },
      { pubkey: HOP_MINT,              isSigner: false, isWritable: true  },
      { pubkey: crankUsdcAta,          isSigner: false, isWritable: true  },
      { pubkey: TOKEN_VAULT_A,         isSigner: false, isWritable: true  },
      { pubkey: crankHopAta,           isSigner: false, isWritable: true  },
      { pubkey: TOKEN_VAULT_B,         isSigner: false, isWritable: true  },
      { pubkey: TICK_ARRAY_90112,      isSigner: false, isWritable: true  },
      { pubkey: TICK_ARRAY_95744,      isSigner: false, isWritable: true  },
      { pubkey: TICK_ARRAY_95744,      isSigner: false, isWritable: true  },
      { pubkey: WP_ORACLE,             isSigner: false, isWritable: true  },
    ],
    data: Buffer.concat([
      SWAP_V2_DISC,
      u64Le(hopAmount),          // amount (HOP in)
      u64Le(0n),                 // otherAmountThreshold=0 (DRY_RUN; live sets slippage)
      u128Le(MAX_SQRT_PRICE),    // sqrtPriceLimit = max (sell HOP, price increases)
      Buffer.from([1]),          // amountSpecifiedIsInput = true
      Buffer.from([0]),          // aToB = false (HOP→USDC: B→A)
      Buffer.from([0]),          // remaining_accounts_info = None
    ]),
  });
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  const rpc               = process.env.SOLANA_RPC_URL || "https://mainnet.helius-rpc.com/?api-key=5b121325-36cb-473b-bbeb-47490d21479c";
  const dryRun            = process.env.DRY_RUN !== "false";
  const allowLive         = process.env.ALLOW_LIVE === "true";
  const flashAmountUsdc   = Number(process.env.FLASH_AMOUNT_USDC || "1");
  const hopAmountPerHop   = BigInt(Math.round(Number(process.env.HOP_AMOUNT_PER_HOP || "1000000") * 10 ** HOP_DECIMALS));
  const jitoTipLamports   = BigInt(process.env.JITO_TIP_LAMPORTS || "200000");
  const cuLimit           = Number(process.env.CU_LIMIT || "400000");
  const cuPrice           = BigInt(process.env.CU_PRICE || "50000");
  const settlementConfirmed = process.env.SETTLEMENT_CONFIRMED === "true";
  const settlementPath    = process.env.SETTLEMENT_PATH || null;

  const conn    = new Connection(rpc, "confirmed");
  const crank   = loadKeypair(process.env.CRANK_KEYPAIR_PATH || "keys/crank.json");
  const mfAcct  = marginfiAccountPubkey(process.env.MARGINFI_ACCOUNT_KEYPAIR_PATH || "keys/marginfi-account.json");

  const walletA = crank.publicKey;
  const walletB = loadKeypair(process.env.RING_B_KEYPAIR_PATH || "keys/ring1.json").publicKey;
  const walletC = loadKeypair(process.env.RING_C_KEYPAIR_PATH || "keys/ring2.json").publicKey;
  const walletD = loadKeypair(process.env.RING_D_KEYPAIR_PATH || "keys/ring3.json").publicKey;

  const ataA = getAssociatedTokenAddressSync(HOP_MINT, walletA, false, TOKEN_2022_PROGRAM_ID);
  const ataB = getAssociatedTokenAddressSync(HOP_MINT, walletB, false, TOKEN_2022_PROGRAM_ID);
  const ataC = getAssociatedTokenAddressSync(HOP_MINT, walletC, false, TOKEN_2022_PROGRAM_ID);
  const ataD = getAssociatedTokenAddressSync(HOP_MINT, walletD, false, TOKEN_2022_PROGRAM_ID);
  const crankUsdcAta = getAssociatedTokenAddressSync(USDC_MINT, walletA, false, TOKEN_PROGRAM_ID);

  const flashMicro = BigInt(Math.round(flashAmountUsdc * 1e6));

  // Fetch on-chain state in parallel
  const [mintInfo, epochInfo, mfOracle, usdcAccBefore, poolData] = await Promise.all([
    getMint(conn, HOP_MINT, "confirmed", TOKEN_2022_PROGRAM_ID),
    conn.getEpochInfo("confirmed"),
    oracleForBank(conn, USDC_BANK),
    getAccount(conn, crankUsdcAta, "confirmed").catch(() => null),
    conn.getAccountInfo(WHIRLPOOL, "confirmed"),
  ]);

  if (!poolData) throw new Error("Whirlpool pool not found");

  // Active fee
  const fc = getTransferFeeConfig(mintInfo)!;
  const activeFeeConfig = epochInfo.epoch >= Number(fc.newerTransferFee.epoch)
    ? fc.newerTransferFee
    : fc.olderTransferFee;
  const activeFeeBps = activeFeeConfig.transferFeeBasisPoints;

  // Calculate ring fees (cascade)
  const calcFee = (amt: bigint) => {
    const r = amt * BigInt(activeFeeBps);
    return r / 10_000n + (r % 10_000n > 0n ? 1n : 0n);
  };
  const hop1Amt = hopAmountPerHop;
  const hop1Fee = calcFee(hop1Amt);
  const hop2Amt = hop1Amt - hop1Fee;
  const hop2Fee = calcFee(hop2Amt);
  const hop3Amt = hop2Amt - hop2Fee;
  const hop3Fee = calcFee(hop3Amt);
  const hop4Amt = hop3Amt - hop3Fee;
  const hop4Fee = calcFee(hop4Amt);
  const totalWithheldHop = hop1Fee + hop2Fee + hop3Fee + hop4Fee;

  // Pool state for swap estimate
  const pd = Buffer.from(poolData.data);
  const sqrtPriceX64 = pd.readBigUInt64LE(65) | (pd.readBigUInt64LE(73) << 64n);
  const wpFeeRate    = pd.readUInt16LE(45);
  const sqrtPriceFp  = Number(sqrtPriceX64) / Number(1n << 64n);
  const hopPerUsdc   = sqrtPriceFp * sqrtPriceFp;
  const estUsdcOut   = Number(totalWithheldHop) / 1e6 / hopPerUsdc;

  const usdcBefore = usdcAccBefore?.amount ?? 0n;
  const newerEpoch = Number(fc.newerTransferFee.epoch);
  const slotsLeft  = Math.max(0, (newerEpoch - epochInfo.epoch) * epochInfo.slotsInEpoch - epochInfo.slotIndex);
  const hoursLeft  = (slotsLeft * 0.4) / 3600;

  const canExecute = activeFeeBps === TARGET_ACTIVE_FEE_BPS && settlementConfirmed && settlementPath === "whirlpool_fork";
  const epochOk    = activeFeeBps === TARGET_ACTIVE_FEE_BPS;

  console.log("=== FULL CYCLE DRY RUN ===");
  console.log(`Crank:          ${walletA.toBase58()}`);
  console.log(`MF account:     ${mfAcct.toBase58()}`);
  console.log(`Epoch:          ${epochInfo.epoch}  →  next: ${newerEpoch}  (${hoursLeft.toFixed(1)}h)`);
  console.log(`Active fee:     ${activeFeeBps} bps  (target: ${TARGET_ACTIVE_FEE_BPS} bps  ${epochOk ? "✓" : "WAITING"})`);
  console.log(`Flash amount:   $${flashAmountUsdc} USDC`);
  console.log(`HOP/hop:        ${Number(hopAmountPerHop)/1e6}M`);
  console.log(`Pool price:     ${hopPerUsdc.toFixed(0)} HOP/USDC  (sqrtPriceX64=${sqrtPriceX64})`);
  console.log(`Pool fee rate:  ${wpFeeRate}`);
  console.log();
  console.log("─── T22 Ring Fees ────────────────────────────────────────");
  console.log(`  hop1: ${Number(hop1Amt)/1e6} → fee=${Number(hop1Fee)/1e6} HOP`);
  console.log(`  hop2: ${Number(hop2Amt)/1e6} → fee=${Number(hop2Fee)/1e6} HOP`);
  console.log(`  hop3: ${Number(hop3Amt)/1e6} → fee=${Number(hop3Fee)/1e6} HOP`);
  console.log(`  hop4: ${Number(hop4Amt)/1e6} → fee=${Number(hop4Fee)/1e6} HOP`);
  console.log(`  total withheld: ${Number(totalWithheldHop)/1e6} HOP`);
  console.log(`  → swap est USDC out: ${estUsdcOut.toFixed(6)} USDC`);
  console.log();

  // ─── Build instruction set ────────────────────────────────────────────────

  // EndFlash at IX[14]
  const END_IX_INDEX = 14n;

  const ixSwap = swapV2HopToUsdc(walletA, crankUsdcAta, ataA, totalWithheldHop);
  const ixCreateUsdc = createAssociatedTokenAccountIdempotentInstruction(
    walletA, crankUsdcAta, walletA, USDC_MINT
  );

  const buildTx = (includeCreateUsdc: boolean): TransactionInstruction[] => [
    // IX[0-1]
    ComputeBudgetProgram.setComputeUnitLimit({ units: cuLimit }),
    ComputeBudgetProgram.setComputeUnitPrice({ microLamports: Number(cuPrice) }),
    // IX[2]
    startFlashIx(mfAcct, walletA, END_IX_INDEX),
    // IX[3-6]
    createTransferCheckedWithFeeInstruction(ataA, HOP_MINT, ataB, walletA, hop1Amt, HOP_DECIMALS, hop1Fee, [], TOKEN_2022_PROGRAM_ID),
    createTransferCheckedWithFeeInstruction(ataB, HOP_MINT, ataC, walletA, hop2Amt, HOP_DECIMALS, hop2Fee, [], TOKEN_2022_PROGRAM_ID),
    createTransferCheckedWithFeeInstruction(ataC, HOP_MINT, ataD, walletA, hop3Amt, HOP_DECIMALS, hop3Fee, [], TOKEN_2022_PROGRAM_ID),
    createTransferCheckedWithFeeInstruction(ataD, HOP_MINT, ataA, walletA, hop4Amt, HOP_DECIMALS, hop4Fee, [], TOKEN_2022_PROGRAM_ID),
    // IX[7-8]
    createHarvestWithheldTokensToMintInstruction(HOP_MINT, [ataA, ataB, ataC, ataD], TOKEN_2022_PROGRAM_ID),
    createWithdrawWithheldTokensFromMintInstruction(HOP_MINT, ataA, walletA, [], TOKEN_2022_PROGRAM_ID),
    // IX[9] — optional
    ...(includeCreateUsdc ? [ixCreateUsdc] : []),
    // IX[10]
    borrowIx(mfAcct, walletA, crankUsdcAta, flashMicro),
    // IX[11]
    ixSwap,
    // IX[12]
    repayIx(mfAcct, walletA, crankUsdcAta, flashMicro),
    // IX[13]
    SystemProgram.transfer({ fromPubkey: walletA, toPubkey: JITO_TIP, lamports: jitoTipLamports }),
    // IX[14]
    endFlashIx(mfAcct, walletA, mfOracle),
  ];

  // ─── Load ALT ─────────────────────────────────────────────────────────────

  const altAddress = process.env.ALT_ADDRESS;
  let altAccount: AddressLookupTableAccount | null = null;
  if (altAddress) {
    const altInfo = await conn.getAddressLookupTable(new PublicKey(altAddress));
    altAccount = altInfo.value;
    if (!altAccount) console.warn(`ALT ${altAddress} not found on-chain — proceeding without`);
    else console.log(`ALT loaded: ${altAddress} (${altAccount.state.addresses.length} accounts)`);
  }

  const { blockhash } = await conn.getLatestBlockhash("confirmed");

  const buildV0 = (ixList: TransactionInstruction[]): VersionedTransaction => {
    const msg = new TransactionMessage({
      payerKey: walletA,
      recentBlockhash: blockhash,
      instructions: ixList,
    }).compileToV0Message(altAccount ? [altAccount] : []);
    const vtx = new VersionedTransaction(msg);
    vtx.sign([crank]);
    return vtx;
  };

  // Try with createIdempotent first; drop it if TX still too large
  let ixs = buildTx(true);
  // Patch endIndex in startFlash to actual last-ix position
  ixs[2] = startFlashIx(mfAcct, walletA, BigInt(ixs.length - 1));

  let vtx = buildV0(ixs);
  let txSize = vtx.serialize().length;

  if (txSize > 1232) {
    console.log(`TX size with createIdempotent: ${txSize} bytes — dropping it`);
    ixs = buildTx(false);
    ixs[2] = startFlashIx(mfAcct, walletA, BigInt(ixs.length - 1));
    vtx = buildV0(ixs);
    txSize = vtx.serialize().length;
  }

  console.log(`TX size: ${txSize} bytes / 1232 limit  ${txSize > 1232 ? "⚠ TOO LARGE" : "✓"}  (v0${altAccount ? "+ALT" : ""})`);
  console.log(`Instructions: ${ixs.length}`);
  ixs.forEach((ix, i) => {
    const prog = ix.programId.toBase58().slice(0, 8);
    console.log(`  [${i.toString().padStart(2)}] ${prog}...  data=${ix.data.length}b  accts=${ix.keys.length}`);
  });

  if (txSize > 1232) {
    console.error(`\nFATAL: TX ${txSize} > 1232. Set ALT_ADDRESS=qDpKx5a6o84rvUyRG3w7j1t9MPP8tYoqZsHWFh7494u`);
    writeReceipt("FULL-CYCLE-DRY-RUN-LATEST.json", {
      verdict: "TX_TOO_LARGE",
      txSize,
      limit: 1232,
      overflow: txSize - 1232,
      fix: "Set ALT_ADDRESS=qDpKx5a6o84rvUyRG3w7j1t9MPP8tYoqZsHWFh7494u",
    });
    process.exitCode = 1;
    return;
  }

  // ─── Simulate ─────────────────────────────────────────────────────────────

  if (!epochOk && !process.env.FORCE_SIM) {
    console.log(`\nEpoch ${epochInfo.epoch}: activeFeeBps=${activeFeeBps}, target=1. TX structure valid.`);
    console.log(`Fee will be 1bps at epoch ${newerEpoch} (~${hoursLeft.toFixed(1)}h).`);
    console.log("Set FORCE_SIM=1 to simulate with current fee bps anyway.");
  } else {
    console.log("\nSimulating...");
    const sim = await conn.simulateTransaction(vtx, {
      sigVerify: false,
      replaceRecentBlockhash: true,
      accounts: { encoding: "base64", addresses: [crankUsdcAta.toBase58()] },
    });
    const simErr  = sim.value.err ?? null;
    const simCu   = sim.value.unitsConsumed ?? cuLimit;
    console.log(`Sim: ${simErr ? "FAIL: " + JSON.stringify(simErr) : "OK"}  cu=${simCu}`);
    if (simErr) {
      (sim.value.logs ?? []).slice(-8).forEach(l => console.log(" ", l));
    }

    // USDC delta from post-sim account state
    let actualUsdcAfter = usdcBefore;
    if (!simErr && sim.value.accounts?.[0]?.data && Array.isArray(sim.value.accounts[0].data)) {
      const buf = Buffer.from(sim.value.accounts[0].data[0], "base64");
      if (buf.length >= 72) actualUsdcAfter = buf.readBigUInt64LE(64);
    }
    const actualUsdcDelta = actualUsdcAfter - usdcBefore;

    const gasLamports  = 5000n + BigInt(simCu) * cuPrice / 1_000_000n + jitoTipLamports;
    const gasUsd       = Number(gasLamports) / 1e9 * SOL_USD;
    const usdcDeltaUsd = Number(actualUsdcDelta) / 1e6;
    const netCashUsd   = usdcDeltaUsd - gasUsd;

    console.log("\n════════════════════════════════════════════════════");
    console.log("FULL CYCLE ECONOMICS");
    console.log("════════════════════════════════════════════════════");
    console.log(`  HOP withheld (ring):      ${Number(totalWithheldHop)/1e6} HOP`);
    console.log(`  USDC from swap (est):     ${estUsdcOut.toFixed(6)} USDC`);
    console.log(`  USDC from swap (sim):     ${usdcDeltaUsd.toFixed(6)} USDC`);
    console.log(`  Gas (sol+jito tip):       $${gasUsd.toFixed(6)}`);
    console.log(`  ──────────────────────────────────────────────────`);
    console.log(`  NET per TX:               ${netCashUsd >= 0 ? "✓" : "✗"} $${netCashUsd.toFixed(6)}`);
    if (netCashUsd > 0) {
      const txPerMin = 20;
      console.log(`  NET/min (${txPerMin} TX/min):     $${(netCashUsd * txPerMin).toFixed(4)}`);
      console.log(`  NET/hr:                   $${(netCashUsd * txPerMin * 60).toFixed(2)}`);
    }
    console.log();

    const receipt = {
      verdict:            simErr ? "SIM_FAIL" : canExecute ? "SIM_OK_LIVE_READY" : "SIM_OK_EPOCH_PENDING",
      dryRun,
      txSize,
      txVersion:          "v0",
      altAddress:         altAddress ?? null,
      flashAmountUsdc,
      hopAmountPerHopUi:  Number(hopAmountPerHop) / 1e6,
      activeFeeBps,
      epochOk,
      epochCurrent:       epochInfo.epoch,
      epochTarget:        newerEpoch,
      hoursUntilEpoch978: hoursLeft,
      ring: {
        hops: 4,
        totalWithheldHop: Number(totalWithheldHop) / 1e6,
        fees: [hop1Fee, hop2Fee, hop3Fee, hop4Fee].map(f => Number(f)/1e6),
      },
      swap: {
        program:      WHIRLPOOL_PROGRAM.toBase58(),
        pool:         WHIRLPOOL.toBase58(),
        inputHop:     Number(totalWithheldHop) / 1e6,
        estUsdcOut,
        simUsdcDelta: usdcDeltaUsd,
        sqrtPriceX64: sqrtPriceX64.toString(),
        wpFeeRate,
      },
      beforeRaw:    usdcBefore.toString(),
      afterRaw:     actualUsdcAfter.toString(),
      simErr,
      simCu,
      gasUsd,
      jitoTipLamports: Number(jitoTipLamports),
      netCashUsd,
      settlementConfirmed,
      settlementPath,
      canExecuteLive: canExecute && !simErr,
      generatedAt:    new Date().toISOString(),
    };

    const out = writeReceipt("FULL-CYCLE-DRY-RUN-LATEST.json", receipt);
    console.log(`Receipt: ${out}`);

    if (!dryRun && allowLive && canExecute && !simErr) {
      console.log("\n=== EXECUTING LIVE ===");
      const liveMin = actualUsdcDelta * 9700n / 10000n;
      const liveSwapIx = swapV2HopToUsdc(walletA, crankUsdcAta, ataA, totalWithheldHop);
      const liveSwapData = Buffer.from(liveSwapIx.data);
      liveSwapData.writeBigUInt64LE(liveMin, 16);
      const liveIxs = [...ixs];
      const swapIdx = liveIxs.findIndex(ix => ix.data.slice(0, 8).equals(SWAP_V2_DISC));
      if (swapIdx >= 0) liveIxs[swapIdx] = new TransactionInstruction({ ...liveSwapIx, data: liveSwapData });
      const { blockhash: lb } = await conn.getLatestBlockhash("confirmed");
      const liveMsg = new TransactionMessage({
        payerKey: walletA,
        recentBlockhash: lb,
        instructions: liveIxs,
      }).compileToV0Message(altAccount ? [altAccount] : []);
      const liveVtx = new VersionedTransaction(liveMsg);
      liveVtx.sign([crank]);
      const sig = await conn.sendRawTransaction(liveVtx.serialize(), { skipPreflight: false });
      await conn.confirmTransaction(sig, "confirmed");
      console.log(`TX: ${sig}`);
      writeReceipt("FULL-CYCLE-LIVE.json", { ...receipt, verdict: "EXECUTED", txSig: sig });
    }
  }
}

main().catch(e => { console.error(e); process.exitCode = 1; });
