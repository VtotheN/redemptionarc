# HOP Route Incentive Plan

`npm run hop-route-incentive-plan` is a read-only planner for fee-gated route
incentives.

It does not pay rewards. It only calculates whether observed external HOP flow
has enough cash-safe fee budget to justify a micro-incentive.

## Rule

Do not pay traders for showing up. Pay only after they already created usable
fee budget:

```text
external signer flow
-> quote asset enters HOP venue
-> LP/T22 fee is observed
-> fee is collected/settled into spendable USDC/SOL
-> reward <= cash-safe fee budget
```

## Inputs

Default receipts:

```text
receipts/HOP-EXTERNAL-FLOW-WATCH-LATEST.json
receipts/HOP-CASHABILITY-GATE-LATEST.json
```

Main knobs:

```bash
HOP_INCENTIVE_REWARD_TOKEN=USDC
HOP_INCENTIVE_REWARD_SHARE_BPS=1000
HOP_INCENTIVE_LP_FEE_BPS=25
HOP_INCENTIVE_T22_SETTLED_USD=0
HOP_INCENTIVE_CONFIRMED_CASH_FEE_USD=0
HOP_INCENTIVE_MIN_REWARD_USD=0.001
```

`HOP_INCENTIVE_T22_SETTLED_USD` and
`HOP_INCENTIVE_CONFIRMED_CASH_FEE_USD` should stay zero until an exact
collect/settle receipt proves spendable USDC/SOL.

## Outputs

Receipt:

```text
receipts/HOP-ROUTE-INCENTIVE-PLAN-LATEST.json
```

Important fields:

```text
observedFlow.externalFlowUsd
observedFlow.t22FeeHop
economics.theoreticalMaxRewardUsd
economics.cashSafeRewardUsd
gate.cashRelayPass
gate.rejectionReasons
```

## Cash Rule

HOP fees and LP NAV are not reward budget by themselves.

Reward is allowed only when:

```text
cashSafeRewardUsd >= HOP_INCENTIVE_MIN_REWARD_USD
rewardToken is USDC or SOL
N-pool external route proof exists
CashRelay can prove owned SOL/USDC after reward remains net-positive
```
