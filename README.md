# RedemptionArc

Flywheel engine: own Orca Whirlpool fork + MarginFi flash + HOP T22 ring.

## Live State (2026-05-23)

### Own Orca Whirlpool (GxRHMB9a6XE8BqGPeNb9UkJUPvbvrPoPgNTJPJJA4n8h)

Forked from Orca, stripped to 12 instructions, deployed mainnet.

| Component | Address |
|-----------|---------|
| Program | `GxRHMB9a6XE8BqGPeNb9UkJUPvbvrPoPgNTJPJJA4n8h` |
| WhirlpoolsConfig | `9Nr7o1muxPfcsxv4WtTN2GdUFKhUsdR7WHejyJdesTmZ` |
| FeeTier (tick_spacing=64) | `7v5Rhe37P5BrPTtEeumH1oa6aBQg2tTzFN3r58Sfe4m7` |
| HOP TokenBadge | `HVcso86ZCfodDrGhSxiwuegx1K8xJqWso1M7Hs6UcwsE` |
| USDC/HOP Pool | `8aoWgf7ycbeKv6BTFCdUj4JR7Y4mXWuPZWEUhmuzN5ZL` |
| LP Position 1 | `ErgQU48egJMNBLZeVkdjrtZrSWUQJCky3deh2B4U1YPQ` |
| LP Position 2 | `3Qx4NtMhd9vDKWbcdUAu2qrwpypbXEGy95N4cYgdyaGk` |

Pool: USDC (tokenA) / HOP (tokenB), price = $0.0001/HOP, tick_spacing = 64.
Tick arrays initialized: [84480, 90112, 95744]. Position range: [84480, 101312].
LP seeded: 290.445053 USDC + HOP inventory, current pool liquidity = 78,748,145,963.

Official KPX9 position `59LWLWVULsY2QszQZJurs2yvkjwvfpZNnbA5jBqQpMbd` was withdrawn and closed; recovered `0.445053 USDC` plus HOP inventory was moved into the fork position `3Qx4NtMhd9vDKWbcdUAu2qrwpypbXEGy95N4cYgdyaGk`.

Current live-send blockers:
- HOP Token-2022 active fee is still 690 bps until the scheduled 1 bps config becomes active at epoch 978.
- The fork pool currently has 0 claimable USDC protocol fees.
- The crank currently has 0 USDC, so the existing flash round-trip cannot repay MarginFi after swap loss.
- HOP balances are tracked non-cash until settled into wallet-controlled SOL/USDC.

### T22 Ring + MarginFi Flash

| Component | Address |
|-----------|---------|
| Crank | `8pWEfpJas2tgS8iE7ZyHKNjeDSEixqSwK12W4tagNJ3S` |
| MarginFi account | `9SdjygeTAmMrgCQjBAGNAAjjYE6U35ARWcuvvxFZJHz` |
| USDC bank (MarginFi) | `2s37akK2eyBbp8DZgCm7RtsaEz8eJP3Nxd4urLHQv7yB` (~$559k vault) |
| HOP mint | `HZF5k7h39hkysoSZ4ZfmWc55PhvW7ntVvVqdXFCyYGh3` |
| Raydium CPMM pool | `EwoZHyXz48vZL1TwkpQoq31brW4G4NDwmMr1DMw6qqBV` |

Proven flash TXs: $1, $1k, $100k confirmed on-chain.

### Keys

```
keys/crank.json              — 8pWEfpJ... (sole TX signer)
keys/withdraw-authority.json — 4J3QuZt...
keys/orca-config.json        — 9Nr7o1m... (WhirlpoolsConfig account)
keys/pool-vault-a.json       — 4QD4Ggn... (USDC vault)
keys/pool-vault-b.json       — Qv51R47... (HOP vault)
keys/position-mint.json      — position NFT mint keypair
```

## Commands

```bash
npm install
cp .env.redemptionarc .env   # or set env vars directly

# Bootstrap (already done — do NOT re-run unless rebuilding)
DRY_RUN=false ALLOW_LIVE=true LIVE_TX_APPROVED=true npm run init-orca-config
DRY_RUN=false ALLOW_LIVE=true LIVE_TX_APPROVED=true npm run init-hop-token-badge
DRY_RUN=false ALLOW_LIVE=true LIVE_TX_APPROVED=true HOP_PRICE_USDC=0.0001 npm run init-pool
DRY_RUN=false ALLOW_LIVE=true LIVE_TX_APPROVED=true npm run init-tick-arrays
DRY_RUN=false ALLOW_LIVE=true LIVE_TX_APPROVED=true SEED_USDC=290 npm run add-liquidity

# Swap SOL → USDC (for funding)
DRY_RUN=false ALLOW_LIVE=true LIVE_TX_APPROVED=true SOL_LAMPORTS=3500000000 npm run swap-sol-for-usdc

# T22 ring flash cycle
SOLANA_RPC_URL=<rpc> DRY_RUN=false ALLOW_LIVE=true FLASH_AMOUNT_USDC=100000 npm run not-stacc-replicate

# Keeper loop
SOLANA_RPC_URL=<rpc> FLASH_AMOUNT_USDC=100000 npm run keeper-loop

# Snapshot
npm run snapshot

# Fork read-only readiness gate
npm run fork-readiness
```

## Program Instructions (active in GxRHMB9a...)

| Instruction | Handler |
|-------------|---------|
| initialize_config | Anchor |
| initialize_fee_tier | Anchor |
| initialize_tick_array | Anchor |
| initialize_pool_v2 | Anchor |
| initialize_config_extension | Anchor |
| initialize_token_badge | Anchor |
| open_position | Anchor |
| close_position | Anchor |
| increase_liquidity_v2 | Pinocchio |
| decrease_liquidity_v2 | Pinocchio |
| swap_v2 | Anchor |
| collect_protocol_fees_v2 | Anchor |

## Flash Deep Vol Roadmap (NEXT)

Single atomic TX: MarginFi flash ($559k) → addLiq → swap USDC→HOP→USDC → removeLiq → repay.
Est. ~$8.50/TX from LP fees + T22 transfer fees, ~$13k/hr at 25 TPS.

Files to build:
- `src/scripts/flash-deep-vol-orca.ts` — atomic flash+LP+swap+remove on OUR Whirlpool
- `src/scripts/flash-deep-vol-orca-loop.ts` — keeper loop

## Known Bugs Fixed

1. Pinocchio `WHIRLPOOL_PROGRAM_ID` constant must be OUR program ID (`GxRHMB9a...`), not official Orca — otherwise all pinocchio handlers fail with `AccountOwnedByWrongProgram` (Custom 3007).
2. `initialize_token_badge` feature flag check removed from handler — config flag not set on our fork.
3. `is_admin_key` constraint removed to allow crank as fee authority.

## Estado del sistema (Mayo 2026)

Motor principal: flash-deep-vol-orca-loop.ts
  - SIM_OK verificado
  - $0.149/TX neto = $178.80/hora a 20 TX/min
  - Epoch watcher activo → arranca en epoch 978
  - ALT: EjNKyxzhMCDX63sXLNddioHNZmyyNaHUipsXR65AmwAC

Pendiente:
  [ ] Primera TX live post-epoch 978
  [ ] collect_fees_v2 periódico (LP fees → wallet)
  [ ] Escalar SWAP_USDC tras confirmar TX live
  [ ] Jupiter indexing del pool

Leer SISTEMA.md antes de modificar cualquier script.
