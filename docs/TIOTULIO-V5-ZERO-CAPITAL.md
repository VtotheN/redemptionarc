# TIOTULIO V5 Zero-Capital Gate

This module maps `/Users/velon/Desktop/VELON-PRESENTACION.html` into a no-send
engineering gate for phase 5:

```text
multi-flash borrow
-> flash-funded GHOST-LP
-> PHANTOM-LITE scale from 4 to 8 hops
-> fee extraction to PHANTOM-TREASURY
-> remove LP / venue death
-> repay flash
-> cash proof in wallet-controlled SOL/USDC
```

The important correction is that v5 is not the previous persistent-fork loop.
The old core proved mechanics, but it still depended on owned pool inventory or
HOP conversion. V5 must prove that Velon contributes zero principal and that the
fee output is spendable SOL/USDC after all bundle costs.

## Command

```bash
npm run tiotulio-v5-sim
```

Receipt:

```text
receipts/TIOTULIO-V5-ZERO-CAPITAL-SIM-LATEST.json
```

Default deck-calibrated inputs:

```text
TIOTULIO_FLASH_USD=200000
TIOTULIO_START_HOPS=4
TIOTULIO_TARGET_HOPS=8
TIOTULIO_EFFECTIVE_FEE_BPS=10
TIOTULIO_PROTOCOL_SPLIT_BPS=5000
TIOTULIO_CYCLES_PER_DAY=96
TIOTULIO_MIN_DAILY_USD=10000
```

The 10 bps default is the effective fee rate that matches the presentation's
`$350-450` per-cycle range at 4 hops and `$200k` flash size. If the active token
fee or protocol split changes, override the env values and keep the receipt.

## Gates

`zeroCapitalGate` passes only when:

```text
GHOST-LP source = flash
gas payer != Velon
deploy payer != Velon
seed liquidity = 0
Velon signer is not required
```

`modelGate` passes only when:

```text
phase-5 net per cycle > 0
daily net >= MILLIONS-GATE
zero-capital gate passes
fee sink ownership is confirmed
```

`cashProofGate` remains blocked until:

```text
SETTLEMENT_CONFIRMED=true
EXACT_TX_RECEIPT_CONFIRMED=true
```

That is intentional. A model pass is not a live-send approval. The next build is
the exact TX0/TX1/TX2 no-send receipt that proves the same invariant with real
accounts and instructions.
