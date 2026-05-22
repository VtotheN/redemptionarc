# Owned Venue Spec

Purpose: create a path where RedemptionArc can settle value into USDC/SOL without pretending self-funded inventory is profit.

## Rejected Variant

```text
RedemptionArc funds USDC pool
-> RedemptionArc swaps HOP into pool
-> RedemptionArc treasury receives USDC
```

Verdict: rejected as profit. This drains controlled USDC inventory.

## Valid Variants

### A. External Flow Fee Venue

```text
external/protocol orderflow
-> trades through RedemptionArc venue
-> venue charges fee in USDC/SOL
-> fee vault controlled by RedemptionArc
-> withdraw to treasury
```

Required proof:

- external/protocol payer identified,
- fee vault balance increases without RedemptionArc funding it first,
- exact claim/withdraw instruction exists,
- post-cycle SOL+USDC increases after all costs.

### B. Protocol-Paid Claim Source

```text
owned position/referral/reward right
-> claim/collect instruction
-> USDC/SOL to RedemptionArc treasury
```

Required proof:

- account authority is RedemptionArc,
- claim status says unpaid,
- token paid is SOL/USDC or has ready settlement route,
- no lifecycle recreation drains rent again.

### C. HOP Settlement Market With Real Counterparty

```text
HOP withheld fees
-> market with non-RedemptionArc USDC liquidity
-> swap/settle
-> treasury USDC
```

Required proof:

- executable route,
- enough depth at target size,
- route does not depend on our own USDC side,
- no forbidden Kimi/legacy wallet.

## Minimal Program Shape

If building our own venue:

- Pinocchio/no_std preferred for low deploy size.
- Instructions:
  - `initialize_config`
  - `initialize_fee_vault`
  - `record_external_fill`
  - `collect_usdc_fees`
  - `close_empty_vault`
- Accounts:
  - config PDA
  - USDC fee vault ATA/PDA
  - authority
  - payer/filler
  - treasury USDC ATA

## RedemptionArc Gate

```text
venue_cash_pass =
  fee_vault_usdc_after > fee_vault_usdc_before
  AND fee payer is not RedemptionArc
  AND treasury_usdc_after - treasury_usdc_before > all_costs
```

Anything else is inventory conversion, not loop profit.
