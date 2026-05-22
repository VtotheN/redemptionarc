import "dotenv/config";
import dotenv from "dotenv";
import fs from "node:fs";
import path from "node:path";
import {
  Keypair,
  SystemProgram,
  Transaction,
  sendAndConfirmTransaction
} from "@solana/web3.js";
import {
  createAssociatedTokenAccountIdempotentInstruction,
  createInitializeMintInstruction,
  createInitializeTransferFeeConfigInstruction,
  createMintToInstruction,
  ExtensionType,
  getAssociatedTokenAddressSync,
  getMintLen,
  TOKEN_2022_PROGRAM_ID
} from "@solana/spl-token";
import { loadConfig } from "../config.js";
import { connectionFor } from "../utils/rpc.js";
import { writeReceipt } from "../utils/receipt.js";

if (process.env.ENV_PATH) {
  dotenv.config({ path: process.env.ENV_PATH, override: true });
}

function loadKeypair(file: string): Keypair {
  return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(file, "utf8")) as number[]));
}

function saveKeypairIfMissing(file: string): Keypair {
  if (fs.existsSync(file)) return loadKeypair(file);
  const keypair = Keypair.generate();
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  fs.writeFileSync(file, JSON.stringify(Array.from(keypair.secretKey)), { mode: 0o600 });
  return keypair;
}

async function main() {
  const config = loadConfig();
  if (!config.crank || !config.withdrawAuthority) {
    throw new Error("Missing REDEMPTION_CRANK or REDEMPTION_WITHDRAW_AUTHORITY");
  }

  const connection = connectionFor(config.rpcUrl);
  const crank = loadKeypair(process.env.CRANK_KEYPAIR_PATH || "keys/crank.json");
  const withdrawAuthority = loadKeypair(process.env.WITHDRAW_AUTHORITY_KEYPAIR_PATH || "keys/withdraw-authority.json");
  const mintKeypair = saveKeypairIfMissing("keys/redemption-hop-mint.json");
  const existing = await connection.getAccountInfo(mintKeypair.publicKey, "confirmed");
  const decimals = 6;
  const basisPoints = Number(process.env.REDEMPTION_HOP_TRANSFER_FEE_BPS || "690");
  const maxFee = BigInt(process.env.REDEMPTION_HOP_MAX_FEE_MICRO || "18446744073709551615");
  const mintUnits = BigInt(process.env.REDEMPTION_HOP_INITIAL_SUPPLY_MICRO || "10000000000000");
  const escrowAta = getAssociatedTokenAddressSync(
    mintKeypair.publicKey,
    crank.publicKey,
    false,
    TOKEN_2022_PROGRAM_ID
  );

  if (existing) {
    const receipt = {
      verdict: "REDEMPTION_HOP_MINT_ALREADY_EXISTS",
      generatedAt: new Date().toISOString(),
      mint: mintKeypair.publicKey.toBase58(),
      escrowAta: escrowAta.toBase58()
    };
    const out = writeReceipt("REDEMPTION-HOP-MINT-INIT-LATEST.json", receipt);
    console.log(`${receipt.verdict} mint=${receipt.mint} receipt=${out}`);
    return;
  }

  const mintLen = getMintLen([ExtensionType.TransferFeeConfig]);
  const rent = await connection.getMinimumBalanceForRentExemption(mintLen);
  const tx = new Transaction().add(
    SystemProgram.createAccount({
      fromPubkey: crank.publicKey,
      newAccountPubkey: mintKeypair.publicKey,
      space: mintLen,
      lamports: rent,
      programId: TOKEN_2022_PROGRAM_ID
    }),
    createInitializeTransferFeeConfigInstruction(
      mintKeypair.publicKey,
      withdrawAuthority.publicKey,
      withdrawAuthority.publicKey,
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

  const signature = await sendAndConfirmTransaction(connection, tx, [crank, mintKeypair], {
    commitment: "confirmed"
  });

  const receipt = {
    verdict: "REDEMPTION_HOP_MINT_CREATED",
    generatedAt: new Date().toISOString(),
    signature,
    mint: mintKeypair.publicKey.toBase58(),
    escrowAta: escrowAta.toBase58(),
    decimals,
    transferFeeBps: basisPoints,
    maxFee: maxFee.toString(),
    initialSupplyMicro: mintUnits.toString(),
    authority: crank.publicKey.toBase58(),
    withdrawAuthority: withdrawAuthority.publicKey.toBase58(),
    nextEnv: `HOP_MINT=${mintKeypair.publicKey.toBase58()}`
  };
  const out = writeReceipt("REDEMPTION-HOP-MINT-INIT-LATEST.json", receipt);
  console.log(`${receipt.verdict} mint=${receipt.mint} sig=${signature} receipt=${out}`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
