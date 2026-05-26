/**
 * Buy HOP from old Raydium CPMM pool using USDC.
 * Old pool EwoZHy: ~94M HOP + ~$0.40 USDC — essentially free HOP.
 * Even $2 USDC → ~67M HOP at current imbalance.
 *
 * ENV:
 *   SOLANA_RPC_URL
 *   DRY_RUN=true|false (default true)
 *   ALLOW_LIVE=true
 *   BUY_USDC=2          (USDC to spend, default $2)
 *   SLIPPAGE=0.99       (99% slippage — pool is severely unbalanced)
 *   BUY_POOL            (pool address, default old HOP/USDC pool)
 */
import "dotenv/config";
import fs from "node:fs";
import { Connection, Keypair, PublicKey } from "@solana/web3.js";
import { writeReceipt } from "../utils/receipt.js";

const OLD_POOL = "EwoZHyXz48vZL1TwkpQoq31brW4G4NDwmMr1DMw6qqBV";
const HOP_MINT = "HZF5k7h39hkysoSZ4ZfmWc55PhvW7ntVvVqdXFCyYGh3";

function loadKeypair(p: string) {
  return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(p, "utf8")) as number[]));
}

async function main() {
  const rpc = process.env.SOLANA_RPC_URL || "https://api.mainnet-beta.solana.com";
  const dryRun = process.env.DRY_RUN !== "false";
  const allowLive = process.env.ALLOW_LIVE === "true";
  const buyUsdc = Number(process.env.BUY_USDC || "2");
  const slippage = Number(process.env.SLIPPAGE || "0.99");
  const poolAddr = process.env.BUY_POOL || OLD_POOL;

  const conn = new Connection(rpc, "confirmed");
  const crank = loadKeypair("keys/crank.json");

  const BNModule = await import("bn.js");
  const BN = BNModule.default ?? BNModule;

  const { Raydium } = await import("@raydium-io/raydium-sdk-v2");
  const raydium = await Raydium.load({ connection: conn, owner: crank, disableFeatureCheck: true });

  console.log(`Fetching pool: ${poolAddr}`);
  const { poolInfo, poolKeys, computePoolInfo } = await raydium.cpmm.getPoolInfoFromRpc(poolAddr);

  const mintAAddr = poolInfo.mintA.address;
  const mintBAddr = poolInfo.mintB.address;
  console.log(`mintA=${mintAAddr} mintB=${mintBAddr}`);

  // Pool: mintA=USDC, mintB=HOP. We put USDC in (baseIn=true), get HOP out.
  const baseIn = true;
  const inputAmountRaw = Math.round(buyUsdc * 1e6);
  const inputBN = new BN(inputAmountRaw);

  // Step 1: compute expected output (slippage=0 here, applied in swap call)
  const computed = raydium.cpmm.computeSwapAmount({
    pool: computePoolInfo,
    amountIn: inputBN,
    outputMint: new PublicKey(HOP_MINT),
    slippage: 0,
  });

  const hopOut = Number(computed.amountOut) / 1e6;
  const priceImpact = computed.priceImpact.toFixed(4);
  console.log(`${buyUsdc} USDC → ~${hopOut.toFixed(2)} HOP (impact: ${priceImpact}%)`);

  if (dryRun || !allowLive) {
    writeReceipt("buy-hop", {
      verdict: "DRY_RUN",
      poolAddr,
      buyUsdc,
      estimatedHopOut: hopOut,
      priceImpactPct: priceImpact,
      slippage,
    });
    console.log("DRY_RUN — set DRY_RUN=false ALLOW_LIVE=true to execute");
    return;
  }

  // Step 2: build + send swap (slippage applied to minAmountOut inside swap)
  const { execute } = await raydium.cpmm.swap({
    poolInfo,
    poolKeys,
    baseIn,
    inputAmount: inputBN,
    swapResult: computed.swapResult,
    slippage,
    txVersion: 0 as const,
  });

  const { txId } = await execute({ sendAndConfirm: true });
  console.log(`EXECUTED: ${txId}`);
  console.log(`Bought ~${hopOut.toFixed(2)} HOP for ${buyUsdc} USDC`);

  writeReceipt("buy-hop", {
    verdict: "EXECUTED",
    txId,
    poolAddr,
    buyUsdc,
    estimatedHopOut: hopOut,
    priceImpactPct: priceImpact,
    slippage,
  });
}

main().catch(e => { console.error(e); process.exitCode = 1; });
