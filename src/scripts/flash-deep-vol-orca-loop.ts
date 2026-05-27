/**
 * flash-deep-vol-orca-loop.ts — Continuous loop for flash-deep-vol-orca.
 *
 * Phase 1 (epoch watch): polls HOP T22 fee every 10 min.
 *   fee != 1bps → sleep 10 min → retry
 *   fee == 1bps → epoch 978 active → enter loop
 *
 * Phase 2 (main loop): runs one cycle per LOOP_INTERVAL_MS.
 *   3 consecutive failures → 60s backoff → reset counter
 *   Each cycle receipt saved to receipts/deep-vol-{timestamp}.json
 *
 * ENV (all have defaults):
 *   SOLANA_RPC_URL
 *   ALT_ADDRESS          (default: EjNKyxzhMCDX63sXLNddioHNZmyyNaHUipsXR65AmwAC)
 *   ADDLIQ_USDC          (default: 700)
 *   SWAP_USDC            (default: 500)
 *   LOOP_INTERVAL_MS     (default: 3000)
 *   EPOCH_POLL_MS        (default: 600000 = 10 min)
 *   CU_PRICE             (default: 10000 microlamports)
 *   JITO_TIP_LAMPORTS    (default: 200000)
 *   SOL_PRICE_USD        (default: 150)
 *   SWEEP_EVERY          (default: 50 — run T22 withheld sweep every N cycles)
 */

import "dotenv/config";
import { Connection, PublicKey } from "@solana/web3.js";
import { getMint, getTransferFeeConfig, TOKEN_2022_PROGRAM_ID } from "@solana/spl-token";
import { runCycle } from "./flash-deep-vol-orca.js";
import { runSweep } from "./redeem-hop-to-usdc.js";

const HOP_MINT = new PublicKey("HZF5k7h39hkysoSZ4ZfmWc55PhvW7ntVvVqdXFCyYGh3");
const ALT_DEFAULT = "EjNKyxzhMCDX63sXLNddioHNZmyyNaHUipsXR65AmwAC";
const FAIL_THRESHOLD = 3;
const BACKOFF_MS = 60_000;
const SWEEP_EVERY   = Number(process.env.SWEEP_EVERY ?? "50");

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function fmt(d: Date): string {
  return d.toISOString().replace("T", " ").slice(0, 19);
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
      console.log(`[epoch-watch] ${fmt(new Date())} fee=1bps. Epoch 978 active. Starting loop...`);
      return;
    }

    const nextCheck = new Date(Date.now() + pollMs);
    console.log(`[epoch-watch] ${fmt(new Date())} fee=${bps}bps (epoch 977). Next check: ${fmt(nextCheck)}`);
    await sleep(pollMs);
  }
}

async function main(): Promise<void> {
  const rpcUrl      = process.env.SOLANA_RPC_URL || process.env.RPC_URL || "https://api.mainnet-beta.solana.com";
  const loopMs      = Number(process.env.LOOP_INTERVAL_MS ?? "3000");
  const pollMs      = Number(process.env.EPOCH_POLL_MS    ?? "600000");

  // Harden cycle env vars — loop owns these
  process.env.ALT_ADDRESS    = process.env.ALT_ADDRESS    ?? ALT_DEFAULT;
  process.env.ADDLIQ_USDC    = process.env.ADDLIQ_USDC    ?? "700";
  process.env.SWAP_USDC      = process.env.SWAP_USDC      ?? "500";
  process.env.DRY_RUN        = "false";
  process.env.ALLOW_LIVE     = "true";
  // No FORCE_T22_BPS — use real on-chain value (should be 1bps after epoch 978 gate)

  const conn = new Connection(rpcUrl, "confirmed");

  console.log(`=== flash-deep-vol-orca-loop ===`);
  console.log(`RPC:          ${rpcUrl.slice(0, 60)}...`);
  console.log(`ALT:          ${process.env.ALT_ADDRESS}`);
  console.log(`ADDLIQ_USDC:  $${process.env.ADDLIQ_USDC}`);
  console.log(`SWAP_USDC:    $${process.env.SWAP_USDC}`);
  console.log(`Loop interval: ${loopMs}ms`);
  console.log(`Epoch poll:    ${pollMs / 60_000}min`);
  console.log();

  // ── Phase 1: wait for epoch 978 ─────────────────────────────────────────
  await waitForEpoch978(conn, pollMs);

  // ── Phase 2: main loop ───────────────────────────────────────────────────
  let consecutiveFails = 0;
  let totalCycles      = 0;
  let totalBundles     = 0;

  console.log(`[loop] ${fmt(new Date())} Starting cycle loop...`);

  while (true) {
    totalCycles++;
    const ts = Date.now();
    process.env.RECEIPT_NAME = `deep-vol-${ts}.json`;

    let verdict = "UNKNOWN";
    let ok = false;

    try {
      const result = await runCycle();
      verdict = result.verdict;
      ok = !!result.bundleId;   // success = live bundle sent

      if (ok) {
        totalBundles++;
        consecutiveFails = 0;
        console.log(
          `[loop #${totalCycles}] ${fmt(new Date())} OK` +
          ` bundle=${result.bundleId}` +
          ` cashNet=$${result.cashNetProj.toFixed(4)}` +
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

    // T22 withheld sweep — runs every SWEEP_EVERY cycles
    if (totalCycles % SWEEP_EVERY === 0) {
      try {
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
