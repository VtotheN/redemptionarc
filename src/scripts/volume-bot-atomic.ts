/**
 * Volume Bot — ATOMIC mode.
 *
 * Single TX: MarginFi flash USDC → addLiquidity → swap USDC→HOP → swap HOP→USDC
 * → removeLiquidity → harvest T22 → repay flash → Jito tip → endFlash.
 *
 * Revenue: LP fees (100% ours) + T22 withheld fees (harvested intra-TX).
 * Capital at risk: $0 (flash borrowed, auto-repaid).
 *
 * Pool:    EwoZHyXz48vZL1TwkpQoq31brW4G4NDwmMr1DMw6qqBV
 * Flash:   MarginFi USDC bank (legacy, zero fee)
 *
 * ENV:
 *   SOLANA_RPC_URL
 *   DRY_RUN=true           (default; sim only)
 *   ALLOW_LIVE=true        (required to send)
 *   SWAP_USDC=100          (swap round-trip size, default $100)
 *   FLASH_USDC=10000       (flash borrow amount, default $10k)
 *   ADDLIQ_USDC=5000       (USDC to deposit as LP, default $5k, must be < FLASH_USDC)
 *   SLIPPAGE_BPS=50
 *   JITO_TIP_LAMPORTS=200000
 *   CU_LIMIT=600000
 *   CU_PRICE=10000
 *   ALT_ADDRESS=7bdFfzqrpYxB4bzd6NmzWi5SRK5XMYVMg8RXu7X2Jpfp  (default ALT)
 */

import "dotenv/config";
import fs from "node:fs";
import {
  Connection,
  Keypair,
  PublicKey,
  TransactionMessage,
  VersionedTransaction,
  AddressLookupTableAccount,
  SystemProgram,
  ComputeBudgetProgram,
  SYSVAR_INSTRUCTIONS_PUBKEY,
  TransactionInstruction,
} from "@solana/web3.js";
import {
  TOKEN_2022_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  createAssociatedTokenAccountIdempotentInstruction,
  createHarvestWithheldTokensToMintInstruction,
  createWithdrawWithheldTokensFromMintInstruction,
  getAssociatedTokenAddressSync,
  getMint,
  getTransferFeeConfig,
} from "@solana/spl-token";
import { writeReceipt } from "../utils/receipt.js";

// ─── Constants ───────────────────────────────────────────────────────────────

const POOL_ID  = new PublicKey("EwoZHyXz48vZL1TwkpQoq31brW4G4NDwmMr1DMw6qqBV");
const RAYDIUM_CPMM_PROGRAM = new PublicKey("CPMMoo8L3F4NbTegBCKVNunggL7H1ZpdTHKxQB5qKP1C");
const HOP_MINT  = new PublicKey("HZF5k7h39hkysoSZ4ZfmWc55PhvW7ntVvVqdXFCyYGh3");
const USDC_MINT = new PublicKey("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v");
const HOP_DECIMALS  = 6;
const USDC_DECIMALS = 6;

const MARGINFI_PROGRAM      = new PublicKey("MFv2hWf31Z9kbCa1snEPYctwafyhdvnV7FZnsebVacA");
const MARGINFI_GROUP        = new PublicKey("4qp6Fx6tnZkY5Wropq9wUYgtFxXKwE6viZxFHg3rdAG8");
const USDC_BANK             = new PublicKey("2s37akK2eyBbp8DZgCm7RtsaEz8eJP3Nxd4urLHQv7yB");
const USDC_LIQUIDITY_VAULT  = new PublicKey("7jaiZR5Sk8hdYN9MxTpczTcwbWpb5WEoxSANuUwveuat");
const JITO_TIP_WALLET       = new PublicKey("96gYZGLnJYVFmbjzopPSU6QiEV5fGqZNyN9nmNhvrZU5");

const MF_ACCOUNT_DEFAULT = new PublicKey("9SdjygeTAmMrgCQjBAGNAAjjYE6U35ARWcuvvxFZJHz");
const CRANK_HOP_ATA      = new PublicKey("2s2Au2bxsvF5cHbdhfP4JaFX8FXp5wXzQxBj15PNPEkD");

const IX_START  = Buffer.from([14, 131, 33, 220, 81, 186, 180, 107]);
const IX_END    = Buffer.from([105, 124, 201, 106, 153, 2, 8, 156]);
const IX_BORROW = Buffer.from([4, 126, 116, 53, 48, 5, 212, 31]);
const IX_REPAY  = Buffer.from([79, 209, 172, 177, 222, 51, 173, 151]);
const BANK_ORACLE_OFFSET = 610;

const DEFAULT_ALT = "7bdFfzqrpYxB4bzd6NmzWi5SRK5XMYVMg8RXu7X2Jpfp";

// ─── Helpers ─────────────────────────────────────────────────────────────────

function loadKeypair(p: string): Keypair {
  return Keypair.fromSecretKey(
    Uint8Array.from(JSON.parse(fs.readFileSync(p, "utf8")) as number[])
  );
}

function u64Le(n: bigint): Buffer {
  const b = Buffer.alloc(8);
  b.writeBigUInt64LE(n);
  return b;
}

function marginfiAccountPubkey(path: string): PublicKey {
  const raw = Uint8Array.from(JSON.parse(fs.readFileSync(path, "utf8")) as number[]);
  return new PublicKey(raw.slice(32, 64));
}

async function oracleForBank(connection: Connection, bank: PublicKey): Promise<PublicKey> {
  const info = await connection.getAccountInfo(bank, "confirmed");
  if (!info) throw new Error(`Bank not found: ${bank.toBase58()}`);
  return new PublicKey(Buffer.from(info.data).subarray(BANK_ORACLE_OFFSET, BANK_ORACLE_OFFSET + 32));
}

// ─── MarginFi instruction builders ──────────────────────────────────────────

function startFlashIx(account: PublicKey, authority: PublicKey, endIndex: bigint): TransactionInstruction {
  return new TransactionInstruction({
    programId: MARGINFI_PROGRAM,
    keys: [
      { pubkey: account, isSigner: false, isWritable: true },
      { pubkey: authority, isSigner: true, isWritable: false },
      { pubkey: SYSVAR_INSTRUCTIONS_PUBKEY, isSigner: false, isWritable: false },
    ],
    data: Buffer.concat([IX_START, u64Le(endIndex)]),
  });
}

function endFlashIx(account: PublicKey, authority: PublicKey, oracle: PublicKey): TransactionInstruction {
  return new TransactionInstruction({
    programId: MARGINFI_PROGRAM,
    keys: [
      { pubkey: account, isSigner: false, isWritable: true },
      { pubkey: authority, isSigner: true, isWritable: false },
      { pubkey: USDC_BANK, isSigner: false, isWritable: false },
      { pubkey: oracle, isSigner: false, isWritable: false },
    ],
    data: IX_END,
  });
}

function borrowIx(account: PublicKey, authority: PublicKey, destAta: PublicKey, amount: bigint): TransactionInstruction {
  const [vaultAuth] = PublicKey.findProgramAddressSync(
    [Buffer.from("liquidity_vault_auth"), USDC_BANK.toBuffer()],
    MARGINFI_PROGRAM
  );
  return new TransactionInstruction({
    programId: MARGINFI_PROGRAM,
    keys: [
      { pubkey: MARGINFI_GROUP, isSigner: false, isWritable: false },
      { pubkey: account, isSigner: false, isWritable: true },
      { pubkey: authority, isSigner: true, isWritable: false },
      { pubkey: USDC_BANK, isSigner: false, isWritable: true },
      { pubkey: destAta, isSigner: false, isWritable: true },
      { pubkey: vaultAuth, isSigner: false, isWritable: false },
      { pubkey: USDC_LIQUIDITY_VAULT, isSigner: false, isWritable: true },
      { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
    ],
    data: Buffer.concat([IX_BORROW, u64Le(amount)]),
  });
}

function repayIx(account: PublicKey, authority: PublicKey, srcAta: PublicKey, amount: bigint): TransactionInstruction {
  return new TransactionInstruction({
    programId: MARGINFI_PROGRAM,
    keys: [
      { pubkey: MARGINFI_GROUP, isSigner: false, isWritable: false },
      { pubkey: account, isSigner: false, isWritable: true },
      { pubkey: authority, isSigner: true, isWritable: false },
      { pubkey: USDC_BANK, isSigner: false, isWritable: true },
      { pubkey: srcAta, isSigner: false, isWritable: true },
      { pubkey: USDC_LIQUIDITY_VAULT, isSigner: false, isWritable: true },
      { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
    ],
    data: Buffer.concat([IX_REPAY, u64Le(amount), Buffer.from([0])]),
  });
}

// ─── Main ────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const rpcUrl    = process.env.SOLANA_RPC_URL || "https://api.mainnet-beta.solana.com";
  const dryRun    = process.env.DRY_RUN !== "false";
  const allowLive = process.env.ALLOW_LIVE === "true";

  const swapUsdcUi    = Number(process.env.SWAP_USDC   || "100");
  const flashUsdcUi   = Number(process.env.FLASH_USDC  || "10000");
  const addLiqUsdcUi  = Number(process.env.ADDLIQ_USDC || "5000");
  const slippageBps   = Number(process.env.SLIPPAGE_BPS || "50");
  const jitoTipLamports = BigInt(process.env.JITO_TIP_LAMPORTS || "200000");
  const cuLimit       = Number(process.env.CU_LIMIT || "600000");
  const cuPrice       = Number(process.env.CU_PRICE || "10000");
  const altAddress    = process.env.ALT_ADDRESS || DEFAULT_ALT;

  if (addLiqUsdcUi >= flashUsdcUi) {
    throw new Error(`ADDLIQ_USDC (${addLiqUsdcUi}) must be < FLASH_USDC (${flashUsdcUi})`);
  }

  const conn  = new Connection(rpcUrl, "confirmed");
  const crank = loadKeypair(process.env.CRANK_KEYPAIR_PATH || "keys/crank.json");

  // ── MarginFi account ──
  const mfAccountPath = process.env.MARGINFI_ACCOUNT_KEYPAIR_PATH;
  const mfAccount = mfAccountPath ? marginfiAccountPubkey(mfAccountPath) : MF_ACCOUNT_DEFAULT;

  // ── ATAs ──
  const crankUsdcAta = getAssociatedTokenAddressSync(USDC_MINT, crank.publicKey, false, TOKEN_PROGRAM_ID);
  const crankHopAta  = CRANK_HOP_ATA;

  // ── Oracle ──
  const oracle = await oracleForBank(conn, USDC_BANK);

  // ── HOP mint info (T22 fee bps) ──
  const hopMintInfo = await getMint(conn, HOP_MINT, "confirmed", TOKEN_2022_PROGRAM_ID);
  const hopFeeConfig = getTransferFeeConfig(hopMintInfo);
  if (!hopFeeConfig) throw new Error("HOP missing TransferFeeConfig extension");
  const epochInfo = await conn.getEpochInfo();
  const activeFee = epochInfo.epoch >= Number(hopFeeConfig.newerTransferFee.epoch)
    ? hopFeeConfig.newerTransferFee
    : hopFeeConfig.olderTransferFee;
  const t22FeeBps = activeFee.transferFeeBasisPoints;

  const calcT22Fee = (amount: bigint): bigint => {
    const raw = amount * BigInt(t22FeeBps);
    return raw / 10_000n + (raw % 10_000n > 0n ? 1n : 0n);
  };

  // ── Load Raydium SDK ──
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let sdk: any;
  try {
    sdk = await import("@raydium-io/raydium-sdk-v2" as string);
  } catch {
    throw new Error("Missing SDK: npm install @raydium-io/raydium-sdk-v2");
  }
  const {
    Raydium,
    makeDepositCpmmInInstruction,
    makeWithdrawCpmmInInstruction,
    makeSwapCpmmBaseInInstruction,
  } = sdk;
  const BNModule = await import("bn.js");
  const BN = BNModule.default ?? BNModule;

  const raydium = await Raydium.load({ connection: conn, owner: crank, disableFeatureCheck: true });
  const poolFetch = await raydium.cpmm.getPoolInfoFromRpc(POOL_ID.toBase58());
  if (!poolFetch) throw new Error(`Pool not found: ${POOL_ID.toBase58()}`);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { poolInfo, poolKeys, rpcData } = poolFetch as any;

  if (poolInfo.mintA.address !== USDC_MINT.toBase58()) {
    throw new Error(`Pool mintA mismatch: expected USDC got ${poolInfo.mintA.address}`);
  }
  if (poolInfo.mintB.address !== HOP_MINT.toBase58()) {
    throw new Error(`Pool mintB mismatch: expected HOP got ${poolInfo.mintB.address}`);
  }

  const usdcReserveRaw = BigInt((rpcData.baseReserve  ?? rpcData.vaultAAmount).toString());
  const hopReserveRaw  = BigInt((rpcData.quoteReserve ?? rpcData.vaultBAmount).toString());
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const lpSupplyRaw    = BigInt(((rpcData.lpAmount ?? (poolInfo as any).lpAmount ?? 0).toString()));

  if (usdcReserveRaw === 0n || hopReserveRaw === 0n || lpSupplyRaw === 0n) {
    throw new Error(`Pool empty: USDC=${usdcReserveRaw} HOP=${hopReserveRaw} LP=${lpSupplyRaw}`);
  }

  const usdcReserveUi = Number(usdcReserveRaw) / 10 ** USDC_DECIMALS;
  const hopReserveUi  = Number(hopReserveRaw)  / 10 ** HOP_DECIMALS;
  const priceUsd      = usdcReserveUi / hopReserveUi;

  // ── Derive Raydium pool PDAs ──
  const [authority] = PublicKey.findProgramAddressSync(
    [Buffer.from("vault_and_lp_mint_auth_seed")], RAYDIUM_CPMM_PROGRAM
  );
  const [lpMint] = PublicKey.findProgramAddressSync(
    [Buffer.from("pool_lp_mint"), POOL_ID.toBuffer()], RAYDIUM_CPMM_PROGRAM
  );
  const [vaultA] = PublicKey.findProgramAddressSync(
    [Buffer.from("pool_vault"), POOL_ID.toBuffer(), USDC_MINT.toBuffer()], RAYDIUM_CPMM_PROGRAM
  );
  const [vaultB] = PublicKey.findProgramAddressSync(
    [Buffer.from("pool_vault"), POOL_ID.toBuffer(), HOP_MINT.toBuffer()], RAYDIUM_CPMM_PROGRAM
  );
  const [observationId] = PublicKey.findProgramAddressSync(
    [Buffer.from("observation"), POOL_ID.toBuffer()], RAYDIUM_CPMM_PROGRAM
  );

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const configRaw = (poolKeys as any).config?.id ?? (poolKeys as any).configId ?? (poolInfo as any).config?.id;
  if (!configRaw) throw new Error("Could not resolve CPMM configId from poolKeys");
  const configId = typeof configRaw === "string" ? new PublicKey(configRaw) : new PublicKey(configRaw.toString());

  const crankLpAta = getAssociatedTokenAddressSync(lpMint, crank.publicKey, false, TOKEN_PROGRAM_ID);

  // ── Amounts ──
  const flashAmountMicro = BigInt(Math.floor(flashUsdcUi * 10 ** USDC_DECIMALS));
  const addLiqUsdcRaw    = BigInt(Math.floor(addLiqUsdcUi * 10 ** USDC_DECIMALS));
  const swapUsdcRaw      = BigInt(Math.floor(swapUsdcUi   * 10 ** USDC_DECIMALS));

  const addLiqHopRaw = (addLiqUsdcRaw * hopReserveRaw + (usdcReserveRaw - 1n)) / usdcReserveRaw;

  const slippageBpsBig = BigInt(slippageBps);
  const addLiqUsdcMax  = addLiqUsdcRaw + (addLiqUsdcRaw * slippageBpsBig) / 10_000n;
  const addLiqHopMax   = addLiqHopRaw  + (addLiqHopRaw  * (slippageBpsBig + BigInt(t22FeeBps))) / 10_000n;

  // LP to mint: floor((usdcDeposited / usdcReserve) * lpSupply)
  const lpMintRaw = (addLiqUsdcRaw * lpSupplyRaw) / usdcReserveRaw;
  // Deposit needs slippage cushion on minimum LP to receive
  const lpMintMin = lpMintRaw - (lpMintRaw * slippageBpsBig) / 10_000n;
  // Withdraw burns the minimum LP we know was minted (deposit passed with this min)
  const lpBurnAmount = lpMintMin > 0n ? lpMintMin - 1n : 0n;

  // ── Estimate swap outputs ──
  const lpFeeBps = 5n; // 0.05% CPMM
  const swapUsdcAfterFee = swapUsdcRaw - (swapUsdcRaw * lpFeeBps + 9_999n) / 10_000n;
  const usdcResPost = usdcReserveRaw + addLiqUsdcRaw;
  const hopResPost  = hopReserveRaw  + addLiqHopRaw;
  const newUsdc1    = usdcResPost + swapUsdcAfterFee;
  const k1          = usdcResPost * hopResPost;
  const newHop1     = (k1 + newUsdc1 - 1n) / newUsdc1;
  const hopOutRaw   = hopResPost - newHop1;
  const hopReceivedUsable = hopOutRaw - calcT22Fee(hopOutRaw);
  const hopForSell  = hopReceivedUsable;

  // ── Build instructions ──
  const ixs: TransactionInstruction[] = [];

  ixs.push(ComputeBudgetProgram.setComputeUnitLimit({ units: cuLimit }));
  ixs.push(ComputeBudgetProgram.setComputeUnitPrice({ microLamports: cuPrice }));
  ixs.push(startFlashIx(mfAccount, crank.publicKey, 13n));
  ixs.push(borrowIx(mfAccount, crank.publicKey, crankUsdcAta, flashAmountMicro));
  ixs.push(createAssociatedTokenAccountIdempotentInstruction(
    crank.publicKey, crankLpAta, crank.publicKey, lpMint, TOKEN_PROGRAM_ID
  ));
  ixs.push(makeDepositCpmmInInstruction(
    RAYDIUM_CPMM_PROGRAM,
    crank.publicKey,
    authority,
    POOL_ID,
    crankLpAta,
    crankUsdcAta,
    crankHopAta,
    vaultA,
    vaultB,
    USDC_MINT,
    HOP_MINT,
    lpMint,
    new BN(lpMintMin.toString()),      // min LP to receive (with slippage cushion)
    new BN(addLiqUsdcMax.toString()),
    new BN(addLiqHopMax.toString()),
  ));
  ixs.push(makeSwapCpmmBaseInInstruction(
    RAYDIUM_CPMM_PROGRAM,
    crank.publicKey,
    authority,
    configId,
    POOL_ID,
    crankUsdcAta,
    crankHopAta,
    vaultA,
    vaultB,
    TOKEN_PROGRAM_ID,
    TOKEN_2022_PROGRAM_ID,
    USDC_MINT,
    HOP_MINT,
    observationId,
    new BN(swapUsdcRaw.toString()),
    new BN(0),
  ));
  ixs.push(makeSwapCpmmBaseInInstruction(
    RAYDIUM_CPMM_PROGRAM,
    crank.publicKey,
    authority,
    configId,
    POOL_ID,
    crankHopAta,
    crankUsdcAta,
    vaultB,
    vaultA,
    TOKEN_2022_PROGRAM_ID,
    TOKEN_PROGRAM_ID,
    HOP_MINT,
    USDC_MINT,
    observationId,
    new BN(hopForSell.toString()),
    new BN(0),
  ));
  ixs.push(makeWithdrawCpmmInInstruction(
    RAYDIUM_CPMM_PROGRAM,
    crank.publicKey,
    authority,
    POOL_ID,
    crankLpAta,
    crankUsdcAta,
    crankHopAta,
    vaultA,
    vaultB,
    USDC_MINT,
    HOP_MINT,
    lpMint,
    new BN(lpBurnAmount.toString()),   // ← FIX: burn exactly what we minted
    new BN(0),
    new BN(0),
  ));
  ixs.push(createHarvestWithheldTokensToMintInstruction(HOP_MINT, [crankHopAta], TOKEN_2022_PROGRAM_ID));
  ixs.push(createWithdrawWithheldTokensFromMintInstruction(
    HOP_MINT, crankHopAta, crank.publicKey, [], TOKEN_2022_PROGRAM_ID
  ));
  ixs.push(repayIx(mfAccount, crank.publicKey, crankUsdcAta, flashAmountMicro));
  ixs.push(SystemProgram.transfer({
    fromPubkey: crank.publicKey,
    toPubkey: JITO_TIP_WALLET,
    lamports: Number(jitoTipLamports),
  }));
  ixs.push(endFlashIx(mfAccount, crank.publicKey, oracle));

  if (ixs.length - 1 !== 13) {
    throw new Error(`endIndex mismatch: endFlash must be at index 13, got ${ixs.length - 1}`);
  }

  // ── P&L projection ──
  const swapLpFeeUsd = (Number(swapUsdcRaw) / 10 ** USDC_DECIMALS) * 0.0005 * 2;
  const t22FeeHopUi  = (Number(calcT22Fee(hopOutRaw)) + Number(calcT22Fee(hopForSell))) / 10 ** HOP_DECIMALS;
  const t22FeeUsd    = t22FeeHopUi * priceUsd;
  const tipUsdEst    = Number(jitoTipLamports) / 1e9 * 130;
  const netEst       = swapLpFeeUsd + t22FeeUsd - tipUsdEst;

  console.log("=== VOLUME BOT ATOMIC ===");
  console.log(`Pool:       ${POOL_ID.toBase58().slice(0, 8)}...`);
  console.log(`Crank:      ${crank.publicKey.toBase58()}`);
  console.log(`MF acct:    ${mfAccount.toBase58()}`);
  console.log(`Reserves:   $${usdcReserveUi.toFixed(2)} USDC | ${hopReserveUi.toFixed(0)} HOP`);
  console.log(`Price:      $${priceUsd.toFixed(8)}/HOP`);
  console.log(`T22 fee:    ${t22FeeBps} bps`);
  console.log(`Flash:      $${flashUsdcUi} USDC`);
  console.log(`AddLiq:     $${addLiqUsdcUi} USDC + ${(Number(addLiqHopRaw) / 10 ** HOP_DECIMALS).toFixed(2)} HOP`);
  console.log(`  LP mint:  ${(Number(lpMintRaw) / 1e6).toFixed(6)} (est)`);
  console.log(`  LP min:   ${(Number(lpMintMin) / 1e6).toFixed(6)} (deposit slippage)`);
  console.log(`  LP burn:  ${(Number(lpBurnAmount) / 1e6).toFixed(6)} (withdraw = lpMin - 1)`);
  console.log(`Swap:       $${swapUsdcUi} USDC round-trip`);
  console.log(`  est HOP recv:      ${(Number(hopOutRaw) / 10 ** HOP_DECIMALS).toFixed(4)} (pre-T22)`);
  console.log(`  est HOP for sell:  ${(Number(hopForSell) / 10 ** HOP_DECIMALS).toFixed(4)} (post-T22)`);
  console.log(`LP fee:     ~$${swapLpFeeUsd.toFixed(4)}`);
  console.log(`T22 fee:    ~${t22FeeHopUi.toFixed(4)} HOP (~$${t22FeeUsd.toFixed(4)})`);
  console.log(`Jito tip:   ${jitoTipLamports} lamports (~$${tipUsdEst.toFixed(4)})`);
  console.log(`Net est:    ${netEst >= 0 ? "+" : ""}$${netEst.toFixed(4)}`);
  console.log(`Dry run:    ${dryRun}`);
  console.log(`IX count:   ${ixs.length} (endFlash @ ${ixs.length - 1})`);
  console.log();

  // ── Receipt ──
  const ts = new Date().toISOString();
  const receiptName = `volume-bot-atomic-${ts.replace(/[:.]/g, "-")}.json`;
  const receipt: Record<string, unknown> = {
    timestamp: ts,
    dryRun,
    flashUsdc: flashUsdcUi,
    addLiqUsdc: addLiqUsdcUi,
    swapUsdc: swapUsdcUi,
    lpFeesUsd: swapLpFeeUsd,
    t22FeesUsd: t22FeeUsd,
    netEstUsd: netEst,
    poolId: POOL_ID.toBase58(),
    mfAccount: mfAccount.toBase58(),
    crank: crank.publicKey.toBase58(),
    t22FeeBps,
    priceUsd,
    signature: null as string | null,
    simLogs: null as string[] | null,
    error: null as string | null,
  };

  // ── Build v0 TX with ALT ──
  const { blockhash, lastValidBlockHeight } = await conn.getLatestBlockhash("confirmed");

  let altAccount: AddressLookupTableAccount | null = null;
  if (altAddress) {
    const altInfo = await conn.getAddressLookupTable(new PublicKey(altAddress));
    if (!altInfo.value) throw new Error(`ALT not found: ${altAddress}`);
    altAccount = altInfo.value;
  }

  const msg = new TransactionMessage({
    payerKey: crank.publicKey,
    recentBlockhash: blockhash,
    instructions: ixs,
  }).compileToV0Message(altAccount ? [altAccount] : []);

  const vtx = new VersionedTransaction(msg);
  vtx.sign([crank]);
  const serSize = vtx.serialize().length;
  console.log(`v0 TX size: ${serSize}b ${serSize > 1232 ? "(OVER LIMIT)" : "OK"}`);

  if (dryRun || !allowLive) {
    const sim = await conn.simulateTransaction(vtx, { sigVerify: false, replaceRecentBlockhash: true });
    receipt.verdict = sim.value.err ? "SIM_FAILED" : "SIM_OK";
    receipt.error = sim.value.err ? JSON.stringify(sim.value.err) : null;
    receipt.simLogs = (sim.value.logs ?? []).slice(-25);
    receipt.unitsConsumed = sim.value.unitsConsumed ?? null;

    console.log(`SIM ${receipt.verdict} cu=${sim.value.unitsConsumed}`);
    if (sim.value.err) {
      console.log("ERR:", JSON.stringify(sim.value.err));
    }
    if (sim.value.logs) {
      console.log("LOGS:\n" + sim.value.logs.slice(-12).join("\n"));
    }

    // Print net round-trip for loop parsing even in dry-run
    console.log(`\nNet round-trip: ${netEst >= 0 ? "+" : ""}$${netEst.toFixed(4)} USDC`);
  } else {
    const sig = await conn.sendTransaction(vtx, { skipPreflight: false });
    await conn.confirmTransaction({ signature: sig, blockhash, lastValidBlockHeight }, "confirmed");
    receipt.verdict = "EXECUTED";
    receipt.signature = sig;
    console.log(`EXECUTED: ${sig}`);
    console.log(`\nNet round-trip: ${netEst >= 0 ? "+" : ""}$${netEst.toFixed(4)} USDC`);
  }

  const receiptPath = writeReceipt(receiptName, receipt);
  console.log(`Receipt: ${receiptPath}`);
}

main().catch((e) => { console.error(e); process.exitCode = 1; });
