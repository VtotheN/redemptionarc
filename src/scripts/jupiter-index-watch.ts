/**
 * Read-only Jupiter route/index watcher for a mint.
 *
 * It never builds or sends swaps. It only asks Jupiter quote endpoints whether
 * routes exist between the target mint and SOL/USDC.
 */
import { writeReceipt } from "../utils/receipt.js";

const SOL_MINT = "So11111111111111111111111111111111111111112";
const USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const DEFAULT_TOKEN_MINT = "Bzkdz5AKApsqizBxzqMUqWGJbx4gHXVC6NJekmAY8Gq3";

type QuoteResult = {
  baseUrl: string;
  inputMint: string;
  outputMint: string;
  amount: string;
  ok: boolean;
  routeFound: boolean;
  status: number | null;
  error: unknown;
  routeSummary: unknown;
};

async function quote(args: {
  baseUrl: string;
  inputMint: string;
  outputMint: string;
  amount: string;
  apiKey: string | null;
}): Promise<QuoteResult> {
  const url = new URL(args.baseUrl);
  url.searchParams.set("inputMint", args.inputMint);
  url.searchParams.set("outputMint", args.outputMint);
  url.searchParams.set("amount", args.amount);
  url.searchParams.set("slippageBps", process.env.JUP_SLIPPAGE_BPS || "100");
  const headers: Record<string, string> = {};
  if (args.apiKey) headers["x-api-key"] = args.apiKey;

  try {
    const response = await fetch(url, { headers });
    const body = await response.json().catch(() => null);
    const routePlan = Array.isArray(body?.routePlan) ? body.routePlan : [];
    return {
      baseUrl: args.baseUrl,
      inputMint: args.inputMint,
      outputMint: args.outputMint,
      amount: args.amount,
      ok: response.ok,
      routeFound: response.ok && routePlan.length > 0,
      status: response.status,
      error: response.ok ? null : body,
      routeSummary: response.ok ? {
        outAmount: body?.outAmount ?? null,
        priceImpactPct: body?.priceImpactPct ?? null,
        routePlan: routePlan.map((leg: any) => ({
          label: leg.swapInfo?.label ?? null,
          ammKey: leg.swapInfo?.ammKey ?? null,
          inputMint: leg.swapInfo?.inputMint ?? null,
          outputMint: leg.swapInfo?.outputMint ?? null,
          percent: leg.percent ?? null,
          bps: leg.bps ?? null,
        })),
      } : null,
    };
  } catch (error) {
    return {
      baseUrl: args.baseUrl,
      inputMint: args.inputMint,
      outputMint: args.outputMint,
      amount: args.amount,
      ok: false,
      routeFound: false,
      status: null,
      error: error instanceof Error ? { message: error.message } : String(error),
      routeSummary: null,
    };
  }
}

async function main() {
  const tokenMint = process.env.TOKEN_MINT || DEFAULT_TOKEN_MINT;
  const amountRaw = process.env.QUOTE_AMOUNT_RAW || "1000000";
  const solAmountRaw = process.env.SOL_QUOTE_AMOUNT_RAW || "1000000";
  const usdcAmountRaw = process.env.USDC_QUOTE_AMOUNT_RAW || "1000000";
  const apiKey = process.env.JUP_API_KEY || null;
  const baseUrls = (process.env.JUP_QUOTE_URLS ||
    "https://api.jup.ag/swap/v1/quote,https://lite-api.jup.ag/swap/v1/quote")
    .split(",")
    .map((x) => x.trim())
    .filter(Boolean);

  const pairs = [
    { inputMint: tokenMint, outputMint: SOL_MINT, amount: amountRaw },
    { inputMint: tokenMint, outputMint: USDC_MINT, amount: amountRaw },
    { inputMint: SOL_MINT, outputMint: tokenMint, amount: solAmountRaw },
    { inputMint: USDC_MINT, outputMint: tokenMint, amount: usdcAmountRaw },
  ];

  const results: QuoteResult[] = [];
  for (const baseUrl of baseUrls) {
    for (const pair of pairs) {
      results.push(await quote({ baseUrl, apiKey, ...pair }));
    }
  }

  const routeFound = results.some((result) => result.routeFound);
  const receipt = {
    verdict: routeFound ? "JUPITER_ROUTE_FOUND_READ_ONLY" : "JUPITER_NO_ROUTE_FOUND_READ_ONLY",
    generatedAt: new Date().toISOString(),
    readOnly: true,
    tokenMint,
    amountRaw,
    apiKeyProvided: Boolean(apiKey),
    results,
    next: routeFound
      ? "Route exists. Inspect routeSummary and only trade with explicit cash-settlement approval."
      : "No Jupiter route yet. Wait for DEX liquidity/indexing or use a different legitimate settlement path.",
  };

  const out = writeReceipt("JUPITER-INDEX-WATCH-LATEST.json", receipt);
  console.log(`${receipt.verdict} mint=${tokenMint} routeFound=${routeFound} receipt=${out}`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
