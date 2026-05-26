import "dotenv/config";
import fs from "node:fs";
import { Connection, Keypair, SystemProgram, Transaction, sendAndConfirmTransaction } from "@solana/web3.js";

const RPC = "https://mainnet.helius-rpc.com/?api-key=5b121325-36cb-473b-bbeb-47490d21479c";
const conn = new Connection(RPC, "confirmed");

const crank = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync("keys/crank.json", "utf8"))));
const treasury = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync("keys/treasury.json", "utf8"))));

async function main() {
  const lamports = 40_000_000;
  const tx = new Transaction().add(
    SystemProgram.transfer({ fromPubkey: treasury.publicKey, toPubkey: crank.publicKey, lamports })
  );
  const sig = await sendAndConfirmTransaction(conn, tx, [treasury], { commitment: "confirmed" });
  console.log(`sig: ${sig}`);
  const bal = await conn.getBalance(crank.publicKey);
  console.log(`crank: ${bal / 1e9} SOL`);
}

main().catch(e => { console.error(e); process.exitCode = 1; });
