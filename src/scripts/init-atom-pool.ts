/**
 * Initialize atom_ickk pool on mainnet.
 * Builds raw instruction from IDL discriminator — no anchor-lang dep.
 * TOKEN_MINT defaults to USDC. PYTH_PRICE_FEED defaults to USDC/USD feed.
 */
import "dotenv/config";
import fs from "node:fs";
import {
  Connection, Keypair, PublicKey, Transaction,
  TransactionInstruction, AccountMeta, sendAndConfirmTransaction,
  ComputeBudgetProgram, SystemProgram,
} from "@solana/web3.js";
import { TOKEN_PROGRAM_ID } from "@solana/spl-token";
import { writeReceipt } from "../utils/receipt.js";

const ATOM_PROGRAM_ID = new PublicKey("BxJMJLxXJhKvuhvvxY57wYY69CAs9RCQWBv9JPCtm9Kx");
const USDC_MINT = new PublicKey("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v");
const PYTH_USDC_USD = new PublicKey("Gnt27xtC473ZT2Mw5u8wZ68Z3gULkSTb5DuxJy7eJotD");

// initialize_pool discriminator from IDL
const INIT_POOL_DISC = Buffer.from([95, 180, 10, 172, 84, 174, 232, 40]);

function loadKeypair(p: string): Keypair {
  return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(p, "utf8"))));
}

function encodeInitPoolArgs(flashFeeBps: number, keeperRewardBps: number, insuranceMinBps: number, maxDeadlineSlots: bigint): Buffer {
  const buf = Buffer.allocUnsafe(8 + 2 + 2 + 2 + 8);
  INIT_POOL_DISC.copy(buf, 0);
  buf.writeUInt16LE(flashFeeBps, 8);
  buf.writeUInt16LE(keeperRewardBps, 10);
  buf.writeUInt16LE(insuranceMinBps, 12);
  buf.writeBigUInt64LE(maxDeadlineSlots, 14);
  return buf;
}

async function main() {
  const rpc = process.env.SOLANA_RPC_URL || "https://mainnet.helius-rpc.com/?api-key=5b121325-36cb-473b-bbeb-47490d21479c";
  const dryRun = process.env.DRY_RUN !== "false";
  const allowLive = process.env.ALLOW_LIVE === "true";

  const tokenMint = new PublicKey(process.env.TOKEN_MINT || USDC_MINT.toBase58());
  const pythFeed = new PublicKey(process.env.PYTH_PRICE_FEED || PYTH_USDC_USD.toBase58());
  const flashFeeBps = Number(process.env.FLASH_FEE_BPS || "30");
  const keeperRewardBps = Number(process.env.KEEPER_REWARD_BPS || "50");
  const insuranceMinBps = Number(process.env.INSURANCE_MIN_BPS || "500");
  const maxDeadlineSlots = BigInt(process.env.MAX_DEADLINE_SLOTS || "150");

  const conn = new Connection(rpc, "confirmed");
  const crank = loadKeypair("keys/crank.json");

  const [poolPda] = PublicKey.findProgramAddressSync(
    [Buffer.from("pool"), tokenMint.toBuffer()],
    ATOM_PROGRAM_ID
  );
  const [vaultPda] = PublicKey.findProgramAddressSync(
    [Buffer.from("vault"), poolPda.toBuffer()],
    ATOM_PROGRAM_ID
  );

  console.log("=== ATOM ICKK INIT POOL ===");
  console.log(`Program:   ${ATOM_PROGRAM_ID.toBase58()}`);
  console.log(`Authority: ${crank.publicKey.toBase58()}`);
  console.log(`Token:     ${tokenMint.toBase58()}`);
  console.log(`Pyth:      ${pythFeed.toBase58()}`);
  console.log(`Pool PDA:  ${poolPda.toBase58()}`);
  console.log(`Vault PDA: ${vaultPda.toBase58()}`);
  console.log(`flashFeeBps=${flashFeeBps} keeperRewardBps=${keeperRewardBps} insuranceMinBps=${insuranceMinBps} maxDeadlineSlots=${maxDeadlineSlots}`);

  const existing = await conn.getAccountInfo(poolPda);
  if (existing) {
    console.log("Pool already initialized. Reading on-chain data...");
    const receipt = {
      verdict: "ALREADY_EXISTS",
      programId: ATOM_PROGRAM_ID.toBase58(),
      poolPda: poolPda.toBase58(),
      vaultPda: vaultPda.toBase58(),
      tokenMint: tokenMint.toBase58(),
      pythPriceFeed: pythFeed.toBase58(),
      fees: { flashFeeBps, keeperRewardBps, insuranceMinBps, maxDeadlineSlots: Number(maxDeadlineSlots) },
    };
    writeReceipt("pool-mainnet", receipt);
    console.log("Pool exists. Receipt saved.");
    return;
  }

  const data = encodeInitPoolArgs(flashFeeBps, keeperRewardBps, insuranceMinBps, maxDeadlineSlots);

  const keys: AccountMeta[] = [
    { pubkey: crank.publicKey, isSigner: true, isWritable: true },
    { pubkey: tokenMint, isSigner: false, isWritable: false },
    { pubkey: pythFeed, isSigner: false, isWritable: false },
    { pubkey: poolPda, isSigner: false, isWritable: true },
    { pubkey: vaultPda, isSigner: false, isWritable: true },
    { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
    { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
  ];

  const ix = new TransactionInstruction({ programId: ATOM_PROGRAM_ID, keys, data });
  const cuLimitIx = ComputeBudgetProgram.setComputeUnitLimit({ units: 200000 });
  const cuPriceIx = ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 10000 });

  const tx = new Transaction().add(cuLimitIx, cuPriceIx, ix);

  if (dryRun || !allowLive) {
    const sim = await conn.simulateTransaction(tx, [crank]);
    const verdict = sim.value.err ? "SIM_FAILED" : "SIM_OK";
    console.log(`SIM: ${verdict} cu=${sim.value.unitsConsumed}`);
    if (sim.value.err) console.log("ERR:", JSON.stringify(sim.value.err));
    writeReceipt("pool-mainnet", { verdict, simErr: sim.value.err, poolPda: poolPda.toBase58(), vaultPda: vaultPda.toBase58() });
    return;
  }

  const sig = await sendAndConfirmTransaction(conn, tx, [crank], { commitment: "confirmed" });
  console.log(`TX: ${sig}`);

  const receipt = {
    verdict: "EXECUTED",
    network: "mainnet-beta",
    programId: ATOM_PROGRAM_ID.toBase58(),
    authority: crank.publicKey.toBase58(),
    tokenMint: tokenMint.toBase58(),
    pythPriceFeed: pythFeed.toBase58(),
    poolPda: poolPda.toBase58(),
    vaultPda: vaultPda.toBase58(),
    txSignature: sig,
    explorer: `https://explorer.solana.com/tx/${sig}`,
    fees: { flashFeeBps, keeperRewardBps, insuranceMinBps, maxDeadlineSlots: Number(maxDeadlineSlots) },
  };

  writeReceipt("pool-mainnet", receipt);
  fs.writeFileSync("/Users/velon/Desktop/atom_ickk/pool-mainnet.json", JSON.stringify(receipt, null, 2));
  console.log("Pool initialized. Receipts saved.");
  console.log(JSON.stringify(receipt, null, 2));
}

main().catch(e => { console.error(e); process.exitCode = 1; });
