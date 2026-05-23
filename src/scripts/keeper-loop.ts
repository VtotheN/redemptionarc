/**
 * Keeper loop: runs not-stacc-replicate continuously.
 * ENV:
 *   LOOP_INTERVAL_MS=1500      (1.5s = ~1 TX/slot)
 *   FLASH_AMOUNT_USDC=100000
 *   HOP_AMOUNT_PER_HOP=10000000
 *   CU_LIMIT=400000
 *   MAX_CYCLES=0               (0 = infinite)
 *   SELL_EVERY_N_CYCLES=100    (0 = never sell; triggers sell-hop-fees every N cycles)
 *   SELL_HOP_MIN_USD=5.0       (min USDC out to trigger sell)
 */
import "dotenv/config";
import { execSync } from "child_process";

const intervalMs = Number(process.env.LOOP_INTERVAL_MS || "1500");
const flashUsdc = process.env.FLASH_AMOUNT_USDC || "100000";
const hopPerHop = process.env.HOP_AMOUNT_PER_HOP || "10000000";
const cuLimit = process.env.CU_LIMIT || "400000";
const maxCycles = Number(process.env.MAX_CYCLES || "0");
const sellEveryN = Number(process.env.SELL_EVERY_N_CYCLES || "0");
const sellMinUsd = process.env.SELL_HOP_MIN_USD || "5.0";
const rpc = process.env.SOLANA_RPC_URL || "https://api.mainnet-beta.solana.com";

let cycle = 0;
let totalHopFees = 0;
let errors = 0;
let lastSellCycle = 0;

console.log("=== KEEPER LOOP ===");
console.log(`interval: ${intervalMs}ms  flash: $${flashUsdc}  hop/hop: ${hopPerHop}  maxCycles: ${maxCycles||"∞"}  sellEvery: ${sellEveryN||"never"}`);
console.log();

async function runCycle() {
  cycle++;
  const start = Date.now();
  try {
    const out = execSync(
      `SOLANA_RPC_URL="${rpc}" DRY_RUN=false ALLOW_LIVE=true ` +
      `FLASH_AMOUNT_USDC=${flashUsdc} HOP_AMOUNT_PER_HOP=${hopPerHop} ` +
      `CU_LIMIT=${cuLimit} tsx src/scripts/not-stacc-replicate.ts 2>&1`,
      { encoding: "utf8", timeout: 30000 }
    );
    const sigLine = out.match(/EXECUTED: (\S+)/);
    const netLine = out.match(/Net: ~([\d.]+) HOP/);
    const hopFees = netLine ? Number(netLine[1]) : 0;
    totalHopFees += hopFees;
    const elapsed = Date.now() - start;
    console.log(`[${cycle}] ${sigLine?.[1]?.slice(0,20) || "?"} | +${hopFees.toFixed(0)} HOP | ${elapsed}ms | total: ${totalHopFees.toFixed(0)} HOP`);
  } catch (e: unknown) {
    errors++;
    const msg = e instanceof Error ? e.message.slice(0, 80) : String(e).slice(0, 80);
    console.error(`[${cycle}] ERR #${errors}: ${msg}`);
    if (errors > 10) { console.error("Too many errors, stopping."); process.exit(1); }
  }
}

async function runSell() {
  try {
    const out = execSync(
      `SOLANA_RPC_URL="${rpc}" DRY_RUN=false ALLOW_LIVE=true ` +
      `SELL_HOP_MIN_USD=${sellMinUsd} tsx src/scripts/sell-hop-fees.ts 2>&1`,
      { encoding: "utf8", timeout: 60000 }
    );
    const verdict = out.match(/^(EXECUTED|NO_ROUTE|SKIP|SIM)[^\n]*/m)?.[0] ?? "?";
    console.log(`[SELL] ${verdict}`);
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message.slice(0, 80) : String(e).slice(0, 80);
    console.error(`[SELL] ERR: ${msg}`);
  }
}

(async () => {
  while (true) {
    await runCycle();
    if (maxCycles > 0 && cycle >= maxCycles) {
      console.log(`Done. ${cycle} cycles, ${totalHopFees.toFixed(0)} HOP collected.`);
      // Final sell attempt
      if (sellEveryN > 0) await runSell();
      break;
    }
    // Auto-sell every N cycles
    if (sellEveryN > 0 && cycle - lastSellCycle >= sellEveryN) {
      lastSellCycle = cycle;
      await runSell();
    }
    await new Promise(r => setTimeout(r, intervalMs));
  }
})();
