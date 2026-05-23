import "dotenv/config";
import fs from "node:fs";
import { PublicKey, Transaction, sendAndConfirmTransaction } from "@solana/web3.js";
import { loadConfig } from "../config.js";
import { connectionFor } from "../utils/rpc.js";
import { writeReceipt } from "../utils/receipt.js";
import { assertKeypairMatches, loadKeypair } from "../utils/keypair.js";
import { assertLiveAllowed, assertNoForbiddenConfigured } from "../utils/safety.js";
import { deriveTickArray, initializeTickArrayIx } from "../utils/orca-whirlpool.js";

const TICK_SPACING  = Number(process.env.ORCA_TICK_SPACING || "64");
const TICK_ARRAY_SIZE = 88;

function sqrtPriceX64ToTick(sqrtPriceX64: bigint): number {
  // price = (sqrtPriceX64 / 2^64)^2
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
  const file = "receipts/REDEMPTION-ORCA-POOL.json";
  if (!fs.existsSync(file)) throw new Error(`Missing ${file} — run init-pool first`);
  return JSON.parse(fs.readFileSync(file, "utf8")) as PoolReceipt;
}

async function main() {
  const config = loadConfig();
  assertNoForbiddenConfigured(config);
  assertLiveAllowed(config);
  if (!config.crank) throw new Error("Missing REDEMPTION_CRANK");

  const connection = connectionFor(config.rpcUrl);
  const funder = loadKeypair("keys/crank.json");
  assertKeypairMatches("crank", funder, config.crank);

  const poolReceipt = readPoolReceipt();
  const whirlpool     = new PublicKey(poolReceipt.whirlpool!);
  const sqrtPriceX64  = BigInt(poolReceipt.initialSqrtPrice!);

  const currentTick = sqrtPriceX64ToTick(sqrtPriceX64);
  const currentStart = tickArrayStart(currentTick, TICK_SPACING);
  const range = TICK_SPACING * TICK_ARRAY_SIZE;

  const starts = [currentStart - range, currentStart, currentStart + range];

  const tickArrayMeta: { start: number; address: string; existed: boolean }[] = [];
  const ixs = [];

  for (const start of starts) {
    const tickArray = deriveTickArray(whirlpool, start);
    const info = await connection.getAccountInfo(tickArray, "confirmed");
    tickArrayMeta.push({ start, address: tickArray.toBase58(), existed: Boolean(info) });
    if (!info) {
      ixs.push(initializeTickArrayIx({ whirlpool, funder: funder.publicKey, tickArray, startTickIndex: start }));
    }
  }

  const receipt: Record<string, unknown> = {
    verdict: "TICK_ARRAYS_PLAN_BUILT",
    dryRun: config.dryRun,
    whirlpool: whirlpool.toBase58(),
    currentTick,
    tickArrayStarts: starts,
    tickArrays: tickArrayMeta,
  };

  if (ixs.length === 0) {
    receipt.verdict = "TICK_ARRAYS_ALREADY_INITIALIZED";
    writeReceipt("REDEMPTION-ORCA-TICK-ARRAYS.json", receipt);
    console.log("TICK_ARRAYS_ALREADY_INITIALIZED");
    return;
  }

  const tx = new Transaction().add(...ixs);
  tx.feePayer = funder.publicKey;
  tx.recentBlockhash = (await connection.getLatestBlockhash("confirmed")).blockhash;
  tx.sign(funder);

  const sim = await connection.simulateTransaction(tx);
  receipt.simulation = { err: sim.value.err ?? null, logs: (sim.value.logs ?? []).slice(-5) };

  if (sim.value.err) {
    receipt.verdict = "TICK_ARRAYS_SIM_FAILED";
    writeReceipt("REDEMPTION-ORCA-TICK-ARRAYS.json", receipt);
    console.error(`TICK_ARRAYS_SIM_FAILED err=${JSON.stringify(sim.value.err)}`);
    console.error((sim.value.logs ?? []).slice(-5).join("\n"));
    process.exitCode = 1;
    return;
  }

  if (config.dryRun) {
    receipt.verdict = "TICK_ARRAYS_SIM_OK_DRY_RUN";
    writeReceipt("REDEMPTION-ORCA-TICK-ARRAYS.json", receipt);
    console.log(`TICK_ARRAYS_SIM_OK_DRY_RUN tick=${currentTick} starts=${starts.join(",")}`);
    return;
  }

  const sig = await sendAndConfirmTransaction(connection, tx, [funder], { commitment: "confirmed" });
  receipt.verdict = "TICK_ARRAYS_DEPLOYED";
  receipt.signature = sig;
  writeReceipt("REDEMPTION-ORCA-TICK-ARRAYS.json", receipt);
  console.log(`TICK_ARRAYS_DEPLOYED sig=${sig} starts=${starts.join(",")}`);
}

main().catch((e) => { console.error(e); process.exitCode = 1; });
