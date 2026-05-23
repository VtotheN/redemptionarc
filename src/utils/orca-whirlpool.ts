import { PublicKey, SystemProgram, SYSVAR_RENT_PUBKEY, TransactionInstruction } from "@solana/web3.js";
import { ASSOCIATED_TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID } from "@solana/spl-token";

export const SPL_MEMO_PROGRAM_ID = new PublicKey("MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr");

export const WHIRLPOOL_PROGRAM_ID = new PublicKey("GxRHMB9a6XE8BqGPeNb9UkJUPvbvrPoPgNTJPJJA4n8h");
export const ORCA_WHIRLPOOLS_CONFIG_DISCRIMINATOR = Buffer.from([157, 20, 49, 224, 217, 87, 193, 254]);

export const ORCA_ACCOUNT_SIZES = {
  whirlpoolsConfig: 108,
  whirlpoolsConfigExtension: 104,
  feeTier: 44,
  tokenBadge: 73,
  whirlpool: 653,
  fixedTickArray: 9988
} as const;

const INITIALIZE_CONFIG = Buffer.from([208, 127, 21, 1, 194, 190, 196, 70]);
const INITIALIZE_CONFIG_EXTENSION = Buffer.from([55, 9, 53, 9, 114, 57, 209, 52]);
const INITIALIZE_FEE_TIER = Buffer.from([183, 74, 156, 160, 112, 2, 42, 30]);
const INITIALIZE_POOL_V2 = Buffer.from([207, 45, 87, 242, 27, 63, 204, 67]);
const INITIALIZE_TICK_ARRAY = Buffer.from([11, 188, 193, 214, 141, 91, 149, 184]);
const INITIALIZE_TOKEN_BADGE = Buffer.from([253, 77, 205, 95, 27, 224, 89, 223]);

function u16Le(value: number): Buffer {
  const out = Buffer.alloc(2);
  out.writeUInt16LE(value);
  return out;
}

function i32Le(value: number): Buffer {
  const out = Buffer.alloc(4);
  out.writeInt32LE(value);
  return out;
}

function u128Le(value: bigint): Buffer {
  const out = Buffer.alloc(16);
  out.writeBigUInt64LE(value & ((1n << 64n) - 1n), 0);
  out.writeBigUInt64LE(value >> 64n, 8);
  return out;
}

export function deriveConfigExtension(config: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync([Buffer.from("config_extension"), config.toBuffer()], WHIRLPOOL_PROGRAM_ID)[0];
}

export function deriveFeeTier(config: PublicKey, tickSpacing: number): PublicKey {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("fee_tier"), config.toBuffer(), u16Le(tickSpacing)],
    WHIRLPOOL_PROGRAM_ID
  )[0];
}

export function deriveTokenBadge(config: PublicKey, mint: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("token_badge"), config.toBuffer(), mint.toBuffer()],
    WHIRLPOOL_PROGRAM_ID
  )[0];
}

export function deriveWhirlpool(config: PublicKey, tokenMintA: PublicKey, tokenMintB: PublicKey, tickSpacing: number): PublicKey {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("whirlpool"), config.toBuffer(), tokenMintA.toBuffer(), tokenMintB.toBuffer(), u16Le(tickSpacing)],
    WHIRLPOOL_PROGRAM_ID
  )[0];
}

export function deriveTickArray(whirlpool: PublicKey, startTickIndex: number): PublicKey {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("tick_array"), whirlpool.toBuffer(), Buffer.from(String(startTickIndex))],
    WHIRLPOOL_PROGRAM_ID
  )[0];
}

export function initializeConfigIx(args: {
  config: PublicKey;
  funder: PublicKey;
  feeAuthority: PublicKey;
  collectProtocolFeesAuthority: PublicKey;
  rewardEmissionsSuperAuthority: PublicKey;
  defaultProtocolFeeRate: number;
}): TransactionInstruction {
  return new TransactionInstruction({
    programId: WHIRLPOOL_PROGRAM_ID,
    keys: [
      { pubkey: args.config, isSigner: true, isWritable: true },
      { pubkey: args.funder, isSigner: true, isWritable: true },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false }
    ],
    data: Buffer.concat([
      INITIALIZE_CONFIG,
      args.feeAuthority.toBuffer(),
      args.collectProtocolFeesAuthority.toBuffer(),
      args.rewardEmissionsSuperAuthority.toBuffer(),
      u16Le(args.defaultProtocolFeeRate)
    ])
  });
}

export function initializeConfigExtensionIx(args: {
  config: PublicKey;
  configExtension: PublicKey;
  funder: PublicKey;
  feeAuthority: PublicKey;
}): TransactionInstruction {
  return new TransactionInstruction({
    programId: WHIRLPOOL_PROGRAM_ID,
    keys: [
      { pubkey: args.config, isSigner: false, isWritable: false },
      { pubkey: args.configExtension, isSigner: false, isWritable: true },
      { pubkey: args.funder, isSigner: true, isWritable: true },
      { pubkey: args.feeAuthority, isSigner: true, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false }
    ],
    data: INITIALIZE_CONFIG_EXTENSION
  });
}

export function initializeFeeTierIx(args: {
  config: PublicKey;
  feeTier: PublicKey;
  funder: PublicKey;
  feeAuthority: PublicKey;
  tickSpacing: number;
  defaultFeeRate: number;
}): TransactionInstruction {
  return new TransactionInstruction({
    programId: WHIRLPOOL_PROGRAM_ID,
    keys: [
      { pubkey: args.config, isSigner: false, isWritable: false },
      { pubkey: args.feeTier, isSigner: false, isWritable: true },
      { pubkey: args.funder, isSigner: true, isWritable: true },
      { pubkey: args.feeAuthority, isSigner: true, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false }
    ],
    data: Buffer.concat([INITIALIZE_FEE_TIER, u16Le(args.tickSpacing), u16Le(args.defaultFeeRate)])
  });
}

export function initializeTokenBadgeIx(args: {
  whirlpoolsConfig: PublicKey;
  whirlpoolsConfigExtension: PublicKey;
  tokenBadgeAuthority: PublicKey;
  tokenMint: PublicKey;
  tokenBadge: PublicKey;
  funder: PublicKey;
}): TransactionInstruction {
  return new TransactionInstruction({
    programId: WHIRLPOOL_PROGRAM_ID,
    keys: [
      { pubkey: args.whirlpoolsConfig, isSigner: false, isWritable: false },
      { pubkey: args.whirlpoolsConfigExtension, isSigner: false, isWritable: false },
      { pubkey: args.tokenBadgeAuthority, isSigner: true, isWritable: false },
      { pubkey: args.tokenMint, isSigner: false, isWritable: false },
      { pubkey: args.tokenBadge, isSigner: false, isWritable: true },
      { pubkey: args.funder, isSigner: true, isWritable: true },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false }
    ],
    data: INITIALIZE_TOKEN_BADGE
  });
}

export function initializePoolV2Ix(args: {
  whirlpoolsConfig: PublicKey;
  tokenMintA: PublicKey;
  tokenMintB: PublicKey;
  tokenBadgeA: PublicKey;
  tokenBadgeB: PublicKey;
  funder: PublicKey;
  whirlpool: PublicKey;
  tokenVaultA: PublicKey;
  tokenVaultB: PublicKey;
  feeTier: PublicKey;
  tokenProgramA?: PublicKey;
  tokenProgramB?: PublicKey;
  tickSpacing: number;
  initialSqrtPrice: bigint;
}): TransactionInstruction {
  return new TransactionInstruction({
    programId: WHIRLPOOL_PROGRAM_ID,
    keys: [
      { pubkey: args.whirlpoolsConfig, isSigner: false, isWritable: false },
      { pubkey: args.tokenMintA, isSigner: false, isWritable: false },
      { pubkey: args.tokenMintB, isSigner: false, isWritable: false },
      { pubkey: args.tokenBadgeA, isSigner: false, isWritable: false },
      { pubkey: args.tokenBadgeB, isSigner: false, isWritable: false },
      { pubkey: args.funder, isSigner: true, isWritable: true },
      { pubkey: args.whirlpool, isSigner: false, isWritable: true },
      { pubkey: args.tokenVaultA, isSigner: true, isWritable: true },
      { pubkey: args.tokenVaultB, isSigner: true, isWritable: true },
      { pubkey: args.feeTier, isSigner: false, isWritable: false },
      { pubkey: args.tokenProgramA ?? TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: args.tokenProgramB ?? TOKEN_2022_PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      { pubkey: SYSVAR_RENT_PUBKEY, isSigner: false, isWritable: false }
    ],
    data: Buffer.concat([INITIALIZE_POOL_V2, u16Le(args.tickSpacing), u128Le(args.initialSqrtPrice)])
  });
}

export function initializeTickArrayIx(args: {
  whirlpool: PublicKey;
  funder: PublicKey;
  tickArray: PublicKey;
  startTickIndex: number;
}): TransactionInstruction {
  return new TransactionInstruction({
    programId: WHIRLPOOL_PROGRAM_ID,
    keys: [
      { pubkey: args.whirlpool, isSigner: false, isWritable: false },
      { pubkey: args.funder, isSigner: true, isWritable: true },
      { pubkey: args.tickArray, isSigner: false, isWritable: true },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false }
    ],
    data: Buffer.concat([INITIALIZE_TICK_ARRAY, i32Le(args.startTickIndex)])
  });
}

const OPEN_POSITION = Buffer.from([0x87, 0x80, 0x2f, 0x4d, 0x0f, 0x98, 0xf0, 0x31]);
const INCREASE_LIQUIDITY_V2 = Buffer.from([0x85, 0x1d, 0x59, 0xdf, 0x45, 0xee, 0xb0, 0x0a]);
const CLOSE_POSITION = Buffer.from([0x7b, 0x86, 0x51, 0x00, 0x31, 0x44, 0x62, 0x62]);

export function openPositionIx(args: {
  funder: PublicKey;
  owner: PublicKey;
  position: PublicKey;
  positionMint: PublicKey;
  positionTokenAccount: PublicKey;
  whirlpool: PublicKey;
  tickLowerIndex: number;
  tickUpperIndex: number;
}): TransactionInstruction {
  const lowerBuf = Buffer.alloc(4); lowerBuf.writeInt32LE(args.tickLowerIndex);
  const upperBuf = Buffer.alloc(4); upperBuf.writeInt32LE(args.tickUpperIndex);
  return new TransactionInstruction({
    programId: WHIRLPOOL_PROGRAM_ID,
    keys: [
      { pubkey: args.funder, isSigner: true, isWritable: true },
      { pubkey: args.owner, isSigner: false, isWritable: false },
      { pubkey: args.position, isSigner: false, isWritable: true },
      { pubkey: args.positionMint, isSigner: true, isWritable: true },
      { pubkey: args.positionTokenAccount, isSigner: false, isWritable: true },
      { pubkey: args.whirlpool, isSigner: false, isWritable: false },
      { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      { pubkey: SYSVAR_RENT_PUBKEY, isSigner: false, isWritable: false },
      { pubkey: ASSOCIATED_TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
    ],
    data: Buffer.concat([OPEN_POSITION, Buffer.from([0]), lowerBuf, upperBuf])
  });
}

export function increaseLiquidityV2Ix(args: {
  whirlpool: PublicKey;
  tokenProgramA: PublicKey;
  tokenProgramB: PublicKey;
  positionAuthority: PublicKey;
  position: PublicKey;
  positionTokenAccount: PublicKey;
  tokenMintA: PublicKey;
  tokenMintB: PublicKey;
  tokenOwnerAccountA: PublicKey;
  tokenOwnerAccountB: PublicKey;
  tokenVaultA: PublicKey;
  tokenVaultB: PublicKey;
  tickArrayLower: PublicKey;
  tickArrayUpper: PublicKey;
  liquidityAmount: bigint;
  tokenMaxA: bigint;
  tokenMaxB: bigint;
}): TransactionInstruction {
  const liqBuf = u128Le(args.liquidityAmount);
  const maxABuf = Buffer.alloc(8); maxABuf.writeBigUInt64LE(args.tokenMaxA);
  const maxBBuf = Buffer.alloc(8); maxBBuf.writeBigUInt64LE(args.tokenMaxB);
  return new TransactionInstruction({
    programId: WHIRLPOOL_PROGRAM_ID,
    keys: [
      { pubkey: args.whirlpool, isSigner: false, isWritable: true },
      { pubkey: args.tokenProgramA, isSigner: false, isWritable: false },
      { pubkey: args.tokenProgramB, isSigner: false, isWritable: false },
      { pubkey: SPL_MEMO_PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: args.positionAuthority, isSigner: true, isWritable: false },
      { pubkey: args.position, isSigner: false, isWritable: true },
      { pubkey: args.positionTokenAccount, isSigner: false, isWritable: false },
      { pubkey: args.tokenMintA, isSigner: false, isWritable: false },
      { pubkey: args.tokenMintB, isSigner: false, isWritable: false },
      { pubkey: args.tokenOwnerAccountA, isSigner: false, isWritable: true },
      { pubkey: args.tokenOwnerAccountB, isSigner: false, isWritable: true },
      { pubkey: args.tokenVaultA, isSigner: false, isWritable: true },
      { pubkey: args.tokenVaultB, isSigner: false, isWritable: true },
      { pubkey: args.tickArrayLower, isSigner: false, isWritable: true },
      { pubkey: args.tickArrayUpper, isSigner: false, isWritable: true },
    ],
    // remaining_accounts_info = None → 0x00
    data: Buffer.concat([INCREASE_LIQUIDITY_V2, liqBuf, maxABuf, maxBBuf, Buffer.from([0x00])])
  });
}

export function closePositionIx(args: {
  positionAuthority: PublicKey;
  receiver: PublicKey;
  position: PublicKey;
  positionMint: PublicKey;
  positionTokenAccount: PublicKey;
}): TransactionInstruction {
  return new TransactionInstruction({
    programId: WHIRLPOOL_PROGRAM_ID,
    keys: [
      { pubkey: args.positionAuthority, isSigner: true, isWritable: false },
      { pubkey: args.receiver, isSigner: false, isWritable: true },
      { pubkey: args.position, isSigner: false, isWritable: true },
      { pubkey: args.positionMint, isSigner: false, isWritable: true },
      { pubkey: args.positionTokenAccount, isSigner: false, isWritable: true },
      { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
    ],
    data: CLOSE_POSITION
  });
}

// Tick → sqrtPriceX64 conversion
export function tickToSqrtPriceX64(tick: number): bigint {
  const sqrtPrice = Math.pow(1.0001, tick / 2);
  const scale = 1_000_000_000_000_000n;
  return (BigInt(Math.round(sqrtPrice * Number(scale))) * (1n << 64n)) / scale;
}

// Liquidity from amount_a (token_a units) given sqrtPrice range
export function liquidityFromAmountA(amountA: bigint, sqrtP: bigint, sqrtPUpper: bigint): bigint {
  return (amountA * sqrtP * sqrtPUpper) / ((sqrtPUpper - sqrtP) * (1n << 64n));
}

// Required amount_b from liquidity and sqrtPrice range
export function amountBFromLiquidity(liquidity: bigint, sqrtP: bigint, sqrtPLower: bigint): bigint {
  return (liquidity * (sqrtP - sqrtPLower)) / (1n << 64n);
}

export function serializableInstruction(ix: TransactionInstruction) {
  return {
    programId: ix.programId.toBase58(),
    keys: ix.keys.map((key) => ({
      pubkey: key.pubkey.toBase58(),
      isSigner: key.isSigner,
      isWritable: key.isWritable
    })),
    dataHex: Buffer.from(ix.data).toString("hex")
  };
}

