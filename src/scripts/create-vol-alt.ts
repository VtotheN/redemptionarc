/**
 * Create (or extend) an Address Lookup Table with all accounts needed by flash-deep-vol.ts.
 *
 * ENV:
 *   SOLANA_RPC_URL   (required)
 *   EXISTING_ALT     (optional — if set, extend this ALT instead of creating a new one)
 */
import "dotenv/config";
import fs from "node:fs";
import path from "node:path";
import {
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
  AddressLookupTableProgram,
  TransactionMessage,
  VersionedTransaction,
  SYSVAR_INSTRUCTIONS_PUBKEY,
} from "@solana/web3.js";
import {
  TOKEN_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ID,
  ASSOCIATED_TOKEN_PROGRAM_ID,
  getAssociatedTokenAddressSync,
} from "@solana/spl-token";
import { writeReceipt } from "../utils/receipt.js";

// ─── Constants ────────────────────────────────────────────────────────────────

const MARGINFI_PROGRAM   = new PublicKey("MFv2hWf31Z9kbCa1snEPYctwafyhdvnV7FZnsebVacA");
const MARGINFI_GROUP     = new PublicKey("4qp6Fx6tnZkY5Wropq9wUYgtFxXKwE6viZxFHg3rdAG8");
const USDC_BANK          = new PublicKey("2s37akK2eyBbp8DZgCm7RtsaEz8eJP3Nxd4urLHQv7yB");
const USDC_LIQUIDITY_VAULT = new PublicKey("7jaiZR5Sk8hdYN9MxTpczTcwbWpb5WEoxSANuUwveuat");

const RAYDIUM_CPMM_PROGRAM = new PublicKey("CPMMoo8L3F4NbTegBCKVNunggL7H1ZpdTHKxQB5qKP1C");
const POOL_ID            = new PublicKey("EwoZHyXz48vZL1TwkpQoq31brW4G4NDwmMr1DMw6qqBV");
// AMM config index 2 = 0.05% fee (from seed-hop-pool.ts AMM_CONFIGS table)
const AMM_CONFIG_ID      = new PublicKey("E64NGkDLLCdQ2yFNPcavaKptrEgmiQaNykUuLC1Qgwyp");

const USDC_MINT          = new PublicKey("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v");
const HOP_MINT           = new PublicKey("HZF5k7h39hkysoSZ4ZfmWc55PhvW7ntVvVqdXFCyYGh3");

const CRANK              = new PublicKey("8pWEfpJas2tgS8iE7ZyHKNjeDSEixqSwK12W4tagNJ3S");
const CRANK_HOP_ATA      = new PublicKey("2s2Au2bxsvF5cHbdhfP4JaFX8FXp5wXzQxBj15PNPEkD");
const MF_ACCOUNT         = new PublicKey("9SdjygeTAmMrgCQjBAGNAAjjYE6U35ARWcuvvxFZJHz");

const JITO_TIP           = new PublicKey("96gYZGLnJYVFmbjzopPSU6QiEV5fGqZNyN9nmNhvrZU5");

const COMPUTE_BUDGET     = new PublicKey("ComputeBudget111111111111111111111111111111");

// ─── Helpers ──────────────────────────────────────────────────────────────────

function loadKeypair(relPath: string): Keypair {
  const abs = path.resolve(relPath);
  return Keypair.fromSecretKey(
    Uint8Array.from(JSON.parse(fs.readFileSync(abs, "utf8")) as number[])
  );
}

/** Derive a PDA, return the PublicKey only. */
function pda(seeds: (Buffer | Uint8Array)[], program: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync(seeds, program)[0];
}

/** Send a VersionedTransaction, wait for confirmation. */
async function sendAndConfirm(
  conn: Connection,
  tx: VersionedTransaction,
  label: string
): Promise<string> {
  const sig = await conn.sendTransaction(tx, { skipPreflight: false });
  console.log(`  ${label} sent: ${sig}`);
  const { blockhash, lastValidBlockHeight } = await conn.getLatestBlockhash("confirmed");
  await conn.confirmTransaction(
    { signature: sig, blockhash, lastValidBlockHeight },
    "confirmed"
  );
  console.log(`  ${label} confirmed.`);
  return sig;
}

/** Sleep ms. */
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

// ─── Oracle from bank account data ───────────────────────────────────────────

async function fetchOraclePubkey(conn: Connection): Promise<PublicKey> {
  const info = await conn.getAccountInfo(USDC_BANK, "confirmed");
  if (!info) throw new Error("Could not fetch USDC bank account");
  // Oracle pubkey is at offset 610 in the bank account data.
  const oracleBytes = info.data.slice(610, 610 + 32);
  return new PublicKey(oracleBytes);
}

// ─── Chunk array ─────────────────────────────────────────────────────────────

function chunk<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  const rpc = process.env.SOLANA_RPC_URL;
  if (!rpc) throw new Error("SOLANA_RPC_URL is required");

  const conn = new Connection(rpc, "confirmed");
  const crank = loadKeypair("keys/crank.json");

  console.log("=== CREATE-VOL-ALT ===");
  console.log(`Crank: ${crank.publicKey.toBase58()}`);

  // ── Derive PDAs ────────────────────────────────────────────────────────────

  // MarginFi: liquidity_vault_authority
  const liquidityVaultAuth = pda(
    [Buffer.from("liquidity_vault_auth"), USDC_BANK.toBuffer()],
    MARGINFI_PROGRAM
  );

  // Raydium CPMM
  const raydiumAuthority = pda(
    [Buffer.from("vault_and_lp_mint_auth_seed")],
    RAYDIUM_CPMM_PROGRAM
  );
  const lpMint = pda(
    [Buffer.from("pool_lp_mint"), POOL_ID.toBuffer()],
    RAYDIUM_CPMM_PROGRAM
  );
  const vaultA = pda(
    [Buffer.from("pool_vault"), POOL_ID.toBuffer(), USDC_MINT.toBuffer()],
    RAYDIUM_CPMM_PROGRAM
  );
  const vaultB = pda(
    [Buffer.from("pool_vault"), POOL_ID.toBuffer(), HOP_MINT.toBuffer()],
    RAYDIUM_CPMM_PROGRAM
  );
  const observationId = pda(
    [Buffer.from("observation"), POOL_ID.toBuffer()],
    RAYDIUM_CPMM_PROGRAM
  );

  // User ATAs derived from known crank pubkey
  const crankUsdcAta = getAssociatedTokenAddressSync(
    USDC_MINT, CRANK, false, TOKEN_PROGRAM_ID
  );
  const crankLpAta = getAssociatedTokenAddressSync(
    lpMint, CRANK, false, TOKEN_PROGRAM_ID
  );

  // Oracle from bank data
  console.log("Fetching oracle pubkey from USDC bank...");
  const oraclePubkey = await fetchOraclePubkey(conn);
  console.log(`Oracle: ${oraclePubkey.toBase58()}`);

  // ── Build full account list ────────────────────────────────────────────────

  const accounts: PublicKey[] = [
    // MarginFi
    MARGINFI_PROGRAM,
    MARGINFI_GROUP,
    USDC_BANK,
    USDC_LIQUIDITY_VAULT,
    liquidityVaultAuth,

    // Raydium CPMM
    RAYDIUM_CPMM_PROGRAM,
    POOL_ID,
    raydiumAuthority,
    lpMint,
    vaultA,
    vaultB,
    observationId,
    AMM_CONFIG_ID,

    // Mints
    USDC_MINT,
    HOP_MINT,

    // User accounts
    CRANK,
    CRANK_HOP_ATA,
    crankUsdcAta,
    crankLpAta,

    // MarginFi account
    MF_ACCOUNT,

    // System programs
    TOKEN_PROGRAM_ID,
    TOKEN_2022_PROGRAM_ID,
    ASSOCIATED_TOKEN_PROGRAM_ID,
    SystemProgram.programId,
    COMPUTE_BUDGET,
    SYSVAR_INSTRUCTIONS_PUBKEY,

    // Jito tip
    JITO_TIP,

    // Oracle
    oraclePubkey,
  ];

  // Deduplicate preserving order
  const seen = new Set<string>();
  const uniqueAccounts = accounts.filter(pk => {
    const k = pk.toBase58();
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });

  console.log(`\nTotal unique accounts: ${uniqueAccounts.length}`);
  uniqueAccounts.forEach((pk, i) => console.log(`  [${i.toString().padStart(2)}] ${pk.toBase58()}`));

  // ── Create or reuse ALT ───────────────────────────────────────────────────

  let altAddress: PublicKey;

  const existingAlt = process.env.EXISTING_ALT;
  if (existingAlt) {
    altAddress = new PublicKey(existingAlt);
    console.log(`\nUsing existing ALT: ${altAddress.toBase58()}`);
  } else {
    console.log("\nCreating new ALT...");

    // Use finalized slot for createLookupTable to avoid "slot too recent" error
    const recentSlot = await conn.getSlot("finalized");

    const [createIx, altPubkey] = AddressLookupTableProgram.createLookupTable({
      authority: crank.publicKey,
      payer: crank.publicKey,
      recentSlot,
    });
    altAddress = altPubkey;

    const { blockhash } = await conn.getLatestBlockhash("confirmed");
    const createMsg = new TransactionMessage({
      payerKey: crank.publicKey,
      recentBlockhash: blockhash,
      instructions: [createIx],
    }).compileToV0Message();

    const createTx = new VersionedTransaction(createMsg);
    createTx.sign([crank]);

    await sendAndConfirm(conn, createTx, "createLookupTable");

    console.log(`ALT created: ${altAddress.toBase58()}`);

    // Wait 1 slot for the ALT account to be visible before extending
    console.log("Waiting 1 slot before extending...");
    await sleep(500);
  }

  // ── Extend ALT in chunks of 20 ────────────────────────────────────────────

  const chunks = chunk(uniqueAccounts, 20);
  console.log(`\nExtending ALT in ${chunks.length} chunk(s) of up to 20...`);

  for (let i = 0; i < chunks.length; i++) {
    const addresses = chunks[i];
    console.log(`\nChunk ${i + 1}/${chunks.length} (${addresses.length} accounts)...`);

    const extendIx = AddressLookupTableProgram.extendLookupTable({
      payer: crank.publicKey,
      authority: crank.publicKey,
      lookupTable: altAddress,
      addresses,
    });

    const { blockhash } = await conn.getLatestBlockhash("confirmed");
    const extMsg = new TransactionMessage({
      payerKey: crank.publicKey,
      recentBlockhash: blockhash,
      instructions: [extendIx],
    }).compileToV0Message();

    const extTx = new VersionedTransaction(extMsg);
    extTx.sign([crank]);

    await sendAndConfirm(conn, extTx, `extendLookupTable chunk ${i + 1}`);

    // Small gap between extend txs to avoid slot issues
    if (i < chunks.length - 1) await sleep(400);
  }

  // ── Write results ─────────────────────────────────────────────────────────

  console.log(`\nALT address: ${altAddress.toBase58()}`);

  // Plain text receipt
  const receiptsDir = path.resolve("receipts");
  fs.mkdirSync(receiptsDir, { recursive: true });
  fs.writeFileSync(path.join(receiptsDir, "vol-alt-address.txt"), altAddress.toBase58());

  // JSON receipt
  writeReceipt("vol-alt.json", {
    altAddress: altAddress.toBase58(),
    totalAccounts: uniqueAccounts.length,
    accounts: uniqueAccounts.map((pk, i) => ({ index: i, pubkey: pk.toBase58() })),
    derivedPdas: {
      liquidityVaultAuth: liquidityVaultAuth.toBase58(),
      raydiumAuthority: raydiumAuthority.toBase58(),
      lpMint: lpMint.toBase58(),
      vaultA: vaultA.toBase58(),
      vaultB: vaultB.toBase58(),
      observationId: observationId.toBase58(),
      crankUsdcAta: crankUsdcAta.toBase58(),
      crankLpAta: crankLpAta.toBase58(),
      oraclePubkey: oraclePubkey.toBase58(),
    },
  });

  console.log("receipts/vol-alt-address.txt written");
  console.log("receipts/vol-alt.json written");
  console.log("\nDone.");
}

main().catch(e => { console.error(e); process.exitCode = 1; });
