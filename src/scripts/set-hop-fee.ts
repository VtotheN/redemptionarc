/**
 * FASE 0: Cambia HOP transfer fee de 690bps a 1bps.
 *
 * Requiere key de: FVxMBHVbyPqqo6ANaY4RM1h7JBJaRHuPTF9XehwaWztp
 * (transferFeeConfigAuthority de HOP — old DOCTORKIMI wallet)
 *
 * Set: OLD_FEE_CONFIG_AUTH_PATH=keys/old-fee-config-auth.json
 *      DRY_RUN=true (simular primero)
 *      ALLOW_LIVE=false → true para ejecutar
 */

import "dotenv/config";
import dotenv from "dotenv";
import fs from "node:fs";
import {
  Connection,
  Keypair,
  PublicKey,
  Transaction,
  sendAndConfirmTransaction,
} from "@solana/web3.js";
import {
  TOKEN_2022_PROGRAM_ID,
  createSetTransferFeeInstruction,
  getTransferFeeConfig,
  getMint,
} from "@solana/spl-token";
import { writeReceipt } from "../utils/receipt.js";

if (process.env.ENV_PATH) {
  dotenv.config({ path: process.env.ENV_PATH, override: true });
}

const HOP_MINT = new PublicKey("HZF5k7h39hkysoSZ4ZfmWc55PhvW7ntVvVqdXFCyYGh3");
const EXPECTED_CURRENT_FEE_BPS = 690;
const TARGET_FEE_BPS = 1;

function loadKeypair(path: string): Keypair {
  return Keypair.fromSecretKey(
    Uint8Array.from(JSON.parse(fs.readFileSync(path, "utf8")) as number[])
  );
}

function boolEnv(name: string, fallback: boolean): boolean {
  const raw = process.env[name];
  if (raw == null || raw === "") return fallback;
  return ["1", "true", "yes", "y"].includes(raw.toLowerCase());
}

async function main() {
  const rpcUrl = process.env.SOLANA_RPC_URL || process.env.RPC_URL || "https://api.mainnet-beta.solana.com";
  const dryRun = process.env.DRY_RUN !== "false";
  const allowLive = process.env.ALLOW_LIVE === "true";
  const forceReschedule = boolEnv("FORCE_RESCHEDULE_HOP_FEE", false);
  const verify = process.argv.includes("--verify");
  const connection = new Connection(rpcUrl, "confirmed");

  // Read current state
  const mintInfo = await getMint(connection, HOP_MINT, "confirmed", TOKEN_2022_PROGRAM_ID);
  const feeConfig = getTransferFeeConfig(mintInfo);
  if (!feeConfig) throw new Error("HOP has no TransferFeeConfig extension");

  const epochInfo = await connection.getEpochInfo();
  const currentEpoch = epochInfo.epoch;
  const activeFeeConfig = currentEpoch >= Number(feeConfig.newerTransferFee.epoch)
    ? feeConfig.newerTransferFee : feeConfig.olderTransferFee;
  const activeFee = activeFeeConfig.transferFeeBasisPoints;
  const feeConfigAuthority = feeConfig.transferFeeConfigAuthority;
  const withdrawAuthority = feeConfig.withdrawWithheldAuthority;
  const targetScheduled = feeConfig.newerTransferFee.transferFeeBasisPoints === TARGET_FEE_BPS;
  const targetActive = activeFee === TARGET_FEE_BPS;
  const slotsUntilTargetEpoch = Number(feeConfig.newerTransferFee.epoch) <= currentEpoch
    ? 0
    : (epochInfo.slotsInEpoch - epochInfo.slotIndex)
      + Math.max(Number(feeConfig.newerTransferFee.epoch) - currentEpoch - 1, 0) * epochInfo.slotsInEpoch;
  const statusReceipt = {
    mint: HOP_MINT.toBase58(),
    currentEpoch,
    slotsInEpoch: epochInfo.slotsInEpoch,
    slotIndex: epochInfo.slotIndex,
    slotsUntilTargetEpoch,
    activeFee,
    targetFee: TARGET_FEE_BPS,
    olderFee: {
      bps: feeConfig.olderTransferFee.transferFeeBasisPoints,
      epoch: feeConfig.olderTransferFee.epoch.toString(),
    },
    newerFee: {
      bps: feeConfig.newerTransferFee.transferFeeBasisPoints,
      epoch: feeConfig.newerTransferFee.epoch.toString(),
    },
    transferFeeConfigAuthority: feeConfigAuthority?.toBase58() ?? null,
    withdrawWithheldAuthority: withdrawAuthority?.toBase58() ?? null,
    withheldAmount: feeConfig.withheldAmount.toString(),
    targetActive,
    targetScheduled,
    canLowerNow: targetActive,
    forceReschedule,
  };

  console.log("=== HOP TOKEN STATE ===");
  console.log(`mint:                     ${HOP_MINT.toBase58()}`);
  console.log(`currentEpoch:             ${currentEpoch}`);
  console.log(`activeFee (current):      ${activeFee} bps`);
  console.log(`olderFee:                 ${feeConfig.olderTransferFee.transferFeeBasisPoints} bps @ epoch ${feeConfig.olderTransferFee.epoch}`);
  console.log(`newerFee:                 ${feeConfig.newerTransferFee.transferFeeBasisPoints} bps @ epoch ${feeConfig.newerTransferFee.epoch}`);
  console.log(`transferFeeConfigAuth:    ${feeConfigAuthority?.toBase58() ?? "None"}`);
  console.log(`withdrawWithheldAuth:     ${withdrawAuthority?.toBase58() ?? "None"}`);
  console.log(`withheldAmount:           ${feeConfig.withheldAmount}`);
  console.log(`targetFeeBps:             ${TARGET_FEE_BPS}`);
  console.log(`targetScheduled:          ${targetScheduled ? "yes" : "no"}`);
  console.log(`slotsUntilTargetEpoch:    ${slotsUntilTargetEpoch}`);

  if (verify) {
    const verdict = targetActive
      ? "HOP_FEE_TARGET_ACTIVE"
      : targetScheduled
        ? "HOP_FEE_TARGET_SCHEDULED_NOT_ACTIVE"
        : "HOP_FEE_TARGET_NOT_SCHEDULED";
    console.log(`\nVERIFY: ${verdict}`);
    writeReceipt("set-hop-fee-status", { verdict, ...statusReceipt });
    return;
  }

  if (targetActive) {
    console.log(`\nActive fee already ${TARGET_FEE_BPS} bps. Nothing to do.`);
    writeReceipt("set-hop-fee-status", { verdict: "HOP_FEE_ALREADY_ACTIVE", ...statusReceipt });
    return;
  }

  if (targetScheduled && !forceReschedule) {
    console.log(`\nTarget fee already scheduled. Nothing to send until epoch ${feeConfig.newerTransferFee.epoch.toString()}.`);
    writeReceipt("set-hop-fee-status", {
      verdict: "HOP_FEE_ALREADY_SCHEDULED_WAIT_FOR_EPOCH",
      ...statusReceipt,
      note: "Re-sending SetTransferFee is intentionally blocked because it does not make the existing newer fee active before its epoch.",
    });
    return;
  }

  if (!feeConfigAuthority) throw new Error("No transferFeeConfigAuthority on mint");

  const authKeyPath = process.env.OLD_FEE_CONFIG_AUTH_PATH || "keys/old-fee-config-auth.json";
  if (!fs.existsSync(authKeyPath)) {
    throw new Error(
      `Missing keypair at ${authKeyPath}.\n` +
      `Need key for: ${feeConfigAuthority.toBase58()}\n` +
      `Export from old DOCTORKIMI wallets and place at ${authKeyPath}`
    );
  }

  const authority = loadKeypair(authKeyPath);
  if (!authority.publicKey.equals(feeConfigAuthority)) {
    throw new Error(
      `Keypair pubkey ${authority.publicKey.toBase58()} does not match ` +
      `expected authority ${feeConfigAuthority.toBase58()}`
    );
  }

  // crank pays the fee (authority has 0 SOL)
  const crankKeyPath = process.env.CRANK_KEY_PATH || "keys/crank.json";
  const crank = loadKeypair(crankKeyPath);

  const ix = createSetTransferFeeInstruction(
    HOP_MINT,
    authority.publicKey,
    [],
    TARGET_FEE_BPS,
    BigInt("18446744073709551615"), // u64::MAX — keep unlimited cap
    TOKEN_2022_PROGRAM_ID
  );

  const tx = new Transaction().add(ix);
  tx.recentBlockhash = (await connection.getLatestBlockhash("confirmed")).blockhash;
  tx.feePayer = crank.publicKey;

  const receipt = {
    verdict: "",
    mint: HOP_MINT.toBase58(),
    authority: authority.publicKey.toBase58(),
    fromFeeBps: activeFee,
    toFeeBps: TARGET_FEE_BPS,
    currentEpoch,
    currentNewerFeeEpoch: feeConfig.newerTransferFee.epoch.toString(),
    dryRun,
    signature: null as string | null,
  };

  if (dryRun || !allowLive) {
    const sim = await connection.simulateTransaction(tx);
    receipt.verdict = sim.value.err ? "SIM_FAILED" : "SIM_OK";
    console.log(`\nSIM: ${receipt.verdict}`);
    if (sim.value.err) console.log("err:", sim.value.err);
    console.log("logs:", sim.value.logs?.slice(-5));
  } else {
    const sig = await sendAndConfirmTransaction(connection, tx, [crank, authority], { commitment: "confirmed" });
    receipt.verdict = "EXECUTED";
    receipt.signature = sig;
    console.log(`\nEXECUTED: ${sig}`);
    console.log(`HOP fee changed: ${activeFee} → ${TARGET_FEE_BPS} bps`);
  }

  writeReceipt(receipt.verdict === "EXECUTED" ? "set-hop-fee" : "set-hop-fee-plan", receipt);
  console.log(`\nReceipt written. Run with --verify to confirm.`);
}

main().catch((e) => { console.error(e); process.exitCode = 1; });
