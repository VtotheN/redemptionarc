# RedemptionCashRelay V1

RedemptionCashRelay is the no-send judge for closed-cash loop plans.

```text
HOP = control / metering only
GGSS/UNDERWHEEL = future actuator source
USDC/SOL vault delta = only accepted profit
CashRelay = judge
```

V1 does not build or submit transactions. It reads one source receipt from
`CASH_SOURCE_RECEIPT_PATH`, applies the cash gate, and writes
`receipts/REDEMPTION-CASH-RELAY-LATEST.json`.

## Source Receipt Interface

```ts
{
  verdict: string;
  noSend: boolean;
  sourceClass: "authority_exclusive_actuator";
  sourceName: string;
  payerClass: "external_protocol" | "owned_inventory" | "unknown";
  asset: "USDC" | "SOL";
  beforeRaw: string;
  afterRaw: string;
  decimals: number;
  costsUsd: number;
  liabilitiesUsd: number;
  inventoryDrawUsd: number;
  simErr: null | unknown;
}
```

## Gate

The relay passes only when:

```text
sourceClass == authority_exclusive_actuator
payerClass == external_protocol
asset is USDC or SOL
simErr == null
afterRaw > beforeRaw
netCashUsd = deltaUsd - costsUsd - liabilitiesUsd - inventoryDrawUsd
netCashUsd >= MIN_NET_USD
```

USDC is priced as 1 USD. SOL sources require `SOL_PRICE_USD` so the planner can
compute exact USD net.

## Hard Rejects

- HOP/custom token counted as profit.
- `payerClass=owned_inventory`.
- Own-pool USDC recycled into treasury.
- Quote-only spread.
- Public race or faster bot assumption.
- Rent recovery or salvage treated as recurring source.
- Forbidden Kimi/legacy wallets.
- Missing, malformed, or non-no-send source receipt.

## Run

```bash
npm run redemption-cash-relay-plan
CASH_SOURCE_RECEIPT_PATH=receipts/source.json npm run redemption-cash-relay-plan
```

`ALLOW_LIVE=true` and `LIVE_TX_APPROVED=true` are recorded but ignored. V1 is
always no-send.
