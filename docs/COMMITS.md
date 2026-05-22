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
