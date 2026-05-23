/**
 * Enable the TOKEN_BADGE feature flag on the KPX9 WhirlpoolsConfig.
 *
 * The official Orca Whirlpool V2 program guards initialize_token_badge behind a
 * feature flag (ConfigFeatureFlags::TOKEN_BADGE, bit 0) stored in the config's
 * feature_flags u16 field.  Without this flag set the instruction fails with
 * error 6066 FeatureIsNotEnabled.
 *
 * Instruction: set_config_feature_flag
 *   discriminator : [71, 173, 228, 18, 67, 247, 210, 57]
 *   accounts      : whirlpools_config (mut), fee_authority (signer)
 *   data          : discriminator + 0x00 (TokenBadge variant) + 0x01 (enable=true)
 *
 * KPX9 config  : KPX9QQP4GLWiRkh4pGpkagwoPGaGixarRQs1LQKb9dt
 * fee_authority: 8pWEfpJas2tgS8iE7ZyHKNjeDSEixqSwK12W4tagNJ3S (crank)
 *
 * After this runs, re-run: npm run init-kpx9-token-badge
 *
 * Env: DRY_RUN=false ALLOW_LIVE=true
 */

import "dotenv/config";
import dotenv from "dotenv";
import fs from "node:fs";
import {
  Connection,
  Keypair,
  PublicKey,
  Transaction,
  TransactionInstruction,
  sendAndConfirmTransaction,
} from "@solana/web3.js";
import { writeReceipt } from "../utils/receipt.js";

if (process.env.ENV_PATH) {
  dotenv.config({ path: process.env.ENV_PATH, override: true });
}

const OFFICIAL_ORCA = new PublicKey("whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc");
const KPX9_CONFIG   = new PublicKey("KPX9QQP4GLWiRkh4pGpkagwoPGaGixarRQs1LQKb9dt");

// sha256("global:set_config_feature_flag")[0:8]
const SET_CONFIG_FEATURE_FLAG_DISC = Buffer.from([71, 173, 228, 18, 67, 247, 210, 57]);

// ConfigFeatureFlag::TokenBadge = variant 0; bool true = 0x01
const ENABLE_TOKEN_BADGE_DATA = Buffer.concat([
  SET_CONFIG_FEATURE_FLAG_DISC,
  Buffer.from([0x00]),  // enum variant: TokenBadge
  Buffer.from([0x01]),  // bool: true (enable)
]);

function loadKeypair(path: string): Keypair {
  return Keypair.fromSecretKey(
    Uint8Array.from(JSON.parse(fs.readFileSync(path, "utf8")) as number[])
  );
}

async function main() {
  const rpcUrl    = process.env.SOLANA_RPC_URL || process.env.RPC_URL || "https://api.mainnet-beta.solana.com";
  const dryRun    = process.env.DRY_RUN !== "false";
  const allowLive = process.env.ALLOW_LIVE === "true";
  const connection = new Connection(rpcUrl, "confirmed");

  const crank = loadKeypair(process.env.CRANK_KEYPAIR_PATH || "keys/crank.json");

  if (!crank.publicKey.equals(new PublicKey("8pWEfpJas2tgS8iE7ZyHKNjeDSEixqSwK12W4tagNJ3S"))) {
    throw new Error(`crank pubkey mismatch: ${crank.publicKey.toBase58()}`);
  }

  // Verify current state
  const configInfo = await connection.getAccountInfo(KPX9_CONFIG, "confirmed");
  if (!configInfo) throw new Error("KPX9 config account not found on-chain");
  const featureFlags = configInfo.data.readUInt16LE(106);
  const alreadyEnabled = (featureFlags & 0x0001) !== 0;

  console.log("=== KPX9 ENABLE TOKEN BADGE FEATURE ===");
  console.log(`program:        ${OFFICIAL_ORCA.toBase58()}`);
  console.log(`kpx9_config:    ${KPX9_CONFIG.toBase58()}`);
  console.log(`fee_authority:  ${crank.publicKey.toBase58()} (crank)`);
  console.log(`feature_flags:  ${featureFlags} (current)`);
  console.log(`already_set:    ${alreadyEnabled}`);
  console.log(`dry_run:        ${dryRun}`);

  const receipt: Record<string, unknown> = {
    kpx9Config: KPX9_CONFIG.toBase58(),
    feeAuthority: crank.publicKey.toBase58(),
    featureFlagsBefore: featureFlags,
    alreadyEnabled,
    dryRun,
    signature: null as string | null,
    verdict: "",
  };

  if (alreadyEnabled) {
    receipt.verdict = "TOKEN_BADGE_FEATURE_ALREADY_ENABLED";
    const out = writeReceipt("KPX9-ENABLE-TOKEN-BADGE-FEATURE.json", receipt);
    console.log(`\nALREADY_ENABLED feature_flags=${featureFlags} receipt=${out}`);
    return;
  }

  const ix = new TransactionInstruction({
    programId: OFFICIAL_ORCA,
    keys: [
      { pubkey: KPX9_CONFIG,       isSigner: false, isWritable: true  },
      { pubkey: crank.publicKey,   isSigner: true,  isWritable: false },
    ],
    data: ENABLE_TOKEN_BADGE_DATA,
  });

  const tx = new Transaction().add(ix);
  tx.feePayer = crank.publicKey;
  tx.recentBlockhash = (await connection.getLatestBlockhash("confirmed")).blockhash;

  const sim = await connection.simulateTransaction(tx);
  receipt.simErr  = sim.value.err ?? null;
  receipt.simLogs = sim.value.logs?.slice(-10) ?? [];

  if (sim.value.err) {
    receipt.verdict = "SIM_FAILED";
    const out = writeReceipt("KPX9-ENABLE-TOKEN-BADGE-FEATURE.json", receipt);
    console.error(`\nSIM_FAILED: ${JSON.stringify(sim.value.err)}`);
    (receipt.simLogs as string[]).forEach(l => console.error(l));
    console.error(`receipt=${out}`);
    process.exitCode = 1;
    return;
  }

  if (dryRun || !allowLive) {
    receipt.verdict = "SIM_OK";
    const out = writeReceipt("KPX9-ENABLE-TOKEN-BADGE-FEATURE.json", receipt);
    console.log(`\nSIM_OK — run with DRY_RUN=false ALLOW_LIVE=true to execute`);
    console.log(`receipt=${out}`);
    return;
  }

  const sig = await sendAndConfirmTransaction(connection, tx, [crank], { commitment: "confirmed" });
  receipt.verdict   = "EXECUTED";
  receipt.signature = sig;
  const out = writeReceipt("KPX9-ENABLE-TOKEN-BADGE-FEATURE.json", receipt);
  console.log(`\nEXECUTED sig=${sig}`);
  console.log(`TOKEN_BADGE feature flag is now enabled on KPX9 config`);
  console.log(`Next: npm run init-kpx9-token-badge`);
  console.log(`receipt=${out}`);
}

main().catch(e => { console.error(e); process.exitCode = 1; });
