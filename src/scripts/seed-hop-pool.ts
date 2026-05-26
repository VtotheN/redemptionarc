/**
 * Create HOP/USDC CPMM pool on Raydium + seed initial liquidity.
 *
 * Requires: @raydium-io/raydium-sdk-v2 (install with: npm install @raydium-io/raydium-sdk-v2)
 *
 * ENV:
 *   SOLANA_RPC_URL
 *   DRY_RUN=true|false (default true)
 *   ALLOW_LIVE=true (required to send)
 *   SEED_USDC=500            (USDC to seed, e.g. 500 = $500)
 *   SEED_HOP=50000000        (HOP units to seed, e.g. 50000000 = 50 HOP at 6 decimals)
 *   HOP_PRICE_USD=0.01       (initial price: SEED_USDC / (SEED_HOP / 1e6))
 *   AMM_CONFIG_INDEX=0       (0=0.25%, 1=1%, 2=2%, 3=4%, 4=0.5%, 5=0.3%; default 0)
 *
 * After creation: Jupiter will index the pool within ~30 min.
 * Then run: npm run sell-hop-fees
 */
import "dotenv/config";
import fs from "node:fs";
import {
  Connection, Keypair, PublicKey,
} from "@solana/web3.js";
import {
  getAssociatedTokenAddressSync,
  TOKEN_2022_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
} from "@solana/spl-token";
import { writeReceipt } from "../utils/receipt.js";

const HOP_MINT = new PublicKey("HZF5k7h39hkysoSZ4ZfmWc55PhvW7ntVvVqdXFCyYGh3");
const USDC_MINT = new PublicKey("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v");
const HOP_DECIMALS = 6;
const USDC_DECIMALS = 6;

// Raydium CPMM AMM Configs — PDAs of CPMMoo8L3F4NbTegBCKVNunggL7H1ZpdTHKxQB5qKP1C
// Verified on-chain 2026-05-26. tradeFee / 1,000,000 = LP fee rate.
// Index  |  Fee    | PDA
// 0      |  0.25%  | D4FPEruKEHrG5TenZ2mpDGEfu1iUvTiqBxvpU8HLBvC2
// 1      |  1%     | G95xxie3XbkCqtE39GgQ9Ggc7xBC8Uceve7HFDEFApkc
// 2      |  2%     | 2fGXL8uhqxJ4tpgtosHZXT4zcQap6j62z3bMDxdkMvy5  (old pool uses this)
// 3      |  4%     | C7Cx2pMLtjybS3mDKSfsBj4zQ3PRZGkKt7RCYTTbCSx2
// 4      |  0.5%   | BhH6HphjBKXu2PkUc2aw3xEMdUvK14NXxE5LbNWZNZAA
// 5      |  0.3%   | BgxH5ifebqHDuiADWKhLjXGP5hWZeZLoCdmeWJLkRqLP
// 6      |  1.5%   | B5u5x9S5pyaJdonf7bXUiEnBfEXsJWhNxXfLGAbRFtg2
// 7      |  2.5%   | ESLj2Rzmvn3RhDo4Z18hY1wYmGyC9xM4ZtRXhvoFkDAi
const AMM_CONFIGS: Record<number, { pubkey: string; fee: string }> = {
  0: { pubkey: "D4FPEruKEHrG5TenZ2mpDGEfu1iUvTiqBxvpU8HLBvC2", fee: "0.25%" },
  1: { pubkey: "G95xxie3XbkCqtE39GgQ9Ggc7xBC8Uceve7HFDEFApkc", fee: "1%" },
  2: { pubkey: "2fGXL8uhqxJ4tpgtosHZXT4zcQap6j62z3bMDxdkMvy5", fee: "2%" },
  3: { pubkey: "C7Cx2pMLtjybS3mDKSfsBj4zQ3PRZGkKt7RCYTTbCSx2", fee: "4%" },
  4: { pubkey: "BhH6HphjBKXu2PkUc2aw3xEMdUvK14NXxE5LbNWZNZAA", fee: "0.5%" },
  5: { pubkey: "BgxH5ifebqHDuiADWKhLjXGP5hWZeZLoCdmeWJLkRqLP", fee: "0.3%" },
  6: { pubkey: "B5u5x9S5pyaJdonf7bXUiEnBfEXsJWhNxXfLGAbRFtg2", fee: "1.5%" },
  7: { pubkey: "ESLj2Rzmvn3RhDo4Z18hY1wYmGyC9xM4ZtRXhvoFkDAi", fee: "2.5%" },
};

function loadKeypair(p: string) {
  return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(p, "utf8")) as number[]));
}

async function main() {
  const rpc = process.env.SOLANA_RPC_URL || "https://api.mainnet-beta.solana.com";
  const dryRun = process.env.DRY_RUN !== "false";
  const allowLive = process.env.ALLOW_LIVE === "true";
  const seedUsdc = Number(process.env.SEED_USDC || "500");
  const seedHopUi = Number(process.env.SEED_HOP_UI || "50000");  // HOP in whole units
  const ammConfigIndex = Number(process.env.AMM_CONFIG_INDEX || "0");  // 0.25% fee default

  const conn = new Connection(rpc, "confirmed");
  const crank = loadKeypair("keys/crank.json");

  const ammConfig = AMM_CONFIGS[ammConfigIndex];
  if (!ammConfig) throw new Error(`Invalid AMM_CONFIG_INDEX ${ammConfigIndex}`);

  const seedUsdcMicro = BigInt(Math.round(seedUsdc * 10 ** USDC_DECIMALS));
  const seedHopUnits = BigInt(Math.round(seedHopUi * 10 ** HOP_DECIMALS));
  const impliedHopPriceUsd = seedUsdc / seedHopUi;

  console.log("=== SEED HOP/USDC POOL ===");
  console.log(`Crank:         ${crank.publicKey.toBase58()}`);
  console.log(`HOP Mint:      ${HOP_MINT.toBase58()}`);
  console.log(`USDC Mint:     ${USDC_MINT.toBase58()}`);
  console.log(`Seed USDC:     $${seedUsdc} (${seedUsdcMicro} micro)`);
  console.log(`Seed HOP:      ${seedHopUi} HOP (${seedHopUnits} units)`);
  console.log(`Initial price: $${impliedHopPriceUsd.toFixed(6)}/HOP`);
  console.log(`AMM Config:    ${ammConfig.pubkey} (${ammConfig.fee} fee)`);
  console.log();

  // Check that crank has enough USDC and HOP
  const crankUsdcAta = getAssociatedTokenAddressSync(USDC_MINT, crank.publicKey, false, TOKEN_PROGRAM_ID);
  const crankHopAta = getAssociatedTokenAddressSync(HOP_MINT, crank.publicKey, false, TOKEN_2022_PROGRAM_ID);

  let usdcBalance = 0n;
  let hopBalance = 0n;
  try {
    const { getAccount } = await import("@solana/spl-token");
    const usdcInfo = await getAccount(conn, crankUsdcAta, "confirmed", TOKEN_PROGRAM_ID);
    usdcBalance = usdcInfo.amount;
    const hopInfo = await getAccount(conn, crankHopAta, "confirmed", TOKEN_2022_PROGRAM_ID);
    hopBalance = hopInfo.amount;
  } catch (e) {
    console.log("Could not fetch balances:", e instanceof Error ? e.message : String(e));
  }

  console.log(`Crank USDC: ${Number(usdcBalance) / 10 ** USDC_DECIMALS} USDC (need $${seedUsdc})`);
  console.log(`Crank HOP:  ${Number(hopBalance) / 10 ** HOP_DECIMALS} HOP (need ${seedHopUi})`);

  if (usdcBalance < seedUsdcMicro) {
    console.error(`INSUFFICIENT USDC: have ${Number(usdcBalance) / 1e6} need ${seedUsdc}`);
    console.error(`Fund crank (${crank.publicKey.toBase58()}) with $${seedUsdc} USDC first.`);
    process.exitCode = 1;
    return;
  }
  if (hopBalance < seedHopUnits) {
    console.error(`INSUFFICIENT HOP: have ${Number(hopBalance) / 1e6} need ${seedHopUi}`);
    process.exitCode = 1;
    return;
  }

  // Check if Raydium SDK is installed
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let sdk: any;
  try {
    // Dynamic import — won't fail tsc if SDK not installed
    sdk = await import(/* @vite-ignore */ "@raydium-io/raydium-sdk-v2" as string);
  } catch {
    console.error("Missing SDK. Install: npm install @raydium-io/raydium-sdk-v2");
    console.error("\nAlternative — create pool manually via Raydium UI:");
    console.error("  https://raydium.io/liquidity/create-pool/");
    console.error(`  Token0: ${HOP_MINT.toBase58()} (HOP, T22)`);
    console.error(`  Token1: ${USDC_MINT.toBase58()} (USDC)`);
    console.error(`  Initial price: ${impliedHopPriceUsd} USDC/HOP`);
    console.error(`  Seed: $${seedUsdc} USDC + ${seedHopUi} HOP`);
    console.error(`  AMM Config: ${ammConfig.pubkey} (${ammConfig.fee} fee)`);

    writeReceipt("seed-hop-pool", {
      verdict: "SDK_MISSING",
      instruction: "npm install @raydium-io/raydium-sdk-v2 then re-run",
      manualUrl: "https://raydium.io/liquidity/create-pool/",
      hopMint: HOP_MINT.toBase58(),
      usdcMint: USDC_MINT.toBase58(),
      seedUsdc,
      seedHopUi,
      impliedPriceUsd: impliedHopPriceUsd,
      ammConfig: ammConfig.pubkey,
    });
    process.exitCode = 1;
    return;
  }

  // SDK available — create pool
  const {
    Raydium,
    CREATE_CPMM_POOL_PROGRAM,
    CREATE_CPMM_POOL_FEE_ACC,
    getCpmmPdaAmmConfigId,
  } = sdk;
  // BN must come from bn.js directly (SDK doesn't re-export the constructor)
  const BNModule = await import("bn.js");
  const BN = BNModule.default ?? BNModule;
  console.log("Raydium SDK loaded. Initializing...");

  const raydium = await Raydium.load({
    connection: conn,
    owner: crank,
    disableFeatureCheck: true,
  });

  // Sort mints (Raydium requires token0 < token1 by pubkey)
  const [mint0, mint1, token0Program, token1Program, amount0, amount1] =
    HOP_MINT.toBase58() < USDC_MINT.toBase58()
      ? [HOP_MINT, USDC_MINT, TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID, seedHopUnits, seedUsdcMicro]
      : [USDC_MINT, HOP_MINT, TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID, seedUsdcMicro, seedHopUnits];

  // Derive correct AMM config PDA for this program + index
  const configPda = getCpmmPdaAmmConfigId(CREATE_CPMM_POOL_PROGRAM, ammConfigIndex);
  const configPubkey = configPda.publicKey ?? configPda;
  console.log(`AMM Config PDA (index ${ammConfigIndex}): ${configPubkey.toBase58()}`);

  const { execute, extInfo } = await raydium.cpmm.createPool({
    programId: CREATE_CPMM_POOL_PROGRAM,
    poolFeeAccount: CREATE_CPMM_POOL_FEE_ACC,
    mintA: {
      address: mint0.toBase58(),
      decimals: mint0.equals(HOP_MINT) ? HOP_DECIMALS : USDC_DECIMALS,
      programId: token0Program.toBase58(),
    },
    mintB: {
      address: mint1.toBase58(),
      decimals: mint1.equals(HOP_MINT) ? HOP_DECIMALS : USDC_DECIMALS,
      programId: token1Program.toBase58(),
    },
    mintAAmount: new BN(amount0.toString()),
    mintBAmount: new BN(amount1.toString()),
    startTime: new BN(0),
    feeConfig: { id: configPubkey },
    associatedOnly: false,
    ownerInfo: { feePayer: crank.publicKey },
    txVersion: 0,
  });

  const poolId = extInfo?.address?.poolId?.toBase58() ?? "unknown";
  console.log(`Pool PDA: ${poolId}`);

  if (dryRun || !allowLive) {
    console.log("DRY_RUN: skipping pool creation. Set DRY_RUN=false ALLOW_LIVE=true to create.");
    writeReceipt("seed-hop-pool", {
      verdict: "DRY_RUN",
      poolId,
      seedUsdc,
      seedHopUi,
      impliedPriceUsd: impliedHopPriceUsd,
    });
    return;
  }

  const { txId } = await execute({ sendAndConfirm: true });

  console.log(`\nPOOL CREATED: ${txId}`);
  console.log(`Pool ID:      ${poolId}`);
  console.log(`\nNext steps:`);
  console.log(`  1. Wait ~30 min for Jupiter to index`);
  console.log(`  2. npm run sell-hop-fees`);
  console.log(`  3. keeper-loop with SELL_EVERY_N_CYCLES=100`);

  writeReceipt("seed-hop-pool", {
    verdict: "EXECUTED",
    txId,
    poolId,
    mint0: mint0.toBase58(),
    mint1: mint1.toBase58(),
    amount0: amount0.toString(),
    amount1: amount1.toString(),
    seedUsdc,
    seedHopUi,
    impliedPriceUsd: impliedHopPriceUsd,
    ammConfig: ammConfig.pubkey,
    jupiterIndexingEta: "~30 minutes",
  });
}

main().catch(e => { console.error(e); process.exitCode = 1; });
