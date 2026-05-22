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
