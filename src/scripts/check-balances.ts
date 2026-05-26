import "dotenv/config";
import fs from "node:fs";
import { Connection, Keypair, PublicKey } from "@solana/web3.js";
import { TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID, getAssociatedTokenAddressSync } from "@solana/spl-token";
async function main() {
  const conn = new Connection(process.env.SOLANA_RPC_URL || "https://api.mainnet-beta.solana.com", "confirmed");
  const crank = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync("keys/crank.json", "utf8")) as number[]));
  const USDC_MINT = new PublicKey("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v");
  const HOP_MINT  = new PublicKey("HZF5k7h39hkysoSZ4ZfmWc55PhvW7ntVvVqdXFCyYGh3");
  const crankUsdcAta = getAssociatedTokenAddressSync(USDC_MINT, crank.publicKey, false, TOKEN_PROGRAM_ID);
  const crankHopAta  = new PublicKey("2s2Au2bxsvF5cHbdhfP4JaFX8FXp5wXzQxBj15PNPEkD");
  const sol = await conn.getBalance(crank.publicKey);
  const [usdc, hop] = await Promise.all([
    conn.getTokenAccountBalance(crankUsdcAta).catch(() => ({ value: { uiAmountString: "N/A", amount: "0" } })),
    conn.getTokenAccountBalance(crankHopAta).catch(() => ({ value: { uiAmountString: "N/A", amount: "0" } })),
  ]);
  console.log(`Crank: ${crank.publicKey.toBase58()}`);
  console.log(`SOL:   ${sol / 1e9}`);
  console.log(`USDC:  $${usdc.value.uiAmountString}`);
  console.log(`HOP:   ${hop.value.uiAmountString} (${hop.value.amount} raw)`);
}
main().catch(console.error);
