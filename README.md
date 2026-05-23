# RedemptionArc

Flywheel engine: own Orca Whirlpool fork + MarginFi flash + HOP T22 ring.

## Live State (2026-05-23)

### Own Orca Whirlpool (GxRHMB9a6XE8BqGPeNb9UkJUPvbvrPoPgNTJPJJA4n8h)

Forked from Orca, stripped to 12 instructions, deployed mainnet.

| Component | Address |
|-----------|---------|
| Program | `GxRHMB9a6XE8BqGPeNb9UkJUPvbvrPoPgNTJPJJA4n8h` |
| WhirlpoolsConfig | `9Nr7o1muxPfcsxv4WtTN2GdUFKhUsdR7WHejyJdesTmY` |
| FeeTier (tick_spacing=64) | `7v5Rhe37P5BrPTtEeumH1oa6aBQg2tTzFN3r58Sfe4m7` |
| HOP TokenBadge | `HVcso86ZCfodDrGhSxiwuegx1K8xJqWso1M7Hs6UcwsE` |
| USDC/HOP Pool | `8aoWgf7ycbeKv6BTFCdUj4JR7Y4mXWuPZWEUhmuzN5ZL` |
| LP Position A | `ErgQU48egJMNBLZeVkdjrtZrSWUQJCky3deh2B4U1YPQ` |
| LP Position B | `3Qx4NtMhd9vDKWbcdUAu2qrwpypbXEGy95N4cYgdyaGk` |

Pool: USDC (tokenA) / HOP (tokenB), price = $0.0001/HOP, tick_spacing = 64.
Tick arrays initialized: [84480, 90112, 95744]. Position range: [84480, 101312].
LP seeded total: ~290.45 USDC + ~6.32M HOP, liquidity ≈ 78,748,145,963.

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

## KPX9 Official Orca — CLOSED

Config `KPX9QQP4GL...` was acquired and all authorities transferred to crank.
Pool and position deployed, then closed: `set_config_feature_flag` is governance-only
(hardcoded Orca admin keys), so HOP token badge could not be created and swaps
would fail. LP position `59LWLWVU...` removed 2026-05-23; 0.445 USDC + 3562 HOP
recovered and redeployed to fork pool as Position B.

## Pending

- [ ] flywheel-bot.ts: sim clean + cash proof receipt → live at $1k flash
- [ ] flywheel-bot-loop.ts: keeper loop
- [ ] flash-deep-vol-orca.ts: atomic flash+addLiq+swap+removeLiq on OUR Whirlpool
- [ ] flash-deep-vol-orca-loop.ts: keeper loop
- [ ] collect-protocol-fees-keeper.ts: auto-collect when threshold met
- [ ] Scale pool TVL to $50k+ (more SOL → swap → add liquidity)
- [ ] Jupiter indexing of our pool (pool too new, non-standard program)
- [ ] Epoch 977: HOP fee → 1bps active — monitor T22 transfer fee epoch
