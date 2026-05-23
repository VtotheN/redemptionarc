import { PublicKey, SystemProgram, SYSVAR_RENT_PUBKEY, TransactionInstruction } from "@solana/web3.js";
import { TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID } from "@solana/spl-token";

export const WHIRLPOOL_PROGRAM_ID = new PublicKey("whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc");
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

