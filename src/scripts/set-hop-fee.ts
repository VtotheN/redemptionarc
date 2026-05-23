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

async function main() {
  const rpcUrl = process.env.SOLANA_RPC_URL || process.env.RPC_URL || "https://api.mainnet-beta.solana.com";
  const dryRun = process.env.DRY_RUN !== "false";
  const allowLive = process.env.ALLOW_LIVE === "true";
  const verify = process.argv.includes("--verify");
  const connection = new Connection(rpcUrl, "confirmed");

  // Read current state
  const mintInfo = await getMint(connection, HOP_MINT, "confirmed", TOKEN_2022_PROGRAM_ID);
  const feeConfig = getTransferFeeConfig(mintInfo);
  if (!feeConfig) throw new Error("HOP has no TransferFeeConfig extension");

  const currentFee = feeConfig.newerTransferFee.transferFeeBasisPoints;
  const feeConfigAuthority = feeConfig.transferFeeConfigAuthority;
  const withdrawAuthority = feeConfig.withdrawWithheldAuthority;

  console.log("=== HOP TOKEN STATE ===");
  console.log(`mint:                     ${HOP_MINT.toBase58()}`);
  console.log(`currentFeeBps:            ${currentFee}`);
  console.log(`transferFeeConfigAuth:    ${feeConfigAuthority?.toBase58() ?? "None"}`);
  console.log(`withdrawWithheldAuth:     ${withdrawAuthority?.toBase58() ?? "None"}`);
  console.log(`withheldAmount:           ${feeConfig.withheldAmount}`);
  console.log(`targetFeeBps:             ${TARGET_FEE_BPS}`);

  if (verify) {
    const ok = currentFee === TARGET_FEE_BPS;
    console.log(`\nVERIFY: fee=${currentFee} target=${TARGET_FEE_BPS} → ${ok ? "OK ✅" : "NOT SET ❌"}`);
    writeReceipt("set-hop-fee-verify", { mint: HOP_MINT.toBase58(), currentFee, targetFee: TARGET_FEE_BPS, ok });
    return;
  }

  if (currentFee === TARGET_FEE_BPS) {
    console.log(`\nFee already ${TARGET_FEE_BPS} bps. Nothing to do.`);
    writeReceipt("set-hop-fee", { verdict: "ALREADY_SET", currentFee, targetFee: TARGET_FEE_BPS });
    return;
  }

  if (currentFee !== EXPECTED_CURRENT_FEE_BPS) {
    throw new Error(`Unexpected current fee ${currentFee} bps (expected ${EXPECTED_CURRENT_FEE_BPS}). Aborting.`);
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
  tx.feePayer = authority.publicKey;

  const receipt = {
    verdict: "",
    mint: HOP_MINT.toBase58(),
    authority: authority.publicKey.toBase58(),
    fromFeeBps: currentFee,
    toFeeBps: TARGET_FEE_BPS,
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
    const sig = await sendAndConfirmTransaction(connection, tx, [authority], { commitment: "confirmed" });
    receipt.verdict = "EXECUTED";
    receipt.signature = sig;
    console.log(`\nEXECUTED: ${sig}`);
    console.log(`HOP fee changed: ${currentFee} → ${TARGET_FEE_BPS} bps`);
  }

  writeReceipt("set-hop-fee", receipt);
  console.log(`\nReceipt written. Run with --verify to confirm.`);
}

main().catch((e) => { console.error(e); process.exitCode = 1; });
