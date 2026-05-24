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
const EXTENSIONS = new Set([".json", ".jsonl", ".env", ".txt", ".key", ".pem", ".bak", ".yaml", ".yml"]);
const NAME_HINT = /key|wallet|secret|kp|payer|authority|signer|id\.json|\.env|solana/i;
const BASE58_ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
const BASE58_SECRET_RE = /(?<![1-9A-HJ-NP-Za-km-z])([1-9A-HJ-NP-Za-km-z]{40,120})(?![1-9A-HJ-NP-Za-km-z])/g;

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

function numberEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw == null || raw === "") return fallback;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) throw new Error(`Invalid ${name}=${raw}`);
  return parsed;
}

function boolEnv(name: string, fallback: boolean): boolean {
  const raw = process.env[name];
  if (raw == null || raw === "") return fallback;
  return ["1", "true", "yes", "y"].includes(raw.toLowerCase());
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

function base58Decode(value: string): Uint8Array | null {
  const bytes = [0];
  for (const char of value) {
    const digit = BASE58_ALPHABET.indexOf(char);
    if (digit < 0) return null;
    let carry = digit;
    for (let index = 0; index < bytes.length; index += 1) {
      carry += bytes[index] * 58;
      bytes[index] = carry & 0xff;
      carry >>= 8;
    }
    while (carry > 0) {
      bytes.push(carry & 0xff);
      carry >>= 8;
    }
  }

  let leadingZeros = 0;
  for (const char of value) {
    if (char !== "1") break;
    leadingZeros += 1;
  }
  return Uint8Array.from([...Array(leadingZeros).fill(0), ...bytes.reverse()]);
}

function parseBase58Keypairs(text: string, includeSeeds: boolean): Array<{ raw: Uint8Array; format: "base58-secret-key" | "base58-seed" }> {
  const out: Array<{ raw: Uint8Array; format: "base58-secret-key" | "base58-seed" }> = [];
  const seen = new Set<string>();
  for (const match of text.matchAll(BASE58_SECRET_RE)) {
    const decoded = base58Decode(match[1]);
    if (!decoded) continue;
    const format = decoded.length === 64
      ? "base58-secret-key"
      : includeSeeds && decoded.length === 32
        ? "base58-seed"
        : null;
    if (!format) continue;
    const key = `${format}:${Buffer.from(decoded).toString("hex")}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ raw: decoded, format });
  }
  return out;
}

function shouldScanFile(file: string, size: number, maxBytes: number): boolean {
  if (size <= 0 || size > maxBytes) return false;
  const basename = path.basename(file);
  return EXTENSIONS.has(path.extname(file)) || NAME_HINT.test(basename);
}

async function main(): Promise<void> {
  const targetPubkeys = new Set(targets());
  const searchRoots = roots();
  const maxFileBytes = Math.floor(numberEnv("SIGNER_SEARCH_MAX_FILE_BYTES", 512 * 1024));
  const includeBase58Seeds = boolEnv("SIGNER_SEARCH_INCLUDE_BASE58_SEEDS", false);
  const matches: Array<{ file: string; pubkey: string; format: string }> = [];
  const derivedByFile = new Map<string, { file: string; pubkey: string; format: string; match: boolean }>();
  const targetMentions: string[] = [];
  let dirsScanned = 0;
  let filesSeen = 0;
  let candidateFiles = 0;
  let keypairLike = 0;
  let base58KeypairLike = 0;
  let errors = 0;

  function recordDerived(file: string, pubkey: string, format: string): void {
    const row = { file, pubkey, format, match: targetPubkeys.has(pubkey) };
    derivedByFile.set(`${file}:${pubkey}:${format}`, row);
    if (row.match) matches.push({ file, pubkey, format });
  }

  function scanFile(file: string): void {
    filesSeen += 1;
    let stat: fs.Stats;
    try {
      stat = fs.statSync(file);
    } catch {
      errors += 1;
      return;
    }
    if (!stat.isFile() || !shouldScanFile(file, stat.size, maxFileBytes)) return;
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
        recordDerived(file, pubkey, "json-secret-key-array");
      } catch {
        // Ignore arrays that look keypair-like but are not valid Solana secret keys.
      }
    }
    for (const candidate of parseBase58Keypairs(text, includeBase58Seeds)) {
      try {
        const keypair = candidate.format === "base58-secret-key"
          ? Keypair.fromSecretKey(candidate.raw)
          : Keypair.fromSeed(candidate.raw);
        base58KeypairLike += 1;
        recordDerived(file, keypair.publicKey.toBase58(), candidate.format);
      } catch {
        // Ignore base58 strings that decode to 32/64 bytes but are not valid keys.
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
    maxFileBytes,
    includeBase58Seeds,
    dirsScanned,
    filesSeen,
    candidateFiles,
    keypairLike,
    base58KeypairLike,
    uniqueDerived: derived.length,
    matchCount: matches.length,
    matches,
    targetMentionFiles: [...new Set(targetMentions)].slice(0, 80),
    sampleDerivedPubkeys: derived.slice(0, 80).map((entry) => ({
      file: entry.file,
      pubkey: entry.pubkey,
      format: entry.format,
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
