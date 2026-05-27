# M0 — Measurements Summary

> Date: 2026-05-27
> Epoch: 977 (pre-978, HOP T22 fee = 690 bps)
> Pool: 8aoWgf7ycbeKv6BTFCdUj4JR7Y4mXWuPZWEUhmuzN5ZL (OWN Whirlpool USDC/HOP)

---

## M1 — Flywheel-Bot Dry-Runs (FLASH sweep)

| FLASH_USDC | Sim CU | Cash Net USDC | Protocol Fee/bundle | LP Fee USDC | Fee Efficiency (bps) | Verdict |
|---|---|---|---|---|---|---|
| 100 | 335,691 | −6.132745 | 0.000900 | 0.052961 | 0.0900 | CASH_PROOF_FAILED |
| 200 | 331,186 | −11.030709 | 0.001800 | 0.100849 | 0.0900 | CASH_PROOF_FAILED |
| 300 | 329,585 | −15.034808 | 0.002700 | 0.145126 | 0.0900 | CASH_PROOF_FAILED |
| 360 | 332,317 | −16.108346 | 0.002972 | 0.157992 | 0.0826 | CASH_PROOF_FAILED |

**Notes:**
- All runs blocked pre-978 by 690 bps HOP T22 fee.
- Fee efficiency = `protocolFeeUsdcPerBundle / flashUsdc * 10,000`.
- Mean CU ≈ 332k < 400k limit.
- Break-even flash at current liquidity: ~$222 USDC.

---

## M2 — Dry-Run Loop Performance (20 iterations)

| Metric | Value |
|---|---|
| Iterations | 20 |
| Mean latency | 3,147.6 ms |
| Median (p50) | 3,056 ms |
| p95 latency | 4,989 ms |
| Min / Max | 2,879 / 4,989 ms |
| Effective TPS | **0.32 tx/s** |

**Notes:**
- Interval between iterations: 5 s.
- One outlier at 4,989 ms (likely RPC variance).
- Extrapolated 30-min throughput: ~576 dry-run simulations.

---

## M3 — Auto-Compound TX Size Audit

| Variant | IX Count | Serialized Size | Signers | Verdict |
|---|---|---|---|---|
| Base (collect_proto + collect_lp + increase_liq) | 7 | **924 b** | crank + withdrawAuth | FITS_LEGACY |
| Extended (+ harvest + withdraw + swap_v2) | 10 | **1,031 b** | crank + withdrawAuth | FITS_LEGACY |

**Notes:**
- Legacy TX limit: 1,232 b.
- Extended variant leaves **201 b headroom** for Jito tip or additional memo.
- No ALT required for either variant.

---

## TASK 2 — Flash-Deep-Vol Round-Trip Fix

**Root cause:** `removeLiquidity` was burning `lpMintMin` (slippage-discounted) instead of `lpMintRaw`, leaving unburned LP and recovering fewer tokens.

**Fixes applied:**
1. Withdraw now burns `lpMintRaw` (exact LP minted in deposit).
2. `minAmountAOut/minAmountBOut` computed from **post-deposit** reserves (not pre-deposit).
3. Added crank HOP balance check before TX build — warns if insufficient for `addLiquidity`.
4. Added round-trip USDC delta projection — shows expected surplus/deficit before simulation.

**Working capital required:**
- HOP: `addLiqHopRaw` (depends on `ADDLIQ_USDC` and pool ratio).
- USDC buffer: if round-trip delta < 0, crank needs `−delta` as working capital to cover repay.

---

## TASK 3 — Auto-Compound T22 Harvest + HOP→USDC Swap

**New instructions added:**
- `[4.5]` `harvest_withheld_tokens_to_mint` (HOP T22 fees → mint)
- `[5.5]` `withdraw_withheld_tokens_from_mint` (mint → crank HOP ATA)
- `[6.5]` `swap_v2` HOP→USDC (optional, `SWAP_HOP_TO_USDC=true`)

**TX size impact:** 924 b → 1,031 b (+107 b). Still fits legacy limit.

**Note:** When `SWAP_HOP_TO_USDC=true`, `liquidityDelta` is recomputed USDC-only; the swap consumes all HOP fees before increase-liquidity. This is a heuristic — optimal split would require iterative rebalancing.

---

## TASK 4 — Post-Epoch-978 Simulation

**Command:**
```bash
FORCE_T22_BPS=1 PROJECTION_MODE=true FLASH_AMOUNT_USDC=300 \
  MIN_FLASH_AMOUNT_USDC=100 DRY_RUN=true \
  npx tsx src/scripts/flywheel-bot.ts
```

**Receipt:** `receipts/flywheel-post978-sim.json`

| Metric | Value |
|---|---|
| t22Bps | 1 (forced) |
| cashNetUsdc | **+0.148106** |
| cashProofPass | **true** |
| Sim CU | 329,133 |
| Verdict | SIM_OK |

**Caveat:** `PROJECTION_MODE=true` excludes `walletUsdcDeltaBeforeCollect` (slippage) from cashNet, representing the fee-engine economics under ideal liquidity. With current pool liquidity, actual wallet delta is ≈−0.175 USDC for a $300 flash, making the bundle slightly unprofitable until liquidity deepens or flash size drops.

**Conclusion:** Post-978, the HOP T22 fee drag disappears. The remaining bottleneck is pool liquidity / slippage, not protocol fees.

---

## Next Steps

1. **Bootstrap shards** (`bootstrap-shards.ts`) when ready to scale.
2. **Deepen pool liquidity** — auto-compound will raise `maxFlashUsdcInCurrentRange` organically.
3. **Monitor epoch 978** — when `solana epoch >= 978`, run live with `FORCE_T22_BPS` removed.
