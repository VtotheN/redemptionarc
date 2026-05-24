# Mainnet Program Candidate Scan

Read-only inventory for the "which program can we use?" question.

```bash
npm run mainnet-program-candidate-scan
```

The scanner writes `receipts/MAINNET-PROGRAM-CANDIDATE-SCAN-LATEST.json` and never sends, deploys, upgrades, or closes. It checks:

- program account existence/executable state
- upgradeable loader ProgramData address, slot, authority, and data length estimate
- local program keypair pubkey matches
- local authority keypair/pubkey metadata matches
- local source markers for CSDM redeem/session/`flash_lend_backing` and atom multi-slot capital

Current architecture rule:

```text
CSDM / atom = actuator or redeem-vault build target
ENCHANCEDBLOCK = external Orca settlement source
ora-culoxx = truth/freshness helper
RedemptionCashRelay = final judge
SOL/USDC wallet delta = only accepted profit
```

Important distinction:

```text
program control != cash profit
HOP/custom token gain != cash profit
T22 fee/nav/internal accounting != cash profit
```

CSDM is useful because the legacy source already has burn-share-for-backing semantics, and the lazyloop source adds `ix7 flash_lend_backing`, which releases real backing and requires principal plus delta to return. That is the right shape for a cash-settled vault, but the live program must still be proven by exact binary/ix simulation before assuming ix7 is available.

Next exact build:

1. Prove whether live CSDM can be upgraded safely with the local authority and current ProgramData size.
2. Simulate `flash_lend_backing` or a HOP burn/redeem instruction against exact accounts.
3. Emit a source receipt with real SOL/USDC `beforeRaw`/`afterRaw`.
4. Pass `npm run redemption-cash-relay-plan`.
