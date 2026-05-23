import "dotenv/config";
import { writeReceipt } from "../utils/receipt.js";

// not stacc confirmed TX 2026-05-22:
// WzMaL78s... → 20 TXs/20sec, $0.004/tx, T22 ring + MarginFi legacy flash
// Claim: $30M volume for <$10 gas total

const GAS_PER_TX_LAMPORTS = 25_800;
const SOL_PRICE_USD = Number(process.env.SOL_PRICE_USD || "165");
const GAS_PER_TX_USD = (GAS_PER_TX_LAMPORTS / 1e9) * SOL_PRICE_USD;

const T22_FEE_BPS = 1;        // 1 bps per hop (DLYp3Fd5... confirmed)
const HOPS = 4;               // 4-wallet ring
const TOTAL_FEE_BPS = T22_FEE_BPS * HOPS; // 4 bps per TX

const MARGINFI_FEE_BPS = 0;  // legacy flash, 0 bps confirmed

function model(flashUsd: number, txPerDay: number) {
  const feeUsdPerTx = flashUsd * (TOTAL_FEE_BPS / 10_000);
  const gasUsdPerTx = GAS_PER_TX_USD;
  const netUsdPerTx = feeUsdPerTx - gasUsdPerTx;
  const netUsdPerDay = netUsdPerTx * txPerDay;
  const totalGasPerDay = gasUsdPerTx * txPerDay;
  const breakEvenFlash = gasUsdPerTx / (TOTAL_FEE_BPS / 10_000);
  return { flashUsd, txPerDay, feeUsdPerTx, gasUsdPerTx, netUsdPerTx, netUsdPerDay, totalGasPerDay, breakEvenFlash };
}

function main() {
  const scenarios = [
    { flash: 10_000,       txPerDay: 86_400 },   // $10k flash, 1 TX/sec
    { flash: 100_000,      txPerDay: 86_400 },   // $100k flash
    { flash: 1_000_000,    txPerDay: 86_400 },   // $1M flash
    { flash: 10_000_000,   txPerDay: 86_400 },   // $10M flash
    { flash: 30_000_000,   txPerDay: 86_400 },   // $30M flash (not stacc claim)
  ];

  console.log("\n=== OWNED AMM PLAN — T22 Ring + MarginFi Legacy Flash ===\n");
  console.log(`Gas/TX:         $${GAS_PER_TX_USD.toFixed(6)} (${GAS_PER_TX_LAMPORTS} lamports @ $${SOL_PRICE_USD})`);
  console.log(`T22 fee:        ${T22_FEE_BPS} bps/hop × ${HOPS} hops = ${TOTAL_FEE_BPS} bps/TX`);
  console.log(`MarginFi fee:   ${MARGINFI_FEE_BPS} bps (legacy mode, confirmed)`);
  console.log(`Breakeven vol:  $${(GAS_PER_TX_USD / (TOTAL_FEE_BPS / 10_000)).toFixed(2)}/TX\n`);

  console.log("Flash Size     | Fee/TX    | Gas/TX   | Net/TX   | Net/Day      | Gas/Day");
  console.log("---------------|-----------|----------|----------|--------------|--------");

  for (const s of scenarios) {
    const m = model(s.flash, s.txPerDay);
    const fmtFlash = `$${(s.flash / 1_000_000).toFixed(1)}M`.padEnd(14);
    const fmtFee = `$${m.feeUsdPerTx.toFixed(2)}`.padEnd(10);
    const fmtGas = `$${m.gasUsdPerTx.toFixed(4)}`.padEnd(9);
    const fmtNet = `$${m.netUsdPerTx.toFixed(2)}`.padEnd(9);
    const fmtDay = `$${m.netUsdPerDay.toLocaleString("en-US", { maximumFractionDigits: 0 })}`.padEnd(13);
    const fmtGasDay = `$${m.totalGasPerDay.toFixed(2)}`;
    console.log(`${fmtFlash} | ${fmtFee} | ${fmtGas} | ${fmtNet} | ${fmtDay} | ${fmtGasDay}`);
  }

  console.log("\n=== SETTLEMENT GAP ===");
  console.log("T22 fees collected in DLYp3Fd5 token, NOT USDC.");
  console.log("To realize as USDC:");
  console.log("  Option A: Own T22/USDC pool (Whirlpool fork) → sell fees into own pool");
  console.log("  Option B: Give token real market (Raydium/Orca seed $500 liq)");
  console.log("  Option C: T22 token = USDC-pegged wrapper (most elegant)");

  console.log("\n=== NOT STACC LIVE PROOF ===");
  console.log("TX:    2jgoM1pFSH7FRqnLixMs3GAYrNQWDiJyMf1G284FTBWNjXqFy7MAV9cA1uyg4KDLw3dQsYN9xKvTimmRbscMGaLe");
  console.log("Bot:   20 TXs in 20 seconds (1 TX/slot)");
  console.log("Fee:   $0.004257/TX");
  console.log("Token: DLYp3Fd5SQSyY4o33NgPBicnTtBfZr5NBk6vAFv5E9En");
  console.log("       1 bps fee, u64::MAX cap, immutable mint, 1B supply");
  console.log("Flash: $1 USDC (minimum wrapper, scales to $30M same gas)");

  console.log("\n=== NEXT STEPS ===");
  console.log("1. Replicate not stacc TX structure in redemptionarc (T22 ring + MarginFi legacy)");
  console.log("2. Scale flash from $1 → $100k → $1M (MarginFi USDC bank capacity)");
  console.log("3. Solve settlement: deploy T22/USDC owned AMM (VtotheN/EXPERIMENTO-bhivepool fork)");
  console.log("4. Run 50 rings parallel → aggregate daily target");

  writeReceipt("owned-amm-plan", {
    verdict: "OWNED_AMM_PATH_MODELED",
    gasPerTxUsd: GAS_PER_TX_USD,
    t22FeeBps: T22_FEE_BPS,
    hops: HOPS,
    totalFeeBps: TOTAL_FEE_BPS,
    breakEvenFlashUsd: GAS_PER_TX_USD / (TOTAL_FEE_BPS / 10_000),
    notStaccProofTx: "2jgoM1pFSH7FRqnLixMs3GAYrNQWDiJyMf1G284FTBWNjXqFy7MAV9cA1uyg4KDLw3dQsYN9xKvTimmRbscMGaLe",
    notStaccToken: "DLYp3Fd5SQSyY4o33NgPBicnTtBfZr5NBk6vAFv5E9En",
    at30mFlashNetPerTx: model(30_000_000, 86_400).netUsdPerTx,
    at1mFlashNetPerDay: model(1_000_000, 86_400).netUsdPerDay,
    settlementGap: "T22 fees in T22 token, not USDC — needs owned AMM or real market",
    nextStep: "replicate-not-stacc-tx-structure-then-scale-flash",
  });
}

main();
