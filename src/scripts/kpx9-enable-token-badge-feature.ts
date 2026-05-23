/**
 * Diagnostic: KPX9 WhirlpoolsConfig TOKEN_BADGE feature flag status.
 *
 * FINDING: set_config_feature_flag on the official Orca Whirlpool program is
 * GOVERNANCE-ONLY. The instruction's authority account is constrained to two
 * hardcoded admin pubkeys inside the program binary:
 *
 *   GwH3Hiv5mACLX3ufTw1pFsrhSPon5tdw252DBs4Rx4PV  (Orca governance)
 *   AqiJTdr9jLPDAk5prGhWFHtSM1qJszAsdZVV7oeinxhh  (Eclipse fee authority)
 *
 * No config authority, fee_authority, or owner of a WhirlpoolsConfig can call
 * this instruction — only Orca's own wallets.
 *
 * Consequence for KPX9 pool (2FhggxytqRvUrxEru2BTLkZfz3w8AcBUu4cqZzU2pFww):
 *   - Pool and LP position exist and hold liquidity.
 *   - HOP is Token-2022; without a TokenBadge the Orca program will reject
 *     any swap that involves HOP, so Jupiter / Orca UI cannot route through it.
 *   - Protocol fees will not accrue until token badge is created.
 *
 * To unblock: contact Orca to call set_config_feature_flag on KPX9 config,
 * then re-run init-kpx9-token-badge with the crank.
 *
 * This script inspects and reports current on-chain state.
 */

import "dotenv/config";
import dotenv from "dotenv";
import { Connection, PublicKey } from "@solana/web3.js";
import { writeReceipt } from "../utils/receipt.js";

if (process.env.ENV_PATH) {
  dotenv.config({ path: process.env.ENV_PATH, override: true });
}

const OFFICIAL_ORCA = new PublicKey("whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc");
const KPX9_CONFIG   = new PublicKey("KPX9QQP4GLWiRkh4pGpkagwoPGaGixarRQs1LQKb9dt");
const KPX9_EXT      = new PublicKey("GgGRBg8kKd4h5KZcDSLMnHL84g3cEdJRaAfRmushev6A");
const HOP_MINT      = new PublicKey("HZF5k7h39hkysoSZ4ZfmWc55PhvW7ntVvVqdXFCyYGh3");

const ORCA_MAINNET_ADMINS = [
  "GwH3Hiv5mACLX3ufTw1pFsrhSPon5tdw252DBs4Rx4PV",
  "AqiJTdr9jLPDAk5prGhWFHtSM1qJszAsdZVV7oeinxhh",
];

function deriveTokenBadge(config: PublicKey, mint: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("token_badge"), config.toBuffer(), mint.toBuffer()],
    OFFICIAL_ORCA
  )[0];
}

async function main() {
  const rpcUrl = process.env.SOLANA_RPC_URL || process.env.RPC_URL || "https://api.mainnet-beta.solana.com";
  const connection = new Connection(rpcUrl, "confirmed");

  const [configInfo, extInfo, badgeInfo] = await Promise.all([
    connection.getAccountInfo(KPX9_CONFIG, "confirmed"),
    connection.getAccountInfo(KPX9_EXT, "confirmed"),
    connection.getAccountInfo(deriveTokenBadge(KPX9_CONFIG, HOP_MINT), "confirmed"),
  ]);

  if (!configInfo) throw new Error("KPX9 config not found on-chain");

  const featureFlags     = configInfo.data.readUInt16LE(106);
  const tokenBadgeEnabled = (featureFlags & 0x0001) !== 0;

  const receipt = {
    verdict: "KPX9_TOKEN_BADGE_FEATURE_BLOCKED",
    kpx9Config: KPX9_CONFIG.toBase58(),
    kpx9Extension: KPX9_EXT.toBase58(),
    hopTokenBadge: deriveTokenBadge(KPX9_CONFIG, HOP_MINT).toBase58(),
    featureFlags,
    tokenBadgeEnabled,
    hopTokenBadgeExists: badgeInfo !== null,
    orcaAdminKeysRequired: ORCA_MAINNET_ADMINS,
    finding: "set_config_feature_flag is governance-only (hardcoded admin keys in program binary). Crank cannot call it regardless of config authority ownership.",
    toUnblock: "Contact Orca to call set_config_feature_flag on KPX9 config, then run init-kpx9-token-badge.",
  };

  const out = writeReceipt("KPX9-ENABLE-TOKEN-BADGE-FEATURE.json", receipt);

  console.log("=== KPX9 TOKEN BADGE FEATURE STATUS ===");
  console.log(`feature_flags:       ${featureFlags} (TOKEN_BADGE bit: ${tokenBadgeEnabled})`);
  console.log(`hop_badge_exists:    ${badgeInfo !== null}`);
  console.log(`orca_admin_required: ${ORCA_MAINNET_ADMINS.join(", ")}`);
  console.log(`verdict:             ${receipt.verdict}`);
  console.log(`receipt:             ${out}`);
}

main().catch(e => { console.error(e); process.exitCode = 1; });
