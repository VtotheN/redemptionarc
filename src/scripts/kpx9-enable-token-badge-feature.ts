/**
 * Enable TOKEN_BADGE feature flag (bit 0) on KPX9 WhirlpoolsConfig.
 */
import "dotenv/config";
import dotenv from "dotenv";
import fs from "node:fs";
import {
  Connection,
  Keypair,
  Transaction,
  TransactionInstruction,
  sendAndConfirmTransaction,
} from "@solana/web3.js";
import { KPX9_WHIRLPOOLS_CONFIG, OFFICIAL_ORCA_PROGRAM_ID } from "../constants.js";
import { writeReceipt } from "../utils/receipt.js";

if (process.env.ENV_PATH) dotenv.config({ path: process.env.ENV_PATH, override: true });

const TOKEN_BADGE_BIT = 1;

const SET_CONFIG_FEATURE_FLAG_DISC = Buffer.from("47ade41243f7d239", "hex");

function loadKeypair(p: string): Keypair {
  return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(p, "utf8")) as number[]));
}

function decodeFeatureFlags(data: Buffer): number {
  return data.readUInt16LE(106);
}

async function main() {
  const rpcUrl = process.env.SOLANA_RPC_URL || process.env.RPC_URL || "https://api.mainnet-beta.solana.com";
  const dryRun = process.env.DRY_RUN !== "false";
  const allowLive = process.env.ALLOW_LIVE === "true";
  const connection = new Connection(rpcUrl, "confirmed");

  const authority = loadKeypair(
    process.env.KPX9_FEATURE_AUTH_PATH ||
    process.env.KPX9_ADMIN_KEYPAIR_PATH ||
    process.env.CRANK_KEYPAIR_PATH ||
    "keys/crank.json"
  );

  console.log("=== KPX9 ENABLE TOKEN BADGE FEATURE ===");
  console.log(`program:   ${OFFICIAL_ORCA_PROGRAM_ID.toBase58()}`);
  console.log(`config:    ${KPX9_WHIRLPOOLS_CONFIG.toBase58()}`);
  console.log(`authority: ${authority.publicKey.toBase58()}`);
  console.log(`dry_run:   ${dryRun}`);

  const configInfo = await connection.getAccountInfo(KPX9_WHIRLPOOLS_CONFIG, "confirmed");
  if (!configInfo) throw new Error(`Missing KPX9 config ${KPX9_WHIRLPOOLS_CONFIG.toBase58()}`);

  const currentFeatureFlags = decodeFeatureFlags(Buffer.from(configInfo.data));
  const receipt: Record<string, unknown> = {
    config: KPX9_WHIRLPOOLS_CONFIG.toBase58(),
    authority: authority.publicKey.toBase58(),
    currentFeatureFlags,
    desiredFeatureFlags: currentFeatureFlags | TOKEN_BADGE_BIT,
    dryRun,
    signature: null as string | null,
    verdict: "",
  };

  if ((currentFeatureFlags & TOKEN_BADGE_BIT) !== 0) {
    receipt.verdict = "TOKEN_BADGE_FEATURE_ALREADY_ENABLED";
    writeReceipt("KPX9-TOKEN-BADGE-FEATURE.json", receipt);
    console.log("\nTOKEN_BADGE_FEATURE_ALREADY_ENABLED");
    return;
  }

  const ix = new TransactionInstruction({
    programId: OFFICIAL_ORCA_PROGRAM_ID,
    keys: [
      { pubkey: KPX9_WHIRLPOOLS_CONFIG, isSigner: false, isWritable: true },
      { pubkey: authority.publicKey, isSigner: true, isWritable: false },
    ],
    // ConfigFeatureFlag::TokenBadge(true): variant index 0 + bool true.
    data: Buffer.concat([SET_CONFIG_FEATURE_FLAG_DISC, Buffer.from([0, 1])]),
  });

  const tx = new Transaction().add(ix);
  tx.feePayer = authority.publicKey;
  tx.recentBlockhash = (await connection.getLatestBlockhash("confirmed")).blockhash;
  tx.sign(authority);

  const sim = await connection.simulateTransaction(tx);
  receipt.simErr = sim.value.err ?? null;
  receipt.simLogs = sim.value.logs?.slice(-8) ?? [];

  if (sim.value.err) {
    receipt.verdict = "TOKEN_BADGE_FEATURE_SIM_FAILED";
    writeReceipt("KPX9-TOKEN-BADGE-FEATURE.json", receipt);
    console.error(`SIM_FAILED: ${JSON.stringify(sim.value.err)}`);
    (receipt.simLogs as string[]).forEach((l) => console.error(l));
    process.exitCode = 1;
    return;
  }

  if (dryRun || !allowLive) {
    receipt.verdict = "TOKEN_BADGE_FEATURE_SIM_OK";
    writeReceipt("KPX9-TOKEN-BADGE-FEATURE.json", receipt);
    console.log(`\nSIM_OK feature_flags=${receipt.desiredFeatureFlags}`);
    return;
  }

  const sig = await sendAndConfirmTransaction(connection, tx, [authority], { commitment: "confirmed" });
  receipt.verdict = "TOKEN_BADGE_FEATURE_EXECUTED";
  receipt.signature = sig;
  writeReceipt("KPX9-TOKEN-BADGE-FEATURE.json", receipt);
  console.log(`\nEXECUTED sig=${sig}`);
}

main().catch((e) => { console.error(e); process.exitCode = 1; });
