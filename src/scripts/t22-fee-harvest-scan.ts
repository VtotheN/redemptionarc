/**
 * T22 Fee-Harvest Candidate Scanner (Broad Sweep)
 *
 * Uses CoinGecko's full coin list (5699+ Solana tokens) and batch-checks
 * all of them on-chain for Token-2022 + TransferFeeConfig + low fees.
 * Only the survivors hit Jupiter for liquidity validation.
 */
import "dotenv/config";
import { PublicKey, AccountInfo } from "@solana/web3.js";
import { unpackMint, getTransferFeeConfig, TOKEN_2022_PROGRAM_ID } from "@solana/spl-token";
import { connectionFor } from "../utils/rpc.js";
import { writeReceipt } from "../utils/receipt.js";

const SOL_MINT = "So11111111111111111111111111111111111111112";
const USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const MAX_FEE_BPS = 100;

const RPC_URL = process.env.SOLANA_RPC_URL || "https://api.mainnet-beta.solana.com";

interface Candidate {
  mint: string;
  name: string;
  symbol: string;
  decimals: number;
  feeBps: number;
  maximumFeeRaw: string;
  maximumFeeUi: number;
  transferFeeConfigAuthority: string | null;
  withdrawWithheldAuthority: string | null;
  feeConfigMutable: boolean;
  jupiterRouteToUsdc: boolean;
  jupiterRouteToSol: boolean;
  jupiterRouteFromUsdc: boolean;
  jupiterRouteFromSol: boolean;
  jupiterOutAmountUsdcToMint?: string;
  jupiterOutAmountSolToMint?: string;
  tags: string[];
  score: number;
  notes: string[];
}

async function fetchCoinGeckoList(): Promise<Map<string, { name: string; symbol: string; address: string }>> {
  const map = new Map<string, { name: string; symbol: string; address: string }>();
  try {
    const res = await fetch("https://api.coingecko.com/api/v3/coins/list?include_platform=true", {
      headers: { Accept: "application/json" }
    });
    if (!res.ok) return map;
    const data = await res.json() as Array<{ id: string; name: string; symbol: string; platforms: Record<string, string> }>;
    for (const item of data) {
      const addr = item.platforms?.solana;
      if (addr) {
        map.set(addr, { name: item.name, symbol: item.symbol.toUpperCase(), address: addr });
      }
    }
  } catch {
    // ignore
  }
  return map;
}

async function jupiterQuoteExists(inputMint: string, outputMint: string, amount: string): Promise<{ exists: boolean; outAmount?: string }> {
  try {
    const url = new URL("https://api.jup.ag/swap/v1/quote");
    url.searchParams.set("inputMint", inputMint);
    url.searchParams.set("outputMint", outputMint);
    url.searchParams.set("amount", amount);
    url.searchParams.set("slippageBps", "200");
    const res = await fetch(url, { headers: { Accept: "application/json" } });
    if (!res.ok) return { exists: false };
    const body = await res.json() as { routePlan?: unknown[]; outAmount?: string };
    const exists = Array.isArray(body.routePlan) && body.routePlan.length > 0;
    return { exists, outAmount: body.outAmount };
  } catch {
    return { exists: false };
  }
}

function scoreCandidate(c: Candidate): number {
  let s = 0;
  if (c.feeBps <= 10) s += 40;
  else if (c.feeBps <= 50) s += 25;
  else if (c.feeBps <= 100) s += 10;
  if (c.feeConfigMutable) s += 30;
  const routeCount = [c.jupiterRouteFromUsdc, c.jupiterRouteFromSol, c.jupiterRouteToUsdc, c.jupiterRouteToSol].filter(Boolean).length;
  s += routeCount * 10;
  return s;
}

async function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function main() {
  const connection = connectionFor(RPC_URL);
  const warnings: string[] = [];

  console.log("Fetching CoinGecko full list...");
  const cgList = await fetchCoinGeckoList();
  console.log(`CoinGecko solana addresses: ${cgList.size}`);

  const candidateAddrs = [...cgList.keys()];
  const accountInfos = new Map<string, AccountInfo<Buffer> | null>();
  const isT22 = new Map<string, boolean>();

  console.log("Batch-fetching account infos...");
  for (let i = 0; i < candidateAddrs.length; i += 100) {
    const chunk = candidateAddrs.slice(i, i + 100);
    const pks = chunk.map((a) => new PublicKey(a));
    try {
      const infos = await connection.getMultipleAccountsInfo(pks, "confirmed");
      infos.forEach((info, idx) => {
        const addr = chunk[idx];
        accountInfos.set(addr, info ?? null);
        isT22.set(addr, info ? info.owner.equals(TOKEN_2022_PROGRAM_ID) : false);
      });
    } catch (error) {
      warnings.push(`batchAccountInfo chunk ${i} error=${error instanceof Error ? error.message : String(error)}`);
      for (const addr of chunk) isT22.set(addr, false);
    }
    if ((i + 1) % 1000 === 0) console.log(`  fetched ${i + 1}/${candidateAddrs.length}`);
  }

  const t22Addrs = candidateAddrs.filter((a) => isT22.get(a));
  console.log(`T22 mints found: ${t22Addrs.length}`);

  const epoch = BigInt((await connection.getEpochInfo("confirmed")).epoch);
  console.log(`Current epoch: ${epoch}`);

  const lowFeeCandidates: Candidate[] = [];

  for (const addr of t22Addrs) {
    const meta = cgList.get(addr);
    const info = accountInfos.get(addr);
    if (!info || !meta) continue;

    try {
      const mint = unpackMint(new PublicKey(addr), info, TOKEN_2022_PROGRAM_ID);
      const cfg = getTransferFeeConfig(mint);
      if (!cfg) continue;

      const activeFee = epoch >= cfg.newerTransferFee.epoch ? cfg.newerTransferFee : cfg.olderTransferFee;
      const bps = activeFee.transferFeeBasisPoints;

      if (bps === 0 || bps > MAX_FEE_BPS) continue;

      const transferFeeConfigAuthority = cfg.transferFeeConfigAuthority?.toBase58() ?? null;
      const withdrawWithheldAuthority = cfg.withdrawWithheldAuthority?.toBase58() ?? null;
      const feeConfigMutable = transferFeeConfigAuthority !== null || withdrawWithheldAuthority !== null;
      const maxFeeUi = Number(activeFee.maximumFee) / 10 ** mint.decimals;

      lowFeeCandidates.push({
        mint: addr,
        name: meta.name,
        symbol: meta.symbol,
        decimals: mint.decimals,
        feeBps: bps,
        maximumFeeRaw: activeFee.maximumFee.toString(),
        maximumFeeUi: maxFeeUi,
        transferFeeConfigAuthority,
        withdrawWithheldAuthority,
        feeConfigMutable,
        jupiterRouteToUsdc: false,
        jupiterRouteToSol: false,
        jupiterRouteFromUsdc: false,
        jupiterRouteFromSol: false,
        tags: ["coingecko"],
        score: 0,
        notes: [],
      });
    } catch (error) {
      warnings.push(`mint=${addr} parse error=${error instanceof Error ? error.message : String(error)}`);
    }
  }

  console.log(`Low-fee T22 candidates (before Jupiter): ${lowFeeCandidates.length}`);

  // Jupiter liquidity checks
  for (let i = 0; i < lowFeeCandidates.length; i++) {
    const c = lowFeeCandidates[i];
    const decimalFactor = 10 ** c.decimals;
    const smallAmount = String(Math.floor(0.01 * decimalFactor));
    const usdcSmallAmount = "10000";
    const solSmallAmount = "10000000";

    const [toUsdc, toSol, fromUsdc, fromSol] = await Promise.all([
      jupiterQuoteExists(c.mint, USDC_MINT, smallAmount),
      jupiterQuoteExists(c.mint, SOL_MINT, smallAmount),
      jupiterQuoteExists(USDC_MINT, c.mint, usdcSmallAmount),
      jupiterQuoteExists(SOL_MINT, c.mint, solSmallAmount),
    ]);

    c.jupiterRouteToUsdc = toUsdc.exists;
    c.jupiterRouteToSol = toSol.exists;
    c.jupiterRouteFromUsdc = fromUsdc.exists;
    c.jupiterRouteFromSol = fromSol.exists;
    c.jupiterOutAmountUsdcToMint = fromUsdc.outAmount;
    c.jupiterOutAmountSolToMint = fromSol.outAmount;

    if (!toUsdc.exists && !toSol.exists && !fromUsdc.exists && !fromSol.exists) {
      c.notes.push("No Jupiter routes found; likely illiquid or not indexed.");
    }
    if (c.transferFeeConfigAuthority === null && c.withdrawWithheldAuthority === null) {
      c.notes.push("Authorities are null; fees may be unharvestable or permanently locked.");
    } else if (c.transferFeeConfigAuthority === "11111111111111111111111111111111") {
      c.notes.push("transferFeeConfigAuthority is SystemProgram; likely burned/meaningless.");
    }

    c.score = scoreCandidate(c);

    if ((i + 1) % 5 === 0) await sleep(300);
    if ((i + 1) % 10 === 0) console.log(`Jupiter check ${i + 1}/${lowFeeCandidates.length}`);
  }

  lowFeeCandidates.sort((a, b) => b.score - a.score);
  const top = lowFeeCandidates.slice(0, 15);

  const receipt = {
    verdict: "T22_FEE_HARVEST_SCAN_COMPLETE",
    generatedAt: new Date().toISOString(),
    rpcUrlRedacted: RPC_URL.replace(/api-key=([^&]+)/, "api-key=<redacted>"),
    parameters: {
      maxFeeBps: MAX_FEE_BPS,
      totalCandidates: candidateAddrs.length,
      t22MintsFound: t22Addrs.length,
      lowFeeBeforeJupiter: lowFeeCandidates.length,
      liquidAfterJupiter: lowFeeCandidates.filter((c) =>
        c.jupiterRouteToUsdc || c.jupiterRouteToSol || c.jupiterRouteFromUsdc || c.jupiterRouteFromSol
      ).length,
    },
    topCandidates: top,
    allCandidates: lowFeeCandidates,
    warnings,
    nextSteps: [
      "For mutable-authority candidates: attempt to acquire authority via key compromise, social engineering, or marketplace purchase (if authority is an NFT/wallet).",
      "For null-authority candidates: verify on-chain that WithdrawWithheldTokensFromMint is callable by anyone; usually it is not.",
      "Run volume-bot or ring-bot simulation on top 3 before any live execution.",
      "Check if any candidate has an Orca/Raydium pool with concentrated liquidity for tighter ring spreads.",
    ],
  };

  const out = writeReceipt("T22-FEE-HARVEST-SCAN-LATEST.json", receipt);
  console.log(`Scan complete. Final candidates: ${lowFeeCandidates.length}. Top score: ${top[0]?.score ?? 0}`);
  console.log(`Receipt written: ${out}`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
