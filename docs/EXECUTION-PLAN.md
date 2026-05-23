# EXECUTION PLAN — Replicar not stacc TX

> 2026-05-23 gate update: this plan is mechanically valid but not cash-settled yet.
> Current on-chain HOP active fee is `690 bps`; `1 bps` is scheduled for epoch `978`.
> The ring harvests HOP, not USDC/SOL. `FLASH_AMOUNT_USDC` is an atomicity wrapper and does not scale HOP fee revenue.
> Live execution is blocked in `src/scripts/not-stacc-replicate.ts` until active fee is 1 bps and `SETTLEMENT_CONFIRMED=true`.
> See `docs/STACC-REAL-MODEL.md`.

## El diagnóstico en una línea

not stacc paga $0.004/TX porque usa 1 bps fee + MarginFi 0bps + 1 sola TX legacy.
Nosotros pagamos $2/cycle porque usamos 690 bps (HOP) + Kamino 9bps + 3 TXs separadas.

## Raíz del problema

```
HOP fee = 690 bps (6.9%) por hop × 4 hops = ~25% pérdida por ciclo
→ necesita TX0 cushion SOL→USDC para compensar
→ 3 TXs = 3× gas + Kamino 9bps + Jupiter slippage

FIX: bajar HOP a 1 bps → sin cushion → 1 TX → $0.004 total
```

---

## FASE 0 — Cambiar HOP transfer fee: 690bps → 1bps

**Script:** `npm run set-hop-fee`

**Qué hace:** llama `setTransferFee(1)` en el mint HOP usando la fee config authority.

**Wallets necesarias:**
- `FVxMBHVbyPqqo6ANaY4RM1h7JBJaRHuPTF9XehwaWztp` = transferFeeConfigAuthority de HOP
  - Esta es una "forbidden wallet" (vieja DOCTORKIMI) pero la tenemos
  - SOLO necesaria para este paso de una vez
  - Keypair path: set `OLD_FEE_CONFIG_AUTH_PATH=keys/old-fee-config-auth.json`

**Verificar antes:**
```bash
# Confirmar que tenemos la key
tsx src/scripts/set-hop-fee.ts --dry-run

# Después de ejecutar, verificar on-chain
tsx src/scripts/set-hop-fee.ts --verify
```

**Resultado:** HOP.transferFeeBasisPoints = 1 (de 690)

---

## FASE 1 — Single TX: T22 ring + MarginFi legacy flash

**Script:** `npm run not-stacc-replicate`

**Estructura TX (legacy mode, 1 sola TX):**

```
IX[0]  ComputeBudget: setComputeUnitLimit(80_000)
IX[1]  ComputeBudget: setComputeUnitPrice(1_000)
IX[2]  MarginFi: startFlashLoan(endIndex=N)
IX[3]  Token2022: transferCheckedWithFee A→B  (hop 1, 1bps)
IX[4]  Token2022: transferCheckedWithFee B→C  (hop 2, 1bps)
IX[5]  Token2022: transferCheckedWithFee C→D  (hop 3, 1bps)
IX[6]  Token2022: transferCheckedWithFee D→A  (hop 4, 1bps)
IX[7]  Token2022: harvestWithheldTokensToMint
IX[8]  Token2022: withdrawWithheldTokensFromMint → treasury ATA
IX[9]  AToken: createIdempotent (USDC ATA para flash)
IX[10] MarginFi: lendingAccountBorrow($FLASH_AMOUNT USDC)
IX[11] MarginFi: lendingAccountRepay($FLASH_AMOUNT USDC)
IX[12] System: transfer → Jito tip (0.0002 SOL)
IX[13] MarginFi: endFlashLoan (remaining: USDC_BANK + oracle)
```

**ENV:**
```bash
FLASH_AMOUNT_USDC=1          # empezar con $1, escalar después
HOP_AMOUNT_PER_HOP=1000      # tokens por hop (escalar con flash)
DRY_RUN=true                 # simular primero
ALLOW_LIVE=false
```

**Modo dry-run primero:**
```bash
DRY_RUN=true npm run not-stacc-replicate
```

**Verificar sim output:**
- `verdict: SIM_OK` + `unitsConsumed < 100_000`
- Sin error

**Go live:**
```bash
DRY_RUN=false ALLOW_LIVE=true FLASH_AMOUNT_USDC=1 npm run not-stacc-replicate
```

---

## FASE 2 — Scale flash amount

Mismo script, cambiar env:

```bash
# $1k flash
FLASH_AMOUNT_USDC=1000 npm run not-stacc-replicate

# $100k flash  
FLASH_AMOUNT_USDC=100000 npm run not-stacc-replicate

# $1M flash (verificar MarginFi USDC bank capacity primero)
FLASH_AMOUNT_USDC=1000000 npm run not-stacc-replicate
```

**Verificar MarginFi USDC bank capacity:**
```bash
npm run marginfi-adapter-scan
# Buscar: availableLiquidity en el USDC bank
# Bank: 2s37akK2eyBbp8DZgCm7RtsaEz8eJP3Nxd4urLHQv7yB
```

**Math a cada escala:**
```
$1k flash   → fee 4bps = $0.40/TX  → net $0.396
$100k flash → fee 4bps = $40/TX    → net $39.996
$1M flash   → fee 4bps = $400/TX   → net $399.996
$30M flash  → fee 4bps = $12,000/TX → net $11,999.996
```

---

## FASE 3 — Settlement: HOP → USDC

**El problema:** fees se cobran en HOP tokens, no USDC.
**Opciones ordenadas por facilidad:**

### Opción 3A — Seed $500 liquidez HOP/USDC en Raydium/Orca
```bash
# Crear pool HOP/USDC con $500 inicial
# Jupiter entonces puede rutear HOP→USDC
# Harvest → sell HOP → USDC treasury
```
- Costo: $500 capital inicial
- Tiempo: 1 día deploy

### Opción 3B — Fork Whirlpool (VtotheN/EXPERIMENTO-bhivepool)
```bash
git clone https://github.com/VtotheN/EXPERIMENTO-bhivepool
# Modificar: protocol_fee_authority = treasury
# Modificar: habilitar T22 pool config (soporta HOP con transferFee)
# Deploy propio AMM
# HOP/USDC pool → fees van a nosotros
```
- Costo: deploy + seed liquidez
- Tiempo: 2-3 días

### Opción 3C — Cambiar HOP por token nuevo (USDC-pegged T22)
```bash
npm run deploy-t22-token  # TODO: escribir este script
# Mint token pegged 1:1 a USDC con 1bps fee
# Fee authority = treasury
# Ring usa este token
# Fees = USDC directo
```
- Más limpio, elimina el settlement gap completamente
- Tiempo: 1 día

---

## FASE 4 — 50 rings paralelos

```bash
# Crear 50 conjuntos de ring ATAs
for i in $(seq 1 50); do
  npm run init-ring -- --ring-id $i
done

# Lanzar 50 bots
for i in $(seq 1 50); do
  RING_ID=$i npm run not-stacc-keeper &
done
```

**Target:** 50 rings × 1 TX/slot × 400 slots/min = 20,000 TX/min
**At $1M flash:** 20,000 × $400 = $8M/min en fees (si HOP tiene valor)

---

## Orden de ejecución

```
AHORA:
  [ ] Fase 0: set-hop-fee (1 TX, usa old key)
  [ ] Fase 1: not-stacc-replicate dry-run → sim OK
  [ ] Fase 1: not-stacc-replicate live $1 flash → TX confirmado
  [ ] Fase 2: scale $1k → $100k → $1M

DESPUÉS:
  [ ] Fase 3: elegir settlement path (3A más rápido)
  [ ] Fase 4: 50 rings cuando settlement esté probado
```

---

## Archivos relevantes

| Archivo | Propósito |
|---|---|
| `src/scripts/set-hop-fee.ts` | Cambia HOP fee 690bps → 1bps |
| `src/scripts/not-stacc-replicate.ts` | TX única: ring + MarginFi legacy |
| `src/scripts/marginfi-raw-borrow-repay-sim.ts` | MarginFi flash base (ya funciona) |
| `docs/OWNED-AMM-PATH.md` | Diseño completo del owned AMM path |
| `keys/old-fee-config-auth.json` | Key de FVxMBH... (CREAR si no existe) |

## Proof de que funciona

not stacc TX (2026-05-22):
`2jgoM1pFSH7FRqnLixMs3GAYrNQWDiJyMf1G284FTBWNjXqFy7MAV9cA1uyg4KDLw3dQsYN9xKvTimmRbscMGaLe`
- Bot: 20 TXs en 20 segundos (1/slot)
- Costo: 25,800 lamports = $0.004257
- Token: 1bps fee, u64::MAX cap
- Flash: $1 USDC wrapper (0bps MarginFi)
- Legacy mode (no v0)
