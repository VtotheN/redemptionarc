import "dotenv/config";
import dotenv from "dotenv";
import fs from "node:fs";
import {
  Keypair,
  Transaction,
  sendAndConfirmTransaction
} from "@solana/web3.js";
import {
  createAssociatedTokenAccountIdempotentInstruction,
  getAssociatedTokenAddressSync,
  NATIVE_MINT,
  TOKEN_2022_PROGRAM_ID,
  TOKEN_PROGRAM_ID
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

async function main() {
  const config = loadConfig();
  if (!config.treasury || !config.crank) throw new Error("Missing treasury/crank");
  const connection = connectionFor(config.rpcUrl);
  const crank = loadKeypair(process.env.CRANK_KEYPAIR_PATH || "keys/crank.json");
  const ringPaths = (process.env.RING_KEYPAIR_PATHS || "./keys/ring1.json,./keys/ring2.json,./keys/ring3.json,./keys/ring4.json")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
  const rings = ringPaths.map(loadKeypair);

  const atas = [
    {
      label: "ghostUsdc",
      address: getAssociatedTokenAddressSync(config.usdcMint, crank.publicKey, false, TOKEN_PROGRAM_ID),
      owner: crank.publicKey,
      mint: config.usdcMint,
      programId: TOKEN_PROGRAM_ID
    },
    {
      label: "treasuryUsdc",
      address: getAssociatedTokenAddressSync(config.usdcMint, config.treasury, false, TOKEN_PROGRAM_ID),
      owner: config.treasury,
      mint: config.usdcMint,
      programId: TOKEN_PROGRAM_ID
    },
    {
      label: "crankWsol",
      address: getAssociatedTokenAddressSync(NATIVE_MINT, crank.publicKey, false, TOKEN_PROGRAM_ID),
      owner: crank.publicKey,
      mint: NATIVE_MINT,
      programId: TOKEN_PROGRAM_ID
    },
    {
      label: "hopEscrow",
      address: getAssociatedTokenAddressSync(config.hopMint, crank.publicKey, false, TOKEN_2022_PROGRAM_ID),
      owner: crank.publicKey,
      mint: config.hopMint,
      programId: TOKEN_2022_PROGRAM_ID
    },
    {
      label: "treasuryHop",
      address: getAssociatedTokenAddressSync(config.hopMint, config.treasury, false, TOKEN_2022_PROGRAM_ID),
      owner: config.treasury,
      mint: config.hopMint,
      programId: TOKEN_2022_PROGRAM_ID
    },
    ...rings.map((ring, index) => ({
      label: `ring${index + 1}Hop`,
      address: getAssociatedTokenAddressSync(config.hopMint, ring.publicKey, false, TOKEN_2022_PROGRAM_ID),
      owner: ring.publicKey,
      mint: config.hopMint,
      programId: TOKEN_2022_PROGRAM_ID
    }))
  ];

  const tx = new Transaction();
  for (const ata of atas) {
    tx.add(
      createAssociatedTokenAccountIdempotentInstruction(
        crank.publicKey,
        ata.address,
        ata.owner,
        ata.mint,
        ata.programId
      )
    );
  }

  const signature = await sendAndConfirmTransaction(connection, tx, [crank], {
    commitment: "confirmed"
  });

  const receipt = {
    verdict: "REDEMPTION_CYCLE_ACCOUNTS_READY",
    generatedAt: new Date().toISOString(),
    signature,
    payer: crank.publicKey.toBase58(),
    hopMint: config.hopMint.toBase58(),
    atas: atas.map((ata) => ({
      label: ata.label,
      address: ata.address.toBase58(),
      owner: ata.owner.toBase58(),
      mint: ata.mint.toBase58(),
      programId: ata.programId.toBase58()
    }))
  };
  const out = writeReceipt("REDEMPTION-CYCLE-ACCOUNTS-LATEST.json", receipt);
  console.log(`${receipt.verdict} sig=${signature} receipt=${out}`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
