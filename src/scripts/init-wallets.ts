import fs from "node:fs";
import path from "node:path";
import { Keypair } from "@solana/web3.js";
import { FORBIDDEN_WALLETS } from "../constants.js";

type WalletRole = "treasury" | "crank" | "withdraw-authority" | "ring1" | "ring2" | "ring3" | "ring4";

function writeKeypairIfMissing(role: WalletRole): { role: WalletRole; path: string; pubkey: string; created: boolean } {
  const dir = path.resolve("keys");
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const file = path.join(dir, `${role}.json`);

  if (fs.existsSync(file)) {
    const raw = JSON.parse(fs.readFileSync(file, "utf8")) as number[];
    const keypair = Keypair.fromSecretKey(Uint8Array.from(raw));
    return { role, path: file, pubkey: keypair.publicKey.toBase58(), created: false };
  }

  const keypair = Keypair.generate();
  fs.writeFileSync(file, JSON.stringify(Array.from(keypair.secretKey)), { mode: 0o600 });
  return { role, path: file, pubkey: keypair.publicKey.toBase58(), created: true };
}

function main() {
  const wallets = [
    writeKeypairIfMissing("treasury"),
    writeKeypairIfMissing("crank"),
    writeKeypairIfMissing("withdraw-authority"),
    writeKeypairIfMissing("ring1"),
    writeKeypairIfMissing("ring2"),
    writeKeypairIfMissing("ring3"),
    writeKeypairIfMissing("ring4")
  ];

  for (const wallet of wallets) {
    if (FORBIDDEN_WALLETS.has(wallet.pubkey)) {
      throw new Error(`Generated/configured forbidden wallet for ${wallet.role}: ${wallet.pubkey}`);
    }
  }

  const envPath = path.resolve(".env.redemptionarc");
  const rpc = process.env.SOLANA_RPC_URL || process.env.RPC_URL || "https://api.mainnet-beta.solana.com";
  const env = [
    "DRY_RUN=true",
    "ALLOW_LIVE=false",
    `SOLANA_RPC_URL=${rpc}`,
    `REDEMPTION_TREASURY=${wallets.find((wallet) => wallet.role === "treasury")?.pubkey}`,
    `REDEMPTION_CRANK=${wallets.find((wallet) => wallet.role === "crank")?.pubkey}`,
    `REDEMPTION_WITHDRAW_AUTHORITY=${wallets.find((wallet) => wallet.role === "withdraw-authority")?.pubkey}`,
    `RING_KEYPAIR_PATHS=./keys/ring1.json,./keys/ring2.json,./keys/ring3.json,./keys/ring4.json`,
    "USDC_MINT=EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
    "HOP_MINT=HZF5k7h39hkysoSZ4ZfmWc55PhvW7ntVvVqdXFCyYGh3",
    "MIN_NET_USD=0.25",
    "FORCE_ENV_SOL_PRICE=false",
    ""
  ].join("\n");

  if (!fs.existsSync(envPath)) {
    fs.writeFileSync(envPath, env, { mode: 0o600 });
  }

  console.log("REDEMPTION_WALLETS_READY");
  for (const wallet of wallets) {
    console.log(`${wallet.role}=${wallet.pubkey} created=${wallet.created}`);
  }
  console.log(`env=${envPath}`);
}

main();
