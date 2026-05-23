/**
 * Remove all LP liquidity from HOP/USDC CPMM pool.
 * Recovers: ~500 USDC + ~5M HOP (if no prior sells into pool).
 * If ataA was already sold into pool first: recovers remaining USDC.
 *
 * Pool: EwoZHyXz48vZL1TwkpQoq31brW4G4NDwmMr1DMw6qqBV
 * Crank owns 100% of LP.
 *
 * ENV:
 *   SOLANA_RPC_URL
 *   DRY_RUN=true|false (default true)
 *   ALLOW_LIVE=true (required to send)
 *   REMOVE_PCT=100  (% of LP to remove, default 100)
 */
import "dotenv/config";
import fs from "node:fs";
import {
  Connection, Keypair, PublicKey,
} from "@solana/web3.js";
import {
  TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID,
  getAssociatedTokenAddressSync,
} from "@solana/spl-token";
import { writeReceipt } from "../utils/receipt.js";

const POOL_ID = new PublicKey("EwoZHyXz48vZL1TwkpQoq31brW4G4NDwmMr1DMw6qqBV");
const HOP_MINT = new PublicKey("HZF5k7h39hkysoSZ4ZfmWc55PhvW7ntVvVqdXFCyYGh3");
const USDC_MINT = new PublicKey("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v");
const HOP_DECIMALS = 6;
const USDC_DECIMALS = 6;

function loadKeypair(p: string) {
  return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(p, "utf8")) as number[]));
}

async function main() {
  const rpc = process.env.SOLANA_RPC_URL || "https://api.mainnet-beta.solana.com";
  const dryRun = process.env.DRY_RUN !== "false";
  const allowLive = process.env.ALLOW_LIVE === "true";
  const removePct = Number(process.env.REMOVE_PCT || "100");
  const slippageBps = Number(process.env.SLIPPAGE_BPS || "100");

  const conn = new Connection(rpc, "confirmed");
  const crank = loadKeypair("keys/crank.json");

  console.log("=== REMOVE HOP/USDC LP ===");
  console.log(`Crank:    ${crank.publicKey.toBase58()}`);
  console.log(`Pool:     ${POOL_ID.toBase58()}`);
  console.log(`Remove:   ${removePct}%`);
  console.log(`Dry run:  ${dryRun}`);
  console.log();

  // Load Raydium SDK
  let sdk: any;
  try {
    sdk = await import("@raydium-io/raydium-sdk-v2" as string);
  } catch {
    console.error("Missing SDK. Install: npm install @raydium-io/raydium-sdk-v2");
    process.exitCode = 1;
    return;
  }

  const { Raydium, CREATE_CPMM_POOL_PROGRAM, Percent } = sdk;
  const BNModule = await import("bn.js");
  const BN = BNModule.default ?? BNModule;

  const raydium = await Raydium.load({
    connection: conn,
    owner: crank,
    disableFeatureCheck: true,
  });

  // Fetch pool info
  const info = await raydium.cpmm.getPoolInfoFromRpc(POOL_ID.toBase58());
  if (!info) {
    console.error("Pool not found:", POOL_ID.toBase58());
    process.exitCode = 1;
    return;
  }

  const { poolInfo: poolData, poolKeys } = info;
  const lpMint = poolData.lpMint;

  // Get LP token balance
  const lpAta = getAssociatedTokenAddressSync(
    new PublicKey(lpMint.address),
    crank.publicKey,
    false,
    TOKEN_PROGRAM_ID
  );

  const lpAcct = await conn.getTokenAccountBalance(lpAta);
  const lpBalanceRaw = BigInt(lpAcct.value.amount);
  const lpBalanceUi = lpAcct.value.uiAmount ?? 0;

  if (lpBalanceRaw === 0n) {
    console.log("LP balance = 0. Nothing to remove.");
    writeReceipt("remove-hop-liquidity", { verdict: "NO_LP", lpBalanceUi: 0 });
    return;
  }

  const removeAmount = new BN(
    (lpBalanceRaw * BigInt(removePct) / 100n).toString()
  );

  console.log(`LP balance: ${lpBalanceUi.toFixed(6)} LP tokens`);
  console.log(`Removing:   ${(Number(removeAmount.toString()) / 1e9).toFixed(6)} LP (${removePct}%)`);

  // Estimate output — vaultAAmount is USDC (mintA)
  const vaultUsdcRaw = poolData.vaultAAmount ?? poolData.baseReserve ?? new BN(0);
  const totalLp = poolData.lpAmount ?? new BN(lpBalanceRaw.toString());
  const pct = Number(removeAmount.toString()) / Number(totalLp.toString());
  const estUsdc = pct * (Number(vaultUsdcRaw.toString()) / 10 ** USDC_DECIMALS);
  console.log(`Est. USDC out: ~$${estUsdc.toFixed(2)}`);
  console.log();

  const { execute } = await raydium.cpmm.withdrawLiquidity({
    poolInfo: poolData,
    poolKeys,
    lpAmount: removeAmount,
    slippage: new Percent(new BN(slippageBps), new BN(10000)),
    txVersion: 0,
  });

  const receipt: Record<string, unknown> = {
    verdict: "",
    poolId: POOL_ID.toBase58(),
    lpRemoved: removeAmount.toString(),
    removePct,
    estUsdcOut: estUsdc,
    dryRun,
    signature: null as string | null,
  };

  if (dryRun || !allowLive) {
    console.log("DRY_RUN — set DRY_RUN=false ALLOW_LIVE=true to execute.");
    receipt.verdict = "DRY_RUN";
    writeReceipt("remove-hop-liquidity", receipt);
    return;
  }

  const { txId } = await execute({ sendAndConfirm: true });

  receipt.verdict = "EXECUTED";
  receipt.signature = txId;

  console.log(`EXECUTED: ${txId}`);
  console.log(`LP removed. Check wallet for USDC + HOP.`);

  writeReceipt("remove-hop-liquidity", receipt);
}

main().catch(e => { console.error(e); process.exitCode = 1; });
