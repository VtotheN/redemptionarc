import "dotenv/config";
import dotenv from "dotenv";
import fs from "node:fs";
import { PublicKey } from "@solana/web3.js";
import { HOP_MINT_DEFAULT, USDC_MINT_DEFAULT } from "./constants.js";

if (!process.env.ENV_PATH && fs.existsSync(".env.redemptionarc")) {
  dotenv.config({ path: ".env.redemptionarc", override: false });
}

if (process.env.ENV_PATH) {
  dotenv.config({ path: process.env.ENV_PATH, override: true });
}

export type RedemptionConfig = {
  rpcUrl: string;
  dryRun: boolean;
  allowLive: boolean;
  treasury?: PublicKey;
  crank?: PublicKey;
  withdrawAuthority?: PublicKey;
  usdcMint: PublicKey;
  hopMint: PublicKey;
  minNetUsd: number;
  solPriceUsd?: number;
  forceEnvSolPrice: boolean;
  ledgerMode: "treasury" | "total-system";
  routeVolumeUsdc: number;
  hops: number;
  tx2CushionExtraUsdcMicro: bigint;
  tx2MinCushionSolLamports: bigint;
  tx2CuLimit: number;
  tx2CuPriceMicroLamports: number;
  jupiterSlippageBps: number;
  keeperPaused: boolean;
  keeperIntervalMs: number;
};

function boolEnv(name: string, fallback: boolean): boolean {
  const raw = process.env[name];
  if (raw == null || raw === "") return fallback;
  return ["1", "true", "yes", "y"].includes(raw.toLowerCase());
}

function numberEnv(name: string, fallback?: number): number | undefined {
  const raw = process.env[name];
  if (raw == null || raw === "") return fallback;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) {
    throw new Error(`Invalid numeric env ${name}=${raw}`);
  }
  return parsed;
}

function bigintEnv(name: string, fallback: bigint): bigint {
  const raw = process.env[name];
  if (raw == null || raw === "") return fallback;
  return BigInt(raw);
}

function optionalPubkey(name: string): PublicKey | undefined {
  const raw = process.env[name];
  if (!raw) return undefined;
  return new PublicKey(raw);
}

function requiredPubkeyFromDefault(name: string, fallback: string): PublicKey {
  return new PublicKey(process.env[name] || fallback);
}

export function loadConfig(): RedemptionConfig {
  const rpcUrl =
    process.env.SOLANA_RPC_URL ||
    process.env.RPC_URL ||
    "https://api.mainnet-beta.solana.com";

  const ledgerMode = process.env.LEDGER_MODE === "total-system" ? "total-system" : "treasury";

  return {
    rpcUrl,
    dryRun: boolEnv("DRY_RUN", true),
    allowLive: boolEnv("ALLOW_LIVE", false),
    treasury: optionalPubkey("REDEMPTION_TREASURY"),
    crank: optionalPubkey("REDEMPTION_CRANK"),
    withdrawAuthority: optionalPubkey("REDEMPTION_WITHDRAW_AUTHORITY"),
    usdcMint: requiredPubkeyFromDefault("USDC_MINT", USDC_MINT_DEFAULT),
    hopMint: requiredPubkeyFromDefault("HOP_MINT", HOP_MINT_DEFAULT),
    minNetUsd: numberEnv("MIN_NET_USD", 0.25) ?? 0.25,
    solPriceUsd: numberEnv("SOL_PRICE_USD"),
    forceEnvSolPrice: boolEnv("FORCE_ENV_SOL_PRICE", false),
    ledgerMode,
    routeVolumeUsdc: numberEnv("ROUTE_VOLUME_USDC", 39) ?? 39,
    hops: numberEnv("HOPS", 2) ?? 2,
    tx2CushionExtraUsdcMicro: bigintEnv("TX2_CUSHION_EXTRA_USDC_MICRO", 4_000_000n),
    tx2MinCushionSolLamports: bigintEnv("TX2_MIN_CUSHION_SOL_LAMPORTS", 10_000_000n),
    tx2CuLimit: numberEnv("TX2_CU_LIMIT", 400_000) ?? 400_000,
    tx2CuPriceMicroLamports: numberEnv("TX2_CU_PRICE_MICRO_LAMPORTS", 1_000) ?? 1_000,
    jupiterSlippageBps: numberEnv("JUPITER_SLIPPAGE_BPS", 100) ?? 100,
    keeperPaused: boolEnv("KEEPER_PAUSED", true),
    keeperIntervalMs: numberEnv("KEEPER_INTERVAL_MS", 1500) ?? 1500
  };
}
