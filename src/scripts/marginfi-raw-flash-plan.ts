import "dotenv/config";
import dotenv from "dotenv";
import fs from "node:fs";
import { PublicKey, TransactionInstruction } from "@solana/web3.js";
import { writeReceipt } from "../utils/receipt.js";

if (process.env.ENV_PATH) {
  dotenv.config({ path: process.env.ENV_PATH, override: true });
}

const MARGINFI_PROGRAM = new PublicKey("MFv2hWf31Z9kbCa1snEPYctwafyhdvnV7FZnsebVacA");
const IX_SYSVAR = new PublicKey("Sysvar1nstructions1111111111111111111111111");
const START = Buffer.from([14, 131, 33, 220, 81, 186, 180, 107]);
const END = Buffer.from([105, 124, 201, 106, 153, 2, 8, 156]);

function pubkeyFromKeypair(file: string): PublicKey {
  const secret = Uint8Array.from(JSON.parse(fs.readFileSync(file, "utf8")) as number[]);
  return new PublicKey(secret.slice(32, 64));
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

function main() {
  const authority = pubkeyFromKeypair(process.env.CRANK_KEYPAIR_PATH || "keys/crank.json");
  const marginfiAccount = pubkeyFromKeypair(process.env.MARGINFI_ACCOUNT_KEYPAIR_PATH || "keys/marginfi-account.json");
  const bodyInstructionCount = Number(process.env.FLASH_BODY_IX_COUNT || "7");
  const startIndex = Number(process.env.FLASH_START_INDEX || "0");
  const endIndex = BigInt(startIndex + bodyInstructionCount + 1);
  const start = startFlashIx({ marginfiAccount, authority, endIndex });
  const end = endFlashIx({ marginfiAccount, authority });

  const receipt = {
    verdict: "MARGINFI_RAW_FLASH_PLAN_READY_NO_SEND",
    generatedAt: new Date().toISOString(),
    mode: "instruction builder only; no transaction sent",
    marginfiProgram: MARGINFI_PROGRAM.toBase58(),
    marginfiAccount: marginfiAccount.toBase58(),
    authority: authority.toBase58(),
    bodyInstructionCount,
    startIndex,
    endIndex: endIndex.toString(),
    instructions: {
      start: {
        programId: start.programId.toBase58(),
        keys: start.keys.map((key) => ({
          pubkey: key.pubkey.toBase58(),
          isSigner: key.isSigner,
          isWritable: key.isWritable
        })),
        dataHex: start.data.toString("hex")
      },
      end: {
        programId: end.programId.toBase58(),
        keys: end.keys.map((key) => ({
          pubkey: key.pubkey.toBase58(),
          isSigner: key.isSigner,
          isWritable: key.isWritable
        })),
        dataHex: end.data.toString("hex")
      }
    },
    next: "Wrap current RedemptionArc body with these instructions and simulate exact v0 transaction."
  };

  const out = writeReceipt("REDEMPTION-MARGINFI-RAW-FLASH-PLAN-LATEST.json", receipt);
  console.log(`${receipt.verdict} account=${receipt.marginfiAccount} endIndex=${receipt.endIndex} receipt=${out}`);
}

main();
