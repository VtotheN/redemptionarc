# Commit Log

## e33e9ff

Initial RedemptionArc scaffold and aggressive treasury-ledger planner.

Includes:

- new wallets/config isolation,
- denylist against Kimi/legacy wallets,
- Kimi proof import,
- aggressive `$25/cycle` planner,
- no-live receipts and docs.

## 71e4364

Aggressive readiness gate.

Adds:

- `npm run aggressive-readiness`,
- crank float check for the selected `$25/cycle` profile,
- ATA existence checks,
- blocked receipt while crank is unfunded.

## pending

Crank funding and exact-sim readiness.

Live internal transfer:

- `0.49 SOL` treasury -> crank
- signature `5Eshg5FGhaD2NBCb8U4Q4dChXVSfRuyrZ6F8vZn3wgvZFsMvwbZ9f4RR64yu1tTBXF3oCDSVWpq2VD1Jwshqz9GM`
- readiness now `AGGRESSIVE_READINESS_READY_FOR_EXACT_SIM`

## pending

RedemptionArc-owned HOP mint.

- mint `AKjuodXiTwwCVtZzrnGnYHYvZhEB3HH728JQrY7ovXDA`
- create signature `4Q46Y14mhHJ74KC8uV6ifrMVaxrBDc1VHUB1bvKgMRJW2S3KT58TdraB1gdRBMSsnTptrQfrz2twR3UdzwZmTWAX`
- transfer fee `690 bps`
- initial supply minted to RedemptionArc crank ATA
- `.env.redemptionarc` updated locally to use this mint

## pending

Cycle token accounts initialized.

- signature `4QbEH7CrbWsn184xDSdoESsvVypPSX83hhRiwVwtoEHgJMffLPf7DX2XxnyJGhiFAxwR2zmJFseDTQCccApPZ6bU`
- created/idempotently verified ghost USDC, treasury USDC, WSOL, hop escrow, treasury HOP, ring HOP ATAs

## pending

First aggressive live cycle.

- TX0 `559dw2B75teohmeT4s5vMRyoNBLib3wwn1Uroc4CYc6Gqtr7t6M6tfsr531eJxCRFc84JF2V3yzXP5CqPx51aLNx`
- TX2 `27epQsuL9T6Rkc6D7qYFyt16LhRjz5ForUTDangQjpw3bnhnYTpR2scAhd8yYRbfqhp3AvBbkuZYnwo866aSFXS8`
- TX3 `4xSuj6RTHmwSBL8AHVXHzQSp9LTSpcBDSQ6QixG4po6ENAbuct1QiRsDAW7cVuZuYubiyLWt7PEyRSwGY3euAddD`
- treasury delta `34.743069 USDC`
- reported post-gate net `$34.4371`
- crank after cycle `0.064379503 SOL`

## pending

Treasury refill to crank.

- first refill swapped `30 USDC`, transferred `0.311005 SOL`
- second refill swapped `4 USDC`, transferred `0.084241 SOL`
- crank after refill `0.459625769 SOL`
- readiness restored to `AGGRESSIVE_READINESS_READY_FOR_EXACT_SIM`

## pending

Second aggressive live cycle.

- TX0 `5QiMnxJ5uTm8kmALxpz9btpFzDEt7hukpvG8zLFxJQBj3r1eVTBeMYDvxyJTUr1YEiGpTVvJ9tPEg9MTAYMrzGrN`
- TX2 `2F2QtXmK3TwvpKCS763wXhpPzW86McynQPvkQGv42fFvZ5pv8gCjB2sgZVYxXwCvHn14FavC4HHsRQaUyTe7YfDd`
- TX3 `4cNn9Q9m6hoGVSJ9S8NsDmLmvNY7CjfR6tgfSiHqxaBtb3C9UsQGBjiwFEdVLXnNXDyviKcF5WXpJE5jWaVN5gnp`
- treasury delta `34.678876 USDC`
- reported post-gate net `$34.6676`

## pending

Refill after cycle 002.

- swapped `35 USDC`
- transferred `0.399567 SOL` to crank
- crank after refill `0.458872541 SOL`
- readiness restored

## pending

Third aggressive live cycle.

- TX0 `674SRi1ySzBwBnjEZ2HyNir83vrUHZMf7xzwT35PvE7P1TmL6BbhHtk8VRcxjdFwRQSADEhZeUSniVMF3RXkmgKZ`
- TX2 `43CTQaWcUqxeLLhkVaWDZDYYfPRQMPVpC1dRRe9MHwbEa4J3WMHCz7g1ed9F5RyEgb2SY2bgeAyeLsvST8tEEjT`
- TX3 `4XTPUT6WuMsdtqt5nLFgaQ7yvaVCPcf2DRMvU5dkoPuBz7h8QTt4LeyL8WvMRP27cA31jdipBEMvBG5AFxDTnpeV`
- treasury delta `34.712398 USDC`
- reported post-gate net `$34.7011`
- crank after cycle `0.058552724 SOL`

## pending

Refill after cycle 003.

- swapped `35 USDC`
- transferred `0.362309 SOL` to crank
- crank after refill `0.420861472 SOL`
- readiness blocked for `$25/cycle` profile: needs `0.443596051 SOL`

## pending

RedemptionArc lab sweep.

- added `npm run arc-lab`
- added `npm run flash-provider-scan`
- cycle 004: `cushionExtra=1 USDC`, `CU price=100`, system net `-$0.008590`
- cycle 005: `cushionExtra=0`, `minCushion=0.0100 SOL`, system net `-$0.008921`
- cycle 006: `cushionExtra=0`, `minCushion=0.0098 SOL`, system net `-$0.008151`
- provider scan says native Marginfi 0 bps would model `+$0.026179`, below the normal `$0.25` gate but positive directionally

## pending

Pinocchio + Marginfi track.

- installed `@mrgnlabs/marginfi-client-v2@6.4.1`
- installed `@mrgnlabs/mrgn-common@2.0.7`
- added `programs/pinocchio-arc` read-only callback scaffold
- added `npm run pinocchio-marginfi-plan`
- local blocker: no `rustc`, `cargo`, or `rustup` installed
- adapter target: Marginfi begin flashloan -> RedemptionArc body -> Marginfi end flashloan -> total-system cash receipt

## pending

Marginfi read-only adapter scanner.

- added `npm run marginfi-adapter-scan`
- fetches Marginfi production config/client read-only
- locates USDC bank
- checks whether RedemptionArc crank already owns a Marginfi account
- sends no transactions

## pending

Marginfi account setup planner.

- added `npm run marginfi-account-setup`
- no-send by default
- generates ignored `keys/marginfi-account.json`
- builds create-account + `marginfi_account_initialize`
- live setup requires `ALLOW_LIVE=true DRY_RUN=false`

## pending

Marginfi account live setup and raw flash plan.

- created Marginfi account `9SdjygeTAmMrgCQjBAGNAAjjYE6U35ARWcuvvxFZJHz`
- setup sig `YxWAGmcjQQeVxFuqqFuXtW34rqYfrht5cCTuUR3M4qxoBjGi7mBkjUQzPgtBxK5X9ofb5tZnm5YiagFybazKGG4`
- fixed setup builder to let Marginfi allocate the account internally
- added `npm run marginfi-raw-flash-plan`

## pending

Marginfi empty raw flash simulation.

- added `npm run marginfi-raw-flash-sim`
- simulates start/end flashloan wrappers with no body
- next: insert RedemptionArc body only if empty wrapper sim passes

## pending

Marginfi raw borrow/repay simulation.

- added `npm run marginfi-raw-borrow-repay-sim`
- uses raw IDL discriminators for start flash, USDC borrow, USDC repay, end flash
- candidate USDC bank `2s37akK2eyBbp8DZgCm7RtsaEz8eJP3Nxd4urLHQv7yB`
- candidate liquidity vault `7jaiZR5Sk8hdYN9MxTpczTcwbWpb5WEoxSANuUwveuat`

## pending

Kamino baseline preserved.

- added `docs/KAMINO-BASELINE.md`
- keeps the `$25 treasury-positive` profile and micro near-breakeven profile
- best total-system Kamino micro result remains cycle 006: `-$0.008151`
- best treasury-positive aggressive result remains cycle 003: `+34.712398 USDC`, system `-$0.015346`

## pending

Kamino Orca-style cost scanner.

- added `npm run kamino-orca-style-scan`
- compares live Jupiter SOL/USDC quote against empirical Kamino break-even
- preserves low-cost rules: CU price `100`, keep WSOL open, deficit-only refill, no over-cushion
- no live TX

## pending

Excluded salvage cash recovery.

- source: one-time rent recovery from empty crank WSOL ATA
- signature `27YnrugN4DYYoEwbKmRvNitioaWeqTQKQn63Y8iqE2M8141osvSubxdaokqeLoLZ5dfxZyaV8NjYL2LCrLbqW15X`
- crank SOL before `0.369478173`
- crank SOL after `0.371512453`
- net `+0.00203428 SOL`, about `+$0.176474` at SOL `86.75`
- classification: real spendable cash, one-time salvage, excluded from RedemptionArc loop success
