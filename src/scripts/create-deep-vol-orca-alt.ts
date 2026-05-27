/**
 * create-deep-vol-orca-alt.ts — Build ALT for flash-deep-vol-orca.ts.
 *
 * Creates (or extends) an Address Lookup Table with all 25 accounts needed
 * so the versioned TX fits under 1232 bytes.
 *
 * ENV:
 *   SOLANA_RPC_URL
 *   EXISTING_ALT   (optional — extend existing instead of creating new)
 */
import "dotenv/config";
import fs from "node:fs";
import {
  Connection, Keypair, PublicKey,
  AddressLookupTableProgram,
  TransactionMessage, VersionedTransaction,
  SYSVAR_INSTRUCTIONS_PUBKEY, SystemProgram,
} from "@solana/web3.js";
import {
  TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID,
  getAssociatedTokenAddressSync,
} from "@solana/spl-token";
import { getShardConfig } from "../utils/shard.js";

const WHIRLPOOL_PROGRAM  = new PublicKey("GxRHMB9a6XE8BqGPeNb9UkJUPvbvrPoPgNTJPJJA4n8h");
const WHIRLPOOL          = new PublicKey("8aoWgf7ycbeKv6BTFCdUj4JR7Y4mXWuPZWEUhmuzN5ZL");
const TOKEN_VAULT_A      = new PublicKey("4QD4GgnjRvjETqWLT5e3x7SHtJSzs9kShUPLfyHcTu7d");
const TOKEN_VAULT_B      = new PublicKey("Qv51R47g7pMDxa3UofXaz8cNr8pwRSXaNufgnEWX8Yk");
const TICK_ARRAY_84480   = new PublicKey("be9QKj4mYB8erh6r4ZDrKxxSvSYSUNRfpTxqJUgd3jG");
const TICK_ARRAY_90112   = new PublicKey("CDMSB5e6WUgtoSLrybvYm4j58Jue3eqpzHQVLmgVkAe4");
const TICK_ARRAY_95744   = new PublicKey("MXd8HXPjcH9ZCuyr4uKKyN7GkJ5YizZQkgUndB6J8Gz");
const ORACLE             = new PublicKey("5qhXANMqTNNzdp1N1PrMzWzSzjHTZxuLPELcmpog6bp5");
const POSITION           = new PublicKey("ErgQU48egJMNBLZeVkdjrtZrSWUQJCky3deh2B4U1YPQ");
const POSITION_TA        = new PublicKey("GgLpt3VY9vWKLnNa5Dj3FKvBn3JEDL4KTKpabCAfL54Q");
const SPL_MEMO           = new PublicKey("MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr");
const USDC_MINT          = new PublicKey("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v");
const HOP_MINT           = new PublicKey("HZF5k7h39hkysoSZ4ZfmWc55PhvW7ntVvVqdXFCyYGh3");
const MARGINFI_PROGRAM   = new PublicKey("MFv2hWf31Z9kbCa1snEPYctwafyhdvnV7FZnsebVacA");
const MARGINFI_GROUP     = new PublicKey("4qp6Fx6tnZkY5Wropq9wUYgtFxXKwE6viZxFHg3rdAG8");
const USDC_BANK          = new PublicKey("2s37akK2eyBbp8DZgCm7RtsaEz8eJP3Nxd4urLHQv7yB");
const USDC_LIQ_VAULT     = new PublicKey("7jaiZR5Sk8hdYN9MxTpczTcwbWpb5WEoxSANuUwveuat");
const MF_ACCOUNT_DEFAULT = new PublicKey("9SdjygeTAmMrgCQjBAGNAAjjYE6U35ARWcuvvxFZJHz");
const JITO_TIP_WALLET    = new PublicKey("96gYZGLnJYVFmbjzopPSU6QiEV5fGqZNyN9nmNhvrZU5");
const COMPUTE_BUDGET     = new PublicKey("ComputeBudget111111111111111111111111111111");

function loadKeypair(p: string): Keypair {
  return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(p, "utf8")) as number[]));
}

async function sendAndConfirm(conn: Connection, tx: VersionedTransaction, label: string): Promise<string> {
  const sig = await conn.sendTransaction(tx, { skipPreflight: false });
  console.log(`  ${label}: ${sig}`);
  const { blockhash, lastValidBlockHeight } = await conn.getLatestBlockhash("confirmed");
  await conn.confirmTransaction({ signature: sig, blockhash, lastValidBlockHeight }, "confirmed");
  console.log(`  confirmed.`);
  return sig;
}

async function main() {
  const rpcUrl = process.env.SOLANA_RPC_URL || process.env.RPC_URL || "https://api.mainnet-beta.solana.com";
  const existingAlt = process.env.EXISTING_ALT || "";
  const conn = new Connection(rpcUrl, "confirmed");

  const shard = getShardConfig();
  const crank = shard
    ? shard.crank
    : loadKeypair(process.env.CRANK_KEYPAIR_PATH || "keys/crank.json");
  const mfAccount = shard
    ? shard.marginfiAccountPubkey
    : (process.env.MARGINFI_ACCOUNT_PUBKEY
        ? new PublicKey(process.env.MARGINFI_ACCOUNT_PUBKEY)
        : MF_ACCOUNT_DEFAULT);

  const crankUsdcAta = getAssociatedTokenAddressSync(USDC_MINT, crank.publicKey, false, TOKEN_PROGRAM_ID);
  const crankHopAta  = getAssociatedTokenAddressSync(HOP_MINT,  crank.publicKey, false, TOKEN_2022_PROGRAM_ID);

  const [vaultAuth] = PublicKey.findProgramAddressSync(
    [Buffer.from("liquidity_vault_auth"), USDC_BANK.toBuffer()],
    MARGINFI_PROGRAM
  );

  const accounts: PublicKey[] = [
    // Programs (in ALT for compression)
    MARGINFI_PROGRAM,
    WHIRLPOOL_PROGRAM,
    TOKEN_PROGRAM_ID,
    TOKEN_2022_PROGRAM_ID,
    SPL_MEMO,
    COMPUTE_BUDGET,
    SystemProgram.programId,
    // Sysvar
    SYSVAR_INSTRUCTIONS_PUBKEY,
    // MarginFi state
    mfAccount,
    MARGINFI_GROUP,
    USDC_BANK,
    vaultAuth,
    USDC_LIQ_VAULT,
    // Mints
    USDC_MINT,
    HOP_MINT,
    // Whirlpool state
    WHIRLPOOL,
    TOKEN_VAULT_A,
    TOKEN_VAULT_B,
    ORACLE,
    // Position
    POSITION,
    POSITION_TA,
    // Tick arrays
    TICK_ARRAY_84480,
    TICK_ARRAY_90112,
    TICK_ARRAY_95744,
    // Crank ATAs
    crankUsdcAta,
    crankHopAta,
    // Jito
    JITO_TIP_WALLET,
  ];

  console.log(`Crank: ${crank.publicKey.toBase58()}`);
  console.log(`Accounts to add to ALT: ${accounts.length}`);

  const { blockhash, lastValidBlockHeight } = await conn.getLatestBlockhash("confirmed");
  const slot = await conn.getSlot("confirmed");

  let altPubkey: PublicKey;

  if (existingAlt) {
    altPubkey = new PublicKey(existingAlt);
    console.log(`Extending existing ALT: ${altPubkey.toBase58()}`);
  } else {
    // Create new ALT
    const [createIx, newAlt] = AddressLookupTableProgram.createLookupTable({
      authority: crank.publicKey,
      payer: crank.publicKey,
      recentSlot: slot - 1,
    });
    altPubkey = newAlt;

    const createMsg = new TransactionMessage({
      payerKey: crank.publicKey,
      recentBlockhash: blockhash,
      instructions: [createIx],
    }).compileToV0Message();
    const createTx = new VersionedTransaction(createMsg);
    createTx.sign([crank]);
    await sendAndConfirm(conn, createTx, `create ALT ${altPubkey.toBase58()}`);
    console.log(`\nALT created: ${altPubkey.toBase58()}`);
    // Wait a slot for ALT to be available
    await new Promise((r) => setTimeout(r, 2000));
  }

  // Extend in chunks of 20 (max per TX)
  const CHUNK = 20;
  for (let i = 0; i < accounts.length; i += CHUNK) {
    const chunk = accounts.slice(i, i + CHUNK);
    const { blockhash: bh } = await conn.getLatestBlockhash("confirmed");
    const extendIx = AddressLookupTableProgram.extendLookupTable({
      payer: crank.publicKey,
      authority: crank.publicKey,
      lookupTable: altPubkey,
      addresses: chunk,
    });
    const msg = new TransactionMessage({
      payerKey: crank.publicKey,
      recentBlockhash: bh,
      instructions: [extendIx],
    }).compileToV0Message();
    const tx = new VersionedTransaction(msg);
    tx.sign([crank]);
    await sendAndConfirm(conn, tx, `extend [${i}..${i + chunk.length - 1}]`);
    if (i + CHUNK < accounts.length) await new Promise((r) => setTimeout(r, 1000));
  }

  console.log(`\nALT ready: ${altPubkey.toBase58()}`);
  console.log(`Run sim:`);
  console.log(`  ALT_ADDRESS=${altPubkey.toBase58()} FORCE_T22_BPS=1 ADDLIQ_USDC=10000 SWAP_USDC=300 DRY_RUN=true npm run flash-deep-vol-orca`);
}

main().catch((e) => { console.error(e); process.exitCode = 1; });
