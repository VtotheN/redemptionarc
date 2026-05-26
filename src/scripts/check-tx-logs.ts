import "dotenv/config";
import { Connection } from "@solana/web3.js";

const CONN = new Connection(process.env.SOLANA_RPC_URL || "https://api.mainnet-beta.solana.com", "confirmed");

async function main() {
  const sig = "9Td4CitJ2LvW51hGeB4qtTGLrfgsoYkBx1ETPn5YKBpeoySTfGGKQNgpCtmmBUSMDpMZ15KojTprsLD4s97se8F";
  const tx = await CONN.getTransaction(sig, { maxSupportedTransactionVersion: 0, commitment: "confirmed" });
  if (!tx) { console.log("TX not found"); return; }
  console.log("err:", tx.meta?.err ?? null);
  console.log("logs:");
  (tx.meta?.logMessages ?? []).forEach(l => console.log(" ", l));

  // Also check the first KPX9_EXTENSION tx
  const sig2 = "4SMAQSbC8KGcgWq6r92mHuPQzbAR9JUQ4GrYfXJbo88U6XzmhngpzaANgNodUmWJA4y9uUPQPkb41WfVqsepYZmg";
  console.log("\n--- Second tx ---");
  const tx2 = await CONN.getTransaction(sig2, { maxSupportedTransactionVersion: 0, commitment: "confirmed" });
  if (!tx2) { console.log("TX2 not found"); return; }
  console.log("err:", tx2.meta?.err ?? null);
  console.log("logs:");
  (tx2.meta?.logMessages ?? []).forEach(l => console.log(" ", l));
}
main().catch(console.error);
