import { Keypair } from "@solana/web3.js";
import { RedemptionConfig } from "../config.js";
import { FORBIDDEN_WALLETS } from "../constants.js";

export function assertNoForbiddenConfigured(config: RedemptionConfig): void {
  const configured = [
    ["REDEMPTION_TREASURY", config.treasury?.toBase58()],
    ["REDEMPTION_CRANK", config.crank?.toBase58()],
    ["REDEMPTION_WITHDRAW_AUTHORITY", config.withdrawAuthority?.toBase58()]
  ].filter((entry): entry is [string, string] => Boolean(entry[1]));

  for (const [name, value] of configured) {
    if (FORBIDDEN_WALLETS.has(value)) {
      throw new Error(`${name} points to forbidden wallet ${value}`);
    }
  }
}

export function assertLiveAllowed(config: RedemptionConfig): void {
  if (config.dryRun) return;
  if (!config.allowLive) {
    throw new Error("DRY_RUN=false requires ALLOW_LIVE=true");
  }
  if (process.env.LIVE_TX_APPROVED !== "true") {
    throw new Error("Live send blocked: set LIVE_TX_APPROVED=true only after Velon approves the exact receipt.");
  }
}

export function uniqueSigners(signers: Keypair[], signerPubkeys: Set<string>): Keypair[] {
  const seen = new Set<string>();
  const out: Keypair[] = [];
  for (const signer of signers) {
    const id = signer.publicKey.toBase58();
    if (!signerPubkeys.has(id) || seen.has(id)) continue;
    seen.add(id);
    out.push(signer);
  }
  return out;
}

export function lamportsToSol(lamports: number | bigint): number {
  return Number(lamports) / 1_000_000_000;
}

