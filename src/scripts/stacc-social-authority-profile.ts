import "dotenv/config";
import fs from "node:fs";
import { Connection, PublicKey } from "@solana/web3.js";
import { TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID } from "@solana/spl-token";
import { loadConfig } from "../config.js";
import { writeReceipt } from "../utils/receipt.js";
import { assertNoForbiddenConfigured } from "../utils/safety.js";

const OUT_RECEIPT = "STACC-SOCIAL-AUTHORITY-PROFILE-LATEST.json";
const CLAIM_SIM_RECEIPT = "receipts/STACC-SOCIAL-FEE-CLAIM-SIM-LATEST.json";
const DEFAULT_AUTHORITY = "2sMrGNK8i36YRkF5WWCwnaUYuwDJhHe1g2xA8aPvhkjM";

type AnyRecord = Record<string, unknown>;

function record(value: unknown): AnyRecord {
  return typeof value === "object" && value !== null ? value as AnyRecord : {};
}

function string(value: unknown): string | null {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : null;
}

function numberEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw == null || raw === "") return fallback;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) throw new Error(`Invalid ${name}=${raw}`);
  return Math.floor(parsed);
}

function authorityPubkey(): string {
  if (process.env.SOCIAL_AUTHORITY_PUBKEY) return process.env.SOCIAL_AUTHORITY_PUBKEY;
  if (fs.existsSync(CLAIM_SIM_RECEIPT)) {
    const receipt = record(JSON.parse(fs.readFileSync(CLAIM_SIM_RECEIPT, "utf8")) as unknown);
    return string(receipt.socialClaimAuthority) ?? string(receipt.authority) ?? DEFAULT_AUTHORITY;
  }
  return DEFAULT_AUTHORITY;
}

async function parsedTokenAccounts(connection: Connection, owner: PublicKey, programId: PublicKey) {
  const response = await connection.getParsedTokenAccountsByOwner(owner, { programId }, "confirmed").catch(() => ({ value: [] }));
  return response.value.map(({ pubkey, account }) => {
    const parsed = account.data.parsed as {
      info?: {
        mint?: string;
        tokenAmount?: {
          amount?: string;
          decimals?: number;
          uiAmountString?: string;
        };
      };
    };
    return {
      tokenAccount: pubkey.toBase58(),
      programId: programId.toBase58(),
      mint: parsed.info?.mint ?? null,
      amountRaw: parsed.info?.tokenAmount?.amount ?? null,
      decimals: parsed.info?.tokenAmount?.decimals ?? null,
      uiAmountString: parsed.info?.tokenAmount?.uiAmountString ?? null,
    };
  });
}

async function main(): Promise<void> {
  const config = loadConfig();
  assertNoForbiddenConfigured(config);

  const authority = new PublicKey(authorityPubkey());
  const connection = new Connection(config.rpcUrl, "confirmed");
  const signatureLimit = numberEnv("SOCIAL_AUTHORITY_PROFILE_SIGNATURE_LIMIT", 20);

  const [balanceLamports, signatures, splAccounts, t22Accounts] = await Promise.all([
    connection.getBalance(authority, "confirmed"),
    connection.getSignaturesForAddress(authority, { limit: signatureLimit }, "confirmed"),
    parsedTokenAccounts(connection, authority, TOKEN_PROGRAM_ID),
    parsedTokenAccounts(connection, authority, TOKEN_2022_PROGRAM_ID),
  ]);

  const receipt = {
    verdict: "STACC_SOCIAL_AUTHORITY_PROFILE_READ_ONLY",
    generatedAt: new Date().toISOString(),
    noSend: true,
    readOnly: true,
    authority: authority.toBase58(),
    short: `${authority.toBase58().slice(0, 4)}...${authority.toBase58().slice(-4)}`,
    solBalance: {
      lamports: balanceLamports,
      sol: balanceLamports / 1_000_000_000,
    },
    tokenAccounts: [...splAccounts, ...t22Accounts],
    recentSignatures: signatures.map((signature) => ({
      signature: signature.signature,
      slot: signature.slot,
      blockTime: signature.blockTime ?? null,
      err: signature.err ?? null,
    })),
    locatorHints: [
      "Look for this public key in wallet apps or keypair files.",
      "A matching wallet should show approximately the same SOL balance at the generatedAt timestamp.",
      "Do not paste private keys or seed phrases into chat; provide only the local keypair file path if found.",
    ],
  };

  const out = writeReceipt(OUT_RECEIPT, receipt);
  console.log(`${receipt.verdict} authority=${receipt.short} sol=${receipt.solBalance.sol.toFixed(9)} receipt=${out}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
