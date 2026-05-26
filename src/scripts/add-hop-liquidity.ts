/**
 * Re-seed HOP/USDC CPMM pool — first deposit bypass.
 * Uses makeDepositCpmmInInstruction directly (SDK addLiquidity passes lp=0, program rejects).
 *
 * Pool: EwoZHyXz48vZL1TwkpQoq31brW4G4NDwmMr1DMw6qqBV
 * ENV: SOLANA_RPC_URL, DRY_RUN, ALLOW_LIVE
 *      SEED_USDC=500        (USDC to deposit, default $500)
 *      SEED_HOP_UI=5000000  (HOP whole tokens, default 5M → $0.0001/HOP)
 */
import "dotenv/config";
import fs from "node:fs";
import {
  Connection, Keypair, PublicKey,
  TransactionMessage, VersionedTransaction,
  ComputeBudgetProgram,
} from "@solana/web3.js";
import {
  TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID,
  createAssociatedTokenAccountIdempotentInstruction,
  getAssociatedTokenAddressSync,
  getMint, getTransferFeeConfig,
} from "@solana/spl-token";
import { writeReceipt } from "../utils/receipt.js";

const POOL_ID      = new PublicKey("EwoZHyXz48vZL1TwkpQoq31brW4G4NDwmMr1DMw6qqBV");
const RAYDIUM_CPMM = new PublicKey("CPMMoo8L3F4NbTegBCKVNunggL7H1ZpdTHKxQB5qKP1C");
const HOP_MINT     = new PublicKey("HZF5k7h39hkysoSZ4ZfmWc55PhvW7ntVvVqdXFCyYGh3");
const USDC_MINT    = new PublicKey("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v");
const USDC_DEC = 6;
const HOP_DEC  = 6;
const SLIPPAGE_BPS = 100n; // 1% slippage on max amounts

function loadKeypair(p: string) {
  return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(p, "utf8")) as number[]));
}

async function main() {
  const rpc      = process.env.SOLANA_RPC_URL || "https://api.mainnet-beta.solana.com";
  const dryRun   = process.env.DRY_RUN !== "false";
  const allowLive = process.env.ALLOW_LIVE === "true";
  const seedUsdcUi = Number(process.env.SEED_USDC    || "500");
  const seedHopUi  = Number(process.env.SEED_HOP_UI  || "5000000");

  const conn  = new Connection(rpc, "confirmed");
  const crank = loadKeypair("keys/crank.json");

  // ── PDAs ──
  const [authority] = PublicKey.findProgramAddressSync(
    [Buffer.from("vault_and_lp_mint_auth_seed")], RAYDIUM_CPMM);
  const [lpMint] = PublicKey.findProgramAddressSync(
    [Buffer.from("pool_lp_mint"), POOL_ID.toBuffer()], RAYDIUM_CPMM);
  const [vaultA] = PublicKey.findProgramAddressSync(
    [Buffer.from("pool_vault"), POOL_ID.toBuffer(), USDC_MINT.toBuffer()], RAYDIUM_CPMM);
  const [vaultB] = PublicKey.findProgramAddressSync(
    [Buffer.from("pool_vault"), POOL_ID.toBuffer(), HOP_MINT.toBuffer()], RAYDIUM_CPMM);

  // ── ATAs ──
  const crankUsdcAta = getAssociatedTokenAddressSync(USDC_MINT, crank.publicKey, false, TOKEN_PROGRAM_ID);
  const crankHopAta  = new PublicKey("2s2Au2bxsvF5cHbdhfP4JaFX8FXp5wXzQxBj15PNPEkD");
  const crankLpAta   = getAssociatedTokenAddressSync(lpMint, crank.publicKey, false, TOKEN_PROGRAM_ID);

  // ── T22 fee bps ──
  const hopMintInfo = await getMint(conn, HOP_MINT, "confirmed", TOKEN_2022_PROGRAM_ID);
  const feeConf     = getTransferFeeConfig(hopMintInfo);
  if (!feeConf) throw new Error("HOP missing TransferFeeConfig");
  const epochInfo   = await conn.getEpochInfo();
  const activeFee   = epochInfo.epoch >= Number(feeConf.newerTransferFee.epoch)
    ? feeConf.newerTransferFee : feeConf.olderTransferFee;
  const t22FeeBps   = BigInt(activeFee.transferFeeBasisPoints);

  // ── LP mint supply on-chain + actual vault balances ──
  const lpMintSupply = BigInt((await conn.getTokenSupply(lpMint)).value.amount);
  const vaultABal = BigInt((await conn.getTokenAccountBalance(vaultA)).value.amount);
  const vaultBBal = BigInt((await conn.getTokenAccountBalance(vaultB)).value.amount);

  // ── Pool state via Raydium SDK (for reserves + lp_supply in pool account) ──
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let sdk: any;
  try { sdk = await import("@raydium-io/raydium-sdk-v2" as string); }
  catch { throw new Error("Missing SDK: npm install @raydium-io/raydium-sdk-v2"); }
  const { Raydium, makeDepositCpmmInInstruction } = sdk;
  const BNModule = await import("bn.js");
  const BN = BNModule.default ?? BNModule;

  const raydium   = await Raydium.load({ connection: conn, owner: crank, disableFeatureCheck: true });
  const poolFetch = await raydium.cpmm.getPoolInfoFromRpc(POOL_ID.toBase58());
  if (!poolFetch) throw new Error("Pool not found");
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { poolInfo, poolKeys, rpcData } = poolFetch as any;

  if (poolInfo.mintA.address !== USDC_MINT.toBase58()) throw new Error("Pool mintA != USDC");
  if (poolInfo.mintB.address !== HOP_MINT.toBase58())  throw new Error("Pool mintB != HOP");

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const configRaw = (poolKeys as any).config?.id ?? (poolKeys as any).configId ?? (poolInfo as any).config?.id;
  if (!configRaw) throw new Error("Could not resolve CPMM configId");
  void configRaw; // not needed for deposit

  const usdcReserveRaw = BigInt((rpcData.baseReserve  ?? rpcData.vaultAAmount).toString());
  const hopReserveRaw  = BigInt((rpcData.quoteReserve ?? rpcData.vaultBAmount).toString());
  const lpSupplyPool   = BigInt(((rpcData.lpAmount ?? (poolInfo as any).lpAmount ?? 0).toString()));

  // ── Amounts ──
  const seedUsdcRaw = BigInt(Math.round(seedUsdcUi * 10 ** USDC_DEC));

  // effectiveA/B = rpcData reserves (vault minus protocol+fund fees). Used by program for LP math.
  const effectiveA = usdcReserveRaw;  // rpcData.baseReserve
  const effectiveB = hopReserveRaw;   // rpcData.quoteReserve

  const impliedPrice = effectiveA > 0n && effectiveB > 0n
    ? (Number(effectiveA) / 1e6) / (Number(effectiveB) / 1e6)
    : seedUsdcUi / Number(process.env.SEED_HOP_UI || "5000000");

  let targetHopRaw: bigint;
  let lpMintRaw: bigint;

  if (lpSupplyPool === 0n) {
    // True first deposit — set price from seed amounts
    const seedHopUiRaw = BigInt(Math.round(Number(process.env.SEED_HOP_UI || "5000000") * 10 ** HOP_DEC));
    targetHopRaw = seedHopUiRaw;
    const sqrtLp = BigInt(Math.floor(Math.sqrt(Number(seedUsdcRaw) * Number(targetHopRaw))));
    lpMintRaw = sqrtLp > 100n ? (sqrtLp - 100n) * 9990n / 10_000n : 1n;
  } else {
    // Proportional deposit using effective reserves (what program actually uses)
    // LP proportional to USDC leg: lp = seedUsdc * lp_supply / effectiveA
    lpMintRaw = (seedUsdcRaw * lpSupplyPool + effectiveA - 1n) / effectiveA; // ceiling
    // Vault receives HOP = ceiling(lp * effectiveB / lp_supply)
    targetHopRaw = (lpMintRaw * effectiveB + lpSupplyPool - 1n) / lpSupplyPool; // ceiling
  }

  // Crank must SEND more HOP so vault receives targetHopRaw after T22 withhold
  const sendHopRaw = (targetHopRaw * 10_000n) / (10_000n - t22FeeBps);

  // maximum_token_0_amount = USDC vault receive + 2% headroom
  // maximum_token_1_amount = crank SENDS (vault receive + T22 fee) + 2% headroom
  // Raydium CPMM checks slippage on the crank-send amount for T22 tokens
  const maxUsdcRaw = seedUsdcRaw + (seedUsdcRaw * 200n) / 10_000n;
  const maxHopRaw  = sendHopRaw  + (sendHopRaw  * 200n) / 10_000n;

  const targetHopUi = Number(targetHopRaw) / 10 ** HOP_DEC;
  console.log("=== RE-SEED HOP/USDC POOL ===");
  console.log(`Pool:          ${POOL_ID.toBase58()}`);
  console.log(`Crank:         ${crank.publicKey.toBase58()}`);
  console.log(`Seed USDC:     $${seedUsdcUi}`);
  console.log(`Target HOP:    ${targetHopUi.toLocaleString()} (vault receives, proportional to reserves)`);
  console.log(`Pool price:    $${impliedPrice.toFixed(8)}/HOP`);
  console.log(`Mode:          ${lpSupplyPool === 0n ? "FIRST_DEPOSIT" : "PROPORTIONAL"}`);
  console.log(`LP mint supply:${lpMintSupply} (on-chain) | pool state: ${lpSupplyPool}`);
  console.log(`Vault USDC:    ${vaultABal} | Vault HOP: ${vaultBBal}`);
  console.log(`targetHopRaw:  ${targetHopRaw} (vault receives)`);
  console.log(`sendHopRaw:    ${sendHopRaw} (crank sends, T22 takes ${t22FeeBps}bps)`);
  console.log(`lpMintRaw:     ${lpMintRaw}`);
  console.log(`T22 fee bps:   ${t22FeeBps}`);
  console.log(`Dry run:       ${dryRun}`);
  console.log();

  if (dryRun || !allowLive) {
    console.log("DRY_RUN — set DRY_RUN=false ALLOW_LIVE=true to execute.");
    writeReceipt("add-hop-liquidity", {
      verdict: "DRY_RUN",
      poolId: POOL_ID.toBase58(),
      seedUsdcUi, targetHopUi, impliedPrice,
      lpMintRaw: lpMintRaw.toString(),
      sendHopRaw: sendHopRaw.toString(),
      t22FeeBps: t22FeeBps.toString(),
    });
    return;
  }

  // ── Build TX manually ──
  const { blockhash, lastValidBlockHeight } = await conn.getLatestBlockhash("confirmed");

  const ixs = [
    ComputeBudgetProgram.setComputeUnitLimit({ units: 300_000 }),
    ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 50_000 }),
    createAssociatedTokenAccountIdempotentInstruction(
      crank.publicKey, crankLpAta, crank.publicKey, lpMint, TOKEN_PROGRAM_ID
    ),
    makeDepositCpmmInInstruction(
      RAYDIUM_CPMM,
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
      new BN(lpMintRaw.toString()),
      new BN(maxUsdcRaw.toString()),
      new BN(maxHopRaw.toString()),
    ),
  ];

  const msg = new TransactionMessage({
    payerKey: crank.publicKey,
    recentBlockhash: blockhash,
    instructions: ixs,
  }).compileToV0Message([]);
  const vtx = new VersionedTransaction(msg);
  vtx.sign([crank]);

  console.log(`TX size: ${vtx.serialize().length}b`);

  // Simulate first
  const sim = await conn.simulateTransaction(vtx, { sigVerify: false, replaceRecentBlockhash: true });
  if (sim.value.err) {
    console.error("SIM FAILED:", JSON.stringify(sim.value.err));
    if (sim.value.logs) console.error("LOGS:\n" + sim.value.logs.slice(-15).join("\n"));
    process.exitCode = 1;
    return;
  }
  console.log(`SIM OK cu=${sim.value.unitsConsumed}`);

  const sig = await conn.sendTransaction(vtx, { skipPreflight: true });
  await conn.confirmTransaction({ signature: sig, blockhash, lastValidBlockHeight }, "confirmed");
  console.log(`EXECUTED: ${sig}`);
  console.log(`Pool re-seeded. Jupiter re-indexes in ~30 min.`);

  writeReceipt("add-hop-liquidity", {
    verdict: "EXECUTED",
    signature: sig,
    poolId: POOL_ID.toBase58(),
    seedUsdcUi, targetHopUi, impliedPrice,
    lpMintRaw: lpMintRaw.toString(),
    t22FeeBps: t22FeeBps.toString(),
  });
}

main().catch(e => { console.error(e); process.exitCode = 1; });
