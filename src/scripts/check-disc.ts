import { Connection, PublicKey } from "@solana/web3.js";
async function main() {
  const conn = new Connection(process.env.SOLANA_RPC_URL || "https://api.mainnet-beta.solana.com", "confirmed");
  const CONFIG = new PublicKey("KPX9QQP4GLWiRkh4pGpkagwoPGaGixarRQs1LQKb9dt");
  const EXT    = new PublicKey("GgGRBg8kKd4h5KZcDSLMnHL84g3cEdJRaAfRmushev6A");
  const [c, e] = await Promise.all([conn.getAccountInfo(CONFIG, "confirmed"), conn.getAccountInfo(EXT, "confirmed")]);
  if (!c || !e) throw new Error("missing");
  console.log("config disc:   ", Buffer.from(c.data.slice(0, 8)).toString("hex"), "(expect 9d1431e0d957c1fe)");
  console.log("ext disc:      ", Buffer.from(e.data.slice(0, 8)).toString("hex"), "(expect 0263d7a3f01a993a)");
}
main().catch(console.error);
