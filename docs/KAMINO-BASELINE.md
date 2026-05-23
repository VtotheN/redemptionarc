# Kamino Baseline

This document preserves the exact Kamino configurations that produced
treasury-positive RedemptionArc cycles. They are not deleted or replaced by the
Marginfi/Pinocchio track.

## Hard Accounting

Loop success requires total-system cash:

```text
system_net = treasury_usdc_delta + crank_sol_delta * SOL_price
```

Treasury-only profit is useful evidence but not sufficient for the repeatable
RedemptionArc objective.

## Best Treasury-Positive Aggressive Profile

```bash
SOLANA_RPC_URL=https://api.mainnet-beta.solana.com \
DRY_RUN=false \
KEEPER_PAUSED=false \
FORCE_ENV_SOL_PRICE=true \
SOL_PRICE_USD=86.75 \
ROUTE_VOLUME_USDC=39 \
HOPS=2 \
AUTO_CALIBRATE=false \
TX2_CUSHION_EXTRA_USDC_MICRO=34681332 \
TX2_MIN_CUSHION_SOL_LAMPORTS=10000000 \
USE_JUPITER=true \
JUPITER_SLIPPAGE_BPS=100 \
TX2_CU_LIMIT=400000 \
TX2_CU_PRICE_MICRO_LAMPORTS=100 \
MIN_PROFIT_USD=-1 \
HOP_MINT=AKjuodXiTwwCVtZzrnGnYHYvZhEB3HH728JQrY7ovXDA \
CRANK_KEYPAIR_PATH=/Users/velon/Desktop/redemptionarc/keys/crank.json \
TREASURY_KEYPAIR_PATH=/Users/velon/Desktop/redemptionarc/keys/treasury.json \
WITHDRAW_AUTHORITY_PATH=/Users/velon/Desktop/redemptionarc/keys/withdraw-authority.json \
RING_KEYPAIR_PATHS=/Users/velon/Desktop/redemptionarc/keys/ring1.json,/Users/velon/Desktop/redemptionarc/keys/ring2.json \
LEDGER_MODE=total-system \
npm run cycle
```

Best observed cycle:

```text
receipt: receipts/REDEMPTION-LIVE-CYCLE-003.json
TX2: 43CTQaWcUqxeLLhkVaWDZDYYfPRQMPVpC1dRRe9MHwbEa4J3WMHCz7g1ed9F5RyEgb2SY2bgeAyeLsvST8tEEjT
TX3: 4XTPUT6WuMsdtqt5nLFgaQ7yvaVCPcf2DRMvU5dkoPuBz7h8QTt4LeyL8WvMRP27cA31jdipBEMvBG5AFxDTnpeV
treasury_usdc_delta: +34.712398
crank_sol_delta: -0.400319817
system_net_at_86.75: -0.015346 USD
```

## Best Near-Breakeven Micro Profile

```bash
SOL_PRICE_USD=86.75
ROUTE_VOLUME_USDC=39
HOPS=2
TX2_CUSHION_EXTRA_USDC_MICRO=0
TX2_MIN_CUSHION_SOL_LAMPORTS=9800000
TX2_CU_PRICE_MICRO_LAMPORTS=100
```

Observed:

```text
receipt: receipts/REDEMPTION-LIVE-CYCLE-006.json
treasury_usdc_delta: +0.853280
crank_sol_delta: -0.009930040
system_net_at_86.75: -0.008151 USD
break_even_SOL_price: 85.929160
```

## Do Not Lose

- The Kamino route is a working baseline for treasury-positive cycles.
- CU price `100` is mandatory for the low-gas profile.
- The micro profile is within one cent of system break-even.
- The aggressive profile is useful if the goal is treasury USDC growth, but it
  does not pass total-system accounting at current observed price.

## Orca-Style Cost Controls For Kamino

Use the same discipline people use around Orca route execution:

```text
quote immediately
set low CU price
avoid ATA churn
avoid WSOL close/reopen inside the loop
use deficit-only refill
reject if live quote is outside break-even
```

Scanner:

```bash
ENV_PATH=.env.redemptionarc npm run kamino-orca-style-scan
```

It does not send transactions. It checks the live SOL/USDC quote and compares it
against empirical break-even from the preserved Kamino receipts. The live gate is
now margin-based, not just break-even-based:

```text
projectedNetAtCurrentQuote >= KAMINO_WINDOW_MIN_MARGIN_USD
default margin: 0.05 USD
```

This was added because cycles 009-011 proved that a tiny quote edge can be eaten
by sweep variance.

## Why Marginfi Remains Active

The Marginfi track is not a replacement for this baseline. It exists because
removing Kamino flash fee/friction is the clearest path to turn the near-breakeven
micro profile into repeatable total-system profit.
