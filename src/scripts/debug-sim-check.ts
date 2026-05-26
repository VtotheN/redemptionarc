import "dotenv/config";
import fs from "node:fs";
import { Connection, Keypair, PublicKey, TransactionInstruction, TransactionMessage, VersionedTransaction, ComputeBudgetProgram } from "@solana/web3.js";
import { KPX9_WHIRLPOOLS_CONFIG, KPX9_CONFIG_EXTENSION, OFFICIAL_ORCA_PROGRAM_ID } from "../constants.js";
async function main() {
  const conn = new Connection(process.env.SOLANA_RPC_URL || "https://api.mainnet-beta.solana.com", "confirmed");
  const authority = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync("keys/crank.json", "utf8")) as number[]));
  const SET_DISC = Buffer.from("47ade41243f7d239", "hex");
  const ix = new TransactionInstruction({
    programId: OFFICIAL_ORCA_PROGRAM_ID,
    keys: [
      { pubkey: KPX9_WHIRLPOOLS_CONFIG, isSigner: false, isWritable: false },
      { pubkey: KPX9_CONFIG_EXTENSION,  isSigner: false, isWritable: true  },
      { pubkey: authority.publicKey,    isSigner: true,  isWritable: true  },
    ],
    data: Buffer.concat([SET_DISC, Buffer.from([0, 1])]),
  });
  const { blockhash } = await conn.getLatestBlockhash("confirmed");
  const msg = new TransactionMessage({
    payerKey: authority.publicKey,
    recentBlockhash: blockhash,
    instructions: [ix],
  }).compileToV0Message([]);
  const vtx = new VersionedTransaction(msg);
  vtx.sign([authority]);
  
  // Send directly - skip simulation
  const sig = await conn.sendTransaction(vtx, { skipPreflight: false });
  console.log("sig:", sig);
}
main().catch(console.error);
