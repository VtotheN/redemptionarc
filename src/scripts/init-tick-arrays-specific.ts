import "dotenv/config";
import { PublicKey, Transaction, sendAndConfirmTransaction } from "@solana/web3.js";
import { loadConfig } from "../config.js";
import { connectionFor } from "../utils/rpc.js";
import { writeReceipt } from "../utils/receipt.js";
import { assertKeypairMatches, loadKeypair } from "../utils/keypair.js";
import { assertLiveAllowed, assertNoForbiddenConfigured } from "../utils/safety.js";
import { deriveTickArray, initializeTickArrayIx } from "../utils/orca-whirlpool.js";

const starts = [101376, 107008];
const whirlpool = new PublicKey("8aoWgf7ycbeKv6BTFCdUj4JR7Y4mXWuPZWEUhmuzN5ZL");

async function main() {
  const config = loadConfig();
  assertNoForbiddenConfigured(config);
  assertLiveAllowed(config);
  if (!config.crank) throw new Error("Missing REDEMPTION_CRANK");

  const connection = connectionFor(config.rpcUrl);
  const funder = loadKeypair("keys/crank.json");
  assertKeypairMatches("crank", funder, config.crank);

  for (const start of starts) {
    const pda = deriveTickArray(whirlpool, start);
    console.log(`TICK_ARRAY_${start} PDA: ${pda.toBase58()}`);
  }

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
    tickArrayStarts: starts,
    tickArrays: tickArrayMeta,
  };

  if (ixs.length === 0) {
    receipt.verdict = "TICK_ARRAYS_ALREADY_INITIALIZED";
    writeReceipt("REDEMPTION-ORCA-TICK-ARRAYS-SPECIFIC.json", receipt);
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
    writeReceipt("REDEMPTION-ORCA-TICK-ARRAYS-SPECIFIC.json", receipt);
    console.error(`TICK_ARRAYS_SIM_FAILED err=${JSON.stringify(sim.value.err)}`);
    console.error((sim.value.logs ?? []).slice(-5).join("\n"));
    process.exitCode = 1;
    return;
  }

  if (config.dryRun) {
    receipt.verdict = "TICK_ARRAYS_SIM_OK_DRY_RUN";
    writeReceipt("REDEMPTION-ORCA-TICK-ARRAYS-SPECIFIC.json", receipt);
    console.log(`TICK_ARRAYS_SIM_OK_DRY_RUN starts=${starts.join(",")}`);
    return;
  }

  const sig = await sendAndConfirmTransaction(connection, tx, [funder], { commitment: "confirmed" });
  receipt.verdict = "TICK_ARRAYS_DEPLOYED";
  receipt.signature = sig;
  writeReceipt("REDEMPTION-ORCA-TICK-ARRAYS-SPECIFIC.json", receipt);
  console.log(`TICK_ARRAYS_DEPLOYED sig=${sig} starts=${starts.join(",")}`);
}

main().catch((e) => { console.error(e); process.exitCode = 1; });
