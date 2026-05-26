/**
 * Crea un nuevo token T22 (Token-2022) con TransferFeeConfig de 1bps.
 * 
 * Authorities:
 *   - mintAuthority     = crank
 *   - transferFeeConfigAuthority = crank
 *   - withdrawWithheldAuthority  = crank
 * 
 * ENV:
 *   ARC_TOKEN_NAME="ARC"
 *   ARC_TOKEN_SYMBOL="ARC"
 *   ARC_TOKEN_DECIMALS=6
 *   ARC_TRANSFER_FEE_BPS=1
 *   ARC_INITIAL_SUPPLY_MICRO=100000000000000  (100M tokens with 6 decimals)
 *   DRY_RUN=true
 *   ALLOW_LIVE=false
 */

import "dotenv/config";
import dotenv from "dotenv";
import fs from "node:fs";
import path from "node:path";
import {
  Connection,
  Keypair,
  SystemProgram,
  Transaction,
  sendAndConfirmTransaction,
} from "@solana/web3.js";
import {
  createAssociatedTokenAccountIdempotentInstruction,
  createInitializeMintInstruction,
  createInitializeTransferFeeConfigInstruction,
  createMintToInstruction,
  ExtensionType,
  getAssociatedTokenAddressSync,
  getMintLen,
  TOKEN_2022_PROGRAM_ID,
} from "@solana/spl-token";
import { writeReceipt } from "../utils/receipt.js";

if (process.env.ENV_PATH) {
  dotenv.config({ path: process.env.ENV_PATH, override: true });
}

function loadKeypair(file: string): Keypair {
  return Keypair.fromSecretKey(
    Uint8Array.from(JSON.parse(fs.readFileSync(file, "utf8")) as number[])
  );
}

function saveKeypair(file: string): Keypair {
  if (fs.existsSync(file)) {
    console.log(`Keypair already exists at ${file}, reusing.`);
    return loadKeypair(file);
  }
  const kp = Keypair.generate();
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  fs.writeFileSync(file, JSON.stringify(Array.from(kp.secretKey)), { mode: 0o600 });
  console.log(`New keypair saved to ${file} pubkey=${kp.publicKey.toBase58()}`);
  return kp;
}

async function main() {
  const rpcUrl = process.env.SOLANA_RPC_URL || process.env.RPC_URL || "https://api.mainnet-beta.solana.com";
  const dryRun = process.env.DRY_RUN !== "false";
  const allowLive = process.env.ALLOW_LIVE === "true";
  const connection = new Connection(rpcUrl, "confirmed");

  const crank = loadKeypair(process.env.CRANK_KEYPAIR_PATH || "keys/crank.json");
  const mintKeypair = saveKeypair(process.env.ARC_MINT_KEYPAIR_PATH || "keys/arc-mint.json");

  const name = process.env.ARC_TOKEN_NAME || "ARC";
  const symbol = process.env.ARC_TOKEN_SYMBOL || "ARC";
  const decimals = Number(process.env.ARC_TOKEN_DECIMALS || "6");
  const basisPoints = Number(process.env.ARC_TRANSFER_FEE_BPS || "1");
  const maxFee = BigInt(process.env.ARC_MAX_FEE || "18446744073709551615");
  const mintUnits = BigInt(process.env.ARC_INITIAL_SUPPLY_MICRO || "100000000000000"); // 100M

  const existing = await connection.getAccountInfo(mintKeypair.publicKey, "confirmed");
  if (existing) {
    console.log(`Mint already exists: ${mintKeypair.publicKey.toBase58()}`);
    console.log("If you want a NEW token, delete the keypair file first.");
    return;
  }

  const escrowAta = getAssociatedTokenAddressSync(
    mintKeypair.publicKey,
    crank.publicKey,
    false,
    TOKEN_2022_PROGRAM_ID
  );

  const mintLen = getMintLen([ExtensionType.TransferFeeConfig]);
  const rent = await connection.getMinimumBalanceForRentExemption(mintLen);

  const tx = new Transaction().add(
    SystemProgram.createAccount({
      fromPubkey: crank.publicKey,
      newAccountPubkey: mintKeypair.publicKey,
      space: mintLen,
      lamports: rent,
      programId: TOKEN_2022_PROGRAM_ID,
    }),
    createInitializeTransferFeeConfigInstruction(
      mintKeypair.publicKey,
      crank.publicKey, // withdrawWithheldAuthority
      crank.publicKey, // transferFeeConfigAuthority
      basisPoints,
      maxFee,
      TOKEN_2022_PROGRAM_ID
    ),
    createInitializeMintInstruction(
      mintKeypair.publicKey,
      decimals,
      crank.publicKey,
      null,
      TOKEN_2022_PROGRAM_ID
    ),
    createAssociatedTokenAccountIdempotentInstruction(
      crank.publicKey,
      escrowAta,
      crank.publicKey,
      mintKeypair.publicKey,
      TOKEN_2022_PROGRAM_ID
    ),
    createMintToInstruction(
      mintKeypair.publicKey,
      escrowAta,
      crank.publicKey,
      mintUnits,
      [],
      TOKEN_2022_PROGRAM_ID
    )
  );

  if (dryRun || !allowLive) {
    tx.recentBlockhash = (await connection.getLatestBlockhash("confirmed")).blockhash;
    tx.feePayer = crank.publicKey;
    tx.partialSign(crank, mintKeypair);
    const sim = await connection.simulateTransaction(tx);
    console.log("SIM:", sim.value.err ? "FAILED" : "OK");
    if (sim.value.err) {
      console.log("ERR:", JSON.stringify(sim.value.err));
      console.log("LOGS:", sim.value.logs?.slice(-6));
    } else {
      console.log("Units:", sim.value.unitsConsumed);
    }
  } else {
    const signature = await sendAndConfirmTransaction(connection, tx, [crank, mintKeypair], {
      commitment: "confirmed",
    });
    console.log(`EXECUTED: ${signature}`);
    console.log(`Mint: ${mintKeypair.publicKey.toBase58()}`);
    console.log(`Escrow ATA: ${escrowAta.toBase58()}`);
    console.log(`Supply: ${Number(mintUnits) / 10 ** decimals} ${symbol}`);
    console.log(`Fee: ${basisPoints} bps`);
  }

  const receipt = {
    verdict: dryRun || !allowLive ? "SIM" : "EXECUTED",
    mint: mintKeypair.publicKey.toBase58(),
    name,
    symbol,
    decimals,
    feeBps: basisPoints,
    maxFee: maxFee.toString(),
    initialSupply: Number(mintUnits) / 10 ** decimals,
    escrowAta: escrowAta.toBase58(),
    authority: crank.publicKey.toBase58(),
    dryRun,
  };
  writeReceipt("init-arc-mint", receipt);
}

main().catch((e) => { console.error(e); process.exitCode = 1; });
