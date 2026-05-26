/**
 * Sell accumulated HOP fees → USDC via Jupiter.
 * Run periodically (after keeper-loop accumulates enough HOP).
 *
 * ENV:
 *   SOLANA_RPC_URL
 *   DRY_RUN=true|false (default true)
 *   ALLOW_LIVE=true (required to send)
 *   SELL_HOP_AMOUNT=0          (0 = sell all withheld; else exact units)
 *   SELL_HOP_MIN_USD=1.0       (skip if Jupiter quote < this)
 *   SLIPPAGE_BPS=100
 *   JUPITER_API=https://lite-api.jup.ag/swap/v1
 *   PRIORITY_FEE_MICRO=1000
 */
import "dotenv/config";
import fs from "node:fs";
import {
  Connection, Keypair, PublicKey, VersionedTransaction,
  ComputeBudgetProgram, Transaction,
} from "@solana/web3.js";
import {
  TOKEN_2022_PROGRAM_ID,
  getAssociatedTokenAddressSync, getAccount, getMint, getTransferFeeConfig,
} from "@solana/spl-token";
import { writeReceipt } from "../utils/receipt.js";

const HOP_MINT = new PublicKey("HZF5k7h39hkysoSZ4ZfmWc55PhvW7ntVvVqdXFCyYGh3");
const USDC_MINT = new PublicKey("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v");
const HOP_DECIMALS = 6;
const USDC_DECIMALS = 6;

function loadKeypair(p: string) {
  return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(p, "utf8")) as number[]));
}

interface JupiterQuote {
  inputMint: string;
  inAmount: string;
  outputMint: string;
  outAmount: string;
  priceImpactPct: string;
  routePlan: Array<{ swapInfo: { label: string } }>;
}

interface JupiterSwapResponse {
  swapTransaction: string;
  lastValidBlockHeight: number;
}

async function getQuote(
  jupiterApi: string,
  inputMint: PublicKey,
  outputMint: PublicKey,
  amount: bigint,
  slippageBps: number
): Promise<JupiterQuote | null> {
  const url = `${jupiterApi}/quote?inputMint=${inputMint.toBase58()}&outputMint=${outputMint.toBase58()}&amount=${amount}&slippageBps=${slippageBps}&onlyDirectRoutes=false`;
  const resp = await fetch(url, { headers: { accept: "application/json" } });
  if (!resp.ok) {
    const text = await resp.text();
    console.log(`Jupiter quote error ${resp.status}: ${text.slice(0, 200)}`);
    return null;
  }
  const json = await resp.json();
  if ((json as { error?: string }).error) {
    console.log(`Jupiter quote rejected: ${(json as { error: string }).error}`);
    return null;
  }
  return json as JupiterQuote;
}

async function getSwapTx(
  jupiterApi: string,
  quote: JupiterQuote,
  userPubkey: PublicKey,
  priorityFeeMicro: number
): Promise<string | null> {
  const resp = await fetch(`${jupiterApi}/swap`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      quoteResponse: quote,
      userPublicKey: userPubkey.toBase58(),
      wrapAndUnwrapSol: true,
      prioritizationFeeLamports: { priorityLevelWithMaxLamports: { maxLamports: priorityFeeMicro, priorityLevel: "medium" } },
      dynamicComputeUnitLimit: true,
    })
  });
  if (!resp.ok) {
    const text = await resp.text();
    console.log(`Jupiter swap error ${resp.status}: ${text.slice(0, 200)}`);
    return null;
  }
  const json = await resp.json() as JupiterSwapResponse;
  return json.swapTransaction;
}

async function main() {
  const rpc = process.env.SOLANA_RPC_URL || "https://api.mainnet-beta.solana.com";
  const dryRun = process.env.DRY_RUN !== "false";
  const allowLive = process.env.ALLOW_LIVE === "true";
  const slippageBps = Number(process.env.SLIPPAGE_BPS || "100");
  const minUsd = Number(process.env.SELL_HOP_MIN_USD || "1.0");
  const jupiterApi = process.env.JUPITER_API || "https://lite-api.jup.ag/swap/v1";
  const priorityFeeMicro = Number(process.env.PRIORITY_FEE_MICRO || "1000");

  const conn = new Connection(rpc, "confirmed");
  const crank = loadKeypair("keys/crank.json");
  const ataA = getAssociatedTokenAddressSync(HOP_MINT, crank.publicKey, false, TOKEN_2022_PROGRAM_ID);

  // Check ataA HOP balance
  const ataInfo = await getAccount(conn, ataA, "confirmed", TOKEN_2022_PROGRAM_ID);
  const hopBalance = Number(ataInfo.amount);
  const hopBalanceUi = hopBalance / 10 ** HOP_DECIMALS;

  // Read mint withheld amount (T22 TransferFeeConfig.withheldAmount)
  const mintInfo = await getMint(conn, HOP_MINT, "confirmed", TOKEN_2022_PROGRAM_ID);
  const feeConfig = getTransferFeeConfig(mintInfo);
  const mintWithheld = Number(feeConfig?.withheldAmount ?? 0n);
  const mintWithheldUi = mintWithheld / 10 ** HOP_DECIMALS;
  console.log(`Mint withheld: ${mintWithheldUi} HOP`);

  // Determine sell amount — ONLY sell withheld, NOT entire ataA balance
  const sellAmountRaw = process.env.SELL_HOP_AMOUNT
    ? Number(process.env.SELL_HOP_AMOUNT)
    : mintWithheld;

  if (sellAmountRaw <= 0) {
    console.log(`ataA: ${hopBalanceUi} HOP — nothing to sell`);
    process.exitCode = 0;
    return;
  }

  console.log(`ataA: ${hopBalanceUi} HOP | selling: ${(sellAmountRaw / 10 ** HOP_DECIMALS).toFixed(6)} HOP`);
  console.log(`Jupiter API: ${jupiterApi}`);

  // Get quote
  const quote = await getQuote(jupiterApi, HOP_MINT, USDC_MINT, BigInt(Math.floor(sellAmountRaw)), slippageBps);
  if (!quote) {
    const receipt = {
      verdict: "NO_ROUTE",
      hopBalanceUi,
      sellAmountUi: sellAmountRaw / 10 ** HOP_DECIMALS,
      conclusion: "HOP has no Jupiter route yet — seed a HOP/USDC pool first (run seed-hop-pool)",
    };
    writeReceipt("sell-hop-fees", receipt);
    console.log("NO_ROUTE — need HOP/USDC pool. Run: npm run seed-hop-pool");
    process.exitCode = 1;
    return;
  }

  const outUsdc = Number(quote.outAmount) / 10 ** USDC_DECIMALS;
  const priceImpact = Number(quote.priceImpactPct);
  const routes = quote.routePlan.map(r => r.swapInfo.label).join(" → ");

  console.log(`Quote: ${(sellAmountRaw / 10 ** HOP_DECIMALS).toFixed(6)} HOP → ${outUsdc.toFixed(6)} USDC`);
  console.log(`Route: ${routes}`);
  console.log(`Price impact: ${priceImpact.toFixed(4)}%`);

  if (outUsdc < minUsd) {
    console.log(`SKIP: quote $${outUsdc.toFixed(4)} < minUsd $${minUsd}`);
    const receipt = { verdict: "SKIPPED_BELOW_MIN", outUsdc, minUsd, hopBalanceUi };
    writeReceipt("sell-hop-fees", receipt);
    return;
  }

  // Get swap transaction
  const swapTxBase64 = await getSwapTx(jupiterApi, quote, crank.publicKey, priorityFeeMicro);
  if (!swapTxBase64) {
    writeReceipt("sell-hop-fees", { verdict: "SWAP_TX_FAILED", quote });
    process.exitCode = 1;
    return;
  }

  const swapTxBuf = Buffer.from(swapTxBase64, "base64");
  const swapTx = VersionedTransaction.deserialize(swapTxBuf);

  const receipt: Record<string, unknown> = {
    verdict: "",
    hopSold: sellAmountRaw / 10 ** HOP_DECIMALS,
    usdcOut: outUsdc,
    priceImpactPct: priceImpact,
    routes,
    dryRun,
    signature: null as string | null,
  };

  if (dryRun || !allowLive) {
    const sim = await conn.simulateTransaction(swapTx);
    receipt.verdict = sim.value.err ? "SIM_FAILED" : "SIM_OK";
    receipt.simErr = sim.value.err;
    receipt.simCu = sim.value.unitsConsumed;
    console.log(`SIM: ${receipt.verdict} cu=${receipt.simCu}`);
    if (sim.value.err) console.log("ERR:", JSON.stringify(sim.value.err));
  } else {
    swapTx.sign([crank]);
    const { blockhash, lastValidBlockHeight } = await conn.getLatestBlockhash();
    const sig = await conn.sendRawTransaction(swapTx.serialize(), {
      skipPreflight: false,
      maxRetries: 3,
    });
    await conn.confirmTransaction({ signature: sig, blockhash, lastValidBlockHeight }, "confirmed");
    receipt.verdict = "EXECUTED";
    receipt.signature = sig;
    console.log(`EXECUTED: ${sig}`);
    console.log(`Sold ${(sellAmountRaw / 10 ** HOP_DECIMALS).toFixed(6)} HOP → ${outUsdc.toFixed(6)} USDC`);
  }

  writeReceipt("sell-hop-fees", receipt);
}

main().catch(e => { console.error(e); process.exitCode = 1; });
