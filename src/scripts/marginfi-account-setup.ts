import "dotenv/config";
import dotenv from "dotenv";
import fs from "node:fs";
import {
  Keypair,
  PublicKey,
  SystemProgram,
  Transaction,
  TransactionInstruction,
  sendAndConfirmTransaction
} from "@solana/web3.js";
import { loadConfig } from "../config.js";
import { connectionFor } from "../utils/rpc.js";
import { writeReceipt } from "../utils/receipt.js";

if (process.env.ENV_PATH) {
  dotenv.config({ path: process.env.ENV_PATH, override: true });
}

const MARGINFI_PROGRAM = new PublicKey("MFv2hWf31Z9kbCa1snEPYctwafyhdvnV7FZnsebVacA");
const MARGINFI_GROUP = new PublicKey("4qp6Fx6tnZkY5Wropq9wUYgtFxXKwE6viZxFHg3rdAG8");
const INIT_MARGINFI_ACCOUNT_DISCRIMINATOR = Buffer.from([43, 78, 61, 255, 148, 52, 249, 154]);

function loadKeypair(file: string): Keypair {
  return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(file, "utf8")) as number[]));
}

function marginfiAccountPath(): string {
  return process.env.MARGINFI_ACCOUNT_KEYPAIR_PATH || "keys/marginfi-account.json";
}

function getOrCreateLocalMarginfiKeypair(): Keypair {
  const file = marginfiAccountPath();
  if (fs.existsSync(file)) return loadKeypair(file);
  const keypair = Keypair.generate();
  fs.writeFileSync(file, `${JSON.stringify(Array.from(keypair.secretKey))}\n`, { mode: 0o600 });
  return keypair;
}

async function main() {
  const config = loadConfig();
  const connection = connectionFor(config.rpcUrl);
  const crank = loadKeypair(process.env.CRANK_KEYPAIR_PATH || "keys/crank.json");
  const marginfiAccount = getOrCreateLocalMarginfiKeypair();
  const space = Number(process.env.MARGINFI_ACCOUNT_SPACE || "2304");
  const rentLamports = await connection.getMinimumBalanceForRentExemption(space);
  const crankBefore = await connection.getBalance(crank.publicKey, "confirmed");
  const accountInfo = await connection.getAccountInfo(marginfiAccount.publicKey, "confirmed");

  const initIx = new TransactionInstruction({
    programId: MARGINFI_PROGRAM,
    keys: [
      { pubkey: MARGINFI_GROUP, isSigner: false, isWritable: false },
      { pubkey: marginfiAccount.publicKey, isSigner: true, isWritable: true },
      { pubkey: crank.publicKey, isSigner: true, isWritable: false },
      { pubkey: crank.publicKey, isSigner: true, isWritable: true },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false }
    ],
    data: INIT_MARGINFI_ACCOUNT_DISCRIMINATOR
  });

  const receiptBase = {
    generatedAt: new Date().toISOString(),
    mode: config.allowLive && !config.dryRun ? "live" : "no-send",
    marginfiProgram: MARGINFI_PROGRAM.toBase58(),
    marginfiGroup: MARGINFI_GROUP.toBase58(),
    authority: crank.publicKey.toBase58(),
    marginfiAccount: marginfiAccount.publicKey.toBase58(),
    rentLamports,
    crankBeforeSol: crankBefore / 1e9,
    accountAlreadyExists: Boolean(accountInfo)
  };

  if (accountInfo) {
    const receipt = {
      verdict: "MARGINFI_ACCOUNT_ALREADY_EXISTS",
      ...receiptBase
    };
    const out = writeReceipt("REDEMPTION-MARGINFI-ACCOUNT-SETUP-LATEST.json", receipt);
    console.log(`${receipt.verdict} account=${receipt.marginfiAccount} receipt=${out}`);
    return;
  }

  if (!config.allowLive || config.dryRun) {
    const receipt = {
      verdict: "MARGINFI_ACCOUNT_SETUP_READY_NO_SEND",
      ...receiptBase,
      instructions: [
        "marginfi_account_initialize"
      ],
      next: "Set ALLOW_LIVE=true DRY_RUN=false only when approving this setup transaction."
    };
    const out = writeReceipt("REDEMPTION-MARGINFI-ACCOUNT-SETUP-LATEST.json", receipt);
    console.log(`${receipt.verdict} account=${receipt.marginfiAccount} rentSol=${(rentLamports / 1e9).toFixed(9)} receipt=${out}`);
    return;
  }

  const tx = new Transaction().add(initIx);
  const signature = await sendAndConfirmTransaction(connection, tx, [crank, marginfiAccount], {
    commitment: "confirmed"
  });
  const crankAfter = await connection.getBalance(crank.publicKey, "confirmed");

  const receipt = {
    verdict: "MARGINFI_ACCOUNT_CREATED",
    ...receiptBase,
    signature,
    crankAfterSol: crankAfter / 1e9,
    setupCostSol: (crankBefore - crankAfter) / 1e9
  };
  const out = writeReceipt("REDEMPTION-MARGINFI-ACCOUNT-SETUP-LATEST.json", receipt);
  console.log(`${receipt.verdict} sig=${signature} account=${receipt.marginfiAccount} receipt=${out}`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
