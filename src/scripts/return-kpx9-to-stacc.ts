/**
 * Return all 5 KPX9 authorities back to STACC wallet.
 * 1. fee_authority
 * 2. collect_protocol_fees_authority
 * 3. reward_emissions_super_authority
 * 4. config_extension_authority
 * 5. token_badge_authority
 */
import "dotenv/config";
import fs from "node:fs";
import {
  Connection, Keypair, PublicKey,
  TransactionInstruction, TransactionMessage, VersionedTransaction,
  ComputeBudgetProgram,
} from "@solana/web3.js";
import { KPX9_WHIRLPOOLS_CONFIG, KPX9_CONFIG_EXTENSION, OFFICIAL_ORCA_PROGRAM_ID } from "../constants.js";
import { writeReceipt } from "../utils/receipt.js";

const STACC = new PublicKey("WzMaL78srutrF6CsxEkWuhMaDF5HZA6jNRaEPengqpb");

const DISC = {
  set_fee_authority:                      Buffer.from("1f013257ed656184", "hex"),
  set_collect_protocol_fees_authority:    Buffer.from("22965df48be1e943", "hex"),
  set_reward_emissions_super_authority:   Buffer.from("cf05c8d17a3852b7", "hex"),
  set_config_extension_authority:         Buffer.from("2c5ef17418bc3c8f", "hex"),
  set_token_badge_authority:              Buffer.from("cfca0420cd4f0db2", "hex"),
};

function loadKeypair(p: string) {
  return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(p, "utf8")) as number[]));
}

async function main() {
  const rpc = process.env.SOLANA_RPC_URL || "https://api.mainnet-beta.solana.com";
  const dryRun = process.env.DRY_RUN !== "false";
  const allowLive = process.env.ALLOW_LIVE === "true";
  const conn = new Connection(rpc, "confirmed");
  const crank = loadKeypair("keys/crank.json"); // current authority for all 5

  console.log("=== RETURN KPX9 AUTHORITIES TO STACC ===");
  console.log(`from:    ${crank.publicKey.toBase58()} (crank)`);
  console.log(`to:      ${STACC.toBase58()} (STACC)`);
  console.log(`config:  ${KPX9_WHIRLPOOLS_CONFIG.toBase58()}`);
  console.log(`ext:     ${KPX9_CONFIG_EXTENSION.toBase58()}`);
  console.log(`dry_run: ${dryRun}`);

  // 3 config-level instructions (signed by crank as current authority)
  const ix_fee = new TransactionInstruction({
    programId: OFFICIAL_ORCA_PROGRAM_ID,
    keys: [
      { pubkey: KPX9_WHIRLPOOLS_CONFIG, isSigner: false, isWritable: true  },
      { pubkey: crank.publicKey,         isSigner: true,  isWritable: false },
      { pubkey: STACC,                   isSigner: false, isWritable: false },
      { pubkey: OFFICIAL_ORCA_PROGRAM_ID,isSigner: false, isWritable: false },
    ],
    data: DISC.set_fee_authority,
  });

  const ix_collect = new TransactionInstruction({
    programId: OFFICIAL_ORCA_PROGRAM_ID,
    keys: [
      { pubkey: KPX9_WHIRLPOOLS_CONFIG, isSigner: false, isWritable: true  },
      { pubkey: crank.publicKey,         isSigner: true,  isWritable: false },
      { pubkey: STACC,                   isSigner: false, isWritable: false },
      { pubkey: OFFICIAL_ORCA_PROGRAM_ID,isSigner: false, isWritable: false },
    ],
    data: DISC.set_collect_protocol_fees_authority,
  });

  const ix_reward = new TransactionInstruction({
    programId: OFFICIAL_ORCA_PROGRAM_ID,
    keys: [
      { pubkey: KPX9_WHIRLPOOLS_CONFIG, isSigner: false, isWritable: true  },
      { pubkey: crank.publicKey,         isSigner: true,  isWritable: false },
      { pubkey: STACC,                   isSigner: false, isWritable: false },
      { pubkey: OFFICIAL_ORCA_PROGRAM_ID,isSigner: false, isWritable: false },
    ],
    data: DISC.set_reward_emissions_super_authority,
  });

  // 2 extension-level instructions
  const ix_ext_auth = new TransactionInstruction({
    programId: OFFICIAL_ORCA_PROGRAM_ID,
    keys: [
      { pubkey: KPX9_WHIRLPOOLS_CONFIG,  isSigner: false, isWritable: false },
      { pubkey: KPX9_CONFIG_EXTENSION,   isSigner: false, isWritable: true  },
      { pubkey: crank.publicKey,          isSigner: true,  isWritable: false },
      { pubkey: STACC,                    isSigner: false, isWritable: false },
      { pubkey: OFFICIAL_ORCA_PROGRAM_ID, isSigner: false, isWritable: false },
    ],
    data: DISC.set_config_extension_authority,
  });

  const ix_badge_auth = new TransactionInstruction({
    programId: OFFICIAL_ORCA_PROGRAM_ID,
    keys: [
      { pubkey: KPX9_WHIRLPOOLS_CONFIG,  isSigner: false, isWritable: false },
      { pubkey: KPX9_CONFIG_EXTENSION,   isSigner: false, isWritable: true  },
      { pubkey: crank.publicKey,          isSigner: true,  isWritable: false },
      { pubkey: STACC,                    isSigner: false, isWritable: false },
      { pubkey: OFFICIAL_ORCA_PROGRAM_ID, isSigner: false, isWritable: false },
    ],
    data: DISC.set_token_badge_authority,
  });

  const { blockhash, lastValidBlockHeight } = await conn.getLatestBlockhash("confirmed");
  const msg = new TransactionMessage({
    payerKey: crank.publicKey,
    recentBlockhash: blockhash,
    instructions: [
      ComputeBudgetProgram.setComputeUnitLimit({ units: 200_000 }),
      ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 50_000 }),
      ix_fee, ix_collect, ix_reward, ix_badge_auth, ix_ext_auth,
    ],
  }).compileToV0Message([]);
  const vtx = new VersionedTransaction(msg);
  vtx.sign([crank]);

  const sim = await conn.simulateTransaction(vtx, { sigVerify: false, replaceRecentBlockhash: true });
  console.log("\nSim err:", sim.value.err ?? "OK", `cu=${sim.value.unitsConsumed}`);
  if (sim.value.err) {
    (sim.value.logs ?? []).slice(-10).forEach(l => console.error(l));
    process.exitCode = 1;
    return;
  }

  if (dryRun || !allowLive) {
    console.log("DRY_RUN — set DRY_RUN=false ALLOW_LIVE=true to execute");
    return;
  }

  const sig = await conn.sendTransaction(vtx, { skipPreflight: true });
  await conn.confirmTransaction({ signature: sig, blockhash, lastValidBlockHeight }, "confirmed");

  // Verify on-chain result
  const txLog = await conn.getTransaction(sig, { maxSupportedTransactionVersion: 0, commitment: "confirmed" });
  if (txLog?.meta?.err) {
    console.error("TX FAILED:", JSON.stringify(txLog.meta.err));
    (txLog.meta.logMessages ?? []).slice(-8).forEach(l => console.error(l));
    process.exitCode = 1;
    return;
  }

  writeReceipt("return-kpx9-to-stacc.json", { sig, from: crank.publicKey.toBase58(), to: STACC.toBase58() });
  console.log(`\nEXECUTED sig=${sig}`);
  console.log("All 5 KPX9 authorities → STACC");
}

main().catch(e => { console.error(e); process.exitCode = 1; });
