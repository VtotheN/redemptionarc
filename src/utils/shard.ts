import fs from "node:fs";
import path from "node:path";
import { Keypair, PublicKey } from "@solana/web3.js";
import { loadKeypair, ensureKeypair, publicKeyFromKeypairFile } from "./keypair.js";

export interface ShardConfig {
  shardId: number;
  crank: Keypair;
  crankPath: string;
  marginfiAccountPath: string;
  marginfiAccountPubkey: PublicKey;
  ringPaths: string[];
}

function resolveKeysDir(): string {
  return process.env.KEYS_DIR || path.join(process.cwd(), "keys");
}

export function getShardConfig(shardId?: number): ShardConfig | null {
  const id = shardId ?? (process.env.CRANK_SHARD_ID ? Number(process.env.CRANK_SHARD_ID) : null);
  if (id === null || Number.isNaN(id)) return null;

  const keysDir = resolveKeysDir();
  const suffix = id === 0 ? "" : `-${id}`;
  const crankPath = path.join(keysDir, `crank${suffix}.json`);
  const marginfiPath = path.join(keysDir, `marginfi-account${suffix}.json`);

  if (!fs.existsSync(crankPath)) {
    throw new Error(`Shard ${id}: crank keypair not found: ${crankPath}`);
  }
  if (!fs.existsSync(marginfiPath)) {
    throw new Error(`Shard ${id}: MarginFi account keypair not found: ${marginfiPath}`);
  }

  const crank = loadKeypair(crankPath);
  const marginfiPubkey = publicKeyFromKeypairFile(marginfiPath);

  const ringPaths: string[] = [];
  for (let r = 1; r <= 4; r++) {
    const rp = path.join(keysDir, `ring${suffix}-${r}.json`);
    if (fs.existsSync(rp)) ringPaths.push(rp);
  }

  return {
    shardId: id,
    crank,
    crankPath,
    marginfiAccountPath: marginfiPath,
    marginfiAccountPubkey: marginfiPubkey,
    ringPaths,
  };
}

export function shardCrankPath(shardId: number): string {
  const keysDir = resolveKeysDir();
  const suffix = shardId === 0 ? "" : `-${shardId}`;
  return path.join(keysDir, `crank${suffix}.json`);
}

export function shardMarginfiPath(shardId: number): string {
  const keysDir = resolveKeysDir();
  const suffix = shardId === 0 ? "" : `-${shardId}`;
  return path.join(keysDir, `marginfi-account${suffix}.json`);
}

export function shardRingPath(shardId: number, ringIndex: number): string {
  const keysDir = resolveKeysDir();
  const suffix = shardId === 0 ? "" : `-${shardId}`;
  return path.join(keysDir, `ring${suffix}-${ringIndex}.json`);
}

export function ensureShardKeys(shardId: number): {
  crank: Keypair;
  marginfiAccount: Keypair;
  rings: Keypair[];
} {
  const keysDir = resolveKeysDir();
  fs.mkdirSync(keysDir, { recursive: true });

  const suffix = shardId === 0 ? "" : `-${shardId}`;
  const crankPath = path.join(keysDir, `crank${suffix}.json`);
  const marginfiPath = path.join(keysDir, `marginfi-account${suffix}.json`);

  const crank = ensureKeypair(crankPath);
  const marginfiAccount = ensureKeypair(marginfiPath);

  const rings: Keypair[] = [];
  for (let r = 1; r <= 4; r++) {
    rings.push(ensureKeypair(path.join(keysDir, `ring${suffix}-${r}.json`)));
  }

  return { crank, marginfiAccount, rings };
}

export function listShards(): number[] {
  const keysDir = resolveKeysDir();
  if (!fs.existsSync(keysDir)) return [0];

  const shards = new Set<number>();
  // Always include shard 0 (default crank.json)
  if (fs.existsSync(path.join(keysDir, "crank.json"))) shards.add(0);

  const re = /^crank-(\d+)\.json$/;
  for (const f of fs.readdirSync(keysDir)) {
    const m = re.exec(f);
    if (m) shards.add(Number(m[1]));
  }

  return Array.from(shards).sort((a, b) => a - b);
}
