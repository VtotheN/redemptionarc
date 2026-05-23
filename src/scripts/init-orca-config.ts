import "dotenv/config";
import {
  Transaction,
  TransactionInstruction,
  sendAndConfirmTransaction
} from "@solana/web3.js";
import { loadConfig } from "../config.js";
import { connectionFor } from "../utils/rpc.js";
import { writeReceipt } from "../utils/receipt.js";
import { assertKeypairMatches, ensureKeypair, loadKeypair } from "../utils/keypair.js";
import { assertLiveAllowed, assertNoForbiddenConfigured, uniqueSigners } from "../utils/safety.js";
import {
  deriveConfigExtension,
  deriveFeeTier,
  initializeConfigExtensionIx,
  initializeConfigIx,
  initializeFeeTierIx,
  serializableInstruction,
  WHIRLPOOL_PROGRAM_ID
} from "../utils/orca-whirlpool.js";

const TICK_SPACING = Number(process.env.ORCA_TICK_SPACING || "64");
const DEFAULT_FEE_RATE = Number(process.env.ORCA_FEE_RATE || "300");
const DEFAULT_PROTOCOL_FEE_RATE = Number(process.env.ORCA_PROTOCOL_FEE_RATE || "300");
const MAINNET_INITIALIZE_CONFIG_ADMINS = new Set([
  "GwH3Hiv5mACLX3ufTw1pFsrhSPon5tdw252DBs4Rx4PV",
  "AqiJTdr9jLPDAk5prGhWFHtSM1qJszAsdZVV7oeinxhh"
]);

async function maybePush(ixs: TransactionInstruction[], exists: boolean, ix: TransactionInstruction): Promise<void> {
  if (!exists) ixs.push(ix);
}

async function main() {
  const config = loadConfig();
  assertNoForbiddenConfigured(config);
  assertLiveAllowed(config);
  if (!config.crank || !config.withdrawAuthority) {
    throw new Error("Missing REDEMPTION_CRANK or REDEMPTION_WITHDRAW_AUTHORITY");
  }

  const connection = connectionFor(config.rpcUrl);
  const funderPath = process.env.ORCA_FUNDER_KEYPAIR_PATH || process.env.CRANK_KEYPAIR_PATH || "keys/crank.json";
  const funder = loadKeypair(funderPath);
  const withdrawAuthorityPath = process.env.WITHDRAW_AUTHORITY_KEYPAIR_PATH ||
    (config.withdrawAuthority.equals(config.crank) ? funderPath : "keys/withdraw-authority.json");
  const feeAuthority = loadKeypair(withdrawAuthorityPath);
  const whirlpoolsConfig = ensureKeypair(process.env.ORCA_CONFIG_KEYPAIR_PATH || "keys/orca-config.json");

  if (!process.env.ORCA_FUNDER_KEYPAIR_PATH) {
    assertKeypairMatches("crank", funder, config.crank);
  }
  assertKeypairMatches("withdraw authority", feeAuthority, config.withdrawAuthority);

  const configExtension = deriveConfigExtension(whirlpoolsConfig.publicKey);
  const feeTier = deriveFeeTier(whirlpoolsConfig.publicKey, TICK_SPACING);

  const [configInfo, extensionInfo, feeTierInfo] = await Promise.all([
    connection.getAccountInfo(whirlpoolsConfig.publicKey, "confirmed"),
    connection.getAccountInfo(configExtension, "confirmed"),
    connection.getAccountInfo(feeTier, "confirmed")
  ]);

  const ixs: TransactionInstruction[] = [];
  await maybePush(
    ixs,
    Boolean(configInfo),
    initializeConfigIx({
      config: whirlpoolsConfig.publicKey,
      funder: funder.publicKey,
      feeAuthority: feeAuthority.publicKey,
      collectProtocolFeesAuthority: feeAuthority.publicKey,
      rewardEmissionsSuperAuthority: feeAuthority.publicKey,
      defaultProtocolFeeRate: DEFAULT_PROTOCOL_FEE_RATE
    })
  );
  await maybePush(
    ixs,
    Boolean(extensionInfo),
    initializeConfigExtensionIx({
      config: whirlpoolsConfig.publicKey,
      configExtension,
      funder: funder.publicKey,
      feeAuthority: feeAuthority.publicKey
    })
  );
  await maybePush(
    ixs,
    Boolean(feeTierInfo),
    initializeFeeTierIx({
      config: whirlpoolsConfig.publicKey,
      feeTier,
      funder: funder.publicKey,
      feeAuthority: feeAuthority.publicKey,
      tickSpacing: TICK_SPACING,
      defaultFeeRate: DEFAULT_FEE_RATE
    })
  );

  const receipt: Record<string, unknown> = {
    verdict: "ORCA_CONFIG_PLAN_BUILT",
    generatedAt: new Date().toISOString(),
    dryRun: config.dryRun,
    allowLive: config.allowLive,
    liveTxApproved: process.env.LIVE_TX_APPROVED === "true",
    whirlpoolProgram: WHIRLPOOL_PROGRAM_ID.toBase58(),
    createdAccountAddresses: {
      whirlpoolsConfig: whirlpoolsConfig.publicKey.toBase58(),
      whirlpoolsConfigExtension: configExtension.toBase58(),
      feeTier: feeTier.toBase58()
    },
    authorities: {
      funder: funder.publicKey.toBase58(),
      feeAuthority: feeAuthority.publicKey.toBase58(),
      collectProtocolFeesAuthority: feeAuthority.publicKey.toBase58(),
      rewardEmissionsSuperAuthority: feeAuthority.publicKey.toBase58(),
      tokenBadgeAuthority: feeAuthority.publicKey.toBase58()
    },
    params: {
      tickSpacing: TICK_SPACING,
      defaultFeeRate: DEFAULT_FEE_RATE,
      defaultProtocolFeeRate: DEFAULT_PROTOCOL_FEE_RATE
    },
    preExisting: {
      whirlpoolsConfig: Boolean(configInfo),
      whirlpoolsConfigExtension: Boolean(extensionInfo),
      feeTier: Boolean(feeTierInfo)
    },
    mainnetInitializeConfigAdmins: Array.from(MAINNET_INITIALIZE_CONFIG_ADMINS),
    upstreamConstraint: "Current Orca mainnet initialize_config requires is_admin_key(funder.key).",
    instructions: ixs.map(serializableInstruction)
  };

  if (!configInfo && !MAINNET_INITIALIZE_CONFIG_ADMINS.has(funder.publicKey.toBase58())) {
    receipt.verdict = "ORCA_CONFIG_BLOCKED_NON_ADMIN_FUNDER";
    receipt.blockedReason = "Canonical Orca Whirlpool mainnet does not allow arbitrary funders to initialize new WhirlpoolsConfig accounts.";
    receipt.source = "orca-so/whirlpools programs/whirlpool/src/instructions/initialize_config.rs: #[account(mut, constraint = is_admin_key(funder.key))]";
    const out = writeReceipt("REDEMPTION-ORCA-CONFIG.json", receipt);
    console.log(`${receipt.verdict} funder=${funder.publicKey.toBase58()} receipt=${out}`);
    process.exitCode = 1;
    return;
  }

  if (ixs.length === 0) {
    receipt.verdict = "ORCA_CONFIG_ALREADY_INITIALIZED";
    const out = writeReceipt("REDEMPTION-ORCA-CONFIG.json", receipt);
    console.log(`${receipt.verdict} config=${whirlpoolsConfig.publicKey.toBase58()} receipt=${out}`);
    return;
  }

  const signerPubkeys = new Set(ixs.flatMap((ix) => ix.keys.filter((key) => key.isSigner).map((key) => key.pubkey.toBase58())));
  const signers = uniqueSigners([funder, feeAuthority, whirlpoolsConfig], signerPubkeys);
  const tx = new Transaction().add(...ixs);
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
    receipt.verdict = "ORCA_CONFIG_SIM_FAILED";
    const out = writeReceipt("REDEMPTION-ORCA-CONFIG.json", receipt);
    console.log(`${receipt.verdict} err=${JSON.stringify(sim.value.err)} receipt=${out}`);
    process.exitCode = 1;
    return;
  }

  if (config.dryRun) {
    receipt.verdict = "ORCA_CONFIG_SIM_OK_DRY_RUN";
    const out = writeReceipt("REDEMPTION-ORCA-CONFIG.json", receipt);
    console.log(`${receipt.verdict} config=${whirlpoolsConfig.publicKey.toBase58()} receipt=${out}`);
    return;
  }

  const signature = await sendAndConfirmTransaction(connection, tx, signers, { commitment: "confirmed" });
  receipt.verdict = "ORCA_CONFIG_EXECUTED";
  receipt.signature = signature;
  const out = writeReceipt("REDEMPTION-ORCA-CONFIG.json", receipt);
  console.log(`${receipt.verdict} sig=${signature} receipt=${out}`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
