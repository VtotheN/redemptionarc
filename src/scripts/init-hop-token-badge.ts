import "dotenv/config";
import fs from "node:fs";
import { Transaction, sendAndConfirmTransaction } from "@solana/web3.js";
import { loadConfig } from "../config.js";
import { connectionFor } from "../utils/rpc.js";
import { writeReceipt } from "../utils/receipt.js";
import { assertKeypairMatches, loadKeypair } from "../utils/keypair.js";
import { assertLiveAllowed, assertNoForbiddenConfigured, uniqueSigners } from "../utils/safety.js";
import {
  deriveConfigExtension,
  deriveTokenBadge,
  initializeTokenBadgeIx,
  serializableInstruction,
  WHIRLPOOL_PROGRAM_ID
} from "../utils/orca-whirlpool.js";
import { PublicKey } from "@solana/web3.js";

type OrcaConfigReceipt = {
  createdAccountAddresses?: {
    whirlpoolsConfig?: string;
    whirlpoolsConfigExtension?: string;
  };
};

function readConfigReceipt(): OrcaConfigReceipt {
  const file = process.env.ORCA_CONFIG_RECEIPT || "receipts/REDEMPTION-ORCA-CONFIG.json";
  if (!fs.existsSync(file)) throw new Error(`Missing Orca config receipt: ${file}`);
  return JSON.parse(fs.readFileSync(file, "utf8")) as OrcaConfigReceipt;
}

async function main() {
  const config = loadConfig();
  assertNoForbiddenConfigured(config);
  assertLiveAllowed(config);
  if (!config.crank || !config.withdrawAuthority) {
    throw new Error("Missing REDEMPTION_CRANK or REDEMPTION_WITHDRAW_AUTHORITY");
  }

  const receiptIn = readConfigReceipt();
  const configAddress = receiptIn.createdAccountAddresses?.whirlpoolsConfig;
  if (!configAddress) throw new Error("REDEMPTION-ORCA-CONFIG.json missing createdAccountAddresses.whirlpoolsConfig");

  const whirlpoolsConfig = new PublicKey(configAddress);
  const configExtension = receiptIn.createdAccountAddresses?.whirlpoolsConfigExtension
    ? new PublicKey(receiptIn.createdAccountAddresses.whirlpoolsConfigExtension)
    : deriveConfigExtension(whirlpoolsConfig);
  const tokenBadge = deriveTokenBadge(whirlpoolsConfig, config.hopMint);

  const connection = connectionFor(config.rpcUrl);
  const funder = loadKeypair(process.env.CRANK_KEYPAIR_PATH || "keys/crank.json");
  const tokenBadgeAuthority = loadKeypair(process.env.WITHDRAW_AUTHORITY_KEYPAIR_PATH ||
    (config.withdrawAuthority.equals(config.crank) ? process.env.CRANK_KEYPAIR_PATH || "keys/crank.json" : "keys/withdraw-authority.json"));
  assertKeypairMatches("crank", funder, config.crank);
  assertKeypairMatches("withdraw authority", tokenBadgeAuthority, config.withdrawAuthority);

  const [configInfo, extensionInfo, badgeInfo] = await Promise.all([
    connection.getAccountInfo(whirlpoolsConfig, "confirmed"),
    connection.getAccountInfo(configExtension, "confirmed"),
    connection.getAccountInfo(tokenBadge, "confirmed")
  ]);

  const ix = initializeTokenBadgeIx({
    whirlpoolsConfig,
    whirlpoolsConfigExtension: configExtension,
    tokenBadgeAuthority: tokenBadgeAuthority.publicKey,
    tokenMint: config.hopMint,
    tokenBadge,
    funder: funder.publicKey
  });

  const receipt: Record<string, unknown> = {
    verdict: "HOP_TOKEN_BADGE_PLAN_BUILT",
    generatedAt: new Date().toISOString(),
    dryRun: config.dryRun,
    allowLive: config.allowLive,
    liveTxApproved: process.env.LIVE_TX_APPROVED === "true",
    whirlpoolProgram: WHIRLPOOL_PROGRAM_ID.toBase58(),
    whirlpoolsConfig: whirlpoolsConfig.toBase58(),
    whirlpoolsConfigExtension: configExtension.toBase58(),
    hopMint: config.hopMint.toBase58(),
    tokenBadge: tokenBadge.toBase58(),
    authorities: {
      funder: funder.publicKey.toBase58(),
      tokenBadgeAuthority: tokenBadgeAuthority.publicKey.toBase58()
    },
    preExisting: {
      whirlpoolsConfig: Boolean(configInfo),
      whirlpoolsConfigExtension: Boolean(extensionInfo),
      tokenBadge: Boolean(badgeInfo)
    },
    instruction: serializableInstruction(ix)
  };

  if (!configInfo || !extensionInfo) {
    receipt.verdict = "HOP_TOKEN_BADGE_BLOCKED_MISSING_CONFIG";
    const out = writeReceipt("REDEMPTION-HOP-TOKEN-BADGE.json", receipt);
    console.log(`${receipt.verdict} receipt=${out}`);
    process.exitCode = 1;
    return;
  }

  if (badgeInfo) {
    receipt.verdict = "HOP_TOKEN_BADGE_ALREADY_INITIALIZED";
    const out = writeReceipt("REDEMPTION-HOP-TOKEN-BADGE.json", receipt);
    console.log(`${receipt.verdict} badge=${tokenBadge.toBase58()} receipt=${out}`);
    return;
  }

  const signerPubkeys = new Set(ix.keys.filter((key) => key.isSigner).map((key) => key.pubkey.toBase58()));
  const signers = uniqueSigners([funder, tokenBadgeAuthority], signerPubkeys);
  const tx = new Transaction().add(ix);
  tx.feePayer = funder.publicKey;
  tx.recentBlockhash = (await connection.getLatestBlockhash("confirmed")).blockhash;
  tx.sign(...signers);

  const sim = await connection.simulateTransaction(tx);
  receipt.simulation = {
    err: sim.value.err ?? null,
    unitsConsumed: sim.value.unitsConsumed ?? null,
    logs: sim.value.logs ?? []
  };

  if (sim.value.err) {
    receipt.verdict = "HOP_TOKEN_BADGE_SIM_FAILED";
    const out = writeReceipt("REDEMPTION-HOP-TOKEN-BADGE.json", receipt);
    console.log(`${receipt.verdict} err=${JSON.stringify(sim.value.err)} receipt=${out}`);
    process.exitCode = 1;
    return;
  }

  if (config.dryRun) {
    receipt.verdict = "HOP_TOKEN_BADGE_SIM_OK_DRY_RUN";
    const out = writeReceipt("REDEMPTION-HOP-TOKEN-BADGE.json", receipt);
    console.log(`${receipt.verdict} badge=${tokenBadge.toBase58()} receipt=${out}`);
    return;
  }

  const signature = await sendAndConfirmTransaction(connection, tx, signers, { commitment: "confirmed" });
  receipt.verdict = "HOP_TOKEN_BADGE_EXECUTED";
  receipt.signature = signature;
  const out = writeReceipt("REDEMPTION-HOP-TOKEN-BADGE.json", receipt);
  console.log(`${receipt.verdict} sig=${signature} receipt=${out}`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
