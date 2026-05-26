import { Connection, PublicKey } from "@solana/web3.js";
async function main() {
  const conn = new Connection(process.env.SOLANA_RPC_URL || "https://api.mainnet-beta.solana.com", "confirmed");
  const RAYDIUM_CPMM = new PublicKey("CPMMoo8L3F4NbTegBCKVNunggL7H1ZpdTHKxQB5qKP1C");
  const POOL_ID = new PublicKey("EwoZHyXz48vZL1TwkpQoq31brW4G4NDwmMr1DMw6qqBV");
  const USDC_MINT = new PublicKey("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v");
  const HOP_MINT  = new PublicKey("HZF5k7h39hkysoSZ4ZfmWc55PhvW7ntVvVqdXFCyYGh3");
  const [vaultA] = PublicKey.findProgramAddressSync([Buffer.from("pool_vault"), POOL_ID.toBuffer(), USDC_MINT.toBuffer()], RAYDIUM_CPMM);
  const [vaultB] = PublicKey.findProgramAddressSync([Buffer.from("pool_vault"), POOL_ID.toBuffer(), HOP_MINT.toBuffer()], RAYDIUM_CPMM);
  const [lpMint] = PublicKey.findProgramAddressSync([Buffer.from("pool_lp_mint"), POOL_ID.toBuffer()], RAYDIUM_CPMM);
  console.log("vaultA:", vaultA.toBase58());
  console.log("vaultB:", vaultB.toBase58());
  const [a, b, lp] = await Promise.all([
    conn.getTokenAccountBalance(vaultA),
    conn.getTokenAccountBalance(vaultB),
    conn.getTokenSupply(lpMint),
  ]);
  console.log("vaultA (USDC):", a.value.amount, "= $" + a.value.uiAmountString);
  console.log("vaultB (HOP): ", b.value.amount, "=", b.value.uiAmountString, "HOP");
  console.log("LP mint supply:", lp.value.amount);
}
main().catch(console.error);
