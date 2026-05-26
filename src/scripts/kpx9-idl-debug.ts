import "dotenv/config";
import fs from "node:fs";
import crypto from "node:crypto";
import { Connection, Keypair, PublicKey } from "@solana/web3.js";
import * as anchor from "@coral-xyz/anchor";
import { OFFICIAL_ORCA_PROGRAM_ID } from "../constants.js";

function loadKeypair(p: string) {
  return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(p, "utf8")) as number[]));
}

async function main() {
  const rpcUrl = process.env.SOLANA_RPC_URL || "https://api.mainnet-beta.solana.com";
  const conn = new Connection(rpcUrl, "confirmed");
  const authority = loadKeypair("keys/crank.json");
  const wallet = new anchor.Wallet(authority);
  const provider = new anchor.AnchorProvider(conn, wallet, { commitment: "confirmed" });

  const idl = await anchor.Program.fetchIdl(OFFICIAL_ORCA_PROGRAM_ID, provider);
  if (!idl) throw new Error("No IDL");

  const ixDef = (idl.instructions as any[]).find(i => i.name === "set_config_feature_flag");
  if (!ixDef) throw new Error("Instruction not found");

  console.log("=== set_config_feature_flag ===");
  console.log("Accounts:");
  (ixDef.accounts as any[]).forEach((a: any, i: number) => {
    console.log(`  [${i}] ${a.name} — isMut:${a.isMut} isSigner:${a.isSigner}`);
  });
  console.log("Args:", JSON.stringify(ixDef.args, null, 2));

  // Compute discriminator
  const disc_snake = crypto.createHash("sha256").update("global:set_config_feature_flag").digest().slice(0, 8);
  const disc_camel = crypto.createHash("sha256").update("global:setConfigFeatureFlag").digest().slice(0, 8);
  console.log("\nDiscriminators:");
  console.log("  snake (set_config_feature_flag):", disc_snake.toString("hex"));
  console.log("  camel (setConfigFeatureFlag):    ", disc_camel.toString("hex"));
  console.log("  current in script: 47ade41243f7d239");
}

main().catch(e => { console.error(e); process.exitCode = 1; });
