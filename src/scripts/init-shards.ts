/**
 * init-shards.ts — Generate N independent crank shards.
 *
 * Each shard gets:
 *   - crank-{id}.json        (TX signer + fee payer)
 *   - marginfi-account-{id}.json  (MarginFi flash account)
 *   - ring-{id}-1.json … ring-{id}-4.json  (T22 ring co-signers)
 *
 * ENV:
 *   SHARD_COUNT=4   (how many shards to create)
 *   KEYS_DIR=keys   (output directory)
 */

import "dotenv/config";
import fs from "node:fs";
import path from "node:path";
import { ensureShardKeys, listShards } from "../utils/shard.js";

async function main(): Promise<void> {
  const count = Number(process.env.SHARD_COUNT || "4");
  if (count < 1 || count > 100) throw new Error(`SHARD_COUNT must be 1..100, got ${count}`);

  const existing = listShards();
  console.log(`Existing shards: [${existing.join(", ")}]`);

  const created: number[] = [];
  for (let i = 0; i < count; i++) {
    // Find next available shard ID
    let id = i;
    while (existing.includes(id) || created.includes(id)) id++;

    const { crank, marginfiAccount, rings } = ensureShardKeys(id);
    created.push(id);

    console.log(`Shard ${id}:`);
    console.log(`  crank:        ${crank.publicKey.toBase58()}`);
    console.log(`  marginfi:     ${marginfiAccount.publicKey.toBase58()}`);
    rings.forEach((k, idx) => {
      console.log(`  ring-${idx + 1}:   ${k.publicKey.toBase58()}`);
    });
  }

  console.log(`\nCreated ${created.length} shard(s): [${created.join(", ")}]`);
  console.log("Next steps:");
  console.log("  1. Fund each crank with SOL for gas + Jito tips");
  console.log("  2. Create MarginFi accounts for each shard (deposit USDC collateral)");
  console.log("  3. Create USDC + HOP ATAs for each crank");
  console.log("  4. Run: CRANK_SHARD_ID=0 npx tsx src/scripts/flywheel-bot.ts  (etc)");
}

main().catch((e) => { console.error(e); process.exitCode = 1; });
