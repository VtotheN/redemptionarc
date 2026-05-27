/**
 * shard-orchestrator.ts — Supervise N crank shards in parallel child processes.
 *
 * For each shard, spawns the target script with CRANK_SHARD_ID set.
 * Restarts crashed workers up to MAX_RETRIES. Logs per-shard output.
 *
 * ENV:
 *   SCRIPT_NAME=flywheel-bot.ts        (target script in src/scripts/)
 *   SHARD_COUNT=auto                   (auto-detect from keys/, or set number)
 *   SHARD_IDS=0,1,2,3                  (explicit list, overrides SHARD_COUNT)
 *   LOOP_INTERVAL_MS=30000             (how often to respawn/check health)
 *   MAX_RETRIES=5                      (per-shard restart limit)
 *   DRY_RUN=true                       (passed through to children)
 *   ALLOW_LIVE=false                   (passed through to children)
 */

import "dotenv/config";
import fs from "node:fs";
import path from "node:path";
import { spawn, ChildProcess } from "node:child_process";
import { listShards } from "../utils/shard.js";

interface WorkerState {
  shardId: number;
  proc: ChildProcess | null;
  retries: number;
  lastExitCode: number | null;
  lastStart: number;
  logs: string[];
}

function now(): string {
  return new Date().toISOString();
}

function getShardIds(): number[] {
  if (process.env.SHARD_IDS) {
    return process.env.SHARD_IDS.split(",").map((s) => Number(s.trim())).filter((n) => !Number.isNaN(n));
  }
  const countEnv = process.env.SHARD_COUNT;
  if (countEnv && countEnv !== "auto") {
    const count = Number(countEnv);
    return Array.from({ length: count }, (_, i) => i);
  }
  return listShards();
}

function spawnWorker(
  scriptName: string,
  shardId: number,
  env: NodeJS.ProcessEnv
): ChildProcess {
  const scriptPath = path.join(process.cwd(), "src", "scripts", scriptName);
  const workerEnv = {
    ...env,
    CRANK_SHARD_ID: String(shardId),
    RECEIPT_NAME: `shard-${shardId}-${scriptName.replace(/\.ts$/, "")}.json`,
  };

  const proc = spawn("npx", ["tsx", scriptPath], {
    env: workerEnv,
    stdio: ["ignore", "pipe", "pipe"],
    detached: false,
  });

  proc.stdout?.on("data", (data: Buffer) => {
    const lines = data.toString("utf8").trimEnd().split("\n");
    for (const line of lines) {
      console.log(`[shard-${shardId}] ${line}`);
    }
  });

  proc.stderr?.on("data", (data: Buffer) => {
    const lines = data.toString("utf8").trimEnd().split("\n");
    for (const line of lines) {
      console.error(`[shard-${shardId}] ${line}`);
    }
  });

  return proc;
}

async function main(): Promise<void> {
  const scriptName = process.env.SCRIPT_NAME || "flywheel-bot.ts";
  const intervalMs = Number(process.env.LOOP_INTERVAL_MS || "30000");
  const maxRetries = Number(process.env.MAX_RETRIES || "5");
  const shardIds = getShardIds();

  if (shardIds.length === 0) {
    throw new Error("No shards found. Run: npx tsx src/scripts/init-shards.ts");
  }

  console.log(`[${now()}] shard-orchestrator starting`);
  console.log(`  script:   ${scriptName}`);
  console.log(`  shards:   [${shardIds.join(", ")}]`);
  console.log(`  interval: ${intervalMs}ms`);
  console.log(`  maxRetries: ${maxRetries}`);
  console.log(`  dryRun:   ${process.env.DRY_RUN !== "false"}`);
  console.log();

  const workers: Map<number, WorkerState> = new Map();
  for (const id of shardIds) {
    workers.set(id, {
      shardId: id,
      proc: null,
      retries: 0,
      lastExitCode: null,
      lastStart: 0,
      logs: [],
    });
  }

  // Pass-through env vars that children need
  const baseEnv = { ...process.env };

  // Initial spawn
  for (const [id, state] of workers) {
    console.log(`[${now()}] spawning shard-${id}`);
    state.proc = spawnWorker(scriptName, id, baseEnv);
    state.lastStart = Date.now();
  }

  // Health / respawn loop
  const healthInterval = setInterval(() => {
    for (const [id, state] of workers) {
      if (state.proc === null || state.proc.exitCode !== null) {
        // Process exited
        if (state.retries >= maxRetries) {
          console.error(`[${now()}] shard-${id} exceeded max retries (${maxRetries}). Marking DEAD.`);
          workers.delete(id);
          continue;
        }
        state.retries++;
        console.log(`[${now()}] shard-${id} exited (code=${state.proc?.exitCode ?? "null"}), restart ${state.retries}/${maxRetries}`);
        state.proc = spawnWorker(scriptName, id, baseEnv);
        state.lastStart = Date.now();
      }
    }

    if (workers.size === 0) {
      console.error(`[${now()}] All shards dead. Exiting.`);
      clearInterval(healthInterval);
      process.exit(1);
    }
  }, intervalMs);

  // Graceful shutdown
  const shutdown = () => {
    console.log(`[${now()}] shutting down orchestrator...`);
    clearInterval(healthInterval);
    for (const [, state] of workers) {
      if (state.proc && state.proc.exitCode === null) {
        state.proc.kill("SIGTERM");
      }
    }
    setTimeout(() => process.exit(0), 2000);
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((e) => { console.error(e); process.exitCode = 1; });
