/**
 * Remove all liquidity from the official Orca KPX9 USDC/HOP Whirlpool position.
 * Recovers owned LP capital back to crank USDC/HOP ATAs, then closes the position NFT.
 */
import "dotenv/config";
import dotenv from "dotenv";
import fs from "node:fs";
import {
  ComputeBudgetProgram,
  Connection,
  Keypair,
  PublicKey,
  Transaction,
  TransactionInstruction,
  sendAndConfirmTransaction,
} from "@solana/web3.js";
import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  createAssociatedTokenAccountIdempotentInstruction,
  getAssociatedTokenAddressSync,
} from "@solana/spl-token";
import { writeReceipt } from "../utils/receipt.js";

if (process.env.ENV_PATH) dotenv.config({ path: process.env.ENV_PATH, override: true });

const OFFICIAL_ORCA = new PublicKey("whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc");
const SPL_MEMO = new PublicKey("MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr");
const USDC_MINT = new PublicKey("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v");
const HOP_MINT = new PublicKey("HZF5k7h39hkysoSZ4ZfmWc55PhvW7ntVvVqdXFCyYGh3");

const DECREASE_LIQ_V2_DISC = Buffer.from([58, 127, 188, 62, 79, 82, 196, 96]);
const COLLECT_FEES_V2_DISC = Buffer.from([207, 117, 95, 191, 229, 180, 226, 15]);
const CLOSE_POSITION_DISC = Buffer.from([123, 134, 81, 0, 49, 68, 98, 98]);

type PoolReceipt = {
  whirlpool?: string;
  tokenMintA?: string;
  tokenMintB?: string;
  tokenVaultA?: string;
  tokenVaultB?: string;
};
type AddLiqReceipt = {
  position?: string;
  positionMint?: string;
  tickLower?: number;
  tickUpper?: number;
  liquidity?: string;
};

function loadKeypair(p: string): Keypair {
  return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(p, "utf8")) as number[]));
}

function readJson<T>(p: string): T {
  return JSON.parse(fs.readFileSync(p, "utf8")) as T;
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

function readU128Le(buf: Buffer, offset: number): bigint {
  return buf.readBigUInt64LE(offset) + (buf.readBigUInt64LE(offset + 8) << 64n);
}

function deriveTickArray(whirlpool: PublicKey, start: number): PublicKey {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("tick_array"), whirlpool.toBuffer(), Buffer.from(String(start))],
    OFFICIAL_ORCA
  )[0];
}

function decodePosition(data: Buffer) {
  return {
    whirlpool: new PublicKey(data.subarray(8, 40)),
    positionMint: new PublicKey(data.subarray(40, 72)),
    liquidity: readU128Le(data, 72),
    tickLowerIndex: data.readInt32LE(88),
    tickUpperIndex: data.readInt32LE(92),
    feeOwedA: data.readBigUInt64LE(112),
    feeOwedB: data.readBigUInt64LE(136),
  };
}

function decodeWhirlpool(data: Buffer) {
  return {
    tickSpacing: data.readUInt16LE(41),
    liquidity: readU128Le(data, 49),
    sqrtPrice: readU128Le(data, 65),
    tickCurrentIndex: data.readInt32LE(81),
    tokenMintA: new PublicKey(data.subarray(101, 133)),
    tokenVaultA: new PublicKey(data.subarray(133, 165)),
    tokenMintB: new PublicKey(data.subarray(181, 213)),
    tokenVaultB: new PublicKey(data.subarray(213, 245)),
  };
}

function decreaseLiquidityV2Ix(args: {
  whirlpool: PublicKey;
  tokenProgramA: PublicKey;
  tokenProgramB: PublicKey;
  positionAuthority: PublicKey;
  position: PublicKey;
  positionTokenAccount: PublicKey;
  tokenMintA: PublicKey;
  tokenMintB: PublicKey;
  tokenOwnerAccountA: PublicKey;
  tokenOwnerAccountB: PublicKey;
  tokenVaultA: PublicKey;
  tokenVaultB: PublicKey;
  tickArrayLower: PublicKey;
  tickArrayUpper: PublicKey;
  liquidityAmount: bigint;
  tokenMinA: bigint;
  tokenMinB: bigint;
}): TransactionInstruction {
  return new TransactionInstruction({
    programId: OFFICIAL_ORCA,
    keys: [
      { pubkey: args.whirlpool, isSigner: false, isWritable: true },
      { pubkey: args.tokenProgramA, isSigner: false, isWritable: false },
      { pubkey: args.tokenProgramB, isSigner: false, isWritable: false },
      { pubkey: SPL_MEMO, isSigner: false, isWritable: false },
      { pubkey: args.positionAuthority, isSigner: true, isWritable: false },
      { pubkey: args.position, isSigner: false, isWritable: true },
      { pubkey: args.positionTokenAccount, isSigner: false, isWritable: false },
      { pubkey: args.tokenMintA, isSigner: false, isWritable: false },
      { pubkey: args.tokenMintB, isSigner: false, isWritable: false },
      { pubkey: args.tokenOwnerAccountA, isSigner: false, isWritable: true },
      { pubkey: args.tokenOwnerAccountB, isSigner: false, isWritable: true },
      { pubkey: args.tokenVaultA, isSigner: false, isWritable: true },
      { pubkey: args.tokenVaultB, isSigner: false, isWritable: true },
      { pubkey: args.tickArrayLower, isSigner: false, isWritable: true },
      { pubkey: args.tickArrayUpper, isSigner: false, isWritable: true },
    ],
    data: Buffer.concat([
      DECREASE_LIQ_V2_DISC,
      u128Le(args.liquidityAmount),
      u64Le(args.tokenMinA),
      u64Le(args.tokenMinB),
      Buffer.from([0x00]),
    ]),
  });
}

function collectFeesV2Ix(args: {
  whirlpool: PublicKey;
  positionAuthority: PublicKey;
  position: PublicKey;
  positionTokenAccount: PublicKey;
  tokenMintA: PublicKey;
  tokenMintB: PublicKey;
  tokenOwnerAccountA: PublicKey;
  tokenVaultA: PublicKey;
  tokenOwnerAccountB: PublicKey;
  tokenVaultB: PublicKey;
  tokenProgramA: PublicKey;
  tokenProgramB: PublicKey;
}): TransactionInstruction {
  return new TransactionInstruction({
    programId: OFFICIAL_ORCA,
    keys: [
      { pubkey: args.whirlpool, isSigner: false, isWritable: false },
      { pubkey: args.positionAuthority, isSigner: true, isWritable: false },
      { pubkey: args.position, isSigner: false, isWritable: true },
      { pubkey: args.positionTokenAccount, isSigner: false, isWritable: false },
      { pubkey: args.tokenMintA, isSigner: false, isWritable: false },
      { pubkey: args.tokenMintB, isSigner: false, isWritable: false },
      { pubkey: args.tokenOwnerAccountA, isSigner: false, isWritable: true },
      { pubkey: args.tokenVaultA, isSigner: false, isWritable: true },
      { pubkey: args.tokenOwnerAccountB, isSigner: false, isWritable: true },
      { pubkey: args.tokenVaultB, isSigner: false, isWritable: true },
      { pubkey: args.tokenProgramA, isSigner: false, isWritable: false },
      { pubkey: args.tokenProgramB, isSigner: false, isWritable: false },
      { pubkey: SPL_MEMO, isSigner: false, isWritable: false },
    ],
    data: Buffer.concat([COLLECT_FEES_V2_DISC, Buffer.from([0x00])]),
  });
}

function closePositionIx(args: {
  positionAuthority: PublicKey;
  receiver: PublicKey;
  position: PublicKey;
  positionMint: PublicKey;
  positionTokenAccount: PublicKey;
}): TransactionInstruction {
  return new TransactionInstruction({
    programId: OFFICIAL_ORCA,
    keys: [
      { pubkey: args.positionAuthority, isSigner: true, isWritable: false },
      { pubkey: args.receiver, isSigner: false, isWritable: true },
      { pubkey: args.position, isSigner: false, isWritable: true },
      { pubkey: args.positionMint, isSigner: false, isWritable: true },
      { pubkey: args.positionTokenAccount, isSigner: false, isWritable: true },
      { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
    ],
    data: CLOSE_POSITION_DISC,
  });
}

async function tokenBalance(connection: Connection, ata: PublicKey): Promise<bigint> {
  return BigInt((await connection.getTokenAccountBalance(ata, "confirmed").catch(() => null))?.value.amount ?? "0");
}

async function main() {
  const rpcUrl = process.env.SOLANA_RPC_URL || process.env.RPC_URL || "https://api.mainnet-beta.solana.com";
  const dryRun = process.env.DRY_RUN !== "false";
  const allowLive = process.env.ALLOW_LIVE === "true";
  const connection = new Connection(rpcUrl, "confirmed");
  const crank = loadKeypair(process.env.CRANK_KEYPAIR_PATH || "keys/crank.json");

  const poolR = readJson<PoolReceipt>(process.env.KPX9_POOL_RECEIPT || "receipts/KPX9-POOL.json");
  const liqR = readJson<AddLiqReceipt>(process.env.KPX9_ADD_LIQ_RECEIPT || "receipts/KPX9-ADD-LIQ.json");

  const whirlpool = new PublicKey(poolR.whirlpool!);
  const position = new PublicKey(liqR.position!);
  const positionMint = new PublicKey(liqR.positionMint!);
  const tokenMintA = new PublicKey(poolR.tokenMintA!);
  const tokenMintB = new PublicKey(poolR.tokenMintB!);
  const tokenVaultA = new PublicKey(poolR.tokenVaultA!);
  const tokenVaultB = new PublicKey(poolR.tokenVaultB!);
  const tokenProgramA = tokenMintA.equals(USDC_MINT) ? TOKEN_PROGRAM_ID : TOKEN_2022_PROGRAM_ID;
  const tokenProgramB = tokenMintB.equals(USDC_MINT) ? TOKEN_PROGRAM_ID : TOKEN_2022_PROGRAM_ID;

  const positionTokenAccount = getAssociatedTokenAddressSync(positionMint, crank.publicKey, false, TOKEN_PROGRAM_ID);
  const tokenOwnerAccountA = getAssociatedTokenAddressSync(tokenMintA, crank.publicKey, false, tokenProgramA);
  const tokenOwnerAccountB = getAssociatedTokenAddressSync(tokenMintB, crank.publicKey, false, tokenProgramB);

  const [positionInfo, whirlpoolInfo] = await Promise.all([
    connection.getAccountInfo(position, "confirmed"),
    connection.getAccountInfo(whirlpool, "confirmed"),
  ]);
  if (!positionInfo) throw new Error(`Missing position ${position.toBase58()}`);
  if (!whirlpoolInfo) throw new Error(`Missing whirlpool ${whirlpool.toBase58()}`);

  const positionState = decodePosition(Buffer.from(positionInfo.data));
  const poolState = decodeWhirlpool(Buffer.from(whirlpoolInfo.data));
  const liquidity = positionState.liquidity;
  if (liquidity === 0n) {
    const receipt = {
      verdict: "NO_LIQUIDITY",
      whirlpool: whirlpool.toBase58(),
      position: position.toBase58(),
      positionMint: positionMint.toBase58(),
      dryRun,
    };
    writeReceipt("KPX9-REMOVE-LIQ.json", receipt);
    console.log("NO_LIQUIDITY");
    return;
  }

  const tickArrayLower = deriveTickArray(whirlpool, Number(liqR.tickLower ?? positionState.tickLowerIndex));
  const tickArrayUpper = deriveTickArray(whirlpool, Number(liqR.tickUpper ?? positionState.tickUpperIndex) - (88 - 1) * 64);

  const before = {
    solLamports: (await connection.getBalance(crank.publicKey, "confirmed")).toString(),
    tokenA: (await tokenBalance(connection, tokenOwnerAccountA)).toString(),
    tokenB: (await tokenBalance(connection, tokenOwnerAccountB)).toString(),
    usdc: (await tokenBalance(connection, getAssociatedTokenAddressSync(USDC_MINT, crank.publicKey, false, TOKEN_PROGRAM_ID))).toString(),
    hop: (await tokenBalance(connection, getAssociatedTokenAddressSync(HOP_MINT, crank.publicKey, false, TOKEN_2022_PROGRAM_ID))).toString(),
  };

  console.log("=== KPX9 REMOVE LIQUIDITY ===");
  console.log(`program:       ${OFFICIAL_ORCA.toBase58()}`);
  console.log(`pool:          ${whirlpool.toBase58()}`);
  console.log(`position:      ${position.toBase58()}`);
  console.log(`positionMint:  ${positionMint.toBase58()}`);
  console.log(`liquidity:     ${liquidity}`);
  console.log(`tickLower:     ${positionState.tickLowerIndex}`);
  console.log(`tickUpper:     ${positionState.tickUpperIndex}`);
  console.log(`poolTick:      ${poolState.tickCurrentIndex}`);
  console.log(`dry_run:       ${dryRun}`);

  const common = {
    whirlpool,
    positionAuthority: crank.publicKey,
    position,
    positionTokenAccount,
    tokenMintA,
    tokenMintB,
    tokenOwnerAccountA,
    tokenOwnerAccountB,
    tokenVaultA,
    tokenVaultB,
    tokenProgramA,
    tokenProgramB,
  };

  const tx = new Transaction()
    .add(ComputeBudgetProgram.setComputeUnitLimit({ units: 500_000 }))
    .add(createAssociatedTokenAccountIdempotentInstruction(crank.publicKey, tokenOwnerAccountA, crank.publicKey, tokenMintA, tokenProgramA, ASSOCIATED_TOKEN_PROGRAM_ID))
    .add(createAssociatedTokenAccountIdempotentInstruction(crank.publicKey, tokenOwnerAccountB, crank.publicKey, tokenMintB, tokenProgramB, ASSOCIATED_TOKEN_PROGRAM_ID))
    .add(decreaseLiquidityV2Ix({
      ...common,
      tickArrayLower,
      tickArrayUpper,
      liquidityAmount: liquidity,
      tokenMinA: 0n,
      tokenMinB: 0n,
    }))
    .add(collectFeesV2Ix(common))
    .add(closePositionIx({
      positionAuthority: crank.publicKey,
      receiver: crank.publicKey,
      position,
      positionMint,
      positionTokenAccount,
    }));

  tx.feePayer = crank.publicKey;
  tx.recentBlockhash = (await connection.getLatestBlockhash("confirmed")).blockhash;
  tx.sign(crank);

  const receipt: Record<string, unknown> = {
    verdict: "",
    whirlpool: whirlpool.toBase58(),
    position: position.toBase58(),
    positionMint: positionMint.toBase58(),
    liquidity: liquidity.toString(),
    tickArrayLower: tickArrayLower.toBase58(),
    tickArrayUpper: tickArrayUpper.toBase58(),
    tokenMintA: tokenMintA.toBase58(),
    tokenMintB: tokenMintB.toBase58(),
    tokenVaultA: tokenVaultA.toBase58(),
    tokenVaultB: tokenVaultB.toBase58(),
    tokenOwnerAccountA: tokenOwnerAccountA.toBase58(),
    tokenOwnerAccountB: tokenOwnerAccountB.toBase58(),
    before,
    dryRun,
    signature: null as string | null,
  };

  const sim = await connection.simulateTransaction(tx);
  receipt.simErr = sim.value.err ?? null;
  receipt.simLogs = sim.value.logs?.slice(-20) ?? [];
  receipt.unitsConsumed = sim.value.unitsConsumed ?? null;

  if (sim.value.err) {
    receipt.verdict = "REMOVE_LIQ_SIM_FAILED";
    writeReceipt("KPX9-REMOVE-LIQ.json", receipt);
    console.error(`SIM_FAILED: ${JSON.stringify(sim.value.err)}`);
    (receipt.simLogs as string[]).forEach((l) => console.error(l));
    process.exitCode = 1;
    return;
  }

  if (dryRun || !allowLive) {
    receipt.verdict = "REMOVE_LIQ_SIM_OK";
    writeReceipt("KPX9-REMOVE-LIQ.json", receipt);
    console.log(`SIM_OK liquidity=${liquidity}`);
    return;
  }

  const sig = await sendAndConfirmTransaction(connection, tx, [crank], { commitment: "confirmed" });
  const after = {
    solLamports: (await connection.getBalance(crank.publicKey, "confirmed")).toString(),
    tokenA: (await tokenBalance(connection, tokenOwnerAccountA)).toString(),
    tokenB: (await tokenBalance(connection, tokenOwnerAccountB)).toString(),
    usdc: (await tokenBalance(connection, getAssociatedTokenAddressSync(USDC_MINT, crank.publicKey, false, TOKEN_PROGRAM_ID))).toString(),
    hop: (await tokenBalance(connection, getAssociatedTokenAddressSync(HOP_MINT, crank.publicKey, false, TOKEN_2022_PROGRAM_ID))).toString(),
  };

  receipt.verdict = "REMOVE_LIQ_EXECUTED";
  receipt.signature = sig;
  receipt.after = after;
  receipt.delta = {
    solLamports: (BigInt(after.solLamports) - BigInt(before.solLamports)).toString(),
    tokenA: (BigInt(after.tokenA) - BigInt(before.tokenA)).toString(),
    tokenB: (BigInt(after.tokenB) - BigInt(before.tokenB)).toString(),
    usdc: (BigInt(after.usdc) - BigInt(before.usdc)).toString(),
    hop: (BigInt(after.hop) - BigInt(before.hop)).toString(),
  };
  writeReceipt("KPX9-REMOVE-LIQ.json", receipt);

  console.log(`EXECUTED sig=${sig}`);
  console.log(`delta USDC=${(receipt.delta as Record<string, string>).usdc}`);
  console.log(`delta HOP=${(receipt.delta as Record<string, string>).hop}`);
}

main().catch((e) => { console.error(e); process.exitCode = 1; });
