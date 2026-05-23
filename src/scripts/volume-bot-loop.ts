/**
 * Volume bot loop: runs volume-bot.ts continuously.
 * Multiple worker instances run in parallel (staggered start).
 *
 * ENV:
 *   LOOP_INTERVAL_MS=3000    (per-worker cycle interval, default 3s)
 *   WORKERS=1                (parallel instances, default 1)
 *   WORKER_STAGGER_MS=500    (stagger between worker starts, default 500ms)
 *   SWAP_USDC=50
 *   SLIPPAGE_BPS=100
 *   T22_FEE_BPS=690
 *   MAX_CYCLES=0             (0 = infinite)
 *   SELL_EVERY_N_CYCLES=50   (trigger sell-hop-fees every N cycles, 0=never)
 */
import "dotenv/config";
import { execSync } from "child_process";

const intervalMs    = Number(process.env.LOOP_INTERVAL_MS    || "3000");
const workers       = Number(process.env.WORKERS             || "1");
const staggerMs     = Number(process.env.WORKER_STAGGER_MS   || "500");
const swapUsdc      = process.env.SWAP_USDC    || "50";
const slippageBps   = process.env.SLIPPAGE_BPS || "100";
const t22FeeBps     = process.env.T22_FEE_BPS  || "690";
const maxCycles     = Number(process.env.MAX_CYCLES          || "0");
const sellEveryN    = Number(process.env.SELL_EVERY_N_CYCLES || "0");
const sellMinUsd    = process.env.SELL_HOP_MIN_USD || "1.0";
const rpc           = process.env.SOLANA_RPC_URL || "https://api.mainnet-beta.solana.com";

const ENV_PREFIX = `SOLANA_RPC_URL="${rpc}" DRY_RUN=false ALLOW_LIVE=true ` +
  `SWAP_USDC=${swapUsdc} SLIPPAGE_BPS=${slippageBps} T22_FEE_BPS=${t22FeeBps}`;

interface WorkerState {
  id: number;
  cycles: number;
  errors: number;
  netUsdc: number;
  lastSellCycle: number;
}

let globalCycles = 0;
const startTime = Date.now();

function runVolumeBot(workerId: number): number {
  const out = execSync(
    `${ENV_PREFIX} tsx src/scripts/volume-bot.ts 2>&1`,
    { encoding: "utf8", timeout: 60000 }
  );
  const netLine = out.match(/Net round-trip:\s*([+-]?\$?[\d.]+)/);
  const net = netLine ? Number(netLine[1].replace("$", "")) : 0;
  const txLine = out.match(/EXECUTED: (\S+)/g);
  if (txLine) {
    const txIds = txLine.map(l => l.replace("EXECUTED: ", "")).map(s => s.slice(0, 16));
    console.log(`[W${workerId}] ${txIds.join(" | ")} net=${net >= 0 ? "+" : ""}$${net.toFixed(4)}`);
  }
  return net;
}

function runSell(): void {
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

async function workerLoop(state: WorkerState) {
  while (true) {
    try {
      const net = runVolumeBot(state.id);
      state.cycles++;
      state.netUsdc += net;
      globalCycles++;

      if (maxCycles > 0 && state.cycles >= maxCycles) break;

      if (sellEveryN > 0 && state.cycles - state.lastSellCycle >= sellEveryN) {
        state.lastSellCycle = state.cycles;
        if (state.id === 1) runSell();
      }

      const elapsed = (Date.now() - startTime) / 1000;
      const rate = state.netUsdc / elapsed * 3600;
      console.log(`[W${state.id}] cycles=${state.cycles} net=$${state.netUsdc.toFixed(4)} rate=$${rate.toFixed(2)}/hr`);
    } catch (e: unknown) {
      state.errors++;
      const msg = e instanceof Error ? e.message.slice(0, 100) : String(e).slice(0, 100);
      console.error(`[W${state.id}] ERR #${state.errors}: ${msg}`);
      if (state.errors > 5) {
        console.error(`[W${state.id}] Too many errors, worker stopping.`);
        break;
      }
    }
    await new Promise(r => setTimeout(r, intervalMs));
  }
}

(async () => {
  console.log("=== VOLUME BOT LOOP ===");
  console.log(`workers: ${workers}  interval: ${intervalMs}ms  swap: $${swapUsdc}  slip: ${slippageBps}bps`);
  console.log(`maxCycles: ${maxCycles || "∞"}  sellEvery: ${sellEveryN || "never"}`);
  console.log();

  const states: WorkerState[] = Array.from({ length: workers }, (_, i) => ({
    id: i + 1, cycles: 0, errors: 0, netUsdc: 0, lastSellCycle: 0,
  }));

  await Promise.all(states.map((state, i) =>
    new Promise<void>(resolve =>
      setTimeout(() => workerLoop(state).then(resolve), i * staggerMs)
    )
  ));

  const totalNet = states.reduce((s, w) => s + w.netUsdc, 0);
  const elapsed  = (Date.now() - startTime) / 1000;
  console.log(`Done. ${globalCycles} cycles | net $${totalNet.toFixed(4)} USDC | ${elapsed.toFixed(0)}s`);
})();
