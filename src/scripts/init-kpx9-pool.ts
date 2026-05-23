/**
 * Initialize USDC/HOP pool under KPX9 config on official Orca Whirlpools.
 * Fetches current HOP price from Jupiter (mirrors Raydium EwoZHyXz).
 * Writes KPX9-POOL.json receipt.
 */
import "dotenv/config";
import dotenv from "dotenv";
import fs from "node:fs";
import {
  Connection, Keypair, PublicKey, SystemProgram, SYSVAR_RENT_PUBKEY,
  Transaction, TransactionInstruction, sendAndConfirmTransaction,
} from "@solana/web3.js";
import { TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID } from "@solana/spl-token";
import { writeReceipt } from "../utils/receipt.js";

if (process.env.ENV_PATH) dotenv.config({ path: process.env.ENV_PATH, override: true });

const OFFICIAL_ORCA = new PublicKey("whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc");
const KPX9_CONFIG   = new PublicKey("KPX9QQP4GLWiRkh4pGpkagwoPGaGixarRQs1LQKb9dt");
const USDC_MINT     = new PublicKey("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v");
const HOP_MINT      = new PublicKey("HZF5k7h39hkysoSZ4ZfmWc55PhvW7ntVvVqdXFCyYGh3");
const TICK_SPACING  = 64;

const INIT_POOL_V2_DISC = Buffer.from([207, 45, 87, 242, 27, 63, 204, 67]);

function loadKeypair(p: string): Keypair {
  return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(p, "utf8")) as number[]));
}

function saveKeypair(p: string, kp: Keypair): void {
  fs.writeFileSync(p, JSON.stringify(Array.from(kp.secretKey)));
}

function u16Le(v: number): Buffer {
  const b = Buffer.alloc(2); b.writeUInt16LE(v); return b;
}

function u128Le(v: bigint): Buffer {
  const b = Buffer.alloc(16);
  b.writeBigUInt64LE(v & ((1n << 64n) - 1n), 0);
  b.writeBigUInt64LE(v >> 64n, 8);
  return b;
}

function derivePDA(seeds: Buffer[], program: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync(seeds, program)[0];
}

function deriveFeeTier(config: PublicKey, tickSpacing: number): PublicKey {
  return derivePDA([Buffer.from("fee_tier"), config.toBuffer(), u16Le(tickSpacing)], OFFICIAL_ORCA);
}

function deriveTokenBadge(config: PublicKey, mint: PublicKey): PublicKey {
  return derivePDA([Buffer.from("token_badge"), config.toBuffer(), mint.toBuffer()], OFFICIAL_ORCA);
}

function deriveWhirlpool(config: PublicKey, mintA: PublicKey, mintB: PublicKey, tickSpacing: number): PublicKey {
  return derivePDA(
    [Buffer.from("whirlpool"), config.toBuffer(), mintA.toBuffer(), mintB.toBuffer(), u16Le(tickSpacing)],
    OFFICIAL_ORCA
  );
}

function deriveOracle(whirlpool: PublicKey): PublicKey {
  return derivePDA([Buffer.from("oracle"), whirlpool.toBuffer()], OFFICIAL_ORCA);
}

function priceToSqrtPriceX64(tokenBPerTokenA: number): bigint {
  const sqrtPrice = Math.sqrt(tokenBPerTokenA);
  const scale = 1_000_000_000_000_000n;
  return (BigInt(Math.round(sqrtPrice * Number(scale))) * (1n << 64n)) / scale;
}

async function fetchHopPriceUsdc(): Promise<number> {
  if (process.env.HOP_PRICE_USDC) return Number(process.env.HOP_PRICE_USDC);
  // Try Jupiter first
  try {
    const res = await fetch(`https://api.jup.ag/price/v2?ids=${HOP_MINT.toBase58()}`);
    const json = await res.json() as Record<string, unknown>;
    const price = (json?.data as Record<string, Record<string, unknown>>)?.[HOP_MINT.toBase58()]?.price;
    if (price) return Number(price);
  } catch {
    // fall through
  }
  // Fallback: match existing fork pool (0.0001 USDC/HOP)
  console.warn("Jupiter unavailable — using fallback 0.0001 USDC/HOP");
  return 0.0001;
}

async function main() {
  const rpcUrl    = process.env.SOLANA_RPC_URL || process.env.RPC_URL || "https://api.mainnet-beta.solana.com";
  const dryRun    = process.env.DRY_RUN !== "false";
  const allowLive = process.env.ALLOW_LIVE === "true";
  const connection = new Connection(rpcUrl, "confirmed");

  const crank = loadKeypair(process.env.CRANK_KEYPAIR_PATH || "keys/crank.json");

  // Canonical mint order (lexicographic by bytes)
  const usdcFirst = Buffer.from(USDC_MINT.toBytes()).compare(Buffer.from(HOP_MINT.toBytes())) < 0;
  const tokenMintA    = usdcFirst ? USDC_MINT : HOP_MINT;
  const tokenMintB    = usdcFirst ? HOP_MINT  : USDC_MINT;
  const tokenProgramA = tokenMintA.equals(USDC_MINT) ? TOKEN_PROGRAM_ID : TOKEN_2022_PROGRAM_ID;
  const tokenProgramB = tokenMintB.equals(USDC_MINT) ? TOKEN_PROGRAM_ID : TOKEN_2022_PROGRAM_ID;

  const tokenBadgeA = deriveTokenBadge(KPX9_CONFIG, tokenMintA);
  const tokenBadgeB = deriveTokenBadge(KPX9_CONFIG, tokenMintB);
  const feeTier     = deriveFeeTier(KPX9_CONFIG, TICK_SPACING);
  const whirlpool   = deriveWhirlpool(KPX9_CONFIG, tokenMintA, tokenMintB, TICK_SPACING);
  const oracle      = deriveOracle(whirlpool);

  console.log("=== KPX9 INIT POOL ===");
  console.log(`program:     ${OFFICIAL_ORCA.toBase58()}`);
  console.log(`config:      ${KPX9_CONFIG.toBase58()}`);
  console.log(`tokenMintA:  ${tokenMintA.toBase58()} (${tokenMintA.equals(USDC_MINT) ? "USDC" : "HOP"})`);
  console.log(`tokenMintB:  ${tokenMintB.toBase58()} (${tokenMintB.equals(USDC_MINT) ? "USDC" : "HOP"})`);
  console.log(`feeTier:     ${feeTier.toBase58()}`);
  console.log(`whirlpool:   ${whirlpool.toBase58()}`);
  console.log(`oracle:      ${oracle.toBase58()}`);
  console.log(`dry_run:     ${dryRun}`);

  const existing = await connection.getAccountInfo(whirlpool, "confirmed");
  if (existing) {
    const receipt = {
      verdict: "POOL_ALREADY_EXISTS",
      whirlpool: whirlpool.toBase58(),
      tokenMintA: tokenMintA.toBase58(),
      tokenMintB: tokenMintB.toBase58(),
      oracle: oracle.toBase58(),
    };
    writeReceipt("KPX9-POOL.json", receipt);
    console.log(`POOL_ALREADY_EXISTS pool=${whirlpool.toBase58()}`);
    return;
  }

  const hopPriceUsdc = await fetchHopPriceUsdc();
  // price = tokenB per tokenA
  const price = tokenMintA.equals(USDC_MINT)
    ? 1 / hopPriceUsdc  // HOP per USDC
    : hopPriceUsdc;     // USDC per HOP
  const initialSqrtPrice = priceToSqrtPriceX64(price);

  console.log(`hopPriceUsdc:  ${hopPriceUsdc}`);
  console.log(`price (B/A):   ${price}`);
  console.log(`initialSqrtP:  ${initialSqrtPrice}`);

  const tokenVaultA = Keypair.generate();
  const tokenVaultB = Keypair.generate();
  saveKeypair("keys/kpx9-vault-a.json", tokenVaultA);
  saveKeypair("keys/kpx9-vault-b.json", tokenVaultB);

  const ix = new TransactionInstruction({
    programId: OFFICIAL_ORCA,
    keys: [
      { pubkey: KPX9_CONFIG,             isSigner: false, isWritable: false },
      { pubkey: tokenMintA,              isSigner: false, isWritable: false },
      { pubkey: tokenMintB,              isSigner: false, isWritable: false },
      { pubkey: tokenBadgeA,             isSigner: false, isWritable: false },
      { pubkey: tokenBadgeB,             isSigner: false, isWritable: false },
      { pubkey: crank.publicKey,         isSigner: true,  isWritable: true  },
      { pubkey: whirlpool,               isSigner: false, isWritable: true  },
      { pubkey: tokenVaultA.publicKey,   isSigner: true,  isWritable: true  },
      { pubkey: tokenVaultB.publicKey,   isSigner: true,  isWritable: true  },
      { pubkey: feeTier,                 isSigner: false, isWritable: false },
      { pubkey: tokenProgramA,           isSigner: false, isWritable: false },
      { pubkey: tokenProgramB,           isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      { pubkey: SYSVAR_RENT_PUBKEY,      isSigner: false, isWritable: false },
    ],
    data: Buffer.concat([INIT_POOL_V2_DISC, u16Le(TICK_SPACING), u128Le(initialSqrtPrice)]),
  });

  const receipt: Record<string, unknown> = {
    verdict: "POOL_PLAN",
    hopPriceUsdc,
    price,
    initialSqrtPrice: initialSqrtPrice.toString(),
    whirlpool: whirlpool.toBase58(),
    tokenMintA: tokenMintA.toBase58(),
    tokenMintB: tokenMintB.toBase58(),
    tokenVaultA: tokenVaultA.publicKey.toBase58(),
    tokenVaultB: tokenVaultB.publicKey.toBase58(),
    feeTier: feeTier.toBase58(),
    oracle: oracle.toBase58(),
    tickSpacing: TICK_SPACING,
    dryRun,
    signature: null as string | null,
  };

  const tx = new Transaction().add(ix);
  tx.feePayer = crank.publicKey;
  tx.recentBlockhash = (await connection.getLatestBlockhash("confirmed")).blockhash;
  tx.sign(crank, tokenVaultA, tokenVaultB);

  const sim = await connection.simulateTransaction(tx);
  receipt.simErr  = sim.value.err ?? null;
  receipt.simLogs = sim.value.logs?.slice(-10) ?? [];

  if (sim.value.err) {
    receipt.verdict = "POOL_SIM_FAILED";
    writeReceipt("KPX9-POOL.json", receipt);
    console.error(`SIM_FAILED: ${JSON.stringify(sim.value.err)}`);
    (receipt.simLogs as string[]).forEach(l => console.error(l));
    process.exitCode = 1;
    return;
  }

  if (dryRun || !allowLive) {
    receipt.verdict = "POOL_SIM_OK";
    writeReceipt("KPX9-POOL.json", receipt);
    console.log(`\nSIM_OK pool=${whirlpool.toBase58()}`);
    return;
  }

  const sig = await sendAndConfirmTransaction(connection, tx, [crank, tokenVaultA, tokenVaultB], { commitment: "confirmed" });
  receipt.verdict   = "POOL_EXECUTED";
  receipt.signature = sig;
  writeReceipt("KPX9-POOL.json", receipt);
  console.log(`\nEXECUTED sig=${sig}`);
  console.log(`pool:     ${whirlpool.toBase58()}`);
  console.log(`vaultA:   ${tokenVaultA.publicKey.toBase58()}`);
  console.log(`vaultB:   ${tokenVaultB.publicKey.toBase58()}`);
  console.log(`oracle:   ${oracle.toBase58()}`);
}

main().catch(e => { console.error(e); process.exitCode = 1; });
