import "dotenv/config";
import fs from "node:fs";
import { Keypair, PublicKey, Transaction, sendAndConfirmTransaction } from "@solana/web3.js";
import { TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID } from "@solana/spl-token";
import { loadConfig } from "../config.js";
import { connectionFor } from "../utils/rpc.js";
import { writeReceipt } from "../utils/receipt.js";
import { assertKeypairMatches, loadKeypair } from "../utils/keypair.js";
import { assertLiveAllowed, assertNoForbiddenConfigured } from "../utils/safety.js";
import {
  deriveFeeTier,
  deriveTokenBadge,
  deriveWhirlpool,
  initializePoolV2Ix,
  serializableInstruction,
} from "../utils/orca-whirlpool.js";

const TICK_SPACING = Number(process.env.ORCA_TICK_SPACING || "64");
const USDC_MINT = new PublicKey("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v");
const HOP_MINT  = new PublicKey("HZF5k7h39hkysoSZ4ZfmWc55PhvW7ntVvVqdXFCyYGh3");

async function fetchHopPriceUsdc(): Promise<number> {
  const url = `https://api.jup.ag/price/v2?ids=${HOP_MINT.toBase58()}`;
  const res = await fetch(url);
  const json = (await res.json()) as Record<string, unknown>;
  const price = (json?.data as Record<string, Record<string, unknown>>)?.[HOP_MINT.toBase58()]?.price;
  if (!price) throw new Error("Jupiter price API returned no price for HOP");
  return Number(price);
}

function priceToSqrtPriceX64(tokenBPerTokenA: number): bigint {
  const sqrtPrice = Math.sqrt(tokenBPerTokenA);
  const scale = 1_000_000_000n;
  const sqrtScaled = BigInt(Math.floor(sqrtPrice * Number(scale)));
  return (sqrtScaled * (1n << 64n)) / scale;
}

type ConfigReceipt = { createdAccountAddresses?: { whirlpoolsConfig?: string } };

function readConfigReceipt(): ConfigReceipt {
  const file = "receipts/REDEMPTION-ORCA-CONFIG.json";
  if (!fs.existsSync(file)) throw new Error(`Missing ${file} — run init-orca-config first`);
  return JSON.parse(fs.readFileSync(file, "utf8")) as ConfigReceipt;
}

async function main() {
  const config = loadConfig();
  assertNoForbiddenConfigured(config);
  assertLiveAllowed(config);
  if (!config.crank) throw new Error("Missing REDEMPTION_CRANK");

  const connection = connectionFor(config.rpcUrl);
  const funder = loadKeypair("keys/crank.json");
  assertKeypairMatches("crank", funder, config.crank);

  const configReceipt = readConfigReceipt();
  const whirlpoolsConfig = new PublicKey(configReceipt.createdAccountAddresses!.whirlpoolsConfig!);

  // Canonical mint order (lexicographic by pubkey bytes)
  const usdcBytes = Buffer.from(USDC_MINT.toBytes());
  const hopBytes  = Buffer.from(HOP_MINT.toBytes());
  const usdcFirst = usdcBytes.compare(hopBytes) < 0;
  const tokenMintA = usdcFirst ? USDC_MINT : HOP_MINT;
  const tokenMintB = usdcFirst ? HOP_MINT  : USDC_MINT;
  const tokenProgramA = tokenMintA.equals(USDC_MINT) ? TOKEN_PROGRAM_ID : TOKEN_2022_PROGRAM_ID;
  const tokenProgramB = tokenMintB.equals(USDC_MINT) ? TOKEN_PROGRAM_ID : TOKEN_2022_PROGRAM_ID;

  const tokenBadgeA = deriveTokenBadge(whirlpoolsConfig, tokenMintA);
  const tokenBadgeB = deriveTokenBadge(whirlpoolsConfig, tokenMintB);
  const feeTier     = deriveFeeTier(whirlpoolsConfig, TICK_SPACING);
  const whirlpool   = deriveWhirlpool(whirlpoolsConfig, tokenMintA, tokenMintB, TICK_SPACING);

  const poolInfo = await connection.getAccountInfo(whirlpool, "confirmed");
  if (poolInfo) {
    writeReceipt("REDEMPTION-ORCA-POOL.json", {
      verdict: "POOL_ALREADY_EXISTS",
      whirlpool: whirlpool.toBase58(),
      tokenMintA: tokenMintA.toBase58(),
      tokenMintB: tokenMintB.toBase58(),
    });
    console.log(`POOL_ALREADY_EXISTS pool=${whirlpool.toBase58()}`);
    return;
  }

  const hopPriceUsdc = process.env.HOP_PRICE_USDC
    ? Number(process.env.HOP_PRICE_USDC)
    : await fetchHopPriceUsdc();

  // price = tokenB per tokenA
  const price = tokenMintA.equals(USDC_MINT)
    ? 1 / hopPriceUsdc   // USDC→HOP: how many HOP per 1 USDC
    : hopPriceUsdc;      // HOP→USDC
  const initialSqrtPrice = priceToSqrtPriceX64(price);

  // Fresh vault keypairs
  const tokenVaultA = Keypair.generate();
  const tokenVaultB = Keypair.generate();
  fs.writeFileSync("keys/pool-vault-a.json", JSON.stringify(Array.from(tokenVaultA.secretKey)));
  fs.writeFileSync("keys/pool-vault-b.json", JSON.stringify(Array.from(tokenVaultB.secretKey)));

  const ix = initializePoolV2Ix({
    whirlpoolsConfig,
    tokenMintA,
    tokenMintB,
    tokenBadgeA,
    tokenBadgeB,
    funder: funder.publicKey,
    whirlpool,
    tokenVaultA: tokenVaultA.publicKey,
    tokenVaultB: tokenVaultB.publicKey,
    feeTier,
    tokenProgramA,
    tokenProgramB,
    tickSpacing: TICK_SPACING,
    initialSqrtPrice,
  });

  const receipt: Record<string, unknown> = {
    verdict: "POOL_PLAN_BUILT",
    dryRun: config.dryRun,
    hopPriceUsdc,
    price,
    initialSqrtPrice: initialSqrtPrice.toString(),
    whirlpool: whirlpool.toBase58(),
    tokenMintA: tokenMintA.toBase58(),
    tokenMintB: tokenMintB.toBase58(),
    tokenVaultA: tokenVaultA.publicKey.toBase58(),
    tokenVaultB: tokenVaultB.publicKey.toBase58(),
    feeTier: feeTier.toBase58(),
    instruction: serializableInstruction(ix),
  };

  const tx = new Transaction().add(ix);
  tx.feePayer = funder.publicKey;
  tx.recentBlockhash = (await connection.getLatestBlockhash("confirmed")).blockhash;
  tx.sign(funder, tokenVaultA, tokenVaultB);

  const sim = await connection.simulateTransaction(tx);
  receipt.simulation = { err: sim.value.err ?? null, logs: (sim.value.logs ?? []).slice(-10) };

  if (sim.value.err) {
    receipt.verdict = "POOL_SIM_FAILED";
    writeReceipt("REDEMPTION-ORCA-POOL.json", receipt);
    console.error(`POOL_SIM_FAILED err=${JSON.stringify(sim.value.err)}`);
    console.error((sim.value.logs ?? []).slice(-5).join("\n"));
    process.exitCode = 1;
    return;
  }

  if (config.dryRun) {
    receipt.verdict = "POOL_SIM_OK_DRY_RUN";
    writeReceipt("REDEMPTION-ORCA-POOL.json", receipt);
    console.log(`POOL_SIM_OK_DRY_RUN pool=${whirlpool.toBase58()}`);
    return;
  }

  const sig = await sendAndConfirmTransaction(connection, tx, [funder, tokenVaultA, tokenVaultB], {
    commitment: "confirmed",
  });
  receipt.verdict = "POOL_DEPLOYED";
  receipt.signature = sig;
  writeReceipt("REDEMPTION-ORCA-POOL.json", receipt);
  console.log(`POOL_DEPLOYED sig=${sig} pool=${whirlpool.toBase58()}`);
}

main().catch((e) => { console.error(e); process.exitCode = 1; });
