import "dotenv/config";
import dotenv from "dotenv";
import fs from "node:fs";
import {
  Keypair,
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
const CLAIM_SOCIAL_FEE_PDA_DISC = "e115fb85a11ec7e2";
const CLAIM_SOCIAL_FEE_PDA_V2_DISC = "114df0863abc3595";

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
    `${process.env.HOME ?? ""}/.config/solana/id.json`,
    ...(fs.existsSync("keys") ? fs.readdirSync("keys").map((name) => `keys/${name}`) : []),
    ...envCsv("SOCIAL_FEE_KEYPAIR_PATHS"),
    ...envCsv("OWNED_FEE_KEYPAIR_PATHS"),
    ...envCsv("KEEPER_AUTHORITY_KEYPAIR_PATHS"),
    process.env.CRANK_KEYPAIR_PATH,
    process.env.TREASURY_KEYPAIR_PATH,
  ].filter((value): value is string => Boolean(value));
}

type LocalSigner = {
  path: string;
  pubkey: string;
  keypair: Keypair;
};

function loadLocalSigners(): LocalSigner[] {
  const out: LocalSigner[] = [];
  const seenPath = new Set<string>();
  for (const file of signerCandidates()) {
    if (seenPath.has(file)) continue;
    seenPath.add(file);
    if (!fs.existsSync(file)) continue;
    try {
      const pubkey = publicKeyFromKeypairFile(file).toBase58();
      out.push({ path: file, pubkey, keypair: loadKeypair(file) });
    } catch {
      // Ignore unreadable or malformed keypair files without printing contents.
    }
  }
  return out;
}

function requiredSignerIndexesForKnownIx(programId: string, dataHex: string, accountCount: number): Set<number> | null {
  if (programId !== SOCIAL_FEE_PROGRAM) return null;
  if (dataHex.startsWith(CLAIM_SOCIAL_FEE_PDA_V2_DISC) && accountCount >= 9) return new Set([8]);
  if (dataHex.startsWith(CLAIM_SOCIAL_FEE_PDA_DISC) && accountCount >= 4) return new Set([3]);
  return null;
}

function requiredSignerPubkeys(instructions: TransactionInstruction[]): string[] {
  const signers = new Set<string>();
  for (const ix of instructions) {
    for (const key of ix.keys) {
      if (key.isSigner) signers.add(key.pubkey.toBase58());
    }
  }
  return [...signers];
}

function signerKeypairsFor(required: string[], localSigners: LocalSigner[]): Keypair[] {
  const byPubkey = new Map(localSigners.map((entry) => [entry.pubkey, entry.keypair]));
  return required
    .map((pubkey) => byPubkey.get(pubkey))
    .filter((value): value is Keypair => Boolean(value));
}

function uniqueKeypairs(keypairs: Keypair[]): Keypair[] {
  const seen = new Set<string>();
  const out: Keypair[] = [];
  for (const keypair of keypairs) {
    const pubkey = keypair.publicKey.toBase58();
    if (seen.has(pubkey)) continue;
    seen.add(pubkey);
    out.push(keypair);
  }
  return out;
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
    const knownSignerIndexes = requiredSignerIndexesForKnownIx(programId, dataHex, accounts.length);

    instructions.push(new TransactionInstruction({
      programId: new PublicKey(programId),
      keys: accounts.map((account, index) => ({
        pubkey: new PublicKey(String(account.pubkey)),
        isSigner: knownSignerIndexes ? knownSignerIndexes.has(index) : bool(account.isSigner, false),
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
  const instructions = buildInstructions(source);
  const localSigners = loadLocalSigners();
  const requiredSigners = requiredSignerPubkeys(instructions);
  const availableSignerPubkeys = localSigners.map((entry) => entry.pubkey);
  const availableRequiredSigners = requiredSigners.filter((pubkey) => availableSignerPubkeys.includes(pubkey));
  const missingSignerPubkeys = requiredSigners.filter((pubkey) => !availableSignerPubkeys.includes(pubkey));
  const authoritySigner = authority ? localSigners.find((entry) => entry.pubkey === authority) ?? null : null;
  const payer = authoritySigner
    ?? localSigners.find((entry) => requiredSigners.includes(entry.pubkey))
    ?? localSigners[0]
    ?? null;
  const socialClaimAuthority = instructions[0]?.keys[8]?.pubkey.toBase58() ?? null;

  if (!authority || !payer || instructions.length === 0 || missingSignerPubkeys.length > 0) {
    const receipt = {
      verdict: "STACC_SOCIAL_FEE_CLAIM_SIM_BLOCKED",
      generatedAt: new Date().toISOString(),
      noSend: true,
      dryRun: true,
      authority,
      socialClaimAuthority,
      authorityLocalSignerAvailable: Boolean(authoritySigner),
      instructionCount: instructions.length,
      requiredSignerPubkeys: requiredSigners,
      availableRequiredSignerPubkeys: availableRequiredSigners,
      missingSignerPubkeys,
      configuredSignerPubkeys: availableSignerPubkeys,
      sourceReceipt: SOURCE_RECEIPT,
      rejectionReasons: [
        authority ? null : "source receipt has no authority",
        instructions.length > 0 ? null : "source receipt has no reusable social-fee instruction shape",
        requiredSigners.length > 0 ? null : "source receipt instruction shape marks no required signers",
        payer ? null : "no local payer/signer keypair found in default Solana keypair, keys/, SOCIAL_FEE_KEYPAIR_PATHS/OWNED_FEE_KEYPAIR_PATHS/KEEPER_AUTHORITY_KEYPAIR_PATHS",
        missingSignerPubkeys.length === 0 ? null : `missing required signer keypairs: ${missingSignerPubkeys.join(", ")}`,
      ].filter((value): value is string => value !== null),
    };
    const out = writeReceipt(OUT_RECEIPT, receipt);
    console.log(`${receipt.verdict} authority=${authority ?? "null"} missingSigners=${missingSignerPubkeys.length} ix=${instructions.length} receipt=${out}`);
    process.exitCode = 1;
    return;
  }

  const connection = new Connection(config.rpcUrl, "confirmed");
  const blockhash = await connection.getLatestBlockhash("confirmed");
  const message = new TransactionMessage({
    payerKey: payer.keypair.publicKey,
    recentBlockhash: blockhash.blockhash,
    instructions,
  }).compileToV0Message();
  const tx = new VersionedTransaction(message);
  tx.sign(uniqueKeypairs([payer.keypair, ...signerKeypairsFor(requiredSigners, localSigners)]));

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
    socialClaimAuthority,
    authorityLocalSignerAvailable: Boolean(authoritySigner),
    payerPubkey: payer.keypair.publicKey.toBase58(),
    requiredSignerPubkeys: requiredSigners,
    availableRequiredSignerPubkeys: availableRequiredSigners,
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
