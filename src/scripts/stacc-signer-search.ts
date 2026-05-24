import "dotenv/config";
import dotenv from "dotenv";
import fs from "node:fs";
import path from "node:path";
import { Keypair } from "@solana/web3.js";
import { writeReceipt } from "../utils/receipt.js";

if (process.env.ENV_PATH) {
  dotenv.config({ path: process.env.ENV_PATH, override: true });
}

const OUT_RECEIPT = "STACC-SIGNER-SEARCH-LATEST.json";
const CLAIM_SIM_RECEIPT = "receipts/STACC-SOCIAL-FEE-CLAIM-SIM-LATEST.json";
const DEFAULT_TARGETS = [
  "2sMrGNK8i36YRkF5WWCwnaUYuwDJhHe1g2xA8aPvhkjM",
  "WzMaL78srutrF6CsxEkWuhMaDF5HZA6jNRaEPengqpb",
];
const SKIP_NAMES = new Set([
  "Library",
  "node_modules",
  ".git",
  "target",
  "test-ledger",
  ".Trash",
  ".npm",
  ".cache",
  ".rustup",
  ".cargo",
  "DerivedData",
]);
const EXTENSIONS = new Set([".json", ".env", ".txt", ".key", ".pem", ".bak"]);
const NAME_HINT = /key|wallet|secret|kp|payer|authority|signer|id\.json|\.env|solana/i;

type AnyRecord = Record<string, unknown>;

function record(value: unknown): AnyRecord {
  return typeof value === "object" && value !== null ? value as AnyRecord : {};
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string" && entry.length > 0) : [];
}

function csv(name: string): string[] {
  return (process.env[name] ?? "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
}

function targets(): string[] {
  const explicit = csv("TARGET_SIGNER_PUBKEYS");
  if (explicit.length > 0) return explicit;
  if (fs.existsSync(CLAIM_SIM_RECEIPT)) {
    const receipt = record(JSON.parse(fs.readFileSync(CLAIM_SIM_RECEIPT, "utf8")) as unknown);
    const missing = stringArray(receipt.missingSignerPubkeys);
    if (missing.length > 0) return missing;
  }
  return DEFAULT_TARGETS;
}

function roots(): string[] {
  const explicit = csv("SIGNER_SEARCH_ROOTS");
  if (explicit.length > 0) return explicit;
  return [process.env.HOME ?? process.cwd()];
}

function keypairArrays(value: unknown, out: number[][] = []): number[][] {
  if (Array.isArray(value)) {
    if (value.length === 64 && value.every((entry) => Number.isInteger(entry) && entry >= 0 && entry <= 255)) {
      out.push(value as number[]);
    }
    for (const entry of value) keypairArrays(entry, out);
  } else if (typeof value === "object" && value !== null) {
    for (const entry of Object.values(value)) keypairArrays(entry, out);
  }
  return out;
}

function parseKeypairArrays(text: string): number[][] {
  const out: number[][] = [];
  try {
    out.push(...keypairArrays(JSON.parse(text) as unknown));
  } catch {
    // Fall back to embedded JSON arrays in env files, logs, or pasted snippets.
  }
  const embeddedArray = /\[(?:\s*\d{1,3}\s*,){63}\s*\d{1,3}\s*\]/g;
  for (const match of text.matchAll(embeddedArray)) {
    try {
      const parsed = JSON.parse(match[0]) as unknown;
      out.push(...keypairArrays(parsed));
    } catch {
      // Ignore malformed embedded arrays without logging contents.
    }
  }
  return out;
}

function shouldScanFile(file: string, size: number): boolean {
  if (size <= 0 || size > 512 * 1024) return false;
  const basename = path.basename(file);
  return EXTENSIONS.has(path.extname(file)) || NAME_HINT.test(basename);
}

async function main(): Promise<void> {
  const targetPubkeys = new Set(targets());
  const searchRoots = roots();
  const matches: Array<{ file: string; pubkey: string }> = [];
  const derivedByFile = new Map<string, { file: string; pubkey: string; match: boolean }>();
  const targetMentions: string[] = [];
  let dirsScanned = 0;
  let filesSeen = 0;
  let candidateFiles = 0;
  let keypairLike = 0;
  let errors = 0;

  function scanFile(file: string): void {
    filesSeen += 1;
    let stat: fs.Stats;
    try {
      stat = fs.statSync(file);
    } catch {
      errors += 1;
      return;
    }
    if (!stat.isFile() || !shouldScanFile(file, stat.size)) return;
    candidateFiles += 1;
    let text: string;
    try {
      text = fs.readFileSync(file, "utf8");
    } catch {
      errors += 1;
      return;
    }
    for (const target of targetPubkeys) {
      if (text.includes(target) && targetMentions.length < 80) targetMentions.push(file);
    }
    for (const raw of parseKeypairArrays(text)) {
      try {
        const pubkey = Keypair.fromSecretKey(Uint8Array.from(raw)).publicKey.toBase58();
        keypairLike += 1;
        const row = { file, pubkey, match: targetPubkeys.has(pubkey) };
        derivedByFile.set(`${file}:${pubkey}`, row);
        if (row.match) matches.push({ file, pubkey });
      } catch {
        // Ignore arrays that look keypair-like but are not valid Solana secret keys.
      }
    }
  }

  function walk(dir: string): void {
    dirsScanned += 1;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      errors += 1;
      return;
    }
    for (const entry of entries) {
      if (SKIP_NAMES.has(entry.name)) continue;
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(fullPath);
      else if (entry.isFile()) scanFile(fullPath);
    }
  }

  for (const root of searchRoots) {
    if (fs.existsSync(root)) walk(root);
  }

  const derived = [...derivedByFile.values()];
  const receipt = {
    verdict: matches.length > 0 ? "STACC_SIGNER_SEARCH_MATCH_FOUND_NO_LIVE" : "STACC_SIGNER_SEARCH_NO_MATCH",
    generatedAt: new Date().toISOString(),
    noSend: true,
    targetPubkeys: [...targetPubkeys],
    searchRoots,
    dirsScanned,
    filesSeen,
    candidateFiles,
    keypairLike,
    uniqueDerived: derived.length,
    matchCount: matches.length,
    matches,
    targetMentionFiles: [...new Set(targetMentions)].slice(0, 80),
    sampleDerivedPubkeys: derived.slice(0, 80).map((entry) => ({
      file: entry.file,
      pubkey: entry.pubkey,
      match: entry.match,
    })),
    errors,
    rejectionReasons: matches.length > 0 ? [] : ["no local keypair derived to any target signer pubkey"],
  };
  const out = writeReceipt(OUT_RECEIPT, receipt);
  console.log(`${receipt.verdict} targets=${receipt.targetPubkeys.join(",")} matches=${matches.length} candidates=${candidateFiles} receipt=${out}`);
  if (matches.length === 0) process.exitCode = 1;
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
