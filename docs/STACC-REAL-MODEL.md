# STACC Real Model - Verified Gate

Generated from local receipts and mainnet RPC on 2026-05-23.

## Verified State

- Reference TX decode exists at `receipts/STACC-TX-DECODE.json`.
- STACC config decode exists at `receipts/STACC-CONFIG-DECODE.json`.
- Recoverables scan shows `hopWithheldUi = 722396.824011`, `hopWithheldCanWithdraw = true`, and `hopWithheldQuoteUsd = null`.
- HOP transfer fee is not active at 1 bps yet:
  - current epoch: `976`
  - active fee: `690 bps`
  - newer fee: `1 bps @ epoch 978`
  - withdraw withheld authority: crank `8pWEfpJas2tgS8iE7ZyHKNjeDSEixqSwK12W4tagNJ3S`

## Correct Interpretation

The ring is mechanically useful but not cash-settled today.

```text
controlled HOP ring
-> Token-2022 withheld fees
-> harvest to mint
-> withdraw to treasury
-> HOP balance increases
```

That is not USDC/SOL profit until HOP has an externally funded settlement route. A self-seeded HOP/USDC pool alone does not create cash profit; selling HOP into our own LP vault moves our own USDC from LP inventory to treasury.

MarginFi flash USDC is an atomicity wrapper in the observed TX shape. It does not determine the amount of HOP fee revenue. HOP fee revenue is controlled by `HOP_AMOUNT_PER_HOP`, active transfer-fee bps, ring balances, and settlement value.

## Current Dry Run

Command:

```bash
SOLANA_RPC_URL='https://mainnet.helius-rpc.com/?api-key=<redacted>' \
DRY_RUN=true ALLOW_LIVE=false FLASH_AMOUNT_USDC=1 HOP_AMOUNT_PER_HOP=1000 CU_LIMIT=300000 \
npm run not-stacc-replicate
```

Receipt: `receipts/not-stacc-replicate`

Result:

```text
verdict: SIM_OK_CASH_GATE_BLOCKED
unitsConsumed: 199808
activeFeeBps: 690
expectedTotalWithheldHop: 248.725369
live blocked because:
- active HOP fee is 690bps, target is 1bps
- withheld fees settle as HOP, not spendable USDC/SOL
- FLASH_AMOUNT_USDC is only the MarginFi wrapper amount
```

## Live Gate

`src/scripts/not-stacc-replicate.ts` now blocks live execution unless:

```text
active HOP fee == 1 bps
AND SETTLEMENT_CONFIRMED=true
AND a real settlement path is declared with SETTLEMENT_PATH
```

Until then, the executable status is:

```text
mechanical sim: OK
cash-settled profit: NOT PROVEN
live send: BLOCKED
```

