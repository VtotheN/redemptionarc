import "dotenv/config";
import dotenv from "dotenv";
import fs from "node:fs";
import {
  Keypair,
  PublicKey,
  TransactionMessage,
  VersionedTransaction,
  TransactionInstruction
} from "@solana/web3.js";
import { loadConfig } from "../config.js";
import { connectionFor } from "../utils/rpc.js";
import { writeReceipt } from "../utils/receipt.js";

if (process.env.ENV_PATH) {
  dotenv.config({ path: process.env.ENV_PATH, override: true });
}

const MARGINFI_PROGRAM = new PublicKey("MFv2hWf31Z9kbCa1snEPYctwafyhdvnV7FZnsebVacA");
const IX_SYSVAR = new PublicKey("Sysvar1nstructions1111111111111111111111111");
const START = Buffer.from([14, 131, 33, 220, 81, 186, 180, 107]);
const END = Buffer.from([105, 124, 201, 106, 153, 2, 8, 156]);

function loadKeypair(file: string): Keypair {
  return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(file, "utf8")) as number[]));
}

function u64Le(value: bigint): Buffer {
  const out = Buffer.alloc(8);
  out.writeBigUInt64LE(value);
  return out;
}

function startFlashIx(args: { marginfiAccount: PublicKey; authority: PublicKey; endIndex: bigint }): TransactionInstruction {
  return new TransactionInstruction({
    programId: MARGINFI_PROGRAM,
    keys: [
      { pubkey: args.marginfiAccount, isSigner: false, isWritable: true },
      { pubkey: args.authority, isSigner: true, isWritable: false },
      { pubkey: IX_SYSVAR, isSigner: false, isWritable: false }
    ],
    data: Buffer.concat([START, u64Le(args.endIndex)])
  });
}

function endFlashIx(args: { marginfiAccount: PublicKey; authority: PublicKey }): TransactionInstruction {
  return new TransactionInstruction({
    programId: MARGINFI_PROGRAM,
    keys: [
      { pubkey: args.marginfiAccount, isSigner: false, isWritable: true },
      { pubkey: args.authority, isSigner: true, isWritable: false }
    ],
    data: END
  });
}

async function main() {
  const config = loadConfig();
  const connection = connectionFor(config.rpcUrl);
  const crank = loadKeypair(process.env.CRANK_KEYPAIR_PATH || "keys/crank.json");
  const marginfiAccount = loadKeypair(process.env.MARGINFI_ACCOUNT_KEYPAIR_PATH || "keys/marginfi-account.json");
  const body: TransactionInstruction[] = [];
  const startIndex = 0;
  const endIndex = BigInt(startIndex + body.length + 1);
  const instructions = [
    startFlashIx({ marginfiAccount: marginfiAccount.publicKey, authority: crank.publicKey, endIndex }),
    ...body,
    endFlashIx({ marginfiAccount: marginfiAccount.publicKey, authority: crank.publicKey })
  ];

  const message = new TransactionMessage({
    payerKey: crank.publicKey,
    recentBlockhash: (await connection.getLatestBlockhash("confirmed")).blockhash,
    instructions
  }).compileToV0Message();
  const tx = new VersionedTransaction(message);
  tx.sign([crank]);
  const sim = await connection.simulateTransaction(tx, {
    replaceRecentBlockhash: true,
    sigVerify: false,
    commitment: "confirmed"
  });

  const receipt = {
    verdict: sim.value.err ? "MARGINFI_RAW_FLASH_EMPTY_SIM_FAILED" : "MARGINFI_RAW_FLASH_EMPTY_SIM_OK",
    generatedAt: new Date().toISOString(),
    mode: "no-send simulation",
    marginfiAccount: marginfiAccount.publicKey.toBase58(),
    authority: crank.publicKey.toBase58(),
    endIndex: endIndex.toString(),
    err: sim.value.err,
    unitsConsumed: sim.value.unitsConsumed ?? null,
    logs: sim.value.logs ?? []
  };

  const out = writeReceipt("REDEMPTION-MARGINFI-RAW-FLASH-SIM-LATEST.json", receipt);
  console.log(`${receipt.verdict} cu=${receipt.unitsConsumed ?? "n/a"} receipt=${out}`);
  if (sim.value.err) process.exitCode = 1;
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
