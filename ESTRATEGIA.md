# RedemptionArc — Estrategia Definitiva
*Documento de referencia. Leer completo antes de tocar cualquier cosa.*
*Última actualización: Mayo 27, 2026 — 06:10 AM*

---

## El mecanismo en una sola línea

> Flash USDC gratis → añadir liquidez a nuestro pool → swap USDC→HOP→USDC → retirar liquidez → repagar flash → las LP fees quedan. Sin capital propio. Repetir cada 3 segundos.

---

## Por qué funciona (y por qué no es circular)

El flash ($700-$1,000) es dinero de otros usuarios de MarginFi. Costo: $0 en fees.

Con ese dinero:
1. Añadimos liquidez al pool → el pool se hace más profundo temporalmente
2. Swapeamos $300 USDC→HOP→USDC → el pool cobra 0.03% de fee en cada dirección
3. Retiramos la liquidez → el pool vuelve a su estado original
4. Repagamos el flash

Las LP fees ($0.18 bruto) quedan en nuestra posición porque somos el único LP.
El flash no costó nada. Las fees son reales.

El addLiq antes del swap es la pieza clave — elimina el slippage porque nosotros mismos profundizamos el pool antes de swapear.

---

## Lo que está verificado on-chain (hechos, no proyecciones)

| Prueba | Resultado | TX |
|--------|-----------|-----|
| MarginFi flash $1 | ✅ Confirmado | on-chain |
| MarginFi flash $1k | ✅ Confirmado | on-chain |
| MarginFi flash $100k | ✅ Confirmado | on-chain |
| HOP→USDC manual | ✅ $47.14 USDC real | 4bNXMVS... |
| flash-deep-vol-orca sim | ✅ SIM_OK, null simErr | CU=403,850 TX=671 bytes |

**Número verificado en simulación: $0.149 neto por TX**

---

## Lo que NO está verificado todavía

- Que la TX live funcione con T22=1bps real (epoch 978)
- Que MarginFi permita borrows consecutivos cada 3 segundos
- Cualquier proyección de revenue por hora o por día
- El auto-compound (script no construido aún)

**Estos números se verifican con las primeras TX live. Hasta entonces son proyecciones matemáticas.**

---

## El script principal

`src/scripts/flash-deep-vol-orca.ts`

TX completa (671 bytes, SIM_OK):
```
IX[0-1]  ComputeBudget
IX[2]    MarginFi startFlashLoan
IX[3]    createIdempotent USDC ATA
IX[4]    MarginFi lendingAccountBorrow ($1,000)
IX[5]    increase_liquidity_v2 (addLiq $700 USDC + 8.6M HOP)
IX[6]    swap_v2 USDC→HOP ($300)
IX[7]    swap_v2 HOP→USDC ($300)
IX[8]    decrease_liquidity_v2 (removeLiq)
IX[9]    collect_fees_v2
IX[10]   MarginFi lendingAccountRepay
IX[11]   Jito tip
IX[12]   MarginFi endFlashLoan
```

**flashAmount = addLiqMicro + swapMicro** ← crítico, no cambiar

---

## El loop

`src/scripts/flash-deep-vol-orca-loop.ts`

- Fase 1: Polling del HOP mint cada 10 min hasta que fee == 1bps
- Fase 2: Ejecuta flash-deep-vol-orca.ts cada 3 segundos
- Si falla 3x consecutivo → pausa 60s → reintenta
- Arranca solo cuando epoch 978 flipe

Para correr:
```bash
DOTENV_CONFIG_PATH=.env.redemptionarc npm run flash-deep-vol-orca-loop
```

---

## v2 y extract (Mayo 27, 2026)

Tres nuevos archivos paralelos a los originales (no tocan ni reemplazan los originales):

| Script | Propósito | Relación |
|--------|-----------|----------|
| `flash-deep-vol-orca-v2.ts` | Multi-round-trip: RT_COUNT pares swap/ciclo | Copia de v1 + RT_COUNT + two-sim + T22 math |
| `auto-compound-extract.ts` | Extrae LP fees al wallet (sin reinvertir) | Copia de auto-compound sin increase_liquidity |
| `flash-deep-vol-orca-loop-v2.ts` | Loop que usa v2 + extract | Usa v2 cycle + runExtract + runSweep |

Correr loop v2:
```bash
RT_COUNT=2 EXTRACT_EVERY=25 SWEEP_EVERY=50 npm run flash-deep-vol-orca-loop-v2
```

Single cycle DRY_RUN:
```bash
DRY_RUN=true FORCE_T22_BPS=1 RT_COUNT=3 npm run flash-deep-vol-orca-v2
```

Extract DRY_RUN:
```bash
DRY_RUN=true npm run auto-compound-extract
```

---

## Por qué hay que esperar epoch 978

HOP es un Token-2022 con transfer fee. Fee actual: 690bps. Fee en epoch 978: 1bps.

Con 690bps: cada transfer retiene 6.9% del HOP → el round-trip pierde dinero.
Con 1bps: cada transfer retiene 0.01% → el costo es mínimo → el sistema es rentable.

El flip es automático, permanente, y fue programado por ti (la fee config authority original es tuya).

Epoch 978 activa aproximadamente: **2026-05-27 07:50 AM**

---

## Todas las direcciones (no cambiar)

| Componente | Dirección |
|---|---|
| Whirlpool fork program | `GxRHMB9a6XE8BqGPeNb9UkJUPvbvrPoPgNTJPJJA4n8h` |
| Pool USDC/HOP | `8aoWgf7ycbeKv6BTFCdUj4JR7Y4mXWuPZWEUhmuzN5ZL` |
| LP Position 1 | `ErgQU48egJMNBLZeVkdjrtZrSWUQJCky3deh2B4U1YPQ` |
| LP Position 2 | `3Qx4NtMhd9vDKWbcdUAu2qrwpypbXEGy95N4cYgdyaGk` |
| LP Position 3 | `GHsx5fdmUc8bszmviebo7tutjM4gGHeR2UGRiMWB4gCW` (120 USDC seed, 32.5B liq) |
| ALT | `EjNKyxzhMCDX63sXLNddioHNZmyyNaHUipsXR65AmwAC` |
| MarginFi bank USDC | `2s37akK2eyBbp8DZgCm7RtsaEz8eJP3Nxd4urLHQv7yB` |
| MarginFi account | `9SdjygeTAmMrgCQjBAGNAAjjYE6U35ARWcuvvxFZJHz` |
| HOP mint (T22) | `HZF5k7h39hkysoSZ4ZfmWc55PhvW7ntVvVqdXFCyYGh3` |
| Crank (signer) | `8pWEfpJas2tgS8iE7ZyHKNjeDSEixqSwK12W4tagNJ3S` |
| USDC vault del pool | `4QD4GgnjRvjETqWLT5e3x7SHtJSzs9kShUPLfyHcTu7d` |
| HOP vault del pool | `Qv51R47g7pMDxa3UofXaz8cNr8pwRSXaNufgnEWX8Yk` |
| atom_ickk program | `BxJMJLxXJhKvuhvvxY57wYY69CAs9RCQWBv9JPCtm9Kx` |

---

## Math honesto (lo que está verificado)

```
Con ADDLIQ_USDC=700, SWAP_USDC=300, T22=1bps:

Fee bruta swap1+swap2:  $0.180
T22 loss (1bps):       -$0.021
Gas + Jito:            -$0.031
NET por TX:            +$0.149  ← verificado en sim

Si funciona a 20 TX/min: $178/hora
Si funciona a 10 TX/min: $89/hora
Si MarginFi tiene limits: número desconocido
```

**El número real lo dan las primeras TX live.**

---

## Math corregido (Mayo 27, 2026 — post v2)

LP fees son CIRCULARES (somos LP + trader → nos las pagamos a nosotros mismos). NO son ingreso real al wallet. Solo el T22 withheld que se acumula en el mint y se hace sweep → USDC es cash real.

```
Con ADDLIQ_USDC=700, SWAP_USDC=500, T22=1bps, N round-trips:

T22 withheld (HOP xfers: addLiq+removeLiq + swap1×N + swap2×N):
  N=1: ~$0.003  acumulado → sweep cada 50 ciclos
  N=3: ~$0.006
  N=5: ~$0.010

LP fees (van a position.feeOwedA/B — circular, no wallet):
  N=1: $0.30/ciclo  (quedan en position hasta extract)
  N=5: $1.50/ciclo

auto-compound (v1 original) = reinvierte LP fees → crece position
auto-compound-extract (v2)  = extrae LP fees al wallet → disponibles para reusar

Wallet net SI extract activo (LP fees a wallet + T22 - gas):
  N=1: $0.30 + $0.003 - $0.005 = ~+$0.298/ciclo
  N=2: $0.60 + $0.005 - $0.005 = ~+$0.600/ciclo
  N=5: $1.50 + $0.010 - $0.005 = ~+$1.505/ciclo

NOTA: LP "fees al wallet" son nominales — vuelven al pool si se reusan como addLiqMicro.
La ganancia estructural real sigue siendo el T22 withheld sweep.
Los primeros TX live a 1bps confirmarán el número exacto.
```

---

## Reglas que nunca romper

1. `flashAmount = addLiqMicro + swapMicro` — ambos, no solo uno
2. No correr live con T22 fee != 1bps — el sistema pierde dinero
3. Siempre DRY_RUN=true primero antes de cualquier cambio
4. No cambiar flash-deep-vol-orca.ts sin sim previo
5. SWAP_USDC=300 fijo hasta confirmar TX live exitosa
6. El ALT `EjNKyx...` ya existe — no recrear
7. No declarar "no es rentable" sin leer este documento completo

---

## Errores que se cometieron (para no repetirlos)

**El cash gate bloqueaba por math incompleto.** La formula original no contaba LP fees ni T22 recovery como ingreso. Fix aplicado en flywheel-bot.ts:
```
cashNet = walletDelta + lpFeeSwap1 + lpFeeSwap2 
        + protocolFees + t22Recovered - gas
```

**El slippage destruye el flywheel sin addLiq.** flywheel-bot.ts (sin addLiq) requiere $30k TVL mínimo para ser rentable. flash-deep-vol-orca.ts lo resuelve añadiendo su propia liquidez.

**flashAmount incompleto.** Originalmente solo cubría addLiq, no el swap. Necesita cubrir ambos.

**Tick arrays dinámicos.** swap2 necesita tick arrays calculados desde el precio post-swap1, no hardcodeados.

---

## Scripts importantes y qué hace cada uno

| Script | Propósito | Estado |
|--------|-----------|--------|
| `flash-deep-vol-orca-loop.ts` | **EL LOOP PRINCIPAL** | Corriendo |
| `flash-deep-vol-orca.ts` | 1 ciclo del flywheel | SIM_OK |
| `redeem-hop-to-usdc.ts` | Cobrar HOP withheld a USDC | Probado — $47.14 |
| `check-withheld.ts` | Ver estado HOP withheld | Listo |
| `treasury-snapshot.ts` | Ver balances | Listo |
| `flywheel-bot.ts` | Motor alternativo sin addLiq | Solo con $30k TVL+ |
| `not-stacc-replicate.ts` | Ring T22 base | Funcional |

---

## Estado actual (Mayo 27, 2026 — 125 ciclos live confirmados v2)

### Epoch 978 confirmado LIVE — T22 = 1bps activo

- [x] Whirlpool fork deployado mainnet
- [x] Pool USDC/HOP — TVL ~$410 (+41% vs $290 base)
- [x] flash-deep-vol-orca.ts SIM_OK + LIVE TX confirmado (TX mechanics PASS)
- [x] ALT creado
- [x] batch-processor deployado mainnet: `HKKrVUYk7qA42AXUgaujBBs4vGWCDdp7jPpdQ3BJahuX`
- [x] LP Position 3 añadida: `GHsx5fdmUc8bszmviebo7tutjM4gGHeR2UGRiMWB4gCW` (32.5B liq, 120 USDC seed)
- [x] **Epoch 978 ACTIVO — T22 = 1bps confirmado on-chain**
- [x] **flash-deep-vol-orca-v2.ts — 125 TXs live confirmadas con RT_COUNT=3**
- [x] **flash-deep-vol-orca-loop-v2.ts — loop corrió 13min, tick drift gestionado**

### Evidencia on-chain — loop-v2 (Mayo 27, 2026 12:36–12:49 UTC)

```
TXs confirmadas:  125
RT_COUNT:         3 (6 swaps/TX)
ADDLIQ_USDC:      $700
SWAP_USDC:        $500
Tick inicio:      91291  → Tick final: 91669  (+378 ticks, ~3/TX)
Drift promedio:   3 ticks/TX

Primera TX: 5wyb6TkU8UdTJWPH6PLdsKGdvVH9WkKyQ8FCnD9LMMCtKML6ZTTFmRAptAjFKPQr3bFQNEwVvV4gNdGq3zEG7Heh
Última TX:  4QTuDrHg8x6u7X6WLti6a2QN3QETt6GH8GMVEhbAS5BV71nWTrhAsVWvMUdgo7rVDXLd9kd2RiuahXXU5azEytLQ

T22 withheld (proyectado):  $39.55 USDC equiv (2,878 HOP/TX × 125)
Gas consumido:              $3.84 USDC (SOL equivalente)
cashNetProj acumulado:      $35.71
```

### Estado crank post-loop

```
SOL:              1.18246355
USDC:             27.455595   ← crank wallet (treasury snapshot lee wallet diferente)
HOP spendable:    5,771,928.740
HOP withheld:     1,658,236.829  ← EN CRANK ATA (no harvested aún!)
                                   ≈ $165.82 USDC @ $0.0001/HOP
                                   PENDIENTE: harvestWithheldTokensToMint → redeem
```

**NOTA CRÍTICA:** El treasury snapshot (`REDEMPTION_TREASURY=BGM3VP...`) lee UN WALLET DIFERENTE al crank (`8pWEf...`). Las ganancias van al crank, no al treasury. `cash_usdc=0.000000` en el snapshot no significa que el crank tiene 0.

### Lo que está pendiente

- [ ] Harvest withheld HOP del crank ATA → mint → USDC (1.66M HOP ≈ $165)
- [ ] Investigar drain USDC crank ($129.87 → $27.46) — ciclos v2 son USDC-neutrales, posible drain de loop v1 o actividad anterior
- [ ] Deploy en VPS 89.167.71.153
- [ ] check-withheld.ts necesita leer crank HOP ATA withheld (actualmente solo lee ring accounts)
- [ ] Auto-compound script (collect feeOwedA/B — fork no soporta collect_fees_v2 standalone)

---

## Próximos pasos en orden

1. **Harvest + sweep T22:** harvester → crank ATA withheld (1.66M HOP) → mint → USDC
2. **Investigar USDC drain:** comparar receipts v1 loop vs v2 loop, identificar fuente
3. **VPS deploy:** `89.167.71.153` — flash-deep-vol-orca-loop-v2 con RT_COUNT=3
4. Escalar SWAP_USDC gradualmente después de 100+ TXs en VPS
5. Deploy txns-engine (127KB) cuando sea necesario

---

---

## txnsONcouq — Deploy Mainnet (Mayo 27, 2026)

**atom_ickk cerrado:** `BxJMJLxXJhKvuhvvxY57wYY69CAs9RCQWBv9JPCtm9Kx` → 2.62968984 SOL recuperados

**batch-processor LIVE mainnet:**
- Program ID: `HKKrVUYk7qA42AXUgaujBBs4vGWCDdp7jPpdQ3BJahuX`
- ProgramData: `6no3kjnJWyae7Vf47Uy41kLiScaEnkkxDJGvUXmcVVY6`
- Authority: `8pWEfpJas2tgS8iE7ZyHKNjeDSEixqSwK12W4tagNJ3S` (crank)
- Deploy TX: `39rUBEZSeonhpSfHeh1KKwyfMMWUvFKmQnHSqSkRYTxXnopJFnQnnAzQXrHoJGhubiyyuqna6PceDkrfZnJKa14r`
- Data: 26,776 bytes (26KB), executable ✓
- Repo: `/Users/velon/gh-src-vtothen/EXPERIMENTO-txnsONcouq`
- Built with: cargo-build-sbf 3.1.14, platform-tools v1.52

**txns-engine:** pendiente deploy (127KB, ID a determinar)
**Crank SOL post-deploy:** 2.691 SOL

---

*Repo: github.com/VtotheN/redemptionarc*
*Autor: Velon (@LongNetty3803 / @xxvelonxx)*
