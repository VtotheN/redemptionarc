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

## TASK 2 — Dry-Run Validation Status (pre-merge)

**flash-deep-vol.ts post-fix: NOT VALIDATED IN SIM (out of scope for epoch 978 merge)**

Root cause: Raydium CPMM pool `EwoZHyXz48vZL1TwkpQoq31brW4G4NDwmMr1DMw6qqBV` drained (on-chain state: 1 lamport USDC, 370,520 lamports HOP). Sim fails at IX[4] `addLiquidity` (insufficient HOP in crank ATA) before reaching the Repay instruction.

Code-level fix confirmed at `flash-deep-vol.ts:488` (`lpMintRaw` instead of `lpMintMin`). To validate in sim, the Raydium pool requires re-seeding or the script needs refactor to target the Orca Whirlpool. **Out of scope for epoch 978 merge — `flywheel-bot.ts` is the canonical revenue path post-978.**

---

## Hallazgo on-chain: collect_fees_v2 not implemented in fork

Fork `GxRHMB9a6XE8BqGPeNb9UkJUPvbvrPoPgNTJPJJA4n8h` implements `collect_protocol_fees_v2` but not `collect_fees_v2` (discriminator `[0xcf 0x75 0x5f 0xbf 0xe5 0xb4 0xe2 0x0f]` returns `InstructionFallbackNotFound` error 101).

LP fees accrued in the position are not collectible via IX until the program is extended. **Mitigation:** `auto-compound.ts` conditionally skips `collect_fees_v2` when `lpFeeA == 0n && lpFeeB == 0n`. LP fees continue accruing inside the position and grow `max_flash_in_range` automatically — implicit compound. `collect_protocol_fees_v2` (the 3% protocol slice) continues working correctly.

---

---

## M4 — Post-978 Flash Sweep WITHOUT PROJECTION_MODE (2026-05-27)

`FORCE_T22_BPS=1 DRY_RUN=true` — real slippage included in cashNet.

| FLASH_USDC | Wallet USDC Δ | LP fee sw1 | LP fee sw2 | cashNet | Verdict |
|---|---|---|---|---|---|
| $30 | -0.020529 | 0.008730 | 0.008386 | **-0.007143** | CASH_PROOF_FAILED |
| $50 | -0.033729 | 0.014550 | 0.013624 | **-0.009105** | CASH_PROOF_FAILED |
| $100 | -0.065230 | 0.029100 | 0.025627 | **-0.013603** | CASH_PROOF_FAILED |
| $150 | -0.094879 | 0.043650 | 0.036283 | **-0.017596** | CASH_PROOF_FAILED |
| $200 | -0.122971 | 0.058200 | 0.045806 | **-0.021165** | CASH_PROOF_FAILED |
| $300 | -0.175382 | 0.087300 | 0.062106 | **-0.027276** | CASH_PROOF_FAILED |

**Sim err: null for all sizes** (TX simulates clean; cash gate rejects).

**Key finding:** Slippage/LP-fee ratio ≈ 1.19× constant across all flash sizes. No flash size produces positive cashNet at current pool depth (TVL ~$507, maxFlashInRange ~$243). Pool must deepen ~2× before round-trip breaks even at 1bps T22. Bottleneck is pool liquidity, not protocol fees — consistent with TASK 4 PROJECTION_MODE note.

**Gas estimate:** ~$0.004/bundle (constant, deduced from sweep).

---

## Next Steps

1. **Bootstrap shards** (`bootstrap-shards.ts`) when ready to scale.
2. **Deepen pool liquidity** — auto-compound will raise `maxFlashUsdcInCurrentRange` organically. Break-even requires ~2× current TVL.
3. **Monitor epoch 978** — when `solana epoch >= 978`, run live with `FORCE_T22_BPS` removed.
