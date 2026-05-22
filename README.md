# RedemptionArc

Independent rebuild of the Kimi-style cash engine, with new wallets and stricter accounting.

The target is not to copy old balances. The target is to isolate the primitive that made treasury USDC rise, rebuild it under new authorities, and scale only after the loop proves repeatable cash settlement.

## Current State

- Project scaffold: ready.
- Live execution: disabled.
- Wallets: must be new.
- Profit accounting: SOL + USDC only.
- HOP/custom tokens: tracked, not counted as cash.

## Commands

```bash
npm install
cp .env.example .env
npm run preflight
npm run snapshot
npm run dry-run
```

## Scale Plan

1. **Clone the observable invariant, not the old wallets.**
   Measure the exact source of treasury USDC growth, then reproduce it under RedemptionArc authorities.

2. **Prove cash per cycle.**
   Every cycle must emit a receipt with before/after spendable SOL + USDC, gas, tips, swaps, and non-cash leftovers.

3. **Add capital only after repeatability.**
   Millions come from compounding a real cash source. If a route only works by preloading value, it is rejected.

4. **Automate conservatively.**
   Keeper stays paused until the no-send gate returns positive with current price, current liquidity, and current wallet state.

## Current Verdict

Kimi's receipts prove a small positive cash loop happened. RedemptionArc imported
that evidence read-only, then separated the scaling blocker:

```text
cash observed: treasury USDC delta - crank SOL cost
non-cash observed: HOP/Token-2022 withheld fees
blocked route: HOP -> USDC via Jupiter returns TOKEN_NOT_TRADABLE
```

So the next build target is not raw speed. It is a settlement primitive that turns
withheld/value accrual into spendable USDC/SOL without draining our own inventory.

Accounting correction from the GitHub review:

```text
Kimi treasury ledger:
  treasury USDC delta - burned gas

RedemptionArc total-system ledger:
  treasury USDC delta - burned gas - SOL cushion converted in TX0
```

Kimi correctly fixed that TX0 cushion is not gas. RedemptionArc still tracks it
as system inventory conversion, because scaling to millions needs net new
SOL/USDC, not just moving controlled SOL into treasury USDC.

## Aggressive Mode

Velon's current directive is treasury-ledger scale. RedemptionArc now has an
aggressive planner:

```bash
npm run aggressive-plan
```

Current selected profile:

```text
target: 25 USD/cycle
required float: 0.443596051 SOL
projected: 25,000 USD/day at 1000 cycles/day
```

See [AGGRESSIVE-RUNBOOK.md](docs/AGGRESSIVE-RUNBOOK.md).

## Cash Invariant

```text
cash_after_usd - cash_before_usd - all_liabilities_usd >= MIN_NET_USD
```

Cash means:

- SOL controlled by RedemptionArc wallets.
- USDC controlled by RedemptionArc wallets.

Not cash:

- HOP/custom/Token-2022 balances before settlement.
- Ghost residual seeded before the cycle.
- Owned vault withdrawals.
- One-time rent recovery reported as recurring profit.
