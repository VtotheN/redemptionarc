/**
 * Bootstrap a WhirlpoolsConfig + FeeTier + TokenBadge(HOP) + Pool
 * on the OFFICIAL Orca Whirlpool program (whirLbM...).
 *
 * Unlike init-orca-config.ts (which targets our fork GxRHMB9a...),
 * this targets the canonical program so Jupiter will index the pool
 * and arb bots route through it automatically.
 *
 * Steps executed (each idempotent):
 *   TX1 — InitializeConfig + InitializeConfigExtension + InitializeFeeTier
 *   TX2 — InitializeTokenBadge (for HOP, Token-2022)
 *   TX3 — InitializePoolV2  (USDC / HOP)
 *
 * ENV:
 *   SOLANA_RPC_URL          (required)
 *   DRY_RUN=true            (default — sim only, no send)
 *   ALLOW_LIVE=true         (required to send)
 *   HOP_PRICE_USDC=0.0001   (initial pool price, default $0.0001/HOP)
 *   ORCA_TICK_SPACING=64    (default)
 *   ORCA_FEE_RATE=300       (LP fee bps, default 300 = 0.03%)
 *   ORCA_PROTOCOL_FEE_RATE=300 (protocol fee bps, default 300 = 3% of LP fee)
 *   ORCA_CONFIG_KEYPAIR_PATH=keys/official-orca-config.json (default)
 */

import "dotenv/config";
import fs from "node:fs";
import {
  Keypair,
  PublicKey,
  Transaction,
  TransactionInstruction,
  SystemProgram,
  SYSVAR_RENT_PUBKEY,
  sendAndConfirmTransaction,
} from "@solana/web3.js";
import { TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID } from "@solana/spl-token";
import { loadConfig } from "../config.js";
import { connectionFor } from "../utils/rpc.js";
import { writeReceipt } from "../utils/receipt.js";
import { assertKeypairMatches, ensureKeypair, loadKeypair } from "../utils/keypair.js";
import { assertLiveAllowed, assertNoForbiddenConfigured, uniqueSigners } from "../utils/safety.js";

// ─── Official Orca program ────────────────────────────────────────────────────
const OFFICIAL_ORCA = new PublicKey("whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc");

// Anchor discriminators (sha256("global:<name>")[:8]) — same as fork
const IX_INIT_CONFIG      = Buffer.from([208, 127,  21,   1, 194, 190, 196,  70]);
const IX_INIT_CONFIG_EXT  = Buffer.from([ 55,   9,  53,   9, 114,  57, 209,  52]);
const IX_INIT_FEE_TIER    = Buffer.from([183,  74, 156, 160, 112,   2,  42,  30]);
const IX_INIT_TOKEN_BADGE = Buffer.from([253,  77, 205,  95,  27, 224,  89, 223]);
const IX_INIT_POOL_V2     = Buffer.from([207,  45,  87, 242,  27,  63, 204,  67]);

const TICK_SPACING            = Number(process.env.ORCA_TICK_SPACING         ?? "64");
const DEFAULT_FEE_RATE        = Number(process.env.ORCA_FEE_RATE             ?? "300");
const DEFAULT_PROTOCOL_FEE    = Number(process.env.ORCA_PROTOCOL_FEE_RATE    ?? "300");
const HOP_PRICE_USDC          = Number(process.env.HOP_PRICE_USDC            ?? "0.0001");

const USDC_MINT = new PublicKey("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v");
const HOP_MINT  = new PublicKey("HZF5k7h39hkysoSZ4ZfmWc55PhvW7ntVvVqdXFCyYGh3");

// ─── PDA helpers (official program) ──────────────────────────────────────────
function u16Le(n: number): Buffer { const b = Buffer.alloc(2); b.writeUInt16LE(n); return b; }
function u128Le(n: bigint): Buffer {
  const b = Buffer.alloc(16);
  b.writeBigUInt64LE(n & ((1n << 64n) - 1n), 0);
  b.writeBigUInt64LE(n >> 64n, 8);
  return b;
}
function i32Le(n: number): Buffer { const b = Buffer.alloc(4); b.writeInt32LE(n); return b; }

function pda(seeds: Buffer[], program = OFFICIAL_ORCA): PublicKey {
  return PublicKey.findProgramAddressSync(seeds, program)[0];
}
const deriveConfigExt  = (c: PublicKey) => pda([Buffer.from("config_extension"), c.toBuffer()]);
const deriveFeeTier    = (c: PublicKey, ts: number) => pda([Buffer.from("fee_tier"), c.toBuffer(), u16Le(ts)]);
const deriveTokenBadge = (c: PublicKey, m: PublicKey) => pda([Buffer.from("token_badge"), c.toBuffer(), m.toBuffer()]);
const deriveWhirlpool  = (c: PublicKey, a: PublicKey, b: PublicKey, ts: number) =>
  pda([Buffer.from("whirlpool"), c.toBuffer(), a.toBuffer(), b.toBuffer(), u16Le(ts)]);

function priceToSqrtX64(tokenBPerTokenA: number): bigint {
  const sqrtPrice = Math.sqrt(tokenBPerTokenA);
  const scale = 1_000_000_000n;
  const sqrtScaled = BigInt(Math.floor(sqrtPrice * Number(scale)));
  return (sqrtScaled * (1n << 64n)) / scale;
}

// ─── Instruction builders ─────────────────────────────────────────────────────
function initConfigIx(config: PublicKey, funder: PublicKey, authority: PublicKey): TransactionInstruction {
  return new TransactionInstruction({
    programId: OFFICIAL_ORCA,
    keys: [
      { pubkey: config,              isSigner: true,  isWritable: true  },
      { pubkey: funder,              isSigner: true,  isWritable: true  },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    data: Buffer.concat([IX_INIT_CONFIG, authority.toBuffer(), authority.toBuffer(), authority.toBuffer(), u16Le(DEFAULT_PROTOCOL_FEE)]),
  });
}

function initConfigExtIx(config: PublicKey, ext: PublicKey, funder: PublicKey, authority: PublicKey): TransactionInstruction {
  return new TransactionInstruction({
    programId: OFFICIAL_ORCA,
    keys: [
      { pubkey: config,   isSigner: false, isWritable: false },
      { pubkey: ext,      isSigner: false, isWritable: true  },
      { pubkey: funder,   isSigner: true,  isWritable: true  },
      { pubkey: authority,isSigner: true,  isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    data: IX_INIT_CONFIG_EXT,
  });
}

function initFeeTierIx(config: PublicKey, feeTier: PublicKey, funder: PublicKey, authority: PublicKey): TransactionInstruction {
  return new TransactionInstruction({
    programId: OFFICIAL_ORCA,
    keys: [
      { pubkey: config,    isSigner: false, isWritable: false },
      { pubkey: feeTier,   isSigner: false, isWritable: true  },
      { pubkey: funder,    isSigner: true,  isWritable: true  },
      { pubkey: authority, isSigner: true,  isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    data: Buffer.concat([IX_INIT_FEE_TIER, u16Le(TICK_SPACING), u16Le(DEFAULT_FEE_RATE)]),
  });
}

function initTokenBadgeIx(config: PublicKey, ext: PublicKey, badgeAuth: PublicKey, mint: PublicKey, badge: PublicKey, funder: PublicKey): TransactionInstruction {
  return new TransactionInstruction({
    programId: OFFICIAL_ORCA,
    keys: [
      { pubkey: config,    isSigner: false, isWritable: false },
      { pubkey: ext,       isSigner: false, isWritable: false },
      { pubkey: badgeAuth, isSigner: true,  isWritable: false },
      { pubkey: mint,      isSigner: false, isWritable: false },
      { pubkey: badge,     isSigner: false, isWritable: true  },
      { pubkey: funder,    isSigner: true,  isWritable: true  },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    data: IX_INIT_TOKEN_BADGE,
  });
}

function initPoolV2Ix(
  config: PublicKey, mintA: PublicKey, mintB: PublicKey,
  badgeA: PublicKey, badgeB: PublicKey, funder: PublicKey,
  pool: PublicKey, vaultA: PublicKey, vaultB: PublicKey,
  feeTier: PublicKey, progA: PublicKey, progB: PublicKey,
  sqrtPrice: bigint
): TransactionInstruction {
  return new TransactionInstruction({
    programId: OFFICIAL_ORCA,
    keys: [
      { pubkey: config,   isSigner: false, isWritable: false },
      { pubkey: mintA,    isSigner: false, isWritable: false },
      { pubkey: mintB,    isSigner: false, isWritable: false },
      { pubkey: badgeA,   isSigner: false, isWritable: false },
      { pubkey: badgeB,   isSigner: false, isWritable: false },
      { pubkey: funder,   isSigner: true,  isWritable: true  },
      { pubkey: pool,     isSigner: false, isWritable: true  },
      { pubkey: vaultA,   isSigner: true,  isWritable: true  },
      { pubkey: vaultB,   isSigner: true,  isWritable: true  },
      { pubkey: feeTier,  isSigner: false, isWritable: false },
      { pubkey: progA,    isSigner: false, isWritable: false },
      { pubkey: progB,    isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      { pubkey: SYSVAR_RENT_PUBKEY,      isSigner: false, isWritable: false },
    ],
    data: Buffer.concat([IX_INIT_POOL_V2, u16Le(TICK_SPACING), u128Le(sqrtPrice)]),
  });
}

// ─── Main ─────────────────────────────────────────────────────────────────────
async function sendOrSim(
  connection: ReturnType<typeof connectionFor>,
  tx: Transaction,
  signers: Keypair[],
  dryRun: boolean,
  label: string
): Promise<string | null> {
  tx.recentBlockhash = (await connection.getLatestBlockhash("confirmed")).blockhash;
  tx.sign(...signers);

  const sim = await connection.simulateTransaction(tx);
  if (sim.value.err) {
    console.error(`${label} SIM_FAILED`, JSON.stringify(sim.value.err));
    console.error((sim.value.logs ?? []).slice(-8).join("\n"));
    throw new Error(`${label} simulation failed: ${JSON.stringify(sim.value.err)}`);
  }
  console.log(`${label} sim OK (${sim.value.unitsConsumed ?? "??"} CU)`);

  if (dryRun) {
    console.log(`${label} DRY_RUN — not sent`);
    return null;
  }

  const sig = await sendAndConfirmTransaction(connection, tx, signers, { commitment: "confirmed" });
  console.log(`${label} confirmed: ${sig}`);
  return sig;
}

async function main() {
  const config = loadConfig();
  assertNoForbiddenConfigured(config);
  assertLiveAllowed(config);
  if (!config.crank) throw new Error("Missing REDEMPTION_CRANK in env");

  const connection = connectionFor(config.rpcUrl);
  const funder    = loadKeypair(process.env.CRANK_KEYPAIR_PATH || "keys/crank.json");
  const authority = loadKeypair(process.env.CRANK_KEYPAIR_PATH || "keys/crank.json");
  assertKeypairMatches("crank", funder, config.crank);

  const whirlpoolsConfig = ensureKeypair(
    process.env.ORCA_CONFIG_KEYPAIR_PATH || "keys/official-orca-config.json"
  );
  const configPub = whirlpoolsConfig.publicKey;
  const ext       = deriveConfigExt(configPub);
  const feeTier   = deriveFeeTier(configPub, TICK_SPACING);
  const hopBadge  = deriveTokenBadge(configPub, HOP_MINT);

  // Canonical mint order (lexicographic by bytes)
  const usdcFirst = Buffer.from(USDC_MINT.toBytes()).compare(Buffer.from(HOP_MINT.toBytes())) < 0;
  const mintA     = usdcFirst ? USDC_MINT : HOP_MINT;
  const mintB     = usdcFirst ? HOP_MINT  : USDC_MINT;
  const progA     = mintA.equals(USDC_MINT) ? TOKEN_PROGRAM_ID : TOKEN_2022_PROGRAM_ID;
  const progB     = mintB.equals(USDC_MINT) ? TOKEN_PROGRAM_ID : TOKEN_2022_PROGRAM_ID;
  const badgeA    = mintA.equals(USDC_MINT) ? deriveTokenBadge(configPub, USDC_MINT) : hopBadge;
  const badgeB    = mintB.equals(USDC_MINT) ? deriveTokenBadge(configPub, USDC_MINT) : hopBadge;

  // price = tokenB per tokenA
  const price       = usdcFirst ? (1 / HOP_PRICE_USDC) : HOP_PRICE_USDC;
  const sqrtPrice   = priceToSqrtX64(price);
  const pool        = deriveWhirlpool(configPub, mintA, mintB, TICK_SPACING);

  const [configInfo, extInfo, feeTierInfo, hopBadgeInfo, poolInfo] = await Promise.all([
    connection.getAccountInfo(configPub, "confirmed"),
    connection.getAccountInfo(ext,       "confirmed"),
    connection.getAccountInfo(feeTier,   "confirmed"),
    connection.getAccountInfo(hopBadge,  "confirmed"),
    connection.getAccountInfo(pool,      "confirmed"),
  ]);

  console.log("State:", {
    config:    Boolean(configInfo),
    ext:       Boolean(extInfo),
    feeTier:   Boolean(feeTierInfo),
    hopBadge:  Boolean(hopBadgeInfo),
    pool:      Boolean(poolInfo),
  });

  const receipt: Record<string, unknown> = {
    generatedAt: new Date().toISOString(),
    dryRun: config.dryRun,
    orcaProgram: OFFICIAL_ORCA.toBase58(),
    whirlpoolsConfig: configPub.toBase58(),
    configExtension: ext.toBase58(),
    feeTier: feeTier.toBase58(),
    hopBadge: hopBadge.toBase58(),
    pool: pool.toBase58(),
    mintA: mintA.toBase58(),
    mintB: mintB.toBase58(),
    hopPriceUsdc: HOP_PRICE_USDC,
    initialSqrtPrice: sqrtPrice.toString(),
    authority: authority.publicKey.toBase58(),
    signatures: {} as Record<string, string | null>,
  };

  // ── TX1: config + extension + fee tier ────────────────────────────────────
  const tx1Ixs: TransactionInstruction[] = [];
  if (!configInfo)  tx1Ixs.push(initConfigIx(configPub, funder.publicKey, authority.publicKey));
  if (!extInfo)     tx1Ixs.push(initConfigExtIx(configPub, ext, funder.publicKey, authority.publicKey));
  if (!feeTierInfo) tx1Ixs.push(initFeeTierIx(configPub, feeTier, funder.publicKey, authority.publicKey));

  if (tx1Ixs.length > 0) {
    const tx1 = new Transaction().add(...tx1Ixs);
    tx1.feePayer = funder.publicKey;
    const signers1 = uniqueSigners([funder, whirlpoolsConfig], new Set([funder.publicKey.toBase58(), whirlpoolsConfig.publicKey.toBase58()]));
    (receipt.signatures as Record<string, string | null>).configBootstrap = await sendOrSim(connection, tx1, signers1, config.dryRun, "TX1_CONFIG");
  } else {
    console.log("TX1 — config/ext/feeTier already exist, skipping");
  }

  // ── TX2: HOP token badge ──────────────────────────────────────────────────
  if (!hopBadgeInfo) {
    const tx2 = new Transaction().add(
      initTokenBadgeIx(configPub, ext, authority.publicKey, HOP_MINT, hopBadge, funder.publicKey)
    );
    tx2.feePayer = funder.publicKey;
    const signers2 = [funder, ...(funder.publicKey.equals(authority.publicKey) ? [] : [authority])];
    (receipt.signatures as Record<string, string | null>).hopBadge = await sendOrSim(connection, tx2, signers2, config.dryRun, "TX2_HOP_BADGE");
  } else {
    console.log("TX2 — HOP badge already exists, skipping");
  }

  // ── TX3: pool ─────────────────────────────────────────────────────────────
  if (!poolInfo) {
    const vaultA = Keypair.generate();
    const vaultB = Keypair.generate();
    fs.writeFileSync("keys/official-pool-vault-a.json", JSON.stringify(Array.from(vaultA.secretKey)));
    fs.writeFileSync("keys/official-pool-vault-b.json", JSON.stringify(Array.from(vaultB.secretKey)));
    receipt.tokenVaultA = vaultA.publicKey.toBase58();
    receipt.tokenVaultB = vaultB.publicKey.toBase58();

    const tx3 = new Transaction().add(
      initPoolV2Ix(configPub, mintA, mintB, badgeA, badgeB, funder.publicKey, pool, vaultA.publicKey, vaultB.publicKey, feeTier, progA, progB, sqrtPrice)
    );
    tx3.feePayer = funder.publicKey;
    (receipt.signatures as Record<string, string | null>).pool = await sendOrSim(connection, tx3, [funder, vaultA, vaultB], config.dryRun, "TX3_POOL");
  } else {
    console.log("TX3 — pool already exists, skipping");
    receipt.verdict = "POOL_ALREADY_EXISTS";
  }

  if (!receipt.verdict) {
    receipt.verdict = config.dryRun ? "OFFICIAL_ORCA_BOOTSTRAP_DRY_RUN" : "OFFICIAL_ORCA_BOOTSTRAP_DEPLOYED";
  }

  const out = writeReceipt("REDEMPTION-OFFICIAL-ORCA-BOOTSTRAP.json", receipt);
  console.log(`\n${receipt.verdict}`);
  console.log(`  config:  ${configPub.toBase58()}`);
  console.log(`  pool:    ${pool.toBase58()}`);
  console.log(`  receipt: ${out}`);
}

main().catch((e) => { console.error(e); process.exitCode = 1; });
