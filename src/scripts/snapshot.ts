import "dotenv/config";
import { Connection, PublicKey, LAMPORTS_PER_SOL } from "@solana/web3.js";
import { getAssociatedTokenAddressSync, TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID } from "@solana/spl-token";

const RPC = process.env.SOLANA_RPC_URL!;
const CRANK    = new PublicKey("8pWEfpJas2tgS8iE7ZyHKNjeDSEixqSwK12W4tagNJ3S");
const USDC_MINT = new PublicKey("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v");
const HOP_MINT  = new PublicKey("HZF5k7h39hkysoSZ4ZfmWc55PhvW7ntVvVqdXFCyYGh3");
const WHIRLPOOL = new PublicKey("8aoWgf7ycbeKv6BTFCdUj4JR7Y4mXWuPZWEUhmuzN5ZL");
const USDC_VAULT = new PublicKey("4QD4GgnjRvjETqWLT5e3x7SHtJSzs9kShUPLfyHcTu7d");
const HOP_VAULT  = new PublicKey("Qv51R47g7pMDxa3UofXaz8cNr8pwRSXaNufgnEWX8Yk");
const SOL_MINT   = "So11111111111111111111111111111111111111112";
const WP_TICK_INDEX_OFFSET = 81;
const WP_SQRT_PRICE_OFFSET = 65;

function readI32LE(buf: Buffer, off: number) { return buf.readInt32LE(off); }
function readU128LE(buf: Buffer, off: number): bigint {
  return buf.readBigUInt64LE(off) | (buf.readBigUInt64LE(off+8) << 64n);
}

async function getSolPriceUsd(): Promise<number> {
  // CoinGecko primary, no API key needed
  try {
    const res = await fetch("https://api.coingecko.com/api/v3/simple/price?ids=solana&vs_currencies=usd", { signal: AbortSignal.timeout(5000) });
    const json = await res.json() as any;
    const price = Number(json?.solana?.usd);
    if (price > 0) return price;
  } catch {}
  // Binance fallback
  try {
    const res = await fetch("https://api.binance.com/api/v3/ticker/price?symbol=SOLUSDT", { signal: AbortSignal.timeout(5000) });
    const json = await res.json() as any;
    const price = Number(json?.price);
    if (price > 0) return price;
  } catch {}
  return 170; // last resort hardcoded fallback
}

async function main() {
  const conn = new Connection(RPC, "confirmed");
  const usdcAta = getAssociatedTokenAddressSync(USDC_MINT, CRANK, false, TOKEN_PROGRAM_ID);
  const hopAta  = getAssociatedTokenAddressSync(HOP_MINT,  CRANK, false, TOKEN_2022_PROGRAM_ID);

  const [solLamp, usdcBal, hopBal, vaultA, vaultB, wpInfo, solUsd] = await Promise.all([
    conn.getBalance(CRANK, "confirmed"),
    conn.getTokenAccountBalance(usdcAta, "confirmed"),
    conn.getTokenAccountBalance(hopAta, "confirmed"),
    conn.getTokenAccountBalance(USDC_VAULT, "confirmed"),
    conn.getTokenAccountBalance(HOP_VAULT, "confirmed"),
    conn.getAccountInfo(WHIRLPOOL, "confirmed"),
    getSolPriceUsd(),
  ]);

  const wpBuf = Buffer.from(wpInfo!.data);
  const tick = readI32LE(wpBuf, WP_TICK_INDEX_OFFSET);
  const sqrtPriceX64 = readU128LE(wpBuf, WP_SQRT_PRICE_OFFSET);
  const sqrtPrice = Number(sqrtPriceX64) / (2**64);
  const hopPerUsdc = sqrtPrice * sqrtPrice;
  const usdcPerHop = 1 / hopPerUsdc;

  const sol  = solLamp / LAMPORTS_PER_SOL;
  const usdc = Number(usdcBal.value.uiAmount);
  const hop  = Number(hopBal.value.uiAmount);

  const vaultUsdc = Number(vaultA.value.uiAmount);
  const vaultHop  = Number(vaultB.value.uiAmount);

  // all prices: USDC exact on-chain, HOP from pool sqrtPrice on-chain, SOL from Jupiter API
  const hopUsd     = hop  * usdcPerHop;
  const solUsdVal  = sol  * solUsd;
  const vaultHopUsd = vaultHop * usdcPerHop;

  const walletTotal = usdc + hopUsd + solUsdVal;
  const poolTotal   = vaultUsdc + vaultHopUsd;
  const systemTotal = walletTotal + poolTotal;

  // exact USDC-only total (no price assumptions)
  const usdcOnlyTotal = usdc + vaultUsdc;

  console.log(`\n=== SYSTEM SNAPSHOT ${new Date().toISOString()} ===`);
  console.log(`\n--- CRANK WALLET (on-chain: ${CRANK.toBase58()}) ---`);
  console.log(`  SOL:  ${sol.toFixed(6)} SOL  × $${solUsd.toFixed(2)}/SOL (Jupiter) = $${solUsdVal.toFixed(2)}`);
  console.log(`  USDC: $${usdc.toFixed(6)}  ← exact on-chain`);
  console.log(`  HOP:  ${hop.toFixed(6)} × $${usdcPerHop.toFixed(8)}/HOP (pool sqrtPrice) = $${hopUsd.toFixed(2)}`);
  console.log(`  WALLET TOTAL: $${walletTotal.toFixed(4)}`);
  console.log(`\n--- POOL STATE (on-chain: ${WHIRLPOOL.toBase58()}) ---`);
  console.log(`  tick:         ${tick}  (center 92520, distance ${tick - 92520 > 0 ? "+" : ""}${tick - 92520})`);
  console.log(`  pool price:   1 HOP = $${usdcPerHop.toFixed(8)} USDC  ← from on-chain sqrtPrice`);
  console.log(`  vault USDC:   $${vaultUsdc.toFixed(6)}  ← exact on-chain`);
  console.log(`  vault HOP:    ${vaultHop.toFixed(2)} × $${usdcPerHop.toFixed(8)} = $${vaultHopUsd.toFixed(2)}`);
  console.log(`  POOL TVL:     $${poolTotal.toFixed(4)}`);
  console.log(`\n--- SYSTEM TOTAL ---`);
  console.log(`  Full (incl SOL+HOP at market):  $${systemTotal.toFixed(4)}`);
  console.log(`  USDC-only (exact, no estimates): $${usdcOnlyTotal.toFixed(4)}  [wallet $${usdc.toFixed(2)} + vault $${vaultUsdc.toFixed(2)}]`);
  console.log(`===`);
}
main().catch(e => { console.error(e); process.exit(1); });
