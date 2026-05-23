import { AccountMeta, PublicKey, SYSVAR_INSTRUCTIONS_PUBKEY, TransactionInstruction } from "@solana/web3.js";
import { TOKEN_PROGRAM_ID } from "@solana/spl-token";
import { connectionFor } from "./rpc.js";

export const MARGINFI_PROGRAM = new PublicKey("MFv2hWf31Z9kbCa1snEPYctwafyhdvnV7FZnsebVacA");
export const MARGINFI_GROUP = new PublicKey("4qp6Fx6tnZkY5Wropq9wUYgtFxXKwE6viZxFHg3rdAG8");
export const MARGINFI_USDC_BANK = new PublicKey("2s37akK2eyBbp8DZgCm7RtsaEz8eJP3Nxd4urLHQv7yB");
export const MARGINFI_USDC_LIQUIDITY_VAULT = new PublicKey("7jaiZR5Sk8hdYN9MxTpczTcwbWpb5WEoxSANuUwveuat");
export const JITO_TIP_WALLET = new PublicKey("96gYZGLnJYVFmbjzopPSU6QiEV5fGqZNyN9nmNhvrZU5");

export const USER_PROVIDED_FLASH_BORROW_DISCRIMINATOR = Buffer.from([135, 231, 52, 167, 7, 52, 212, 193]);
export const USER_PROVIDED_FLASH_REPAY_DISCRIMINATOR = Buffer.from([185, 117, 0, 203, 96, 245, 180, 186]);

const START_FLASH = Buffer.from([14, 131, 33, 220, 81, 186, 180, 107]);
const END_FLASH = Buffer.from([105, 124, 201, 106, 153, 2, 8, 156]);
const LENDING_ACCOUNT_BORROW = Buffer.from([4, 126, 116, 53, 48, 5, 212, 31]);
const LENDING_ACCOUNT_REPAY = Buffer.from([79, 209, 172, 177, 222, 51, 173, 151]);
const BANK_ORACLE_KEYS_OFFSET = 610;

export function u64Le(value: bigint): Buffer {
  const out = Buffer.alloc(8);
  out.writeBigUInt64LE(value);
  return out;
}

export function startFlashIx(account: PublicKey, authority: PublicKey, endIndex: bigint): TransactionInstruction {
  return new TransactionInstruction({
    programId: MARGINFI_PROGRAM,
    keys: [
      { pubkey: account, isSigner: false, isWritable: true },
      { pubkey: authority, isSigner: true, isWritable: false },
      { pubkey: SYSVAR_INSTRUCTIONS_PUBKEY, isSigner: false, isWritable: false }
    ],
    data: Buffer.concat([START_FLASH, u64Le(endIndex)])
  });
}

export function endFlashIx(account: PublicKey, authority: PublicKey, oracle: PublicKey): TransactionInstruction {
  return new TransactionInstruction({
    programId: MARGINFI_PROGRAM,
    keys: [
      { pubkey: account, isSigner: false, isWritable: true },
      { pubkey: authority, isSigner: true, isWritable: false },
      { pubkey: MARGINFI_USDC_BANK, isSigner: false, isWritable: false },
      { pubkey: oracle, isSigner: false, isWritable: false }
    ],
    data: END_FLASH
  });
}

export function borrowIx(account: PublicKey, authority: PublicKey, destinationAta: PublicKey, amount: bigint): TransactionInstruction {
  const [vaultAuthority] = PublicKey.findProgramAddressSync(
    [Buffer.from("liquidity_vault_auth"), MARGINFI_USDC_BANK.toBuffer()],
    MARGINFI_PROGRAM
  );
  return new TransactionInstruction({
    programId: MARGINFI_PROGRAM,
    keys: [
      { pubkey: MARGINFI_GROUP, isSigner: false, isWritable: false },
      { pubkey: account, isSigner: false, isWritable: true },
      { pubkey: authority, isSigner: true, isWritable: false },
      { pubkey: MARGINFI_USDC_BANK, isSigner: false, isWritable: true },
      { pubkey: destinationAta, isSigner: false, isWritable: true },
      { pubkey: vaultAuthority, isSigner: false, isWritable: false },
      { pubkey: MARGINFI_USDC_LIQUIDITY_VAULT, isSigner: false, isWritable: true },
      { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false }
    ],
    data: Buffer.concat([LENDING_ACCOUNT_BORROW, u64Le(amount)])
  });
}

export function repayIx(account: PublicKey, authority: PublicKey, sourceAta: PublicKey, amount: bigint): TransactionInstruction {
  return new TransactionInstruction({
    programId: MARGINFI_PROGRAM,
    keys: [
      { pubkey: MARGINFI_GROUP, isSigner: false, isWritable: false },
      { pubkey: account, isSigner: false, isWritable: true },
      { pubkey: authority, isSigner: true, isWritable: false },
      { pubkey: MARGINFI_USDC_BANK, isSigner: false, isWritable: true },
      { pubkey: sourceAta, isSigner: false, isWritable: true },
      { pubkey: MARGINFI_USDC_LIQUIDITY_VAULT, isSigner: false, isWritable: true },
      { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false }
    ],
    data: Buffer.concat([LENDING_ACCOUNT_REPAY, u64Le(amount), Buffer.from([0])])
  });
}

export async function oracleForBank(connection: ReturnType<typeof connectionFor>, bank = MARGINFI_USDC_BANK): Promise<PublicKey> {
  const info = await connection.getAccountInfo(bank, "confirmed");
  if (!info) throw new Error(`MarginFi bank missing on-chain: ${bank.toBase58()}`);
  return new PublicKey(Buffer.from(info.data).subarray(BANK_ORACLE_KEYS_OFFSET, BANK_ORACLE_KEYS_OFFSET + 32));
}

export async function bankHealthMetas(connection: ReturnType<typeof connectionFor>, bank = MARGINFI_USDC_BANK): Promise<AccountMeta[]> {
  const oracle = await oracleForBank(connection, bank);
  return [
    { pubkey: bank, isSigner: false, isWritable: false },
    { pubkey: oracle, isSigner: false, isWritable: false }
  ];
}

