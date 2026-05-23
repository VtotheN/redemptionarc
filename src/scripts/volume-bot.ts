/**
 * Volume bot: USDC→HOP→USDC round-trip via Raydium CPMM.
 * Revenue = LP fees (0.05% per swap, 0.10% round-trip) — crank is 100% LP owner.
 * T22 withheld fees harvested separately by not-stacc-replicate / keeper-loop.
 *
 * Pool: EwoZHyXz48vZL1TwkpQoq31brW4G4NDwmMr1DMw6qqBV
 * ENV:
 *   SOLANA_RPC_URL
 *   DRY_RUN=true|false       (default true)
 *   ALLOW_LIVE=true          (required for live execution)
 *   SWAP_USDC=50             (USDC per buy leg, default $50)
 *   SLIPPAGE_BPS=100         (default 1% = 100bps)
 *   T22_FEE_BPS=690          (current HOP transfer fee, default 690)
 *   MIN_POOL_USDC=10         (abort if pool < this USD, default $10)
 */
import "dotenv/config";
import fs from "node:fs";
import { Connection, Keypair, PublicKey } from "@solana/web3.js";
import { writeReceipt } from "../utils/receipt.js";

const POOL_ID  = new PublicKey("EwoZHyXz48vZL1TwkpQoq31brW4G4NDwmMr1DMw6qqBV");
const HOP_MINT = new PublicKey("HZF5k7h39hkysoSZ4ZfmWc55PhvW7ntVvVqdXFCyYGh3");
const USDC_DECIMALS = 6;
const HOP_DECIMALS  = 6;

function loadKeypair(p: string) {
  return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(p, "utf8")) as number[]));
}

async function main() {
  const rpc        = process.env.SOLANA_RPC_URL || "https://api.mainnet-beta.solana.com";
  const dryRun     = process.env.DRY_RUN !== "false";
  const allowLive  = process.env.ALLOW_LIVE === "true";
  const swapUsdcUi = Number(process.env.SWAP_USDC || "50");
  const slippageBps = Number(process.env.SLIPPAGE_BPS || "100");
  const t22FeeBps  = Number(process.env.T22_FEE_BPS || "690");
  const minPoolUsdc = Number(process.env.MIN_POOL_USDC || "10");
  const slippagePct = slippageBps / 10000;

  const conn  = new Connection(rpc, "confirmed");
  const crank = loadKeypair("keys/crank.json");

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let sdk: any;
  try {
    sdk = await import("@raydium-io/raydium-sdk-v2" as string);
  } catch {
    console.error("Missing SDK: npm install @raydium-io/raydium-sdk-v2");
    process.exitCode = 1;
    return;
  }

  const { Raydium } = sdk;
  const BNModule = await import("bn.js");
  const BN = BNModule.default ?? BNModule;

  const raydium = await Raydium.load({ connection: conn, owner: crank, disableFeatureCheck: true });

  const { poolInfo, poolKeys, rpcData, computePoolInfo } =
    await raydium.cpmm.getPoolInfoFromRpc(POOL_ID.toBase58());

  if (!poolInfo) {
    console.error("Pool not found:", POOL_ID.toBase58());
    process.exitCode = 1;
    return;
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const base  = Number((rpcData as any).baseReserve)  / 10 ** USDC_DECIMALS;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const quote = Number((rpcData as any).quoteReserve) / 10 ** HOP_DECIMALS;
  const priceUsd = base > 0 && quote > 0 ? base / quote : 0;

  console.log("=== VOLUME BOT ===");
  console.log(`Pool:     ${POOL_ID.toBase58()}`);
  console.log(`Crank:    ${crank.publicKey.toBase58()}`);
  console.log(`Reserve:  $${base.toFixed(2)} USDC | ${quote.toFixed(0)} HOP`);
  console.log(`Price:    $${priceUsd.toFixed(8)}/HOP`);
  console.log(`Swap:     $${swapUsdcUi} USDC`);
  console.log(`Slip:     ${slippageBps}bps  T22fee: ${t22FeeBps}bps`);
  console.log(`Dry run:  ${dryRun}`);
  console.log();

  if (base < minPoolUsdc) {
    console.error(`Pool too shallow: $${base.toFixed(2)} USDC < min $${minPoolUsdc}. Seed pool first.`);
    console.error(`  Run: DRY_RUN=false ALLOW_LIVE=true npm run add-hop-liquidity`);
    process.exitCode = 1;
    return;
  }

  const swapUsdcRaw = Math.round(swapUsdcUi * 10 ** USDC_DECIMALS);
  const usdcBN = new BN(swapUsdcRaw.toString());

  // ── LEG 1 compute: USDC → HOP ──
  const buy = raydium.cpmm.computeSwapAmount({
    pool: computePoolInfo,
    amountIn: usdcBN,
    outputMint: HOP_MINT.toBase58(),
    slippage: slippagePct,
    swapBaseIn: true,
  });

  const hopOutRaw    = Number(buy.amountOut);
  const hopOutMin    = Number(buy.minAmountOut);
  const buyFeeUsdc   = Number(buy.fee) / 10 ** USDC_DECIMALS;
  const buyImpact    = Number(buy.priceImpact) * 100;

  // HOP received after T22 fee withheld (deducted from received amount)
  const t22WithheldRaw = Math.ceil(hopOutRaw * t22FeeBps / 10000);
  const hopAvailRaw    = hopOutRaw - t22WithheldRaw;
  const hopAvailBN     = new BN(hopAvailRaw.toString());
  const hopOutUi       = hopOutRaw / 10 ** HOP_DECIMALS;
  const hopAvailUi     = hopAvailRaw / 10 ** HOP_DECIMALS;

  console.log(`LEG1 (USDC→HOP): $${swapUsdcUi} → ${hopOutUi.toFixed(4)} HOP`);
  console.log(`  impact: ${buyImpact.toFixed(4)}%  LP fee: $${buyFeeUsdc.toFixed(4)}`);
  console.log(`  T22 withheld: ${(t22WithheldRaw / 10**HOP_DECIMALS).toFixed(4)} HOP (${t22FeeBps}bps)`);
  console.log(`  Available for sell: ${hopAvailUi.toFixed(4)} HOP`);

  // ── LEG 2 compute (approx, using updated vault state from buy swapResult): HOP → USDC ──
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const sr = buy.swapResult as any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const computePost: any = {
    ...computePoolInfo,
    baseReserve:  sr.newInputVaultAmount,
    quoteReserve: sr.newOutputVaultAmount,
  };

  const sell = raydium.cpmm.computeSwapAmount({
    pool: computePost,
    amountIn: hopAvailBN,
    outputMint: poolInfo.mintA.address,  // USDC
    slippage: slippagePct,
    swapBaseIn: false,
  });

  const usdcBackUi  = Number(sell.amountOut) / 10 ** USDC_DECIMALS;
  const sellFeeHop  = Number(sell.fee) / 10 ** HOP_DECIMALS;
  const sellImpact  = Number(sell.priceImpact) * 100;

  console.log(`LEG2 (HOP→USDC): ${hopAvailUi.toFixed(4)} HOP → $${usdcBackUi.toFixed(4)} USDC`);
  console.log(`  impact: ${sellImpact.toFixed(4)}%  LP fee: ${sellFeeHop.toFixed(4)} HOP`);

  const netRoundTrip   = usdcBackUi - swapUsdcUi;
  const lpFeesUsd      = buyFeeUsdc + sellFeeHop * priceUsd;
  const t22ValueUsd    = (t22WithheldRaw / 10 ** HOP_DECIMALS) * priceUsd;

  console.log();
  console.log(`Net round-trip:    ${netRoundTrip >= 0 ? "+" : ""}$${netRoundTrip.toFixed(4)} USDC`);
  console.log(`LP fees accrued:   ~$${lpFeesUsd.toFixed(4)} USDC (ours as 100% LP)`);
  console.log(`T22 withheld val:  ~$${t22ValueUsd.toFixed(4)} USDC equiv (sell via keeper)`);
  console.log(`Est total revenue: ~$${(lpFeesUsd + t22ValueUsd).toFixed(4)} USDC`);
  console.log();

  const receipt: Record<string, unknown> = {
    verdict: "",
    swapUsdcUi,
    hopOutUi,
    hopAvailUi,
    usdcBackUi,
    netRoundTrip,
    lpFeesUsd,
    t22ValueUsd,
    buyImpactPct: buyImpact,
    sellImpactPct: sellImpact,
    buyTxId: null as string | null,
    sellTxId: null as string | null,
  };

  if (dryRun || !allowLive) {
    console.log("DRY_RUN — set DRY_RUN=false ALLOW_LIVE=true to execute.");
    receipt.verdict = "DRY_RUN";
    writeReceipt("volume-bot", receipt);
    return;
  }

  // ── EXECUTE LEG 1: USDC → HOP ──
  console.log("Executing LEG1: USDC→HOP...");
  const { execute: buyExec } = await raydium.cpmm.swap({
    poolInfo,
    poolKeys,
    baseIn: true,
    inputAmount: usdcBN,
    swapResult: buy.swapResult,
    slippage: slippagePct,
    txVersion: 0,
  });
  const { txId: buyTxId } = await buyExec({ sendAndConfirm: true });
  console.log(`LEG1 TX: ${buyTxId}`);
  receipt.buyTxId = buyTxId;

  // Re-fetch live pool state for accurate leg2
  const { computePoolInfo: computePoolInfo2 } =
    await raydium.cpmm.getPoolInfoFromRpc(POOL_ID.toBase58());

  // ── EXECUTE LEG 2: HOP → USDC ──
  console.log("Executing LEG2: HOP→USDC...");
  const sell2 = raydium.cpmm.computeSwapAmount({
    pool: computePoolInfo2,
    amountIn: hopAvailBN,
    outputMint: poolInfo.mintA.address,
    slippage: slippagePct,
    swapBaseIn: false,
  });

  const { execute: sellExec } = await raydium.cpmm.swap({
    poolInfo,
    poolKeys,
    baseIn: false,
    inputAmount: hopAvailBN,
    swapResult: sell2.swapResult,
    slippage: slippagePct,
    txVersion: 0,
  });
  const { txId: sellTxId } = await sellExec({ sendAndConfirm: true });
  console.log(`LEG2 TX: ${sellTxId}`);
  receipt.sellTxId = sellTxId;

  const usdcBackActual = Number(sell2.amountOut) / 10 ** USDC_DECIMALS;
  const netActual = usdcBackActual - swapUsdcUi;

  console.log();
  console.log(`Round trip: $${swapUsdcUi} → ${hopAvailUi.toFixed(4)} HOP → $${usdcBackActual.toFixed(4)} USDC`);
  console.log(`Net: ${netActual >= 0 ? "+" : ""}$${netActual.toFixed(4)} USDC`);
  console.log(`LP fees: ~$${lpFeesUsd.toFixed(4)} | T22 withheld: ~$${t22ValueUsd.toFixed(4)}`);

  receipt.verdict = "EXECUTED";
  receipt.usdcBackUi = usdcBackActual;
  receipt.netRoundTrip = netActual;
  writeReceipt("volume-bot", receipt);
}

main().catch(e => { console.error(e); process.exitCode = 1; });
