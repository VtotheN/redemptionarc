import "dotenv/config";
import dotenv from "dotenv";
import fs from "node:fs";
import {
  Keypair,
  PublicKey,
  SystemProgram,
  Transaction,
  TransactionInstruction,
  VersionedTransaction,
  sendAndConfirmTransaction
} from "@solana/web3.js";
import { loadConfig } from "../config.js";
import { connectionFor } from "../utils/rpc.js";
import { writeReceipt } from "../utils/receipt.js";

if (process.env.ENV_PATH) {
  dotenv.config({ path: process.env.ENV_PATH, override: true });
}

const JUPITER_API = "https://api.jup.ag/swap/v1";

function loadKeypair(file: string): Keypair {
  return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(file, "utf8")) as number[]));
}

function ix(raw: any): TransactionInstruction | null {
  if (!raw?.programId || !raw?.accounts || !raw?.data) return null;
  return new TransactionInstruction({
    programId: new PublicKey(raw.programId),
    keys: raw.accounts.map((account: any) => ({
      pubkey: new PublicKey(account.pubkey),
      isSigner: account.isSigner,
      isWritable: account.isWritable
    })),
    data: Buffer.from(raw.data, "base64")
  });
}

async function main() {
  const config = loadConfig();
  if (!config.crank) throw new Error("Missing REDEMPTION_CRANK");
  const connection = connectionFor(config.rpcUrl);
  const treasury = loadKeypair(process.env.TREASURY_KEYPAIR_PATH || "keys/treasury.json");
  const usdcAmount = Number(process.env.REFILL_USDC_AMOUNT || "30");
  const keepTreasurySol = Number(process.env.REFILL_KEEP_TREASURY_SOL || "0.01");
  const transferRatio = Number(process.env.REFILL_TRANSFER_RATIO || "0.9");
  const amountMicro = Math.floor(usdcAmount * 1_000_000);

  const preTreasurySol = await connection.getBalance(treasury.publicKey, "confirmed");
  const preCrankSol = await connection.getBalance(config.crank, "confirmed");

  const quoteUrl =
    `${JUPITER_API}/quote?inputMint=${config.usdcMint.toBase58()}` +
    `&outputMint=So11111111111111111111111111111111111111112&amount=${amountMicro}&slippageBps=100`;
  const quote = await (await fetch(quoteUrl)).json() as any;
  if (quote.error) throw new Error(quote.error);

  const swapBody = {
    quoteResponse: quote,
    userPublicKey: treasury.publicKey.toBase58(),
    wrapAndUnwrapSol: true,
    dynamicComputeUnitLimit: true,
    prioritizationFeeLamports: 10_000
  };
  const swapData = await (await fetch(`${JUPITER_API}/swap`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(swapBody)
  })).json() as any;
  if (swapData.error) throw new Error(swapData.error);
  if (!swapData.swapTransaction) throw new Error("Jupiter did not return swapTransaction");

  const swapTx = VersionedTransaction.deserialize(Buffer.from(swapData.swapTransaction, "base64"));
  swapTx.sign([treasury]);
  const swapSignature = await connection.sendRawTransaction(swapTx.serialize(), {
    skipPreflight: false,
    preflightCommitment: "confirmed",
    maxRetries: 3
  });
  await connection.confirmTransaction(swapSignature, "confirmed");

  const postSwapTreasurySol = await connection.getBalance(treasury.publicKey, "confirmed");
  const transferable = Math.max(0, postSwapTreasurySol - Math.floor(keepTreasurySol * 1e9));
  const transferLamports = Math.floor(transferable * transferRatio);
  if (transferLamports <= 0) throw new Error("No transferable SOL after swap");

  const transferTx = new Transaction().add(
    SystemProgram.transfer({
      fromPubkey: treasury.publicKey,
      toPubkey: config.crank,
      lamports: transferLamports
    })
  );
  const transferSignature = await sendAndConfirmTransaction(connection, transferTx, [treasury], {
    commitment: "confirmed"
  });

  const postTreasurySol = await connection.getBalance(treasury.publicKey, "confirmed");
  const postCrankSol = await connection.getBalance(config.crank, "confirmed");

  const receipt = {
    verdict: "REDEMPTION_CRANK_REFILLED",
    generatedAt: new Date().toISOString(),
    usdcAmount,
    quoteOutSol: Number(quote.outAmount) / 1e9,
    swapSignature,
    transferSignature,
    transferSol: transferLamports / 1e9,
    balances: {
      preTreasurySol: preTreasurySol / 1e9,
      preCrankSol: preCrankSol / 1e9,
      postTreasurySol: postTreasurySol / 1e9,
      postCrankSol: postCrankSol / 1e9
    }
  };

  const out = writeReceipt("REDEMPTION-CRANK-REFILL-LATEST.json", receipt);
  console.log(`${receipt.verdict} transferSol=${receipt.transferSol.toFixed(6)} crank=${receipt.balances.postCrankSol.toFixed(6)} receipt=${out}`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
