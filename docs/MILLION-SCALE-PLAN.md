# RedemptionArc Million-Scale Plan

This is an engineering target, not an assumed result. The path to large capital is:

```text
repeatable cash source
-> exact no-send proof
-> controlled live micro-cycle
-> automated small keeper
-> scale volume only while the same invariant holds
```

## Phase 0: Isolation

Done in the scaffold:

- New treasury, crank, and withdraw authority.
- Kimi/legacy wallet denylist.
- No-live preflight.
- Treasury snapshot receipt.

## Phase 1: Kimi Primitive Autopsy

Goal: explain the real treasury USDC rise without relying on Kimi wallets.

Required output:

```text
sourceClass:
whoPays:
whyEligible:
exactInstructionPath:
settlementPathToSolUsdc:
perCycleBeforeAfter:
nonCashRemainder:
failureMode:
```

Do not accept:

- "HOP balance went up" as cash.
- "Ghost residual existed" as production.
- "Treasury USDC rose" without decoding who paid it and why.

Current imported proof:

```text
receipt: receipts/REDEMPTION-KIMI-PROOF-IMPORT-LATEST.json
cycles imported: 250
positive cycles: 247
avg net: 1.890197 USD/cycle
avg treasury delta: 3.920381 USDC/cycle
avg gas: 0.023293873 SOL/cycle
```

GitHub review correction:

```text
receipt: receipts/REDEMPTION-KIMI-CUSHION-AUDIT-LATEST.json
treasury ledger: positive
total-system estimate: negative
reason: TX0 cushion is not burned gas, but it is controlled SOL converted into USDC
```

RedemptionArc must scale the total-system ledger, not only treasury USDC.

## Phase 2: RedemptionArc Micro-Rebuild

Use new authorities and smallest possible size:

- Route volume: start tiny.
- TX count: TX0/TX2/TX3 only if each has a measured role.
- Gate: `cash_after_usd - cash_before_usd >= MIN_NET_USD`.
- Live: one manually approved cycle only after no-send receipt.

## Phase 3: Calibrated Scale

Scale is allowed only if all are true at the larger size:

- Same source still pays.
- Same signer/authority still controls the right.
- Liquidity depth supports settlement.
- Priority fee and tip are priced.
- No wallet inventory is silently drained.
- Receipts show spendable SOL/USDC growth after the cycle.

Current scale receipt:

```text
receipt: receipts/REDEMPTION-TARGET-DESIGN-LATEST.json
target: 1,000 USD net/cycle
observed net yield: 484.67 bps on 39 USDC route
theoretical required route volume: ~20,633 USDC
Token-2022 fee cap blocker: no
next blocker: route/liquidity/settlement/CU proof
```

Important correction:

The observed Kimi cash delta does **not** prove that USDC cash scales linearly with
`ROUTE_VOLUME_USDC`. The route volume mainly scales HOP/Token-2022 withheld fees.
Those are non-cash until a concrete settlement route converts them into SOL/USDC.

Therefore the next required proof is not just bigger route volume. It is:

```text
bigger route volume
-> larger HOP withheld fees
-> controlled withdraw authority
-> HOP -> USDC/SOL settlement route
-> treasury cash delta after all costs
```

Without that final settlement path, large route volume creates inventory/accounting
gain, not million-scale cash.

## Phase 4: Keeper

Keeper starts paused and only wakes when:

- source scanner returns `READY`,
- exact route simulator returns `POSITIVE`,
- preflight returns `READY_NO_LIVE` for dry run or `LIVE_ARMED` only after explicit approval,
- wallet balances are within configured float limits.

## Million-Dollar Constraint

Millions do not come from increasing a negative loop. Millions require one of:

- More external/protocol-paid cash sources.
- Larger repeatable route size without slippage collapse.
- Parallel independent sources.
- A protocol-owned venue where fee rights are controlled by RedemptionArc and settle to SOL/USDC.

If the source cannot be regenerated every cycle, classify it as salvage and do not scale it as keeper revenue.
