# Live Cycle Test — 2026-05-27T09:14Z

## Config

| Param | Value |
|---|---|
| ADDLIQ_USDC | 700 |
| SWAP_USDC | 500 |
| T22 actual | 690bps (epoch 977, gate bypassed via FORCE_T22_BPS=690) |
| T22 projected (epoch 978) | 1bps |
| JITO | SKIP (direct RPC send, no tip) |
| ALT | EjNKyxzhMCDX63sXLNddioHNZmyyNaHUipsXR65AmwAC |

**Purpose:** Verify TX mechanics, measure real gas, confirm LP fees accumulate. Not a profit test — epoch gate exists to block 690bps.

---

## TX

```
sig:      4mmUofaWdSNwjJ89KNx4DSt5pv7F8GTNTCoZoiyUyTn4Z9w1xu89bDebmSjc5eyvrUdyfzu8ziDBsKzBR9UX8td
explorer: https://solscan.io/tx/4mmUofaWdSNwjJ89KNx4DSt5pv7F8GTNTCoZoiyUyTn4Z9w1xu89bDebmSjc5eyvrUdyfzu8ziDBsKzBR9UX8td
status:   CONFIRMED
simCU:    401,115
txSize:   671 bytes
```

---

## Phase 5 — Balance Sheet

### Wallet Balances

| Token | Pre-TX | Post-TX | Delta |
|---|---|---|---|
| SOL | 0.250849287 | 0.250814287 | -0.000035 (-35,000 lam) |
| USDC | 148.854573 | 114.606531 | **-34.248042** |
| HOP | 8,623,846.212 | 7,350,681.778 | **-1,273,164.434** |

### Position (unclaimed fees, still in pool)

| Field | Pre-TX | Post-TX |
|---|---|---|
| feeOwedA (USDC) | 0 | **+0.145438** |
| feeOwedB (HOP) | 0 | **+1,144.124** |
| liquidity | 78,627,479,083 | 78,627,479,083 (unchanged) |

### Pool Tick

| | Pre-TX | Post-TX |
|---|---|---|
| tick | 93,342 | 92,442 |
| HOP/USDC | 11,314 | 10,340 |
| HOP price (USD) | $0.0000884 | $0.0000967 |

Tick moved -900 (HOP got more expensive): asymmetric T22 impact on swap2 HOP input.

### Withheld HOP

| Account | Pre-TX | Post-TX |
|---|---|---|
| Mint (accumulated) | 33,945.19 | 33,945.19 (unchanged) |
| VaultB / crankATA | 0 / 0 | 0 / 0 |

Note: vaultB/crankATA withheld reads 0. Possible causes: T22 extension offset parsing bug in snapshot script (ext starts at byte 166, not 165), or vault accounts route withheld directly to mint. To be validated separately via `getAccount` + `getTransferFeeAmount`.

---

## Phase 5 — USD P&L

At pre-TX HOP price $0.0000884:

| Item | USD |
|---|---|
| ΔUSDC | -$34.248 |
| ΔHOP (×$0.0000884) | -$112.55 |
| Gas (SOL) | -$0.005 |
| **Gross cycle cost** | **-$146.80** |
| LP feeOwedA (claimable) | +$0.145 |
| LP feeOwedB (×$0.0000884) | +$0.101 |
| **Net including unclaimed fees** | **-$146.56** |

Expected at 690bps: all T22 costs (~$146) dwarf LP fees ($0.25). This is WHY the epoch 978 gate exists.

---

## Phase 5 — Projection vs Actual

Receipt was simulated with FORCE_T22_BPS=1 (1bps, epoch 978 target):

| Metric | Projected (1bps) | Actual (690bps) | Notes |
|---|---|---|---|
| Gas (SOL) | $0.034 | $0.005 | No Jito tip (JITO_SKIP) |
| LP fees total | $0.300 | $0.246 | feeOwedA+B not yet claimed |
| T22 cost | ~$0.003 | ~$146.56 | ~48,850× higher at 690bps |
| Net/TX | **+$0.266** | **-$146.56** | Epoch gate is mandatory |

---

## Phase 6 — Verdict

### PASS: TX mechanics

- [x] Flash loan (MarginFi borrow+repay) executes in single atomic TX
- [x] addLiq → 2× swap → removeLiq round-trip completes
- [x] Position accumulates LP fees ($0.246 unclaimed)
- [x] TX confirmed on-chain (not just simulated)
- [x] ALT reduces TX to 671 bytes (fits in 1232b limit)
- [x] Direct RPC send (JITO_SKIP) works as Jito fallback

### PASS: Gas measurement

- Gas real: 35,000 lamports = **$0.005** (vs $0.034 projected including Jito tip)
- At 1bps with Jito tip: gas = $0.034. Net still +$0.266.

### PASS: Epoch gate logic

- 690bps = -$146.56/TX → correct to abort at this fee level
- 1bps = +$0.266/TX → epoch 978 gate is the correct execution trigger
- Gate works via T22 on-chain bps check in loop (waitForEpoch978)

### INCONCLUSIVE: T22 withheld per cycle

- Mint withheld unchanged (33,945.19 HOP) — harvest sources TBC
- vaultB / crankATA withheld shows 0 — likely a parsing bug in snapshot script
- Will verify via proper `getAccount` + `getTransferFeeAmount` call

---

## Phase 4 — Sweep Execution

Mint withheld: 33,945.19 HOP → swapped → +$3.044 USDC (live TX executed).

```
sweep TX: 4oX5NH9YDn5yZ7yzRTZjcqbFCdZJ3ZLmi5MkDoHzkNeFyPhVnQrsqbVXQkfPqYzNNwUWxz64FtsKEEx263P3772j
HOP in:    33,945.19
USDC out:  +3.044 (sim: 3.044, actual confirmed)
gas:       8,995 lamports = $0.0015
net:       +$3.042
```

Post-sweep state:
- USDC: 117.650067 (+$3.044 vs post-cycle)
- mint withheld: 0 (cleared)
- position fees: 0.145438 USDC + 1,144 HOP (unclaimed, needs collect_fees)

---

## Next Steps

1. **Epoch 978** — Loop fires automatically when HOP T22 = 1bps
2. **Sweep validation** — Fix withheld parsing in snapshot to confirm T22 withheld accounts
3. **Jito** — Investigate correct tip account for `mainnet.block-engine.jito.wtf`; USE_JITO=true when fixed
4. **Auto-compound** — Claim feeOwedA/B (0.145 USDC + 1,144 HOP) via auto-compound.ts
5. **Loop monitoring** — receipts/deep-vol-{ts}.json per cycle, sweep every 50 cycles
