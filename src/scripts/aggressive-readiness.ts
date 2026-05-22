import "dotenv/config";
import dotenv from "dotenv";
import fs from "node:fs";
import { getAssociatedTokenAddressSync, NATIVE_MINT, TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID } from "@solana/spl-token";
import { LAMPORTS_PER_SOL, PublicKey } from "@solana/web3.js";
import { loadConfig } from "../config.js";
import { FORBIDDEN_WALLETS } from "../constants.js";
import { connectionFor } from "../utils/rpc.js";
import { writeReceipt } from "../utils/receipt.js";

if (process.env.ENV_PATH) {
  dotenv.config({ path: process.env.ENV_PATH, override: true });
}

function readAggressivePlan() {
  const file = "receipts/REDEMPTION-AGGRESSIVE-PLAN-LATEST.json";
  if (!fs.existsSync(file)) return null;
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

async function accountExists(connection: ReturnType<typeof connectionFor>, pubkey: PublicKey): Promise<boolean> {
  return Boolean(await connection.getAccountInfo(pubkey, "confirmed"));
}

async function main() {
  const config = loadConfig();
  const connection = connectionFor(config.rpcUrl);
  const plan = readAggressivePlan();
  const selected = plan?.selected;
  const blockers: string[] = [];

  if (!selected) blockers.push("missing aggressive selected plan");
  if (!config.treasury || !config.crank || !config.withdrawAuthority) blockers.push("missing redemption wallets");

  for (const wallet of [config.treasury, config.crank, config.withdrawAuthority]) {
    if (wallet && FORBIDDEN_WALLETS.has(wallet.toBase58())) {
      blockers.push(`forbidden wallet configured: ${wallet.toBase58()}`);
    }
  }

  let crankSol = 0;
  let accountChecks: Record<string, unknown> = {};
  if (config.treasury && config.crank) {
    const treasuryUsdcAta = getAssociatedTokenAddressSync(config.usdcMint, config.treasury, false, TOKEN_PROGRAM_ID);
    const ghostUsdcAta = getAssociatedTokenAddressSync(config.usdcMint, config.crank, false, TOKEN_PROGRAM_ID);
    const crankWsolAta = getAssociatedTokenAddressSync(NATIVE_MINT, config.crank, false, TOKEN_PROGRAM_ID);
    const hopEscrowAta = getAssociatedTokenAddressSync(config.hopMint, config.crank, false, TOKEN_2022_PROGRAM_ID);
    const treasuryHopAta = getAssociatedTokenAddressSync(config.hopMint, config.treasury, false, TOKEN_2022_PROGRAM_ID);

    crankSol = (await connection.getBalance(config.crank, "confirmed")) / LAMPORTS_PER_SOL;
    const requiredFloatSol = Number(selected?.expected?.requiredFloatSol ?? 0);
    if (crankSol < requiredFloatSol) {
      blockers.push(`crank underfunded: ${crankSol.toFixed(9)} SOL < ${requiredFloatSol.toFixed(9)} SOL`);
    }

    accountChecks = {
      treasuryUsdcAta: { address: treasuryUsdcAta.toBase58(), exists: await accountExists(connection, treasuryUsdcAta) },
      ghostUsdcAta: { address: ghostUsdcAta.toBase58(), exists: await accountExists(connection, ghostUsdcAta) },
      crankWsolAta: { address: crankWsolAta.toBase58(), exists: await accountExists(connection, crankWsolAta) },
      hopEscrowAta: { address: hopEscrowAta.toBase58(), exists: await accountExists(connection, hopEscrowAta) },
      treasuryHopAta: { address: treasuryHopAta.toBase58(), exists: await accountExists(connection, treasuryHopAta) }
    };
  }

  const verdict = blockers.length === 0
    ? "AGGRESSIVE_READINESS_READY_FOR_EXACT_SIM"
    : "AGGRESSIVE_READINESS_BLOCKED";

  const receipt = {
    verdict,
    generatedAt: new Date().toISOString(),
    selectedPlan: selected ?? null,
    crankSol,
    accountChecks,
    blockers,
    next: verdict === "AGGRESSIVE_READINESS_READY_FOR_EXACT_SIM"
      ? "Build exact TX0/TX2/TX3 transaction simulation for selected aggressive profile."
      : "Resolve blockers, then rerun aggressive-readiness."
  };

  const out = writeReceipt("REDEMPTION-AGGRESSIVE-READINESS-LATEST.json", receipt);
  console.log(`${verdict} blockers=${blockers.length} crankSol=${crankSol.toFixed(9)} receipt=${out}`);
  if (blockers.length > 0) process.exitCode = 1;
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
