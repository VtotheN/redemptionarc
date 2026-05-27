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
import { Connection, PublicKey } from "@solana/web3.js";
import { getMint, getTransferFeeConfig, TOKEN_2022_PROGRAM_ID } from "@solana/spl-token";
import { runCycle } from "./flash-deep-vol-orca-v2.js";
import { runExtract } from "./auto-compound-extract.js";
import { runSweep } from "./redeem-hop-to-usdc.js";

const HOP_MINT             = new PublicKey("HZF5k7h39hkysoSZ4ZfmWc55PhvW7ntVvVqdXFCyYGh3");
const WHIRLPOOL            = new PublicKey("8aoWgf7ycbeKv6BTFCdUj4JR7Y4mXWuPZWEUhmuzN5ZL");
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

  process.env.ALT_ADDRESS    = process.env.ALT_ADDRESS    ?? ALT_DEFAULT;
  process.env.ADDLIQ_USDC    = process.env.ADDLIQ_USDC    ?? "700";
  process.env.SWAP_USDC      = process.env.SWAP_USDC      ?? "500";
  process.env.RT_COUNT       = String(rtCount);
  process.env.DRY_RUN        = "false";
  process.env.ALLOW_LIVE     = "true";

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
    try {
      const currentTick = await readCurrentTick(conn);
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

    let ok = false;
    let verdict = "UNKNOWN";

    try {
      const result = await runCycle();
      verdict = result.verdict;
      ok = !!result.bundleId;

      if (ok) {
        totalBundles++;
        consecutiveFails = 0;
        console.log(
          `[loop #${totalCycles}] ${fmt(new Date())} OK` +
          ` bundle=${result.bundleId}` +
          ` cashNet=$${result.cashNetProj.toFixed(4)}` +
          ` rtCount=${rtCount}` +
          ` (total=${totalBundles})`
        );
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
