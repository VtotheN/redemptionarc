import "dotenv/config";
import { Connection, PublicKey } from "@solana/web3.js";
const CONN = new Connection(process.env.SOLANA_RPC_URL || "https://api.mainnet-beta.solana.com", "confirmed");
const CFG = new PublicKey("KPX9QQP4GLWiRkh4pGpkagwoPGaGixarRQs1LQKb9dt");
async function main() {
  const info = await CONN.getAccountInfo(CFG);
  const buf = Buffer.from(info!.data);
  console.log("Full hex:", buf.toString("hex"));
  console.log("Length:", buf.length);
  for (let i = 0; i < buf.length - 1; i++) {
    const v = buf.readUInt16LE(i);
    if (v !== 0) console.log(`  offset ${i}: u16LE=${v} (0x${v.toString(16).padStart(4,"0")})`);
  }
}
main().catch(console.error);
