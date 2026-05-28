/**
 * flash-deep-vol-orca-loop-v2.ts — Loop using v2 (RT_COUNT round-trips) + extract.
 *
 * Phase 1: waits for HOP T22 = 1bps (epoch 978).
 * Phase 2: runs flash-deep-vol-orca-v2 every LOOP_INTERVAL_MS.
 *   Every EXTRACT_EVERY cycles: calls runExtract (collect LP fees → wallet, no reinvest).
 *   Every SWEEP_EVERY cycles: calls runSweep (T22 withheld → USDC, real wallet income).
 *
 * ENV:
 *   RT_COUNT=2              (round-trips per TX, passed to v2; default 2)
 *   EXTRACT_EVERY=25        (run extract every N cycles)
 *   SWEEP_EVERY=50
 *   LOOP_INTERVAL_MS=3000
 *   EPOCH_POLL_MS=600000
 *   ALT_ADDRESS             (default: EjNKyxzhMCDX63sXLNddioHNZmyyNaHUipsXR65AmwAC)
 *   ADDLIQ_USDC=700
 *   SWAP_USDC=500
 */

import "dotenv/config";
import fs from "node:fs";
import {
  Connection, Keypair, PublicKey, TransactionInstruction,
  TransactionMessage, VersionedTransaction, ComputeBudgetProgram,
} from "@solana/web3.js";
import {
  getMint, getTransferFeeConfig, TOKEN_2022_PROGRAM_ID,
  TOKEN_PROGRAM_ID, getAssociatedTokenAddressSync,
} from "@solana/spl-token";
import { runCycle } from "./flash-deep-vol-orca-v2.js";
import { runExtract } from "./auto-compound-extract.js";
import { runSweep } from "./redeem-hop-to-usdc.js";

const HOP_MINT             = new PublicKey("HZF5k7h39hkysoSZ4ZfmWc55PhvW7ntVvVqdXFCyYGh3");
const USDC_MINT            = new PublicKey("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v");
const WHIRLPOOL            = new PublicKey("8aoWgf7ycbeKv6BTFCdUj4JR7Y4mXWuPZWEUhmuzN5ZL");
const WHIRLPOOL_PROGRAM_RB = new PublicKey("GxRHMB9a6XE8BqGPeNb9UkJUPvbvrPoPgNTJPJJA4n8h");
const TOKEN_VAULT_A        = new PublicKey("4QD4GgnjRvjETqWLT5e3x7SHtJSzs9kShUPLfyHcTu7d");
const TOKEN_VAULT_B        = new PublicKey("Qv51R47g7pMDxa3UofXaz8cNr8pwRSXaNufgnEWX8Yk");
const TICK_ARRAY_84480     = new PublicKey("be9QKj4mYB8erh6r4ZDrKxxSvSYSUNRfpTxqJUgd3jG");
const TICK_ARRAY_90112     = new PublicKey("CDMSB5e6WUgtoSLrybvYm4j58Jue3eqpzHQVLmgVkAe4");
const TICK_ARRAY_95744     = new PublicKey("MXd8HXPjcH9ZCuyr4uKKyN7GkJ5YizZQkgUndB6J8Gz");
const ORACLE               = new PublicKey("5qhXANMqTNNzdp1N1PrMzWzSzjHTZxuLPELcmpog6bp5");
const SPL_MEMO             = new PublicKey("MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr");
const TOKEN_PROG_PK        = new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
const TOKEN_2022_PROG_PK   = new PublicKey("TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb");
const SWAP_V2_DISC_RB      = Buffer.from([0x2b, 0x04, 0xed, 0x0b, 0x1a, 0xc9, 0x1e, 0x62]);
const Q64_RB               = 1n << 64n;
const ALT_DEFAULT          = "EjNKyxzhMCDX63sXLNddioHNZmyyNaHUipsXR65AmwAC";
const POSITION_TICK_LOWER  = 84480;
const POSITION_TICK_UPPER  = 101312;
const WP_TICK_INDEX_OFFSET = 81;

const FAIL_THRESHOLD  = 3;
const BACKOFF_MS      = 60_000;
const SWEEP_EVERY     = Number(process.env.SWEEP_EVERY   ?? "50");
const EXTRACT_EVERY   = Number(process.env.EXTRACT_EVERY ?? "25");

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function fmt(d: Date): string {
  return d.toISOString().replace("T", " ").slice(0, 19);
}

function u64LeRb(n: bigint): Buffer {
  const b = Buffer.alloc(8); b.writeBigUInt64LE(n); return b;
}

function u128LeRb(n: bigint): Buffer {
  const b = Buffer.alloc(16);
  b.writeBigUInt64LE(n & ((1n << 64n) - 1n), 0);
  b.writeBigUInt64LE(n >> 64n, 8);
  return b;
}

function tickToSqrtPriceX64Rb(tick: number): bigint {
  const sqrtPrice = Math.pow(1.0001, tick / 2);
  const scale = 1_000_000_000n;
  return (BigInt(Math.round(sqrtPrice * Number(scale))) * Q64_RB) / scale;
}

function loadKeypairRb(p: string): Keypair {
  return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(p, "utf8")) as number[]));
}

function buildSwapV2Ix(args: {
  authority: PublicKey; ownerA: PublicKey; ownerB: PublicKey;
  ta0: PublicKey; ta1: PublicKey; ta2: PublicKey;
  amount: bigint; otherAmountThreshold: bigint;
  sqrtPriceLimit: bigint; amountSpecifiedIsInput: boolean; aToB: boolean;
}): TransactionInstruction {
  return new TransactionInstruction({
    programId: WHIRLPOOL_PROGRAM_RB,
    keys: [
      { pubkey: TOKEN_PROG_PK,      isSigner: false, isWritable: false },
      { pubkey: TOKEN_2022_PROG_PK, isSigner: false, isWritable: false },
      { pubkey: SPL_MEMO,           isSigner: false, isWritable: false },
      { pubkey: args.authority,     isSigner: true,  isWritable: false },
      { pubkey: WHIRLPOOL,          isSigner: false, isWritable: true  },
      { pubkey: USDC_MINT,          isSigner: false, isWritable: false },
      { pubkey: HOP_MINT,           isSigner: false, isWritable: true  },
      { pubkey: args.ownerA,        isSigner: false, isWritable: true  },
      { pubkey: TOKEN_VAULT_A,      isSigner: false, isWritable: true  },
      { pubkey: args.ownerB,        isSigner: false, isWritable: true  },
      { pubkey: TOKEN_VAULT_B,      isSigner: false, isWritable: true  },
      { pubkey: args.ta0,           isSigner: false, isWritable: true  },
      { pubkey: args.ta1,           isSigner: false, isWritable: true  },
      { pubkey: args.ta2,           isSigner: false, isWritable: true  },
      { pubkey: ORACLE,             isSigner: false, isWritable: true  },
    ],
    data: Buffer.concat([
      SWAP_V2_DISC_RB,
      u64LeRb(args.amount),
      u64LeRb(args.otherAmountThreshold),
      u128LeRb(args.sqrtPriceLimit),
      Buffer.from([args.amountSpecifiedIsInput ? 1 : 0]),
      Buffer.from([args.aToB ? 1 : 0]),
      Buffer.from([0x00]),
    ]),
  });
}

function appendRebalanceLog(entry: object): void {
  const line = JSON.stringify({ ...entry, ts: new Date().toISOString() }) + "\n";
  fs.appendFileSync("logs/auto-rebalances.log", line);
}

async function executeAutoRebalance(
  conn: Connection,
  tickBefore: number,
  direction: "DOWN" | "UP",
  cfg: {
    rebalanceAmountUsdc: number;
    rebalanceAmountHop: bigint;
    tickTargetLow: number;
    tickTargetHigh: number;
    dryRun: boolean;
  }
): Promise<{ tickAfter: number; sig: string | null }> {
  const crank  = loadKeypairRb(process.env.CRANK_KEYPAIR_PATH || "keys/crank.json");
  const ownerA = getAssociatedTokenAddressSync(USDC_MINT, crank.publicKey, false, TOKEN_PROGRAM_ID);
  const ownerB = getAssociatedTokenAddressSync(HOP_MINT,  crank.publicKey, false, TOKEN_2022_PROGRAM_ID);

  const aToB = direction === "DOWN";
  const amount = aToB
    ? BigInt(Math.floor(cfg.rebalanceAmountUsdc * 1e6))
    : cfg.rebalanceAmountHop;

  // tick arrays: aToB=true → descending (95744→90112→84480), aToB=false → ascending (84480→90112→95744)
  const [ta0, ta1, ta2] = aToB
    ? [TICK_ARRAY_95744, TICK_ARRAY_90112, TICK_ARRAY_84480]
    : [TICK_ARRAY_84480, TICK_ARRAY_90112, TICK_ARRAY_95744];

  const sqrtPriceLimit = aToB
    ? tickToSqrtPriceX64Rb(cfg.tickTargetLow)
    : tickToSqrtPriceX64Rb(cfg.tickTargetHigh);

  const swapIx = buildSwapV2Ix({
    authority: crank.publicKey,
    ownerA, ownerB,
    ta0, ta1, ta2,
    amount,
    otherAmountThreshold: 0n,
    sqrtPriceLimit,
    amountSpecifiedIsInput: true,
    aToB,
  });

  const cu      = ComputeBudgetProgram.setComputeUnitLimit({ units: 300_000 });
  const cuPrice = ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 50_000 });
  const { blockhash } = await conn.getLatestBlockhash("confirmed");

  const msg = new TransactionMessage({
    payerKey:        crank.publicKey,
    recentBlockhash: blockhash,
    instructions:    [cu, cuPrice, swapIx],
  }).compileToV0Message();

  const vtx = new VersionedTransaction(msg);
  vtx.sign([crank]);

  const sim = await conn.simulateTransaction(vtx, { commitment: "confirmed" });
  if (sim.value.err) {
    throw new Error(`Rebalance sim failed: ${JSON.stringify(sim.value.err)} | logs: ${(sim.value.logs ?? []).slice(-5).join(" | ")}`);
  }

  if (cfg.dryRun) {
    return { tickAfter: tickBefore, sig: null };
  }

  const sig = await conn.sendRawTransaction(vtx.serialize(), { skipPreflight: false, maxRetries: 3 });
  const { value: status } = await conn.confirmTransaction(
    { signature: sig, blockhash, lastValidBlockHeight: (await conn.getLatestBlockhash()).lastValidBlockHeight },
    "confirmed"
  );
  if (status.err) throw new Error(`Rebalance TX failed: ${JSON.stringify(status.err)}`);

  const info = await conn.getAccountInfo(WHIRLPOOL, "confirmed");
  const tickAfter = info ? Buffer.from(info.data).readInt32LE(WP_TICK_INDEX_OFFSET) : tickBefore;
  return { tickAfter, sig };
}

async function readCurrentTick(conn: Connection): Promise<number> {
  const info = await conn.getAccountInfo(WHIRLPOOL, "confirmed");
  if (!info) throw new Error("WHIRLPOOL account not found");
  return Buffer.from(info.data).readInt32LE(WP_TICK_INDEX_OFFSET);
}

async function getHopT22Bps(conn: Connection): Promise<number> {
  const mint = await getMint(conn, HOP_MINT, "confirmed", TOKEN_2022_PROGRAM_ID);
  const cfg  = getTransferFeeConfig(mint);
  if (!cfg) throw new Error("HOP missing TransferFeeConfig");
  const epoch = (await conn.getEpochInfo()).epoch;
  const active = epoch >= Number(cfg.newerTransferFee.epoch)
    ? cfg.newerTransferFee : cfg.olderTransferFee;
  return active.transferFeeBasisPoints;
}

async function waitForEpoch978(conn: Connection, pollMs: number): Promise<void> {
  while (true) {
    let bps: number;
    try {
      bps = await getHopT22Bps(conn);
    } catch (e) {
      console.error(`[epoch-watch] RPC error:`, e instanceof Error ? e.message : e);
      await sleep(pollMs);
      continue;
    }

    if (bps === 1) {
      console.log(`[epoch-watch] ${fmt(new Date())} fee=1bps. Epoch 978 active. Starting loop-v2...`);
      return;
    }

    const nextCheck = new Date(Date.now() + pollMs);
    console.log(`[epoch-watch] ${fmt(new Date())} fee=${bps}bps. Next check: ${fmt(nextCheck)}`);
    await sleep(pollMs);
  }
}

async function main(): Promise<void> {
  const rpcUrl    = process.env.SOLANA_RPC_URL || process.env.RPC_URL || "https://api.mainnet-beta.solana.com";
  const loopMs    = Number(process.env.LOOP_INTERVAL_MS ?? "3000");
  const pollMs    = Number(process.env.EPOCH_POLL_MS    ?? "600000");
  const rtCount   = Number(process.env.RT_COUNT          ?? "2");

  const rebalanceDryRun = process.env.AUTO_REBALANCE_DRY_RUN !== "false"; // separate from main loop DRY_RUN

  process.env.ALT_ADDRESS    = process.env.ALT_ADDRESS    ?? ALT_DEFAULT;
  process.env.ADDLIQ_USDC    = process.env.ADDLIQ_USDC    ?? "700";
  process.env.SWAP_USDC      = process.env.SWAP_USDC      ?? "500";
  process.env.RT_COUNT       = String(rtCount);
  process.env.DRY_RUN        = "false";
  process.env.ALLOW_LIVE     = "true";

  const autoRebalance        = process.env.AUTO_REBALANCE === "true";
  const rebalanceTickHigh    = Number(process.env.REBALANCE_TICK_HIGH   ?? "96000");
  const rebalanceTickLow     = Number(process.env.REBALANCE_TICK_LOW    ?? "90000");
  const rebalanceAmountUsdc  = Number(process.env.REBALANCE_AMOUNT_USDC ?? "50");
  const rebalanceAmountHop   = BigInt(process.env.REBALANCE_AMOUNT_HOP  ?? "700000");
  const tickTargetLow        = Number(process.env.TICK_TARGET_LOW       ?? "93000");
  const tickTargetHigh       = Number(process.env.TICK_TARGET_HIGH      ?? "92500");
  const usdcMinReserve       = 30_000_000n; // $30 in raw USDC (6 decimals)
  const rebalanceCooldownMs  = 10 * 60 * 1_000; // 10 min
  const REBALANCE_FAIL_MAX   = 3;

  let lastRebalanceAt        = 0;
  let consecutiveRebFails    = 0;

  const conn = new Connection(rpcUrl, "confirmed");

  console.log(`=== flash-deep-vol-orca-loop-v2 ===`);
  console.log(`RPC:           ${rpcUrl.slice(0, 60)}...`);
  console.log(`ALT:           ${process.env.ALT_ADDRESS}`);
  console.log(`ADDLIQ_USDC:   $${process.env.ADDLIQ_USDC}`);
  console.log(`SWAP_USDC:     $${process.env.SWAP_USDC}`);
  console.log(`RT_COUNT:      ${rtCount}`);
  console.log(`Loop interval: ${loopMs}ms`);
  console.log(`Epoch poll:    ${pollMs / 60_000}min`);
  console.log(`Extract every: ${EXTRACT_EVERY} cycles`);
  console.log(`Sweep every:   ${SWEEP_EVERY} cycles`);
  console.log(`Auto-rebalance: ${autoRebalance} | HIGH=${rebalanceTickHigh} LOW=${rebalanceTickLow} TARGET_LOW=${tickTargetLow} TARGET_HIGH=${tickTargetHigh}`);
  console.log();

  // ── Phase 1: wait for epoch 978 ─────────────────────────────────────────
  await waitForEpoch978(conn, pollMs);

  // ── Phase 2: main loop ───────────────────────────────────────────────────
  let consecutiveFails = 0;
  let totalCycles      = 0;
  let totalBundles     = 0;

  console.log(`[loop] ${fmt(new Date())} Starting cycle loop-v2 (RT_COUNT=${rtCount})...`);

  while (true) {
    totalCycles++;
    const ts = Date.now();
    process.env.RECEIPT_NAME = `deep-vol-v2-${ts}.json`;

    // Safety: pause if tick near range boundaries (10% margin each side)
    const SAFETY_MARGIN_PCT = 0.10;
    const rangeSize  = POSITION_TICK_UPPER - POSITION_TICK_LOWER;
    const safetyLow  = POSITION_TICK_LOWER + Math.floor(rangeSize * SAFETY_MARGIN_PCT);
    const safetyHigh = POSITION_TICK_UPPER - Math.floor(rangeSize * SAFETY_MARGIN_PCT);
    let currentTickForRebalance = 0;
    try {
      const currentTick = await readCurrentTick(conn);
      currentTickForRebalance = currentTick;
      if (currentTick < safetyLow || currentTick > safetyHigh) {
        console.error(`[SAFETY] Tick ${currentTick} outside [${safetyLow}, ${safetyHigh}]. Pausing 5min.`);
        fs.writeFileSync(`receipts/SAFETY-PAUSE-${ts}.json`, JSON.stringify({
          timestamp: new Date().toISOString(), currentTick, safetyLow, safetyHigh,
          totalCycles, totalBundles,
        }, null, 2));
        await sleep(300_000);
        continue;
      }
    } catch (e) {
      console.error(`[SAFETY] Tick check failed:`, e instanceof Error ? e.message : e);
    }

    // Auto-rebalance check
    if (autoRebalance && currentTickForRebalance !== 0) {
      const needsDown = currentTickForRebalance > rebalanceTickHigh;
      const needsUp   = currentTickForRebalance < rebalanceTickLow;
      const cooldownOk = Date.now() - lastRebalanceAt >= rebalanceCooldownMs;

      if ((needsDown || needsUp) && cooldownOk) {
        const direction = needsDown ? "DOWN" : "UP";
        console.log(`[rebalance] Tick ${currentTickForRebalance} triggers ${direction} rebalance`);

        // USDC balance check (only relevant for DOWN rebalance)
        let usdcRaw = 0n;
        try {
          const crankPk  = loadKeypairRb(process.env.CRANK_KEYPAIR_PATH || "keys/crank.json").publicKey;
          const usdcAta  = getAssociatedTokenAddressSync(USDC_MINT, crankPk, false, TOKEN_PROGRAM_ID);
          const usdcInfo = await conn.getTokenAccountBalance(usdcAta, "confirmed");
          usdcRaw = BigInt(usdcInfo.value.amount);
        } catch (_) { /* skip if can't read */ }

        if (needsDown && usdcRaw < usdcMinReserve) {
          console.warn(`[rebalance] SKIP — USDC balance $${(Number(usdcRaw) / 1e6).toFixed(2)} < $30 reserve`);
        } else {
          try {
            const result = await executeAutoRebalance(conn, currentTickForRebalance, direction, {
              rebalanceAmountUsdc, rebalanceAmountHop, tickTargetLow, tickTargetHigh, dryRun: rebalanceDryRun,
            });
            consecutiveRebFails = 0;
            lastRebalanceAt = Date.now();
            const entry = {
              direction,
              tickBefore: currentTickForRebalance,
              tickAfter:  result.tickAfter,
              usdcSpent:  needsDown ? rebalanceAmountUsdc : 0,
              hopSpent:   needsUp   ? rebalanceAmountHop.toString() : "0",
              sig:        result.sig,
              dryRun:     rebalanceDryRun,
            };
            appendRebalanceLog(entry);
            console.log(
              `[rebalance] ${rebalanceDryRun ? "DRY_RUN" : "OK"}` +
              ` tick ${currentTickForRebalance}→${result.tickAfter}` +
              (result.sig ? ` sig=${result.sig.slice(0, 8)}...` : "")
            );
          } catch (e) {
            consecutiveRebFails++;
            const msg = e instanceof Error ? e.message : String(e);
            console.error(`[rebalance] FAIL ${consecutiveRebFails}/${REBALANCE_FAIL_MAX}: ${msg}`);
            appendRebalanceLog({ direction, tickBefore: currentTickForRebalance, error: msg, consecutiveRebFails });
            if (consecutiveRebFails >= REBALANCE_FAIL_MAX) {
              console.error(`[rebalance] FATAL: ${REBALANCE_FAIL_MAX} consecutive failures. Stopping loop.`);
              process.exit(1);
            }
          }
        }
      } else if ((needsDown || needsUp) && !cooldownOk) {
        const waitSec = Math.ceil((rebalanceCooldownMs - (Date.now() - lastRebalanceAt)) / 1000);
        console.log(`[rebalance] Tick ${currentTickForRebalance} needs ${needsDown ? "DOWN" : "UP"} — cooldown ${waitSec}s remaining`);
      }
    }

    let ok = false;
    let verdict = "UNKNOWN";

    try {
      const result = await runCycle();
      verdict = result.verdict;
      ok = !!result.bundleId;

      if (ok) {
        totalBundles++;
        consecutiveFails = 0;

        // Drift measurement: read tick after cycle
        let tickAfterCycle = 0;
        try { tickAfterCycle = await readCurrentTick(conn); } catch (_) {}
        const driftThis = tickAfterCycle - currentTickForRebalance;

        console.log(
          `[loop #${totalCycles}] ${fmt(new Date())} OK` +
          ` bundle=${result.bundleId}` +
          ` cashNet=$${result.cashNetProj.toFixed(4)}` +
          ` rtCount=${rtCount}` +
          ` tick:${currentTickForRebalance}→${tickAfterCycle}(${driftThis >= 0 ? "+" : ""}${driftThis})` +
          ` dir=${result.swapDirection ?? "?"}` +
          ` fallback=${result.fallbackFired ?? "?"}` +
          ` (total=${totalBundles})`
        );

        // Append drift entry for calibration analysis
        fs.appendFileSync("logs/drift-calibration.log", JSON.stringify({
          ts: new Date().toISOString(),
          cycle: totalCycles,
          bundle: totalBundles,
          tickBefore: currentTickForRebalance,
          tickAfter: tickAfterCycle,
          drift: driftThis,
          swapDirection: result.swapDirection,
          fallbackFired: result.fallbackFired,
          cashNet: result.cashNetProj,
        }) + "\n");
      } else {
        consecutiveFails++;
        console.warn(
          `[loop #${totalCycles}] ${fmt(new Date())} no-bundle` +
          ` verdict=${verdict} fails=${consecutiveFails}/${FAIL_THRESHOLD}`
        );
      }
    } catch (e) {
      consecutiveFails++;
      console.error(
        `[loop #${totalCycles}] ${fmt(new Date())} ERROR` +
        ` fails=${consecutiveFails}/${FAIL_THRESHOLD}:`,
        e instanceof Error ? e.message : e
      );
    }

    if (consecutiveFails >= FAIL_THRESHOLD) {
      console.log(`[loop] ${FAIL_THRESHOLD} consecutive failures. Backoff ${BACKOFF_MS / 1000}s...`);
      await sleep(BACKOFF_MS);
      consecutiveFails = 0;
    } else {
      await sleep(loopMs);
    }

    // LP fee extract — every EXTRACT_EVERY cycles
    if (totalCycles % EXTRACT_EVERY === 0) {
      try {
        process.env.RECEIPT_NAME = `extract-${ts}.json`;
        const ext = await runExtract();
        console.log(
          `[extract #${totalCycles}] ${fmt(new Date())} ${ext.verdict}` +
          ` usdc=$${(ext.lpFeesExtractedUsdcUi + ext.protoFeesExtractedUsdcUi).toFixed(4)}` +
          ` hop=${(ext.lpFeesExtractedHopUi + ext.protoFeesExtractedHopUi).toFixed(2)}`
        );
      } catch (e) {
        console.error(`[extract #${totalCycles}] ${fmt(new Date())} ERROR:`, e instanceof Error ? e.message : e);
      }
    }

    // T22 withheld sweep — every SWEEP_EVERY cycles
    if (totalCycles % SWEEP_EVERY === 0) {
      try {
        process.env.RECEIPT_NAME = `sweep-${ts}.json`;
        const sweep = await runSweep();
        console.log(
          `[sweep #${totalCycles}] ${fmt(new Date())} ${sweep.verdict}` +
          ` hop=${sweep.withheldHopUi.toFixed(2)}` +
          ` usdc=$${sweep.netUsdcUi.toFixed(4)}` +
          (sweep.txSig ? ` tx=${sweep.txSig.slice(0, 8)}...` : "")
        );
      } catch (e) {
        console.error(`[sweep #${totalCycles}] ${fmt(new Date())} ERROR:`, e instanceof Error ? e.message : e);
      }
    }
  }
}

main().catch((e) => { console.error(e); process.exitCode = 1; });
