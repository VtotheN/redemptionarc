import "dotenv/config";
import fs from "node:fs";
import { Connection, Keypair, PublicKey } from "@solana/web3.js";
import * as anchor from "@coral-xyz/anchor";
import { OFFICIAL_ORCA_PROGRAM_ID, KPX9_WHIRLPOOLS_CONFIG, KPX9_CONFIG_EXTENSION } from "../constants.js";

async function main() {
  const rpcUrl = process.env.SOLANA_RPC_URL || "https://api.mainnet-beta.solana.com";
  const conn = new Connection(rpcUrl, "confirmed");
  const kp = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync("keys/crank.json","utf8")) as number[]));
  const wallet = new anchor.Wallet(kp);
  const provider = new anchor.AnchorProvider(conn, wallet, { commitment: "confirmed" });

  const idl = await anchor.Program.fetchIdl(OFFICIAL_ORCA_PROGRAM_ID, provider);
  if (!idl) throw new Error("no IDL");

  const program = new anchor.Program(idl as anchor.Idl, provider);

  console.log("Calling set_config_feature_flag via Anchor client...");

  // Log the accounts Anchor would resolve
  const ix = await (program.methods as any)
    .setConfigFeatureFlag({ tokenBadge: [true] })
    .accounts({
      whirlpoolsConfig: KPX9_WHIRLPOOLS_CONFIG,
      authority: kp.publicKey,
      whirlpoolProgram: OFFICIAL_ORCA_PROGRAM_ID,
    })
    .instruction();

  console.log("\nInstruction keys:");
  ix.keys.forEach((k: any, i: number) => {
    console.log(`  [${i}] ${k.pubkey.toBase58()} isSigner:${k.isSigner} isWritable:${k.isWritable}`);
  });
  console.log("Data:", ix.data.toString("hex"));

  if (process.env.DRY_RUN !== "false") {
    console.log("\nDRY_RUN — set DRY_RUN=false ALLOW_LIVE=true to send");
    return;
  }

  const sig = await (program.methods as any)
    .setConfigFeatureFlag({ tokenBadge: [true] })
    .accounts({
      whirlpoolsConfig: KPX9_WHIRLPOOLS_CONFIG,
      authority: kp.publicKey,
      whirlpoolProgram: OFFICIAL_ORCA_PROGRAM_ID,
    })
    .rpc({ commitment: "confirmed", skipPreflight: true });

  console.log("\nEXECUTED sig=", sig);

  // Verify
  const cfg = await conn.getAccountInfo(KPX9_WHIRLPOOLS_CONFIG);
  const ext = await conn.getAccountInfo(KPX9_CONFIG_EXTENSION);
  console.log("Config offset 106 u16:", Buffer.from(cfg!.data).readUInt16LE(106));
  console.log("Ext    offset 104 u16:", Buffer.from(ext!.data).readUInt16LE(104));
}
main().catch(e => { console.error(e); process.exitCode=1; });
