# RedemptionArc — Sistema Completo

## Qué hace este sistema y por qué es rentable

Flash USDC gratis de MarginFi → addLiq en nuestro
Whirlpool fork → swap USDC→HOP→USDC → removeLiq →
repay flash. Las LP fees quedan. Repetir cada 3s.

El capital del flash NO es nuestro. Es de otros
usuarios de MarginFi. Lo usamos por 1 TX y lo
devolvemos. Las fees se quedan.

## Math verificado (no cambiar sin probar on-chain)

Script: flash-deep-vol-orca.ts
SIM_OK confirmado: null simErr, CU=403,850, TX=671 bytes

  flashAmount = addLiqMicro + swapMicro = $1,000
  addLiq: $700 USDC + 8.6M HOP → liquidityDelta=226B
  swap:   $300 USDC → HOP → USDC (round trip)
  LP fee: $300 × 0.03% × 2 = $0.18 bruto
  gas:    $0.031
  NET:    $0.149 por TX (verificado en sim)

  A 20 TX/min = $178.80/hora

## Por qué el cash gate bloqueaba antes (RESUELTO)

El cash gate original no contaba:
  1. LP fees swap1 (USDC, acumulan en posición LP)
  2. LP fees swap2 (HOP, acumulan en posición LP)
  3. T22 withheld (ingreso real, somos withdraw authority)

Formula correcta implementada en flywheel-bot.ts:
  cashNet = walletUsdcDeltaBeforeCollect
          + lpFeeUsdcSwap1
          + lpFeeSwap2AsUsdc
          + protocolFeeSwap1
          + protocolFeeSwap2AsUsdc
          + t22RecoveredUsdc
          - gas

## Por qué esperar epoch 978

HOP T22 fee activa = 690bps hasta epoch 978.
Con 690bps: T22 cost > fees → net negativo.
Con 1bps (epoch 978+): T22 cost ~$0.021 → net +$0.149.
El loop detecta el flip automáticamente.

## Reglas que NUNCA cambiar

1. NO correr loops con T22 fee != 1bps
2. NO cambiar flash-deep-vol-orca.ts sin sim previo
3. flashAmount = addLiqMicro + swapMicro (AMBOS)
4. ALT_ADDRESS = EjNKyxzhMCDX63sXLNddioHNZmyyNaHUipsXR65AmwAC
5. El "0 USDC en crank" NO es blocker — el flash
   se repaga con el output del swap, no del balance previo
6. SWAP_USDC=300 fijo hasta confirmar TX live
7. Escalar SWAP_USDC solo después de TX live confirmada

## Direcciones (no tocar)

Whirlpool fork:   GxRHMB9a6XE8BqGPeNb9UkJUPvbvrPoPgNTJPJJA4n8h
Pool USDC/HOP:    8aoWgf7ycbeKv6BTFCdUj4JR7Y4mXWuPZWEUhmuzN5ZL
LP Position 1:    ErgQU48egJMNBLZeVkdjrtZrSWUQJCky3deh2B4U1YPQ
LP Position 2:    3Qx4NtMhd9vDKWbcdUAu2qrwpypbXEGy95N4cYgdyaGk
ALT:              EjNKyxzhMCDX63sXLNddioHNZmyyNaHUipsXR65AmwAC
MarginFi bank:    2s37akK2eyBbp8DZgCm7RtsaEz8eJP3Nxd4urLHQv7yB
MarginFi account: 9SdjygeTAmMrgCQjBAGNAAjjYE6U35ARWcuvvxFZJHz
HOP mint:         HZF5k7h39hkysoSZ4ZfmWc55PhvW7ntVvVqdXFCyYGh3
Crank:            8pWEfpJas2tgS8iE7ZyHKNjeDSEixqSwK12W4tagNJ3S

## Scripts — qué hace cada uno

flash-deep-vol-orca-loop.ts  ← EL PRINCIPAL
  Loop con epoch watcher. Arranca en epoch 978.
  No parar este proceso.
  ENV: DOTENV_CONFIG_PATH=.env.redemptionarc

flash-deep-vol-orca.ts  ← Motor principal
  1 ciclo del flywheel addLiq+swap+removeLiq.
  SIM_OK verificado. No modificar.

flywheel-bot.ts  ← Motor alternativo (sin addLiq)
  Requiere TVL alto para ser rentable.
  Usar solo cuando pool tenga >$30k TVL.

redeem-hop-to-usdc.ts  ← Cobrar HOP withheld
  Usar periódicamente para convertir T22 fees a USDC.
  Probado: generó $47.14 USDC on-chain.

check-withheld.ts  ← Estado actual del sistema
not-stacc-replicate.ts  ← Ring T22 base
treasury-snapshot.ts  ← Ver balances

## Historial de TX probadas on-chain

MarginFi flash $1:    probado ✓
MarginFi flash $1k:   probado ✓
MarginFi flash $100k: probado ✓
HOP→USDC manual:      $47.14 USDC real ✓
  TX: 4bNXMVSdnFbTHUzVa2sGPVcJex1C9ZcsTF2XKExkAWiuf7im4sjFa3gEDw44b5QE1nELipGsSsjYEAj5EkXB81nc
atom_ickk deploy:     BxJMJLxXJhKvuhvvxY57wYY69CAs9RCQWBv9JPCtm9Kx ✓
flash-deep-vol-orca:  SIM_OK, CU=403850, TX=671 bytes ✓

## Estado actual

[x] Whirlpool fork deployado con liquidez
[x] flash-deep-vol-orca.ts SIM_OK
[x] ALT creado: EjNKyx...
[x] flash-deep-vol-orca-loop.ts corriendo
[x] Epoch watcher activo — flipa ~2026-05-27 07:50 AM
[ ] Primera TX live confirmada
[ ] Escalar SWAP_USDC a 500 → 700
