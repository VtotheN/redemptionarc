/**
 * Re-seed HOP/USDC CPMM pool (LP=0) — first deposit bypass.
 * computeResult param skips SDK's broken computePairAmount (div-by-zero when LP=0).
 *
 * Pool: EwoZHyXz48vZL1TwkpQoq31brW4G4NDwmMr1DMw6qqBV
 * ENV: SOLANA_RPC_URL, DRY_RUN, ALLOW_LIVE
 *      SEED_USDC=500        (USDC to deposit, default $500)
 *      SEED_HOP_UI=5000000  (HOP whole tokens, default 5M → $0.0001/HOP)
 */
import "dotenv/config";
import fs from "node:fs";
import { Connection, Keypair, PublicKey } from "@solana/web3.js";
import { writeReceipt } from "../utils/receipt.js";

const POOL_ID = new PublicKey("EwoZHyXz48vZL1TwkpQoq31brW4G4NDwmMr1DMw6qqBV");
const USDC_DECIMALS = 6;
const HOP_DECIMALS = 6;

function loadKeypair(p: string) {
  return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(p, "utf8")) as number[]));
}

async function main() {
  const rpc = process.env.SOLANA_RPC_URL || "https://api.mainnet-beta.solana.com";
  const dryRun = process.env.DRY_RUN !== "false";
  const allowLive = process.env.ALLOW_LIVE === "true";
  const seedUsdcUi = Number(process.env.SEED_USDC || "500");
  const seedHopUi = Number(process.env.SEED_HOP_UI || "5000000");

  const conn = new Connection(rpc, "confirmed");
  const crank = loadKeypair("keys/crank.json");

  const seedUsdcRaw = Math.round(seedUsdcUi * 10 ** USDC_DECIMALS);
  const seedHopRaw = Math.round(seedHopUi * 10 ** HOP_DECIMALS);
  const impliedPrice = seedUsdcUi / seedHopUi;

  console.log("=== RE-SEED HOP/USDC POOL ===");
  console.log(`Pool:      ${POOL_ID.toBase58()}`);
  console.log(`Crank:     ${crank.publicKey.toBase58()}`);
  console.log(`Seed USDC: $${seedUsdcUi}`);
  console.log(`Seed HOP:  ${seedHopUi.toLocaleString()}`);
  console.log(`Price:     $${impliedPrice.toFixed(8)}/HOP`);
  console.log(`Dry run:   ${dryRun}`);
  console.log();

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let sdk: any;
  try {
    sdk = await import("@raydium-io/raydium-sdk-v2" as string);
  } catch {
    console.error("Missing SDK: npm install @raydium-io/raydium-sdk-v2");
    process.exitCode = 1;
    return;
  }

  const { Raydium, Percent } = sdk;
  const BNModule = await import("bn.js");
  const BN = BNModule.default ?? BNModule;

  const raydium = await Raydium.load({ connection: conn, owner: crank, disableFeatureCheck: true });

  const info = await raydium.cpmm.getPoolInfoFromRpc(POOL_ID.toBase58());
  if (!info) {
    console.error("Pool not found:", POOL_ID.toBase58());
    process.exitCode = 1;
    return;
  }
  const { poolInfo, poolKeys } = info;

  const lpSupply = poolInfo.lpAmount?.toString() ?? "?";
  console.log(`LP supply: ${lpSupply}`);
  console.log(`mintA:     ${poolInfo.mintA.address} (${poolInfo.mintA.symbol})`);
  console.log(`mintB:     ${poolInfo.mintB.address} (${poolInfo.mintB.symbol})`);
  console.log();

  // mintA=USDC(base), mintB=HOP — deposit USDC as base side
  const usdcBN = new BN(seedUsdcRaw.toString());
  const hopBN = new BN(seedHopRaw.toString());

  // computeResult bypasses computePairAmount which divs by lpAmount (0 = crash)
  // liquidity=0 means min LP to receive = 0 (no slippage guard needed, we own all LP)
  const noFee = { amount: new BN(0), fee: undefined, expirationTime: undefined };
  const computeResult = {
    liquidity: new BN(0),
    inputAmountFee: { amount: usdcBN, fee: undefined, expirationTime: undefined },
    anotherAmount: { amount: hopBN, fee: undefined, expirationTime: undefined },
    maxAnotherAmount: { amount: hopBN, fee: undefined, expirationTime: undefined },
  };
  void noFee;

  const { execute } = await raydium.cpmm.addLiquidity({
    poolInfo,
    poolKeys,
    inputAmount: usdcBN,
    baseIn: true,
    slippage: new Percent(new BN(0), new BN(1)),
    computeResult,
    txVersion: 0,
  });

  const receipt: Record<string, unknown> = {
    verdict: "",
    poolId: POOL_ID.toBase58(),
    seedUsdcUi,
    seedHopUi,
    impliedPriceUsd: impliedPrice,
    dryRun,
    signature: null as string | null,
  };

  if (dryRun || !allowLive) {
    console.log("DRY_RUN — set DRY_RUN=false ALLOW_LIVE=true to execute.");
    receipt.verdict = "DRY_RUN";
    writeReceipt("add-hop-liquidity", receipt);
    return;
  }

  const { txId } = await execute({ sendAndConfirm: true });
  receipt.verdict = "EXECUTED";
  receipt.signature = txId;
  console.log(`EXECUTED: ${txId}`);
  console.log(`Pool re-seeded. Jupiter re-indexes in ~30 min.`);
  writeReceipt("add-hop-liquidity", receipt);
}

main().catch(e => { console.error(e); process.exitCode = 1; });
