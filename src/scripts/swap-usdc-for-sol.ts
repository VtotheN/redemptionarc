/**
 * Swap USDC → SOL via Jupiter v1, using crank wallet.
 * ENV: USDC_AMOUNT (micro-USDC, default 120000000 = 120 USDC), DRY_RUN, ALLOW_LIVE
 */
import "dotenv/config";
import fs from "node:fs";
import { Connection, Keypair, VersionedTransaction, LAMPORTS_PER_SOL } from "@solana/web3.js";

const SOL_MINT  = "So11111111111111111111111111111111111111112";
const USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const JUP_QUOTE = "https://api.jup.ag/swap/v1/quote";
const JUP_SWAP  = "https://api.jup.ag/swap/v1/swap";

function loadKeypair(p: string): Keypair {
  return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(p, "utf8"))));
}

async function main() {
  const rpc       = process.env.SOLANA_RPC_URL || process.env.RPC_URL || "https://api.mainnet-beta.solana.com";
  const dryRun    = process.env.DRY_RUN !== "false";
  const allowLive = process.env.ALLOW_LIVE === "true";
  const usdcMicro = Number(process.env.USDC_AMOUNT ?? "120000000");

  const conn  = new Connection(rpc, "confirmed");
  const crank = loadKeypair("keys/crank.json");

  console.log(`Crank: ${crank.publicKey.toBase58()}`);
  console.log(`Swap:  ${usdcMicro / 1e6} USDC → SOL`);

  // 1. Quote
  const quoteUrl = `${JUP_QUOTE}?inputMint=${USDC_MINT}&outputMint=${SOL_MINT}&amount=${usdcMicro}&slippageBps=50&onlyDirectRoutes=false`;
  const quoteRes = await fetch(quoteUrl);
  if (!quoteRes.ok) throw new Error(`Jupiter quote failed: ${quoteRes.status} ${await quoteRes.text()}`);
  const quote = await quoteRes.json() as Record<string, unknown>;

  const outLamports = Number(quote.outAmount as string);
  const outSol      = outLamports / LAMPORTS_PER_SOL;
  const priceImpact = quote.priceImpactPct as string;
  console.log(`Quote: ${usdcMicro / 1e6} USDC → ~${outSol.toFixed(6)} SOL (impact: ${priceImpact}%)`);

  if (dryRun || !allowLive) {
    console.log(`DRY_RUN — set DRY_RUN=false ALLOW_LIVE=true to execute`);
    return;
  }

  // 2. Build swap tx
  const swapRes = await fetch(JUP_SWAP, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      quoteResponse: quote,
      userPublicKey: crank.publicKey.toBase58(),
      wrapAndUnwrapSol: true,
      dynamicComputeUnitLimit: true,
      prioritizationFeeLamports: 1000,
    }),
  });
  if (!swapRes.ok) throw new Error(`Jupiter swap build failed: ${swapRes.status} ${await swapRes.text()}`);
  const swapData = await swapRes.json() as { swapTransaction: string };

  // 3. Sign and send
  const txBytes = Buffer.from(swapData.swapTransaction, "base64");
  const vtx = VersionedTransaction.deserialize(txBytes);
  vtx.sign([crank]);

  const sig = await conn.sendRawTransaction(vtx.serialize(), { skipPreflight: false, maxRetries: 3 });
  console.log(`TX sent: ${sig}`);
  console.log("Confirming...");

  const conf = await conn.confirmTransaction(sig, "confirmed");
  if (conf.value.err) throw new Error(`TX failed: ${JSON.stringify(conf.value.err)}`);

  const solAfter  = await conn.getBalance(crank.publicKey, "confirmed");
  console.log(`\n=== SWAP CONFIRMED ===`);
  console.log(`TX sig:          ${sig}`);
  console.log(`SOL received:    ~${outSol.toFixed(6)} SOL`);
  console.log(`SOL balance now: ${(solAfter / LAMPORTS_PER_SOL).toFixed(9)} SOL`);
}

main().catch(e => { console.error(e); process.exitCode = 1; });
