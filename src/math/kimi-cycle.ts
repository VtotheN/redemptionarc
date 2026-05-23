export function estimateKaminoFlashFeeMicro(routeVolumeMicro: bigint): bigint {
  return (routeVolumeMicro * 9n) / 10_000n;
}

export function estimateCushionSolLamports(args: {
  kaminoFlashFeeMicro: bigint;
  solPriceUsd: number;
  cushionExtraUsdcMicro: bigint;
  minCushionSolLamports: bigint;
}): bigint {
  const cushionUsdcMicro = args.kaminoFlashFeeMicro + args.cushionExtraUsdcMicro;
  const solNeeded =
    (cushionUsdcMicro * 1_000_000_000n) / BigInt(Math.floor(args.solPriceUsd * 1e6));
  return solNeeded > args.minCushionSolLamports ? solNeeded : args.minCushionSolLamports;
}

export function estimateKimiStyleTreasuryCreditMicro(args: {
  routeVolumeMicro: bigint;
  kaminoFlashFeeMicro: bigint;
  cushionExtraUsdcMicro: bigint;
}): bigint {
  const orcaCushionUsdcMicro =
    args.kaminoFlashFeeMicro + (args.cushionExtraUsdcMicro * 3n) / 4n;
  const projectedGhostUsdc = args.routeVolumeMicro + orcaCushionUsdcMicro;
  const safetyMicro = 500_000n;
  const reserveMicro = args.routeVolumeMicro + args.kaminoFlashFeeMicro + safetyMicro;
  return projectedGhostUsdc > reserveMicro ? projectedGhostUsdc - reserveMicro : 0n;
}

export function estimatePriorityFeeLamports(args: {
  cuLimit: number;
  cuPriceMicroLamports: number;
}): bigint {
  return BigInt(Math.ceil((args.cuLimit * args.cuPriceMicroLamports) / 1_000_000));
}

export function microToUsdc(value: bigint): number {
  return Number(value) / 1e6;
}

export function lamportsToSol(value: bigint): number {
  return Number(value) / 1e9;
}

// MarginFi flash loan fee = 0bps
export function estimateMarginfiFlashFeeMicro(_routeVolumeMicro: bigint): bigint {
  return 0n;
}

// MarginFi requires no SOL cushion for flash fee (fee=0)
export function estimateCushionSolLamportsMarginfi(): bigint {
  return 0n;
}

// Savings vs Kamino 9bps per routeVolume
export function marginfiFlashFeeSavingsMicro(routeVolumeMicro: bigint): bigint {
  return (routeVolumeMicro * 9n) / 10_000n;
}
