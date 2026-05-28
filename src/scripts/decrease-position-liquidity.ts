/**
 * Remove REMOVE_PCT% of position #1 liquidity via decrease_liquidity_v2.
 * ENV: REMOVE_PCT (default 50), DRY_RUN, ALLOW_LIVE
 */
import "dotenv/config";
import { PublicKey, Transaction, sendAndConfirmTransaction, ComputeBudgetProgram, TransactionInstruction } from "@solana/web3.js";
import { getAssociatedTokenAddressSync, TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID } from "@solana/spl-token";
import { Connection } from "@solana/web3.js";
import { loadConfig } from "../config.js";
import { connectionFor } from "../utils/rpc.js";
import { writeReceipt } from "../utils/receipt.js";
import { assertKeypairMatches, loadKeypair } from "../utils/keypair.js";
import { assertLiveAllowed, assertNoForbiddenConfigured } from "../utils/safety.js";
import { deriveTickArray, tickToSqrtPriceX64 } from "../utils/orca-whirlpool.js";

const WHIRLPOOL_PROGRAM = new PublicKey("GxRHMB9a6XE8BqGPeNb9UkJUPvbvrPoPgNTJPJJA4n8h");
const WHIRLPOOL     = new PublicKey("8aoWgf7ycbeKv6BTFCdUj4JR7Y4mXWuPZWEUhmuzN5ZL");
const TOKEN_VAULT_A = new PublicKey("4QD4GgnjRvjETqWLT5e3x7SHtJSzs9kShUPLfyHcTu7d");
const TOKEN_VAULT_B = new PublicKey("Qv51R47g7pMDxa3UofXaz8cNr8pwRSXaNufgnEWX8Yk");
const POSITION      = new PublicKey("ErgQU48egJMNBLZeVkdjrtZrSWUQJCky3deh2B4U1YPQ");
const POSITION_TA   = new PublicKey("GgLpt3VY9vWKLnNa5Dj3FKvBn3JEDL4KTKpabCAfL54Q");
const USDC_MINT     = new PublicKey("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v");
const HOP_MINT      = new PublicKey("HZF5k7h39hkysoSZ4ZfmWc55PhvW7ntVvVqdXFCyYGh3");
const TICK_LOWER    = 84480;
const TICK_UPPER    = 101312;
const DECREASE_LIQ_DISC = Buffer.from([58, 127, 188, 62, 79, 82, 196, 96]);
const SPL_MEMO = new PublicKey("MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr");
const Q64 = 1n << 64n;

function u64Le(n: bigint): Buffer { const b = Buffer.alloc(8); b.writeBigUInt64LE(n); return b; }
function u128Le(n: bigint): Buffer {
  const b = Buffer.alloc(16);
  b.writeBigUInt64LE(n & ((1n << 64n) - 1n), 0);
  b.writeBigUInt64LE(n >> 64n, 8);
  return b;
}

async function readPoolState(connection: Connection) {
  const info = await connection.getAccountInfo(WHIRLPOOL, "confirmed");
  if (!info) throw new Error("Pool not found");
  const sqrtPrice = info.data.readBigUInt64LE(65) | (info.data.readBigUInt64LE(73) << 64n);
  const tick = info.data.readInt32LE(81);
  return { sqrtPrice, tick };
}

async function readPositionLiquidity(connection: Connection): Promise<bigint> {
  const info = await connection.getAccountInfo(POSITION, "confirmed");
  if (!info) throw new Error("Position not found");
  return info.data.readBigUInt64LE(72) | (info.data.readBigUInt64LE(80) << 64n);
}

async function main() {
  const config = loadConfig();
  assertNoForbiddenConfigured(config);
  assertLiveAllowed(config);
  if (!config.crank) throw new Error("Missing REDEMPTION_CRANK");

  const connection = connectionFor(config.rpcUrl);
  const crank = loadKeypair("keys/crank.json");
  assertKeypairMatches("crank", crank, config.crank);

  const removePct = Number(process.env.REMOVE_PCT ?? "50");
  if (removePct <= 0 || removePct > 100) throw new Error("REMOVE_PCT must be 1-100");

  const { sqrtPrice, tick } = await readPoolState(connection);
  const posLiq = await readPositionLiquidity(connection);
  const liquidityToRemove = (posLiq * BigInt(removePct)) / 100n;

  const sqrtPLower = tickToSqrtPriceX64(TICK_LOWER);
  const sqrtPUpper = tickToSqrtPriceX64(TICK_UPPER);

  // USDC out: L × (sqrtPUpper - sqrtP) × Q64 / (sqrtP × sqrtPUpper)
  const usdcOut = (liquidityToRemove * (sqrtPUpper - sqrtPrice) * Q64) / (sqrtPrice * sqrtPUpper);
  // HOP out: L × (sqrtP - sqrtPLower) / Q64
  const hopOut  = (liquidityToRemove * (sqrtPrice - sqrtPLower)) / Q64;

  const tokenMinA = (usdcOut * 95n) / 100n;
  const tokenMinB = (hopOut  * 95n) / 100n;

  const tickArrayLower = deriveTickArray(WHIRLPOOL, TICK_LOWER);  // 84480
  const tickArrayUpper = deriveTickArray(WHIRLPOOL, 95744);        // contains 101312

  console.log(`posLiq:          ${posLiq}`);
  console.log(`removePct:       ${removePct}%`);
  console.log(`liquidityRemove: ${liquidityToRemove}`);
  console.log(`tick:            ${tick}`);
  console.log(`est USDC out:    $${(Number(usdcOut)/1e6).toFixed(4)}`);
  console.log(`est HOP out:     ${(Number(hopOut)/1e6).toFixed(4)} HOP`);
  console.log(`tokenMinA:       ${tokenMinA} (95%)`);
  console.log(`tokenMinB:       ${tokenMinB} (95%)`);

  const crankUsdcAta = getAssociatedTokenAddressSync(USDC_MINT, crank.publicKey, false, TOKEN_PROGRAM_ID);
  const crankHopAta  = getAssociatedTokenAddressSync(HOP_MINT,  crank.publicKey, false, TOKEN_2022_PROGRAM_ID);

  const decreaseIx = new TransactionInstruction({
    programId: WHIRLPOOL_PROGRAM,
    keys: [
      { pubkey: WHIRLPOOL,                isSigner: false, isWritable: true  },
      { pubkey: TOKEN_PROGRAM_ID,         isSigner: false, isWritable: false },
      { pubkey: TOKEN_2022_PROGRAM_ID,    isSigner: false, isWritable: false },
      { pubkey: SPL_MEMO,                 isSigner: false, isWritable: false },
      { pubkey: crank.publicKey,          isSigner: true,  isWritable: false },
      { pubkey: POSITION,                 isSigner: false, isWritable: true  },
      { pubkey: POSITION_TA,              isSigner: false, isWritable: false },
      { pubkey: USDC_MINT,                isSigner: false, isWritable: false },
      { pubkey: HOP_MINT,                 isSigner: false, isWritable: false },
      { pubkey: crankUsdcAta,             isSigner: false, isWritable: true  },
      { pubkey: crankHopAta,              isSigner: false, isWritable: true  },
      { pubkey: TOKEN_VAULT_A,            isSigner: false, isWritable: true  },
      { pubkey: TOKEN_VAULT_B,            isSigner: false, isWritable: true  },
      { pubkey: tickArrayLower,           isSigner: false, isWritable: true  },
      { pubkey: tickArrayUpper,           isSigner: false, isWritable: true  },
    ],
    data: Buffer.concat([
      DECREASE_LIQ_DISC,
      u128Le(liquidityToRemove),
      u64Le(tokenMinA),
      u64Le(tokenMinB),
      Buffer.from([0x00]),
    ]),
  });

  const tx = new Transaction()
    .add(ComputeBudgetProgram.setComputeUnitLimit({ units: 300_000 }))
    .add(ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 50_000 }))
    .add(decreaseIx);
  tx.feePayer = crank.publicKey;
  tx.recentBlockhash = (await connection.getLatestBlockhash("confirmed")).blockhash;
  tx.sign(crank);

  const sim = await connection.simulateTransaction(tx);
  const receipt: Record<string, unknown> = {
    verdict: "DECREASE_LIQ_PLAN",
    removePct, liquidityToRemove: liquidityToRemove.toString(),
    posLiq: posLiq.toString(), tick,
    estUsdcOut: Number(usdcOut)/1e6, estHopOut: Number(hopOut)/1e6,
    dryRun: config.dryRun,
    simulation: { err: sim.value.err ?? null, logs: (sim.value.logs ?? []).slice(-10) },
  };

  if (sim.value.err) {
    receipt.verdict = "DECREASE_LIQ_SIM_FAILED";
    writeReceipt("REDEMPTION-DECREASE-POSITION-LIQ.json", receipt);
    console.error(`SIM_FAILED: ${JSON.stringify(sim.value.err)}`);
    console.error((sim.value.logs ?? []).slice(-10).join("\n"));
    process.exitCode = 1;
    return;
  }

  if (config.dryRun) {
    receipt.verdict = "DECREASE_LIQ_SIM_OK";
    writeReceipt("REDEMPTION-DECREASE-POSITION-LIQ.json", receipt);
    console.log(`DECREASE_LIQ_SIM_OK liq=${liquidityToRemove} usdc≈$${(Number(usdcOut)/1e6).toFixed(2)} hop≈${(Number(hopOut)/1e6).toFixed(0)} HOP`);
    return;
  }

  const sig = await sendAndConfirmTransaction(connection, tx, [crank], { commitment: "confirmed" });
  receipt.verdict = "DECREASE_LIQ_EXECUTED";
  receipt.signature = sig;
  writeReceipt("REDEMPTION-DECREASE-POSITION-LIQ.json", receipt);
  console.log(`DECREASE_LIQ_EXECUTED sig=${sig} liq=${liquidityToRemove}`);
}

main().catch(e => { console.error(e); process.exitCode = 1; });
