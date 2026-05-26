/**
 * Enable TOKEN_BADGE feature flag (bit 0) on KPX9 WhirlpoolsConfig.
 */
import "dotenv/config";
import dotenv from "dotenv";
import fs from "node:fs";
import {
  Connection,
  Keypair,
  TransactionInstruction,
  TransactionMessage,
  VersionedTransaction,
  ComputeBudgetProgram,
} from "@solana/web3.js";
import { KPX9_WHIRLPOOLS_CONFIG, KPX9_CONFIG_EXTENSION, OFFICIAL_ORCA_PROGRAM_ID } from "../constants.js";
import { writeReceipt } from "../utils/receipt.js";

if (process.env.ENV_PATH) dotenv.config({ path: process.env.ENV_PATH, override: true });

const TOKEN_BADGE_BIT = 1;

const SET_CONFIG_FEATURE_FLAG_DISC = Buffer.from("47ade41243f7d239", "hex");

function loadKeypair(p: string): Keypair {
  return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(p, "utf8")) as number[]));
}

function decodeFeatureFlags(data: Buffer): number {
  // WhirlpoolsConfig (108 bytes): disc(8)+fee_auth(32)+collect_auth(32)+reward_auth(32)+default_fee(2)+feature_flags(2)
  return data.readUInt16LE(106);
}

async function main() {
  const rpcUrl = process.env.SOLANA_RPC_URL || process.env.RPC_URL || "https://api.mainnet-beta.solana.com";
  const dryRun = process.env.DRY_RUN !== "false";
  const allowLive = process.env.ALLOW_LIVE === "true";
  const connection = new Connection(rpcUrl, "confirmed");

  // kpx9-authority signs the instruction; crank pays fees
  const authority = loadKeypair(
    process.env.KPX9_FEATURE_AUTH_PATH ||
    process.env.KPX9_ADMIN_KEYPAIR_PATH ||
    "keys/kpx9-authority.json"
  );
  const payer = loadKeypair(
    process.env.CRANK_KEYPAIR_PATH ||
    "keys/crank.json"
  );

  console.log("=== KPX9 ENABLE TOKEN BADGE FEATURE ===");
  console.log(`program:   ${OFFICIAL_ORCA_PROGRAM_ID.toBase58()}`);
  console.log(`config:    ${KPX9_WHIRLPOOLS_CONFIG.toBase58()}`);
  console.log(`authority: ${authority.publicKey.toBase58()} (kpx9-authority)`);
  console.log(`payer:     ${payer.publicKey.toBase58()} (crank, pays fees)`);
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
      { pubkey: KPX9_WHIRLPOOLS_CONFIG,   isSigner: false, isWritable: true  },  // [0] whirlpools_config (writable)
      { pubkey: authority.publicKey,      isSigner: true,  isWritable: false },  // [1] authority (signer)
      { pubkey: OFFICIAL_ORCA_PROGRAM_ID, isSigner: false, isWritable: false },  // [2] whirlpool_program
    ],
    // ConfigFeatureFlag::TokenBadge(true): variant index 0 + bool true.
    data: Buffer.concat([SET_CONFIG_FEATURE_FLAG_DISC, Buffer.from([0, 1])]),
  });

  const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash("confirmed");
  const msg = new TransactionMessage({
    payerKey: payer.publicKey,
    recentBlockhash: blockhash,
    instructions: [
      ComputeBudgetProgram.setComputeUnitLimit({ units: 80_000 }),
      ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 50_000 }),
      ix,
    ],
  }).compileToV0Message([]);
  const vtx = new VersionedTransaction(msg);
  vtx.sign([payer, authority]);

  if (dryRun || !allowLive) {
    // Dry-run: only simulate
    const sim = await connection.simulateTransaction(vtx, { sigVerify: false, replaceRecentBlockhash: true });
    receipt.simErr = sim.value.err ?? null;
    receipt.simLogs = sim.value.logs?.slice(-8) ?? [];
    receipt.verdict = sim.value.err ? "TOKEN_BADGE_FEATURE_SIM_FAILED" : "TOKEN_BADGE_FEATURE_SIM_OK";
    writeReceipt("KPX9-TOKEN-BADGE-FEATURE.json", receipt);
    console.log(sim.value.err ? `SIM_FAILED: ${JSON.stringify(sim.value.err)}` : `SIM_OK feature_flags=${receipt.desiredFeatureFlags}`);
    if (sim.value.err) { (receipt.simLogs as string[]).forEach((l) => console.error(l)); process.exitCode = 1; }
    return;
  }

  // Live: send directly (skip preflight, let chain confirm)
  const sig = await connection.sendTransaction(vtx, { skipPreflight: true });
  await connection.confirmTransaction({ signature: sig, blockhash, lastValidBlockHeight }, "confirmed");
  receipt.verdict = "TOKEN_BADGE_FEATURE_EXECUTED";
  receipt.signature = sig;
  writeReceipt("KPX9-TOKEN-BADGE-FEATURE.json", receipt);
  console.log(`\nEXECUTED sig=${sig}`);
}

main().catch((e) => { console.error(e); process.exitCode = 1; });
