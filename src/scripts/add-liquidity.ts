/**
 * Open a position on our OWN Orca Whirlpool (GxRHMB9a...) and add initial liquidity.
 * Both open_position + increase_liquidity_v2 in one atomic TX.
 *
 * Range: 3 initialized tick arrays [84480, 90112, 95744] → position [84480, 101312]
 * Pool:  USDC/HOP at price 0.0001 USDC/HOP (10000 HOP/USDC)
 *
 * ENV:
 *   SEED_USDC=100       (USDC to deposit as LP, default $100)
 *   SLIPPAGE_PCT=20     (slippage %, default 20)
 *   DRY_RUN / ALLOW_LIVE / LIVE_TX_APPROVED
 */
import "dotenv/config";
import fs from "node:fs";
import {
  ComputeBudgetProgram,
  Keypair,
  PublicKey,
  Transaction,
  sendAndConfirmTransaction,
} from "@solana/web3.js";
import {
  getAssociatedTokenAddressSync,
  TOKEN_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ID,
} from "@solana/spl-token";
import { loadConfig } from "../config.js";
import { connectionFor } from "../utils/rpc.js";
import { writeReceipt } from "../utils/receipt.js";
import { assertKeypairMatches, loadKeypair } from "../utils/keypair.js";
import { assertLiveAllowed, assertNoForbiddenConfigured } from "../utils/safety.js";
import {
  deriveTickArray,
  openPositionIx,
  increaseLiquidityV2Ix,
  tickToSqrtPriceX64,
  liquidityFromAmountA,
  amountBFromLiquidity,
  WHIRLPOOL_PROGRAM_ID,
} from "../utils/orca-whirlpool.js";

const USDC_MINT = new PublicKey("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v");
const HOP_MINT  = new PublicKey("HZF5k7h39hkysoSZ4ZfmWc55PhvW7ntVvVqdXFCyYGh3");
const TICK_SPACING = 64;
const TICK_ARRAY_SIZE = 88;

// Range: first 3 initialized arrays
const TICK_LOWER = 84480;
// Last valid tick in array 3: 95744 + 87*64 = 95744 + 5568 = 101312
const TICK_UPPER = 84480 + 2 * TICK_SPACING * TICK_ARRAY_SIZE + TICK_SPACING * (TICK_ARRAY_SIZE - 1);

type PoolReceipt = {
  whirlpool?: string;
  initialSqrtPrice?: string;
  tokenVaultA?: string;
  tokenVaultB?: string;
};

function readPoolReceipt(): PoolReceipt {
  const file = "receipts/REDEMPTION-ORCA-POOL.json";
  if (!fs.existsSync(file)) throw new Error(`Missing ${file} — run init-pool first`);
  return JSON.parse(fs.readFileSync(file, "utf8")) as PoolReceipt;
}

function derivePosition(positionMint: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("position"), positionMint.toBuffer()],
    WHIRLPOOL_PROGRAM_ID
  )[0];
}

async function main() {
  const config = loadConfig();
  assertNoForbiddenConfigured(config);
  assertLiveAllowed(config);
  if (!config.crank) throw new Error("Missing REDEMPTION_CRANK");

  const connection = connectionFor(config.rpcUrl);
  const funder = loadKeypair("keys/crank.json");
  assertKeypairMatches("crank", funder, config.crank);

  const seedUsdcUi = Number(process.env.SEED_USDC || "100");
  const slippagePct = Number(process.env.SLIPPAGE_PCT || "20");

  const poolReceipt = readPoolReceipt();
  const whirlpool    = new PublicKey(poolReceipt.whirlpool!);
  const sqrtPriceX64 = BigInt(poolReceipt.initialSqrtPrice!);
  const tokenVaultA  = new PublicKey(poolReceipt.tokenVaultA!);
  const tokenVaultB  = new PublicKey(poolReceipt.tokenVaultB!);

  const sqrtPLower = tickToSqrtPriceX64(TICK_LOWER);
  const sqrtPUpper = tickToSqrtPriceX64(TICK_UPPER);

  const seedUsdcUnits = BigInt(Math.round(seedUsdcUi * 1e6));
  const liquidity = liquidityFromAmountA(seedUsdcUnits, sqrtPriceX64, sqrtPUpper);
  const requiredHopUnits = amountBFromLiquidity(liquidity, sqrtPriceX64, sqrtPLower);

  const slippageMul = 100n + BigInt(Math.round(slippagePct));
  const tokenMaxA = (seedUsdcUnits * slippageMul) / 100n;
  const tokenMaxB = (requiredHopUnits * slippageMul) / 100n;

  const usdcAta = getAssociatedTokenAddressSync(USDC_MINT, funder.publicKey, false, TOKEN_PROGRAM_ID);
  const hopAta  = getAssociatedTokenAddressSync(HOP_MINT, funder.publicKey, false, TOKEN_2022_PROGRAM_ID);

  const [usdcInfo, hopInfo] = await Promise.all([
    connection.getTokenAccountBalance(usdcAta, "confirmed").catch(() => null),
    connection.getTokenAccountBalance(hopAta, "confirmed").catch(() => null),
  ]);

  const usdcBalance = BigInt(usdcInfo?.value.amount ?? "0");
  const hopBalance  = BigInt(hopInfo?.value.amount ?? "0");

  const receipt: Record<string, unknown> = {
    verdict: "ADD_LIQ_PLAN",
    dryRun: config.dryRun,
    whirlpool: whirlpool.toBase58(),
    tickLower: TICK_LOWER,
    tickUpper: TICK_UPPER,
    seedUsdcUi,
    liquidityAmount: liquidity.toString(),
    requiredHopUi: (Number(requiredHopUnits) / 1e6).toFixed(2),
    tokenMaxA: tokenMaxA.toString(),
    tokenMaxB: tokenMaxB.toString(),
    usdcBalanceUi: (Number(usdcBalance) / 1e6).toFixed(2),
    hopBalanceUi: (Number(hopBalance) / 1e6).toFixed(2),
  };

  if (usdcBalance < seedUsdcUnits) {
    receipt.verdict = "ADD_LIQ_INSUFFICIENT_USDC";
    writeReceipt("REDEMPTION-ORCA-ADD-LIQ.json", receipt);
    console.error(`Insufficient USDC: have ${Number(usdcBalance)/1e6} need ${seedUsdcUi}`);
    process.exitCode = 1;
    return;
  }
  if (hopBalance < requiredHopUnits) {
    receipt.verdict = "ADD_LIQ_INSUFFICIENT_HOP";
    writeReceipt("REDEMPTION-ORCA-ADD-LIQ.json", receipt);
    console.error(`Insufficient HOP: have ${Number(hopBalance)/1e6} need ${Number(requiredHopUnits)/1e6}`);
    process.exitCode = 1;
    return;
  }

  const positionMintKp = Keypair.generate();
  const positionMint   = positionMintKp.publicKey;
  const position       = derivePosition(positionMint);
  const positionTokenAccount = getAssociatedTokenAddressSync(
    positionMint, funder.publicKey, false, TOKEN_PROGRAM_ID
  );

  const tickArrayLower = deriveTickArray(whirlpool, TICK_LOWER);
  const tickArrayUpper = deriveTickArray(whirlpool, 95744);

  const openIx = openPositionIx({
    funder: funder.publicKey,
    owner: funder.publicKey,
    position,
    positionMint,
    positionTokenAccount,
    whirlpool,
    tickLowerIndex: TICK_LOWER,
    tickUpperIndex: TICK_UPPER,
  });

  const addLiqIx = increaseLiquidityV2Ix({
    whirlpool,
    tokenProgramA: TOKEN_PROGRAM_ID,
    tokenProgramB: TOKEN_2022_PROGRAM_ID,
    positionAuthority: funder.publicKey,
    position,
    positionTokenAccount,
    tokenMintA: USDC_MINT,
    tokenMintB: HOP_MINT,
    tokenOwnerAccountA: usdcAta,
    tokenOwnerAccountB: hopAta,
    tokenVaultA,
    tokenVaultB,
    tickArrayLower,
    tickArrayUpper,
    liquidityAmount: liquidity,
    tokenMaxA,
    tokenMaxB,
  });

  receipt.positionMint          = positionMint.toBase58();
  receipt.position              = position.toBase58();
  receipt.positionTokenAccount  = positionTokenAccount.toBase58();

  // Single atomic TX: open_position + increase_liquidity_v2
  const tx = new Transaction()
    .add(ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 }))
    .add(openIx)
    .add(addLiqIx);
  tx.feePayer = funder.publicKey;
  tx.recentBlockhash = (await connection.getLatestBlockhash("confirmed")).blockhash;
  tx.sign(funder, positionMintKp);

  const sim = await connection.simulateTransaction(tx);
  receipt.simulation = { err: sim.value.err ?? null, logs: (sim.value.logs ?? []).slice(-10) };

  if (sim.value.err) {
    receipt.verdict = "ADD_LIQ_SIM_FAILED";
    writeReceipt("REDEMPTION-ORCA-ADD-LIQ.json", receipt);
    console.error("SIM_FAILED:", JSON.stringify(sim.value.err));
    (sim.value.logs ?? []).slice(-10).forEach(l => console.error(l));
    process.exitCode = 1;
    return;
  }

  if (config.dryRun) {
    receipt.verdict = "ADD_LIQ_SIM_OK_DRY_RUN";
    writeReceipt("REDEMPTION-ORCA-ADD-LIQ.json", receipt);
    console.log(`ADD_LIQ_SIM_OK_DRY_RUN liquidity=${liquidity} usdc=${seedUsdcUi} hop=${Number(requiredHopUnits)/1e6}`);
    return;
  }

  const sig = await sendAndConfirmTransaction(connection, tx, [funder, positionMintKp], { commitment: "confirmed" });
  fs.writeFileSync("keys/position-mint.json", JSON.stringify(Array.from(positionMintKp.secretKey)));

  receipt.signature = sig;
  receipt.verdict   = "ADD_LIQ_DEPLOYED";
  writeReceipt("REDEMPTION-ORCA-ADD-LIQ.json", receipt);
  console.log(`ADD_LIQ_DEPLOYED sig=${sig} position=${position.toBase58()} liquidity=${liquidity} usdc=${seedUsdcUi} hop=${Number(requiredHopUnits)/1e6}`);
}

main().catch((e) => { console.error(e); process.exitCode = 1; });
