/**
 * No-send builder for the endogenous STACC pool mesh.
 *
 * Creates an exact plan for expanding our fork-owned USDC/HOP Whirlpool mesh
 * from the current single active pool toward 36 active controlled pools.
 * It does not submit transactions. Simulations use ephemeral signer keypairs
 * unless MESH_WRITE_KEYPAIRS=true is set for a later approved live run.
 */
import "dotenv/config";
import dotenv from "dotenv";
import fs from "node:fs";
import path from "node:path";
import {
  ComputeBudgetProgram,
  Keypair,
  PublicKey,
  Transaction,
  TransactionInstruction,
} from "@solana/web3.js";
import {
  getAssociatedTokenAddressSync,
  TOKEN_2022_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
} from "@solana/spl-token";
import { loadConfig } from "../config.js";
import { HOP_MINT_DEFAULT, USDC_MINT_DEFAULT } from "../constants.js";
import { assertKeypairMatches, loadKeypair, saveKeypair } from "../utils/keypair.js";
import { writeReceipt } from "../utils/receipt.js";
import { connectionFor } from "../utils/rpc.js";
import { assertNoForbiddenConfigured } from "../utils/safety.js";
import {
  amountBFromLiquidity,
  deriveFeeTier,
  deriveTickArray,
  deriveTokenBadge,
  deriveWhirlpool,
  increaseLiquidityV2Ix,
  initializeFeeTierIx,
  initializePoolV2Ix,
  initializeTickArrayIx,
  liquidityFromAmountA,
  openPositionIx,
  ORCA_ACCOUNT_SIZES,
  tickToSqrtPriceX64,
  WHIRLPOOL_PROGRAM_ID,
} from "../utils/orca-whirlpool.js";

if (process.env.ENV_PATH) {
  dotenv.config({ path: process.env.ENV_PATH, override: true });
}

const USDC_MINT = new PublicKey(USDC_MINT_DEFAULT);
const HOP_MINT = new PublicKey(HOP_MINT_DEFAULT);
const WHIRLPOOLS_CONFIG = new PublicKey("9Nr7o1muxPfcsxv4WtTN2GdUFKhUsdR7WHejyJdesTmZ");
const EXISTING_POOL = new PublicKey("8aoWgf7ycbeKv6BTFCdUj4JR7Y4mXWuPZWEUhmuzN5ZL");

const TICK_ARRAY_SIZE = 88;
const DEFAULT_TARGET_POOL_COUNT = 36;
const DEFAULT_FEE_RATE = 3000;
const DEFAULT_PROTOCOL_FEE_RATE = 2500;

type MeshPoolPlan = {
  index: number;
  tickSpacing: number;
  whirlpool: string;
  feeTier: string;
  tickArrayStart: number;
  tickArray: string;
  tickLower: number;
  tickUpper: number;
  exists: {
    feeTier: boolean;
    whirlpool: boolean;
    tickArray: boolean;
  };
  tokenVaultA: string | null;
  tokenVaultB: string | null;
  positionMint: string | null;
  position: string | null;
  seedUsdcUi: number;
  requiredHopUi: number;
  liquidity: string;
  missingRentLamports: string;
  setupInstructionCount: number;
  liquidityInstructionCount: number;
  txPlan: string[];
  setupSimulation: SimulationResult;
  liquiditySimulation: SimulationResult;
  verdict: string;
};

type SimulationResult = {
  skipped: boolean;
  reason: string | null;
  err: unknown;
  unitsConsumed: number | null;
  logsTail: string[];
};

function boolEnv(name: string, fallback: boolean): boolean {
  const raw = process.env[name];
  if (!raw) return fallback;
  return ["1", "true", "yes", "y"].includes(raw.toLowerCase());
}

function numberEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) throw new Error(`Invalid ${name}=${raw}`);
  return parsed;
}

function u16TickSpacings(targetCount: number): number[] {
  const out: number[] = [];
  for (let i = 1; out.length < targetCount - 1; i++) {
    if (i === 64) continue;
    out.push(i);
  }
  out.push(64);
  return out.sort((a, b) => a - b);
}

function priceToSqrtPriceX64(tokenBPerTokenA: number): bigint {
  const sqrtPrice = Math.sqrt(tokenBPerTokenA);
  const scale = 1_000_000_000n;
  return (BigInt(Math.floor(sqrtPrice * Number(scale))) * (1n << 64n)) / scale;
}

function sqrtPriceX64ToTick(sqrtPriceX64: bigint): number {
  const sqrtNum = Number(sqrtPriceX64);
  const q64 = Math.pow(2, 64);
  const sqrtPrice = sqrtNum / q64;
  return Math.floor(Math.log(sqrtPrice * sqrtPrice) / Math.log(1.0001));
}

function tickArrayStart(tick: number, tickSpacing: number): number {
  const range = tickSpacing * TICK_ARRAY_SIZE;
  return Math.floor(tick / range) * range;
}

function narrowRangeInsideArray(currentTick: number, tickSpacing: number) {
  const currentInitializable = Math.floor(currentTick / tickSpacing) * tickSpacing;
  const start = tickArrayStart(currentInitializable, tickSpacing);
  const end = start + tickSpacing * (TICK_ARRAY_SIZE - 1);
  let lower = currentInitializable - tickSpacing;
  let upper = currentInitializable + tickSpacing;
  if (lower < start) {
    lower = start;
    upper = start + 2 * tickSpacing;
  }
  if (upper > end) {
    upper = end;
    lower = end - 2 * tickSpacing;
  }
  return { start, lower, upper };
}

function derivePosition(positionMint: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("position"), positionMint.toBuffer()],
    WHIRLPOOL_PROGRAM_ID
  )[0];
}

function meshKeyPath(kind: string, tickSpacing: number): string {
  return path.resolve("keys/mesh", `${kind}-ts${tickSpacing}.json`);
}

function getOrCreateEphemeral(kind: string, tickSpacing: number, writeKeypairs: boolean): Keypair {
  const file = meshKeyPath(kind, tickSpacing);
  if (fs.existsSync(file)) return loadKeypair(file);
  const kp = Keypair.generate();
  if (writeKeypairs) saveKeypair(file, kp);
  return kp;
}

function sumBig(values: bigint[]): bigint {
  return values.reduce((a, b) => a + b, 0n);
}

function readU16(data: Buffer, offset: number): number | null {
  return data.length >= offset + 2 ? data.readUInt16LE(offset) : null;
}

async function simulateIxSet(args: {
  connection: ReturnType<typeof connectionFor>;
  funder: Keypair;
  ixs: TransactionInstruction[];
  signers: Keypair[];
}): Promise<SimulationResult> {
  try {
    const tx = new Transaction().add(...args.ixs);
    tx.feePayer = args.funder.publicKey;
    tx.recentBlockhash = (await args.connection.getLatestBlockhash("confirmed")).blockhash;
    tx.sign(...args.signers);
    const sim = await args.connection.simulateTransaction(tx);
    return {
      skipped: false,
      reason: null,
      err: sim.value.err ?? null,
      unitsConsumed: sim.value.unitsConsumed ?? null,
      logsTail: sim.value.logs?.slice(-12) ?? [],
    };
  } catch (error) {
    return {
      skipped: false,
      reason: null,
      err: {
        message: error instanceof Error ? error.message : String(error),
      },
      unitsConsumed: null,
      logsTail: [],
    };
  }
}

async function main() {
  const config = loadConfig();
  assertNoForbiddenConfigured(config);
  if (!config.crank) throw new Error("Missing REDEMPTION_CRANK");

  const connection = connectionFor(config.rpcUrl);
  const funder = loadKeypair(process.env.CRANK_KEYPAIR_PATH || "keys/crank.json");
  assertKeypairMatches("crank", funder, config.crank);

  const targetPoolCount = numberEnv("STACC_TARGET_MESH_POOLS", DEFAULT_TARGET_POOL_COUNT);
  const feeRate = numberEnv("MESH_FEE_RATE", DEFAULT_FEE_RATE);
  const protocolFeeRate = numberEnv("MESH_PROTOCOL_FEE_RATE", DEFAULT_PROTOCOL_FEE_RATE);
  const seedUsdcUi = numberEnv("MESH_SEED_USDC_PER_POOL", 0.01);
  const hopPriceUsdc = numberEnv("MESH_HOP_PRICE_USDC", 0.0001);
  const slippagePct = numberEnv("MESH_LIQ_SLIPPAGE_PCT", 25);
  const simulate = boolEnv("MESH_SIMULATE", true);
  const writeKeypairs = boolEnv("MESH_WRITE_KEYPAIRS", false);
  const maxSimulations = numberEnv("MESH_MAX_SIMULATIONS", targetPoolCount);
  const cuLimit = numberEnv("MESH_CU_LIMIT", 900_000);
  const cuPriceMicroLamports = numberEnv("MESH_CU_PRICE_MICRO_LAMPORTS", 1_000);

  const usdcAta = getAssociatedTokenAddressSync(USDC_MINT, funder.publicKey, false, TOKEN_PROGRAM_ID);
  const hopAta = getAssociatedTokenAddressSync(HOP_MINT, funder.publicKey, false, TOKEN_2022_PROGRAM_ID);
  const [solLamports, usdcBalance, hopBalance] = await Promise.all([
    connection.getBalance(funder.publicKey, "confirmed"),
    connection.getTokenAccountBalance(usdcAta, "confirmed").then((x) => BigInt(x.value.amount)).catch(() => 0n),
    connection.getTokenAccountBalance(hopAta, "confirmed").then((x) => BigInt(x.value.amount)).catch(() => 0n),
  ]);
  const configInfo = await connection.getAccountInfo(WHIRLPOOLS_CONFIG, "confirmed");
  const currentDefaultProtocolFeeRate = configInfo ? readU16(configInfo.data, 104) : null;
  const effectiveProtocolFeeRate = currentDefaultProtocolFeeRate ?? protocolFeeRate;

  const usdcFirst = Buffer.from(USDC_MINT.toBytes()).compare(Buffer.from(HOP_MINT.toBytes())) < 0;
  const tokenMintA = usdcFirst ? USDC_MINT : HOP_MINT;
  const tokenMintB = usdcFirst ? HOP_MINT : USDC_MINT;
  const tokenProgramA = tokenMintA.equals(USDC_MINT) ? TOKEN_PROGRAM_ID : TOKEN_2022_PROGRAM_ID;
  const tokenProgramB = tokenMintB.equals(USDC_MINT) ? TOKEN_PROGRAM_ID : TOKEN_2022_PROGRAM_ID;
  const tokenOwnerAccountA = tokenMintA.equals(USDC_MINT) ? usdcAta : hopAta;
  const tokenOwnerAccountB = tokenMintB.equals(USDC_MINT) ? usdcAta : hopAta;
  const tokenBadgeA = deriveTokenBadge(WHIRLPOOLS_CONFIG, tokenMintA);
  const tokenBadgeB = deriveTokenBadge(WHIRLPOOLS_CONFIG, tokenMintB);

  const tokenBPerTokenA = tokenMintA.equals(USDC_MINT) ? 1 / hopPriceUsdc : hopPriceUsdc;
  const initialSqrtPrice = priceToSqrtPriceX64(tokenBPerTokenA);
  const currentTick = sqrtPriceX64ToTick(initialSqrtPrice);
  const seedUsdcUnits = BigInt(Math.max(1, Math.round(seedUsdcUi * 1e6)));
  const slippageMul = 100n + BigInt(Math.round(slippagePct));

  const [
    feeTierRent,
    whirlpoolRent,
    tickArrayRent,
    tokenVaultClassicRent,
    tokenVaultT22Rent,
    positionRent,
    positionMintRent,
    positionTokenRent,
  ] = await Promise.all([
    connection.getMinimumBalanceForRentExemption(ORCA_ACCOUNT_SIZES.feeTier),
    connection.getMinimumBalanceForRentExemption(ORCA_ACCOUNT_SIZES.whirlpool),
    connection.getMinimumBalanceForRentExemption(ORCA_ACCOUNT_SIZES.fixedTickArray),
    connection.getMinimumBalanceForRentExemption(165),
    connection.getMinimumBalanceForRentExemption(170),
    connection.getMinimumBalanceForRentExemption(216),
    connection.getMinimumBalanceForRentExemption(82),
    connection.getMinimumBalanceForRentExemption(165),
  ]);

  const tickSpacings = u16TickSpacings(targetPoolCount);
  const plans: MeshPoolPlan[] = [];
  let simulated = 0;

  for (const [index, tickSpacing] of tickSpacings.entries()) {
    const feeTier = deriveFeeTier(WHIRLPOOLS_CONFIG, tickSpacing);
    const whirlpool = deriveWhirlpool(WHIRLPOOLS_CONFIG, tokenMintA, tokenMintB, tickSpacing);
    const range = narrowRangeInsideArray(currentTick, tickSpacing);
    const tickArray = deriveTickArray(whirlpool, range.start);
    const sqrtLower = tickToSqrtPriceX64(range.lower);
    const sqrtUpper = tickToSqrtPriceX64(range.upper);
    const liquidity = liquidityFromAmountA(seedUsdcUnits, initialSqrtPrice, sqrtUpper);
    const requiredHopUnits = amountBFromLiquidity(liquidity, initialSqrtPrice, sqrtLower);
    const tokenMaxA = tokenMintA.equals(USDC_MINT)
      ? (seedUsdcUnits * slippageMul) / 100n
      : (requiredHopUnits * slippageMul) / 100n;
    const tokenMaxB = tokenMintB.equals(USDC_MINT)
      ? (seedUsdcUnits * slippageMul) / 100n
      : (requiredHopUnits * slippageMul) / 100n;

    const [feeTierInfo, whirlpoolInfo, tickArrayInfo] = await Promise.all([
      connection.getAccountInfo(feeTier, "confirmed"),
      connection.getAccountInfo(whirlpool, "confirmed"),
      connection.getAccountInfo(tickArray, "confirmed"),
    ]);

    const exists = {
      feeTier: Boolean(feeTierInfo),
      whirlpool: Boolean(whirlpoolInfo),
      tickArray: Boolean(tickArrayInfo),
    };

    const tokenVaultA = exists.whirlpool ? null : getOrCreateEphemeral("vault-a", tickSpacing, writeKeypairs);
    const tokenVaultB = exists.whirlpool ? null : getOrCreateEphemeral("vault-b", tickSpacing, writeKeypairs);
    const positionMintKp = exists.whirlpool ? null : getOrCreateEphemeral("position-mint", tickSpacing, writeKeypairs);
    const position = positionMintKp ? derivePosition(positionMintKp.publicKey) : null;
    const positionTokenAccount = positionMintKp
      ? getAssociatedTokenAddressSync(positionMintKp.publicKey, funder.publicKey, false, TOKEN_PROGRAM_ID)
      : null;

    const setupIxs: TransactionInstruction[] = [
      ComputeBudgetProgram.setComputeUnitLimit({ units: cuLimit }),
      ComputeBudgetProgram.setComputeUnitPrice({ microLamports: cuPriceMicroLamports }),
    ];
    const liquidityIxs: TransactionInstruction[] = [
      ComputeBudgetProgram.setComputeUnitLimit({ units: cuLimit }),
      ComputeBudgetProgram.setComputeUnitPrice({ microLamports: cuPriceMicroLamports }),
    ];
    if (!exists.feeTier) {
      setupIxs.push(initializeFeeTierIx({
        config: WHIRLPOOLS_CONFIG,
        feeTier,
        funder: funder.publicKey,
        feeAuthority: funder.publicKey,
        tickSpacing,
        defaultFeeRate: feeRate,
      }));
    }
    if (!exists.whirlpool && tokenVaultA && tokenVaultB && positionMintKp && position && positionTokenAccount) {
      setupIxs.push(initializePoolV2Ix({
        whirlpoolsConfig: WHIRLPOOLS_CONFIG,
        tokenMintA,
        tokenMintB,
        tokenBadgeA,
        tokenBadgeB,
        funder: funder.publicKey,
        whirlpool,
        tokenVaultA: tokenVaultA.publicKey,
        tokenVaultB: tokenVaultB.publicKey,
        feeTier,
        tokenProgramA,
        tokenProgramB,
        tickSpacing,
        initialSqrtPrice,
      }));
      if (!exists.tickArray) {
        setupIxs.push(initializeTickArrayIx({
          whirlpool,
          funder: funder.publicKey,
          tickArray,
          startTickIndex: range.start,
        }));
      }
      liquidityIxs.push(openPositionIx({
        funder: funder.publicKey,
        owner: funder.publicKey,
        position,
        positionMint: positionMintKp.publicKey,
        positionTokenAccount,
        whirlpool,
        tickLowerIndex: range.lower,
        tickUpperIndex: range.upper,
      }));
      liquidityIxs.push(increaseLiquidityV2Ix({
        whirlpool,
        tokenProgramA,
        tokenProgramB,
        positionAuthority: funder.publicKey,
        position,
        positionTokenAccount,
        tokenMintA,
        tokenMintB,
        tokenOwnerAccountA,
        tokenOwnerAccountB,
        tokenVaultA: tokenVaultA.publicKey,
        tokenVaultB: tokenVaultB.publicKey,
        tickArrayLower: tickArray,
        tickArrayUpper: tickArray,
        liquidityAmount: liquidity,
        tokenMaxA,
        tokenMaxB,
      }));
    }

    const missingRent = sumBig([
      !exists.feeTier ? BigInt(feeTierRent) : 0n,
      !exists.whirlpool ? BigInt(whirlpoolRent + tokenVaultClassicRent + tokenVaultT22Rent + positionRent + positionMintRent + positionTokenRent) : 0n,
      !exists.whirlpool && !exists.tickArray ? BigInt(tickArrayRent) : 0n,
    ]);

    let setupSimulation: SimulationResult = {
      skipped: !simulate || simulated >= maxSimulations || setupIxs.length <= 2,
      reason: !simulate
        ? "MESH_SIMULATE=false"
        : simulated >= maxSimulations
          ? "MESH_MAX_SIMULATIONS reached"
          : setupIxs.length <= 2
            ? "no setup instructions"
            : null,
      err: null,
      unitsConsumed: null,
      logsTail: [],
    };

    if (!setupSimulation.skipped) {
      simulated += 1;
      const signers = [funder, tokenVaultA, tokenVaultB].filter((x): x is Keypair => Boolean(x));
      setupSimulation = await simulateIxSet({ connection, funder, ixs: setupIxs, signers });
    }

    const liquiditySimulation: SimulationResult = {
      skipped: true,
      reason: exists.whirlpool
        ? "existing pool liquidity top-up is not part of this build step"
        : liquidityIxs.length <= 2
          ? "no liquidity instructions"
          : "requires setup transaction to land before simulation can see the new pool accounts",
      err: null,
      unitsConsumed: null,
      logsTail: [],
    };

    const txPlan = [
      setupIxs.length > 2 ? "setup" : null,
      liquidityIxs.length > 2 ? "liquidity_after_setup" : null,
    ].filter((x): x is string => Boolean(x));

    plans.push({
      index,
      tickSpacing,
      whirlpool: whirlpool.toBase58(),
      feeTier: feeTier.toBase58(),
      tickArrayStart: range.start,
      tickArray: tickArray.toBase58(),
      tickLower: range.lower,
      tickUpper: range.upper,
      exists,
      tokenVaultA: tokenVaultA?.publicKey.toBase58() ?? null,
      tokenVaultB: tokenVaultB?.publicKey.toBase58() ?? null,
      positionMint: positionMintKp?.publicKey.toBase58() ?? null,
      position: position?.toBase58() ?? null,
      seedUsdcUi,
      requiredHopUi: Number(requiredHopUnits) / 1e6,
      liquidity: liquidity.toString(),
      missingRentLamports: missingRent.toString(),
      setupInstructionCount: setupIxs.length,
      liquidityInstructionCount: liquidityIxs.length,
      txPlan,
      setupSimulation,
      liquiditySimulation,
      verdict: exists.whirlpool
        ? "POOL_ALREADY_EXISTS"
        : setupSimulation.err
          ? "SETUP_SIM_FAILED"
          : setupSimulation.skipped
            ? "PLAN_BUILT_NOT_SIMULATED"
            : "SETUP_SIM_OK_LIQUIDITY_PENDING",
    });
  }

  const missing = plans.filter((plan) => !plan.exists.whirlpool);
  const failed = plans.filter((plan) => plan.setupSimulation.err || plan.liquiditySimulation.err);
  const totalRentLamports = sumBig(missing.map((plan) => BigInt(plan.missingRentLamports)));
  const totalSeedUsdcUnits = BigInt(missing.length) * seedUsdcUnits;
  const totalRequiredHopUnits = sumBig(missing.map((plan) => BigInt(Math.ceil(plan.requiredHopUi * 1e6))));
  const plannedSetupTxCount = plans.filter((plan) => plan.setupInstructionCount > 2).length;
  const plannedLiquidityTxCount = plans.filter((plan) => plan.liquidityInstructionCount > 2).length;
  const estimatedTxFeeLamports = BigInt(plannedSetupTxCount + plannedLiquidityTxCount) *
    BigInt(5_000 + Math.ceil(cuLimit * cuPriceMicroLamports / 1_000_000));
  const totalLamportsNeeded = totalRentLamports + estimatedTxFeeLamports;

  const receipt = {
    verdict: failed.length > 0
      ? "STACC_MESH_BUILD_PLAN_HAS_SIM_FAILURES"
      : totalSeedUsdcUnits > usdcBalance
        ? "STACC_MESH_BUILD_PLAN_BLOCKED_INSUFFICIENT_USDC"
        : totalRequiredHopUnits > hopBalance
          ? "STACC_MESH_BUILD_PLAN_BLOCKED_INSUFFICIENT_HOP"
          : BigInt(solLamports) < totalLamportsNeeded
            ? "STACC_MESH_BUILD_PLAN_BLOCKED_INSUFFICIENT_SOL_RENT"
            : "STACC_MESH_BUILD_PLAN_READY_NO_SEND",
    generatedAt: new Date().toISOString(),
    noSend: true,
    liveExecution: "BLOCKED_UNTIL_EXPLICIT_APPROVAL",
    writeKeypairs,
    warning: writeKeypairs
      ? "Mesh signer keypairs were written under keys/mesh; do not commit them."
      : "Simulation used ephemeral signer keypairs. Re-run with MESH_WRITE_KEYPAIRS=true only after approving the plan for a reusable live run.",
    config: WHIRLPOOLS_CONFIG.toBase58(),
    program: WHIRLPOOL_PROGRAM_ID.toBase58(),
    params: {
      targetPoolCount,
      currentKnownPool: EXISTING_POOL.toBase58(),
      tickSpacings,
      feeRate,
      requestedProtocolFeeRate: protocolFeeRate,
      currentDefaultProtocolFeeRate,
      effectiveProtocolFeeRate,
      protocolCaptureRate: feeRate / 1_000_000 * effectiveProtocolFeeRate / 10_000,
      adminFeeUpdates: {
        included: false,
        reason: "Deployed fork returned InstructionFallbackNotFound for set_default_protocol_fee_rate during no-send simulation; new pools use the config default protocol fee rate.",
      },
      seedUsdcUi,
      hopPriceUsdc,
      tokenBPerTokenA,
      initialSqrtPrice: initialSqrtPrice.toString(),
      currentTick,
      slippagePct,
      oneTickArrayPerPool: true,
      cuLimit,
      cuPriceMicroLamports,
    },
    balances: {
      funder: funder.publicKey.toBase58(),
      solLamports: solLamports.toString(),
      solUi: solLamports / 1e9,
      usdcRaw: usdcBalance.toString(),
      usdcUi: Number(usdcBalance) / 1e6,
      hopRaw: hopBalance.toString(),
      hopUi: Number(hopBalance) / 1e6,
    },
    costModel: {
      missingPoolCount: missing.length,
      plannedSetupTxCount,
      plannedLiquidityTxCount,
      simulatedCount: simulated,
      failedSimulationCount: failed.length,
      totalRentLamports: totalRentLamports.toString(),
      totalRentSol: Number(totalRentLamports) / 1e9,
      estimatedTxFeeLamports: estimatedTxFeeLamports.toString(),
      estimatedTxFeeSol: Number(estimatedTxFeeLamports) / 1e9,
      totalLamportsNeeded: totalLamportsNeeded.toString(),
      totalSolNeeded: Number(totalLamportsNeeded) / 1e9,
      totalSeedUsdcRaw: totalSeedUsdcUnits.toString(),
      totalSeedUsdcUi: Number(totalSeedUsdcUnits) / 1e6,
      totalRequiredHopRawApprox: totalRequiredHopUnits.toString(),
      totalRequiredHopUiApprox: Number(totalRequiredHopUnits) / 1e6,
      rentUnitLamports: {
        feeTier: feeTierRent,
        whirlpool: whirlpoolRent,
        tickArray: tickArrayRent,
        tokenVaultClassic: tokenVaultClassicRent,
        tokenVaultToken2022: tokenVaultT22Rent,
        position: positionRent,
        positionMint: positionMintRent,
        positionTokenAccount: positionTokenRent,
      },
    },
    plans,
    next: failed.length > 0
      ? "Fix simulation failures before any live plan."
      : "If Velon approves, rerun with MESH_WRITE_KEYPAIRS=true to persist signer keypairs, then execute in small batches with exact receipts.",
  };

  const out = writeReceipt("STACC-MESH-BUILD-PLAN-LATEST.json", receipt);
  console.log(`${receipt.verdict} missing=${missing.length} sim=${simulated} failed=${failed.length} solNeeded=${receipt.costModel.totalSolNeeded.toFixed(6)} usdcNeeded=${receipt.costModel.totalSeedUsdcUi.toFixed(6)} receipt=${out}`);
  if (receipt.verdict !== "STACC_MESH_BUILD_PLAN_READY_NO_SEND") process.exitCode = 1;
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
