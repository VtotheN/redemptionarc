# redemptionarc — Complete System Reference

> Last updated: 2026-05-28. Single source of truth for new Claude sessions.

---

## What This Is

redemptionarc is a closed-loop flywheel on Solana mainnet. It extracts USDC from market movement across two layers:

- **Layer 1 (live):** Token-2022 transfer fee extraction via a private CLMM pool. Every HOP transfer withholds 0.01% (1bps). Volume is manufactured internally via atomic flash-loan cycles. Withheld fees accumulate and are swept to treasury.
- **Layer 2 (building):** ENCHANCEDBLOCK arbs an external real Orca pool → earns real USDC → CSDM flash-lends that USDC → closes the settlement loop without circular capital.

The USDC-only metric (wallet_usdc + vault_usdc) stays flat on Layer 1 alone because HOP is sold back into the same pool. ENCHANCEDBLOCK is the only external USDC inflow path.

---

## Architecture Diagram

```
┌─────────────────────────────────────────────────────────────────────┐
│  LAYER 1: T22 Ring (running now)                                    │
│                                                                     │
│  MarginFi flash borrow USDC                                         │
│       ↓                                                             │
│  addLiquidity($700 USDC) → private CLMM pool                       │
│       ↓                                                             │
│  RT_COUNT × (USDC→HOP swap, HOP→USDC swap)                        │
│       ← each HOP transfer withholds 1bps T22 fee                   │
│       ↓                                                             │
│  removeLiquidity → repay MarginFi flash                             │
│       ↓                                                             │
│  every 50 cycles: harvest withheld HOP → swap → USDC in crank     │
│                                                                     │
└─────────────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────────────┐
│  LAYER 2: Settlement (building)                                     │
│                                                                     │
│  ENCHANCEDBLOCK arbs external Orca SOL/USDC pool (real edge)       │
│       ↓                                                             │
│  ENCHANCEDBLOCK USDC vault grows                                    │
│       ↓                                                             │
│  CSDM ix_flash_lend_backing (IX 7)                                 │
│       → ENCHANCEDBLOCK CPIs CSDM                                   │
│       → CSDM lends USDC to settlement session                      │
│       → HOP treasury redeems: HOP → USDC at pool price             │
│       → repay CSDM + delta                                         │
│       ↓                                                             │
│  Net: real external USDC flows into crank wallet                   │
│                                                                     │
└─────────────────────────────────────────────────────────────────────┘
```

---

## Module 1: HOP Token-2022 (T22 Ring)

HOP is the flywheel token. It is a Token-2022 mint with a transfer fee extension.

| Property | Value |
|---|---|
| HOP Mint | `HZF5k7h39hkysoSZ4ZfmWc55PhvW7ntVvVqdXFCyYGh3` |
| Token program | Token-2022 (`TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb`) |
| Transfer fee | 1bps (0.01%) — active since epoch 978 |
| Fee authority | `8pWEfpJas2tgS8iE7ZyHKNjeDSEixqSwK12W4tagNJ3S` (crank) |
| Withdraw authority | same as fee authority |

Every time HOP moves (swap, transfer), 1bps is withheld into the token account's withheld balance. This is the primary revenue mechanism.

**Ring wallets:** 4 wallets (A→B→C→D→A). Crank controls all 4. The ring exists to maximize the number of HOP transfers per atomic TX — each swap generates a transfer in and a transfer out, each withheld.

**Harvest flow:**
1. `harvestWithheldTokensToMint` — pulls withheld amounts from ring ATAs into the mint
2. `withdrawWithheldTokensFromMint` — moves from mint to treasury
3. Treasury: `BGM3VPeND4xts3J6WeaeRJVFpzAJhyJiqycqYP2vk6dV`

**Revenue per cycle (sim):** ~5,017 HOP withheld at ADDLIQ=700, SWAP=500, RT=5. At pool price, ~$0.43/cycle.

---

## Module 2: MarginFi Flash Loan (atomic wrapper)

MarginFi is used as the flash loan provider. Purpose: atomically borrow USDC at TX start, do the add/swap/remove sequence, repay at TX end. Fee is 0bps.

| Property | Value |
|---|---|
| MarginFi program | `MFv2hWf31Z9kbCa1snEPYctwafyhdvnV7FZnsebVacA` |
| MarginFi group | `4qp6Fx6tnZkY5Wropq9wUYgtFxXKwE6viZxFHg3rdAG8` |
| USDC bank | `2s37akK2eyBbp8DZgCm7RtsaEz8eJP3Nxd4urLHQv7yB` |
| MarginFi account | `9SdjygeTAmMrgCQjBAGNAAjjYE6U35ARWcuvvxFZJHz` |
| USDC liquidity vault | `7jaiZR5Sk8hdYN9MxTpczTcwbWpb5WEoxSANuUwveuat` |
| Vault available | $559k USDC |
| Flash fee | 0bps (free) |

**Important:** MarginFi here is NOT a leverage mechanism. It is purely an atomicity wrapper. The flash amount covers addLiq + swaps. It is repaid in the same TX. The USDC comes back from removeLiq.

**TX structure (N = RT_COUNT):**
```
[0]       ComputeUnitLimit
[1]       ComputeUnitPrice
[2]       startFlashLoan(endIndex = 7 + 2*N)
[3]       lendingAccountBorrow
[4]       increase_liquidity_v2
[5..4+2N] N × (swap_v2 USDC→HOP, swap_v2 HOP→USDC)
[5+2N]    decrease_liquidity_v2
[6+2N]    lendingAccountRepay
[7+2N]    endFlashLoan
```

---

## Module 3: Private CLMM Pool (Whirlpool fork)

This is a custom-forked Orca Whirlpool deployed under a private program ID. Zero external traders. Crank controls both LP position and swaps.

| Property | Value |
|---|---|
| Whirlpool program (fork) | `GxRHMB9a6XE8BqGPeNb9UkJUPvbvrPoPgNTJPJJA4n8h` |
| Pool (USDC/HOP) | `8aoWgf7ycbeKv6BTFCdUj4JR7Y4mXWuPZWEUhmuzN5ZL` |
| USDC vault (token A) | `4QD4GgnjRvjETqWLT5e3x7SHtJSzs9kShUPLfyHcTu7d` |
| HOP vault (token B) | `Qv51R47g7pMDxa3UofXaz8cNr8pwRSXaNufgnEWX8Yk` |
| Oracle | `5qhXANMqTNNzdp1N1PrMzWzSzjHTZxuLPELcmpog6bp5` |
| Position | `ErgQU48egJMNBLZeVkdjrtZrSWUQJCky3deh2B4U1YPQ` |
| Position token account | `GgLpt3VY9vWKLnNa5Dj3FKvBn3JEDL4KTKpabCAfL54Q` |
| tick_spacing | 64 |
| Position range | [84480, 101312] |
| Center tick | 92520 |
| posLiq | 122.8B (after 50% decrease, OPTION D 2026-05-27) |

**Price convention:** token A = USDC, token B = HOP. `aToB=true` means USDC→HOP (tick moves DOWN). `aToB=false` means HOP→USDC (tick moves UP).

**Tick arrays:**

| Array | Start tick | Address |
|---|---|---|
| TICK_ARRAY_84480 | 84480 | `be9QKj4mYB8erh6r4ZDrKxxSvSYSUNRfpTxqJUgd3jG` |
| TICK_ARRAY_90112 | 90112 | `CDMSB5e6WUgtoSLrybvYm4j58Jue3eqpzHQVLmgVkAe4` |
| TICK_ARRAY_95744 | 95744 | `MXd8HXPjcH9ZCuyr4uKKyN7GkJ5YizZQkgUndB6J8Gz` |
| TICK_ARRAY_101376 | 101376 | `2dQq4vUnzfCmmdex9ikKjF7Z7XifVsbVzoTs7d7ogaEx` |
| TICK_ARRAY_107008 | 107008 | `2BjLGkGEvB5umQjgesM5F48NGg8JVN1yHta8YZcMYann` |

**Address Lookup Table (ALT):** `EjNKyxzhMCDX63sXLNddioHNZmyyNaHUipsXR65AmwAC`

**KPX9 config accounts** (Whirlpool config PDAs for the fork):

| Account | Address |
|---|---|
| WhirlpoolsConfig | `KPX9QQP4GLWiRkh4pGpkagwoPGaGixarRQs1LQKb9dt` |
| ConfigExtension | `GgGRBg8kKd4h5KZcDSLMnHL84g3cEdJRaAfRmushev6A` |
| FeeTier | `6AEKZMiH6vKHQGqxAXLZWQJTQQRmyYZXk9az8nJmbmdU` |

---

## Module 4: Loop Engine

**Files:**
- `src/scripts/flash-deep-vol-orca-loop-v2.ts` — orchestrator loop (phase-wait + cycle + extract + sweep + auto-rebalance)
- `src/scripts/flash-deep-vol-orca-v2.ts` — single TX builder, exports `runCycle()`
- `src/scripts/auto-compound-extract.ts` — LP fee collect, exports `runExtract()`
- `src/scripts/redeem-hop-to-usdc.ts` — T22 withheld harvest + HOP→USDC swap, exports `runSweep()`

**Phase 1:** loop waits for HOP T22 fee = 1bps (polls every `EPOCH_POLL_MS`). Target: epoch 978.

**Phase 2:** main cycle loop.

**Cycle sequence:**
1. Read current tick (safety check: pause if tick outside 10% margin from range edges)
2. Auto-rebalance check (if tick outside `[REBALANCE_TICK_LOW, REBALANCE_TICK_HIGH]`)
3. `runCycle()` — builds and sends the flash TX
4. Log drift (tick before → tick after)
5. Every `EXTRACT_EVERY` cycles: `runExtract()` — collect LP fees to wallet
6. Every `SWEEP_EVERY` cycles: `runSweep()` — harvest T22 withheld → swap to USDC

**Drift:** each RT_COUNT=5 cycle drifts ~+4 ticks DOWN (structural bias because ALTERNATE_DIRECTION was disabled). Managed by AUTO_REBALANCE.

**Two-sim approach:** sim1 measures actual CU consumption, rebuilds TX with `ceil(CU × 1.1)`, sim2 confirms before send.

**Canonical launch command:**
```bash
RT_COUNT=5 ADDLIQ_USDC=700 SWAP_USDC=500 ALTERNATE_DIRECTION=false \
  JITO_SKIP=true DRY_RUN=false ALLOW_LIVE=true \
  AUTO_REBALANCE=true AUTO_REBALANCE_DRY_RUN=false \
  REBALANCE_TICK_HIGH=94000 REBALANCE_TICK_LOW=91040 \
  REBALANCE_AMOUNT_USDC=200 TICK_TARGET_HIGH=92520 TICK_TARGET_LOW=92520 \
  EXTRACT_EVERY=100 SWEEP_EVERY=50 LOOP_INTERVAL_MS=2000 \
  npx tsx src/scripts/flash-deep-vol-orca-loop-v2.ts >> logs/prod-corrected.log 2>&1
```

**VPS:** `89.167.71.153` (betterme-helsinki). Repo path: `/opt/redemptionarc/`. systemd auto-restart enabled.

**Critical ENV vars:**

| Var | Default | Purpose |
|---|---|---|
| `RT_COUNT` | 2 | Round-trips (swap pairs) per TX. Current: 3 |
| `ADDLIQ_USDC` | 700 | USDC added as liquidity per cycle |
| `SWAP_USDC` | 500 | USDC per swap leg |
| `ALTERNATE_DIRECTION` | false | If true, alternates aToB each cycle to cancel drift |
| `AUTO_REBALANCE` | false | Fires a rebalance swap if tick exits bounds |
| `REBALANCE_TICK_HIGH` | 96000 | Tick ceiling before DOWN rebalance |
| `REBALANCE_TICK_LOW` | 90000 | Tick floor before UP rebalance |
| `EXTRACT_EVERY` | 25 | Collect LP fees every N cycles |
| `SWEEP_EVERY` | 50 | Harvest T22 withheld every N cycles |
| `LOOP_INTERVAL_MS` | 3000 | Delay between cycles |
| `JITO_SKIP` | false | Skip Jito tip TX (gas only, no bundle) |
| `DRY_RUN` | true | Simulate only, no send |
| `ALLOW_LIVE` | false | Safety gate — must be true to send |

---

## Module 5: ENCHANCEDBLOCK (External Arb)

ENCHANCEDBLOCK arbs the real external Orca SOL/USDC 30bps pool. This is the only module that generates real external USDC inflow.

| Property | Value |
|---|---|
| Program ID | `61hviwfoDk6ygzJHJaDG2tsoWbBpUYWdNJnSSfRA1vPh` |
| Authority | `FVxMBHCMt3VHFR4XqaApJvuoUq3T7vCK8GCytnrQYnWD` |
| VPS | `37.27.214.225` (Helsinki) |
| USDC vault | `CYaPwtMHcQbbMiEggxpwLvzswqnXqzrsA2AxArrXCazb` (~$154 USDC as of 2026-05-28) |
| SOL vault | 0.752 SOL (needs 10 SOL for full operation) |
| External Orca pool arbed | `HJPjoWUrhoZzkNfRpHuieeFk9WcZWjwy6PBjZ81ngndJ` (SOL/USDC 30bps, real) |

**Edge formula:**
```
BAIT_BPS(60) - ORCA_FEE_BPS(30) - GAS_BPS(3) = 27bps net
```
Revenue target: ~$0.42/cycle at $150/SOL.

**Bootstrap requirement:** 10 SOL minimum in `sol_vault`. Currently 0.752 SOL → needs 9.25 more SOL before ENCHANCEDBLOCK operates at designed edge.

**CSDM integration:** ENCHANCEDBLOCK is the `allowed_borrower` in CSDM. This is configured on-chain. ENCHANCEDBLOCK CPIs CSDM's `ix_flash_lend_backing` to fund settlement sessions.

---

## Module 6: CSDM (CanSmelldaMoney — Flash Backing Vault)

CSDM is the bridge between ENCHANCEDBLOCK real USDC and HOP settlement. It holds USDC and lends it to ENCHANCEDBLOCK's settlement CPI.

| Property | Value |
|---|---|
| Program | `Q9FMc5YLqjJe96geFtg43ocfyrpJYM2WDHkQEqh8aNv` |
| Receipt mint | `DHYv1GnjJuJnvKggmncifHXByhnJqk5am7aLGwfW2NSz` |
| Pool PDA (session vault) | `BSHxRLtdgndvUWdKSH4rkeA1j1iS3TzLMgX25VeDQdCQ` |
| Allowed borrower | `61hviwfoDk6ygzJHJaDG2tsoWbBpUYWdNJnSSfRA1vPh` (ENCHANCEDBLOCK — CONFIGURED ON-CHAIN) |

**Key instruction:** `ix_flash_lend_backing` (IX 7)
- Lends real USDC from pool to calling program
- Enforces invariant: `pool_account.amount >= backing_pre_release + min_repay_delta`
- Repayment with delta enforced atomically

Built on Pinocchio (ultra-low compute units). No Anchor overhead.

**Current state:** deployed and configured. Waiting for ENCHANCEDBLOCK to accumulate USDC.

---

## Module 7: atom_ickk (Multi-Slot Capital Window)

atom_ickk extends flash loan atomicity across multiple slots — needed when settlement can't fit in a single TX.

| Property | Value |
|---|---|
| Program ID | `BxJMJLxXJhKvuhvvxY57wYY69CAs9RCQWBv9JPCtm9Kx` |
| Status | CLOSED — programdata removed. Account exists, executable=true, bytecode gone. |
| Source | `/Users/velon/Desktop/atom_ickk/target/deploy/` |
| Keypair | `/Users/velon/Desktop/atom_ickk/target/deploy/` (existing, use for redeploy) |

**To redeploy:** `solana program deploy --program-id <keypair_path> <so_file>` using the existing keypair. This preserves the program ID.

**Note:** atom_ickk is NOT required for initial settlement. CSDM alone can do the flash backing without it. atom_ickk becomes relevant if settlement needs to span more than one slot.

---

## Settlement Flow (Full L2 Path)

```
Step 1: T22 loop runs → HOP withheld in ring ATAs → swept to treasury
        Treasury: BGM3VPeND4xts3J6WeaeRJVFpzAJhyJiqycqYP2vk6dV

Step 2: ENCHANCEDBLOCK arbs external Orca (real SOL/USDC pool)
        → earns USDC
        → deposits to ENCHANCEDBLOCK USDC vault: CYaPwtMHcQbbMiEggxpwLvzswqnXqzrsA2AxArrXCazb

Step 3: Settlement TX — ENCHANCEDBLOCK CPIs CSDM ix_flash_lend_backing (IX 7)
        → CSDM lends USDC from BSHxRLtdgndvUWdKSH4rkeA1j1iS3TzLMgX25VeDQdCQ
        → HOP treasury redeems: HOP → USDC at pool price
        → Repay CSDM pool + delta (enforced by invariant)

Step 4: Net result — HOP withheld (T22 fees) → real USDC in crank wallet
        Real USDC source = external Orca arb profit, NOT circular swap
```

---

## Economics

### Layer 1 (T22 loop, running)

| Metric | Value |
|---|---|
| cashNet/cycle (sim) | $0.45 |
| drift cost/cycle | ~$0.30 (4.3 ticks × $0.069/tick amortized) |
| gas/cycle | ~$0.031 |
| **NET/cycle** | **~$0.12** |
| Rate (VPS) | 17.5 cycles/min |
| **NET/hr** | **~$126** |

### Layer 2 (ENCHANCEDBLOCK, at full 10 SOL)

| Metric | Value |
|---|---|
| Edge/cycle | 27bps net |
| Cycle value | ~$0.42 at $150/SOL |
| **NET/hr** | **~$152 (at 6 cycles/min)** |

### Combined

| Metric | Value |
|---|---|
| Combined target | ~$278/hr → $6,672/day |
| From $2,400 current → $10k | ~50 hours at combined rate |

---

## USDC-Only Metric Explained

**Definition:** `wallet_usdc + vault_usdc` (exact, no price assumptions, no HOP valued).

**Baseline (2026-05-28):** $816.21 — flat throughout 1200+ loops.

**Why it's flat on L1 alone:**
- Each cycle: borrow USDC → add liq → swaps → remove liq → repay
- LP fees are circular: we pay ourselves as LP + trader
- Sweeps just move USDC: vault DOWN, wallet UP → net = zero
- HOP sold back to own vault = no real USDC inflow

**ENCHANCEDBLOCK is the only external USDC source.** When it's funded and running, USDC-only metric will grow.

---

## Key Addresses Summary

```
# Crank / Authority
Crank wallet:            8pWEfpJas2tgS8iE7ZyHKNjeDSEixqSwK12W4tagNJ3S
Treasury:                BGM3VPeND4xts3J6WeaeRJVFpzAJhyJiqycqYP2vk6dV

# Mints
HOP mint (Token-2022):   HZF5k7h39hkysoSZ4ZfmWc55PhvW7ntVvVqdXFCyYGh3
USDC mint:               EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v

# Private CLMM Pool
Whirlpool program (fork): GxRHMB9a6XE8BqGPeNb9UkJUPvbvrPoPgNTJPJJA4n8h
Pool (USDC/HOP):         8aoWgf7ycbeKv6BTFCdUj4JR7Y4mXWuPZWEUhmuzN5ZL
USDC vault (token A):    4QD4GgnjRvjETqWLT5e3x7SHtJSzs9kShUPLfyHcTu7d
HOP vault (token B):     Qv51R47g7pMDxa3UofXaz8cNr8pwRSXaNufgnEWX8Yk
Position:                ErgQU48egJMNBLZeVkdjrtZrSWUQJCky3deh2B4U1YPQ
Position TA:             GgLpt3VY9vWKLnNa5Dj3FKvBn3JEDL4KTKpabCAfL54Q
Oracle:                  5qhXANMqTNNzdp1N1PrMzWzSzjHTZxuLPELcmpog6bp5
ALT:                     EjNKyxzhMCDX63sXLNddioHNZmyyNaHUipsXR65AmwAC

# Tick Arrays
TA 84480:                be9QKj4mYB8erh6r4ZDrKxxSvSYSUNRfpTxqJUgd3jG
TA 90112:                CDMSB5e6WUgtoSLrybvYm4j58Jue3eqpzHQVLmgVkAe4
TA 95744:                MXd8HXPjcH9ZCuyr4uKKyN7GkJ5YizZQkgUndB6J8Gz
TA 101376:               2dQq4vUnzfCmmdex9ikKjF7Z7XifVsbVzoTs7d7ogaEx
TA 107008:               2BjLGkGEvB5umQjgesM5F48NGg8JVN1yHta8YZcMYann

# Whirlpool Config (KPX9 fork)
WhirlpoolsConfig:        KPX9QQP4GLWiRkh4pGpkagwoPGaGixarRQs1LQKb9dt
ConfigExtension:         GgGRBg8kKd4h5KZcDSLMnHL84g3cEdJRaAfRmushev6A
FeeTier:                 6AEKZMiH6vKHQGqxAXLZWQJTQQRmyYZXk9az8nJmbmdU

# MarginFi Flash
MarginFi program:        MFv2hWf31Z9kbCa1snEPYctwafyhdvnV7FZnsebVacA
MarginFi group:          4qp6Fx6tnZkY5Wropq9wUYgtFxXKwE6viZxFHg3rdAG8
USDC bank:               2s37akK2eyBbp8DZgCm7RtsaEz8eJP3Nxd4urLHQv7yB
MarginFi account:        9SdjygeTAmMrgCQjBAGNAAjjYE6U35ARWcuvvxFZJHz
USDC liquidity vault:    7jaiZR5Sk8hdYN9MxTpczTcwbWpb5WEoxSANuUwveuat

# ENCHANCEDBLOCK
Program:                 61hviwfoDk6ygzJHJaDG2tsoWbBpUYWdNJnSSfRA1vPh
Authority:               FVxMBHCMt3VHFR4XqaApJvuoUq3T7vCK8GCytnrQYnWD
USDC vault:              CYaPwtMHcQbbMiEggxpwLvzswqnXqzrsA2AxArrXCazb
External Orca pool:      HJPjoWUrhoZzkNfRpHuieeFk9WcZWjwy6PBjZ81ngndJ

# CSDM
Program:                 Q9FMc5YLqjJe96geFtg43ocfyrpJYM2WDHkQEqh8aNv
Receipt mint:            DHYv1GnjJuJnvKggmncifHXByhnJqk5am7aLGwfW2NSz
Pool PDA (session vault): BSHxRLtdgndvUWdKSH4rkeA1j1iS3TzLMgX25VeDQdCQ

# atom_ickk (CLOSED — needs redeploy)
Program ID:              BxJMJLxXJhKvuhvvxY57wYY69CAs9RCQWBv9JPCtm9Kx
Source path:             /Users/velon/Desktop/atom_ickk/target/deploy/

# Forbidden wallets (never use as crank)
FvkP2XzbCK6PspjhZ44sae5vbQPZQGmVkCv1dUC2pAZ9
FdpruPJgPzyNefSxkU5JqifteeDPqwZPfBzcmNb7NNxY
FVxMBHVbyPqqo6ANaY4RM1h7JBJaRHuPTF9XehwaWztp
7Wg8aXuPijrmH4svDmqArMeMAWF3ZusgrznJ6ymprBAN
```

---

## Blockers (as of 2026-05-28)

| Component | Status | Blocker |
|---|---|---|
| T22 loop | RUNNING (PID varies, VPS systemd) | None |
| ENCHANCEDBLOCK | LIVE but edge = 0 | Needs 9.25 more SOL (has 0.752/10 required) |
| CSDM backing | DEPLOYED + configured | Waiting for ENCHANCEDBLOCK USDC to accumulate |
| atom_ickk | CLOSED | Needs redeploy from `/Users/velon/Desktop/atom_ickk/target/deploy/` |
| Settlement (full L2) | BLOCKED | ENCHANCEDBLOCK not funded |

---

## Security Rules

- `keys/` is gitignored. Never commit anything from `keys/`.
- Crank keypair: `keys/crank.json`. Never display contents or commit.
- VPS credentials: `keys/vps-password.txt` (chmod 600). Never display.
- Never run loop on Mac AND VPS simultaneously — same wallet = nonce conflict → TX failures.
- Never use the forbidden wallets above as crank (listed in `src/constants.ts`).

---

## Repo Structure (key files only)

```
src/
  constants.ts                         — all program IDs and mint addresses
  config.ts                            — ENV loader, RedemptionConfig type
  scripts/
    flash-deep-vol-orca-loop-v2.ts     — main loop orchestrator (START HERE)
    flash-deep-vol-orca-v2.ts          — single TX builder, exports runCycle()
    auto-compound-extract.ts           — LP fee collect, exports runExtract()
    redeem-hop-to-usdc.ts              — T22 sweep, exports runSweep()
    check-balances.ts                  — quick balance snapshot
    check-vaults.ts                    — vault state check
    treasury-snapshot.ts               — treasury balance snapshot
    harvest-withheld.ts                — manual T22 harvest
    csdm-ix7-sim.ts                    — simulate CSDM IX 7 backing
  utils/
    keypair.ts                         — keypair loader
    marginfi.ts                        — MarginFi helpers
    orca-whirlpool.ts                  — Whirlpool helpers
    receipt.ts                         — TX receipt writer
keys/                                  — GITIGNORED. keypairs + VPS creds.
logs/
  prod-corrected.log                   — main loop output
  drift-calibration.log                — per-cycle tick drift (JSON lines)
  auto-rebalances.log                  — rebalance events (JSON lines)
receipts/                              — per-TX JSON receipts
docs/
  SYSTEM-COMPLETE.md                   — this file
```

---

## Quick Ops Reference

**Check current tick:**
```bash
npx tsx src/scripts/check-vaults.ts
```

**Check USDC-only balance:**
```bash
npx tsx src/scripts/check-balances.ts
```

**Manual T22 harvest (dry run):**
```bash
DRY_RUN=true npx tsx src/scripts/harvest-withheld.ts
```

**Treasury snapshot:**
```bash
npx tsx src/scripts/treasury-snapshot.ts
```

**Simulate CSDM IX 7:**
```bash
DRY_RUN=true npx tsx src/scripts/csdm-ix7-sim.ts
```

**Start loop locally (test, dry):**
```bash
RT_COUNT=3 ADDLIQ_USDC=700 SWAP_USDC=500 \
  DRY_RUN=true ALLOW_LIVE=false \
  npx tsx src/scripts/flash-deep-vol-orca-loop-v2.ts
```
