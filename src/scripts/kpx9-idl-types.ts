import "dotenv/config";
import fs from "node:fs";
import { Connection, Keypair } from "@solana/web3.js";
import * as anchor from "@coral-xyz/anchor";
import { OFFICIAL_ORCA_PROGRAM_ID } from "../constants.js";

async function main() {
  const rpcUrl = process.env.SOLANA_RPC_URL || "https://api.mainnet-beta.solana.com";
  const conn = new Connection(rpcUrl, "confirmed");
  const kp = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync("keys/crank.json","utf8")) as number[]));
  const provider = new anchor.AnchorProvider(conn, new anchor.Wallet(kp), {});
  const idl = await anchor.Program.fetchIdl(OFFICIAL_ORCA_PROGRAM_ID, provider);
  if (!idl) throw new Error("no IDL");

  // Find ConfigFeatureFlag type
  const types = (idl as any).types ?? [];
  const t = types.find((t: any) => t.name === "ConfigFeatureFlag");
  console.log("ConfigFeatureFlag:", JSON.stringify(t, null, 2));

  // Also print full IDL of set_config_feature_flag
  const ix = (idl.instructions as any[]).find(i => i.name === "set_config_feature_flag");
  console.log("\nFull ix:", JSON.stringify(ix, null, 2));

  // Save full IDL for reference
  fs.writeFileSync("/tmp/orca-whirlpool-idl.json", JSON.stringify(idl, null, 2));
  console.log("\nFull IDL saved to /tmp/orca-whirlpool-idl.json");
}
main().catch(e => { console.error(e); process.exitCode=1; });
