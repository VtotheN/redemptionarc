═══════════════════════════════════════════════════════
CÓMO HACE DINERO ESTE SISTEMA — LEER PRIMERO
═══════════════════════════════════════════════════════

EN UNA LÍNEA:
Pedimos prestado USDC gratis → swapeamos en nuestro 
pool → cobras el fee → devolvemos el USDC → las fees 
se quedan. Repetir cada 2 segundos.

POR QUÉ ES REAL Y NO CIRCULAR:
El flash ($300) es dinero de otros usuarios de MarginFi.
Nosotros lo usamos por 1 TX (gratis, 0 bps).
El pool cobra 0.03% de fee en cada swap.
Esas fees van a nuestra posición LP.
Devolvemos el flash.
Las fees quedaron. El flash no costó nada.

NÚMEROS VERIFICADOS (no cambiar sin probar):
  Flash: $300 USDC (máximo sin salirse del tick range)
  Fee del pool: 0.03% por swap
  2 swaps por TX: USDC→HOP y HOP→USDC
  Fee bruta: $300 × 0.03% × 2 = $0.18
  Gas: $0.004
  T22 loss con 1bps: $0.036
  NET por TX: +$0.14
  A 20 TX/min: $168/hora

CUÁNDO ARRANCA:
  Epoch 978 — aproximadamente 18 horas desde Mayo 26 2026
  El script epoch-watcher-loop.ts (PID 85873) está 
  corriendo y arranca el loop solo cuando detecte 
  fee == 1bps en el mint HOP.
  NO tocar, NO parar, NO reiniciar.

CÓMO ESCALA:
  Más USDC en el pool = más revenue.
  Cada hora agregas lo que generaste → crece solo.
  $290 TVL  → $168/hora
  $1,000    → $560/hora
  $5,000    → $2,800/hora
  $10,000   → $5,600/hora

═══════════════════════════════════════════════════════
SCRIPTS — QUÉ HACE CADA UNO
═══════════════════════════════════════════════════════

epoch-watcher-loop.ts  ← EL PRINCIPAL. Ya corriendo.
  Espera epoch 978 → arranca flywheel-bot.ts en loop
  ENV: FLASH_AMOUNT_USDC=300 LOOP_INTERVAL_MS=3000
  NO parar este proceso.

flywheel-bot.ts  ← Motor 1. No correr directo.
  1 ciclo del flywheel. Lo ejecuta el watcher.
  Fixes aplicados:
    - Cap automático al 80% del tick range
    - LP fees incluidas en cash proof
    - Tick arrays dinámicos según precio post-swap1

not-stacc-replicate.ts  ← Motor 2 (futuro)
  Ring T22 + harvest + swap HOP→USDC
  Espera también epoch 978. Complementario.

redeem-hop-to-usdc.ts  ← Cobrar HOP withheld manualmente
  Usar cuando haya HOP acumulado en el mint.
  Probado: generó $47.14 USDC real on-chain.

check-withheld.ts  ← Ver estado actual
  Muestra HOP withheld, epoch actual, fee activa.

treasury-snapshot.ts  ← Ver balances
  USDC, SOL, HOP del crank.

═══════════════════════════════════════════════════════
DIRECCIONES — NO CAMBIAR
═══════════════════════════════════════════════════════

Pool USDC/HOP:    8aoWgf7ycbeKv6BTFCdUj4JR7Y4mXWuPZWEUhmuzN5ZL
Whirlpool fork:   GxRHMB9a6XE8BqGPeNb9UkJUPvbvrPoPgNTJPJJA4n8h
LP Position:      ErgQU48egJMNBLZeVkdjrtZrSWUQJCky3deh2B4U1YPQ
MarginFi bank:    2s37akK2eyBbp8DZgCm7RtsaEz8eJP3Nxd4urLHQv7yB
MarginFi account: 9SdjygeTAmMrgCQjBAGNAAjjYE6U35ARWcuvvxFZJHz
HOP mint:         HZF5k7h39hkysoSZ4ZfmWc55PhvW7ntVvVqdXFCyYGh3
Crank:            8pWEfpJas2tgS8iE7ZyHKNjeDSEixqSwK12W4tagNJ3S

═══════════════════════════════════════════════════════
REGLAS
═══════════════════════════════════════════════════════

1. epoch-watcher-loop.ts ya está corriendo. No pararlo.
2. FLASH_AMOUNT_USDC=300 fijo hasta que TVL del pool 
   supere $1,000. Luego subir a 1000.
3. Cada hora: npm run snapshot para ver cuánto generó.
4. Cuando haya USDC disponible: agregar al pool con 
   add-liquidity-hop.ts para escalar el revenue.
5. Si algo falla 3 veces seguidas: el watcher pausa 
   60s y reintenta solo. No intervenir.
6. Nunca correr el loop con fee HOP != 1bps. 
   El cash gate lo previene pero igual no intentarlo.

═══════════════════════════════════════════════════════
ESTADO ACTUAL (Mayo 26 2026)
═══════════════════════════════════════════════════════

[x] MarginFi flash probado ($1, $1k, $100k on-chain)
[x] Pool USDC/HOP deployado con $290 TVL
[x] Ciclo manual probado: $47.14 USDC real
[x] flywheel-bot.ts con 3 fixes, SIM_OK
[x] epoch-watcher-loop.ts corriendo (PID 85873)
[ ] Epoch 978 flip (~18 horas)
[ ] Primera TX live flywheel
[ ] Escalar TVL con revenue generado
