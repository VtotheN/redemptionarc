# RedemptionArc Lab

This file tracks RedemptionArc's own experiments. It does not copy Kimi wallets
or treat treasury-only movement as profit.

## Rule

```text
profit = treasury USDC delta + crank SOL delta * SOL price
```

HOP/custom token growth is evidence only until it settles to SOL or USDC.

## 2026-05-22 Micro Cushion Sweep

Baseline aggressive profile was rejected for total-system cash:

| Cycle | Cushion Profile | Treasury USDC | Crank SOL Delta | System Net |
| --- | ---: | ---: | ---: | ---: |
| 004 | 1 USDC extra | `+1.037791` | `-0.012062028` | `-$0.008590` |
| 005 | 0 extra, `0.0100 SOL` min | `+0.869860` | `-0.010130040` | `-$0.008921` |
| 006 | 0 extra, `0.0098 SOL` min | `+0.853280` | `-0.009930040` | `-$0.008151` |

The direction is correct, but Kamino's current flash fee leaves the edge a few
cents negative.

## Flash Provider Hypothesis

`npm run flash-provider-scan` models the latest RedemptionArc receipt with only
the flash-loan fee changed.

Current result:

```text
best provider model: marginfi
modeled fee: 0 bps
modeled net: +$0.026179
status: below the normal $0.25 gate, but positive directionally
```

Next implementation target:

```text
Marginfi adapter
-> exact no-send simulation
-> one live micro-cycle only if system cash > 0
```

VAEA is also worth testing as an aggregator path, but its advertised 2 bps fee is
a smaller improvement than native Marginfi 0 bps.
