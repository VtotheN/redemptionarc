/**
 * Transfer all 5 KPX9 WhirlpoolsConfig authorities from 7Wg8 (gas-station-admin) → crank.
 *
 * KPX9 config:  KPX9QQP4GLWiRkh4pGpkagwoPGaGixarRQs1LQKb9dt
 * ConfigExt:    GgGRBg8kKd4h5KZcDSLMnHL84g3cEdJRaAfRmushev6A
 * Current auth: 7Wg8aXuPijrmH4svDmqArMeMAWF3ZusgrznJ6ymprBAN (keys/kpx9-authority.json)
 * New auth:     8pWEfpJas2tgS8iE7ZyHKNjeDSEixqSwK12W4tagNJ3S (keys/crank.json)
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

const ORCA_PROGRAM  = new PublicKey("whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc");
const KPX9_CONFIG   = new PublicKey("KPX9QQP4GLWiRkh4pGpkagwoPGaGixarRQs1LQKb9dt");
const KPX9_EXT      = new PublicKey("GgGRBg8kKd4h5KZcDSLMnHL84g3cEdJRaAfRmushev6A");

// Anchor discriminators (sha256("global:<fn>")[0:8])
const SET_FEE_AUTH          = Buffer.from("1f013257ed656184", "hex");
const SET_COLLECT_AUTH      = Buffer.from("22965df48be1e943", "hex");
const SET_REWARD_AUTH       = Buffer.from("cf05c8d17a3852b7", "hex");
const SET_CONFIG_EXT_AUTH   = Buffer.from("2c5ef17418bc3c8f", "hex");
const SET_TOKEN_BADGE_AUTH  = Buffer.from("cfca0420cd4f0db2", "hex");

function loadKeypair(path: string): Keypair {
  return Keypair.fromSecretKey(
    Uint8Array.from(JSON.parse(fs.readFileSync(path, "utf8")) as number[])
  );
}

function setFeeAuthorityIx(currentAuth: PublicKey, newAuth: PublicKey): TransactionInstruction {
  return new TransactionInstruction({
    programId: ORCA_PROGRAM,
    keys: [
      { pubkey: KPX9_CONFIG, isSigner: false, isWritable: true },
      { pubkey: currentAuth, isSigner: true, isWritable: false },
      { pubkey: newAuth, isSigner: false, isWritable: false },
    ],
    data: SET_FEE_AUTH,
  });
}

function setCollectFeesAuthorityIx(currentAuth: PublicKey, newAuth: PublicKey): TransactionInstruction {
  return new TransactionInstruction({
    programId: ORCA_PROGRAM,
    keys: [
      { pubkey: KPX9_CONFIG, isSigner: false, isWritable: true },
      { pubkey: currentAuth, isSigner: true, isWritable: false },
      { pubkey: newAuth, isSigner: false, isWritable: false },
    ],
    data: SET_COLLECT_AUTH,
  });
}

function setRewardSuperAuthorityIx(currentAuth: PublicKey, newAuth: PublicKey): TransactionInstruction {
  return new TransactionInstruction({
    programId: ORCA_PROGRAM,
    keys: [
      { pubkey: KPX9_CONFIG, isSigner: false, isWritable: true },
      { pubkey: currentAuth, isSigner: true, isWritable: false },
      { pubkey: newAuth, isSigner: false, isWritable: false },
    ],
    data: SET_REWARD_AUTH,
  });
}

function setConfigExtAuthorityIx(currentAuth: PublicKey, newAuth: PublicKey): TransactionInstruction {
  return new TransactionInstruction({
    programId: ORCA_PROGRAM,
    keys: [
      { pubkey: KPX9_CONFIG, isSigner: false, isWritable: false },
      { pubkey: KPX9_EXT, isSigner: false, isWritable: true },
      { pubkey: currentAuth, isSigner: true, isWritable: false },
      { pubkey: newAuth, isSigner: false, isWritable: false },
    ],
    data: SET_CONFIG_EXT_AUTH,
  });
}

function setTokenBadgeAuthorityIx(currentAuth: PublicKey, newAuth: PublicKey): TransactionInstruction {
  return new TransactionInstruction({
    programId: ORCA_PROGRAM,
    keys: [
      { pubkey: KPX9_CONFIG, isSigner: false, isWritable: false },
      { pubkey: KPX9_EXT, isSigner: false, isWritable: true },
      { pubkey: currentAuth, isSigner: true, isWritable: false },
      { pubkey: newAuth, isSigner: false, isWritable: false },
    ],
    data: SET_TOKEN_BADGE_AUTH,
  });
}

async function main() {
  const rpcUrl = process.env.SOLANA_RPC_URL || process.env.RPC_URL || "https://api.mainnet-beta.solana.com";
  const dryRun = process.env.DRY_RUN !== "false";
  const allowLive = process.env.ALLOW_LIVE === "true";
  const connection = new Connection(rpcUrl, "confirmed");

  const authPath = process.env.KPX9_AUTH_PATH || "keys/kpx9-authority.json";
  const crankPath = process.env.CRANK_KEY_PATH || "keys/crank.json";

  const kpx9Auth = loadKeypair(authPath);
  const crank = loadKeypair(crankPath);
  const newAuth = crank.publicKey;

  console.log("=== KPX9 AUTHORITY TRANSFER ===");
  console.log(`current_auth: ${kpx9Auth.publicKey.toBase58()}`);
  console.log(`new_auth:     ${newAuth.toBase58()} (crank)`);
  console.log(`kpx9_config:  ${KPX9_CONFIG.toBase58()}`);
  console.log(`kpx9_ext:     ${KPX9_EXT.toBase58()}`);
  console.log(`dry_run:      ${dryRun}`);

  if (!kpx9Auth.publicKey.equals(new PublicKey("7Wg8aXuPijrmH4svDmqArMeMAWF3ZusgrznJ6ymprBAN"))) {
    throw new Error(`kpx9-authority pubkey mismatch: ${kpx9Auth.publicKey.toBase58()}`);
  }

  const ixs: TransactionInstruction[] = [
    setFeeAuthorityIx(kpx9Auth.publicKey, newAuth),
    setCollectFeesAuthorityIx(kpx9Auth.publicKey, newAuth),
    setRewardSuperAuthorityIx(kpx9Auth.publicKey, newAuth),
    setConfigExtAuthorityIx(kpx9Auth.publicKey, newAuth),
    // After setConfigExtAuth runs, config_extension_authority in GgGRBg8 = newAuth (crank).
    // setTokenBadgeAuth requires config_extension_authority to sign → use newAuth as signer.
    setTokenBadgeAuthorityIx(newAuth, newAuth),
  ];

  const tx = new Transaction().add(...ixs);
  tx.recentBlockhash = (await connection.getLatestBlockhash("confirmed")).blockhash;
  tx.feePayer = crank.publicKey;

  const receipt: Record<string, unknown> = {
    kpx9Config: KPX9_CONFIG.toBase58(),
    kpx9Extension: KPX9_EXT.toBase58(),
    fromAuthority: kpx9Auth.publicKey.toBase58(),
    toAuthority: newAuth.toBase58(),
    dryRun,
    signature: null as string | null,
    verdict: "",
  };

  if (dryRun || !allowLive) {
    const sim = await connection.simulateTransaction(tx);
    receipt.verdict = sim.value.err ? "SIM_FAILED" : "SIM_OK";
    receipt.simErr = sim.value.err ?? null;
    receipt.simLogs = sim.value.logs?.slice(-10) ?? [];
    console.log(`\nSIM: ${receipt.verdict}`);
    if (sim.value.err) {
      console.log("err:", sim.value.err);
      console.log("logs:", (receipt.simLogs as string[]).join("\n"));
      process.exitCode = 1;
    }
  } else {
    const sig = await sendAndConfirmTransaction(connection, tx, [crank, kpx9Auth], { commitment: "confirmed" });
    receipt.verdict = "EXECUTED";
    receipt.signature = sig;
    console.log(`\nEXECUTED: ${sig}`);
    console.log(`All 5 KPX9 authorities transferred → crank (${newAuth.toBase58()})`);
  }

  const out = writeReceipt("KPX9-AUTHORITY-TRANSFER", receipt);
  console.log(`Receipt: ${out}`);
}

main().catch((e) => { console.error(e); process.exitCode = 1; });
