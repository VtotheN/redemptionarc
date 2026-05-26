import "dotenv/config";
import fs from "node:fs";
import { Connection, Keypair, PublicKey, TransactionInstruction, TransactionMessage, VersionedTransaction } from "@solana/web3.js";
import { KPX9_WHIRLPOOLS_CONFIG, KPX9_CONFIG_EXTENSION, OFFICIAL_ORCA_PROGRAM_ID } from "../constants.js";
async function main() {
  const conn = new Connection(process.env.SOLANA_RPC_URL || "https://api.mainnet-beta.solana.com", "confirmed");
  const authority = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync("keys/crank.json", "utf8")) as number[]));
  const ix = new TransactionInstruction({
    programId: OFFICIAL_ORCA_PROGRAM_ID,
    keys: [
      { pubkey: authority.publicKey,    isSigner: true,  isWritable: true  },
      { pubkey: KPX9_CONFIG_EXTENSION,  isSigner: false, isWritable: true  },
      { pubkey: KPX9_WHIRLPOOLS_CONFIG, isSigner: false, isWritable: false },
    ],
    data: Buffer.from("47ade41243f7d239" + "0001", "hex"),
  });
  const { blockhash } = await conn.getLatestBlockhash("confirmed");
  const msg = new TransactionMessage({
    payerKey: authority.publicKey,
    recentBlockhash: blockhash,
    instructions: [ix],
  }).compileToV0Message([]);
  console.log("header:", msg.header);
  console.log("staticAccountKeys:", msg.staticAccountKeys.map(k => k.toBase58()));
  const cix = msg.compiledInstructions[0];
  console.log("ix accountKeyIndexes:", cix.accountKeyIndexes);
  console.log("ix data hex:", Buffer.from(cix.data).toString("hex"));
  // Verify: what does each ix account map to?
  for (let i = 0; i < cix.accountKeyIndexes.length; i++) {
    const idx = cix.accountKeyIndexes[i];
    const pub = msg.staticAccountKeys[idx].toBase58();
    const isSigner = idx < msg.header.numRequiredSignatures;
    console.log(`  ix[${i}] -> staticKey[${idx}] = ${pub} (isSigner=${isSigner})`);
  }
}
main().catch(console.error);
