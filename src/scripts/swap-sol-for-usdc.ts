/**
 * Swap SOL → USDC via Jupiter v6, using crank wallet.
 * ENV: SOL_LAMPORTS (default 3_500_000_000), DRY_RUN, ALLOW_LIVE, LIVE_TX_APPROVED
 */
import "dotenv/config";
import fs from "node:fs";
import { Connection, Keypair, VersionedTransaction } from "@solana/web3.js";
import { loadConfig } from "../config.js";
import { connectionFor } from "../utils/rpc.js";
import { writeReceipt } from "../utils/receipt.js";
import { assertKeypairMatches, loadKeypair } from "../utils/keypair.js";
import { assertLiveAllowed, assertNoForbiddenConfigured } from "../utils/safety.js";

const SOL_MINT  = "So11111111111111111111111111111111111111112";
const USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const JUP_QUOTE = "https://api.jup.ag/swap/v1/quote";
const JUP_SWAP  = "https://api.jup.ag/swap/v1/swap";

async function main() {
  const config = loadConfig();
  assertNoForbiddenConfigured(config);
  assertLiveAllowed(config);
  if (!config.crank) throw new Error("Missing REDEMPTION_CRANK");

  const connection = connectionFor(config.rpcUrl);
  const funder = loadKeypair("keys/crank.json");
  assertKeypairMatches("crank", funder, config.crank);

  const lamports = Number(process.env.SOL_LAMPORTS ?? "3500000000");

  // 1. Quote
  const quoteUrl = `${JUP_QUOTE}?inputMint=${SOL_MINT}&outputMint=${USDC_MINT}&amount=${lamports}&slippageBps=50&onlyDirectRoutes=false`;
  const quoteRes = await fetch(quoteUrl);
  if (!quoteRes.ok) throw new Error(`Jupiter quote failed: ${quoteRes.status} ${await quoteRes.text()}`);
  const quote = await quoteRes.json() as Record<string, unknown>;

  const outAmount = Number(quote.outAmount as string) / 1e6;
  console.log(`Quote: ${lamports / 1e9} SOL → ~${outAmount.toFixed(2)} USDC`);

  const receipt: Record<string, unknown> = {
    verdict: "SWAP_PLAN",
    dryRun: config.dryRun,
    inputSolLamports: lamports,
    quotedUsdcUi: outAmount,
  };

  if (config.dryRun) {
    receipt.verdict = "SWAP_DRY_RUN";
    writeReceipt("REDEMPTION-SWAP-SOL-USDC.json", receipt);
    console.log(`SWAP_DRY_RUN quoted_usdc=${outAmount.toFixed(2)}`);
    return;
  }

  // 2. Build swap tx
  const swapRes = await fetch(JUP_SWAP, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      quoteResponse: quote,
      userPublicKey: funder.publicKey.toBase58(),
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
  vtx.sign([funder]);

  const sig = await connection.sendRawTransaction(vtx.serialize(), {
    skipPreflight: false,
    maxRetries: 3,
  });
  console.log(`SWAP_SENT sig=${sig}`);

  const conf = await connection.confirmTransaction(sig, "confirmed");
  if (conf.value.err) throw new Error(`Swap TX failed: ${JSON.stringify(conf.value.err)}`);

  receipt.verdict = "SWAP_CONFIRMED";
  receipt.signature = sig;
  receipt.receivedUsdcUi = outAmount;
  writeReceipt("REDEMPTION-SWAP-SOL-USDC.json", receipt);
  console.log(`SWAP_CONFIRMED sig=${sig} usdc≈${outAmount.toFixed(2)}`);
}

main().catch((e) => { console.error(e); process.exitCode = 1; });
