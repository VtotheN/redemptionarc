# Pump + Orca Index Plan

Goal: test whether a legitimately launched token with real liquidity becomes
routeable through Jupiter, then measure actual external flow. No fake volume.

## What We Can Do

1. Create a token on Pump.fun through the official UI.
   - Pump.fun creation metadata is one-shot: name, ticker, description, image,
     and links need to be correct before creation.
   - Pump.fun's UI currently exposes options such as pairing with USDC.
2. Seed initial liquidity with a small, pre-approved budget.
3. Create or add a legitimate Orca/Raydium route if the token migrates or if an
   owned pool is created.
4. Run the read-only watcher:

```bash
TOKEN_MINT=<mint> npm run jupiter-index-watch
```

5. If Jupiter returns a route, measure:
   - route labels and AMM keys
   - price impact
   - external fee payers
   - actual wallet-settled SOL/USDC gains

## What We Should Not Do

- No wash volume.
- No fake activity intended to mislead external buyers.
- No reporting self-trades or self-seeded LP inventory movement as profit.

## Cash Gate

Proceed beyond read-only monitoring only when:

```text
external route exists
AND flow is not our own wallet cluster
AND fees or sales settle as SOL/USDC
AND all seed/rent/gas/tips are priced
AND before/after wallet SOL/USDC is positive
```

## Current BZK Reference

The local BZK receipts prove the pattern exists:

- Pump.fun/PumpSwap tx sent `2.081291788 SOL` to WzMa in one transaction.
- BZK pool receipts include one external fee payer swap involving BZK.
- Current Jupiter quote check for BZK returns `NO_ROUTES_FOUND`, so the
  historical route is not currently usable.

## Useful Commands

```bash
npm run stacc-bzk-cash-analysis
TOKEN_MINT=Bzkdz5AKApsqizBxzqMUqWGJbx4gHXVC6NJekmAY8Gq3 npm run jupiter-index-watch
```

## Sources

- Pump.fun create page: `https://pump.fun/create`
- Pump.fun help center: `https://intercom.help/pumpfun-web/en/articles/11002205-create-a-coin-on-pump-fun`
- Jupiter Swap API quote docs: `https://dev.jup.ag/docs/api/swap-api/quote`
- Jupiter March 2026 Swap API v2 changelog: `https://dev.jup.ag/docs/changelog`

