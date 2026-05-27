# Post-flip report — Epoch 978

**Fecha:** 2026-05-27  
**Estado:** Sistema operativo, primera fase completada

## TL;DR

Epoch 978 flipeó a T22=1bps. Loop v2 corrió 125 cycles confirmados en la primera hora (12:36–12:49 UTC). $246.67 USDC recuperados al wallet vía sweep T22 (bug crítico de withheld corregido esta sesión). $88 worth de LP fees pendientes de cobrar (extracción bloqueada por collect_fees_v2 del fork — upgrade en curso sesión paralela).

## Configuración corrida

| Param | Valor |
|-------|-------|
| RT_COUNT | 3 |
| ADDLIQ_USDC | 700 |
| SWAP_USDC | 500 |
| SWEEP_EVERY | 50 |
| EXTRACT_EVERY | 25 |
| JITO_SKIP | true |
| ALTERNATE_DIRECTION | true |

## Métricas reales medidas

| Métrica | Valor |
|---------|-------|
| TXs confirmadas | 125 |
| Inclusion rate | 96.3% |
| Rate sostenido | ~10 TX/min |
| cashNetProj/TX (proyectado) | +$0.28 |
| Drift por cycle | +3 ticks (hacia center) |
| USDC drainage/cycle (on-chain) | -$0.277381 |
| HOP drainage/cycle (on-chain) | -8,845.730 HOP |
| USDC recuperado (sweep T22) | +$246.67 |
| HOP withheld procesado | 3,015,763 HOP |
| LP fees position pendientes | $48.86 USDC + 392,234 HOP |

## Balance del crank (post-sweep)

| Asset | Antes de sesión | Post-sweep |
|-------|----------------|------------|
| SOL | 1.18246 | ~1.18 |
| USDC | 27.455595 | ~274.12 |
| HOP spendable | 5,771,928 | reducido por loop |

## Bugs encontrados y resueltos esta sesión

### Bug 1 — runSweep early-exit en withheld=0

`runSweep()` y `main()` leían `getMint().withheldAmount` (siempre 0 hasta harvest).  
Esto causaba `SKIP_NO_WITHHELD` con 3.01M HOP atrapado en `transferFeeAmount.withheldAmount` de las ATAs.

**Fix:** iterar sobre `allSources` con `getAccount + getTransferFeeAmount`, sumar `ataWithheld`, combinar con `mintWithheld`.  
También: `main()` tenía `RING_ATAS` solo en la instrucción harvest — añadido `TOKEN_VAULT_B + crankHopAta`.

**Impacto:** $246.67 USDC recuperados que llevaban bloqueados desde el deploy.

### Bug 2 — tokenMaxA buffer plano (sesión previa, ya corregido)

Buffer fijo de 5000 µUSDC causaba error 6017 TokenMaxExceeded tras el primer cycle.  
Fix: `addLiqMicro / 1000n` (0.1% proporcional).

## TX de referencia

| Evento | TX Sig |
|--------|--------|
| Primera TX live (epoch 978) | `5wyb6TkU8UdTJWPH6PLdsKGdvVH9WkKyQ8FCnD9LMMCtKML6ZTTFmRAptAjFKPQr3bFQNEwVvV4gNdGq3zEG7Heh` |
| Última TX loop v2 (125) | `4QTuDrHg8x6u7X6WLti6a2QN3QETt6GH8GMVEhbAS5BV71nWTrhAsVWvMUdgo7rVDXLd9kd2RiuahXXU5azEytLQ` |
| Sweep T22 $246.67 | `3B7Dmm46ZmV2rDuqB6SQpRGNcYQDNxLJbrr1fSbGY6EzG61C2UxyQaxdqpbMLPKXjNeGbBfSCzgUzAsL9wx3PEkD` |

## Direcciones relevantes

| Componente | Address |
|------------|---------|
| Crank wallet | `8pWEfpJas2tgS8iE7ZyHKNjeDSEixqSwK12W4tagNJ3S` |
| Crank USDC ATA | `5BK5sqF2vH8o1BBrSukV44ujpu19rpgvJFedGC8GzF9X` |
| Crank HOP ATA | `2s2Au2bxsvF5cHbdhfP4JaFX8FXp5wXzQxBj15PNPEkD` |
| Pool USDC/HOP | `8aoWgf7ycbeKv6BTFCdUj4JR7Y4mXWuPZWEUhmuzN5ZL` |
| Whirlpool fork | `GxRHMB9a6XE8BqGPeNb9UkJUPvbvrPoPgNTJPJJA4n8h` |
| LP Position | `ErgQU48egJMNBLZeVkdjrtZrSWUQJCky3deh2B4U1YPQ` |
| HOP mint T22 | `HZF5k7h39hkysoSZ4ZfmWc55PhvW7ntVvVqdXFCyYGh3` |
| MarginFi account | `9SdjygeTAmMrgCQjBAGNAAjjYE6U35ARWcuvvxFZJHz` |
| ALT | `EjNKyxzhMCDX63sXLNddioHNZmyyNaHUipsXR65AmwAC` |

## Trabajo completado

- [x] Loop v2 multi-RT + output-spec swap2
- [x] Buffer proporcional tokenMaxA
- [x] Alternate direction para cancelar tick drift
- [x] Telemetría completa (tickBefore/After, drift, rangeUtilization, swapDirection)
- [x] Safety margin (pausa si tick cerca de rangos)
- [x] Sweep T22 fix (ATA withheld sumado correctamente)
- [x] 125 cycles confirmados on-chain
- [x] $246.67 USDC recuperados al wallet

## Trabajo pendiente

- [ ] Deploy fork upgrade con `collect_fees_v2` (sesión paralela, blocker SOL)
- [ ] Verificar collect_fees_v2 funciona post-deploy (DRY_RUN=true auto-compound-extract)
- [ ] Extract LP fees live ($48.86 USDC + 392K HOP de position.feeOwedA/B)
- [ ] Relanzar loop con sweep arreglado
- [ ] Monitorear HOP runway (replenish via extract frecuente)
- [ ] Decidir si subir RT_COUNT a 5 (más T22 pero más CU)
- [ ] VPS deploy 89.167.71.153 para 24/7

## Análisis del USDC drainage

USDC drain medido on-chain: **-$0.277/cycle** (muy consistente, 5 samples).

Causa: CLMM impermanent loss intra-TX. addLiq al tick T, 3 round-trips driftan tick ~+9, removeLiq al tick T+9 devuelve menos USDC (precio USDC/HOP bajó = HOP se revalorizó ligeramente). No es bug — es física del CLMM.

Offset: LP fees acumulan en `position.feeOwedA` (~$48.86 USDC). Una vez colectadas (post-fork upgrade), este drain queda más que cubierto.

Net proyectado real: `cashNetProj_T22 - drain_IL + feeOwedA_amortizado` = ~+$0.28 - $0.28 + X/cycles_para_amortizar.
Con EXTRACT_EVERY=25: cada 25 cycles se colectan ~$X LP fees que cubren el drift.
