/**
 * epoch-watcher-loop.ts
 *
 * Phase 1 — polls HOP mint on-chain every 10min until fee == 1bps (epoch 978).
 * Phase 2 — runs flywheel-bot.ts as subprocess every LOOP_INTERVAL_MS.
 *            3 consecutive errors → pause 60s → reset counter.
 *
 * ENV:
 *   SOLANA_RPC_URL
 *   FLASH_AMOUNT_USDC=300        (passed to flywheel-bot.ts)
 *   LOOP_INTERVAL_MS=3000
 *   DRY_RUN=false
 *   ALLOW_LIVE=true
 *   LIVE_TX_APPROVED=true        (propagated to flywheel-bot.ts)
 */

import "dotenv/config";
import { Connection, PublicKey } from "@solana/web3.js";
import { getMint, getTransferFeeConfig, TOKEN_2022_PROGRAM_ID } from "@solana/spl-token";
import { spawn } from "child_process";

const HOP_MINT        = new PublicKey("HZF5k7h39hkysoSZ4ZfmWc55PhvW7ntVvVqdXFCyYGh3");
const TARGET_FEE_BPS  = 1;
const EPOCH_POLL_MS   = 10 * 60 * 1000;

function sleep(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms));
}

function ts(): string {
  return new Date().toISOString();
}

async function getActiveFeeBps(conn: Connection): Promise<number> {
  const [mintInfo, epochInfo] = await Promise.all([
    getMint(conn, HOP_MINT, "confirmed", TOKEN_2022_PROGRAM_ID),
    conn.getEpochInfo(),
  ]);
  const fc = getTransferFeeConfig(mintInfo);
  if (!fc) throw new Error("HOP missing TransferFeeConfig");
  const active = epochInfo.epoch >= Number(fc.newerTransferFee.epoch)
    ? fc.newerTransferFee
    : fc.olderTransferFee;
  return active.transferFeeBasisPoints;
}

function runFlywheelCycle(opts: {
  flashAmountUsdc: number;
  dryRun: boolean;
  allowLive: boolean;
}): Promise<void> {
  return new Promise((resolve, reject) => {
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      FLASH_AMOUNT_USDC:   String(opts.flashAmountUsdc),
      DRY_RUN:             opts.dryRun    ? "true" : "false",
      ALLOW_LIVE:          opts.allowLive ? "true" : "false",
      LIVE_TX_APPROVED:    opts.allowLive ? "true" : "false",
    };
    const proc = spawn("npx", ["tsx", "src/scripts/flywheel-bot.ts"], {
      env,
      stdio: "inherit",
      cwd: process.cwd(),
    });
    proc.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`flywheel-bot exited ${code}`));
    });
    proc.on("error", reject);
  });
}

async function main() {
  const rpcUrl         = process.env.SOLANA_RPC_URL || process.env.RPC_URL || "https://api.mainnet-beta.solana.com";
  const loopIntervalMs = Number(process.env.LOOP_INTERVAL_MS || "3000");
  const flashAmountUsdc = Number(process.env.FLASH_AMOUNT_USDC || "300");
  const dryRun         = process.env.DRY_RUN !== "false";
  const allowLive      = process.env.ALLOW_LIVE === "true";

  const conn = new Connection(rpcUrl, "confirmed");

  console.log("=== EPOCH WATCHER LOOP ===");
  console.log(`flash=$${flashAmountUsdc}  interval=${loopIntervalMs}ms  dry=${dryRun}  live=${allowLive}`);
  console.log();

  // ─── Phase 1: wait for epoch 978 ─────────────────────────────────────────

  while (true) {
    const feeBps = await getActiveFeeBps(conn);
    if (feeBps === TARGET_FEE_BPS) {
      console.log(`[${ts()}] Epoch 978 ACTIVE (fee=${feeBps}bps). Starting flywheel loop.`);
      break;
    }
    console.log(`[${ts()}] fee=${feeBps}bps → target ${TARGET_FEE_BPS}bps. Next check in ${EPOCH_POLL_MS / 60_000}min.`);
    await sleep(EPOCH_POLL_MS);
  }

  // ─── Phase 2: flywheel loop ───────────────────────────────────────────────

  let consecutiveErrors = 0;
  let cycleCount = 0;

  while (true) {
    cycleCount++;
    console.log(`\n[${ts()}] ── Cycle #${cycleCount} ──`);

    try {
      await runFlywheelCycle({ flashAmountUsdc, dryRun, allowLive });
      consecutiveErrors = 0;
      await sleep(loopIntervalMs);
    } catch (e) {
      consecutiveErrors++;
      const msg = e instanceof Error ? e.message : String(e);
      console.error(`[${ts()}] Error ${consecutiveErrors}/3: ${msg}`);

      if (consecutiveErrors >= 3) {
        console.log(`[${ts()}] 3 consecutive errors. Pausing 60s.`);
        await sleep(60_000);
        consecutiveErrors = 0;
      }
    }
  }
}

main().catch(e => { console.error(e); process.exit(1); });
