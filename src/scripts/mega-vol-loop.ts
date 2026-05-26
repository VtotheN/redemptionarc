/**
 * MEGA VOL LOOP — self-volume on Whirlpool USDC/HOP pool.
 *
 * TX layout:
 *   [0]      setComputeUnitLimit
 *   [1]      setComputeUnitPrice
 *   [2..2N+1] N × (swapV2 buy USDC→HOP  +  swapV2 sell HOP→USDC)
 *   [2N+2]   harvestWithheldTokensToMint (ring ATAs + pool vault + crank ATA)
 *   [2N+3]   withdrawWithheldTokensFromMint (mint → crank ATA)
 *
 * Standard TX: max ~4 pairs (8 swaps) + harvest within 1232-byte limit.
 * txnsONcouq batch-processor (devnet only, NOT on mainnet) would allow ~20 pairs.
 * Deploy batch-processor to mainnet: ~2.6 SOL required.
 *
 * Revenue model:
 *   Each HOP transfer withholds floor(amount × fee_bps / 10_000) HOP at destination.
 *   2 transfers per round trip (buy + sell) = 2× withheld.
 *   We are withdraw_withheld_authority → harvest from pool vault + ring ATAs + crank ATA.
 *   Net USDC ≈ 0 per round trip (we are the LP, LP fees recirculate).
 *   True net = withheld_HOP × HOP_USD − gas.
 *   URGENCY: epoch 977 now → fee=690bps. Epoch 978 → 1bps (100× less).
 *
 * ENV:
 *   SOLANA_RPC_URL
 *   SWAPS_PER_BATCH=8      total swaps (even); max 8 with harvest on standard TX
 *   HOP_AMOUNT=100000      HOP per swap, UI units (e.g. 100000 = 100K HOP)
 *   HOP_USD_PRICE=0.0001   approximate HOP price in USD for economics display
 *   CU_PRICE=50000         microLamports per CU
 *   DRY_RUN=true
 *   LOOP=false             continuous mode
 *   LOOP_INTERVAL_MS=500
 *   ALLOW_LIVE=true        required together with DRY_RUN=false to send
 */
import "dotenv/config";
import fs from "node:fs";
import {
  Connection, Keypair, PublicKey, Transaction,
  TransactionInstruction, ComputeBudgetProgram, sendAndConfirmTransaction,
} from "@solana/web3.js";
import {
  TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID,
  getAssociatedTokenAddressSync,
  createHarvestWithheldTokensToMintInstruction,
  createWithdrawWithheldTokensFromMintInstruction,
  getMint, getTransferFeeConfig, getAccount,
} from "@solana/spl-token";
import { writeReceipt } from "../utils/receipt.js";

// ─── Constants ───────────────────────────────────────────────────────────────

const HOP_MINT    = new PublicKey("HZF5k7h39hkysoSZ4ZfmWc55PhvW7ntVvVqdXFCyYGh3");
const USDC_MINT   = new PublicKey("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v");
const HOP_DEC = 6;
const USDC_DEC = 6;

const WHIRLPOOL_PROGRAM = new PublicKey("GxRHMB9a6XE8BqGPeNb9UkJUPvbvrPoPgNTJPJJA4n8h");
const WHIRLPOOL         = new PublicKey("8aoWgf7ycbeKv6BTFCdUj4JR7Y4mXWuPZWEUhmuzN5ZL");
const TOKEN_VAULT_A     = new PublicKey("4QD4GgnjRvjETqWLT5e3x7SHtJSzs9kShUPLfyHcTu7d"); // USDC
const TOKEN_VAULT_B     = new PublicKey("Qv51R47g7pMDxa3UofXaz8cNr8pwRSXaNufgnEWX8Yk");  // HOP
const TICK_ARRAY_84480  = new PublicKey("be9QKj4mYB8erh6r4ZDrKxxSvSYSUNRfpTxqJUgd3jG");
const TICK_ARRAY_90112  = new PublicKey("CDMSB5e6WUgtoSLrybvYm4j58Jue3eqpzHQVLmgVkAe4");
const TICK_ARRAY_95744  = new PublicKey("MXd8HXPjcH9ZCuyr4uKKyN7GkJ5YizZQkgUndB6J8Gz");
const ORACLE            = new PublicKey("5qhXANMqTNNzdp1N1PrMzWzSzjHTZxuLPELcmpog6bp5");
const SPL_MEMO          = new PublicKey("MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr");

const RING_ATAS = [
  new PublicKey("6y8Q9u9psmrwfiAhV4NwR34ap7GZhU4Vc78PpRequijn"),
  new PublicKey("Fq9x3SMf7DLHTVo3yhApFUsM1KibGodbEvcDuGFkiUMJ"),
  new PublicKey("DsKieWX5AtrHpefetBe8kxueQXx7TwEH1R2ScCnDN9Jn"),
];

const SWAP_V2_DISC   = Buffer.from([0x2b, 0x04, 0xed, 0x0b, 0x1a, 0xc9, 0x1e, 0x62]);
const MAX_SQRT_PRICE = 79226673515401279992447579055n;
const MIN_SQRT_PRICE = 4295048016n;
const Q64            = 1n << 64n;
const SOL_USD        = 165.0; // approx for gas calc
const EPOCH_SLOTS    = 432_000;

// ─── Helpers ─────────────────────────────────────────────────────────────────

function loadKeypair(p: string): Keypair {
  return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(p, "utf8"))));
}

function u64Le(n: bigint): Buffer {
  const b = Buffer.alloc(8); b.writeBigUInt64LE(n); return b;
}

function u128Le(n: bigint): Buffer {
  const b = Buffer.alloc(16);
  b.writeBigUInt64LE(n & ((1n << 64n) - 1n), 0);
  b.writeBigUInt64LE(n >> 64n, 8);
  return b;
}

function swapV2Ix(args: {
  tokenAuthority: PublicKey;
  tokenOwnerAccountA: PublicKey;
  tokenOwnerAccountB: PublicKey;
  tickArray0: PublicKey;
  tickArray1: PublicKey;
  tickArray2: PublicKey;
  amount: bigint;
  otherAmountThreshold: bigint;
  sqrtPriceLimit: bigint;
  amountSpecifiedIsInput: boolean;
  aToB: boolean;
}): TransactionInstruction {
  return new TransactionInstruction({
    programId: WHIRLPOOL_PROGRAM,
    keys: [
      { pubkey: TOKEN_PROGRAM_ID,         isSigner: false, isWritable: false },
      { pubkey: TOKEN_2022_PROGRAM_ID,    isSigner: false, isWritable: false },
      { pubkey: SPL_MEMO,                 isSigner: false, isWritable: false },
      { pubkey: args.tokenAuthority,      isSigner: true,  isWritable: false },
      { pubkey: WHIRLPOOL,                isSigner: false, isWritable: true  },
      { pubkey: USDC_MINT,                isSigner: false, isWritable: false },
      { pubkey: HOP_MINT,                 isSigner: false, isWritable: true  },
      { pubkey: args.tokenOwnerAccountA,  isSigner: false, isWritable: true  },
      { pubkey: TOKEN_VAULT_A,            isSigner: false, isWritable: true  },
      { pubkey: args.tokenOwnerAccountB,  isSigner: false, isWritable: true  },
      { pubkey: TOKEN_VAULT_B,            isSigner: false, isWritable: true  },
      { pubkey: args.tickArray0,          isSigner: false, isWritable: true  },
      { pubkey: args.tickArray1,          isSigner: false, isWritable: true  },
      { pubkey: args.tickArray2,          isSigner: false, isWritable: true  },
      { pubkey: ORACLE,                   isSigner: false, isWritable: true  },
    ],
    data: Buffer.concat([
      SWAP_V2_DISC,
      u64Le(args.amount),
      u64Le(args.otherAmountThreshold),
      u128Le(args.sqrtPriceLimit),
      Buffer.from([args.amountSpecifiedIsInput ? 1 : 0]),
      Buffer.from([args.aToB ? 1 : 0]),
      Buffer.from([0x00]),
    ]),
  });
}

// ─── TX size estimator ────────────────────────────────────────────────────────
// Returns max pairs that fit in 1232 bytes with harvest+withdraw in same TX
function maxPairsForStandardTx(): number {
  // Empirical: 4 pairs = 1269 bytes (over limit by 37). 3 pairs fits.
  // TX with 3 buy+sell pairs + 2 CU + harvest + withdraw ≈ 1147 bytes.
  return 3;
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function runOnce(conn: Connection, crank: Keypair, opts: {
  pairs: number;
  hopAmountRaw: bigint;
  hopUsd: number;
  cuPrice: bigint;
  dryRun: boolean;
  allowLive: boolean;
  cuLimit: number;
}): Promise<{ netCashUsd: number; simErr: unknown; txSig?: string }> {
  const { pairs, hopAmountRaw, hopUsd, cuPrice, dryRun, allowLive, cuLimit } = opts;

  const crankHopAta  = getAssociatedTokenAddressSync(HOP_MINT, crank.publicKey, false, TOKEN_2022_PROGRAM_ID);
  const crankUsdcAta = getAssociatedTokenAddressSync(USDC_MINT, crank.publicKey, false);

  // ── 1. On-chain state ────────────────────────────────────────────────────
  const [mintInfo, usdcInfo, hopInfo, epochInfo] = await Promise.all([
    getMint(conn, HOP_MINT, "confirmed", TOKEN_2022_PROGRAM_ID),
    getAccount(conn, crankUsdcAta, "confirmed"),
    getAccount(conn, crankHopAta, "confirmed", TOKEN_2022_PROGRAM_ID).catch(() => null),
    conn.getEpochInfo("confirmed"),
  ]);

  const feeConfig       = getTransferFeeConfig(mintInfo)!;
  const currentEpoch    = epochInfo.epoch;
  const olderFeeBps     = feeConfig.olderTransferFee.transferFeeBasisPoints;
  const newerFeeBps     = feeConfig.newerTransferFee.transferFeeBasisPoints;
  const newerFeeEpoch   = Number(feeConfig.newerTransferFee.epoch);
  const effectiveFeeBps = currentEpoch >= newerFeeEpoch ? newerFeeBps : olderFeeBps;
  const epochChanging   = newerFeeEpoch > currentEpoch;

  const usdcBefore = usdcInfo.amount;
  const hopBefore  = (hopInfo?.amount ?? 0n);

  // Slots to next epoch (approximate urgency)
  const slotsLeft = Math.max(0, (newerFeeEpoch - currentEpoch) * EPOCH_SLOTS - epochInfo.slotIndex);
  const hoursLeft = (slotsLeft * 0.4) / 3600;

  // ── 2. Economics (off-chain estimate) ────────────────────────────────────
  // T22 withheld per transfer: floor(amount × bps / 10_000)
  const withheldPerTransfer = (hopAmountRaw * BigInt(effectiveFeeBps)) / 10_000n;
  const withheldPerPair     = withheldPerTransfer * 2n; // buy + sell
  const withheldPerTx       = withheldPerPair * BigInt(pairs);
  const withheldUsdPerTx    = Number(withheldPerTx) / 10 ** HOP_DEC * hopUsd;

  // USDC per buy (approximate: HOP_AMOUNT / pool_price)
  // pool price = 10000 HOP/USDC (from sqrtPriceX64 = 100 × Q64)
  const hopPriceRatio     = 10000n; // HOP raw per USDC raw (same 6 dec both sides)
  const usdcPerBuyRaw     = hopAmountRaw / hopPriceRatio; // USDC raw per swap
  const usdcPerBuyUsd     = Number(usdcPerBuyRaw) / 10 ** USDC_DEC;

  // ── 3. Build instructions ─────────────────────────────────────────────────
  const buyIxs: TransactionInstruction[] = [];
  const sellIxs: TransactionInstruction[] = [];

  for (let i = 0; i < pairs; i++) {
    // Buy: USDC → HOP (a_to_b=true, price decreases)
    buyIxs.push(swapV2Ix({
      tokenAuthority:       crank.publicKey,
      tokenOwnerAccountA:   crankUsdcAta,
      tokenOwnerAccountB:   crankHopAta,
      tickArray0:           TICK_ARRAY_90112,
      tickArray1:           TICK_ARRAY_84480,
      tickArray2:           TICK_ARRAY_84480,
      amount:               usdcPerBuyRaw,
      otherAmountThreshold: 0n,
      sqrtPriceLimit:       MIN_SQRT_PRICE,
      amountSpecifiedIsInput: true,
      aToB:                 true,
    }));
    // Sell: HOP → USDC (a_to_b=false, price increases)
    sellIxs.push(swapV2Ix({
      tokenAuthority:       crank.publicKey,
      tokenOwnerAccountA:   crankUsdcAta,
      tokenOwnerAccountB:   crankHopAta,
      tickArray0:           TICK_ARRAY_90112,
      tickArray1:           TICK_ARRAY_95744,
      tickArray2:           TICK_ARRAY_95744,
      amount:               hopAmountRaw,
      otherAmountThreshold: 0n,
      sqrtPriceLimit:       MAX_SQRT_PRICE,
      amountSpecifiedIsInput: true,
      aToB:                 false,
    }));
  }

  // Interleave: buy1, sell1, buy2, sell2, ...
  const swapIxs: TransactionInstruction[] = [];
  for (let i = 0; i < pairs; i++) {
    swapIxs.push(buyIxs[i], sellIxs[i]);
  }

  // Harvest: ring ATAs + pool vault B + crank HOP ATA
  const harvestSources = [...RING_ATAS, TOKEN_VAULT_B, crankHopAta];
  const harvestIx = createHarvestWithheldTokensToMintInstruction(
    HOP_MINT, harvestSources, TOKEN_2022_PROGRAM_ID
  );
  const withdrawIx = createWithdrawWithheldTokensFromMintInstruction(
    HOP_MINT, crankHopAta, crank.publicKey, [], TOKEN_2022_PROGRAM_ID
  );

  const ixCuLimit = ComputeBudgetProgram.setComputeUnitLimit({ units: cuLimit });
  const ixCuPrice = ComputeBudgetProgram.setComputeUnitPrice({ microLamports: Number(cuPrice) });

  const { blockhash } = await conn.getLatestBlockhash("confirmed");
  const tx = new Transaction({ recentBlockhash: blockhash, feePayer: crank.publicKey });
  tx.add(ixCuLimit, ixCuPrice, ...swapIxs, harvestIx, withdrawIx);

  // ── 4. Simulate ───────────────────────────────────────────────────────────
  const sim = await conn.simulateTransaction(tx, [crank], [crankUsdcAta, crankHopAta]);
  const simErr  = sim.value.err ?? null;
  const simCu   = sim.value.unitsConsumed ?? cuLimit;

  // Extract post-sim balances
  let usdcAfter = usdcBefore;
  let hopAfter  = hopBefore;
  if (!simErr && sim.value.accounts) {
    const decode = (acc: (typeof sim.value.accounts)[number] | null, offset: number): bigint => {
      if (!acc?.data || !Array.isArray(acc.data)) return 0n;
      const buf = Buffer.from(acc.data[0], "base64");
      return buf.length >= offset + 8 ? buf.readBigUInt64LE(offset) : 0n;
    };
    usdcAfter = decode(sim.value.accounts[0], 64);
    hopAfter  = decode(sim.value.accounts[1], 64);
  }

  // ── 5. Cost & net ─────────────────────────────────────────────────────────
  const gasLamports = 5000n + BigInt(simCu) * cuPrice / 1_000_000n;
  const gasUsd      = Number(gasLamports) / 1e9 * SOL_USD;
  const usdcDelta   = Number(usdcAfter - usdcBefore) / 10 ** USDC_DEC;
  const hopDelta    = Number(hopAfter - hopBefore) / 10 ** HOP_DEC;
  const hopDeltaUsd = hopDelta * hopUsd;
  const netCashUsd  = usdcDelta + hopDeltaUsd - gasUsd;

  // ── 6. Print economics ────────────────────────────────────────────────────
  const sep = "═".repeat(56);
  console.log(`\n${sep}`);
  console.log("MEGA VOL LOOP — DRY RUN");
  console.log(sep);
  console.log(`Crank:          ${crank.publicKey.toBase58()}`);
  console.log(`Epoch:          ${currentEpoch}  (next epoch: ${newerFeeEpoch})`);
  if (epochChanging) {
    console.log(`⚡ FEE CHANGE IN ${hoursLeft.toFixed(1)}h: ${olderFeeBps}bps → ${newerFeeBps}bps AT EPOCH ${newerFeeEpoch}`);
  }
  console.log(`Effective T22:  ${effectiveFeeBps} bps`);
  console.log(`\n─── TX STRUCTURE ─────────────────────────────────────────`);
  console.log(`  [0] setComputeUnitLimit(${cuLimit})`);
  console.log(`  [1] setComputeUnitPrice(${cuPrice} µL)`);
  for (let i = 0; i < pairs; i++) {
    const base = 2 + i * 2;
    console.log(`  [${base}] swapV2 BUY  USDC→HOP  ${Number(usdcPerBuyRaw)/10**USDC_DEC} USDC  a_to_b=true`);
    console.log(`  [${base+1}] swapV2 SELL HOP→USDC  ${Number(hopAmountRaw)/10**HOP_DEC} HOP   a_to_b=false`);
  }
  console.log(`  [${2+pairs*2}] harvestWithheldTokensToMint  (${harvestSources.length} sources)`);
  console.log(`  [${3+pairs*2}] withdrawWithheldTokensFromMint`);
  console.log(`  Total instructions: ${4 + pairs * 2}`);
  console.log(`\n─── T22 FEE ESTIMATE (off-chain) ──────────────────────────`);
  console.log(`  Fee per transfer:   ${Number(withheldPerTransfer)/10**HOP_DEC} HOP  (${effectiveFeeBps}bps × ${Number(hopAmountRaw)/10**HOP_DEC}K HOP)`);
  console.log(`  Withheld per pair:  ${Number(withheldPerPair)/10**HOP_DEC} HOP  (buy + sell)`);
  console.log(`  Withheld per TX:    ${Number(withheldPerTx)/10**HOP_DEC} HOP  (${pairs} pairs)`);
  console.log(`  USD value est:      $${withheldUsdPerTx.toFixed(4)}/TX  (@$${hopUsd}/HOP)`);
  console.log(`\n─── SIMULATION ────────────────────────────────────────────`);
  console.log(`  Sim result:         ${simErr ? "FAIL: " + JSON.stringify(simErr) : "SIM_OK"}`);
  console.log(`  CUs consumed:       ${simCu}`);
  if (simErr) {
    (sim.value.logs ?? []).slice(-8).forEach(l => console.log("    ", l));
  }
  console.log(`\n─── ACTUAL DELTAS (from post-sim account state) ───────────`);
  console.log(`  USDC before:        ${Number(usdcBefore)/10**USDC_DEC}`);
  console.log(`  USDC after (sim):   ${Number(usdcAfter)/10**USDC_DEC}  (Δ${usdcDelta >= 0 ? "+" : ""}${usdcDelta.toFixed(6)})`);
  console.log(`  HOP before:         ${Number(hopBefore)/10**HOP_DEC}`);
  console.log(`  HOP after (sim):    ${Number(hopAfter)/10**HOP_DEC}  (Δ${hopDelta >= 0 ? "+" : ""}${hopDelta.toFixed(3)})`);
  console.log(`\n─── NET ECONOMICS ─────────────────────────────────────────`);
  console.log(`  USDC delta:         $${usdcDelta.toFixed(6)}`);
  console.log(`  HOP delta × price:  $${hopDeltaUsd.toFixed(6)}  (${hopDelta.toFixed(0)} HOP × $${hopUsd})`);
  console.log(`  Gas:                -$${gasUsd.toFixed(6)}  (${Number(gasLamports)} lamports @ $${SOL_USD}/SOL)`);
  console.log(`  ─────────────────────────────────────────────────────────`);
  const profitEmoji = netCashUsd > 0 ? "✓" : "✗";
  console.log(`  NET per TX:         ${profitEmoji} $${netCashUsd.toFixed(6)}`);

  if (!simErr) {
    const txsPerHour = 3600 / (Number(process.env.LOOP_INTERVAL_MS || "500") / 1000);
    const netPerHour = netCashUsd * txsPerHour;
    console.log(`  Est TXs/hr:         ${txsPerHour.toFixed(0)} (1 TX every ${process.env.LOOP_INTERVAL_MS || 500}ms)`);
    console.log(`  NET per hour:       $${netPerHour.toFixed(2)}`);

    // Show epoch 978 projection
    if (epochChanging) {
      const withheldAfter1bps = (hopAmountRaw * 1n / 10_000n) * 2n * BigInt(pairs);
      const usdAfter1bps = Number(withheldAfter1bps) / 10 ** HOP_DEC * hopUsd;
      const netAfter1bps = usdAfter1bps + usdcDelta - gasUsd;
      const hrAfter1bps  = netAfter1bps * txsPerHour;
      console.log(`\n  ─── AFTER EPOCH ${newerFeeEpoch} (1bps) ─────────────────────────────`);
      console.log(`  Withheld/TX:        ${Number(withheldAfter1bps)/10**HOP_DEC} HOP  = $${usdAfter1bps.toFixed(6)}`);
      console.log(`  NET per TX:         $${netAfter1bps.toFixed(6)}`);
      console.log(`  NET per hour:       $${hrAfter1bps.toFixed(2)}`);
    }

    // Batch-processor comparison
    const bpPairs = 20;
    const bpWithheld = (hopAmountRaw * BigInt(effectiveFeeBps) / 10_000n) * 2n * BigInt(bpPairs);
    const bpUsd = Number(bpWithheld) / 10 ** HOP_DEC * hopUsd;
    console.log(`\n  ─── IF batch-processor deployed to mainnet ─────────────`);
    console.log(`  Pairs per TX:       ${bpPairs} (vs ${pairs} now)`);
    console.log(`  Withheld/TX:        ${Number(bpWithheld)/10**HOP_DEC} HOP  ≈ $${bpUsd.toFixed(4)}`);
    console.log(`  Deploy cost:        ~2.6 SOL (one-time)`);
  }

  const out = writeReceipt("MEGA-VOL-DRYRUN-LATEST.json", {
    verdict:           simErr ? "SIM_FAIL" : "SIM_OK",
    epoch:             currentEpoch,
    effectiveFeeBps,
    epochChanging,
    hoursToFeeChange:  epochChanging ? hoursLeft : null,
    pairs,
    hopAmountUi:       Number(hopAmountRaw) / 10 ** HOP_DEC,
    withheldPerTxUi:   Number(withheldPerTx) / 10 ** HOP_DEC,
    withheldUsdPerTx,
    simErr,
    simCu,
    usdcBefore:        usdcBefore.toString(),
    usdcAfter:         usdcAfter.toString(),
    usdcDelta,
    hopBefore:         hopBefore.toString(),
    hopAfter:          hopAfter.toString(),
    hopDelta,
    gasUsd,
    netCashUsd,
    generatedAt:       new Date().toISOString(),
  });
  console.log(`\nReceipt: ${out}`);

  // ── 7. Live execution ─────────────────────────────────────────────────────
  if (!dryRun && allowLive && !simErr) {
    tx.sign(crank);
    const txSig = await sendAndConfirmTransaction(conn, tx, [crank], { commitment: "confirmed" });
    console.log(`\nTX: ${txSig}`);
    writeReceipt("MEGA-VOL-DRYRUN-LATEST.json", { verdict: "EXECUTED", txSig, netCashUsd });
    return { netCashUsd, simErr: null, txSig };
  }

  return { netCashUsd, simErr };
}

async function main() {
  const rpc          = process.env.SOLANA_RPC_URL || "https://mainnet.helius-rpc.com/?api-key=5b121325-36cb-473b-bbeb-47490d21479c";
  const dryRun       = process.env.DRY_RUN !== "false";
  const allowLive    = process.env.ALLOW_LIVE === "true";
  const loopMode     = process.env.LOOP === "true";
  const intervalMs   = Number(process.env.LOOP_INTERVAL_MS || "500");
  const cuPrice      = BigInt(process.env.CU_PRICE || "50000");
  const hopUsd       = Number(process.env.HOP_USD_PRICE || "0.0001");
  const cuLimit      = 800_000;
  const hopAmountUi  = Number(process.env.HOP_AMOUNT || "100000");
  const hopAmountRaw = BigInt(Math.round(hopAmountUi * 10 ** 6));
  const swapsReq     = Number(process.env.SWAPS_PER_BATCH || "8");
  const pairsReq     = Math.floor(swapsReq / 2);
  const maxPairs     = maxPairsForStandardTx();
  const pairs        = Math.min(pairsReq, maxPairs);

  if (pairsReq > maxPairs) {
    console.log(`NOTE: SWAPS_PER_BATCH=${swapsReq} → ${pairsReq} pairs requested, capped at ${maxPairs}`);
    console.log(`      batch-processor on mainnet would allow ${pairsReq} pairs (deploy cost ~2.6 SOL)`);
  }

  const conn  = new Connection(rpc, "confirmed");
  const crank = loadKeypair("keys/crank.json");

  if (!loopMode) {
    await runOnce(conn, crank, { pairs, hopAmountRaw, hopUsd, cuPrice, dryRun, allowLive, cuLimit });
    return;
  }

  console.log(`Loop mode: 1 TX every ${intervalMs}ms`);
  let i = 0;
  while (true) {
    try {
      const { netCashUsd, simErr } = await runOnce(conn, crank, {
        pairs, hopAmountRaw, hopUsd, cuPrice,
        dryRun, allowLive, cuLimit,
      });
      if (simErr) { console.error(`[${i}] SIM_FAIL — stopping loop`); break; }
      console.log(`[${i}] net=$${netCashUsd.toFixed(4)}`);
    } catch (e) {
      console.error(`[${i}] error:`, e);
    }
    i++;
    await new Promise(r => setTimeout(r, intervalMs));
  }
}

main().catch(e => { console.error(e); process.exitCode = 1; });
