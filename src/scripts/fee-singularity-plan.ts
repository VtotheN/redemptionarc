/**
 * FEE-SINGULARITY no-send planner.
 *
 * Builds and simulates the intended single-v0-TX core:
 *   MarginFi flash -> borrow USDC -> fork Whirlpool USDC/HOP
 *   -> four Token-2022 transfer-fee hops -> harvest/withdraw withheld HOP
 *   -> fork Whirlpool HOP/USDC -> repay -> optional tip -> end flash.
 *
 * This script never sends a transaction. It writes an exact receipt and blocks
 * live execution unless wallet cash and total-system accounting both pass.
 */
import "dotenv/config";
import fs from "node:fs";
import {
  AddressLookupTableAccount,
  ComputeBudgetProgram,
  PublicKey,
  SystemProgram,
  TransactionInstruction,
  TransactionMessage,
  VersionedTransaction,
} from "@solana/web3.js";
import {
  createAssociatedTokenAccountIdempotentInstruction,
  createHarvestWithheldTokensToMintInstruction,
  createTransferCheckedWithFeeInstruction,
  createWithdrawWithheldTokensFromMintInstruction,
  getAccount,
  getAssociatedTokenAddressSync,
  getMint,
  getTransferFeeConfig,
  TOKEN_2022_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
} from "@solana/spl-token";
import { loadConfig } from "../config.js";
import { HOP_MINT_DEFAULT, USDC_MINT_DEFAULT } from "../constants.js";
import { loadKeypair, publicKeyFromKeypairFile } from "../utils/keypair.js";
import {
  borrowIx,
  endFlashIx,
  JITO_TIP_WALLET,
  MARGINFI_USDC_BANK,
  MARGINFI_USDC_LIQUIDITY_VAULT,
  oracleForBank,
  repayIx,
  startFlashIx,
} from "../utils/marginfi.js";
import { writeReceipt } from "../utils/receipt.js";
import { connectionFor } from "../utils/rpc.js";
import { serializableInstruction, SPL_MEMO_PROGRAM_ID, WHIRLPOOL_PROGRAM_ID } from "../utils/orca-whirlpool.js";

const WHIRLPOOL = new PublicKey("8aoWgf7ycbeKv6BTFCdUj4JR7Y4mXWuPZWEUhmuzN5ZL");
const WHIRLPOOLS_CONFIG = new PublicKey("9Nr7o1muxPfcsxv4WtTN2GdUFKhUsdR7WHejyJdesTmZ");
const TOKEN_VAULT_A = new PublicKey("4QD4GgnjRvjETqWLT5e3x7SHtJSzs9kShUPLfyHcTu7d");
const TOKEN_VAULT_B = new PublicKey("Qv51R47g7pMDxa3UofXaz8cNr8pwRSXaNufgnEWX8Yk");
const TICK_ARRAY_84480 = new PublicKey("be9QKj4mYB8erh6r4ZDrKxxSvSYSUNRfpTxqJUgd3jG");
const TICK_ARRAY_90112 = new PublicKey("CDMSB5e6WUgtoSLrybvYm4j58Jue3eqpzHQVLmgVkAe4");
const TICK_ARRAY_95744 = new PublicKey("MXd8HXPjcH9ZCuyr4uKKyN7GkJ5YizZQkgUndB6J8Gz");
const ORACLE = new PublicKey("5qhXANMqTNNzdp1N1PrMzWzSzjHTZxuLPELcmpog6bp5");

const USDC_MINT = new PublicKey(USDC_MINT_DEFAULT);
const HOP_MINT = new PublicKey(HOP_MINT_DEFAULT);
const HOP_DECIMALS = 6;
const USDC_DECIMALS = 6;
const TARGET_HOP_FEE_BPS = 1;

const SWAP_V2_DISC = Buffer.from([0x2b, 0x04, 0xed, 0x0b, 0x1a, 0xc9, 0x1e, 0x62]);
const MIN_SQRT_PRICE = 4295048016n;
const MAX_SQRT_PRICE = 79226673515401279992447579055n;
const Q64 = 1n << 64n;

type PoolState = {
  feeRate: number;
  protocolFeeRate: number;
  liquidity: bigint;
  sqrtPrice: bigint;
  tickCurrentIndex: number;
  protocolFeeOwedA: bigint;
  protocolFeeOwedB: bigint;
  tokenMintA: PublicKey;
  tokenMintB: PublicKey;
};

type AccountState = {
  exists: boolean;
  amountRaw: string | null;
  amountUi: number | null;
  delegate: string | null;
  delegatedAmount: string | null;
  closeAuthority: string | null;
  error?: string;
};

function u64Le(value: bigint): Buffer {
  const out = Buffer.alloc(8);
  out.writeBigUInt64LE(value);
  return out;
}

function u128Le(value: bigint): Buffer {
  const out = Buffer.alloc(16);
  out.writeBigUInt64LE(value & ((1n << 64n) - 1n), 0);
  out.writeBigUInt64LE(value >> 64n, 8);
  return out;
}

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

function readPubkey(data: Buffer, offset: number): PublicKey {
  return new PublicKey(data.subarray(offset, offset + 32));
}

async function tokenAccountState(
  connection: ReturnType<typeof connectionFor>,
  ata: PublicKey,
  tokenProgram = TOKEN_2022_PROGRAM_ID,
): Promise<AccountState> {
  try {
    const account = await getAccount(connection, ata, "confirmed", tokenProgram);
    return {
      exists: true,
      amountRaw: account.amount.toString(),
      amountUi: Number(account.amount) / 10 ** HOP_DECIMALS,
      delegate: account.delegate?.toBase58() ?? null,
      delegatedAmount: account.delegatedAmount.toString(),
      closeAuthority: account.closeAuthority?.toBase58() ?? null,
    };
  } catch (error) {
    return {
      exists: false,
      amountRaw: null,
      amountUi: null,
      delegate: null,
      delegatedAmount: null,
      closeAuthority: null,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

async function readPoolState(connection: ReturnType<typeof connectionFor>): Promise<PoolState> {
  const info = await connection.getAccountInfo(WHIRLPOOL, "confirmed");
  if (!info) throw new Error(`Missing fork pool ${WHIRLPOOL.toBase58()}`);
  if (!info.owner.equals(WHIRLPOOL_PROGRAM_ID)) {
    throw new Error(`Pool owner mismatch: ${info.owner.toBase58()}`);
  }
  const data = Buffer.from(info.data);
  return {
    feeRate: readU16(data, 45),
    protocolFeeRate: readU16(data, 47),
    liquidity: readU128(data, 49),
    sqrtPrice: readU128(data, 65),
    tickCurrentIndex: readI32(data, 81),
    protocolFeeOwedA: readU64(data, 85),
    protocolFeeOwedB: readU64(data, 93),
    tokenMintA: readPubkey(data, 101),
    tokenMintB: readPubkey(data, 181),
  };
}

function nextSqrtPriceFromAmountA(sqrtP: bigint, liquidity: bigint, amountIn: bigint): bigint {
  const num = liquidity * sqrtP;
  const den = (liquidity << 64n) + amountIn * sqrtP;
  return (num * Q64 + den - 1n) / den;
}

function nextSqrtPriceFromAmountB(sqrtP: bigint, liquidity: bigint, amountIn: bigint): bigint {
  return sqrtP + (amountIn * Q64) / liquidity;
}

function amountDeltaB(sqrtPLow: bigint, sqrtPHigh: bigint, liquidity: bigint): bigint {
  return (liquidity * (sqrtPHigh - sqrtPLow)) >> 64n;
}

function amountDeltaA(sqrtPLow: bigint, sqrtPHigh: bigint, liquidity: bigint): bigint {
  return (liquidity * (sqrtPHigh - sqrtPLow) + sqrtPHigh - 1n) / sqrtPHigh * Q64 / sqrtPLow;
}

function ceilDiv(numerator: bigint, denominator: bigint): bigint {
  return (numerator + denominator - 1n) / denominator;
}

function transferFee(amount: bigint, bps: number, maximumFee: bigint): bigint {
  const fee = ceilDiv(amount * BigInt(bps), 10_000n);
  return fee > maximumFee ? maximumFee : fee;
}

function swapFee(amount: bigint, feeRate: number): bigint {
  return ceilDiv(amount * BigInt(feeRate), 1_000_000n);
}

function computeSwapAToB(pool: PoolState, amountUsdc: bigint) {
  const feeAmount = swapFee(amountUsdc, pool.feeRate);
  const amountAfterFee = amountUsdc - feeAmount;
  const nextSqrtP = nextSqrtPriceFromAmountA(pool.sqrtPrice, pool.liquidity, amountAfterFee);
  const hopOut = amountDeltaB(nextSqrtP, pool.sqrtPrice, pool.liquidity);
  const protocolFee = (feeAmount * BigInt(pool.protocolFeeRate)) / 10_000n;
  return { feeAmount, protocolFee, amountAfterFee, hopOut, nextSqrtP };
}

function computeSwapBToA(pool: PoolState, sqrtP: bigint, amountHop: bigint) {
  const feeAmount = swapFee(amountHop, pool.feeRate);
  const amountAfterFee = amountHop - feeAmount;
  const nextSqrtP = nextSqrtPriceFromAmountB(sqrtP, pool.liquidity, amountAfterFee);
  const usdcOut = amountDeltaA(sqrtP, nextSqrtP, pool.liquidity);
  const protocolFee = (feeAmount * BigInt(pool.protocolFeeRate)) / 10_000n;
  return { feeAmount, protocolFee, amountAfterFee, usdcOut, nextSqrtP };
}

function swapV2Ix(args: {
  tokenAuthority: PublicKey;
  tokenOwnerAccountA: PublicKey;
  tokenOwnerAccountB: PublicKey;
  tickArray0: PublicKey;
  tickArray1: PublicKey;
  tickArray2: PublicKey;
  amount: bigint;
  otherAmountThreshold: bigint;
  sqrtPriceLimit: bigint;
  amountSpecifiedIsInput: boolean;
  aToB: boolean;
}): TransactionInstruction {
  return new TransactionInstruction({
    programId: WHIRLPOOL_PROGRAM_ID,
    keys: [
      { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: TOKEN_2022_PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: SPL_MEMO_PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: args.tokenAuthority, isSigner: true, isWritable: false },
      { pubkey: WHIRLPOOL, isSigner: false, isWritable: true },
      { pubkey: USDC_MINT, isSigner: false, isWritable: false },
      { pubkey: HOP_MINT, isSigner: false, isWritable: true },
      { pubkey: args.tokenOwnerAccountA, isSigner: false, isWritable: true },
      { pubkey: TOKEN_VAULT_A, isSigner: false, isWritable: true },
      { pubkey: args.tokenOwnerAccountB, isSigner: false, isWritable: true },
      { pubkey: TOKEN_VAULT_B, isSigner: false, isWritable: true },
      { pubkey: args.tickArray0, isSigner: false, isWritable: true },
      { pubkey: args.tickArray1, isSigner: false, isWritable: true },
      { pubkey: args.tickArray2, isSigner: false, isWritable: true },
      { pubkey: ORACLE, isSigner: false, isWritable: true },
    ],
    data: Buffer.concat([
      SWAP_V2_DISC,
      u64Le(args.amount),
      u64Le(args.otherAmountThreshold),
      u128Le(args.sqrtPriceLimit),
      Buffer.from([args.amountSpecifiedIsInput ? 1 : 0]),
      Buffer.from([args.aToB ? 1 : 0]),
      Buffer.from([0x00]),
    ]),
  });
}

async function loadLookupTable(connection: ReturnType<typeof connectionFor>): Promise<AddressLookupTableAccount | null> {
  const altAddress = process.env.ALT_ADDRESS || (fs.existsSync("receipts/vol-alt-address.txt")
    ? fs.readFileSync("receipts/vol-alt-address.txt", "utf8").trim()
    : "");
  if (!altAddress) return null;
  const result = await connection.getAddressLookupTable(new PublicKey(altAddress));
  return result.value;
}

function keypairPubkey(path: string): PublicKey {
  return publicKeyFromKeypairFile(path);
}

async function main() {
  const config = loadConfig();
  const connection = connectionFor(config.rpcUrl);
  const crank = loadKeypair(process.env.CRANK_KEYPAIR_PATH || "keys/crank.json");
  const marginfiAccount = keypairPubkey(process.env.MARGINFI_ACCOUNT_KEYPAIR_PATH || "keys/marginfi-account.json");
  const ringWallets = [
    crank.publicKey,
    keypairPubkey(process.env.RING_B_KEYPAIR_PATH || "keys/ring1.json"),
    keypairPubkey(process.env.RING_C_KEYPAIR_PATH || "keys/ring2.json"),
    keypairPubkey(process.env.RING_D_KEYPAIR_PATH || "keys/ring3.json"),
  ];

  const flashUsdcUi = Number(process.env.FLASH_AMOUNT_USDC || "1");
  const flashMicro = BigInt(Math.floor(flashUsdcUi * 10 ** USDC_DECIMALS));
  const cuLimit = Number(process.env.CU_LIMIT || "900000");
  const cuPrice = Number(process.env.CU_PRICE || "1000");
  const jitoTipLamports = BigInt(process.env.JITO_TIP_LAMPORTS || "0");
  const solPriceUsd = config.solPriceUsd ?? Number(process.env.SOL_PRICE_USD || "85");
  const minNetUsd = Number(process.env.MIN_NET_USD || "0.01");

  const crankUsdcAta = getAssociatedTokenAddressSync(USDC_MINT, crank.publicKey, false, TOKEN_PROGRAM_ID);
  const ringAtas = ringWallets.map((owner) => getAssociatedTokenAddressSync(HOP_MINT, owner, false, TOKEN_2022_PROGRAM_ID));
  const crankHopAta = ringAtas[0];

  const [
    pool,
    oracle,
    hopMintInfo,
    epochInfo,
    marginfiVault,
    beforeUsdc,
    beforeHop,
    beforeSol,
    ringAccountStates,
  ] = await Promise.all([
    readPoolState(connection),
    oracleForBank(connection),
    getMint(connection, HOP_MINT, "confirmed", TOKEN_2022_PROGRAM_ID),
    connection.getEpochInfo("confirmed"),
    connection.getTokenAccountBalance(MARGINFI_USDC_LIQUIDITY_VAULT, "confirmed").catch(() => null),
    connection.getTokenAccountBalance(crankUsdcAta, "confirmed").catch(() => null),
    connection.getTokenAccountBalance(crankHopAta, "confirmed").catch(() => null),
    connection.getBalance(crank.publicKey, "confirmed"),
    Promise.all(ringAtas.map((ata) => tokenAccountState(connection, ata))),
  ]);

  if (!pool.tokenMintA.equals(USDC_MINT) || !pool.tokenMintB.equals(HOP_MINT)) {
    throw new Error(`Unexpected fork pool mints: ${pool.tokenMintA.toBase58()} / ${pool.tokenMintB.toBase58()}`);
  }

  const feeConfig = getTransferFeeConfig(hopMintInfo);
  if (!feeConfig) throw new Error("HOP mint missing transfer fee config");
  const activeTransferFee = epochInfo.epoch >= Number(feeConfig.newerTransferFee.epoch)
    ? feeConfig.newerTransferFee
    : feeConfig.olderTransferFee;
  const activeHopFeeBps = activeTransferFee.transferFeeBasisPoints;
  const maxHopFee = activeTransferFee.maximumFee;

  const swap1 = computeSwapAToB(pool, flashMicro);
  const swap1HopT22Fee = transferFee(swap1.hopOut, activeHopFeeBps, maxHopFee);
  let ringAmount = swap1.hopOut - swap1HopT22Fee;
  const ringHaircutBps = Number(process.env.RING_HOP_HAIRCUT_BPS || "0");
  if (ringHaircutBps > 0) ringAmount -= (ringAmount * BigInt(ringHaircutBps)) / 10_000n;

  const ring = [];
  let amount = ringAmount;
  let ringWithheld = 0n;
  for (let i = 0; i < 4; i++) {
    const fee = transferFee(amount, activeHopFeeBps, maxHopFee);
    const delivered = amount - fee;
    ring.push({
      from: i,
      to: (i + 1) % 4,
      input: amount,
      fee,
      delivered,
    });
    ringWithheld += fee;
    amount = delivered;
  }

  const restoredHopForSwap2 = ring[3].delivered + ringWithheld + swap1HopT22Fee;
  const swap2 = computeSwapBToA(pool, swap1.nextSqrtP, restoredHopForSwap2);
  const walletUsdcDeltaMicro = swap2.usdcOut - flashMicro;
  const crankUsdcBeforeRaw = BigInt(beforeUsdc?.value.amount ?? "0");
  const requiredCrankUsdcCushionMicro = swap2.usdcOut >= flashMicro ? 0n : flashMicro - swap2.usdcOut;
  const repayCushionAvailable = crankUsdcBeforeRaw >= requiredCrankUsdcCushionMicro;
  const gasLamports = 5_000n + (BigInt(cuLimit) * BigInt(cuPrice)) / 1_000_000n + jitoTipLamports;
  const gasUsd = Number(gasLamports) / 1e9 * solPriceUsd;
  const walletCashNetUsd = Number(walletUsdcDeltaMicro) / 1e6 - gasUsd;
  const ownPoolUsdcLiabilityUsd = Math.max(0, Number(swap2.usdcOut - flashMicro) / 1e6);
  const totalSystemNetUsd = walletCashNetUsd - ownPoolUsdcLiabilityUsd;

  const precheckBlockers = [
    activeHopFeeBps === TARGET_HOP_FEE_BPS ? null : `active HOP fee is ${activeHopFeeBps}bps until epoch ${feeConfig.newerTransferFee.epoch.toString()}`,
    BigInt(marginfiVault?.value.amount ?? "0") >= flashMicro ? null : "MarginFi USDC vault is below requested flash amount",
    ...ringAccountStates.flatMap((state, index) => {
      if (!state.exists) return [`ring ATA ${index} missing for current HOP mint`];
      if (index > 0 && state.delegate !== crank.publicKey.toBase58()) return [`ring ATA ${index} is not delegated to crank`];
      return [];
    }),
    repayCushionAvailable ? null : `repay shortfall ${requiredCrankUsdcCushionMicro.toString()} micro-USDC; crank has ${crankUsdcBeforeRaw.toString()}`,
    walletCashNetUsd > minNetUsd ? null : `wallet cash net ${walletCashNetUsd.toFixed(6)} below MIN_NET_USD ${minNetUsd}`,
    totalSystemNetUsd > minNetUsd ? null : `total-system net ${totalSystemNetUsd.toFixed(6)} below MIN_NET_USD ${minNetUsd}`,
  ].filter((reason): reason is string => Boolean(reason));

  const ixs: TransactionInstruction[] = [
    ComputeBudgetProgram.setComputeUnitLimit({ units: cuLimit }),
    ComputeBudgetProgram.setComputeUnitPrice({ microLamports: cuPrice }),
    startFlashIx(marginfiAccount, crank.publicKey, 15n),
    createAssociatedTokenAccountIdempotentInstruction(crank.publicKey, crankUsdcAta, crank.publicKey, USDC_MINT),
    borrowIx(marginfiAccount, crank.publicKey, crankUsdcAta, flashMicro),
    swapV2Ix({
      tokenAuthority: crank.publicKey,
      tokenOwnerAccountA: crankUsdcAta,
      tokenOwnerAccountB: crankHopAta,
      tickArray0: TICK_ARRAY_90112,
      tickArray1: TICK_ARRAY_84480,
      tickArray2: TICK_ARRAY_84480,
      amount: flashMicro,
      otherAmountThreshold: 0n,
      sqrtPriceLimit: MIN_SQRT_PRICE,
      amountSpecifiedIsInput: true,
      aToB: true,
    }),
    ...ring.map((leg) => createTransferCheckedWithFeeInstruction(
      ringAtas[leg.from],
      HOP_MINT,
      ringAtas[leg.to],
      crank.publicKey,
      leg.input,
      HOP_DECIMALS,
      leg.fee,
      [],
      TOKEN_2022_PROGRAM_ID,
    )),
    createHarvestWithheldTokensToMintInstruction(HOP_MINT, ringAtas, TOKEN_2022_PROGRAM_ID),
    createWithdrawWithheldTokensFromMintInstruction(HOP_MINT, crankHopAta, crank.publicKey, [], TOKEN_2022_PROGRAM_ID),
    swapV2Ix({
      tokenAuthority: crank.publicKey,
      tokenOwnerAccountA: crankUsdcAta,
      tokenOwnerAccountB: crankHopAta,
      tickArray0: TICK_ARRAY_90112,
      tickArray1: TICK_ARRAY_95744,
      tickArray2: TICK_ARRAY_95744,
      amount: restoredHopForSwap2,
      otherAmountThreshold: 0n,
      sqrtPriceLimit: MAX_SQRT_PRICE,
      amountSpecifiedIsInput: true,
      aToB: false,
    }),
    repayIx(marginfiAccount, crank.publicKey, crankUsdcAta, flashMicro),
    SystemProgram.transfer({ fromPubkey: crank.publicKey, toPubkey: JITO_TIP_WALLET, lamports: Number(jitoTipLamports) }),
    endFlashIx(marginfiAccount, crank.publicKey, oracle),
  ];

  const endFlashIndex = ixs.length - 1;
  if (endFlashIndex !== 15) throw new Error(`endIndex mismatch: expected 15 got ${endFlashIndex}`);
  const instructionPlan = [
    "compute_unit_limit",
    "compute_unit_price",
    "marginfi_start_flash",
    "create_crank_usdc_ata_idempotent",
    "marginfi_borrow_usdc",
    "fork_whirlpool_swap_usdc_to_hop",
    "t22_ring_a_to_b",
    "t22_ring_b_to_c",
    "t22_ring_c_to_d",
    "t22_ring_d_to_a",
    "t22_harvest_withheld_to_mint",
    "t22_withdraw_withheld_from_mint_to_crank_hop",
    "fork_whirlpool_swap_hop_to_usdc",
    "marginfi_repay_usdc",
    "optional_jito_tip",
    "marginfi_end_flash",
  ];

  const { blockhash } = await connection.getLatestBlockhash("confirmed");
  const lookupTable = await loadLookupTable(connection);
  const message = new TransactionMessage({
    payerKey: crank.publicKey,
    recentBlockhash: blockhash,
    instructions: ixs,
  }).compileToV0Message(lookupTable ? [lookupTable] : []);

  const tx = new VersionedTransaction(message);
  tx.sign([crank]);

  let serializedLength: number | null = null;
  let serializedLengthError: string | null = null;
  try {
    serializedLength = tx.serialize().length;
  } catch (error) {
    serializedLengthError = error instanceof Error ? error.message : String(error);
  }

  let simErr: unknown = null;
  let simUnits: number | null = null;
  let simLogs: string[] = [];
  try {
    const sim = await connection.simulateTransaction(tx, {
      sigVerify: false,
      replaceRecentBlockhash: true,
      commitment: "confirmed",
    });
    simErr = sim.value.err ?? null;
    simUnits = sim.value.unitsConsumed ?? null;
    simLogs = sim.value.logs ?? [];
  } catch (error) {
    simErr = { simulationBuildError: error instanceof Error ? error.message : String(error) };
  }

  const simBlockers = [
    serializedLength != null && serializedLength <= 1232 ? null : `serialized tx size ${serializedLength ?? "unknown"} exceeds packet limit`,
    simErr == null ? null : `simulation failed: ${JSON.stringify(simErr)}`,
  ].filter((reason): reason is string => Boolean(reason));

  const liveBlockers = [...precheckBlockers, ...simBlockers];
  const receipt = {
    verdict: liveBlockers.length === 0 ? "FEE_SINGULARITY_EXACT_SIM_READY" : "FEE_SINGULARITY_NO_GO",
    generatedAt: new Date().toISOString(),
    noSend: true,
    dryRunOnly: true,
    flashAmountUsdc: flashUsdcUi,
    forkPool: {
      program: WHIRLPOOL_PROGRAM_ID.toBase58(),
      config: WHIRLPOOLS_CONFIG.toBase58(),
      whirlpool: WHIRLPOOL.toBase58(),
      tickCurrentIndex: pool.tickCurrentIndex,
      liquidity: pool.liquidity.toString(),
      feeRate: pool.feeRate,
      protocolFeeRate: pool.protocolFeeRate,
      protocolFeeOwedA: pool.protocolFeeOwedA.toString(),
      protocolFeeOwedB: pool.protocolFeeOwedB.toString(),
    },
    hopTransferFee: {
      currentEpoch: epochInfo.epoch,
      activeBps: activeHopFeeBps,
      targetBps: TARGET_HOP_FEE_BPS,
      newerBps: feeConfig.newerTransferFee.transferFeeBasisPoints,
      newerEpoch: feeConfig.newerTransferFee.epoch.toString(),
      maximumFee: maxHopFee.toString(),
    },
    ring: ring.map((leg) => ({
      from: leg.from,
      to: leg.to,
      sourceAta: ringAtas[leg.from].toBase58(),
      destinationAta: ringAtas[leg.to].toBase58(),
      inputRaw: leg.input.toString(),
      feeRaw: leg.fee.toString(),
      deliveredRaw: leg.delivered.toString(),
    })),
    estimates: {
      swap1HopOutRaw: swap1.hopOut.toString(),
      swap1HopT22FeeRaw: swap1HopT22Fee.toString(),
      ringStartRaw: ringAmount.toString(),
      ringWithheldRaw: ringWithheld.toString(),
      restoredHopForSwap2Raw: restoredHopForSwap2.toString(),
      swap2UsdcOutRaw: swap2.usdcOut.toString(),
      walletUsdcDeltaMicro: walletUsdcDeltaMicro.toString(),
      requiredCrankUsdcCushionMicro: requiredCrankUsdcCushionMicro.toString(),
      repayCushionAvailable,
      gasLamports: gasLamports.toString(),
      gasUsd,
      walletCashNetUsd,
      ownPoolUsdcLiabilityUsd,
      totalSystemNetUsd,
    },
    balancesBefore: {
      crankSol: beforeSol / 1e9,
      crankUsdc: Number(crankUsdcBeforeRaw) / 1e6,
      crankHop: Number(beforeHop?.value.amount ?? "0") / 1e6,
      marginfiUsdcAvailable: Number(marginfiVault?.value.amount ?? "0") / 1e6,
    },
    ringAccountStates: ringAccountStates.map((state, index) => ({
      index,
      owner: ringWallets[index].toBase58(),
      ata: ringAtas[index].toBase58(),
      ...state,
    })),
    transaction: {
      instructionCount: ixs.length,
      endFlashIndex,
      instructionPlan,
      serializedLength,
      serializedLengthError,
      addressLookupTable: lookupTable ? {
        address: lookupTable.key.toBase58(),
        addresses: lookupTable.state.addresses.length,
      } : null,
      instructions: ixs.map(serializableInstruction),
    },
    simulation: {
      err: simErr,
      unitsConsumed: simUnits,
      logs: simLogs.slice(-20),
    },
    cashProofGate: {
      sourceClass: "self-routed-token2022-fee-plus-owned-fork-liquidity",
      walletCashNetUsd,
      totalSystemNetUsd,
      pass: liveBlockers.length === 0,
      rejectionReasons: liveBlockers,
      note: "Wallet cash can improve while owned fork LP loses value; total-system net blocks that as non-profit.",
    },
  };

  const out = writeReceipt("FEE-SINGULARITY-PLAN-LATEST.json", receipt);
  console.log(`${receipt.verdict} receipt=${out}`);
  console.log(`tx_size=${serializedLength ?? "unknown"} sim_err=${simErr == null ? "null" : JSON.stringify(simErr)}`);
  console.log(`wallet_cash_net_usd=${walletCashNetUsd.toFixed(6)} total_system_net_usd=${totalSystemNetUsd.toFixed(6)}`);
  if (liveBlockers.length > 0) console.log(`blocked=${liveBlockers.join(" | ")}`);
  if (liveBlockers.length > 0) process.exitCode = 1;
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
