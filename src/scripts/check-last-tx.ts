import "dotenv/config";
import { Connection, PublicKey } from "@solana/web3.js";
const conn = new Connection(process.env.SOLANA_RPC_URL||"https://api.mainnet-beta.solana.com","confirmed");
const KPX9_CFG = new PublicKey("KPX9QQP4GLWiRkh4pGpkagwoPGaGixarRQs1LQKb9dt");
async function main() {
  const [txResult, cfg] = await Promise.all([
    conn.getTransaction("3BH7qjbAKhg9S3KAECN4hpHQiLL5fznaUGgF1PEyhJzsZv8eRzsiS7HS9kMQUBZpXY2w8tcTamCoovYAci4cE6ip", {maxSupportedTransactionVersion:0, commitment:"confirmed"}),
    conn.getAccountInfo(KPX9_CFG,"confirmed"),
  ]);
  console.log("TX found:", !!txResult);
  if (txResult) {
    console.log("TX err:", JSON.stringify(txResult.meta?.err));
    (txResult.meta?.logMessages||[]).forEach(l => console.log(l));
  }
  console.log("\nConfig offset 106 (feature_flags):", Buffer.from(cfg!.data).readUInt16LE(106));
}
main().catch(e=>{console.error(e);process.exitCode=1;});
