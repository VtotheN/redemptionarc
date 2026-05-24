# HOP External Flow Watch

`npm run hop-external-flow-watch` is a read-only N-pool watcher for HOP venues.

It looks for confirmed swaps touching configured HOP pools, then classifies them:

```text
EXTERNAL_FLOW_CANDIDATE
AFFILIATED_FLOW_REJECTED
```

External flow is only a candidate. Cash profit still requires a later exact
SOL/USDC post-balance proof.

## Why N Pools

One HOP pool is circular. More HOP venues can create real arbitrage paths:

```text
HOP/USDC
HOP/SOL
HOP/USDT
HOP/JitoSOL
HOP/mSOL
```

The watcher tells us which pairs attract actual external signer flow before more
capital is added.

## Config

Default config watches current Pool A only:

```text
HOP/USDC Raydium CP = 6zbtkhUtxdd3gfae4QJpHe356S44wRMNxNjJq33oEL7f
```

Add all controlled wallets:

```bash
AFFILIATED_WALLETS=<alternate-pool-creator>,<other-owned-wallet>
OWNED_WALLETS=<optional-extra-owned-wallets>
```

Add pools with JSON:

```bash
HOP_FLOW_POOLS_JSON='[
  {
    "id": "hop-usdc",
    "pool": "6zbtkhUtxdd3gfae4QJpHe356S44wRMNxNjJq33oEL7f",
    "quoteMint": "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
    "quoteAsset": "USDC",
    "vaultOwner": "GpMZbSM2GgvTKHJirzeGfMFoaZ8UR2X7F4v8vHTvxFbL",
    "lpMint": "J2HNL9QJYrzDQsf9g3gSnPRSfUEWqWW75H5FyVmBzYqq"
  },
  {
    "id": "hop-sol",
    "pool": "<pool-address>",
    "quoteMint": "So11111111111111111111111111111111111111112",
    "quoteAsset": "SOL",
    "vaultOwner": "<pool-vault-owner>",
    "lpMint": "<optional-lp-mint>"
  }
]'
```

For unknown AMMs, prefer exact vaults:

```json
{
  "hopVault": "<HOP vault token account>",
  "quoteVault": "<quote vault token account>"
}
```

## Receipt

Writes:

```text
receipts/HOP-EXTERNAL-FLOW-WATCH-LATEST.json
```

Important fields:

```text
summary.externalEvents
summary.externalQuoteInUsd
summary.externalEstimatedT22HopUi
poolReports[].events[].flowClass
poolReports[].events[].vaultDeltaSummary
poolReports[].events[].t22
```

## Cash Rule

Affiliated signer flow is rejected even if it uses a different wallet.

Accepted flow still needs:

```text
external signer
-> quote asset enters venue
-> LP/T22 fees become claimable
-> exact collect/settle simulation
-> owned SOL/USDC after > before
```
