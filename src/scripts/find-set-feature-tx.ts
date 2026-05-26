import { Connection, PublicKey } from "@solana/web3.js";
async function main() {
  const conn = new Connection(process.env.SOLANA_RPC_URL || "https://api.mainnet-beta.solana.com", "confirmed");
  const ORCA = new PublicKey("whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc");
  const KPX9_EXT = new PublicKey("GgGRBg8kKd4h5KZcDSLMnHL84g3cEdJRaAfRmushev6A");
  // Get signatures for extension account
  const sigs = await conn.getSignaturesForAddress(KPX9_EXT, { limit: 10 });
  for (const s of sigs) {
    const tx = await conn.getTransaction(s.signature, { maxSupportedTransactionVersion: 0 });
    if (!tx) continue;
    const msg = tx.transaction.message;
    const insts = "compiledInstructions" in msg ? msg.compiledInstructions : (msg as any).instructions;
    for (const ix of insts) {
      const keys = ix.accountKeyIndexes ?? (ix as any).accounts;
      const data = ix.data;
      const dataHex = Buffer.from(data instanceof Uint8Array ? data : Buffer.from(data, "base64")).toString("hex");
      if (dataHex.startsWith("47ade41243f7d239")) {
        const accountKeys = tx.transaction.message.staticAccountKeys ?? (tx.transaction.message as any).accountKeys;
        console.log("TX:", s.signature);
        console.log("disc: 47ade41243f7d239");
        console.log("data:", dataHex);
        console.log("accounts:", (keys as number[]).map((i: number) => accountKeys[i].toBase58()));
      }
    }
  }
}
main().catch(console.error);
