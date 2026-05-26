import { Connection, PublicKey } from "@solana/web3.js";
async function main() {
  const conn = new Connection(process.env.SOLANA_RPC_URL || "https://api.mainnet-beta.solana.com", "confirmed");
  const addrs = {
    KPX9_CONFIG: "KPX9QQP4GLWiRkh4pGpkagwoPGaGixarRQs1LQKb9dt",
    KPX9_EXT:    "GgGRBg8kKd4h5KZcDSLMnHL84g3cEdJRaAfRmushev6A",
  };
  for (const [name, addr] of Object.entries(addrs)) {
    const info = await conn.getAccountInfo(new PublicKey(addr), "confirmed");
    console.log(name, "owner:", info?.owner?.toBase58() ?? "NOT FOUND", "data len:", info?.data.length ?? 0);
  }
}
main().catch(console.error);
