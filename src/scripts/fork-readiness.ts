/**
 * Read-only readiness receipt for the RedemptionArc Orca fork.
 *
 * This is the operator gate after moving liquidity away from the official
 * KPX9 pool. It records the real fork state and blocks live flywheel sends
 * unless the cash-settled preconditions are true.
 */
import "dotenv/config";
import fs from "node:fs";
import { LAMPORTS_PER_SOL, PublicKey } from "@solana/web3.js";
import {
  getAccount,
  getAssociatedTokenAddressSync,
  getMint,
  getTransferFeeConfig,
  TOKEN_2022_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
} from "@solana/spl-token";
import { loadConfig } from "../config.js";
import { HOP_MINT_DEFAULT, OUR_WHIRLPOOL_PROGRAM_ID, USDC_MINT_DEFAULT } from "../constants.js";
import { publicKeyFromKeypairFile } from "../utils/keypair.js";
import { writeReceipt } from "../utils/receipt.js";
import { connectionFor } from "../utils/rpc.js";

const FORK_CONFIG = new PublicKey("9Nr7o1muxPfcsxv4WtTN2GdUFKhUsdR7WHejyJdesTmZ");
const FORK_POOL = new PublicKey("8aoWgf7ycbeKv6BTFCdUj4JR7Y4mXWuPZWEUhmuzN5ZL");
const USDC_MINT = new PublicKey(USDC_MINT_DEFAULT);
const HOP_MINT = new PublicKey(HOP_MINT_DEFAULT);
const OFFICIAL_KPX9_POSITION = new PublicKey("59LWLWVULsY2QszQZJurs2yvkjwvfpZNnbA5jBqQpMbd");
const OLD_FORK_POSITION = new PublicKey("ErgQU48egJMNBLZeVkdjrtZrSWUQJCky3deh2B4U1YPQ");
const TARGET_HOP_FEE_BPS = 1;
const DEFAULT_CRANK = new PublicKey("8pWEfpJas2tgS8iE7ZyHKNjeDSEixqSwK12W4tagNJ3S");

type AddLiquidityReceipt = {
  position?: string;
};

type FlywheelReceipt = {
  cashProofPass?: boolean;
  simErr?: unknown;
  cashGateReasons?: string[];
};

function readU16(data: Buffer, offset: number): number {
  return data.readUInt16LE(offset);
}

function readI32(data: Buffer, offset: number): number {
  return data.readInt32LE(offset);
}

function readU64(data: Buffer, offset: number): bigint {
  return data.readBigUInt64LE(offset);
}

function readU128(data: Buffer, offset: number): bigint {
  const lo = data.readBigUInt64LE(offset);
  const hi = data.readBigUInt64LE(offset + 8);
  return lo | (hi << 64n);
}

function readPubkey(data: Buffer, offset: number): string {
  return new PublicKey(data.subarray(offset, offset + 32)).toBase58();
}

function readJson<T>(file: string): T | null {
  if (!fs.existsSync(file)) return null;
  return JSON.parse(fs.readFileSync(file, "utf8")) as T;
}

function crankPubkey(configCrank?: PublicKey): PublicKey {
  if (configCrank) return configCrank;
  if (fs.existsSync("keys/crank.json")) return publicKeyFromKeypairFile("keys/crank.json");
  return DEFAULT_CRANK;
}

function latestForkPositions(): PublicKey[] {
  const values = new Set<string>([OLD_FORK_POSITION.toBase58()]);
  const latest = readJson<AddLiquidityReceipt>("receipts/REDEMPTION-ORCA-ADD-LIQ.json");
  if (latest?.position) values.add(latest.position);
  return [...values].map((value) => new PublicKey(value));
}

function decodeConfig(data: Buffer) {
  return {
    feeAuthority: readPubkey(data, 8),
    collectProtocolFeesAuthority: readPubkey(data, 40),
    rewardEmissionsSuperAuthority: readPubkey(data, 72),
    defaultProtocolFeeRate: readU16(data, 104),
  };
}

function decodePool(data: Buffer) {
  return {
    whirlpoolsConfig: readPubkey(data, 8),
    tickSpacing: readU16(data, 41),
    feeRate: readU16(data, 45),
    protocolFeeRate: readU16(data, 47),
    liquidity: readU128(data, 49),
    sqrtPrice: readU128(data, 65),
    tickCurrentIndex: readI32(data, 81),
    protocolFeeOwedA: readU64(data, 85),
    protocolFeeOwedB: readU64(data, 93),
    tokenMintA: readPubkey(data, 101),
    tokenVaultA: readPubkey(data, 133),
    tokenMintB: readPubkey(data, 181),
    tokenVaultB: readPubkey(data, 213),
  };
}

function decodePosition(pubkey: PublicKey, data: Buffer) {
  return {
    position: pubkey.toBase58(),
    whirlpool: readPubkey(data, 8),
    positionMint: readPubkey(data, 40),
    liquidity: readU128(data, 72).toString(),
    tickLowerIndex: readI32(data, 88),
    tickUpperIndex: readI32(data, 92),
    feeOwedA: readU64(data, 112).toString(),
    feeOwedB: readU64(data, 136).toString(),
  };
}

async function tokenAmountRaw(args: {
  owner: PublicKey;
  mint: PublicKey;
  tokenProgram: PublicKey;
  connection: ReturnType<typeof connectionFor>;
}): Promise<bigint> {
  const ata = getAssociatedTokenAddressSync(args.mint, args.owner, false, args.tokenProgram);
  return getAccount(args.connection, ata, "confirmed", args.tokenProgram)
    .then((account) => account.amount)
    .catch(() => 0n);
}

async function main() {
  const config = loadConfig();
  const connection = connectionFor(config.rpcUrl);
  const crank = crankPubkey(config.crank);

  const [
    configInfo,
    poolInfo,
    officialPositionInfo,
    crankLamports,
    crankUsdcRaw,
    crankHopRaw,
    hopMintInfo,
    epochInfo,
  ] = await Promise.all([
    connection.getAccountInfo(FORK_CONFIG, "confirmed"),
    connection.getAccountInfo(FORK_POOL, "confirmed"),
    connection.getAccountInfo(OFFICIAL_KPX9_POSITION, "confirmed"),
    connection.getBalance(crank, "confirmed"),
    tokenAmountRaw({ owner: crank, mint: USDC_MINT, tokenProgram: TOKEN_PROGRAM_ID, connection }),
    tokenAmountRaw({ owner: crank, mint: HOP_MINT, tokenProgram: TOKEN_2022_PROGRAM_ID, connection }),
    getMint(connection, HOP_MINT, "confirmed", TOKEN_2022_PROGRAM_ID),
    connection.getEpochInfo("confirmed"),
  ]);

  if (!configInfo) throw new Error(`Missing fork config ${FORK_CONFIG.toBase58()}`);
  if (!poolInfo) throw new Error(`Missing fork pool ${FORK_POOL.toBase58()}`);

  const decodedConfig = decodeConfig(Buffer.from(configInfo.data));
  const decodedPool = decodePool(Buffer.from(poolInfo.data));
  const feeConfig = getTransferFeeConfig(hopMintInfo);
  if (!feeConfig) throw new Error("HOP mint missing transfer fee config");

  const activeTransferFee = epochInfo.epoch >= Number(feeConfig.newerTransferFee.epoch)
    ? feeConfig.newerTransferFee
    : feeConfig.olderTransferFee;

  const positions = await Promise.all(latestForkPositions().map(async (position) => {
    const info = await connection.getAccountInfo(position, "confirmed");
    return info
      ? decodePosition(position, Buffer.from(info.data))
      : { position: position.toBase58(), exists: false };
  }));

  const lastFlywheel = readJson<FlywheelReceipt>("receipts/FLYWHEEL-RUN-001.json");
  const protocolFeeOwedA = BigInt(decodedPool.protocolFeeOwedA);
  const protocolFeeOwedB = BigInt(decodedPool.protocolFeeOwedB);
  const activeHopFeeBps = activeTransferFee.transferFeeBasisPoints;
  const targetFeeEpoch = Number(feeConfig.newerTransferFee.epoch);
  const epochsAfterCurrentEpoch = Math.max(targetFeeEpoch - epochInfo.epoch - 1, 0);
  const slotsUntilTargetFeeEpoch = activeHopFeeBps === TARGET_HOP_FEE_BPS
    ? 0
    : (epochInfo.slotsInEpoch - epochInfo.slotIndex) + epochsAfterCurrentEpoch * epochInfo.slotsInEpoch;

  const liveBlockers = [
    poolInfo.owner.equals(OUR_WHIRLPOOL_PROGRAM_ID) ? null : "fork pool owner is not the fork program",
    decodedPool.whirlpoolsConfig === FORK_CONFIG.toBase58() ? null : "fork pool does not use the expected fork config",
    officialPositionInfo == null ? null : "official KPX9 position still exists",
    activeHopFeeBps === TARGET_HOP_FEE_BPS ? null : `HOP active transfer fee is ${activeHopFeeBps}bps until epoch ${feeConfig.newerTransferFee.epoch.toString()}`,
    crankUsdcRaw > 0n ? null : "crank has 0 USDC; current flash route cannot repay round-trip loss",
    protocolFeeOwedA > 0n ? null : "fork pool has 0 claimable USDC protocol fees",
    lastFlywheel?.cashProofPass === true ? null : "latest flywheel cash proof is not passing",
    lastFlywheel?.simErr == null ? null : "latest flywheel simulation has an error",
  ].filter((reason): reason is string => Boolean(reason));

  const receipt = {
    verdict: liveBlockers.length === 0 ? "FORK_READY_FOR_EXACT_LIVE_APPROVAL" : "FORK_LIVE_TX_BLOCKED",
    generatedAt: new Date().toISOString(),
    program: OUR_WHIRLPOOL_PROGRAM_ID.toBase58(),
    config: {
      address: FORK_CONFIG.toBase58(),
      owner: configInfo.owner.toBase58(),
      ownerMatchesForkProgram: configInfo.owner.equals(OUR_WHIRLPOOL_PROGRAM_ID),
      ...decodedConfig,
    },
    pool: {
      address: FORK_POOL.toBase58(),
      owner: poolInfo.owner.toBase58(),
      ownerMatchesForkProgram: poolInfo.owner.equals(OUR_WHIRLPOOL_PROGRAM_ID),
      ...decodedPool,
      liquidity: decodedPool.liquidity.toString(),
      sqrtPrice: decodedPool.sqrtPrice.toString(),
      protocolFeeOwedA: protocolFeeOwedA.toString(),
      protocolFeeOwedB: protocolFeeOwedB.toString(),
      protocolFeeOwedUsdcUi: Number(protocolFeeOwedA) / 1e6,
      protocolFeeOwedHopUi: Number(protocolFeeOwedB) / 1e6,
    },
    positions,
    officialKpx9: {
      position: OFFICIAL_KPX9_POSITION.toBase58(),
      positionExists: officialPositionInfo != null,
    },
    hopTransferFee: {
      currentEpoch: epochInfo.epoch,
      slotsUntilNextEpoch: epochInfo.slotsInEpoch - epochInfo.slotIndex,
      targetFeeEpoch,
      slotsUntilTargetFeeEpoch,
      activeBps: activeHopFeeBps,
      targetBps: TARGET_HOP_FEE_BPS,
      olderBps: feeConfig.olderTransferFee.transferFeeBasisPoints,
      olderEpoch: feeConfig.olderTransferFee.epoch.toString(),
      newerBps: feeConfig.newerTransferFee.transferFeeBasisPoints,
      newerEpoch: feeConfig.newerTransferFee.epoch.toString(),
      mintWithheldAmount: feeConfig.withheldAmount.toString(),
    },
    crank: {
      pubkey: crank.toBase58(),
      sol: crankLamports / LAMPORTS_PER_SOL,
      usdc: Number(crankUsdcRaw) / 1e6,
      hopTrackedNonCash: Number(crankHopRaw) / 1e6,
    },
    latestFlywheelReceipt: lastFlywheel
      ? {
        cashProofPass: lastFlywheel.cashProofPass ?? null,
        simErr: lastFlywheel.simErr ?? null,
        cashGateReasons: lastFlywheel.cashGateReasons ?? [],
      }
      : null,
    liveBlockers,
    nextSafeActions: [
      "Do not run live flywheel-bot while HOP active transfer fee is 690bps.",
      "Wait until epoch 978 for the scheduled 1bps fee to become active, then rerun this readiness receipt.",
      "Redesign flywheel tx if using flash repayment: fees must settle before repay or the crank needs explicit USDC cushion that is accounted as cost.",
      "Treat HOP as non-cash until a real USDC/SOL settlement route exists.",
    ],
  };

  const file = writeReceipt("FORK-READINESS-LATEST.json", receipt);
  console.log(`${receipt.verdict} receipt=${file}`);
  console.log(`pool=${FORK_POOL.toBase58()} config=${decodedPool.whirlpoolsConfig}`);
  console.log(`active_hop_fee_bps=${activeHopFeeBps} protocol_fee_usdc=${Number(protocolFeeOwedA) / 1e6}`);
  console.log(`crank_sol=${(crankLamports / LAMPORTS_PER_SOL).toFixed(9)} crank_usdc=${(Number(crankUsdcRaw) / 1e6).toFixed(6)}`);
  if (liveBlockers.length > 0) console.log(`blocked=${liveBlockers.join(" | ")}`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
