# Owned AMM Path — RedemptionArc V2

## Diagnosis (accepted 2026-05-22)

External AMM fees kill the loop. Every swap through Orca or Raydium leaks
protocol fees + LP fees to strangers. Self-routed flash volume through a pool
we don't own = zero net (we pay the fee, someone else collects it).

## The Fix (confirmed by not stacc live TX 2026-05-22)

Own the fee sink. Two valid paths — both work atomically in one legacy TX:

### Path A — T22 Ring + MarginFi Flash (PROVEN)

TX: `2jgoM1pFSH7FRqnLixMs3GAYrNQWDiJyMf1G284FTBWNjXqFy7MAV9cA1uyg4KDLw3dQsYN9xKvTimmRbscMGaLe`

```
MarginFi flash borrow (0 bps, legacy mode)
  └─> T22 ring: A→B→C→D→A (4 hops, each withholds transfer_fee_bps)
  └─> harvestWithheldTokensToMint
  └─> withdrawWithheldTokensFromMint → treasury
  └─> repay flash
  └─> net = withheld_fees_value - gas
```

**On-chain proof (not stacc wallet `WzMaL78s...`):**
- Bot running: 20 TXs in 20 seconds (1 TX/slot)
- Cost per TX: 25,800 lamports = **$0.004257**
- T22 token `DLYp3Fd5...`: 1 bps fee, u64::MAX cap, immutable mint
- Flash amount: $1 USDC (minimum to validate MarginFi flash wrapper)
- Legacy mode confirmed working

**Scale math (with valuable T22 token):**
```
volume_per_tx    = flash_size_usdc        (scales to $30M+ per TX)
fee_per_hop      = volume × 0.0001        (1 bps)
hops             = 4
total_fee_per_tx = volume × 0.0004
gas_per_tx       = $0.004257

breakeven_volume = $0.004257 / 0.0004 = $10.64 per TX

At $1M flash per TX:
  fee_collected  = $1,000,000 × 0.0004 = $400
  gas            = $0.004
  net            = $399.996

At $30M flash per TX:
  fee_collected  = $30,000,000 × 0.0004 = $12,000
  gas            = $0.004
  net            = $11,999.996
  cost_to_run    < $10 total gas
```

**The missing piece:** T22 withheld fees are in the T22 token, not USDC.
For net to be real USDC, either:
1. T22 token has real market value → harvest fees → sell
2. T22 token IS a USDC-pegged T22 wrapper (fee authority owns the peg)
3. T22/USDC owned AMM pool → sell harvested T22 into pool you own

### Path B — Owned Whirlpool Fork + MarginFi Flash

```
MarginFi flash (0 bps, legacy mode)
  └─> swap through OWNED Whirlpool fork
        ├─ balanced LP (small, centered) → samebot activation
        ├─ single-sided moonshot position (separate)
        └─ protocol fee vault = OUR treasury
  └─> repay flash
  └─> net = protocol_fee_usdc - gas
```

Per not stacc (17:16): "Add a balanced LP position (smaller, centered on current price)
just to enable samebot mechanics. The single-sided 'moonshot' position above stays
for the actual inventory. Accept that samebot can't manufacture volume in your current
pool setup — it'll only see external swaps moving price up into your range."

Two LP positions:
| Position | Type | Purpose |
|---|---|---|
| Balanced (small, centered) | Both sides | Samebot mechanics — triggers on price crossings |
| Single-sided (moonshot) | One side | Directional inventory accumulation |

## Combined Architecture (maximum capture)

```
Flash MarginFi $30M (0 bps, legacy)
  ├─ Branch A: T22 ring (4 hops) → harvest 1 bps × 4 = 4 bps → fee authority
  └─ Branch B: Swap through owned Whirlpool fork
                 → LP fees (100% ours, only LP)
                 → protocol fees (25.6% of LP fee, to our vault)
Repay flash
Net = T22_fees_value + whirlpool_LP_fees + whirlpool_protocol_fees - gas ($0.004)
```

## T22 Token Requirements

- transfer_fee_bps: 1–100 (1 bps proven working)
- maximum_fee: u64::MAX (no cap, scales with volume)
- withdraw_withheld_authority: treasury wallet
- transfer_fee_config_authority: can be None (immutable = harder to front-run)

Current T22 token `DLYp3Fd5SQSyY4o33NgPBicnTtBfZr5NBk6vAFv5E9En`:
- fee: 1 bps ✅
- max: u64::MAX ✅
- mintAuthority: None ✅
- Supply: 1B tokens ✅

## MarginFi Legacy Flash (DONE ✅)

- Verified working in legacy mode (not v0)
- Cost: 25,800 lamports = $0.004257
- Flash $1 USDC validated. Same gas for $30M flash.
- TX: `2jgoM1pFSH7FRqnLixMs3GAYrNQWDiJyMf1G284FTBWNjXqFy7MAV9cA1uyg4KDLw3dQsYN9xKvTimmRbscMGaLe`

## Implementation Phases

### Phase 0 — T22 Ring + MarginFi Legacy (PROVEN by not stacc) ✅
- Deploy T22 token (or reuse DLYp3Fd5)
- 4-wallet ring, each wallet = separate ATA
- harvestWithheldTokensToMint + withdrawWithheldTokensFromMint in same TX
- MarginFi flash wrapper for atomicity

### Phase 1 — Scale Flash Volume
- Replace $1 MarginFi flash with real flash size ($100k → $1M → $30M)
- MarginFi USDC bank capacity: check available borrow
- Same TX structure, just larger borrow amount

### Phase 2 — T22 Token Settlement
- Either: deploy own AMM (Whirlpool fork) for T22/USDC pair
- Or: give T22 token real market via Raydium/Orca with seed liquidity
- Fee authority sells harvested T22 → USDC = real cash

### Phase 3 — 50 Rings Parallel
- 50 independent T22 ring accounts
- 50 parallel bots, each 1 TX/slot
- At $1M flash per TX: 50 × 1 TX/slot × 400 slots/min = 20,000 TXs/min
- Fee captured: 20,000 × $400 = $8M/min (if T22 = USDC equivalent)

### Phase 4 — Owned Whirlpool Integration (Path B)
- Fork VtotheN/EXPERIMENTO-bhivepool
- Enable T22 pool config (custom config, confirmed by not stacc)
- Set protocol fee authority = treasury
- Balanced LP position for samebot mechanics

## Settlement Gap (the real blocker)

T22 fees are in T22 tokens. To realize as USDC:
- T22 token must have real price
- Jupiter must route T22→USDC (currently TOKEN_NOT_TRADABLE for HOP)
- Solution: own the T22/USDC pool (Path B) → settlement is internal, no external dependency

With owned T22/USDC pool:
```
harvest T22 fees → sell into own pool → USDC to treasury
pool IL absorbed by us (only LP)
net = fee_usdc - IL_usdc - gas
```
IL is zero if the pool never moves price (samebot keeps price stable).
