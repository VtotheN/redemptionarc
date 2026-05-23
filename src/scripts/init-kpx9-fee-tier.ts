/**
 * Initialize FeeTier (tick_spacing=64, fee_rate=3000=0.3%) on KPX9 config
 * under official Orca Whirlpools program.
 *
 * KPX9 config: KPX9QQP4GLWiRkh4pGpkagwoPGaGixarRQs1LQKb9dt
 * fee_authority = crank (8pWEfpJ) — transferred in prior session.
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
const TICK_SPACING  = 64;
const FEE_RATE      = 3000; // 0.3% (ppm units)

const INIT_FEE_TIER_DISC = Buffer.from([183, 74, 156, 160, 112, 2, 42, 30]);

function u16Le(v: number): Buffer {
  const b = Buffer.alloc(2); b.writeUInt16LE(v); return b;
}

function loadKeypair(p: string): Keypair {
  return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(p, "utf8")) as number[]));
}

function deriveFeeTier(config: PublicKey, tickSpacing: number): PublicKey {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("fee_tier"), config.toBuffer(), u16Le(tickSpacing)],
    OFFICIAL_ORCA
  )[0];
}

async function main() {
  const rpcUrl   = process.env.SOLANA_RPC_URL || process.env.RPC_URL || "https://api.mainnet-beta.solana.com";
  const dryRun   = process.env.DRY_RUN !== "false";
  const allowLive = process.env.ALLOW_LIVE === "true";
  const connection = new Connection(rpcUrl, "confirmed");

  const crank = loadKeypair(process.env.CRANK_KEYPAIR_PATH || "keys/crank.json");
  const feeTier = deriveFeeTier(KPX9_CONFIG, TICK_SPACING);

  console.log("=== KPX9 INIT FEE TIER ===");
  console.log(`program:     ${OFFICIAL_ORCA.toBase58()}`);
  console.log(`config:      ${KPX9_CONFIG.toBase58()}`);
  console.log(`fee_tier:    ${feeTier.toBase58()}`);
  console.log(`tick_spacing:${TICK_SPACING}  fee_rate: ${FEE_RATE}`);
  console.log(`crank:       ${crank.publicKey.toBase58()}`);
  console.log(`dry_run:     ${dryRun}`);

  const existing = await connection.getAccountInfo(feeTier, "confirmed");
  const receipt: Record<string, unknown> = {
    config: KPX9_CONFIG.toBase58(),
    feeTier: feeTier.toBase58(),
    tickSpacing: TICK_SPACING,
    feeRate: FEE_RATE,
    funder: crank.publicKey.toBase58(),
    feeAuthority: crank.publicKey.toBase58(),
    dryRun,
    signature: null as string | null,
    verdict: "",
  };

  if (existing) {
    receipt.verdict = "FEE_TIER_ALREADY_EXISTS";
    writeReceipt("KPX9-FEE-TIER.json", receipt);
    console.log(`\nFEE_TIER_ALREADY_EXISTS fee_tier=${feeTier.toBase58()}`);
    return;
  }

  const ix = new TransactionInstruction({
    programId: OFFICIAL_ORCA,
    keys: [
      { pubkey: KPX9_CONFIG,             isSigner: false, isWritable: false },
      { pubkey: feeTier,                 isSigner: false, isWritable: true  },
      { pubkey: crank.publicKey,         isSigner: true,  isWritable: true  },
      { pubkey: crank.publicKey,         isSigner: true,  isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    data: Buffer.concat([INIT_FEE_TIER_DISC, u16Le(TICK_SPACING), u16Le(FEE_RATE)]),
  });

  const tx = new Transaction().add(ix);
  tx.feePayer = crank.publicKey;
  tx.recentBlockhash = (await connection.getLatestBlockhash("confirmed")).blockhash;

  const sim = await connection.simulateTransaction(tx);
  receipt.simErr  = sim.value.err ?? null;
  receipt.simLogs = sim.value.logs?.slice(-8) ?? [];

  if (sim.value.err) {
    receipt.verdict = "FEE_TIER_SIM_FAILED";
    writeReceipt("KPX9-FEE-TIER.json", receipt);
    console.error(`SIM_FAILED: ${JSON.stringify(sim.value.err)}`);
    (receipt.simLogs as string[]).forEach(l => console.error(l));
    process.exitCode = 1;
    return;
  }

  if (dryRun || !allowLive) {
    receipt.verdict = "FEE_TIER_SIM_OK";
    writeReceipt("KPX9-FEE-TIER.json", receipt);
    console.log(`\nSIM_OK fee_tier=${feeTier.toBase58()}`);
    return;
  }

  const sig = await sendAndConfirmTransaction(connection, tx, [crank], { commitment: "confirmed" });
  receipt.verdict   = "FEE_TIER_EXECUTED";
  receipt.signature = sig;
  writeReceipt("KPX9-FEE-TIER.json", receipt);
  console.log(`\nEXECUTED sig=${sig}`);
  console.log(`fee_tier: ${feeTier.toBase58()}`);
}

main().catch(e => { console.error(e); process.exitCode = 1; });
