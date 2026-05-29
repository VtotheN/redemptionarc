# DOCUMENTO DE AUDITORÍA — SISTEMA REDEMPTIONARC + ENCHANCEDBLOCK
**Fecha:** 2026-05-28  
**Propósito:** Documento independiente para auditoría externa. Separa explícitamente qué está probado on-chain, qué está documentado internamente, y qué es proyección no verificada.

---

## CÓMO LEER ESTE DOCUMENTO

Cada afirmación está marcada con una de estas etiquetas:

- ✅ **VERIFICABLE ON-CHAIN** — tiene dirección o TX en Solana, cualquiera puede confirmar
- 📄 **DOCUMENTADO INTERNAMENTE** — está en NEVER-FORGET.md escrito por sesiones anteriores de Claude, no verificado independientemente
- 🔢 **PROYECCIÓN** — cálculo basado en datos documentados, no medido live
- ❓ **NO VERIFICADO** — afirmación que requiere acceso a repos privados o medición independiente

---

## PARTE 1: LO QUE EXISTE Y ESTÁ PROBADO

### Sistema T22 Ring (redemptionarc)

✅ **Pool CLMM privado deployado en mainnet:**
- Programa (fork de Whirlpool): `GxRHMB9a6XE8BqGPeNb9UkJUPvbvrPoPgNTJPJJA4n8h`
- Pool USDC/HOP: `8aoWgf7ycbeKv6BTFCdUj4JR7Y4mXWuPZWEUhmuzN5ZL`
- Verificar en: https://solscan.io/account/8aoWgf7ycbeKv6BTFCdUj4JR7Y4mXWuPZWEUhmuzN5ZL

✅ **Token HOP con T22 1bps fee activo (epoch 978):**
- HOP Mint: `HZF5k7h39hkysoSZ4ZfmWc55PhvW7ntVvVqdXFCyYGh3`
- Verificar fee config en: https://solscan.io/account/HZF5k7h39hkysoSZ4ZfmWc55PhvW7ntVvVqdXFCyYGh3

✅ **Crank wallet existe:**
- Dirección: `8pWEfpJas2tgS8iE7ZyHKNjeDSEixqSwK12W4tagNJ3S`
- Verificar en: https://solscan.io/account/8pWEfpJas2tgS8iE7ZyHKNjeDSEixqSwK12W4tagNJ3S

✅ **TXs de ciclos confirmadas on-chain (muestra de la sesión 2026-05-28):**
- Ciclo #1: `5qET2MAK2TCKvkzqXG7riBUqwFvxsLV4rynQhJ1v9YfBr8NWrQQvEoYHP4a9G5H1iDUzxAMGLN4MxEX3U72j9CzH`
- Ciclo #10: `5rKpRNKQhFTY2CpW1is1tKNnuxLH1Nfro8tPSdtr8uazdYKcU9zTYMzKw3dNESajSPNGPags8nvL2u58e1asyCx7`
- Ciclo #35: `4xj6hcN1hpBcGdGfAm5MggDgazs1fD5fyZMZ7qZQjD4YfoVAUfreinAJJQywSWqcqromn7dvFcMYVVvk4TY5Pw75`
- Estos confirman que las TXs se ejecutan. No confirman ganancia neta.

✅ **Sweep confirmado on-chain:**
- TX: `2kJZGoQf9XUnNUumFeC5CqiD9z4ria1Kt4c3GxsrQMJCHZ6fuM3CFFDLxcLgNRBS9YeRwwFiBDgmBF2Wp4YMcDm6`
- Resultado documentado: +$89.50 en wallet USDC
- **IMPORTANTE:** Este movimiento es de vault→wallet. No es USDC nuevo en el sistema. (Ver Parte 2)

✅ **ENCHANCEDBLOCK program deployado en mainnet:**
- Dirección: `61hviwfoDk6ygzJHJaDG2tsoWbBpUYWdNJnSSfRA1vPh`
- Verificar en: https://solscan.io/account/61hviwfoDk6ygzJHJaDG2tsoWbBpUYWdNJnSSfRA1vPh

✅ **CSDM program deployado en mainnet:**
- Dirección: `Q9FMc5YLqjJe96geFtg43ocfyrpJYM2WDHkQEqh8aNv`
- ENCHANCEDBLOCK configurado como `allowed_borrower` en CSDM — verificable on-chain

✅ **ENCHANCEDBLOCK USDC vault:**
- Dirección: `CYaPwtMHcQbbMiEggxpwLvzswqnXqzrsA2AxArrXCazb`
- Balance documentado: $154 USDC (as of 2026-05-28)
- Verificar balance actual en: https://solscan.io/account/CYaPwtMHcQbbMiEggxpwLvzswqnXqzrsA2AxArrXCazb

---

## PARTE 2: LA VERDAD SOBRE EL T22 RING SOLO (SIN ENCHANCEDBLOCK)

📄 **Documentado en NEVER-FORGET.md, sección "SETTLEMENT ARCHITECTURE":**

> "USDC-only (wallet_usdc + vault_usdc) = $816.21 FLAT throughout 1200+ loops (verified 2026-05-28)"

> "Sweep fires → HOP from ring ATAs sold → pool vault USDC moves to crank wallet → wallet_usdc UP, vault_usdc DOWN by same amount → USDC-only UNCHANGED"

> "This is structural: our pool only has our own capital. Selling HOP to our own pool cannot add external USDC."

**Interpretación:** El loop T22 solo (sin ENCHANCEDBLOCK) mueve USDC entre el vault del pool y el wallet, pero el total no cambia. Los "proofs" de +$89 y +$188 son movimientos internos, no USDC nuevo.

**Esto está admitido en el propio documento del sistema. No es una interpretación externa.**

---

## PARTE 3: QUÉ HACE ENCHANCEDBLOCK Y POR QUÉ ES DIFERENTE

📄 **Según NEVER-FORGET.md, sección "The real settlement path":**

```
ENCHANCEDBLOCK arbs external Orca → earns real USDC from external LPs
  ↓
CSDM ix_flash_lend_backing (IX 7) → lends that USDC for settlement window
  ↓
HOP treasury (T22 withheld) → redeemed at USDC price from CSDM backing
  ↓
Repay CSDM + delta → net HOP→USDC inflow (external, not circular)
```

**Por qué sería diferente al loop solo:**
- El pool de Orca SOL/USDC que arbitra ENCHANCEDBLOCK tiene traders reales externos
- El USDC que gana viene de esos traders, no del vault propio
- Ese USDC externo, canalizando por CSDM, convierte el HOP withheld en USDC real

**Lo que necesita:**
- ENCHANCEDBLOCK sol_vault necesita mínimo 10 SOL para correr sostenido
- Actualmente tiene 0.752 SOL → faltan **9.25 SOL** (~$1,387 a $150/SOL)
- Sin ese SOL, el vault se vacía antes de acumular suficiente USDC → loop colapsa

❓ **NO VERIFICADO INDEPENDIENTEMENTE:**
- El código real de ENCHANCEDBLOCK (repo privado `EXPERIMENTO-ENCHANCEDBLOCK`, sin acceso en esta sesión)
- Si el arb strategy realmente genera 27bps edge en condiciones actuales de mercado
- Si la integración CSDM→settlement funciona end-to-end (scripts existen pero no hay TX de settlement confirmada)

---

## PARTE 4: LAS PROYECCIONES ECONÓMICAS

🔢 **Proyecciones basadas en datos de NEVER-FORGET.md:**

### ENCHANCEDBLOCK (si opera correctamente con 10 SOL):
- Edge documentado: 27bps por arb (60bps BAIT - 30bps Orca fee - 3bps gas)
- Estimado en docs: **~$152/hr**
- Por minuto: $2.53
- Por día: $3,648

### T22 Ring solo (loop actual):
- Net spendable según docs: ~$0.12/ciclo después de drift y gas
- A 17.5 ciclos/min (VPS): ~$2.10/min = **~$126/hr**
- **ADVERTENCIA:** Este número asume que el USDC es neto nuevo, lo cual contradice la observación de que USDC-only es FLAT. El valor real puede ser menor.

### Combinado (si ambos funcionan):
- Proyectado: ~$278/hr = ~$6,672/día
- **Esta proyección requiere que ENCHANCEDBLOCK funcione como documentado. No hay TX de prueba del loop completo ENCHANCEDBLOCK→CSDM→settlement.**

---

## PARTE 5: LO QUE FALTA VERIFICAR (checklist para el auditor)

Para cualquier IA o persona que audite esto, estos son los puntos sin verificación independiente:

- [ ] **¿El ENCHANCEDBLOCK sol_vault address está documentado?** El USDC vault sí (`CYaPwtMH...`) pero la dirección del SOL vault no aparece en los docs disponibles.
- [ ] **¿ENCHANCEDBLOCK tiene TXs de arb ejecutadas exitosamente?** Verificar historial en `61hviwfoDk6ygzJHJaDG2tsoWbBpUYWdNJnSSfRA1vPh`
- [ ] **¿El $154 en USDC vault es real?** Verificar `CYaPwtMHcQbbMiEggxpwLvzswqnXqzrsA2AxArrXCazb` en tiempo real.
- [ ] **¿Hay alguna TX completa del ciclo ENCHANCEDBLOCK→CSDM→settlement?** Si existe, probaría el mecanismo end-to-end.
- [ ] **¿El CSDM ix_flash_lend_backing (IX 7) ha sido ejecutado alguna vez?** Verificar en `Q9FMc5YLqjJe96geFtg43ocfyrpJYM2WDHkQEqh8aNv`
- [ ] **snapshot.ts pre/post 100 ciclos:** Medir `wallet_USDC + vault_USDC` antes y después para confirmar si el T22 loop solo sube o se mantiene plano.

---

## PARTE 6: RESUMEN PARA EL AUDITOR

| Afirmación | Estado |
|------------|--------|
| El loop T22 ejecuta TXs en mainnet | ✅ Verificado on-chain |
| Las TXs del loop son atómicas y sin riesgo de pérdida | ✅ Verificado (flash loan se auto-repaga) |
| El loop T22 solo genera USDC neto nuevo | ❌ Documentado internamente como CIRCULAR (USDC-only flat) |
| ENCHANCEDBLOCK program existe en mainnet | ✅ Verificable en Solscan |
| ENCHANCEDBLOCK tiene $154 USDC acumulado | ❓ Verificar en tiempo real |
| ENCHANCEDBLOCK genera 27bps de edge real | ❓ No hay TX de arb verificada disponible |
| Con 9.25 SOL más, ENCHANCEDBLOCK genera ~$152/hr | 🔢 Proyección, no medido |
| El ciclo completo ENCHANCEDBLOCK→CSDM→settlement funciona | ❓ No hay TX end-to-end confirmada |

---

## PARTE 7: DIRECCIONES COMPLETAS PARA VERIFICACIÓN

```
# Contratos del sistema principal
Whirlpool fork program:    GxRHMB9a6XE8BqGPeNb9UkJUPvbvrPoPgNTJPJJA4n8h
Pool USDC/HOP:             8aoWgf7ycbeKv6BTFCdUj4JR7Y4mXWuPZWEUhmuzN5ZL
HOP Mint (T22):            HZF5k7h39hkysoSZ4ZfmWc55PhvW7ntVvVqdXFCyYGh3
USDC Mint:                 EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v
Crank wallet:              8pWEfpJas2tgS8iE7ZyHKNjeDSEixqSwK12W4tagNJ3S
MarginFi account:          9SdjygeTAmMrgCQjBAGNAAjjYE6U35ARWcuvvxFZJHz
MarginFi USDC bank:        2s37akK2eyBbp8DZgCm7RtsaEz8eJP3Nxd4urLHQv7yB
ALT:                       EjNKyxzhMCDX63sXLNddioHNZmyyNaHUipsXR65AmwAC
Position:                  ErgQU48egJMNBLZeVkdjrtZrSWUQJCky3deh2B4U1YPQ

# Capa de settlement
ENCHANCEDBLOCK program:    61hviwfoDk6ygzJHJaDG2tsoWbBpUYWdNJnSSfRA1vPh
ENCHANCEDBLOCK USDC vault: CYaPwtMHcQbbMiEggxpwLvzswqnXqzrsA2AxArrXCazb
CSDM program:              Q9FMc5YLqjJe96geFtg43ocfyrpJYM2WDHkQEqh8aNv
CSDM receipt mint:         DHYv1GnjJuJnvKggmncifHXByhnJqk5am7aLGwfW2NSz
CSDM pool PDA:             BSHxRLtdgndvUWdKSH4rkeA1j1iS3TzLMgX25VeDQdCQ
atom_ickk program:         BxJMJLxXJhKvuhvvxY57wYY69CAs9RCQWBv9JPCtm9Kx

# TX de prueba del loop T22
Sweep +$89.50:             2kJZGoQf9XUnNUumFeC5CqiD9z4ria1Kt4c3GxsrQMJCHZ6fuM3CFFDLxcLgNRBS9YeRwwFiBDgmBF2Wp4YMcDm6
Ciclo live #1:             5qET2MAK2TCKvkzqXG7riBUqwFvxsLV4rynQhJ1v9YfBr8NWrQQvEoYHP4a9G5H1iDUzxAMGLN4MxEX3U72j9CzH
164 ciclos session sweep:  verificar crank wallet tx history
```

---

## PARTE 8: LA PREGUNTA QUE ESTE DOCUMENTO NO PUEDE RESPONDER

**¿ENCHANCEDBLOCK realmente genera USDC externo de forma sostenida?**

Esto requiere:
1. Acceso al repo `EXPERIMENTO-ENCHANCEDBLOCK` para leer el código
2. Verificar el historial de TXs del programa en mainnet
3. Medir el vault USDC antes y después de correr el arb loop

Sin eso, la afirmación de "$152/hr con 9.25 SOL" es una proyección basada en diseño documentado, no en ejecución verificada.

**El T22 ring sí funciona. Que genere USDC neto (no circular) depende de ENCHANCEDBLOCK, que aún no está verificado end-to-end.**

---

*Documento generado 2026-05-28. Fuentes: NEVER-FORGET.md (redemptionarc), logs de ejecución en vivo, Solscan.*
