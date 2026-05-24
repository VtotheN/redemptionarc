# HOP Cashability Gate

`npm run hop-cashability-gate` is a read-only settlement gate for harvested HOP.

It answers one question:

```text
Can the harvested HOP become external USDC/SOL without selling into our own pool?
```

The gate never builds or sends swap transactions. It records `ALLOW_LIVE`,
`DRY_RUN`, and `LIVE_TX_APPROVED`, but ignores them.

## Inputs

Use one of:

```bash
HOP_CASHABILITY_SOURCE_TX=<confirmed tx with positive HOP delta>
HOP_CASHABILITY_AMOUNT_RAW=<raw HOP amount>
HOP_CASHABILITY_AMOUNT_UI=<decimal HOP amount>
```

If none is set, the gate reads the configured `REDEMPTION_CRANK` HOP ATA balance.

Important controls:

```bash
HOP_CASHABILITY_CYCLE_COST_USD=1.374831
HOP_CASHABILITY_MAX_IMPACT_PCT=1
OWNED_AMM_KEYS=<comma-separated pool/market keys>
OWNED_LP_MINTS=<comma-separated LP mints>
OWNED_WALLETS=<comma-separated owner wallets>
```

## Verdicts

```text
HOP_CASHABILITY_READY_NO_SEND
HOP_CASHABILITY_PARTIAL_READY_NO_SEND
HOP_CASHABILITY_BLOCKED
```

The gate blocks when:

- Jupiter has no HOP -> USDC/SOL route.
- The route uses an owned AMM key.
- The route has no AMM keys to classify.
- Price impact exceeds `HOP_CASHABILITY_MAX_IMPACT_PCT`.
- Net external USDC after cycle cost is below `MIN_NET_USD`.

## Cash Rule

Harvested HOP is evidence, not profit.

Cash profit requires:

```text
HOP harvested
-> external route accepted
-> exact swap simulation
-> wallet/vault SOL or USDC after > before after all costs
```

The receipt is written to:

```text
receipts/HOP-CASHABILITY-GATE-LATEST.json
```
