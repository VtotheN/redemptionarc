import "dotenv/config";

const BCC = "HDaPAGVzD9kBEB4iTrNewuk9wrz58J8fXMs9Q3U31u5N";
const USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const SOL = "So11111111111111111111111111111111111111112";

async function quote(inputMint: string, outputMint: string, amount: string) {
  const url = new URL("https://api.jup.ag/swap/v1/quote");
  url.searchParams.set("inputMint", inputMint);
  url.searchParams.set("outputMint", outputMint);
  url.searchParams.set("amount", amount);
  url.searchParams.set("slippageBps", "200");
  const res = await fetch(url, { headers: { Accept: "application/json" } });
  if (!res.ok) return { ok: false, status: res.status, body: await res.text() };
  const body = await res.json() as any;
  return { ok: true, outAmount: body.outAmount, priceImpact: body.priceImpactPct, routeLabels: body.routePlan?.map((r: any) => r.swapInfo?.label) };
}

async function main() {
  const tests = [
    { input: BCC, output: USDC, amount: "1000000", label: "1 BCC -> USDC" },
    { input: BCC, output: SOL, amount: "1000000", label: "1 BCC -> SOL" },
    { input: USDC, output: BCC, amount: "10000", label: "0.01 USDC -> BCC" },
    { input: USDC, output: BCC, amount: "1000000", label: "1 USDC -> BCC" },
    { input: SOL, output: BCC, amount: "10000000", label: "0.01 SOL -> BCC" },
    { input: SOL, output: BCC, amount: "100000000", label: "0.1 SOL -> BCC" },
    { input: BCC, output: SOL, amount: "10000000", label: "10 BCC -> SOL" },
  ];
  
  for (const t of tests) {
    const r = await quote(t.input, t.output, t.amount);
    console.log(t.label, r.ok ? `out=${r.outAmount} impact=${r.priceImpact} routes=${r.routeLabels?.join(",")}` : `FAIL status=${r.status}`);
    await new Promise(res => setTimeout(res, 300));
  }
}
main().catch(console.error);
