/**
 * Initialize 3 tick arrays around current price for KPX9 pool.
 * Reads KPX9-POOL.json for pool address and initialSqrtPrice.
 * Writes KPX9-TICK-ARRAYS.json receipt.
 */
import "dotenv/config";
import dotenv from "dotenv";
import fs from "node:fs";
import {
  Connection, Keypair, PublicKey, SystemProgram, Transaction,
  TransactionInstruction, sendAndConfirmTransaction,
} from "@solana/web3.js";
import { writeReceipt } from "../utils/receipt.js";

if (process.env.ENV_PATH) dotenv.config({ path: process.env.ENV_PATH, override: true });

const OFFICIAL_ORCA  = new PublicKey("whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc");
const TICK_SPACING   = 64;
const TICK_ARRAY_SIZE = 88;

const INIT_TICK_ARRAY_DISC = Buffer.from([11, 188, 193, 214, 141, 91, 149, 184]);

function loadKeypair(p: string): Keypair {
  return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(p, "utf8")) as number[]));
}

function i32Le(v: number): Buffer {
  const b = Buffer.alloc(4); b.writeInt32LE(v); return b;
}

function deriveTickArray(whirlpool: PublicKey, startTickIndex: number): PublicKey {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("tick_array"), whirlpool.toBuffer(), Buffer.from(String(startTickIndex))],
    OFFICIAL_ORCA
  )[0];
}

function sqrtPriceX64ToTick(sqrtPriceX64: bigint): number {
  const sqrtNum = Number(sqrtPriceX64);
  const Q64 = Math.pow(2, 64);
  const sqrtPrice = sqrtNum / Q64;
  const price = sqrtPrice * sqrtPrice;
  return Math.floor(Math.log(price) / Math.log(1.0001));
}

function tickArrayStart(tick: number, tickSpacing: number): number {
  const range = tickSpacing * TICK_ARRAY_SIZE;
  return Math.floor(tick / range) * range;
}

type PoolReceipt = { whirlpool?: string; initialSqrtPrice?: string };

function readPoolReceipt(): PoolReceipt {
  const file = process.env.KPX9_POOL_RECEIPT || "receipts/KPX9-POOL.json";
  if (!fs.existsSync(file)) throw new Error(`Missing ${file} — run init-kpx9-pool first`);
  return JSON.parse(fs.readFileSync(file, "utf8")) as PoolReceipt;
}

async function main() {
  const rpcUrl    = process.env.SOLANA_RPC_URL || process.env.RPC_URL || "https://api.mainnet-beta.solana.com";
  const dryRun    = process.env.DRY_RUN !== "false";
  const allowLive = process.env.ALLOW_LIVE === "true";
  const connection = new Connection(rpcUrl, "confirmed");

  const crank = loadKeypair(process.env.CRANK_KEYPAIR_PATH || "keys/crank.json");
  const poolReceipt  = readPoolReceipt();
  const whirlpool    = new PublicKey(poolReceipt.whirlpool!);
  const sqrtPriceX64 = BigInt(poolReceipt.initialSqrtPrice!);

  const currentTick  = sqrtPriceX64ToTick(sqrtPriceX64);
  const range        = TICK_SPACING * TICK_ARRAY_SIZE; // 5632
  const currentStart = tickArrayStart(currentTick, TICK_SPACING);
  const starts       = [currentStart - range, currentStart, currentStart + range];

  console.log("=== KPX9 INIT TICK ARRAYS ===");
  console.log(`program:     ${OFFICIAL_ORCA.toBase58()}`);
  console.log(`pool:        ${whirlpool.toBase58()}`);
  console.log(`currentTick: ${currentTick}`);
  console.log(`starts:      ${starts.join(", ")}`);

  const tickArrayMeta: { start: number; address: string; existed: boolean }[] = [];
  const ixs: TransactionInstruction[] = [];

  for (const start of starts) {
    const ta   = deriveTickArray(whirlpool, start);
    const info = await connection.getAccountInfo(ta, "confirmed");
    tickArrayMeta.push({ start, address: ta.toBase58(), existed: Boolean(info) });
    if (!info) {
      ixs.push(new TransactionInstruction({
        programId: OFFICIAL_ORCA,
        keys: [
          { pubkey: whirlpool,               isSigner: false, isWritable: false },
          { pubkey: crank.publicKey,         isSigner: true,  isWritable: true  },
          { pubkey: ta,                      isSigner: false, isWritable: true  },
          { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
        ],
        data: Buffer.concat([INIT_TICK_ARRAY_DISC, i32Le(start)]),
      }));
    }
    console.log(`  ${start}: ${ta.toBase58()} ${info ? "(exists)" : "(will init)"}`);
  }

  const receipt: Record<string, unknown> = {
    verdict: "",
    whirlpool: whirlpool.toBase58(),
    currentTick,
    tickArrayStarts: starts,
    tickArrays: tickArrayMeta,
    // For add-kpx9-liquidity: position range spanning all 3 arrays
    tickLower: starts[0],
    tickUpper: starts[2] + (TICK_ARRAY_SIZE - 1) * TICK_SPACING,
    dryRun,
    signature: null as string | null,
  };

  if (ixs.length === 0) {
    receipt.verdict = "TICK_ARRAYS_ALREADY_EXIST";
    writeReceipt("KPX9-TICK-ARRAYS.json", receipt);
    console.log("\nTICK_ARRAYS_ALREADY_EXIST");
    return;
  }

  const tx = new Transaction().add(...ixs);
  tx.feePayer = crank.publicKey;
  tx.recentBlockhash = (await connection.getLatestBlockhash("confirmed")).blockhash;

  const sim = await connection.simulateTransaction(tx);
  receipt.simErr  = sim.value.err ?? null;
  receipt.simLogs = sim.value.logs?.slice(-8) ?? [];

  if (sim.value.err) {
    receipt.verdict = "TICK_ARRAYS_SIM_FAILED";
    writeReceipt("KPX9-TICK-ARRAYS.json", receipt);
    console.error(`SIM_FAILED: ${JSON.stringify(sim.value.err)}`);
    (receipt.simLogs as string[]).forEach(l => console.error(l));
    process.exitCode = 1;
    return;
  }

  if (dryRun || !allowLive) {
    receipt.verdict = "TICK_ARRAYS_SIM_OK";
    writeReceipt("KPX9-TICK-ARRAYS.json", receipt);
    console.log(`\nSIM_OK starts=${starts.join(",")}`);
    return;
  }

  const sig = await sendAndConfirmTransaction(connection, tx, [crank], { commitment: "confirmed" });
  receipt.verdict   = "TICK_ARRAYS_EXECUTED";
  receipt.signature = sig;
  writeReceipt("KPX9-TICK-ARRAYS.json", receipt);
  console.log(`\nEXECUTED sig=${sig}`);
  tickArrayMeta.forEach(m => console.log(`  ${m.start}: ${m.address}`));
}

main().catch(e => { console.error(e); process.exitCode = 1; });
