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
    instructions: [
      ComputeBudgetProgram.setComputeUnitLimit({ units: 80_000 }),
      ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 50_000 }),
      ix,
    ],
  }).compileToV0Message([]);
  console.log("numRequiredSignatures:", msg.header.numRequiredSignatures);
  console.log("numReadonlySignedAccounts:", msg.header.numReadonlySignedAccounts);
  console.log("numReadonlyUnsignedAccounts:", msg.header.numReadonlyUnsignedAccounts);
  console.log("staticAccountKeys:", msg.staticAccountKeys.map(k => k.toBase58()));
  const ixComp = msg.compiledInstructions[2]; // our main ix (after 2 compute budget)
  console.log("ix accounts:", ixComp.accountKeyIndexes);
}
main().catch(console.error);
