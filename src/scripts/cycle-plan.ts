import "dotenv/config";
import dotenv from "dotenv";
import fs from "node:fs";
import { getAssociatedTokenAddressSync, NATIVE_MINT, TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID } from "@solana/spl-token";
import { Keypair } from "@solana/web3.js";
import { loadConfig } from "../config.js";
import { writeReceipt } from "../utils/receipt.js";

if (process.env.ENV_PATH) {
  dotenv.config({ path: process.env.ENV_PATH, override: true });
}

function loadKeypair(file: string): Keypair {
  const raw = JSON.parse(fs.readFileSync(file, "utf8")) as number[];
  return Keypair.fromSecretKey(Uint8Array.from(raw));
}

function readRouteVerdict(): string {
  const file = "receipts/REDEMPTION-SETTLEMENT-ROUTE-SCAN-LATEST.json";
  if (!fs.existsSync(file)) return "MISSING_SETTLEMENT_ROUTE_SCAN";
  return JSON.parse(fs.readFileSync(file, "utf8")).verdict ?? "UNKNOWN";
}

function main() {
  const config = loadConfig();
  const routeVerdict = readRouteVerdict();
  const routeVolumeUsdc = Number(process.env.ROUTE_VOLUME_USDC || "39");
  const minCrankSol = Number(process.env.MIN_CRANK_SOL_FOR_MICRO_CYCLE || "0.08");
  const targetVolumeUsdc = Number(process.env.TARGET_ROUTE_VOLUME_USDC || "20633");
  const targetFloatSol = Number(process.env.TARGET_FLOAT_SOL_ESTIMATE || "1.0");

  const ringPaths = (process.env.RING_KEYPAIR_PATHS || "./keys/ring1.json,./keys/ring2.json,./keys/ring3.json,./keys/ring4.json")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
  const rings = ringPaths.filter((file) => fs.existsSync(file)).map(loadKeypair);

  const accounts = config.treasury && config.crank ? {
    treasury: config.treasury.toBase58(),
    crank: config.crank.toBase58(),
    withdrawAuthority: config.withdrawAuthority?.toBase58() ?? null,
    treasuryUsdcAta: getAssociatedTokenAddressSync(config.usdcMint, config.treasury, false, TOKEN_PROGRAM_ID).toBase58(),
    ghostUsdcAta: getAssociatedTokenAddressSync(config.usdcMint, config.crank, false, TOKEN_PROGRAM_ID).toBase58(),
    crankWsolAta: getAssociatedTokenAddressSync(NATIVE_MINT, config.crank, false, TOKEN_PROGRAM_ID).toBase58(),
    hopEscrowAta: getAssociatedTokenAddressSync(config.hopMint, config.crank, false, TOKEN_2022_PROGRAM_ID).toBase58(),
    treasuryHopAta: getAssociatedTokenAddressSync(config.hopMint, config.treasury, false, TOKEN_2022_PROGRAM_ID).toBase58(),
    ringAtas: rings.map((ring) => getAssociatedTokenAddressSync(config.hopMint, ring.publicKey, false, TOKEN_2022_PROGRAM_ID).toBase58()),
    ringOwners: rings.map((ring) => ring.publicKey.toBase58())
  } : null;

  const blockers: string[] = [];
  if (!config.treasury || !config.crank || !config.withdrawAuthority) blockers.push("missing RedemptionArc wallets");
  if (rings.length < 4) blockers.push("missing four ring owner keypairs");
  if (routeVerdict !== "SETTLEMENT_ROUTE_READY_JUPITER") {
    blockers.push(`cash settlement route not ready: ${routeVerdict}`);
  }

  const verdict = blockers.length === 0
    ? "REDEMPTION_CYCLE_PLAN_READY_NO_LIVE"
    : "REDEMPTION_CYCLE_PLAN_BLOCKED_NO_CASH_SETTLEMENT";

  const receipt = {
    verdict,
    generatedAt: new Date().toISOString(),
    dryRun: config.dryRun,
    allowLive: config.allowLive,
    accounts,
    plannedTxs: [
      {
        name: "TX0_CUSHION",
        role: "optional SOL/WSOL to USDC float for ghost account",
        liveStatus: "disabled"
      },
      {
        name: "TX2_HOP_RING",
        role: "Kamino borrow + Token-2022 hop ring + repay",
        liveStatus: "disabled"
      },
      {
        name: "TX3_SETTLE_SWEEP",
        role: "withdraw/settle fees to SOL/USDC, sweep cash to treasury",
        liveStatus: "blocked until settlement route exists"
      }
    ],
    floatEstimates: {
      microCycle: {
        routeVolumeUsdc,
        minCrankSol
      },
      targetCycle: {
        targetVolumeUsdc,
        targetFloatSol,
        note: "rough placeholder; must be replaced by exact no-send TX simulation"
      }
    },
    blockers,
    nextRequiredProof: [
      "settlement-route-scan returns READY",
      "exact TX0/TX2/TX3 simulation succeeds with RedemptionArc accounts",
      "receipt shows spendable SOL+USDC after > before",
      "Velon explicitly approves one live micro-cycle"
    ]
  };

  const out = writeReceipt("REDEMPTION-CYCLE-PLAN-LATEST.json", receipt);
  console.log(`${verdict} blockers=${blockers.length} receipt=${out}`);
  if (blockers.length > 0) process.exitCode = 1;
}

main();
