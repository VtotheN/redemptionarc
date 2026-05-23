/**
 * Keeper loop: runs flash-deep-vol.ts continuously.
 *
 * ENV:
 *   SOLANA_RPC_URL            (required, passed to child)
 *   DRY_RUN                   = "false"   (default for loop)
 *   ALLOW_LIVE                = "true"    (default for loop, passed to child)
 *   FLASH_USDC                = "10000"
 *   ADDLIQ_USDC               = "5000"
 *   SWAP_USDC                 = "100"
 *   SLIPPAGE_BPS              = "50"
 *   JITO_TIP_LAMPORTS         = "200000"
 *   CU_LIMIT                  = "600000"
 *   CU_PRICE                  = "10000"
 *   ALT_ADDRESS               = ""        (optional, passed to child)
 *   LOOP_INTERVAL_MS          = "3000"
 *   SELL_EVERY_N              = "50"      (0 = never)
 *   MAX_ERRORS                = "10"
 */
import "dotenv/config";
import { execSync } from "node:child_process";

const rpc            = process.env.SOLANA_RPC_URL    || "https://api.mainnet-beta.solana.com";
const dryRun         = process.env.DRY_RUN           ?? "false";
const allowLive      = process.env.ALLOW_LIVE        ?? "true";
const flashUsdc      = process.env.FLASH_USDC        || "10000";
const addliqUsdc     = process.env.ADDLIQ_USDC       || "5000";
const swapUsdc       = process.env.SWAP_USDC         || "100";
const slippageBps    = process.env.SLIPPAGE_BPS      || "50";
const jitoTip        = process.env.JITO_TIP_LAMPORTS || "200000";
const cuLimit        = process.env.CU_LIMIT          || "600000";
const cuPrice        = process.env.CU_PRICE          || "10000";
const altAddress     = process.env.ALT_ADDRESS       || "";
const intervalMs     = Number(process.env.LOOP_INTERVAL_MS || "3000");
const sellEveryN     = Number(process.env.SELL_EVERY_N     || "50");
const maxErrors      = Number(process.env.MAX_ERRORS       || "10");

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
const ts = () => new Date().toISOString().replace("T", " ").substring(0, 19);

// ── child env ─────────────────────────────────────────────────────────────────

function childEnv(overrides: Record<string, string> = {}): NodeJS.ProcessEnv {
  return {
    ...process.env,
    SOLANA_RPC_URL:    rpc,
    DRY_RUN:           dryRun,
    ALLOW_LIVE:        allowLive,
    FLASH_USDC:        flashUsdc,
    ADDLIQ_USDC:       addliqUsdc,
    SWAP_USDC:         swapUsdc,
    SLIPPAGE_BPS:      slippageBps,
    JITO_TIP_LAMPORTS: jitoTip,
    CU_LIMIT:          cuLimit,
    CU_PRICE:          cuPrice,
    ...(altAddress ? { ALT_ADDRESS: altAddress } : {}),
    ...overrides,
  };
}

// ── flash-deep-vol runner ─────────────────────────────────────────────────────

interface RunResult {
  success: boolean;
  sig: string | null;
  output: string;
}

function runFlashDeepVol(): RunResult {
  try {
    const output = execSync("npx tsx src/scripts/flash-deep-vol.ts", {
      env: childEnv(),
      timeout: 60_000,
      encoding: "utf8",
    });
    const sig = output.match(/EXECUTED:\s*(\S+)/)?.[1] ?? null;
    return { success: true, sig, output };
  } catch (e: unknown) {
    const err = e as { stdout?: string; stderr?: string; message?: string };
    const output = (err.stdout ?? "") + (err.stderr ?? "") + (err.message ?? "");
    return { success: false, sig: null, output };
  }
}

// ── collect + sell HOP fees ───────────────────────────────────────────────────

function runCollectHop(): void {
  try {
    const out = execSync("npx tsx src/scripts/collect-hop-fees.ts", {
      env: childEnv(),
      timeout: 90_000,
      encoding: "utf8",
    });
    const verdict = out.match(/^(HARVEST|WITHDRAW|delta)[^\n]*/m)?.[0] ?? out.slice(0, 120);
    console.log(`[${ts()}] [COLLECT] ${verdict.trim()}`);
  } catch (e: unknown) {
    const err = e as { stdout?: string; stderr?: string; message?: string };
    const msg = ((err.stdout ?? "") + (err.stderr ?? "") + (err.message ?? "")).slice(0, 120);
    console.error(`[${ts()}] [COLLECT] ERR: ${msg}`);
  }
}

function runSellHop(): void {
  try {
    const out = execSync("npx tsx src/scripts/sell-hop-fees.ts", {
      env: childEnv({ DRY_RUN: "false", ALLOW_LIVE: "true" }),
      timeout: 90_000,
      encoding: "utf8",
    });
    const verdict = out.match(/^(EXECUTED|NO_ROUTE|SKIP|SIM)[^\n]*/m)?.[0] ?? out.slice(0, 120);
    console.log(`[${ts()}] [SELL] ${verdict.trim()}`);
  } catch (e: unknown) {
    const err = e as { stdout?: string; stderr?: string; message?: string };
    const msg = ((err.stdout ?? "") + (err.stderr ?? "") + (err.message ?? "")).slice(0, 120);
    console.error(`[${ts()}] [SELL] ERR: ${msg}`);
  }
}

function runHarvestAndSell(): void {
  console.log(`[${ts()}] Selling HOP fees...`);
  runCollectHop();
  runSellHop();
}

// ── main loop ─────────────────────────────────────────────────────────────────

let cycle = 0;
let okCount = 0;
let errCount = 0;
let consecutiveErrors = 0;

function printHeader() {
  console.log("=== FLASH DEEP VOL LOOP ===");
  console.log(`Flash: $${flashUsdc} | AddLiq: $${addliqUsdc} | Swap: $${swapUsdc}`);
  console.log(`Slippage: ${slippageBps}bps | CU: ${cuLimit} @ ${cuPrice} | JitoTip: ${jitoTip}`);
  console.log(`Interval: ${intervalMs}ms | SellEvery: ${sellEveryN > 0 ? sellEveryN + " cycles" : "never"} | MaxErrors: ${maxErrors}`);
  if (altAddress) console.log(`ALT: ${altAddress}`);
  console.log("---");
}

function printSummary() {
  console.log(`\n=== LOOP STOPPED ===`);
  console.log(`Cycles: ${cycle} | OK: ${okCount} | Errors: ${errCount}`);
}

process.on("SIGINT", async () => {
  printSummary();
  if (sellEveryN > 0 && okCount > 0) {
    console.log("Final harvest+sell on exit...");
    runHarvestAndSell();
  }
  process.exit(0);
});

(async () => {
  printHeader();

  while (true) {
    cycle++;

    const result = runFlashDeepVol();

    if (result.success) {
      consecutiveErrors = 0;
      okCount++;
      const sigShort = result.sig ? result.sig.slice(0, 20) + "..." : "?";
      console.log(`[${ts()}] Cycle ${cycle} | EXECUTED: ${sigShort} | OK:${okCount} Err:${errCount}`);
    } else {
      consecutiveErrors++;
      errCount++;
      const errMsg = result.output.slice(0, 120).replace(/\n/g, " ");
      console.error(`[${ts()}] Cycle ${cycle} | FAIL #${consecutiveErrors}: ${errMsg} | OK:${okCount} Err:${errCount}`);

      if (consecutiveErrors >= maxErrors) {
        console.error(`[${ts()}] ${maxErrors} consecutive errors — stopping.`);
        printSummary();
        if (sellEveryN > 0 && okCount > 0) runHarvestAndSell();
        process.exit(1);
      }
    }

    // Periodic harvest+sell
    if (sellEveryN > 0 && cycle % sellEveryN === 0) {
      runHarvestAndSell();
    }

    await sleep(intervalMs);
  }
})();
