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
- optional local CSDM `.so` artifact size against the live Q9 ProgramData ELF length estimate

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

Current local build note: `csdm_flash_lend_backing.so` compiled to 42,304 bytes, while live Q9 ProgramData exposes an estimated 43,416 bytes for the program ELF. The scanner records this as fit/headroom, but that still is not approval to upgrade.

Next exact build:

1. Prove whether live CSDM can be upgraded safely with the local authority and current ProgramData size.
2. Simulate `flash_lend_backing` or a HOP burn/redeem instruction against exact accounts.
3. Emit a source receipt with real SOL/USDC `beforeRaw`/`afterRaw`.
4. Pass `npm run redemption-cash-relay-plan`.

The first step is now captured by:

```bash
npm run csdm-upgrade-preflight
```

That preflight checks Q9 ProgramData, local program/authority keypairs, artifact hash/size, and source invariants. It still refuses cash proof because an upgradeable program is not profit.

The second step is:

```bash
npm run csdm-live-shape-scan
```

That scanner checks the mainnet CSDM pool/config/backing accounts from `config.mainnet.existing.json`: derived PDA matches, token account mints/owners, asset config, allowed borrower, oracle, and whether backing is nonzero. Passing shape means only that ix7 can be simulated after upgrade; it is still not cash proof.

When both preflights pass, build the exact no-send approval packet:

```bash
npm run csdm-upgrade-approval-plan
```

This pins the ProgramData hash, artifact hash, authority, keypairs, byte headroom, and exact `solana program deploy ... --no-auto-extend` command. It does not run the command and still marks cash proof as blocked.
