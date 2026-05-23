/**
 * Initialize TokenBadge for HOP (T22) on KPX9 config under official Orca.
 * Required before initializing a pool with HOP as one of the tokens.
 *
 * token_badge_authority = crank (transferred in prior session).
 */
import "dotenv/config";
import dotenv from "dotenv";
import fs from "node:fs";
import {
  Connection, Keypair, PublicKey, SystemProgram, Transaction,
  TransactionInstruction, sendAndConfirmTransaction,
} from "@solana/web3.js";
import { writeReceipt } from "../utils/receipt.js";

if (process.env.ENV_PATH) dotenv.config({ path: process.env.ENV_PATH, override: true });

const OFFICIAL_ORCA = new PublicKey("whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc");
const KPX9_CONFIG   = new PublicKey("KPX9QQP4GLWiRkh4pGpkagwoPGaGixarRQs1LQKb9dt");
const KPX9_EXT      = new PublicKey("GgGRBg8kKd4h5KZcDSLMnHL84g3cEdJRaAfRmushev6A");
const HOP_MINT      = new PublicKey("HZF5k7h39hkysoSZ4ZfmWc55PhvW7ntVvVqdXFCyYGh3");

const INIT_TOKEN_BADGE_DISC = Buffer.from([253, 77, 205, 95, 27, 224, 89, 223]);

function loadKeypair(p: string): Keypair {
  return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(p, "utf8")) as number[]));
}

function deriveTokenBadge(config: PublicKey, mint: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("token_badge"), config.toBuffer(), mint.toBuffer()],
    OFFICIAL_ORCA
  )[0];
}

async function main() {
  const rpcUrl    = process.env.SOLANA_RPC_URL || process.env.RPC_URL || "https://api.mainnet-beta.solana.com";
  const dryRun    = process.env.DRY_RUN !== "false";
  const allowLive = process.env.ALLOW_LIVE === "true";
  const connection = new Connection(rpcUrl, "confirmed");

  const crank      = loadKeypair(process.env.CRANK_KEYPAIR_PATH || "keys/crank.json");
  const tokenBadge = deriveTokenBadge(KPX9_CONFIG, HOP_MINT);

  console.log("=== KPX9 INIT TOKEN BADGE (HOP) ===");
  console.log(`program:     ${OFFICIAL_ORCA.toBase58()}`);
  console.log(`config:      ${KPX9_CONFIG.toBase58()}`);
  console.log(`config_ext:  ${KPX9_EXT.toBase58()}`);
  console.log(`hop_mint:    ${HOP_MINT.toBase58()}`);
  console.log(`token_badge: ${tokenBadge.toBase58()}`);
  console.log(`crank:       ${crank.publicKey.toBase58()}`);
  console.log(`dry_run:     ${dryRun}`);

  const existing = await connection.getAccountInfo(tokenBadge, "confirmed");
  const receipt: Record<string, unknown> = {
    config: KPX9_CONFIG.toBase58(),
    configExtension: KPX9_EXT.toBase58(),
    hopMint: HOP_MINT.toBase58(),
    tokenBadge: tokenBadge.toBase58(),
    tokenBadgeAuthority: crank.publicKey.toBase58(),
    funder: crank.publicKey.toBase58(),
    dryRun,
    signature: null as string | null,
    verdict: "",
  };

  if (existing) {
    receipt.verdict = "TOKEN_BADGE_ALREADY_EXISTS";
    writeReceipt("KPX9-TOKEN-BADGE.json", receipt);
    console.log(`\nTOKEN_BADGE_ALREADY_EXISTS badge=${tokenBadge.toBase58()}`);
    return;
  }

  const ix = new TransactionInstruction({
    programId: OFFICIAL_ORCA,
    keys: [
      { pubkey: KPX9_CONFIG,             isSigner: false, isWritable: false },
      { pubkey: KPX9_EXT,                isSigner: false, isWritable: false },
      { pubkey: crank.publicKey,         isSigner: true,  isWritable: false },
      { pubkey: HOP_MINT,                isSigner: false, isWritable: false },
      { pubkey: tokenBadge,              isSigner: false, isWritable: true  },
      { pubkey: crank.publicKey,         isSigner: true,  isWritable: true  },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    data: INIT_TOKEN_BADGE_DISC,
  });

  const tx = new Transaction().add(ix);
  tx.feePayer = crank.publicKey;
  tx.recentBlockhash = (await connection.getLatestBlockhash("confirmed")).blockhash;

  const sim = await connection.simulateTransaction(tx);
  receipt.simErr  = sim.value.err ?? null;
  receipt.simLogs = sim.value.logs?.slice(-8) ?? [];

  if (sim.value.err) {
    receipt.verdict = "TOKEN_BADGE_SIM_FAILED";
    writeReceipt("KPX9-TOKEN-BADGE.json", receipt);
    console.error(`SIM_FAILED: ${JSON.stringify(sim.value.err)}`);
    (receipt.simLogs as string[]).forEach(l => console.error(l));
    process.exitCode = 1;
    return;
  }

  if (dryRun || !allowLive) {
    receipt.verdict = "TOKEN_BADGE_SIM_OK";
    writeReceipt("KPX9-TOKEN-BADGE.json", receipt);
    console.log(`\nSIM_OK badge=${tokenBadge.toBase58()}`);
    return;
  }

  const sig = await sendAndConfirmTransaction(connection, tx, [crank], { commitment: "confirmed" });
  receipt.verdict   = "TOKEN_BADGE_EXECUTED";
  receipt.signature = sig;
  writeReceipt("KPX9-TOKEN-BADGE.json", receipt);
  console.log(`\nEXECUTED sig=${sig}`);
  console.log(`token_badge: ${tokenBadge.toBase58()}`);
}

main().catch(e => { console.error(e); process.exitCode = 1; });
