import "dotenv/config";
import dotenv from "dotenv";
import fs from "node:fs";
import {
  Keypair,
  PublicKey,
  TransactionInstruction,
  TransactionMessage,
  VersionedTransaction
} from "@solana/web3.js";
import { TOKEN_PROGRAM_ID } from "@solana/spl-token";
import { loadConfig } from "../config.js";
import { connectionFor } from "../utils/rpc.js";
import { writeReceipt } from "../utils/receipt.js";

if (process.env.ENV_PATH) {
  dotenv.config({ path: process.env.ENV_PATH, override: true });
}

const MARGINFI_PROGRAM = new PublicKey("MFv2hWf31Z9kbCa1snEPYctwafyhdvnV7FZnsebVacA");
const MARGINFI_GROUP = new PublicKey("4qp6Fx6tnZkY5Wropq9wUYgtFxXKwE6viZxFHg3rdAG8");
const IX_SYSVAR = new PublicKey("Sysvar1nstructions1111111111111111111111111");
const USDC_BANK = new PublicKey("2s37akK2eyBbp8DZgCm7RtsaEz8eJP3Nxd4urLHQv7yB");
const USDC_LIQUIDITY_VAULT = new PublicKey("7jaiZR5Sk8hdYN9MxTpczTcwbWpb5WEoxSANuUwveuat");
const START = Buffer.from([14, 131, 33, 220, 81, 186, 180, 107]);
const END = Buffer.from([105, 124, 201, 106, 153, 2, 8, 156]);
const BORROW = Buffer.from([4, 126, 116, 53, 48, 5, 212, 31]);
const REPAY = Buffer.from([79, 209, 172, 177, 222, 51, 173, 151]);

function loadKeypair(file: string): Keypair {
  return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(file, "utf8")) as number[]));
}

function u64Le(value: bigint): Buffer {
  const out = Buffer.alloc(8);
  out.writeBigUInt64LE(value);
  return out;
}

function marginfiAccount(): PublicKey {
  const secret = Uint8Array.from(JSON.parse(fs.readFileSync(process.env.MARGINFI_ACCOUNT_KEYPAIR_PATH || "keys/marginfi-account.json", "utf8")) as number[]);
  return new PublicKey(secret.slice(32, 64));
}

function startIx(account: PublicKey, authority: PublicKey, endIndex: bigint): TransactionInstruction {
  return new TransactionInstruction({
    programId: MARGINFI_PROGRAM,
    keys: [
      { pubkey: account, isSigner: false, isWritable: true },
      { pubkey: authority, isSigner: true, isWritable: false },
      { pubkey: IX_SYSVAR, isSigner: false, isWritable: false }
    ],
    data: Buffer.concat([START, u64Le(endIndex)])
  });
}

function endIx(account: PublicKey, authority: PublicKey): TransactionInstruction {
  return new TransactionInstruction({
    programId: MARGINFI_PROGRAM,
    keys: [
      { pubkey: account, isSigner: false, isWritable: true },
      { pubkey: authority, isSigner: true, isWritable: false }
    ],
    data: END
  });
}

function borrowIx(args: { account: PublicKey; authority: PublicKey; ghostUsdcAta: PublicKey; amount: bigint }): TransactionInstruction {
  const [vaultAuthority] = PublicKey.findProgramAddressSync(
    [Buffer.from("liquidity_vault_auth"), USDC_BANK.toBuffer()],
    MARGINFI_PROGRAM
  );
  return new TransactionInstruction({
    programId: MARGINFI_PROGRAM,
    keys: [
      { pubkey: MARGINFI_GROUP, isSigner: false, isWritable: false },
      { pubkey: args.account, isSigner: false, isWritable: true },
      { pubkey: args.authority, isSigner: true, isWritable: false },
      { pubkey: USDC_BANK, isSigner: false, isWritable: true },
      { pubkey: args.ghostUsdcAta, isSigner: false, isWritable: true },
      { pubkey: vaultAuthority, isSigner: false, isWritable: false },
      { pubkey: USDC_LIQUIDITY_VAULT, isSigner: false, isWritable: true },
      { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false }
    ],
    data: Buffer.concat([BORROW, u64Le(args.amount)])
  });
}

function repayIx(args: { account: PublicKey; authority: PublicKey; ghostUsdcAta: PublicKey; amount: bigint }): TransactionInstruction {
  return new TransactionInstruction({
    programId: MARGINFI_PROGRAM,
    keys: [
      { pubkey: MARGINFI_GROUP, isSigner: false, isWritable: false },
      { pubkey: args.account, isSigner: false, isWritable: true },
      { pubkey: args.authority, isSigner: true, isWritable: false },
      { pubkey: USDC_BANK, isSigner: false, isWritable: true },
      { pubkey: args.ghostUsdcAta, isSigner: false, isWritable: true },
      { pubkey: USDC_LIQUIDITY_VAULT, isSigner: false, isWritable: true },
      { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false }
    ],
    // repay_all: Option<bool> = None => 0x00
    data: Buffer.concat([REPAY, u64Le(args.amount), Buffer.from([0])])
  });
}

async function main() {
  const config = loadConfig();
  if (!config.crank) throw new Error("Missing REDEMPTION_CRANK");
  const connection = connectionFor(config.rpcUrl);
  const crank = loadKeypair(process.env.CRANK_KEYPAIR_PATH || "keys/crank.json");
  const account = marginfiAccount();
  const amount = BigInt(Math.floor(Number(process.env.MARGINFI_FLASH_TEST_USDC || "39") * 1e6));
  const ghostUsdcAta = new PublicKey(process.env.GHOST_USDC_ATA || "5BK5sqF2vH8o1BBrSukV44ujpu19rpgvJFedGC8GzF9X");
  const body = [
    borrowIx({ account, authority: crank.publicKey, ghostUsdcAta, amount }),
    repayIx({ account, authority: crank.publicKey, ghostUsdcAta, amount })
  ];
  const instructions = [
    startIx(account, crank.publicKey, 3n),
    ...body,
    endIx(account, crank.publicKey)
  ];
  const msg = new TransactionMessage({
    payerKey: crank.publicKey,
    recentBlockhash: (await connection.getLatestBlockhash("confirmed")).blockhash,
    instructions
  }).compileToV0Message();
  const tx = new VersionedTransaction(msg);
  tx.sign([crank]);
  const sim = await connection.simulateTransaction(tx, {
    replaceRecentBlockhash: true,
    sigVerify: false,
    commitment: "confirmed"
  });

  const receipt = {
    verdict: sim.value.err ? "MARGINFI_RAW_BORROW_REPAY_SIM_FAILED" : "MARGINFI_RAW_BORROW_REPAY_SIM_OK",
    generatedAt: new Date().toISOString(),
    mode: "no-send simulation",
    amountUsdc: Number(amount) / 1e6,
    marginfiAccount: account.toBase58(),
    usdcBank: USDC_BANK.toBase58(),
    liquidityVault: USDC_LIQUIDITY_VAULT.toBase58(),
    ghostUsdcAta: ghostUsdcAta.toBase58(),
    err: sim.value.err,
    unitsConsumed: sim.value.unitsConsumed ?? null,
    logs: sim.value.logs ?? []
  };
  const out = writeReceipt("REDEMPTION-MARGINFI-RAW-BORROW-REPAY-SIM-LATEST.json", receipt);
  console.log(`${receipt.verdict} cu=${receipt.unitsConsumed ?? "n/a"} receipt=${out}`);
  if (sim.value.err) process.exitCode = 1;
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
