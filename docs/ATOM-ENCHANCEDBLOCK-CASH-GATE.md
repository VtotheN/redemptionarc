# Atom + ENCHANCEDBLOCK Cash Gate

`npm run atom-enchancedblock-gate` is a read-only planner for the current
thesis. `npm run atom-enchancedblock-cash-gate` is the same command under a
more explicit name.

```text
atom_ickk = multi-slot capital window
ENCHANCEDBLOCK = external Orca settlement source
HOP redeem vault = bridge from HOP/accounting units into SOL/USDC
CashRelay = final judge
```

The gate accepts that `atom_ickk` can be deployed or redeployed from the local
contract. Deployment status is treated as an engineering blocker, not an
economic blocker.

## What It Checks

- Local `atom_ickk` has the mechanics needed for a bounded multi-slot position:
  `flash_open`, `borrower_exit`, `keeper_liquidate`, deadline checks, and vault
  constraints.
- ENCHANCEDBLOCK has a real external Orca leg, forward/inverse cycle builders,
  Jito bundle builders, and `admin_rebalance`.
- A current ENCHANCEDBLOCK gate receipt proves a positive exact edge now.
- A HOP redeem receipt proves burn/lock HOP -> SOL/USDC from a backing vault.
- RedemptionCashRelay has already accepted the final SOL/USDC source receipt.

The receipt also reports the working 4-gate dashboard:

```text
Gate 1: atom_ickk executable or deploy/redeploy required
Gate 2: edge model = BAIT_BPS - ORCA_FEE_BPS - GAS_BPS
Gate 3: vault math = SELL_SIZE_USDC * modelNetEdgeBps / 10000 * CYCLES_PER_DAY
Gate 4: HOP redeem vault funded and exact burn/redeem proof present
```

Gate 2/3 are planning math. They are useful for sizing, but they are not booked
profit until Gate 4 and CashRelay pass.

## Required Receipts

```bash
ENCHANCEDBLOCK_GATE_RECEIPT_PATH=...
HOP_REDEEM_RECEIPT_PATH=...
CASH_RELAY_RECEIPT_PATH=receipts/REDEMPTION-CASH-RELAY-LATEST.json
SELL_SIZE_USDC=100
BAIT_BPS=60
ORCA_FEE_BPS=30
GAS_BPS=3
CYCLES_PER_DAY=96
npm run atom-enchancedblock-gate
```

Without those exact receipts the planner writes:

```text
ATOM_ENCHANCEDBLOCK_CASH_GATE_BLOCKED
```

That is expected. It means the thesis is not dead; it means the missing piece is
cash settlement proof.

## Boundary

HOP balance, Token-2022 withheld fees, virtual reserve profit, or owned-pool
inventory do not pass. The only passing invariant is:

```text
controlled SOL/USDC after
> controlled SOL/USDC before
- atom_ickk fee
- ENCHANCEDBLOCK costs
- flash repayment
- retrieve/liabilities
- inventory draw
```

Output:

```text
receipts/ATOM-ENCHANCEDBLOCK-CASH-GATE-LATEST.json
```
