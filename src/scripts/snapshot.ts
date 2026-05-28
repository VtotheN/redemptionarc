import "dotenv/config";
import { Connection, PublicKey, LAMPORTS_PER_SOL } from "@solana/web3.js";
import { getAssociatedTokenAddressSync, TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID } from "@solana/spl-token";

const RPC = process.env.SOLANA_RPC_URL!;
const CRANK = new PublicKey("8pWEfpJas2tgS8iE7ZyHKNjeDSEixqSwK12W4tagNJ3S");
const USDC_MINT = new PublicKey("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v");
const HOP_MINT  = new PublicKey("HZF5k7h39hkysoSZ4ZfmWc55PhvW7ntVvVqdXFCyYGh3");
const WHIRLPOOL = new PublicKey("8aoWgf7ycbeKv6BTFCdUj4JR7Y4mXWuPZWEUhmuzN5ZL");
const USDC_VAULT = new PublicKey("4QD4GgnjRvjETqWLT5e3x7SHtJSzs9kShUPLfyHcTu7d");
const HOP_VAULT  = new PublicKey("Qv51R47g7pMDxa3UofXaz8cNr8pwRSXaNufgnEWX8Yk");
const WP_TICK_INDEX_OFFSET = 81;
const WP_SQRT_PRICE_OFFSET = 65;

function readI32LE(buf: Buffer, off: number) { return buf.readInt32LE(off); }
function readU128LE(buf: Buffer, off: number): bigint {
  return buf.readBigUInt64LE(off) | (buf.readBigUInt64LE(off+8) << 64n);
}

async function main() {
  const conn = new Connection(RPC, "confirmed");
  const usdcAta = getAssociatedTokenAddressSync(USDC_MINT, CRANK, false, TOKEN_PROGRAM_ID);
  const hopAta  = getAssociatedTokenAddressSync(HOP_MINT,  CRANK, false, TOKEN_2022_PROGRAM_ID);

  const [solLamp, usdcBal, hopBal, vaultA, vaultB, wpInfo] = await Promise.all([
    conn.getBalance(CRANK, "confirmed"),
    conn.getTokenAccountBalance(usdcAta, "confirmed"),
    conn.getTokenAccountBalance(hopAta, "confirmed"),
    conn.getTokenAccountBalance(USDC_VAULT, "confirmed"),
    conn.getTokenAccountBalance(HOP_VAULT, "confirmed"),
    conn.getAccountInfo(WHIRLPOOL, "confirmed"),
  ]);

  const wpBuf = Buffer.from(wpInfo!.data);
  const tick = readI32LE(wpBuf, WP_TICK_INDEX_OFFSET);
  const sqrtPriceX64 = readU128LE(wpBuf, WP_SQRT_PRICE_OFFSET);
  const sqrtPrice = Number(sqrtPriceX64) / (2**64);
  const hopPerUsdc = sqrtPrice * sqrtPrice; // price = (sqrtPrice)^2 = HOP per USDC? 
  // pool price = token_b / token_a = HOP / USDC
  // sqrtPrice^2 = price in HOP/USDC units
  const usdcPerHop = 1 / hopPerUsdc; // USDC per HOP

  const sol = solLamp / LAMPORTS_PER_SOL;
  const usdc = Number(usdcBal.value.uiAmount);
  const hop = Number(hopBal.value.uiAmount);
  const hopInUsdc = hop * usdcPerHop;

  // vault balances (pool's liquidity backing)
  const vaultUsdcUi = Number(vaultA.value.uiAmount);
  const vaultHopUi  = Number(vaultB.value.uiAmount);
  const vaultHopInUsdc = vaultHopUi * usdcPerHop;

  // SOL price approximation: use hardcoded ~$170 (replace if needed)
  const SOL_USD = 170;
  const solInUsdc = sol * SOL_USD;

  const walletTotal = usdc + hopInUsdc + solInUsdc;
  const poolTotal = vaultUsdcUi + vaultHopInUsdc;

  console.log(`\n=== SYSTEM SNAPSHOT ${new Date().toISOString()} ===`);
  console.log(`\n--- CRANK WALLET ---`);
  console.log(`  SOL:  ${sol.toFixed(6)} SOL  ≈ $${solInUsdc.toFixed(2)}`);
  console.log(`  USDC: $${usdc.toFixed(6)}`);
  console.log(`  HOP:  ${hop.toFixed(6)} ≈ $${hopInUsdc.toFixed(6)}`);
  console.log(`  WALLET TOTAL: $${walletTotal.toFixed(4)}`);
  console.log(`\n--- POOL STATE ---`);
  console.log(`  tick:         ${tick}  (center 92520)`);
  console.log(`  pool price:   1 HOP = $${usdcPerHop.toFixed(8)} USDC`);
  console.log(`  vault USDC:   $${vaultUsdcUi.toFixed(2)}`);
  console.log(`  vault HOP:    ${vaultHopUi.toFixed(2)} ≈ $${vaultHopInUsdc.toFixed(2)}`);
  console.log(`  POOL TVL:     $${poolTotal.toFixed(2)}`);
  console.log(`\n--- SYSTEM TOTAL (wallet + pool) ---`);
  console.log(`  $${(walletTotal + poolTotal).toFixed(4)}`);
  console.log(`===`);
}
main().catch(e => { console.error(e); process.exit(1); });
