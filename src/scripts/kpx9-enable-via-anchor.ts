import "dotenv/config";
import dotenv from "dotenv";
import fs from "node:fs";
import { Connection, Keypair, PublicKey } from "@solana/web3.js";
import * as anchor from "@coral-xyz/anchor";
import { KPX9_WHIRLPOOLS_CONFIG, KPX9_CONFIG_EXTENSION, OFFICIAL_ORCA_PROGRAM_ID } from "../constants.js";

if (process.env.ENV_PATH) dotenv.config({ path: process.env.ENV_PATH, override: true });

function loadKeypair(p: string) {
  return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(p, "utf8")) as number[]));
}

async function main() {
  const rpcUrl = process.env.SOLANA_RPC_URL || "https://api.mainnet-beta.solana.com";
  const conn = new Connection(rpcUrl, "confirmed");
  const authority = loadKeypair("keys/crank.json");

  const wallet = new anchor.Wallet(authority);
  const provider = new anchor.AnchorProvider(conn, wallet, { commitment: "confirmed" });

  // Fetch IDL from on-chain program
  console.log("Fetching IDL for", OFFICIAL_ORCA_PROGRAM_ID.toBase58());
  const idl = await anchor.Program.fetchIdl(OFFICIAL_ORCA_PROGRAM_ID, provider);
  if (!idl) throw new Error("No IDL found on-chain");

  // Find setConfigFeatureFlag instruction in IDL
  const ixDef = idl.instructions.find((i: any) => i.name === "setConfigFeatureFlag");
  if (!ixDef) {
    console.log("setConfigFeatureFlag NOT found in IDL");
    console.log("All instructions:", idl.instructions.map((i: any) => i.name));
    return;
  }

  console.log("\nsetConfigFeatureFlag accounts:");
  ixDef.accounts.forEach((a: any, i: number) => {
    console.log(`  [${i}] ${a.name} — isMut:${a.isMut} isSigner:${a.isSigner}`);
  });
  console.log("\nArgs:", ixDef.args);
}

main().catch(e => { console.error(e); process.exitCode = 1; });
