/**
 * One-time: transfer HOP withdrawWithheldAuthority from phantom-crank → arc-crank.
 * After this, arc-crank is sole authority for: ring TX + fee withdrawal.
 */
import "dotenv/config";
import fs from "node:fs";
import {
  Connection, Keypair, PublicKey, Transaction, sendAndConfirmTransaction,
} from "@solana/web3.js";
import {
  TOKEN_2022_PROGRAM_ID, createSetAuthorityInstruction, AuthorityType,
  getMint, getTransferFeeConfig,
} from "@solana/spl-token";
import { writeReceipt } from "../utils/receipt.js";

const HOP_MINT = new PublicKey("HZF5k7h39hkysoSZ4ZfmWc55PhvW7ntVvVqdXFCyYGh3");

function loadKeypair(p: string) {
  return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(p, "utf8")) as number[]));
}

async function main() {
  const rpcUrl = process.env.SOLANA_RPC_URL || "https://api.mainnet-beta.solana.com";
  const dryRun = process.env.DRY_RUN !== "false";
  const allowLive = process.env.ALLOW_LIVE === "true";
  const conn = new Connection(rpcUrl, "confirmed");

  const currentAuthPath = process.env.WITHDRAW_AUTH_PATH || "/Users/velon/.keys/phantom-crank.json";
  const newAuthPath = process.env.NEW_WITHDRAW_AUTH_PATH || "keys/crank.json";

  const currentAuth = loadKeypair(currentAuthPath);
  const newAuth = loadKeypair(newAuthPath);

  const mintInfo = await getMint(conn, HOP_MINT, "confirmed", TOKEN_2022_PROGRAM_ID);
  const feeConfig = getTransferFeeConfig(mintInfo);
  const withdrawAuth = feeConfig?.withdrawWithheldAuthority;

  console.log("withdrawWithheldAuthority:", withdrawAuth?.toBase58());
  console.log("current signer:", currentAuth.publicKey.toBase58());
  console.log("new authority:", newAuth.publicKey.toBase58());

  if (!withdrawAuth?.equals(currentAuth.publicKey)) {
    throw new Error(`Expected current auth ${currentAuth.publicKey.toBase58()} but on-chain is ${withdrawAuth?.toBase58()}`);
  }

  if (withdrawAuth.equals(newAuth.publicKey)) {
    console.log("Already set. Nothing to do.");
    return;
  }

  const ix = createSetAuthorityInstruction(
    HOP_MINT, currentAuth.publicKey, AuthorityType.WithheldWithdraw,
    newAuth.publicKey, [], TOKEN_2022_PROGRAM_ID
  );
  const tx = new Transaction().add(ix);
  tx.recentBlockhash = (await conn.getLatestBlockhash("confirmed")).blockhash;
  tx.feePayer = currentAuth.publicKey;

  if (dryRun || !allowLive) {
    const sim = await conn.simulateTransaction(tx);
    console.log("SIM:", sim.value.err ? "FAILED" : "OK", sim.value.logs?.slice(-4));
  } else {
    const sig = await sendAndConfirmTransaction(conn, tx, [currentAuth], { commitment: "confirmed" });
    console.log("EXECUTED:", sig);
    writeReceipt("set-hop-withdraw-authority", { sig, newAuthority: newAuth.publicKey.toBase58() });
  }
}

main().catch(e => { console.error(e); process.exitCode = 1; });
