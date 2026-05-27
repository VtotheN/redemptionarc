# Runbook — Epoch 978 HOP Fee Transition

> **Trigger:** When `epoch >= 978`, HOP T22 transfer fee drops from **690 bps → 1 bps**.
> This flips the economics from negative to positive for all flash-loop strategies.

---

## 1. State Checklist (before touching mainnet)

```bash
# Verify epoch
solana epoch

# Verify HOP fee bps
npx tsx src/scripts/preflight.ts
# Expected: t22FeeBps = 1, gate passes, canExecute = true
```

| Checkpoint | OK? | Command / File |
|---|---|---|
| Epoch ≥ 978 | ☐ | `solana epoch` |
| HOP fee = 1 bps | ☐ | `src/scripts/preflight.ts` |
| All shards funded with SOL | ☐ | `solana balance keys/crank-{id}.json` |
| All shards have MarginFi accounts | ☐ | `src/scripts/bootstrap-shards.ts` dry-run |
| All shards have USDC + HOP ATAs | ☐ | `src/scripts/bootstrap-shards.ts` dry-run |
| Ring delegates approved | ☐ | `src/scripts/bootstrap-shards.ts` dry-run |
| Flywheel dry-run passes | ☐ | `DRY_RUN=true npx tsx src/scripts/flywheel-bot.ts` |
| Flash-deep-vol dry-run passes | ☐ | `DRY_RUN=true npx tsx src/scripts/flash-deep-vol.ts` |
| Fee collector dry-run passes | ☐ | `DRY_RUN=true npx tsx src/scripts/fee-collector.ts` |

---

## 2. Bootstrap (one-time per shard)

If you already ran `init-shards.ts` and `bootstrap-shards.ts`, skip to §3.

```bash
# 2.1 Generate shards (if not done)
SHARD_COUNT=4 npx tsx src/scripts/init-shards.ts

# 2.2 Fund each crank with SOL (minimum 0.05 SOL per shard)
# Replace PK with each crank pubkey from init-shards output
solana transfer <CRANK-1-PK> 0.05 --from <TREASURY>
solana transfer <CRANK-2-PK> 0.05 --from <TREASURY>
# ...

# 2.3 Run bootstrap (dry-run first)
SHARD_IDS=0,1,2,3 \
  DRY_RUN=true \
  npx tsx src/scripts/bootstrap-shards.ts

# 2.4 Live bootstrap (when dry-run passes)
SHARD_IDS=0,1,2,3 \
  DRY_RUN=false ALLOW_LIVE=true \
  npx tsx src/scripts/bootstrap-shards.ts
```

**Note:** MarginFi accounts require SOL rent (~0.016 SOL each). ATAs require ~0.002 SOL each.

---

## 3. Execution Modes

### 3.1 Single-shard dry-run (test one shard)

```bash
CRANK_SHARD_ID=1 \
  DRY_RUN=true \
  FLASH_AMOUNT_USDC=300 \
  npx tsx src/scripts/flywheel-bot.ts
```

### 3.2 Single-shard live (manual, one-off)

```bash
CRANK_SHARD_ID=1 \
  DRY_RUN=false ALLOW_LIVE=true \
  FLASH_AMOUNT_USDC=300 \
  BUNDLES=10 \
  JITO_TIP_LAMPORTS=10000 \
  npx tsx src/scripts/flywheel-bot.ts
```

### 3.3 Multi-shard orchestrator (recommended)

```bash
# Flywheel on all detected shards
SCRIPT_NAME=flywheel-bot.ts \
  DRY_RUN=false ALLOW_LIVE=true \
  FLASH_AMOUNT_USDC=300 \
  BUNDLES=10 \
  JITO_TIP_LAMPORTS=10000 \
  npx tsx src/scripts/shard-orchestrator.ts

# Or explicit shard list
SHARD_IDS=0,1,2,3 \
  SCRIPT_NAME=flywheel-bot.ts \
  DRY_RUN=false ALLOW_LIVE=true \
  npx tsx src/scripts/shard-orchestrator.ts
```

### 3.4 Flash-deep-vol (Raydium CPMM)

```bash
CRANK_SHARD_ID=1 \
  DRY_RUN=false ALLOW_LIVE=true \
  FLASH_USDC=10000 ADDLIQ_USDC=5000 SWAP_USDC=100 \
  npx tsx src/scripts/flash-deep-vol.ts
```

### 3.5 Fee collector (singleton)

Run this periodically (e.g., every 5 min) on **shard 0 only**:

```bash
# Dry-run
DRY_RUN=true npx tsx src/scripts/fee-collector.ts

# Live collect only
DRY_RUN=false ALLOW_LIVE=true \
  SWAP_HOP_TO_USDC=false \
  npx tsx src/scripts/fee-collector.ts

# Live collect + swap HOP→USDC
DRY_RUN=false ALLOW_LIVE=true \
  SWAP_HOP_TO_USDC=true \
  npx tsx src/scripts/fee-collector.ts
```

---

## 4. Monitoring

### 4.1 Watch logs

```bash
# Orchestrator logs are prefixed by shard:
# [shard-0] SIM OK cu=330000
# [shard-1] SIM OK cu=340000
# [shard-0] EXECUTED 5x bundles
```

### 4.2 Watch receipts

```bash
ls -lt receipts/shard-*
ls -lt receipts/fee-collector-*
```

### 4.3 Watch positions

```bash
npx tsx src/scripts/treasury-snapshot.ts
```

### 4.4 Watch HOP fee epoch

```bash
npx tsx src/scripts/epoch-watcher-loop.ts
```

---

## 5. Emergency Stop

```bash
# Kill orchestrator
pkill -f shard-orchestrator

# Or graceful Ctrl+C on the orchestrator terminal
```

Individual shards are stateless — killing the orchestrator stops all bundles immediately. No positions are left open because every bundle is a single atomic TX.

---

## 6. Economic Parameters

| Parameter | Pre-978 | Post-978 |
|---|---|---|
| HOP T22 fee | 690 bps | 1 bps |
| Flywheel LP fee | 0.3% per swap | 0.3% per swap |
| Flash size (flywheel) | $300 USDC | $300–1000 USDC |
| Flash size (deep-vol) | $10k USDC | $10k USDC |
| Jito tip | 10k–20k lamports | 10k lamports |
| Breakeven | ~$0.50/bundle | ~$0.02/bundle |

---

## 7. Files Reference

| File | Purpose |
|---|---|
| `src/scripts/flywheel-bot.ts` | Main flash-loop engine (Whirlpool) |
| `src/scripts/flash-deep-vol.ts` | Raydium CPMM deep-liquidity loop |
| `src/scripts/shard-orchestrator.ts` | Multi-crank supervisor |
| `src/scripts/fee-collector.ts` | Protocol + LP + T22 fee harvester |
| `src/scripts/bootstrap-shards.ts` | On-chain setup for shards |
| `src/scripts/init-shards.ts` | Keypair generation for shards |
| `src/scripts/preflight.ts` | Economic gate / readiness check |
| `src/scripts/treasury-snapshot.ts` | Position value + balances |
| `src/utils/shard.ts` | Shard identity resolver |

---

*Generated: 2026-05-26. Update this file if any parameter or script changes.*
