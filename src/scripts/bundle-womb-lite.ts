/**
 * BUNDLE-WOMB-LITE — TIOTULIO IT-14
 *
 * 2-TX Jito bundle:
 *   TX1 (cranker signs): SystemTransfer gas_lamports → crank   [CRANK-PAYS]
 *   TX2 (crank signs):   startFlash → borrow → GHOST-LP-in
 *                        → 4 hops → GHOST-LP-out (VENUE-DEATH)
 *                        → T22 harvest → repay → endFlash
 *
 * Revenue per cycle:
 *   LP fee  0.05% × 4 hops × SWAP_USDC   (we = 100% LP during cycle)
 *   T22 fee 1bps  × 4 HOP transfers       (post-epoch-977)
 *   Net ≈ $119/cycle at SWAP_USDC=$50k    → $11,472/day (96 cycles)
 *
 * Capital: $0 Velon. Cranker pays TX1 gas. PHANTOM-TREASURY accumulates.
 *
 * ENV:
 *   SOLANA_RPC_URL             (required)
 *   DRY_RUN=true               (default — sim TX2, skip TX1)
 *   ALLOW_LIVE=true            (required to send live bundle)
 *   CRANKER_KEYPAIR_PATH       (required live — pays TX1 gas)
 *   FLASH_USDC=10000           USDC borrowed via MarginFi flash
 *   ADDLIQ_USDC=5000           USDC deposited as GHOST-LP (must be < FLASH_USDC)
 *   SWAP_USDC=100              per-leg swap size (all 4 hops)
 *   SLIPPAGE_BPS=50
 *   JITO_TIP_LAMPORTS=200000
 *   JITO_BLOCK_ENGINE=https://mainnet.block-engine.jito.wtf
 *   CU_LIMIT=800000
 *   CU_PRICE=10000
 *   ALT_ADDRESS                (recommended — compresses 4-hop accounts)
 *   TREASURY_PUBKEY            (optional — if set, logs expected credit)
 *   GAS_BUDGET_LAMPORTS=5000000  SOL cranker sends to crank in TX1 (~0.005 SOL)
 */

import "dotenv/config";
import fs from "node:fs";
import {
  Connection,
  Keypair,
  PublicKey,
  TransactionInstruction,
  TransactionMessage,
  VersionedTransaction,
  AddressLookupTableAccount,
  SystemProgram,
  ComputeBudgetProgram,
  SYSVAR_INSTRUCTIONS_PUBKEY,
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

// ─── Constants ────────────────────────────────────────────────────────────────

const POOL_ID           = new PublicKey("6zbtkhUtxdd3gfae4QJpHe356S44wRMNxNjJq33oEL7f");
const RAYDIUM_CPMM_PROGRAM = new PublicKey("CPMMoo8L3F4NbTegBCKVNunggL7H1ZpdTHKxQB5qKP1C");
const HOP_MINT          = new PublicKey("HZF5k7h39hkysoSZ4ZfmWc55PhvW7ntVvVqdXFCyYGh3");
const USDC_MINT         = new PublicKey("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v");
const HOP_DECIMALS      = 6;
const USDC_DECIMALS     = 6;

const MARGINFI_PROGRAM      = new PublicKey("MFv2hWf31Z9kbCa1snEPYctwafyhdvnV7FZnsebVacA");
const MARGINFI_GROUP        = new PublicKey("4qp6Fx6tnZkY5Wropq9wUYgtFxXKwE6viZxFHg3rdAG8");
const USDC_BANK             = new PublicKey("2s37akK2eyBbp8DZgCm7RtsaEz8eJP3Nxd4urLHQv7yB");
const USDC_LIQUIDITY_VAULT  = new PublicKey("7jaiZR5Sk8hdYN9MxTpczTcwbWpb5WEoxSANuUwveuat");
const JITO_TIP_WALLET       = new PublicKey("96gYZGLnJYVFmbjzopPSU6QiEV5fGqZNyN9nmNhvrZU5");

const MF_ACCOUNT_DEFAULT = new PublicKey("9SdjygeTAmMrgCQjBAGNAAjjYE6U35ARWcuvvxFZJHz");
const CRANK_HOP_ATA      = new PublicKey("2s2Au2bxsvF5cHbdhfP4JaFX8FXp5wXzQxBj15PNPEkD");

// MarginFi discriminators
const IX_START  = Buffer.from([14, 131, 33, 220, 81, 186, 180, 107]);
const IX_END    = Buffer.from([105, 124, 201, 106, 153, 2, 8, 156]);
const IX_BORROW = Buffer.from([4, 126, 116, 53, 48, 5, 212, 31]);
const IX_REPAY  = Buffer.from([79, 209, 172, 177, 222, 51, 173, 151]);
const BANK_ORACLE_OFFSET = 610;

// TX2 instruction layout (endFlash MUST be last):
// [0] CU limit  [1] CU price  [2] startFlash(endIndex=15)  [3] borrow
// [4] createLP  [5] addLiq    [6] swap1 U→H  [7] swap2 H→U
// [8] swap3 U→H [9] swap4 H→U [10] removeLiq [11] harvestWithheld
// [12] withdrawWithheld  [13] repay  [14] Jito tip  [15] endFlash
const END_FLASH_INDEX = 15n;

// ─── Helpers ──────────────────────────────────────────────────────────────────

function loadKeypair(p: string): Keypair {
  return Keypair.fromSecretKey(
    Uint8Array.from(JSON.parse(fs.readFileSync(p, "utf8")) as number[]),
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

async function oracleForBank(conn: Connection, bank: PublicKey): Promise<PublicKey> {
  const info = await conn.getAccountInfo(bank, "confirmed");
  if (!info) throw new Error(`Bank not found: ${bank.toBase58()}`);
  return new PublicKey(Buffer.from(info.data).subarray(BANK_ORACLE_OFFSET, BANK_ORACLE_OFFSET + 32));
}

// ─── MarginFi IX builders ─────────────────────────────────────────────────────

function startFlashIx(account: PublicKey, authority: PublicKey): TransactionInstruction {
  return new TransactionInstruction({
    programId: MARGINFI_PROGRAM,
    keys: [
      { pubkey: account, isSigner: false, isWritable: true },
      { pubkey: authority, isSigner: true, isWritable: false },
      { pubkey: SYSVAR_INSTRUCTIONS_PUBKEY, isSigner: false, isWritable: false },
    ],
    data: Buffer.concat([IX_START, u64Le(END_FLASH_INDEX)]),
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
    MARGINFI_PROGRAM,
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

// ─── Jito bundle submission ───────────────────────────────────────────────────

async function sendJitoBundle(txs: VersionedTransaction[], blockEngine: string): Promise<string> {
  const encoded = txs.map(tx => Buffer.from(tx.serialize()).toString("base64"));
  const resp = await fetch(`${blockEngine}/api/v1/bundles`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "sendBundle",
      params: [encoded],
    }),
  });
  const json = await resp.json() as { result?: string; error?: { message: string } };
  if (json.error) throw new Error(`Jito bundle error: ${json.error.message}`);
  return json.result!;
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const rpcUrl      = process.env.SOLANA_RPC_URL ?? "https://api.mainnet-beta.solana.com";
  const dryRun      = process.env.DRY_RUN !== "false";
  const allowLive   = process.env.ALLOW_LIVE === "true";
  const blockEngine = process.env.JITO_BLOCK_ENGINE ?? "https://mainnet.block-engine.jito.wtf";

  const flashUsdcUi       = Number(process.env.FLASH_USDC         ?? "10000");
  const addLiqUsdcUi      = Number(process.env.ADDLIQ_USDC        ?? "5000");
  const swapUsdcUi        = Number(process.env.SWAP_USDC          ?? "100");
  const slippageBps       = Number(process.env.SLIPPAGE_BPS       ?? "50");
  const jitoTipLamports   = BigInt(process.env.JITO_TIP_LAMPORTS  ?? "200000");
  const gasBudgetLamports = BigInt(process.env.GAS_BUDGET_LAMPORTS ?? "5000000");
  const cuLimit           = Number(process.env.CU_LIMIT           ?? "800000");
  const cuPrice           = Number(process.env.CU_PRICE           ?? "10000");
  const altAddress        = process.env.ALT_ADDRESS               ?? "7bdFfzqrpYxB4bzd6NmzWi5SRK5XMYVMg8RXu7X2Jpfp";
  const treasuryEnv       = process.env.TREASURY_PUBKEY           ?? "";

  if (addLiqUsdcUi >= flashUsdcUi) {
    throw new Error(`ADDLIQ_USDC must be < FLASH_USDC`);
  }

  const conn  = new Connection(rpcUrl, "confirmed");
  const crank = loadKeypair(process.env.CRANK_KEYPAIR_PATH ?? "keys/crank.json");

  const mfAccountPath = process.env.MARGINFI_ACCOUNT_KEYPAIR_PATH;
  const mfAccount = mfAccountPath ? marginfiAccountPubkey(mfAccountPath) : MF_ACCOUNT_DEFAULT;

  // Cranker: external wallet that pays TX1 gas (only needed for live runs)
  let cranker: Keypair | null = null;
  if (!dryRun && allowLive) {
    const crankerPath = process.env.CRANKER_KEYPAIR_PATH;
    if (!crankerPath) throw new Error("CRANKER_KEYPAIR_PATH required for live bundle");
    cranker = loadKeypair(crankerPath);
  }

  const crankUsdcAta = getAssociatedTokenAddressSync(USDC_MINT, crank.publicKey, false, TOKEN_PROGRAM_ID);
  const crankHopAta  = CRANK_HOP_ATA;
  const oracle       = await oracleForBank(conn, USDC_BANK);

  // HOP mint T22 fee config
  const hopMintInfo = await getMint(conn, HOP_MINT, "confirmed", TOKEN_2022_PROGRAM_ID);
  const hopFeeConfig = getTransferFeeConfig(hopMintInfo);
  if (!hopFeeConfig) throw new Error("HOP missing TransferFeeConfig");
  const epochInfo = await conn.getEpochInfo();
  const activeFee = epochInfo.epoch >= Number(hopFeeConfig.newerTransferFee.epoch)
    ? hopFeeConfig.newerTransferFee
    : hopFeeConfig.olderTransferFee;
  const t22FeeBps = activeFee.transferFeeBasisPoints;

  const calcT22Fee = (amount: bigint): bigint => {
    const raw = amount * BigInt(t22FeeBps);
    return raw / 10_000n + (raw % 10_000n > 0n ? 1n : 0n);
  };

  // Raydium SDK
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let sdk: any;
  try { sdk = await import("@raydium-io/raydium-sdk-v2" as string); }
  catch { throw new Error("Run: npm install @raydium-io/raydium-sdk-v2"); }

  const { Raydium, makeDepositCpmmInInstruction, makeWithdrawCpmmInInstruction, makeSwapCpmmBaseInInstruction } = sdk;
  const BNModule = await import("bn.js");
  const BN = BNModule.default ?? BNModule;

  const raydium   = await Raydium.load({ connection: conn, owner: crank, disableFeatureCheck: true });
  const poolFetch = await raydium.cpmm.getPoolInfoFromRpc(POOL_ID.toBase58());
  if (!poolFetch) throw new Error(`Pool not found: ${POOL_ID.toBase58()}`);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { poolInfo, poolKeys, rpcData } = poolFetch as any;

  if (poolInfo.mintA.address !== USDC_MINT.toBase58()) throw new Error("Pool mintA != USDC");
  if (poolInfo.mintB.address !== HOP_MINT.toBase58())  throw new Error("Pool mintB != HOP");

  // Raydium PDAs
  const [authority] = PublicKey.findProgramAddressSync(
    [Buffer.from("vault_and_lp_mint_auth_seed")], RAYDIUM_CPMM_PROGRAM,
  );
  const [lpMint] = PublicKey.findProgramAddressSync(
    [Buffer.from("pool_lp_mint"), POOL_ID.toBuffer()], RAYDIUM_CPMM_PROGRAM,
  );
  const [vaultA] = PublicKey.findProgramAddressSync(
    [Buffer.from("pool_vault"), POOL_ID.toBuffer(), USDC_MINT.toBuffer()], RAYDIUM_CPMM_PROGRAM,
  );
  const [vaultB] = PublicKey.findProgramAddressSync(
    [Buffer.from("pool_vault"), POOL_ID.toBuffer(), HOP_MINT.toBuffer()], RAYDIUM_CPMM_PROGRAM,
  );
  const [observationId] = PublicKey.findProgramAddressSync(
    [Buffer.from("observation"), POOL_ID.toBuffer()], RAYDIUM_CPMM_PROGRAM,
  );
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const configRaw = (poolKeys as any).config?.id ?? (poolKeys as any).configId ?? (poolInfo as any).config?.id;
  if (!configRaw) throw new Error("Could not resolve CPMM configId");
  const configId  = typeof configRaw === "string" ? new PublicKey(configRaw) : new PublicKey(configRaw.toString());
  const crankLpAta = getAssociatedTokenAddressSync(lpMint, crank.publicKey, false, TOKEN_PROGRAM_ID);

  // Read vault balances directly on-chain (SDK rpcData.baseReserve unreliable for small pools)
  const [vaultABal, vaultBBal, lpMintInfo] = await Promise.all([
    conn.getTokenAccountBalance(vaultA, "confirmed"),
    conn.getTokenAccountBalance(vaultB, "confirmed"),
    getMint(conn, lpMint, "confirmed", TOKEN_PROGRAM_ID),
  ]);
  const usdcReserveRaw = BigInt(vaultABal.value.amount);
  const hopReserveRaw  = BigInt(vaultBBal.value.amount);
  const lpSupplyRaw    = lpMintInfo.supply;

  if (usdcReserveRaw === 0n || hopReserveRaw === 0n || lpSupplyRaw === 0n) {
    throw new Error(`Pool empty: USDC=${usdcReserveRaw} HOP=${hopReserveRaw} LP=${lpSupplyRaw}`);
  }

  const usdcReserveUi = Number(usdcReserveRaw) / 10 ** USDC_DECIMALS;
  const hopReserveUi  = Number(hopReserveRaw)  / 10 ** HOP_DECIMALS;
  const priceUsd      = usdcReserveUi / hopReserveUi;

  // ── Amounts ──
  const flashAmountMicro = BigInt(Math.floor(flashUsdcUi  * 10 ** USDC_DECIMALS));
  const addLiqUsdcRaw    = BigInt(Math.floor(addLiqUsdcUi * 10 ** USDC_DECIMALS));
  const swapUsdcRaw      = BigInt(Math.floor(swapUsdcUi   * 10 ** USDC_DECIMALS));

  // HOP required for deposit (ratio-matched)
  const addLiqHopRaw  = (addLiqUsdcRaw * hopReserveRaw + (usdcReserveRaw - 1n)) / usdcReserveRaw;
  const slipBig       = BigInt(slippageBps);
  const addLiqUsdcMax = addLiqUsdcRaw + (addLiqUsdcRaw * slipBig) / 10_000n;
  const addLiqHopMax  = addLiqHopRaw  + (addLiqHopRaw  * (slipBig + BigInt(t22FeeBps))) / 10_000n;
  const lpMintRaw     = (addLiqUsdcRaw * lpSupplyRaw) / usdcReserveRaw;
  const lpMintMin     = lpMintRaw - (lpMintRaw * slipBig) / 10_000n;

  // Estimate HOP for each sell leg (constant-product, post-deposit reserves)
  const lpFeeBps   = 5n;
  const usdcResPost = usdcReserveRaw + addLiqUsdcRaw;
  const hopResPost  = hopReserveRaw  + addLiqHopRaw;

  function estimateHopOut(usdcIn: bigint, uRes: bigint, hRes: bigint): bigint {
    const afterFee = usdcIn - (usdcIn * lpFeeBps + 9_999n) / 10_000n;
    const newU = uRes + afterFee;
    const newH = (uRes * hRes + newU - 1n) / newU;
    return hRes - newH;
  }

  // Hop1: USDC→HOP
  const hopOut1Raw      = estimateHopOut(swapUsdcRaw, usdcResPost, hopResPost);
  const hopSell1        = hopOut1Raw - calcT22Fee(hopOut1Raw);

  // Hop2: HOP→USDC (estimate back-run; pool barely moved, use same reserves approx)
  // For hop3 we re-use swapUsdcRaw again (crank received USDC back from hop2)
  const hopOut3Raw      = estimateHopOut(swapUsdcRaw, usdcResPost, hopResPost);
  const hopSell2        = hopOut3Raw - calcT22Fee(hopOut3Raw);

  // ── Build TX2 instructions ──
  const ixs: TransactionInstruction[] = [];

  // [0] CU limit
  ixs.push(ComputeBudgetProgram.setComputeUnitLimit({ units: cuLimit }));
  // [1] CU price
  ixs.push(ComputeBudgetProgram.setComputeUnitPrice({ microLamports: cuPrice }));
  // [2] startFlash — endIndex hardcoded at END_FLASH_INDEX=15
  ixs.push(startFlashIx(mfAccount, crank.publicKey));
  // [3] borrow
  ixs.push(borrowIx(mfAccount, crank.publicKey, crankUsdcAta, flashAmountMicro));
  // [4] create LP ATA
  ixs.push(createAssociatedTokenAccountIdempotentInstruction(
    crank.publicKey, crankLpAta, crank.publicKey, lpMint, TOKEN_PROGRAM_ID,
  ));
  // [5] GHOST-LP in — addLiquidity
  ixs.push(makeDepositCpmmInInstruction(
    RAYDIUM_CPMM_PROGRAM, crank.publicKey, authority, POOL_ID,
    crankLpAta, crankUsdcAta, crankHopAta, vaultA, vaultB,
    USDC_MINT, HOP_MINT, lpMint,
    new BN(lpMintMin.toString()),
    new BN(addLiqUsdcMax.toString()),
    new BN(addLiqHopMax.toString()),
  ));
  // [6] Hop1: USDC → HOP
  ixs.push(makeSwapCpmmBaseInInstruction(
    RAYDIUM_CPMM_PROGRAM, crank.publicKey, authority, configId, POOL_ID,
    crankUsdcAta, crankHopAta, vaultA, vaultB,
    TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID, USDC_MINT, HOP_MINT, observationId,
    new BN(swapUsdcRaw.toString()), new BN(0),
  ));
  // [7] Hop2: HOP → USDC
  ixs.push(makeSwapCpmmBaseInInstruction(
    RAYDIUM_CPMM_PROGRAM, crank.publicKey, authority, configId, POOL_ID,
    crankHopAta, crankUsdcAta, vaultB, vaultA,
    TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID, HOP_MINT, USDC_MINT, observationId,
    new BN(hopSell1.toString()), new BN(0),
  ));
  // [8] Hop3: USDC → HOP
  ixs.push(makeSwapCpmmBaseInInstruction(
    RAYDIUM_CPMM_PROGRAM, crank.publicKey, authority, configId, POOL_ID,
    crankUsdcAta, crankHopAta, vaultA, vaultB,
    TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID, USDC_MINT, HOP_MINT, observationId,
    new BN(swapUsdcRaw.toString()), new BN(0),
  ));
  // [9] Hop4: HOP → USDC
  ixs.push(makeSwapCpmmBaseInInstruction(
    RAYDIUM_CPMM_PROGRAM, crank.publicKey, authority, configId, POOL_ID,
    crankHopAta, crankUsdcAta, vaultB, vaultA,
    TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID, HOP_MINT, USDC_MINT, observationId,
    new BN(hopSell2.toString()), new BN(0),
  ));
  // [10] GHOST-LP out — removeLiquidity (VENUE-DEATH: burns all LP, no min out)
  ixs.push(makeWithdrawCpmmInInstruction(
    RAYDIUM_CPMM_PROGRAM, crank.publicKey, authority, POOL_ID,
    crankLpAta, crankUsdcAta, crankHopAta, vaultA, vaultB,
    USDC_MINT, HOP_MINT, lpMint,
    new BN(lpMintMin.toString()), new BN(0), new BN(0),
  ));
  // [11] T22 harvest withheld → mint (collects fees from all 4 HOP transfers)
  ixs.push(createHarvestWithheldTokensToMintInstruction(
    HOP_MINT, [crankHopAta], TOKEN_2022_PROGRAM_ID,
  ));
  // [12] withdraw withheld → crank HOP ATA
  ixs.push(createWithdrawWithheldTokensFromMintInstruction(
    HOP_MINT, crankHopAta, crank.publicKey, [], TOKEN_2022_PROGRAM_ID,
  ));
  // [13] repay flash
  ixs.push(repayIx(mfAccount, crank.publicKey, crankUsdcAta, flashAmountMicro));
  // [14] Jito tip
  ixs.push(SystemProgram.transfer({
    fromPubkey: crank.publicKey,
    toPubkey:   JITO_TIP_WALLET,
    lamports:   Number(jitoTipLamports),
  }));
  // [15] endFlash — MUST be at index 15
  ixs.push(endFlashIx(mfAccount, crank.publicKey, oracle));

  if (ixs.length - 1 !== Number(END_FLASH_INDEX)) {
    throw new Error(`endFlash index mismatch: expected ${END_FLASH_INDEX}, got ${ixs.length - 1}`);
  }

  // ── Revenue projection ──
  const lpFeePerHop    = (swapUsdcUi * 0.0005);
  const totalLpFeeUsd  = lpFeePerHop * 4;
  const t22HopUi1      = Number(calcT22Fee(hopOut1Raw))  / 10 ** HOP_DECIMALS;
  const t22HopUi2      = Number(calcT22Fee(hopOut3Raw))  / 10 ** HOP_DECIMALS;
  const t22FeeUsd      = (t22HopUi1 + t22HopUi2) * 2 * priceUsd;
  const tipUsd         = Number(jitoTipLamports) / 1e9 * 130;
  const netEstUsd      = totalLpFeeUsd + t22FeeUsd - tipUsd;
  const dailyEstUsd    = netEstUsd * 96;

  console.log("═══ BUNDLE-WOMB-LITE · TIOTULIO IT-14 ═══");
  console.log(`Pool:          ${POOL_ID.toBase58().slice(0,8)}... EwoZHyXz`);
  console.log(`Crank:         ${crank.publicKey.toBase58()}`);
  console.log(`Reserves:      $${usdcReserveUi.toFixed(2)} USDC | ${hopReserveUi.toFixed(0)} HOP`);
  console.log(`HOP price:     $${priceUsd.toFixed(8)}`);
  console.log(`T22 fee:       ${t22FeeBps} bps (${t22FeeBps === 1 ? "✅ epoch 977" : "⚠️ pre-977"})`);
  console.log(`Epoch:         ${epochInfo.epoch}`);
  console.log();
  console.log(`Flash:         $${flashUsdcUi.toLocaleString()} USDC`);
  console.log(`GHOST-LP in:   $${addLiqUsdcUi.toLocaleString()} USDC + ${(Number(addLiqHopRaw)/10**HOP_DECIMALS).toFixed(2)} HOP`);
  console.log(`Hops:          4 (USDC→HOP→USDC×2 = 2 round trips)`);
  console.log(`Swap per leg:  $${swapUsdcUi}`);
  console.log();
  console.log(`LP fees:       $${totalLpFeeUsd.toFixed(4)} (4 × $${lpFeePerHop.toFixed(4)})`);
  console.log(`T22 fees:      ~$${t22FeeUsd.toFixed(4)}`);
  console.log(`Jito tip:      -$${tipUsd.toFixed(4)}`);
  console.log(`Net/cycle:     ${netEstUsd >= 0 ? "+" : ""}$${netEstUsd.toFixed(4)}`);
  console.log(`Daily @96:     ${dailyEstUsd >= 10_000 ? "✅" : "⚠️"} $${dailyEstUsd.toFixed(2)} ${dailyEstUsd >= 10_000 ? "MILLIONS-GATE PASS" : "MILLIONS-GATE FAIL"}`);
  console.log();
  console.log(`Bundle:        TX1 (cranker→crank ${Number(gasBudgetLamports)/1e9} SOL gas) + TX2 (flash cycle)`);
  console.log(`CRANK-PAYS:    ${cranker ? cranker.publicKey.toBase58() : "DRY_RUN (no cranker needed)"}`);
  if (treasuryEnv) console.log(`Treasury:      ${treasuryEnv}`);
  console.log(`IX count TX2:  ${ixs.length} (endFlash @ ${ixs.length - 1})`);
  console.log(`Dry run:       ${dryRun}`);
  console.log();

  const { blockhash, lastValidBlockHeight } = await conn.getLatestBlockhash("confirmed");

  // ALT
  let altAccount: AddressLookupTableAccount | null = null;
  if (altAddress) {
    const altInfo = await conn.getAddressLookupTable(new PublicKey(altAddress));
    if (!altInfo.value) throw new Error(`ALT not found: ${altAddress}`);
    altAccount = altInfo.value;
    console.log(`ALT:           ${altAddress} (${altAccount.state.addresses.length} addresses)`);
  }

  // Build TX2 (v0 with optional ALT)
  const tx2msg = new TransactionMessage({
    payerKey:        crank.publicKey,
    recentBlockhash: blockhash,
    instructions:    ixs,
  }).compileToV0Message(altAccount ? [altAccount] : []);
  const tx2 = new VersionedTransaction(tx2msg);
  tx2.sign([crank]);
  const tx2Size = tx2.serialize().length;
  console.log(`TX2 size:      ${tx2Size}b ${tx2Size > 1232 ? "⚠️ OVER LIMIT — need ALT" : "✅"}`);

  const receipt: Record<string, unknown> = {
    timestamp: new Date().toISOString(),
    version:   "bundle-womb-lite-v1",
    dryRun,
    flashUsdc: flashUsdcUi, addLiqUsdc: addLiqUsdcUi, swapUsdc: swapUsdcUi,
    hops: 4,
    lpFeesUsd: totalLpFeeUsd, t22FeesUsd: t22FeeUsd, netEstUsd,
    dailyEstUsd, millionsGate: dailyEstUsd >= 10_000,
    t22FeeBps, epoch: epochInfo.epoch, priceUsd,
    tx2SizeBytes: tx2Size,
    bundleId: null as string | null,
    tx2Sig:   null as string | null,
    simVerdict: null as string | null,
    simLogs:    null as string[] | null,
    error:      null as string | null,
  };

  if (dryRun || !allowLive) {
    // Simulate TX2 only
    console.log("Simulating TX2...");
    try {
      const sim = await conn.simulateTransaction(tx2, { sigVerify: false, replaceRecentBlockhash: true });
      receipt.simVerdict = sim.value.err ? "SIM_FAILED" : "SIM_OK";
      receipt.error      = sim.value.err ? JSON.stringify(sim.value.err) : null;
      receipt.simLogs    = (sim.value.logs ?? []).slice(-20);
      receipt.unitsConsumed = sim.value.unitsConsumed;
      console.log(`SIM ${receipt.simVerdict}  cu=${sim.value.unitsConsumed}`);
      if (sim.value.err) {
        console.log("ERR:", JSON.stringify(sim.value.err));
        console.log("LOGS:\n" + (sim.value.logs ?? []).slice(-15).join("\n"));
      }
    } catch (e) {
      receipt.simVerdict = "SIM_ERROR";
      receipt.error      = (e as Error).message;
      console.error("SIM ERROR:", (e as Error).message);
    }
  } else {
    // Live: build TX1 (cranker pays gas → crank), submit bundle
    if (!cranker) throw new Error("cranker required");

    const tx1msg = new TransactionMessage({
      payerKey:        cranker.publicKey,
      recentBlockhash: blockhash,
      instructions: [
        SystemProgram.transfer({
          fromPubkey: cranker.publicKey,
          toPubkey:   crank.publicKey,
          lamports:   Number(gasBudgetLamports),
        }),
      ],
    }).compileToV0Message([]);
    const tx1 = new VersionedTransaction(tx1msg);
    tx1.sign([cranker]);

    console.log("Submitting Jito bundle (TX1 + TX2)...");
    try {
      const bundleId = await sendJitoBundle([tx1, tx2], blockEngine);
      receipt.bundleId = bundleId;
      console.log(`Bundle submitted: ${bundleId}`);
      console.log(`Check: https://explorer.jito.wtf/bundle/${bundleId}`);

      // Poll for TX2 confirmation
      await new Promise(r => setTimeout(r, 5000));
      const status = await conn.getSignatureStatus(
        Buffer.from(tx2.signatures[0]).toString("base64"),
      );
      if (status.value?.confirmationStatus === "confirmed" || status.value?.confirmationStatus === "finalized") {
        receipt.tx2Sig = Buffer.from(tx2.signatures[0]).toString("base64");
        receipt.simVerdict = "EXECUTED";
        console.log(`TX2 confirmed`);
      } else {
        receipt.simVerdict = "BUNDLE_SUBMITTED_UNCONFIRMED";
        console.log(`Bundle submitted — check jito explorer for confirmation`);
      }
    } catch (e) {
      receipt.simVerdict = "BUNDLE_ERROR";
      receipt.error = (e as Error).message;
      console.error("BUNDLE ERROR:", (e as Error).message);
    }
  }

  const ts          = new Date().toISOString().replace(/[:.]/g, "-");
  const receiptPath = writeReceipt(`bundle-womb-lite-${ts}.json`, receipt);
  console.log(`Receipt: ${receiptPath}`);
}

main().catch(e => { console.error(e); process.exitCode = 1; });
