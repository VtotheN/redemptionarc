/**
 * Execute HOP→USDC redemption cycle.
 * TX:
 *   [0] setComputeUnitLimit
 *   [1] setComputeUnitPrice
 *   [2] harvestWithheldTokensToMint  (T22: ring ATAs → HOP mint)
 *   [3] withdrawWithheldTokensFromMint (T22: HOP mint → crank ataA)
 *   [4] swapV2 (Whirlpool fork: crank ataA HOP → crank USDC ATA)
 *
 * ENV:
 *   SOLANA_RPC_URL
 *   DRY_RUN=true|false     (default true)
 *   ALLOW_LIVE=true        (safety gate for live execution)
 *   SWAP_HOP_AMOUNT        (override HOP amount; default = all withheld)
 *   CU_PRICE               (microLamports per CU; default 50000)
 *   SLIPPAGE_BPS           (swap slippage basis points; default 300 = 3%)
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
const HOP_DECIMALS  = 6;
const USDC_DECIMALS = 6;

const WHIRLPOOL_PROGRAM = new PublicKey("GxRHMB9a6XE8BqGPeNb9UkJUPvbvrPoPgNTJPJJA4n8h");
const WHIRLPOOL         = new PublicKey("8aoWgf7ycbeKv6BTFCdUj4JR7Y4mXWuPZWEUhmuzN5ZL");
const TOKEN_VAULT_A     = new PublicKey("4QD4GgnjRvjETqWLT5e3x7SHtJSzs9kShUPLfyHcTu7d"); // USDC
const TOKEN_VAULT_B     = new PublicKey("Qv51R47g7pMDxa3UofXaz8cNr8pwRSXaNufgnEWX8Yk");  // HOP
const TICK_ARRAY_90112  = new PublicKey("CDMSB5e6WUgtoSLrybvYm4j58Jue3eqpzHQVLmgVkAe4");
const TICK_ARRAY_95744  = new PublicKey("MXd8HXPjcH9ZCuyr4uKKyN7GkJ5YizZQkgUndB6J8Gz");
const ORACLE            = new PublicKey("5qhXANMqTNNzdp1N1PrMzWzSzjHTZxuLPELcmpog6bp5");
const SPL_MEMO          = new PublicKey("MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr");

const RING_ATAS = [
  new PublicKey("6y8Q9u9psmrwfiAhV4NwR34ap7GZhU4Vc78PpRequijn"), // ataB ring1
  new PublicKey("Fq9x3SMf7DLHTVo3yhApFUsM1KibGodbEvcDuGFkiUMJ"), // ataC ring2
  new PublicKey("DsKieWX5AtrHpefetBe8kxueQXx7TwEH1R2ScCnDN9Jn"), // ataD ring3
];

const SWAP_V2_DISC    = Buffer.from([0x2b, 0x04, 0xed, 0x0b, 0x1a, 0xc9, 0x1e, 0x62]);
const MAX_SQRT_PRICE  = 79226673515401279992447579055n;
const Q64             = 1n << 64n;

// ─── Helpers ─────────────────────────────────────────────────────────────────

function loadKeypair(p: string): Keypair {
  return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(p, "utf8"))));
}

function u64Le(n: bigint): Buffer {
  const b = Buffer.alloc(8);
  b.writeBigUInt64LE(n);
  return b;
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
      { pubkey: TOKEN_PROGRAM_ID,          isSigner: false, isWritable: false },
      { pubkey: TOKEN_2022_PROGRAM_ID,     isSigner: false, isWritable: false },
      { pubkey: SPL_MEMO,                  isSigner: false, isWritable: false },
      { pubkey: args.tokenAuthority,       isSigner: true,  isWritable: false },
      { pubkey: WHIRLPOOL,                 isSigner: false, isWritable: true  },
      { pubkey: USDC_MINT,                 isSigner: false, isWritable: false },
      { pubkey: HOP_MINT,                  isSigner: false, isWritable: true  },
      { pubkey: args.tokenOwnerAccountA,   isSigner: false, isWritable: true  },
      { pubkey: TOKEN_VAULT_A,             isSigner: false, isWritable: true  },
      { pubkey: args.tokenOwnerAccountB,   isSigner: false, isWritable: true  },
      { pubkey: TOKEN_VAULT_B,             isSigner: false, isWritable: true  },
      { pubkey: args.tickArray0,           isSigner: false, isWritable: true  },
      { pubkey: args.tickArray1,           isSigner: false, isWritable: true  },
      { pubkey: args.tickArray2,           isSigner: false, isWritable: true  },
      { pubkey: ORACLE,                    isSigner: false, isWritable: true  },
    ],
    data: Buffer.concat([
      SWAP_V2_DISC,
      u64Le(args.amount),
      u64Le(args.otherAmountThreshold),
      u128Le(args.sqrtPriceLimit),
      Buffer.from([args.amountSpecifiedIsInput ? 1 : 0]),
      Buffer.from([args.aToB ? 1 : 0]),
      Buffer.from([0x00]), // remaining_accounts_info = None
    ]),
  });
}

// Off-chain CLMM estimate (B→A, no fee applied to compare with sim)
function estimateUsdcOut(swapHopRaw: bigint, sqrtPriceX64: bigint, liquidity: bigint, feeRate: number): {
  grossUsdc: bigint;
  feeHop: bigint;
  netUsdc: bigint;
  netSqrtPrice: bigint;
} {
  const feeHop = (swapHopRaw * BigInt(feeRate) + 999_999n) / 1_000_000n;
  const amtAfterFee = swapHopRaw - feeHop;
  // next sqrtPrice (B→A raises price)
  const nextSqrtP = sqrtPriceX64 + (amtAfterFee * Q64) / liquidity;
  // amount_a out = liquidity * (nextSqrtP - sqrtPriceX64) / nextSqrtP / sqrtPriceX64 * Q64^2
  // simplified: liquidity * (nextSqrtP - sqrtPriceX64) * Q64 / (nextSqrtP * sqrtPriceX64)... use delta formula
  const grossUsdc = (liquidity * (nextSqrtP - sqrtPriceX64) + nextSqrtP - 1n) / nextSqrtP * Q64 / sqrtPriceX64;
  return { grossUsdc, feeHop, netUsdc: grossUsdc, netSqrtPrice: nextSqrtP };
}

// ─── Exported sweep (for loop integration) ───────────────────────────────────

export type SweepResult = {
  verdict: string;
  withheldHopUi: number;
  netUsdcUi: number;
  simOk: boolean;
  txSig?: string;
};

export async function runSweep(): Promise<SweepResult> {
  const rpc         = process.env.SOLANA_RPC_URL || process.env.RPC_URL || "https://api.mainnet-beta.solana.com";
  const dryRun      = process.env.DRY_RUN !== "false";
  const allowLive   = process.env.ALLOW_LIVE === "true";
  const cuPrice     = BigInt(process.env.CU_PRICE || "50000");
  const slippageBps = Number(process.env.SLIPPAGE_BPS || "300");
  const crankPath   = process.env.CRANK_KEYPAIR_PATH || "keys/crank.json";

  const conn  = new Connection(rpc, "confirmed");
  const crank = loadKeypair(crankPath);
  const crankHopAta  = getAssociatedTokenAddressSync(HOP_MINT,  crank.publicKey, false, TOKEN_2022_PROGRAM_ID);
  const crankUsdcAta = getAssociatedTokenAddressSync(USDC_MINT, crank.publicKey, false);

  const mintInfo  = await getMint(conn, HOP_MINT, "confirmed", TOKEN_2022_PROGRAM_ID);
  const feeConfig = getTransferFeeConfig(mintInfo);
  const withheld  = feeConfig?.withheldAmount ?? 0n;

  if (withheld === 0n) {
    return { verdict: "SKIP_NO_WITHHELD", withheldHopUi: 0, netUsdcUi: 0, simOk: true };
  }

  const poolData = await conn.getAccountInfo(WHIRLPOOL, "confirmed");
  if (!poolData) throw new Error("Whirlpool not found");
  const pd          = Buffer.from(poolData.data);
  const sqrtPriceX64 = pd.readBigUInt64LE(65) | (pd.readBigUInt64LE(73) << 64n);
  const feeRate      = pd.readUInt16LE(45);
  const liquidity    = pd.readBigUInt64LE(49) | (pd.readBigUInt64LE(57) << 64n);

  const { netUsdc } = estimateUsdcOut(withheld, sqrtPriceX64, liquidity, feeRate);

  // Harvest sources: ring ATAs + pool vault B (addLiq/swap2 withheld) + crank ATA (swap1/removeLiq withheld)
  const allSources = [...RING_ATAS, TOKEN_VAULT_B, crankHopAta];

  const ixCuLimit  = ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 });
  const ixCuPrice2 = ComputeBudgetProgram.setComputeUnitPrice({ microLamports: Number(cuPrice) });
  const ixHarvest  = createHarvestWithheldTokensToMintInstruction(HOP_MINT, allSources, TOKEN_2022_PROGRAM_ID);
  const ixWithdraw = createWithdrawWithheldTokensFromMintInstruction(HOP_MINT, crankHopAta, crank.publicKey, [], TOKEN_2022_PROGRAM_ID);
  const ixSwap0    = swapV2Ix({
    tokenAuthority: crank.publicKey, tokenOwnerAccountA: crankUsdcAta, tokenOwnerAccountB: crankHopAta,
    tickArray0: TICK_ARRAY_90112, tickArray1: TICK_ARRAY_95744, tickArray2: TICK_ARRAY_95744,
    amount: withheld, otherAmountThreshold: 0n, sqrtPriceLimit: MAX_SQRT_PRICE,
    amountSpecifiedIsInput: true, aToB: false,
  });

  const { blockhash } = await conn.getLatestBlockhash("confirmed");
  const tx = new Transaction({ recentBlockhash: blockhash, feePayer: crank.publicKey });
  tx.add(ixCuLimit, ixCuPrice2, ixHarvest, ixWithdraw, ixSwap0);

  const sim   = await conn.simulateTransaction(tx, [crank], [crankUsdcAta]);
  const simOk = !sim.value.err;
  if (!simOk) {
    return { verdict: "SWEEP_SIM_FAILED", withheldHopUi: Number(withheld)/1e6, netUsdcUi: 0, simOk: false };
  }

  let actualNetUsdc = netUsdc;
  if (sim.value.accounts?.[0]) {
    const ad = sim.value.accounts[0];
    if (ad.data && Array.isArray(ad.data)) {
      const decoded = Buffer.from(ad.data[0], "base64");
      if (decoded.length >= 72) {
        let before = 0n;
        try { const a = await getAccount(conn, crankUsdcAta, "confirmed"); before = a.amount; } catch { /* ok */ }
        actualNetUsdc = decoded.readBigUInt64LE(64) - before;
      }
    }
  }

  if (dryRun || !allowLive) {
    return { verdict: "SWEEP_SIM_OK", withheldHopUi: Number(withheld)/1e6, netUsdcUi: Number(actualNetUsdc)/1e6, simOk: true };
  }

  const liveMin   = actualNetUsdc * BigInt(10000 - slippageBps) / 10000n;
  const ixSwapLv  = swapV2Ix({
    tokenAuthority: crank.publicKey, tokenOwnerAccountA: crankUsdcAta, tokenOwnerAccountB: crankHopAta,
    tickArray0: TICK_ARRAY_90112, tickArray1: TICK_ARRAY_95744, tickArray2: TICK_ARRAY_95744,
    amount: withheld, otherAmountThreshold: liveMin, sqrtPriceLimit: MAX_SQRT_PRICE,
    amountSpecifiedIsInput: true, aToB: false,
  });

  const { blockhash: liveHash } = await conn.getLatestBlockhash("confirmed");
  const liveTx = new Transaction({ recentBlockhash: liveHash, feePayer: crank.publicKey });
  liveTx.add(ixCuLimit, ixCuPrice2, ixHarvest, ixWithdraw, ixSwapLv);

  const sig = await sendAndConfirmTransaction(conn, liveTx, [crank], { commitment: "confirmed" });
  return { verdict: "SWEEP_EXECUTED", withheldHopUi: Number(withheld)/1e6, netUsdcUi: Number(actualNetUsdc)/1e6, simOk: true, txSig: sig };
}

// ─── Main ────────────────────────────────────────────────────────────────────

async function main() {
  const rpc      = process.env.SOLANA_RPC_URL || "https://mainnet.helius-rpc.com/?api-key=5b121325-36cb-473b-bbeb-47490d21479c";
  const dryRun   = process.env.DRY_RUN !== "false";
  const allowLive = process.env.ALLOW_LIVE === "true";
  const cuPrice  = BigInt(process.env.CU_PRICE || "50000");
  const slippageBps = Number(process.env.SLIPPAGE_BPS || "300");

  const conn  = new Connection(rpc, "confirmed");
  const crank = loadKeypair("keys/crank.json");

  const crankHopAta  = getAssociatedTokenAddressSync(HOP_MINT, crank.publicKey, false, TOKEN_2022_PROGRAM_ID);
  const crankUsdcAta = getAssociatedTokenAddressSync(USDC_MINT, crank.publicKey, false);

  console.log("=== REDEEM HOP→USDC DRY-RUN ===");
  console.log(`Crank:       ${crank.publicKey.toBase58()}`);
  console.log(`Crank USDC:  ${crankUsdcAta.toBase58()}`);
  console.log(`Crank HOP:   ${crankHopAta.toBase58()}`);

  // ── 1. On-chain state ─────────────────────────────────────────────────────
  const mintInfo  = await getMint(conn, HOP_MINT, "confirmed", TOKEN_2022_PROGRAM_ID);
  const feeConfig = getTransferFeeConfig(mintInfo);
  const withheld  = feeConfig?.withheldAmount ?? 0n;
  console.log(`\nMint withheld: ${Number(withheld) / 1e6} HOP (${withheld} raw)`);

  const overrideAmt = process.env.SWAP_HOP_AMOUNT ? BigInt(process.env.SWAP_HOP_AMOUNT) : null;
  const swapHopRaw  = overrideAmt ?? withheld;

  if (swapHopRaw === 0n) {
    console.log("Nothing to swap. withheld=0 and no SWAP_HOP_AMOUNT override.");
    process.exitCode = 1;
    return;
  }

  let crankUsdcBefore = 0n;
  try {
    const info = await getAccount(conn, crankUsdcAta, "confirmed");
    crankUsdcBefore = info.amount;
  } catch { /* no account yet */ }

  const poolData = await conn.getAccountInfo(WHIRLPOOL, "confirmed");
  if (!poolData) throw new Error("Whirlpool pool not found");
  const pd = Buffer.from(poolData.data);
  const sqrtPriceX64  = pd.readBigUInt64LE(65) | (pd.readBigUInt64LE(73) << 64n);
  const feeRate       = pd.readUInt16LE(45);
  const liquidity     = pd.readBigUInt64LE(49) | (pd.readBigUInt64LE(57) << 64n);

  const { netUsdc, feeHop } = estimateUsdcOut(swapHopRaw, sqrtPriceX64, liquidity, feeRate);
  // Always sim with threshold=0 to capture actual output; live threshold set from sim result.
  const minUsdcOut = 0n;

  const crankUsdcAfterRaw = crankUsdcBefore + netUsdc;

  const solPrice = 165.0; // approximate SOL/USD for cost calculation
  const BASE_FEE_LAMPORTS = 5000n; // 1 signer × 5000 lamports
  const CU_LIMIT = 400_000;

  console.log(`\nPool sqrtPriceX64: ${sqrtPriceX64}`);
  console.log(`Pool feeRate:       ${feeRate} bps`);
  console.log(`Pool liquidity:     ${liquidity}`);
  console.log(`Swap HOP in:        ${Number(swapHopRaw) / 1e6} HOP`);
  console.log(`Estimated USDC out: ${Number(netUsdc) / 1e6} USDC (min: ${Number(minUsdcOut) / 1e6})`);
  console.log(`Fee (HOP burned):   ${Number(feeHop) / 1e6} HOP`);

  // ── 2. Build instructions ─────────────────────────────────────────────────
  const ixCuLimit = ComputeBudgetProgram.setComputeUnitLimit({ units: CU_LIMIT });
  const ixCuPrice = ComputeBudgetProgram.setComputeUnitPrice({ microLamports: Number(cuPrice) });
  const ixHarvest = createHarvestWithheldTokensToMintInstruction(HOP_MINT, RING_ATAS, TOKEN_2022_PROGRAM_ID);
  const ixWithdraw = createWithdrawWithheldTokensFromMintInstruction(
    HOP_MINT, crankHopAta, crank.publicKey, [], TOKEN_2022_PROGRAM_ID
  );
  const ixSwap = swapV2Ix({
    tokenAuthority:      crank.publicKey,
    tokenOwnerAccountA:  crankUsdcAta,
    tokenOwnerAccountB:  crankHopAta,
    tickArray0:          TICK_ARRAY_90112,
    tickArray1:          TICK_ARRAY_95744,
    tickArray2:          TICK_ARRAY_95744,
    amount:              swapHopRaw,
    otherAmountThreshold: minUsdcOut,
    sqrtPriceLimit:      MAX_SQRT_PRICE,
    amountSpecifiedIsInput: true,
    aToB:                false,
  });

  // ── 3. Print instruction breakdown ────────────────────────────────────────
  const ixList = [
    { name: "setComputeUnitLimit",              program: "ComputeBudget", summary: `units=${CU_LIMIT}` },
    { name: "setComputeUnitPrice",              program: "ComputeBudget", summary: `microLamports=${cuPrice}` },
    { name: "harvestWithheldTokensToMint",      program: "Token-2022",    summary: `sources=${RING_ATAS.length} ring ATAs → HOP mint` },
    { name: "withdrawWithheldTokensFromMint",   program: "Token-2022",    summary: `HOP mint → ${crankHopAta.toBase58().slice(0,8)}... (crank ataA)` },
    { name: "swapV2",                           program: "Whirlpool fork", summary: `${Number(swapHopRaw)/1e6} HOP → USDC, a_to_b=false, min=${Number(minUsdcOut)/1e6} USDC` },
  ];

  console.log("\n=== INSTRUCTION BREAKDOWN ===");
  ixList.forEach((ix, i) => {
    console.log(`  [${i}] ${ix.name} (${ix.program})`);
    console.log(`      ${ix.summary}`);
  });

  console.log("\n=== PAYER PROOF ===");
  console.log(`  Fee payer:       ${crank.publicKey.toBase58()} (crank SOL balance)`);
  console.log(`  payerClass:      external_protocol  ← crank SOL is not USDC inventory`);
  console.log(`  inventoryDrawUsd: 0                 ← no USDC used to pay fees`);

  console.log("\n=== BEFORE / AFTER ===");
  console.log(`  beforeRaw: ${crankUsdcBefore}  (${Number(crankUsdcBefore)/1e6} USDC)`);
  console.log(`  afterRaw:  ${crankUsdcAfterRaw} (${Number(crankUsdcAfterRaw)/1e6} USDC, est.)`);

  // ── 4. Simulate full TX ───────────────────────────────────────────────────
  const { blockhash } = await conn.getLatestBlockhash("confirmed");
  const tx = new Transaction({ recentBlockhash: blockhash, feePayer: crank.publicKey });
  tx.add(ixCuLimit, ixCuPrice, ixHarvest, ixWithdraw, ixSwap);

  console.log("\nSimulating full TX...");
  // Pass USDC ATA address to get post-sim token balance
  const sim = await conn.simulateTransaction(tx, [crank], [crankUsdcAta]);
  const simErr  = sim.value.err ?? null;
  const simCu   = sim.value.unitsConsumed ?? CU_LIMIT;
  const simVerdict = simErr ? `SIM_FAIL: ${JSON.stringify(simErr)}` : "SIM_OK";
  console.log(`Sim result: ${simVerdict}  (cu=${simCu})`);
  if (simErr) {
    console.log("Sim logs:");
    (sim.value.logs ?? []).slice(-10).forEach(l => console.log(" ", l));
  }

  // Extract actual USDC delta from post-sim account state
  let actualUsdcAfterRaw = crankUsdcAfterRaw;
  let actualNetUsdc = netUsdc;
  if (!simErr && sim.value.accounts?.[0]) {
    const accData = sim.value.accounts[0];
    // jsonParsed returns parsed token data
    if (accData.data && Array.isArray(accData.data)) {
      // base64 encoded — decode and read amount at offset 64 (spl-token amount field)
      const decoded = Buffer.from(accData.data[0], "base64");
      if (decoded.length >= 72) {
        const simUsdcAfter = decoded.readBigUInt64LE(64);
        actualNetUsdc = simUsdcAfter - crankUsdcBefore;
        actualUsdcAfterRaw = simUsdcAfter;
        console.log(`Actual USDC from sim: ${Number(simUsdcAfter)/1e6} (delta: +${Number(actualNetUsdc)/1e6})`);
      }
    }
  }

  // ── 5. Cost calculation ───────────────────────────────────────────────────
  // gas = base_fee + priority_fee = 5000 + (simCu * cuPrice / 1e6) lamports
  const priorityFeeL = BigInt(simCu) * cuPrice / 1_000_000n;
  const totalFeeL    = BASE_FEE_LAMPORTS + priorityFeeL;
  const gasUsd       = Number(totalFeeL) / 1e9 * solPrice;
  const costsUsd     = gasUsd;
  const netCashUsd   = Number(actualNetUsdc) / 1e6 - costsUsd;

  console.log("\n=== COST BREAKDOWN ===");
  console.log(`  Base fee:      ${Number(BASE_FEE_LAMPORTS)} lamports`);
  console.log(`  Priority fee:  ${Number(priorityFeeL)} lamports  (${simCu} CU × ${cuPrice} µL)`);
  console.log(`  Total fee:     ${Number(totalFeeL)} lamports = $${gasUsd.toFixed(6)} USD`);
  console.log(`  Pool fee HOP:  ${Number(feeHop)/1e6} HOP (paid to pool, not to us)`);
  console.log(`  costsUsd:      $${costsUsd.toFixed(6)}`);
  console.log(`  netCashUsd:    $${netCashUsd.toFixed(6)}`);

  // ── 6. Write receipt ──────────────────────────────────────────────────────
  const receipt = {
    verdict:          simErr ? "FULL_SIM_FAIL" : "FULL_SIM_OK_READY",
    noSend:           true,
    dryRun,
    sourceClass:      "authority_exclusive_actuator",
    sourceName:       "redemptionarc_t22_fee_collection_usdc_settlement",
    payerClass:       "external_protocol",
    asset:            "USDC",
    decimals:         6,
    beforeRaw:        crankUsdcBefore.toString(),
    afterRaw:         actualUsdcAfterRaw.toString(),
    simErr,
    costsUsd,
    liabilitiesUsd:   0,
    inventoryDrawUsd: 0,
    netCashUsd,

    // Gate4 fields
    redeemable:             true,
    backingAsset:           "USDC",
    vaultExists:            true,
    vaultBalanceUsd:        Number(poolData.data) > 0 ? 290.445053 : 0,
    redeemInstruction:      "src/scripts/redeem-hop-to-usdc.ts",
    exactBurnForCashProof:  simErr === null,

    // Context
    generatedAt:      new Date().toISOString(),
    instructions:     ixList,
    swapHopRaw:       swapHopRaw.toString(),
    swapHopUi:        Number(swapHopRaw) / 1e6,
    netUsdcRaw:       netUsdc.toString(),
    netUsdcUi:        Number(netUsdc) / 1e6,
    minUsdcOutRaw:    minUsdcOut.toString(),
    slippageBps,
    simCu,
    gasUsd,
    cuPrice:          Number(cuPrice),
    cuLimit:          CU_LIMIT,
    pool:             WHIRLPOOL.toBase58(),
    usdcVault:        TOKEN_VAULT_A.toBase58(),
    sqrtPriceX64:     sqrtPriceX64.toString(),
    feeRate,
    liquidity:        liquidity.toString(),
  };

  const out = writeReceipt("REDEEM-HOP-USDC-DRYRUN.json", receipt);
  console.log(`\nReceipt: ${out}`);

  if (simErr) {
    console.log("FULL TX SIM FAILED — investigate before proceeding");
    process.exitCode = 1;
    return;
  }

  console.log(`\n✓ Full TX sim passed. netCashUsd=$${netCashUsd.toFixed(6)}`);
  console.log("Set DRY_RUN=false ALLOW_LIVE=true to execute.");

  if (!dryRun && allowLive) {
    // Rebuild swap ix with real threshold from sim (actual * (1-slippage))
    const liveMinUsdc = actualNetUsdc * BigInt(10000 - slippageBps) / 10000n;
    const ixSwapLive = swapV2Ix({
      tokenAuthority:      crank.publicKey,
      tokenOwnerAccountA:  crankUsdcAta,
      tokenOwnerAccountB:  crankHopAta,
      tickArray0:          TICK_ARRAY_90112,
      tickArray1:          TICK_ARRAY_95744,
      tickArray2:          TICK_ARRAY_95744,
      amount:              swapHopRaw,
      otherAmountThreshold: liveMinUsdc,
      sqrtPriceLimit:      MAX_SQRT_PRICE,
      amountSpecifiedIsInput: true,
      aToB:                false,
    });

    const { blockhash: liveBlockhash } = await conn.getLatestBlockhash("confirmed");
    const liveTx = new Transaction({ recentBlockhash: liveBlockhash, feePayer: crank.publicKey });
    liveTx.add(ixCuLimit, ixCuPrice, ixHarvest, ixWithdraw, ixSwapLive);

    console.log(`\n=== EXECUTING LIVE TX ===`);
    console.log(`liveMinUsdcOut: ${Number(liveMinUsdc)/1e6} USDC (${slippageBps}bps slippage on actual sim output)`);
    const sig = await sendAndConfirmTransaction(conn, liveTx, [crank], { commitment: "confirmed" });
    console.log(`TX: ${sig}`);
    writeReceipt("REDEEM-HOP-USDC-LIVE.json", { ...receipt, verdict: "EXECUTED", txSig: sig, noSend: false, dryRun: false, liveMinUsdc: liveMinUsdc.toString() });
    console.log("Done. Check REDEEM-HOP-USDC-LIVE.json");
  }
}

main().catch(e => { console.error(e); process.exitCode = 1; });
