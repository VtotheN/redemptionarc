/**
 * Add liquidity to existing position #1 on our Orca Whirlpool.
 * Uses increase_liquidity_v2. ENV: SEED_USDC (default 465), DRY_RUN, ALLOW_LIVE
 */
import "dotenv/config";
import { PublicKey, Transaction, sendAndConfirmTransaction, ComputeBudgetProgram } from "@solana/web3.js";
import { getAssociatedTokenAddressSync, TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID, getMint, getTransferFeeConfig } from "@solana/spl-token";
import { Connection } from "@solana/web3.js";
import { loadConfig } from "../config.js";
import { connectionFor } from "../utils/rpc.js";
import { writeReceipt } from "../utils/receipt.js";
import { assertKeypairMatches, loadKeypair } from "../utils/keypair.js";
import { assertLiveAllowed, assertNoForbiddenConfigured } from "../utils/safety.js";
import {
  deriveTickArray,
  increaseLiquidityV2Ix,
  tickToSqrtPriceX64,
  liquidityFromAmountA,
  amountBFromLiquidity,
} from "../utils/orca-whirlpool.js";

const WHIRLPOOL     = new PublicKey("8aoWgf7ycbeKv6BTFCdUj4JR7Y4mXWuPZWEUhmuzN5ZL");
const TOKEN_VAULT_A = new PublicKey("4QD4GgnjRvjETqWLT5e3x7SHtJSzs9kShUPLfyHcTu7d");
const TOKEN_VAULT_B = new PublicKey("Qv51R47g7pMDxa3UofXaz8cNr8pwRSXaNufgnEWX8Yk");
const POSITION      = new PublicKey("ErgQU48egJMNBLZeVkdjrtZrSWUQJCky3deh2B4U1YPQ");
const POSITION_TA   = new PublicKey("GgLpt3VY9vWKLnNa5Dj3FKvBn3JEDL4KTKpabCAfL54Q");
const USDC_MINT     = new PublicKey("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v");
const HOP_MINT      = new PublicKey("HZF5k7h39hkysoSZ4ZfmWc55PhvW7ntVvVqdXFCyYGh3");
const TICK_LOWER    = 84480;
const TICK_UPPER    = 101312;

const Q64 = 1n << 64n;

async function readPoolSqrtPrice(connection: Connection) {
  const info = await connection.getAccountInfo(WHIRLPOOL, "confirmed");
  if (!info) throw new Error("Pool account not found");
  // sqrtPrice at offset 8+32+1+2+2+2+2+16 = 65
  const sqrtBytes = info.data.slice(65, 81);
  return BigInt("0x" + Buffer.from(sqrtBytes).reverse().toString("hex"));
}

async function main() {
  const config = loadConfig();
  assertNoForbiddenConfigured(config);
  assertLiveAllowed(config);
  if (!config.crank) throw new Error("Missing REDEMPTION_CRANK");

  const connection = connectionFor(config.rpcUrl);
  const crank = loadKeypair("keys/crank.json");
  assertKeypairMatches("crank", crank, config.crank);

  const seedUsdcUi = Number(process.env.SEED_USDC ?? "465");
  const usdcDeposit = BigInt(Math.round(seedUsdcUi * 1_000_000));

  // T22 fee
  const hopMintInfo = await getMint(connection, HOP_MINT, "confirmed", TOKEN_2022_PROGRAM_ID);
  const feeConf = getTransferFeeConfig(hopMintInfo);
  if (!feeConf) throw new Error("HOP missing TransferFeeConfig");
  const epoch = (await connection.getEpochInfo()).epoch;
  const activeFee = epoch >= Number(feeConf.newerTransferFee.epoch)
    ? feeConf.newerTransferFee : feeConf.olderTransferFee;
  const t22Bps = BigInt(activeFee.transferFeeBasisPoints);

  // Pool state
  const sqrtPrice = await readPoolSqrtPrice(connection);
  const sqrtPLow  = tickToSqrtPriceX64(TICK_LOWER);
  const sqrtPUp   = tickToSqrtPriceX64(TICK_UPPER);

  // Liquidity math
  const liquidityDelta  = liquidityFromAmountA(usdcDeposit, sqrtPrice, sqrtPUp);
  const requiredHop     = amountBFromLiquidity(liquidityDelta, sqrtPrice, sqrtPLow);
  const sendHop         = (requiredHop * 10_000n + (10_000n - t22Bps - 1n)) / (10_000n - t22Bps);

  // ATAs
  const crankUsdcAta = getAssociatedTokenAddressSync(USDC_MINT, crank.publicKey, false, TOKEN_PROGRAM_ID);
  const crankHopAta  = getAssociatedTokenAddressSync(HOP_MINT, crank.publicKey, false, TOKEN_2022_PROGRAM_ID);

  // USDC balance check
  const usdcBal = BigInt((await connection.getTokenAccountBalance(crankUsdcAta)).value.amount);
  const hopBal  = BigInt((await connection.getTokenAccountBalance(crankHopAta)).value.amount);

  const tokenMaxA = (usdcDeposit * 101n) / 100n;
  const tokenMaxB = (sendHop     * 105n) / 100n;

  const tickArrayLower = deriveTickArray(WHIRLPOOL, TICK_LOWER);
  const tickArrayUpper = deriveTickArray(WHIRLPOOL, 95744);  // array containing tick 101312

  console.log(`sqrtPrice: ${sqrtPrice}`);
  console.log(`liquidityDelta: ${liquidityDelta}`);
  console.log(`USDC deposit:   $${seedUsdcUi} (${usdcDeposit} raw)`);
  console.log(`requiredHOP:    ${requiredHop} raw (${(Number(requiredHop)/1e6).toFixed(2)} HOP)`);
  console.log(`sendHOP:        ${sendHop} raw`);
  console.log(`USDC wallet:    ${usdcBal} raw ($${(Number(usdcBal)/1e6).toFixed(2)})`);
  console.log(`HOP wallet:     ${hopBal} raw`);
  console.log(`HOP fits:       ${sendHop <= hopBal}`);
  console.log(`tokenMaxA:      ${tokenMaxA}`);
  console.log(`tokenMaxB:      ${tokenMaxB}`);

  if (sendHop > hopBal) throw new Error(`Insufficient HOP: need ${sendHop}, have ${hopBal}`);
  if (usdcDeposit > usdcBal) throw new Error(`Insufficient USDC: need ${usdcDeposit}, have ${usdcBal}`);

  const receipt: Record<string, unknown> = {
    verdict: "ADDLIQ_PLAN",
    dryRun: config.dryRun,
    usdcDepositUi: seedUsdcUi,
    liquidityDelta: liquidityDelta.toString(),
    requiredHopRaw: requiredHop.toString(),
    sendHopRaw: sendHop.toString(),
    t22Bps: t22Bps.toString(),
  };

  const ix = increaseLiquidityV2Ix({
    whirlpool:            WHIRLPOOL,
    tokenProgramA:        TOKEN_PROGRAM_ID,
    tokenProgramB:        TOKEN_2022_PROGRAM_ID,
    positionAuthority:    crank.publicKey,
    position:             POSITION,
    positionTokenAccount: POSITION_TA,
    tokenMintA:           USDC_MINT,
    tokenMintB:           HOP_MINT,
    tokenOwnerAccountA:   crankUsdcAta,
    tokenOwnerAccountB:   crankHopAta,
    tokenVaultA:          TOKEN_VAULT_A,
    tokenVaultB:          TOKEN_VAULT_B,
    tickArrayLower,
    tickArrayUpper,
    liquidityAmount:      liquidityDelta,
    tokenMaxA,
    tokenMaxB,
  });

  const tx = new Transaction()
    .add(ComputeBudgetProgram.setComputeUnitLimit({ units: 200_000 }))
    .add(ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 50_000 }))
    .add(ix);
  tx.feePayer = crank.publicKey;
  tx.recentBlockhash = (await connection.getLatestBlockhash("confirmed")).blockhash;
  tx.sign(crank);

  const sim = await connection.simulateTransaction(tx);
  receipt.simulation = { err: sim.value.err ?? null, logs: (sim.value.logs ?? []).slice(-8) };

  if (sim.value.err) {
    receipt.verdict = "ADDLIQ_SIM_FAILED";
    writeReceipt("REDEMPTION-INCREASE-POSITION-LIQ.json", receipt);
    console.error(`SIM_FAILED: ${JSON.stringify(sim.value.err)}`);
    console.error((sim.value.logs ?? []).slice(-8).join("\n"));
    process.exitCode = 1;
    return;
  }

  if (config.dryRun) {
    receipt.verdict = "ADDLIQ_SIM_OK_DRY_RUN";
    writeReceipt("REDEMPTION-INCREASE-POSITION-LIQ.json", receipt);
    console.log(`ADDLIQ_SIM_OK liq=${liquidityDelta} usdc=$${seedUsdcUi}`);
    return;
  }

  const sig = await sendAndConfirmTransaction(connection, tx, [crank], { commitment: "confirmed" });
  receipt.verdict = "ADDLIQ_EXECUTED";
  receipt.signature = sig;
  writeReceipt("REDEMPTION-INCREASE-POSITION-LIQ.json", receipt);
  console.log(`ADDLIQ_EXECUTED sig=${sig} liq=${liquidityDelta} usdc=$${seedUsdcUi}`);
}

main().catch(e => { console.error(e); process.exitCode = 1; });
