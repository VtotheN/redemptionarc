import "dotenv/config";
import dotenv from "dotenv";
import { loadConfig } from "../config.js";
import { writeReceipt } from "../utils/receipt.js";

if (process.env.ENV_PATH) {
  dotenv.config({ path: process.env.ENV_PATH, override: true });
}

async function tryQuote(baseUrl: string, inputMint: string, outputMint: string, amount: string) {
  const url = `${baseUrl}/quote?inputMint=${inputMint}&outputMint=${outputMint}&amount=${amount}&slippageBps=100`;
  try {
    const response = await fetch(url, { headers: { accept: "application/json" } });
    const text = await response.text();
    let json: unknown = null;
    try {
      json = JSON.parse(text);
    } catch {
      json = { raw: text.slice(0, 500) };
    }
    return { baseUrl, amount, ok: response.ok, status: response.status, json };
  } catch (error) {
    return {
      baseUrl,
      amount,
      ok: false,
      status: 0,
      json: { error: error instanceof Error ? error.message : String(error) }
    };
  }
}

async function main() {
  const config = loadConfig();
  const inputMint = config.hopMint.toBase58();
  const outputMint = config.usdcMint.toBase58();
  const amounts = (process.env.SETTLEMENT_SCAN_AMOUNTS || "1000000,10000000,100000000,1000000000")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
  const baseUrls = [
    "https://api.jup.ag/swap/v1",
    "https://lite-api.jup.ag/swap/v1"
  ];

  const results = [];
  for (const baseUrl of baseUrls) {
    for (const amount of amounts) {
      results.push(await tryQuote(baseUrl, inputMint, outputMint, amount));
    }
  }

  const ready = results.some((result) => result.ok && !(result.json as any)?.error);
  const tokenNotTradable = results.some((result) => String(JSON.stringify(result.json)).includes("TOKEN_NOT_TRADABLE"));
  const verdict = ready
    ? "SETTLEMENT_ROUTE_READY_JUPITER"
    : tokenNotTradable
      ? "SETTLEMENT_ROUTE_BLOCKED_TOKEN_NOT_TRADABLE"
      : "SETTLEMENT_ROUTE_BLOCKED_NO_QUOTE";

  const receipt = {
    verdict,
    generatedAt: new Date().toISOString(),
    inputMint,
    outputMint,
    amounts,
    results,
    conclusion: ready
      ? "Jupiter can quote HOP to USDC; next step is swap-instruction simulation."
      : "HOP cannot currently be treated as cash. Need owned pool/venue route, direct market creation, or a different cash-settled source."
  };

  const out = writeReceipt("REDEMPTION-SETTLEMENT-ROUTE-SCAN-LATEST.json", receipt);
  console.log(`${verdict} receipt=${out}`);
  if (!ready) process.exitCode = 1;
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
