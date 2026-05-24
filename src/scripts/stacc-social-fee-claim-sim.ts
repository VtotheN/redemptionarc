import "dotenv/config";
import dotenv from "dotenv";
import fs from "node:fs";
import {
  PublicKey,
  TransactionInstruction,
  TransactionMessage,
  VersionedTransaction,
  Connection,
} from "@solana/web3.js";
import { loadConfig } from "../config.js";
import { loadKeypair, publicKeyFromKeypairFile } from "../utils/keypair.js";
import { assertNoForbiddenConfigured } from "../utils/safety.js";
import { writeReceipt } from "../utils/receipt.js";

if (process.env.ENV_PATH) {
  dotenv.config({ path: process.env.ENV_PATH, override: true });
}

const SOURCE_RECEIPT = "receipts/STACC-SOCIAL-FEE-SOURCE-LATEST.json";
const OUT_RECEIPT = "STACC-SOCIAL-FEE-CLAIM-SIM-LATEST.json";
const SOCIAL_FEE_PROGRAM = "pfeeUxB6jkeY1Hxd7CsFCAjcbHA9rWtchMGdZ6VojVZ";

type AnyRecord = Record<string, unknown>;

function record(value: unknown): AnyRecord {
  return typeof value === "object" && value !== null ? value as AnyRecord : {};
}

function array(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function string(value: unknown): string | null {
  return typeof value === "string" && value.trim() !== "" ? value : null;
}

function bool(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}

function envCsv(name: string): string[] {
  return (process.env[name] ?? "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
}

function signerCandidates() {
  return [
    ...envCsv("SOCIAL_FEE_KEYPAIR_PATHS"),
    ...envCsv("OWNED_FEE_KEYPAIR_PATHS"),
    process.env.CRANK_KEYPAIR_PATH,
    process.env.TREASURY_KEYPAIR_PATH,
  ].filter((value): value is string => Boolean(value));
}

function findAuthorityKeypair(authority: string) {
  for (const file of signerCandidates()) {
    if (!fs.existsSync(file)) continue;
    try {
      const pubkey = publicKeyFromKeypairFile(file).toBase58();
      if (pubkey === authority) return { path: file, keypair: loadKeypair(file) };
    } catch {
      // Ignore unreadable or malformed keypair files without printing contents.
    }
  }
  return null;
}

function buildInstructions(source: AnyRecord): TransactionInstruction[] {
  const latest = record(source.latestPositiveClaim);
  const shapes = array(latest.socialFeeInstructions).map(record);
  const instructions: TransactionInstruction[] = [];

  for (const shape of shapes) {
    const programId = string(shape.programId);
    const dataHex = string(shape.dataHex);
    const accounts = array(shape.accounts).map(record);
    if (programId !== SOCIAL_FEE_PROGRAM || !dataHex || accounts.length === 0) continue;

    instructions.push(new TransactionInstruction({
      programId: new PublicKey(programId),
      keys: accounts.map((account) => ({
        pubkey: new PublicKey(String(account.pubkey)),
        isSigner: bool(account.isSigner, false),
        isWritable: bool(account.isWritable, false),
      })),
      data: Buffer.from(dataHex, "hex"),
    }));
  }

  return instructions;
}

async function main(): Promise<void> {
  const config = loadConfig();
  assertNoForbiddenConfigured(config);

  if (!fs.existsSync(SOURCE_RECEIPT)) {
    const receipt = {
      verdict: "STACC_SOCIAL_FEE_CLAIM_SIM_BLOCKED_MISSING_SOURCE",
      generatedAt: new Date().toISOString(),
      noSend: true,
      sourceReceipt: SOURCE_RECEIPT,
      rejectionReasons: ["run npm run stacc-social-fee-source-scan first"],
    };
    const out = writeReceipt(OUT_RECEIPT, receipt);
    console.log(`${receipt.verdict} receipt=${out}`);
    process.exitCode = 1;
    return;
  }

  const source = JSON.parse(fs.readFileSync(SOURCE_RECEIPT, "utf8")) as AnyRecord;
  const authority = string(source.authority);
  const signer = authority ? findAuthorityKeypair(authority) : null;
  const instructions = buildInstructions(source);

  if (!authority || !signer || instructions.length === 0) {
    const receipt = {
      verdict: "STACC_SOCIAL_FEE_CLAIM_SIM_BLOCKED",
      generatedAt: new Date().toISOString(),
      noSend: true,
      dryRun: true,
      authority,
      authorityLocalSignerAvailable: Boolean(signer),
      instructionCount: instructions.length,
      sourceReceipt: SOURCE_RECEIPT,
      rejectionReasons: [
        authority ? null : "source receipt has no authority",
        signer ? null : "matching authority keypair not found in SOCIAL_FEE_KEYPAIR_PATHS/OWNED_FEE_KEYPAIR_PATHS",
        instructions.length > 0 ? null : "source receipt has no reusable social-fee instruction shape",
      ].filter((value): value is string => value !== null),
    };
    const out = writeReceipt(OUT_RECEIPT, receipt);
    console.log(`${receipt.verdict} authority=${authority ?? "null"} localSigner=${Boolean(signer)} ix=${instructions.length} receipt=${out}`);
    process.exitCode = 1;
    return;
  }

  const connection = new Connection(config.rpcUrl, "confirmed");
  const blockhash = await connection.getLatestBlockhash("confirmed");
  const message = new TransactionMessage({
    payerKey: signer.keypair.publicKey,
    recentBlockhash: blockhash.blockhash,
    instructions,
  }).compileToV0Message();
  const tx = new VersionedTransaction(message);
  tx.sign([signer.keypair]);

  const sim = await connection.simulateTransaction(tx, {
    commitment: "confirmed",
    sigVerify: true,
  });
  const logs = sim.value.logs ?? [];
  const receipt = {
    verdict: sim.value.err == null
      ? "STACC_SOCIAL_FEE_CLAIM_SIM_OK_NO_LIVE"
      : "STACC_SOCIAL_FEE_CLAIM_SIM_BLOCKED",
    generatedAt: new Date().toISOString(),
    noSend: true,
    dryRun: true,
    allowLiveIgnored: process.env.ALLOW_LIVE === "true",
    liveTxApprovedIgnored: process.env.LIVE_TX_APPROVED === "true",
    authority,
    authorityLocalSignerAvailable: true,
    signerPubkey: signer.keypair.publicKey.toBase58(),
    instructionCount: instructions.length,
    sourceReceipt: SOURCE_RECEIPT,
    simErr: sim.value.err,
    unitsConsumed: sim.value.unitsConsumed ?? null,
    logHints: logs.filter((line) => line.includes("ClaimSocialFee") || line.includes("No fees")).slice(0, 12),
    cashProofGate: {
      pass: false,
      reason: "Simulation shape only. A CashRelay source receipt still needs observed beforeRaw/afterRaw for a fresh unclaimed fee state.",
    },
  };
  const out = writeReceipt(OUT_RECEIPT, receipt);
  console.log(`${receipt.verdict} simErr=${JSON.stringify(sim.value.err)} ix=${instructions.length} receipt=${out}`);
  if (sim.value.err != null) process.exitCode = 1;
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
