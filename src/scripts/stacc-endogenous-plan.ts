/**
 * STACC endogenous-only planner.
 *
 * This receipt is the line in the sand:
 * - No organic/Jupiter/external orderflow as a base-case profit source.
 * - No single-pool self-volume counted as profit.
 * - Valid path is a controlled actuator that creates a real two-venue spread,
 *   with final spendable USDC/SOL positive after all controlled wallets.
 */
import "dotenv/config";
import dotenv from "dotenv";
import fs from "node:fs";
import { writeReceipt } from "../utils/receipt.js";

if (process.env.ENV_PATH) {
  dotenv.config({ path: process.env.ENV_PATH, override: true });
}

type PoolRow = {
  programLabel: string;
  whirlpool: string;
  config: string;
  controlStatus: string;
  active: boolean;
  feeRate: number | null;
  protocolFeeRate: number | null;
  cashTvlUsd: number;
  cashClaimableUsd: number;
  tokenA: { mint: string | null; mintMeta: { symbol: string; cashClass: string } | null };
  tokenB: { mint: string | null; mintMeta: { symbol: string; cashClass: string } | null };
};

type SourceScan = {
  generatedAt: string;
  summary: Record<string, unknown>;
  pools: PoolRow[];
};

type CycleSim = {
  verdict: string;
  assumptions: Record<string, unknown>;
  selected: {
    whirlpool: string;
    controlStatus: string;
    feeRate: number;
    protocolFeeRate: number;
    ledgers: { collectorLedgerNetUsd: number; totalSystemNetUsd: number | null };
    feeMath: Record<string, unknown>;
    noGoReasons: string[];
  } | null;
};

function readJson<T>(file: string): T | null {
  if (!fs.existsSync(file)) return null;
  return JSON.parse(fs.readFileSync(file, "utf8")) as T;
}

function numberEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) throw new Error(`Invalid ${name}=${raw}`);
  return parsed;
}

function meshScore(pool: PoolRow): number {
  return (pool.active ? 1_000_000_000 : 0) +
    (pool.cashTvlUsd || 0) * 1_000 +
    ((pool.feeRate ?? 0) * (pool.protocolFeeRate ?? 0)) / 10_000 +
    (pool.cashClaimableUsd || 0) * 1_000_000;
}

function captureRate(pool: PoolRow): number {
  return ((pool.feeRate ?? 0) / 1_000_000) * ((pool.protocolFeeRate ?? 0) / 10_000);
}

function explainSinglePool(pool: PoolRow, grossVolumeUsd: number) {
  const rate = captureRate(pool);
  const swapFeeUsd = grossVolumeUsd * ((pool.feeRate ?? 0) / 1_000_000);
  const protocolFeeUsd = grossVolumeUsd * rate;
  const lpFeeUsd = swapFeeUsd - protocolFeeUsd;
  return {
    whirlpool: pool.whirlpool,
    programLabel: pool.programLabel,
    config: pool.config,
    controlStatus: pool.controlStatus,
    active: pool.active,
    feeRate: pool.feeRate,
    protocolFeeRate: pool.protocolFeeRate,
    protocolCaptureRate: rate,
    protocolCapturePercentOfVolume: rate * 100,
    exampleGrossVolumeUsd: grossVolumeUsd,
    collectorCreditUsd: protocolFeeUsd,
    swapFeePaidByControlledBotsUsd: swapFeeUsd,
    lpFeeSideUsd: lpFeeUsd,
    totalSystemBaseCase: "NO_GO",
    reason: "With only our bots, protocol fees are an internal transfer. The system still pays LP fee side, slippage, inventory drift, and gas unless a separate controlled actuator manufactures recoverable spread.",
    tokens: {
      tokenA: { mint: pool.tokenA.mint, symbol: pool.tokenA.mintMeta?.symbol ?? "UNKNOWN", cashClass: pool.tokenA.mintMeta?.cashClass ?? "unknown" },
      tokenB: { mint: pool.tokenB.mint, symbol: pool.tokenB.mintMeta?.symbol ?? "UNKNOWN", cashClass: pool.tokenB.mintMeta?.cashClass ?? "unknown" },
    },
  };
}

function main() {
  const sourceScan = readJson<SourceScan>("receipts/ORCA-OWNED-FEE-SOURCE-SCAN-LATEST.json");
  const controlledSim = readJson<CycleSim>("receipts/ORCA-OWNED-FEE-CYCLE-SIM-CONTROLLED-LATEST.json");
  const externalSim = readJson<CycleSim>("receipts/ORCA-OWNED-FEE-CYCLE-SIM-EXTERNAL-LATEST.json");
  const grossVolumeUsd = numberEnv("ENDOGENOUS_EXAMPLE_VOLUME_USD", 1_000);
  const targetMeshPoolCount = numberEnv("STACC_TARGET_MESH_POOLS", 36);

  const pools = sourceScan?.pools ?? [];
  const localPools = pools.filter((pool) => pool.controlStatus === "local_signer");
  const kpx9Pools = pools.filter((pool) => pool.config === "KPX9QQP4GLWiRkh4pGpkagwoPGaGixarRQs1LQKb9dt");
  const forkHopPools = pools.filter((pool) => pool.programLabel === "redemption-fork");
  const byAuthority = new Map<string, { configs: Set<string>; pools: number; active: number; claimable: number; cashTvlUsd: number }>();
  for (const pool of pools) {
    const key = pool.controlStatus === "local_signer"
      ? "local_signer"
      : pool.controlStatus;
    const item = byAuthority.get(key) ?? { configs: new Set<string>(), pools: 0, active: 0, claimable: 0, cashTvlUsd: 0 };
    item.configs.add(pool.config);
    item.pools += 1;
    item.active += pool.active ? 1 : 0;
    item.claimable += pool.cashClaimableUsd > 0 || pool.cashClaimableUsd === 0 && pool.cashClaimableUsd !== null ? 0 : 0;
    item.cashTvlUsd += pool.cashTvlUsd || 0;
    byAuthority.set(key, item);
  }
  const meshBasket = [...pools]
    .filter((pool) => pool.active)
    .sort((a, b) => meshScore(b) - meshScore(a))
    .slice(0, targetMeshPoolCount)
    .map((pool) => ({
      whirlpool: pool.whirlpool,
      programLabel: pool.programLabel,
      config: pool.config,
      controlStatus: pool.controlStatus,
      feeRate: pool.feeRate,
      protocolFeeRate: pool.protocolFeeRate,
      protocolCaptureRate: captureRate(pool),
      cashTvlUsd: pool.cashTvlUsd,
      tokenA: pool.tokenA.mint,
      tokenB: pool.tokenB.mint,
    }));

  const receipt = {
    verdict: "ENDOGENOUS_ONLY_REQUIRES_CONTROLLED_ACTUATOR",
    generatedAt: new Date().toISOString(),
    noSend: true,
    baseRule: "No organic/Jupiter/external orderflow is allowed as the base-case source. Controlled bot volume must pass total-system wallet SOL/USDC accounting.",
    conclusion: {
      singleKpx9OrForkPool: "NO_GO_INTERNAL_FEE_TRANSFER",
      kpx9OfficialHopUsdc: "BLOCKED_FOR_HOP_TOKEN2022_BADGE_6066",
      currentForkHopPool: "ACTIVE_BUT_SINGLE_POOL_SELF_VOLUME_IS_NEGATIVE_OR_INTERNAL",
      minimumEngine: "TWO_CONTROLLED_VENUES_PLUS_ACTUATOR",
      staccObservedEngine: "MULTI_POOL_MESH_AROUND_36_POOLS_PLUS_ACTUATOR",
      correctEngine: "CONTROLLED_MULTI_POOL_MESH_PLUS_ACTUATOR",
    },
    observedMeshScale: {
      userCorrection: "STACC used roughly 36 pools; treat two pools only as the mathematical minimum, not the operating ceiling.",
      targetMeshPoolCount,
      currentScan: sourceScan
        ? {
            configCount: sourceScan.summary.configCount,
            poolCount: sourceScan.summary.poolCount,
            activePoolCount: sourceScan.summary.activePoolCount,
            claimableProtocolFeePoolCount: sourceScan.summary.claimableProtocolFeePoolCount,
          }
        : null,
      controlClassReach: [...byAuthority.entries()].map(([controlClass, item]) => ({
        controlClass,
        configs: item.configs.size,
        pools: item.pools,
        active: item.active,
        cashTvlUsd: item.cashTvlUsd,
      })),
      candidateMeshBasket: meshBasket,
      localGap: {
        localActivePools: localPools.filter((pool) => pool.active).length,
        targetMeshPoolCount,
        missingActiveControlledPools: Math.max(0, targetMeshPoolCount - localPools.filter((pool) => pool.active).length),
      },
    },
    proofFromReceipts: {
      sourceScan: sourceScan
        ? {
            generatedAt: sourceScan.generatedAt,
            summary: sourceScan.summary,
          }
        : null,
      controlledBotCycle: controlledSim
        ? {
            verdict: controlledSim.verdict,
            selected: controlledSim.selected,
          }
        : null,
      externalFlowCycleForComparisonOnly: externalSim
        ? {
            verdict: externalSim.verdict,
            selected: externalSim.selected,
            note: "This is not accepted as base case; it only prices the organic/orderflow upside Velon rejected.",
          }
        : null,
    },
    localSinglePoolExamples: localPools.map((pool) => explainSinglePool(pool, grossVolumeUsd)),
    kpx9Pools: kpx9Pools.map((pool) => explainSinglePool(pool, grossVolumeUsd)),
    forkHopPools: forkHopPools.map((pool) => explainSinglePool(pool, grossVolumeUsd)),
    requiredArchitecture: {
      name: "STACC_ENDOGENOUS_36_POOL_MESH_ACTUATOR",
      invariant: "sum(controlled_wallet_SOL_USDC_after) > sum(controlled_wallet_SOL_USDC_before) after flash repay, collect, settlement, gas, rent, tips, and inventory rebalance.",
      actors: [
        "bot-1: actuator/skew planner",
        "bot-2: flash arb executor",
        "bot-3: protocol/LP fee collector",
        "bot-4: inventory rebalancer and receipt checker",
      ],
      venues: [
        "Minimum: Pool A and Pool B controlled venues whose relative price can be shifted by a privileged/owned actuator without relying on external traders",
        "Operating target: around 36 active controlled pools/configs so bots can rotate inventory, fee tiers, and skew paths instead of hammering one pool",
        "Each mesh pool must either be locally signable or have a bounded partner-settlement receipt; unverified screenshot authorities are discovery only",
      ],
      instructionPath: [
        "preflight: snapshot controlled SOL/USDC balances",
        "mesh select: choose 2-4 legs from the 36-pool controlled mesh for this tick",
        "actuator: apply virtual reserve/admin_rebalance skew or equivalent controlled state change on selected venues",
        "flash: borrow USDC/SOL with zero or bounded fee",
        "swap leg A through controlled venue",
        "swap leg B/C through second/third controlled venue",
        "repay flash",
        "collect protocol/LP fees only if they settle to USDC/SOL",
        "rebalance inventory and write receipt",
      ],
      rejectedPaths: [
        "single Orca/KPX9 pool with our bots as both sides",
        "collector-only profit where bot wallets lose more than collector gains",
        "HOP/custom-token accounting profit without same-bundle or bounded USDC/SOL settlement",
        "Jupiter/organic volume as required base case",
      ],
      nextImplementationModule: "GGSS/UNDERWHEEL-style 36-pool mesh actuator plan; Orca official remains only optional upside or classic-SPL fee venue.",
    },
  };

  const out = writeReceipt("STACC-ENDOGENOUS-PLAN-LATEST.json", receipt);
  console.log(`${receipt.verdict} localPools=${localPools.length} kpx9Pools=${kpx9Pools.length} forkHopPools=${forkHopPools.length} receipt=${out}`);
}

main();
