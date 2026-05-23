/**
 * Open position + add ALL available USDC liquidity to KPX9 pool.
 * Reads KPX9-POOL.json and KPX9-TICK-ARRAYS.json.
 * Position spans all 3 initialized tick arrays (full range).
 * Writes KPX9-ADD-LIQ.json receipt.
 */
import "dotenv/config";
import dotenv from "dotenv";
import fs from "node:fs";
import {
  ComputeBudgetProgram, Connection, Keypair, PublicKey,
  SYSVAR_RENT_PUBKEY, SystemProgram, Transaction, TransactionInstruction,
  sendAndConfirmTransaction,
} from "@solana/web3.js";
import {
  ASSOCIATED_TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID,
  getAssociatedTokenAddressSync,
} from "@solana/spl-token";
import { writeReceipt } from "../utils/receipt.js";

if (process.env.ENV_PATH) dotenv.config({ path: process.env.ENV_PATH, override: true });

const OFFICIAL_ORCA  = new PublicKey("whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc");
const SPL_MEMO       = new PublicKey("MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr");
const USDC_MINT      = new PublicKey("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v");
const HOP_MINT       = new PublicKey("HZF5k7h39hkysoSZ4ZfmWc55PhvW7ntVvVqdXFCyYGh3");
const TICK_SPACING   = 64;

const OPEN_POSITION_DISC    = Buffer.from([0x87, 0x80, 0x2f, 0x4d, 0x0f, 0x98, 0xf0, 0x31]);
const INCREASE_LIQ_V2_DISC  = Buffer.from([0x85, 0x1d, 0x59, 0xdf, 0x45, 0xee, 0xb0, 0x0a]);

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

function i32Le(v: number): Buffer {
  const b = Buffer.alloc(4); b.writeInt32LE(v); return b;
}

function deriveTickArray(whirlpool: PublicKey, start: number): PublicKey {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("tick_array"), whirlpool.toBuffer(), Buffer.from(String(start))],
    OFFICIAL_ORCA
  )[0];
}

function derivePosition(positionMint: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("position"), positionMint.toBuffer()],
    OFFICIAL_ORCA
  )[0];
}

function tickToSqrtPriceX64(tick: number): bigint {
  const sqrtPrice = Math.pow(1.0001, tick / 2);
  const scale = 1_000_000_000_000_000n;
  return (BigInt(Math.round(sqrtPrice * Number(scale))) * (1n << 64n)) / scale;
}

function liquidityFromAmountA(amountA: bigint, sqrtP: bigint, sqrtPUpper: bigint): bigint {
  return (amountA * sqrtP * sqrtPUpper) / ((sqrtPUpper - sqrtP) * (1n << 64n));
}

function amountBFromLiquidity(liquidity: bigint, sqrtP: bigint, sqrtPLower: bigint): bigint {
  return (liquidity * (sqrtP - sqrtPLower)) / (1n << 64n);
}

type PoolReceipt = {
  whirlpool?: string; initialSqrtPrice?: string;
  tokenMintA?: string; tokenMintB?: string;
  tokenVaultA?: string; tokenVaultB?: string;
};
type TickArraysReceipt = {
  tickArrayStarts?: number[]; tickArrays?: { start: number; address: string }[];
  tickLower?: number; tickUpper?: number;
};

async function main() {
  const rpcUrl    = process.env.SOLANA_RPC_URL || process.env.RPC_URL || "https://api.mainnet-beta.solana.com";
  const dryRun    = process.env.DRY_RUN !== "false";
  const allowLive = process.env.ALLOW_LIVE === "true";
  const slippagePct = Number(process.env.SLIPPAGE_PCT || "20");
  const connection = new Connection(rpcUrl, "confirmed");

  const crank = loadKeypair(process.env.CRANK_KEYPAIR_PATH || "keys/crank.json");

  const poolR  = JSON.parse(fs.readFileSync(
    process.env.KPX9_POOL_RECEIPT || "receipts/KPX9-POOL.json", "utf8")) as PoolReceipt;
  const tickR  = JSON.parse(fs.readFileSync(
    process.env.KPX9_TICK_RECEIPT || "receipts/KPX9-TICK-ARRAYS.json", "utf8")) as TickArraysReceipt;

  const whirlpool    = new PublicKey(poolR.whirlpool!);
  const sqrtPriceX64 = BigInt(poolR.initialSqrtPrice!);
  const tokenMintA   = new PublicKey(poolR.tokenMintA!);
  const tokenMintB   = new PublicKey(poolR.tokenMintB!);
  const tokenVaultA  = new PublicKey(poolR.tokenVaultA!);
  const tokenVaultB  = new PublicKey(poolR.tokenVaultB!);

  const tickLower = tickR.tickLower!;
  const tickUpper = tickR.tickUpper!;
  const starts    = tickR.tickArrayStarts!;

  // Must be multiples of tickSpacing
  const alignedLower = Math.round(tickLower / TICK_SPACING) * TICK_SPACING;
  const alignedUpper = Math.round(tickUpper / TICK_SPACING) * TICK_SPACING;

  const sqrtPLower = tickToSqrtPriceX64(alignedLower);
  const sqrtPUpper = tickToSqrtPriceX64(alignedUpper);

  const tokenProgramA = tokenMintA.equals(USDC_MINT) ? TOKEN_PROGRAM_ID : TOKEN_2022_PROGRAM_ID;
  const tokenProgramB = tokenMintB.equals(USDC_MINT) ? TOKEN_PROGRAM_ID : TOKEN_2022_PROGRAM_ID;

  const usdcAta = getAssociatedTokenAddressSync(USDC_MINT, crank.publicKey, false, TOKEN_PROGRAM_ID);
  const hopAta  = getAssociatedTokenAddressSync(HOP_MINT,  crank.publicKey, false, TOKEN_2022_PROGRAM_ID);

  const [usdcBal, hopBal] = await Promise.all([
    connection.getTokenAccountBalance(usdcAta, "confirmed").catch(() => null),
    connection.getTokenAccountBalance(hopAta,  "confirmed").catch(() => null),
  ]);

  const usdcBalance = BigInt(usdcBal?.value.amount ?? "0");
  const hopBalance  = BigInt(hopBal?.value.amount  ?? "0");
  const usdcUi      = Number(usdcBalance) / 1e6;
  const hopUi       = Number(hopBalance)  / 1e6;

  // All available USDC as tokenA (or tokenB depending on order)
  const isMintAUsdc = tokenMintA.equals(USDC_MINT);
  const usdcAmount  = usdcBalance;

  // Compute liquidity from available USDC
  let liquidity: bigint;
  let tokenMaxA: bigint;
  let tokenMaxB: bigint;

  if (isMintAUsdc) {
    // tokenA = USDC, tokenB = HOP
    liquidity = liquidityFromAmountA(usdcAmount, sqrtPriceX64, sqrtPUpper);
    const reqHop = amountBFromLiquidity(liquidity, sqrtPriceX64, sqrtPLower);
    const slipMul = 100n + BigInt(Math.round(slippagePct));
    tokenMaxA = (usdcAmount * slipMul) / 100n;
    tokenMaxB = (reqHop * slipMul) / 100n;
    console.log(`crank USDC: ${usdcUi}  HOP: ${hopUi}`);
    console.log(`required HOP: ${Number(reqHop)/1e6}`);
    if (hopBalance < reqHop) {
      writeReceipt("KPX9-ADD-LIQ.json", {
        verdict: "INSUFFICIENT_HOP",
        usdcBalance: usdcUi, hopBalance: hopUi, requiredHop: Number(reqHop)/1e6,
      });
      console.error(`INSUFFICIENT HOP: have ${hopUi}, need ${Number(reqHop)/1e6}`);
      process.exitCode = 1;
      return;
    }
  } else {
    // tokenA = HOP, tokenB = USDC — compute from USDC as tokenB
    // Use all HOP as tokenA, find corresponding USDC
    const hopAmount = hopBalance;
    liquidity = amountBFromLiquidity(hopAmount, sqrtPriceX64, sqrtPLower) > 0n
      ? (usdcAmount * (1n << 64n)) / (sqrtPriceX64 - sqrtPLower)
      : 0n;
    // Simpler: just use all USDC as amount_b
    liquidity = (usdcAmount * (1n << 64n)) / (sqrtPriceX64 - sqrtPLower);
    const reqHop = liquidityFromAmountA(usdcAmount, sqrtPriceX64, sqrtPUpper);
    const slipMul = 100n + BigInt(Math.round(slippagePct));
    tokenMaxB = (usdcAmount * slipMul) / 100n;
    tokenMaxA = (reqHop * slipMul) / 100n;
    console.log(`crank HOP: ${hopUi}  USDC: ${usdcUi}`);
  }

  const tokenOwnerAccountA = isMintAUsdc ? usdcAta : hopAta;
  const tokenOwnerAccountB = isMintAUsdc ? hopAta  : usdcAta;

  // Tick arrays: lower = first array, upper = last array (third)
  const tickArrayLower = deriveTickArray(whirlpool, starts[0]);
  const tickArrayUpper = deriveTickArray(whirlpool, starts[2]);

  const positionMintKp       = Keypair.generate();
  const positionMint         = positionMintKp.publicKey;
  const position             = derivePosition(positionMint);
  const positionTokenAccount = getAssociatedTokenAddressSync(
    positionMint, crank.publicKey, false, TOKEN_PROGRAM_ID
  );

  console.log("=== KPX9 ADD LIQUIDITY ===");
  console.log(`pool:         ${whirlpool.toBase58()}`);
  console.log(`tickLower:    ${alignedLower}   tickUpper: ${alignedUpper}`);
  console.log(`liquidity:    ${liquidity}`);
  console.log(`position:     ${position.toBase58()}`);
  console.log(`positionMint: ${positionMint.toBase58()}`);
  console.log(`dry_run:      ${dryRun}`);

  const openIx = new TransactionInstruction({
    programId: OFFICIAL_ORCA,
    keys: [
      { pubkey: crank.publicKey,         isSigner: true,  isWritable: true  },
      { pubkey: crank.publicKey,         isSigner: false, isWritable: false },
      { pubkey: position,                isSigner: false, isWritable: true  },
      { pubkey: positionMint,            isSigner: true,  isWritable: true  },
      { pubkey: positionTokenAccount,    isSigner: false, isWritable: true  },
      { pubkey: whirlpool,               isSigner: false, isWritable: false },
      { pubkey: TOKEN_PROGRAM_ID,        isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      { pubkey: SYSVAR_RENT_PUBKEY,      isSigner: false, isWritable: false },
      { pubkey: ASSOCIATED_TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
    ],
    data: Buffer.concat([OPEN_POSITION_DISC, Buffer.from([0]), i32Le(alignedLower), i32Le(alignedUpper)]),
  });

  const addLiqIx = new TransactionInstruction({
    programId: OFFICIAL_ORCA,
    keys: [
      { pubkey: whirlpool,               isSigner: false, isWritable: true  },
      { pubkey: tokenProgramA,           isSigner: false, isWritable: false },
      { pubkey: tokenProgramB,           isSigner: false, isWritable: false },
      { pubkey: SPL_MEMO,                isSigner: false, isWritable: false },
      { pubkey: crank.publicKey,         isSigner: true,  isWritable: false },
      { pubkey: position,                isSigner: false, isWritable: true  },
      { pubkey: positionTokenAccount,    isSigner: false, isWritable: false },
      { pubkey: tokenMintA,              isSigner: false, isWritable: false },
      { pubkey: tokenMintB,              isSigner: false, isWritable: false },
      { pubkey: tokenOwnerAccountA,      isSigner: false, isWritable: true  },
      { pubkey: tokenOwnerAccountB,      isSigner: false, isWritable: true  },
      { pubkey: tokenVaultA,             isSigner: false, isWritable: true  },
      { pubkey: tokenVaultB,             isSigner: false, isWritable: true  },
      { pubkey: tickArrayLower,          isSigner: false, isWritable: true  },
      { pubkey: tickArrayUpper,          isSigner: false, isWritable: true  },
    ],
    data: Buffer.concat([INCREASE_LIQ_V2_DISC, u128Le(liquidity), u64Le(tokenMaxA), u64Le(tokenMaxB), Buffer.from([0x00])]),
  });

  const receipt: Record<string, unknown> = {
    verdict: "",
    whirlpool: whirlpool.toBase58(),
    tickLower: alignedLower,
    tickUpper: alignedUpper,
    liquidity: liquidity.toString(),
    usdcBalanceUi: usdcUi,
    hopBalanceUi: hopUi,
    positionMint: positionMint.toBase58(),
    position: position.toBase58(),
    tokenMaxA: tokenMaxA.toString(),
    tokenMaxB: tokenMaxB.toString(),
    dryRun,
    signature: null as string | null,
  };

  const tx = new Transaction()
    .add(ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 }))
    .add(openIx)
    .add(addLiqIx);
  tx.feePayer = crank.publicKey;
  tx.recentBlockhash = (await connection.getLatestBlockhash("confirmed")).blockhash;
  tx.sign(crank, positionMintKp);

  const sim = await connection.simulateTransaction(tx);
  receipt.simErr  = sim.value.err ?? null;
  receipt.simLogs = sim.value.logs?.slice(-10) ?? [];

  if (sim.value.err) {
    receipt.verdict = "ADD_LIQ_SIM_FAILED";
    writeReceipt("KPX9-ADD-LIQ.json", receipt);
    console.error(`SIM_FAILED: ${JSON.stringify(sim.value.err)}`);
    (receipt.simLogs as string[]).forEach(l => console.error(l));
    process.exitCode = 1;
    return;
  }

  if (dryRun || !allowLive) {
    receipt.verdict = "ADD_LIQ_SIM_OK";
    writeReceipt("KPX9-ADD-LIQ.json", receipt);
    console.log(`\nSIM_OK liquidity=${liquidity}`);
    return;
  }

  const sig = await sendAndConfirmTransaction(connection, tx, [crank, positionMintKp], { commitment: "confirmed" });
  fs.writeFileSync("keys/kpx9-position-mint.json", JSON.stringify(Array.from(positionMintKp.secretKey)));
  receipt.verdict   = "ADD_LIQ_EXECUTED";
  receipt.signature = sig;
  writeReceipt("KPX9-ADD-LIQ.json", receipt);
  console.log(`\nEXECUTED sig=${sig}`);
  console.log(`position: ${position.toBase58()}`);
  console.log(`liquidity: ${liquidity}`);
}

main().catch(e => { console.error(e); process.exitCode = 1; });
