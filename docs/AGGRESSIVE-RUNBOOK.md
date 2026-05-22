# Aggressive Runbook

Mode: treasury-ledger, Kimi-style.

Objective: stop thinking in micro-cycles and move to tens per cycle, then thousands per day.

## Current Aggressive Receipt

```text
receipt: receipts/REDEMPTION-AGGRESSIVE-PLAN-LATEST.json
selected target: 25 USD net/cycle
projected daily at 1000 cycles/day: 25,000 USD
required crank float: 0.443596051 SOL
```

## Config Targets

| Target net/cycle | `TX2_CUSHION_EXTRA_USDC_MICRO` | Required crank float | Projected at 1000/day |
|---:|---:|---:|---:|
| 10 USD | `14681332` | `0.213048501 SOL` | `10,000 USD/day` |
| 25 USD | `34681332` | `0.443596051 SOL` | `25,000 USD/day` |
| 50 USD | `68014665` | `0.827841965 SOL` | `50,000 USD/day` |
| 100 USD | `134681332` | `1.596333804 SOL` | `100,000 USD/day` |

## Commands

```bash
cd /Users/velon/Desktop/redemtionarc

ENV_PATH=.env.redemptionarc \
LEDGER_MODE=treasury \
SOL_PRICE_USD=86.75 \
AGGRESSIVE_TARGETS_USD=10,25,50,100 \
AGGRESSIVE_CYCLES_PER_DAY=1000 \
npm run aggressive-plan
```

## Selected Launch Profile

Start with 25 USD/cycle:

```bash
TX2_CUSHION_EXTRA_USDC_MICRO=34681332
LEDGER_MODE=treasury
ROUTE_VOLUME_USDC=39
HOPS=2
```

Before live:

```text
fund crank >= 0.443596051 SOL
run aggressive-readiness
run exact TX0/TX2/TX3 simulation
verify treasury net >= 25 USD at current SOL price
approve one live cycle
```

Readiness command:

```bash
ENV_PATH=.env.redemptionarc \
LEDGER_MODE=treasury \
SOL_PRICE_USD=86.75 \
npm run aggressive-readiness
```

Exact sim command:

```bash
npm run exact-sim
```

It stays blocked until `aggressive-readiness` is ready.

## Boundary

This runbook intentionally follows Kimi's treasury-ledger model. It does not
claim total-system accounting. The operational target is treasury USDC growth.
