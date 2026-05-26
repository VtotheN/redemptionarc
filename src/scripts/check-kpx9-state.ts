import "dotenv/config";
import { Connection, PublicKey } from "@solana/web3.js";
async function main() {
  const conn = new Connection(process.env.SOLANA_RPC_URL || "https://api.mainnet-beta.solana.com", "confirmed");
  const KPX9_CONFIG = new PublicKey("KPX9QQP4GLWiRkh4pGpkagwoPGaGixarRQs1LQKb9dt");
  const KPX9_EXT    = new PublicKey("GgGRBg8kKd4h5KZcDSLMnHL84g3cEdJRaAfRmushev6A");
  const [cfg, ext] = await Promise.all([
    conn.getAccountInfo(KPX9_CONFIG, "confirmed"),
    conn.getAccountInfo(KPX9_EXT, "confirmed"),
  ]);
  if (!cfg) throw new Error("config not found");
  if (!ext) throw new Error("ext not found");
  const c = Buffer.from(cfg.data);
  const e = Buffer.from(ext.data);
  // WhirlpoolsConfig layout (after 8b disc):
  // fee_authority: 32b @ 8
  // collect_protocol_fees_authority: 32b @ 40
  // reward_emissions_super_authority: 32b @ 72
  // default_protocol_fee_rate: 2b @ 104
  // default_fee_rate: 2b @ 106 (but that's per fee tier)
  const feeAuth        = new PublicKey(c.slice(8, 40));
  const collectAuth    = new PublicKey(c.slice(40, 72));
  const rewardAuth     = new PublicKey(c.slice(72, 104));
  const feeBps         = c.readUInt16LE(104);
  console.log("=== WhirlpoolsConfig ===");
  console.log("fee_authority:                   ", feeAuth.toBase58());
  console.log("collect_protocol_fees_authority: ", collectAuth.toBase58());
  console.log("reward_emissions_super_authority:", rewardAuth.toBase58());
  console.log("default_protocol_fee_rate:       ", feeBps, "bps");
  // WhirlpoolsConfigExtension layout (after 8b disc):
  // whirlpools_config: 32b @ 8
  // config_extension_authority: 32b @ 40
  // token_badge_authority: 32b @ 72
  // feature_flags: 2b @ 104 (maybe)
  const extCfg         = new PublicKey(e.slice(8, 40));
  const extAuth        = new PublicKey(e.slice(40, 72));
  const badgeAuth      = new PublicKey(e.slice(72, 104));
  const featureFlags   = e.readUInt16LE(104);
  console.log("\n=== WhirlpoolsConfigExtension ===");
  console.log("whirlpools_config:           ", extCfg.toBase58());
  console.log("config_extension_authority:  ", extAuth.toBase58());
  console.log("token_badge_authority:       ", badgeAuth.toBase58());
  console.log("feature_flags:               ", featureFlags, "(hex:", featureFlags.toString(16) + ")");
}
main().catch(console.error);
