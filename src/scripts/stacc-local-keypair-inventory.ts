import "dotenv/config";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Connection, Keypair, PublicKey } from "@solana/web3.js";
import { loadConfig } from "../config.js";
import { writeReceipt } from "../utils/receipt.js";
import { assertNoForbiddenConfigured } from "../utils/safety.js";

const OUT_RECEIPT = "STACC-LOCAL-KEYPAIR-INVENTORY-LATEST.json";
const DEFAULT_TARGET = "";
const MAX_FILE_BYTES = 512 * 1024;

type Candidate = {
  file: string;
  pubkey: string;
  target: boolean;
};

type CandidateBalance = Candidate & {
  sol: number | null;
  lamports: number | null;
};

function csv(name: string): string[] {
  return (process.env[name] ?? "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
}

function targetPubkeys(): Set<string> {
  const targets = csv("TARGET_SIGNER_PUBKEYS");
  return new Set(targets.length > 0 ? targets : [DEFAULT_TARGET]);
}

function roots(): string[] {
  const explicit = csv("KEYPAIR_INVENTORY_ROOTS");
  if (explicit.length > 0) return explicit;
  const home = os.homedir();
  return [
    path.join(home, ".config", "solana"),
    path.join(home, ".keys"),
    path.join(process.cwd(), "keys"),
  ];
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

function shouldScan(file: string): boolean {
  const ext = path.extname(file).toLowerCase();
  const basename = path.basename(file).toLowerCase();
  return ext === ".json" || ext === ".key" || basename.includes("id.json") || basename.includes("keypair");
}

function scanFile(file: string, targets: Set<string>): Candidate[] {
  let stat: fs.Stats;
  try {
    stat = fs.statSync(file);
  } catch {
    return [];
  }
  if (!stat.isFile() || stat.size <= 0 || stat.size > MAX_FILE_BYTES || !shouldScan(file)) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(file, "utf8")) as unknown;
  } catch {
    return [];
  }
  const out: Candidate[] = [];
  for (const raw of keypairArrays(parsed)) {
    try {
      const pubkey = Keypair.fromSecretKey(Uint8Array.from(raw)).publicKey.toBase58();
      out.push({ file, pubkey, target: targets.has(pubkey) });
    } catch {
      // Ignore arrays that are not valid Solana secret keys.
    }
  }
  return out;
}

function walk(root: string, targets: Set<string>): Candidate[] {
  if (!fs.existsSync(root)) return [];
  const out: Candidate[] = [];
  const stack = [root];
  while (stack.length > 0) {
    const dir = stack.pop();
    if (!dir) continue;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name !== "node_modules" && entry.name !== ".git") stack.push(fullPath);
      } else if (entry.isFile()) {
        out.push(...scanFile(fullPath, targets));
      }
    }
  }
  return out;
}

function receiptCandidate(candidate: CandidateBalance): Record<string, unknown> {
  const publicShape: Record<string, unknown> = {
    pubkey: candidate.pubkey,
    target: candidate.target,
    sol: candidate.sol,
    lamports: candidate.lamports,
  };
  if (candidate.target) {
    publicShape.file = candidate.file;
  } else {
    publicShape.fileBasename = path.basename(candidate.file);
  }
  return publicShape;
}

async function main(): Promise<void> {
  const config = loadConfig();
  assertNoForbiddenConfigured(config);
  const connection = new Connection(config.rpcUrl, "confirmed");
  const targets = targetPubkeys();
  const searchRoots = roots();
  const deduped = new Map<string, Candidate>();
  for (const root of searchRoots) {
    for (const candidate of walk(root, targets)) {
      deduped.set(`${candidate.file}:${candidate.pubkey}`, candidate);
    }
  }

  const candidates = [...deduped.values()];
  const balances = await Promise.all(candidates.map(async (candidate) => {
    const lamports = await connection.getBalance(new PublicKey(candidate.pubkey), "confirmed").catch(() => null);
    return {
      ...candidate,
      sol: lamports == null ? null : lamports / 1_000_000_000,
      lamports,
    };
  }));
  balances.sort((a, b) => (b.sol ?? -1) - (a.sol ?? -1));
  const topSol = balances[0]?.sol ?? 0;

  const receipt = {
    verdict: balances.some((candidate) => candidate.target)
      ? "STACC_LOCAL_KEYPAIR_TARGET_FOUND_NO_LIVE"
      : "STACC_LOCAL_KEYPAIR_TARGET_NOT_FOUND_READ_ONLY",
    generatedAt: new Date().toISOString(),
    readOnly: true,
    noSend: true,
    targetPubkeys: [...targets],
    searchRoots,
    candidateCount: balances.length,
    matches: balances.filter((candidate) => candidate.target).map(receiptCandidate),
    topBySol: balances.slice(0, 40).map(receiptCandidate),
    note: "Secret key material is never printed. Non-matching keypair paths are reduced to basenames in the receipt; exact file path is recorded only for target matches.",
  };

  const out = writeReceipt(OUT_RECEIPT, receipt);
  console.log(`${receipt.verdict} candidates=${receipt.candidateCount} matches=${receipt.matches.length} topSol=${topSol.toFixed(9)} receipt=${out}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
