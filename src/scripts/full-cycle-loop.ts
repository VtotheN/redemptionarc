/**
 * Full-cycle keeper loop.
 *
 * Waits for epoch 978 (activeFeeBps == 1), then executes full-cycle TX every LOOP_INTERVAL_MS:
 *   MarginFi flash → T22 ring (4 hops) → harvest → withdraw → borrow → swapV2 HOP→USDC → repay → tip → endFlash
 *
 * ENV:
 *   FLASH_AMOUNT_USDC=1            (USDC to flash; scales repay threshold)
 *   HOP_AMOUNT_PER_HOP=10000000   (HOP per hop, UI units)
 *   LOOP_INTERVAL_MS=2000
 *   DRY_RUN=false
 *   ALLOW_LIVE=true
 *   LIVE_TX_APPROVED=true
 *   ALT_ADDRESS=qDpKx5a6o84rvUyRG3w7j1t9MPP8tYoqZsHWFh7494u
 *   JITO_TIP_LAMPORTS=200000
 *   CU_LIMIT=400000
 *   CU_PRICE=50000
 *   EPOCH_POLL_MS=600000           (how often to re-check fee when waiting; default 10min)
 */

import "dotenv/config";
import dotenv from "dotenv";
import fs from "node:fs";
import {
  Connection, Keypair, PublicKey,
  TransactionInstruction, TransactionMessage, VersionedTransaction,
  AddressLookupTableAccount, SystemProgram, ComputeBudgetProgram,
  SYSVAR_INSTRUCTIONS_PUBKEY,
} from "@solana/web3.js";
import {
  TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID,
  createTransferCheckedWithFeeInstruction,
  createHarvestWithheldTokensToMintInstruction,
  createWithdrawWithheldTokensFromMintInstruction,
  createAssociatedTokenAccountIdempotentInstruction,
  getAssociatedTokenAddressSync, getMint, getTransferFeeConfig, getAccount,
} from "@solana/spl-token";
import { writeReceipt } from "../utils/receipt.js";

if (process.env.ENV_PATH) {
  dotenv.config({ path: process.env.ENV_PATH, override: true });
}

// ─── Constants ────────────────────────────────────────────────────────────────

const HOP_MINT     = new PublicKey("HZF5k7h39hkysoSZ4ZfmWc55PhvW7ntVvVqdXFCyYGh3");
const USDC_MINT    = new PublicKey("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v");
const HOP_DECIMALS = 6;

const MARGINFI_PROGRAM     = new PublicKey("MFv2hWf31Z9kbCa1snEPYctwafyhdvnV7FZnsebVacA");
const MARGINFI_GROUP       = new PublicKey("4qp6Fx6tnZkY5Wropq9wUYgtFxXKwE6viZxFHg3rdAG8");
const USDC_BANK            = new PublicKey("2s37akK2eyBbp8DZgCm7RtsaEz8eJP3Nxd4urLHQv7yB");
const USDC_LIQUIDITY_VAULT = new PublicKey("7jaiZR5Sk8hdYN9MxTpczTcwbWpb5WEoxSANuUwveuat");
const BANK_ORACLE_OFFSET   = 610;

const WHIRLPOOL_PROGRAM = new PublicKey("GxRHMB9a6XE8BqGPeNb9UkJUPvbvrPoPgNTJPJJA4n8h");
const WHIRLPOOL         = new PublicKey("8aoWgf7ycbeKv6BTFCdUj4JR7Y4mXWuPZWEUhmuzN5ZL");
const TOKEN_VAULT_A     = new PublicKey("4QD4GgnjRvjETqWLT5e3x7SHtJSzs9kShUPLfyHcTu7d");
const TOKEN_VAULT_B     = new PublicKey("Qv51R47g7pMDxa3UofXaz8cNr8pwRSXaNufgnEWX8Yk");
const TICK_ARRAY_90112  = new PublicKey("CDMSB5e6WUgtoSLrybvYm4j58Jue3eqpzHQVLmgVkAe4");
const TICK_ARRAY_95744  = new PublicKey("MXd8HXPjcH9ZCuyr4uKKyN7GkJ5YizZQkgUndB6J8Gz");
const WP_ORACLE         = new PublicKey("5qhXANMqTNNzdp1N1PrMzWzSzjHTZxuLPELcmpog6bp5");
const SPL_MEMO          = new PublicKey("MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr");

const JITO_TIP_ADDR = new PublicKey("96gYZGLnJYVFmbjzopPSU6QiEV5fGqZNyN9nmNhvrZU5");

const IX_START  = Buffer.from([14, 131, 33, 220, 81, 186, 180, 107]);
const IX_END    = Buffer.from([105, 124, 201, 106, 153, 2, 8, 156]);
const IX_BORROW = Buffer.from([4, 126, 116, 53, 48, 5, 212, 31]);
const IX_REPAY  = Buffer.from([79, 209, 172, 177, 222, 51, 173, 151]);
const SWAP_V2_DISC   = Buffer.from([0x2b, 0x04, 0xed, 0x0b, 0x1a, 0xc9, 0x1e, 0x62]);
const MAX_SQRT_PRICE = 79226673515401279992447579055n;

const TARGET_FEE_BPS = 1;
const SOL_USD = 165.0;

// ─── Helpers ──────────────────────────────────────────────────────────────────

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

function loadKeypair(p: string): Keypair {
  return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(p, "utf8"))));
}

function marginfiAccountPubkey(p: string): PublicKey {
  const raw = Uint8Array.from(JSON.parse(fs.readFileSync(p, "utf8")));
  return new PublicKey(raw.slice(32, 64));
}

function u64Le(n: bigint): Buffer {
  const b = Buffer.alloc(8); b.writeBigUInt64LE(n); return b;
}

function u128Le(n: bigint): Buffer {
  const b = Buffer.alloc(16);
  b.writeBigUInt64LE(n & ((1n << 64n) - 1n), 0);
  b.writeBigUInt64LE(n >> 64n, 8);
  return b;
}

async function oracleForBank(conn: Connection, bank: PublicKey): Promise<PublicKey> {
  const info = await conn.getAccountInfo(bank, "confirmed");
  if (!info) throw new Error(`Bank not found: ${bank.toBase58()}`);
  return new PublicKey(Buffer.from(info.data).subarray(BANK_ORACLE_OFFSET, BANK_ORACLE_OFFSET + 32));
}

async function getActiveFeeBps(conn: Connection): Promise<number> {
  const [mintInfo, epochInfo] = await Promise.all([
    getMint(conn, HOP_MINT, "confirmed", TOKEN_2022_PROGRAM_ID),
    conn.getEpochInfo("confirmed"),
  ]);
  const fc = getTransferFeeConfig(mintInfo)!;
  const active = epochInfo.epoch >= Number(fc.newerTransferFee.epoch)
    ? fc.newerTransferFee
    : fc.olderTransferFee;
  return active.transferFeeBasisPoints;
}

// ─── Instruction builders (identical to not-stacc-replicate.ts) ───────────────

function startFlashIx(acct: PublicKey, auth: PublicKey, endIdx: bigint): TransactionInstruction {
  return new TransactionInstruction({
    programId: MARGINFI_PROGRAM,
    keys: [
      { pubkey: acct, isSigner: false, isWritable: true },
      { pubkey: auth, isSigner: true,  isWritable: false },
      { pubkey: SYSVAR_INSTRUCTIONS_PUBKEY, isSigner: false, isWritable: false },
    ],
    data: Buffer.concat([IX_START, u64Le(endIdx)]),
  });
}

function endFlashIx(acct: PublicKey, auth: PublicKey, oracle: PublicKey): TransactionInstruction {
  return new TransactionInstruction({
    programId: MARGINFI_PROGRAM,
    keys: [
      { pubkey: acct,      isSigner: false, isWritable: true  },
      { pubkey: auth,      isSigner: true,  isWritable: false },
      { pubkey: USDC_BANK, isSigner: false, isWritable: false },
      { pubkey: oracle,    isSigner: false, isWritable: false },
    ],
    data: IX_END,
  });
}

function borrowIx(acct: PublicKey, auth: PublicKey, dest: PublicKey, amount: bigint): TransactionInstruction {
  const [vaultAuth] = PublicKey.findProgramAddressSync(
    [Buffer.from("liquidity_vault_auth"), USDC_BANK.toBuffer()], MARGINFI_PROGRAM
  );
  return new TransactionInstruction({
    programId: MARGINFI_PROGRAM,
    keys: [
      { pubkey: MARGINFI_GROUP,       isSigner: false, isWritable: false },
      { pubkey: acct,                 isSigner: false, isWritable: true  },
      { pubkey: auth,                 isSigner: true,  isWritable: false },
      { pubkey: USDC_BANK,            isSigner: false, isWritable: true  },
      { pubkey: dest,                 isSigner: false, isWritable: true  },
      { pubkey: vaultAuth,            isSigner: false, isWritable: false },
      { pubkey: USDC_LIQUIDITY_VAULT, isSigner: false, isWritable: true  },
      { pubkey: TOKEN_PROGRAM_ID,     isSigner: false, isWritable: false },
    ],
    data: Buffer.concat([IX_BORROW, u64Le(amount)]),
  });
}

function repayIx(acct: PublicKey, auth: PublicKey, src: PublicKey, amount: bigint): TransactionInstruction {
  return new TransactionInstruction({
    programId: MARGINFI_PROGRAM,
    keys: [
      { pubkey: MARGINFI_GROUP,       isSigner: false, isWritable: false },
      { pubkey: acct,                 isSigner: false, isWritable: true  },
      { pubkey: auth,                 isSigner: true,  isWritable: false },
      { pubkey: USDC_BANK,            isSigner: false, isWritable: true  },
      { pubkey: src,                  isSigner: false, isWritable: true  },
      { pubkey: USDC_LIQUIDITY_VAULT, isSigner: false, isWritable: true  },
      { pubkey: TOKEN_PROGRAM_ID,     isSigner: false, isWritable: false },
    ],
    data: Buffer.concat([IX_REPAY, u64Le(amount), Buffer.from([0])]),
  });
}

function swapV2Ix(auth: PublicKey, usdcAta: PublicKey, hopAta: PublicKey, hopAmount: bigint): TransactionInstruction {
  return new TransactionInstruction({
    programId: WHIRLPOOL_PROGRAM,
    keys: [
      { pubkey: TOKEN_PROGRAM_ID,      isSigner: false, isWritable: false },
      { pubkey: TOKEN_2022_PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: SPL_MEMO,              isSigner: false, isWritable: false },
      { pubkey: auth,                  isSigner: true,  isWritable: false },
      { pubkey: WHIRLPOOL,             isSigner: false, isWritable: true  },
      { pubkey: USDC_MINT,             isSigner: false, isWritable: false },
      { pubkey: HOP_MINT,              isSigner: false, isWritable: true  },
      { pubkey: usdcAta,               isSigner: false, isWritable: true  },
      { pubkey: TOKEN_VAULT_A,         isSigner: false, isWritable: true  },
      { pubkey: hopAta,                isSigner: false, isWritable: true  },
      { pubkey: TOKEN_VAULT_B,         isSigner: false, isWritable: true  },
      { pubkey: TICK_ARRAY_90112,      isSigner: false, isWritable: true  },
      { pubkey: TICK_ARRAY_95744,      isSigner: false, isWritable: true  },
      { pubkey: TICK_ARRAY_95744,      isSigner: false, isWritable: true  },
      { pubkey: WP_ORACLE,             isSigner: false, isWritable: true  },
    ],
    data: Buffer.concat([
      SWAP_V2_DISC,
      u64Le(hopAmount),
      u64Le(0n),           // otherAmountThreshold=0 (pool is ours, no slippage risk)
      u128Le(MAX_SQRT_PRICE),
      Buffer.from([1]),    // amountSpecifiedIsInput=true
      Buffer.from([0]),    // aToB=false (HOP→USDC = B→A)
      Buffer.from([0]),    // remaining_accounts_info=None
    ]),
  });
}

// ─── Build full IX set ────────────────────────────────────────────────────────

function buildIxs(
  mfAcct: PublicKey,
  auth: PublicKey,
  ataA: PublicKey,
  ataB: PublicKey,
  ataC: PublicKey,
  ataD: PublicKey,
  usdcAta: PublicKey,
  oracle: PublicKey,
  flashMicro: bigint,
  hopAmountPerHop: bigint,
  activeFeeBps: number,
  jitoTip: bigint,
  cuLimit: number,
  cuPrice: bigint,
): TransactionInstruction[] {
  const calcFee = (amt: bigint) => {
    const r = amt * BigInt(activeFeeBps);
    return r / 10_000n + (r % 10_000n > 0n ? 1n : 0n);
  };
  const h1 = hopAmountPerHop;  const f1 = calcFee(h1);
  const h2 = h1 - f1;         const f2 = calcFee(h2);
  const h3 = h2 - f2;         const f3 = calcFee(h3);
  const h4 = h3 - f3;         const f4 = calcFee(h4);
  const totalWithheld = f1 + f2 + f3 + f4;

  // 15 IXs: [0-1] budget, [2] startFlash(14), [3-6] ring, [7-8] harvest/withdraw,
  //         [9] createUsdcAta, [10] borrow, [11] swap, [12] repay, [13] tip, [14] endFlash
  const ixs: TransactionInstruction[] = [
    ComputeBudgetProgram.setComputeUnitLimit({ units: cuLimit }),
    ComputeBudgetProgram.setComputeUnitPrice({ microLamports: Number(cuPrice) }),
    startFlashIx(mfAcct, auth, 14n),
    createTransferCheckedWithFeeInstruction(ataA, HOP_MINT, ataB, auth, h1, HOP_DECIMALS, f1, [], TOKEN_2022_PROGRAM_ID),
    createTransferCheckedWithFeeInstruction(ataB, HOP_MINT, ataC, auth, h2, HOP_DECIMALS, f2, [], TOKEN_2022_PROGRAM_ID),
    createTransferCheckedWithFeeInstruction(ataC, HOP_MINT, ataD, auth, h3, HOP_DECIMALS, f3, [], TOKEN_2022_PROGRAM_ID),
    createTransferCheckedWithFeeInstruction(ataD, HOP_MINT, ataA, auth, h4, HOP_DECIMALS, f4, [], TOKEN_2022_PROGRAM_ID),
    createHarvestWithheldTokensToMintInstruction(HOP_MINT, [ataA, ataB, ataC, ataD], TOKEN_2022_PROGRAM_ID),
    createWithdrawWithheldTokensFromMintInstruction(HOP_MINT, ataA, auth, [], TOKEN_2022_PROGRAM_ID),
    createAssociatedTokenAccountIdempotentInstruction(auth, usdcAta, auth, USDC_MINT),
    borrowIx(mfAcct, auth, usdcAta, flashMicro),
    swapV2Ix(auth, usdcAta, ataA, totalWithheld),
    repayIx(mfAcct, auth, usdcAta, flashMicro),
    SystemProgram.transfer({ fromPubkey: auth, toPubkey: JITO_TIP_ADDR, lamports: jitoTip }),
    endFlashIx(mfAcct, auth, oracle),
  ];
  return ixs;
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  const rpc             = process.env.SOLANA_RPC_URL || "https://mainnet.helius-rpc.com/?api-key=5b121325-36cb-473b-bbeb-47490d21479c";
  const dryRun          = process.env.DRY_RUN !== "false";
  const allowLive       = process.env.ALLOW_LIVE === "true";
  const liveTxApproved  = process.env.LIVE_TX_APPROVED === "true";
  const flashAmountUsdc = Number(process.env.FLASH_AMOUNT_USDC || "1");
  const hopAmountPerHop = BigInt(Math.round(Number(process.env.HOP_AMOUNT_PER_HOP || "10000000") * 10 ** HOP_DECIMALS));
  const loopIntervalMs  = Number(process.env.LOOP_INTERVAL_MS || "2000");
  const epochPollMs     = Number(process.env.EPOCH_POLL_MS || "600000");
  const jitoTip         = BigInt(process.env.JITO_TIP_LAMPORTS || "200000");
  const cuLimit         = Number(process.env.CU_LIMIT || "400000");
  const cuPrice         = BigInt(process.env.CU_PRICE || "50000");
  const altAddress      = process.env.ALT_ADDRESS;

  if (!dryRun && (!allowLive || !liveTxApproved)) {
    console.error("FATAL: live execution requires ALLOW_LIVE=true LIVE_TX_APPROVED=true");
    process.exit(1);
  }

  const conn   = new Connection(rpc, "confirmed");
  const crank  = loadKeypair(process.env.CRANK_KEYPAIR_PATH || "keys/crank.json");
  const mfAcct = marginfiAccountPubkey(process.env.MARGINFI_ACCOUNT_KEYPAIR_PATH || "keys/marginfi-account.json");

  const walletA = crank.publicKey;
  const walletB = loadKeypair(process.env.RING_B_KEYPAIR_PATH || "keys/ring1.json").publicKey;
  const walletC = loadKeypair(process.env.RING_C_KEYPAIR_PATH || "keys/ring2.json").publicKey;
  const walletD = loadKeypair(process.env.RING_D_KEYPAIR_PATH || "keys/ring3.json").publicKey;

  const ataA      = getAssociatedTokenAddressSync(HOP_MINT,  walletA, false, TOKEN_2022_PROGRAM_ID);
  const ataB      = getAssociatedTokenAddressSync(HOP_MINT,  walletB, false, TOKEN_2022_PROGRAM_ID);
  const ataC      = getAssociatedTokenAddressSync(HOP_MINT,  walletC, false, TOKEN_2022_PROGRAM_ID);
  const ataD      = getAssociatedTokenAddressSync(HOP_MINT,  walletD, false, TOKEN_2022_PROGRAM_ID);
  const usdcAta   = getAssociatedTokenAddressSync(USDC_MINT, walletA, false, TOKEN_PROGRAM_ID);
  const flashMicro = BigInt(Math.round(flashAmountUsdc * 1e6));

  // Load ALT once
  let altAccount: AddressLookupTableAccount | null = null;
  if (altAddress) {
    const info = await conn.getAddressLookupTable(new PublicKey(altAddress));
    altAccount = info.value;
    if (!altAccount) throw new Error(`ALT ${altAddress} not found`);
    console.log(`ALT: ${altAddress} (${altAccount.state.addresses.length} accounts)`);
  }

  // Fetch oracle once (stable)
  const mfOracle = await oracleForBank(conn, USDC_BANK);

  console.log(`Crank:    ${walletA.toBase58()}`);
  console.log(`MF acct:  ${mfAcct.toBase58()}`);
  console.log(`Flash:    $${flashAmountUsdc} USDC`);
  console.log(`HOP/hop:  ${Number(hopAmountPerHop) / 1e6}M`);
  console.log(`Mode:     ${dryRun ? "DRY_RUN" : "LIVE"}`);
  console.log();

  // ─── Phase 1: wait for epoch 978 ──────────────────────────────────────────

  while (true) {
    const feeBps = await getActiveFeeBps(conn);
    if (feeBps === TARGET_FEE_BPS) {
      console.log(`Epoch 978 active. fee=${feeBps}bps. Starting loop.`);
      break;
    }
    const [mintInfo, epochInfo] = await Promise.all([
      getMint(conn, HOP_MINT, "confirmed", TOKEN_2022_PROGRAM_ID),
      conn.getEpochInfo("confirmed"),
    ]);
    const fc = getTransferFeeConfig(mintInfo)!;
    const newerEpoch  = Number(fc.newerTransferFee.epoch);
    const slotsLeft   = Math.max(0, (newerEpoch - epochInfo.epoch) * epochInfo.slotsInEpoch - epochInfo.slotIndex);
    const hoursLeft   = (slotsLeft * 0.4) / 3600;
    console.log(`[${new Date().toISOString()}] fee=${feeBps}bps (target: ${TARGET_FEE_BPS}bps). Epoch ${newerEpoch} in ~${hoursLeft.toFixed(1)}h. Next check in ${epochPollMs / 60000}min.`);
    await sleep(epochPollMs);
  }

  // ─── Phase 2: main loop ────────────────────────────────────────────────────

  let cycleCount  = 0;
  let totalUsdcUi = 0;
  let consecutiveFails = 0;

  while (true) {
    cycleCount++;
    const startMs = Date.now();

    try {
      // Fetch fresh state
      const [{ blockhash, lastValidBlockHeight }, usdcAccBefore, activeFeeBps] = await Promise.all([
        conn.getLatestBlockhash("confirmed"),
        getAccount(conn, usdcAta, "confirmed").catch(() => null),
        getActiveFeeBps(conn),
      ]);

      // Guard: stop if fee changed back (shouldn't happen but safety)
      if (activeFeeBps !== TARGET_FEE_BPS) {
        console.error(`fee=${activeFeeBps}bps — not 1bps. Halting.`);
        break;
      }

      const usdcBefore = usdcAccBefore?.amount ?? 0n;

      // Build IXs
      const ixs = buildIxs(mfAcct, walletA, ataA, ataB, ataC, ataD, usdcAta, mfOracle,
        flashMicro, hopAmountPerHop, activeFeeBps, jitoTip, cuLimit, cuPrice);

      // Build V0+ALT TX
      const msg = new TransactionMessage({
        payerKey: walletA,
        recentBlockhash: blockhash,
        instructions: ixs,
      }).compileToV0Message(altAccount ? [altAccount] : []);
      const vtx = new VersionedTransaction(msg);
      vtx.sign([crank]);
      const txBytes = vtx.serialize();

      if (txBytes.length > 1232) {
        throw new Error(`TX too large: ${txBytes.length} bytes. Add ALT_ADDRESS.`);
      }

      let txSig: string | null = null;
      let usdcAfter = usdcBefore;
      let simErr: unknown = null;
      let simCu = cuLimit;

      if (dryRun) {
        const sim = await conn.simulateTransaction(vtx, {
          sigVerify: false,
          replaceRecentBlockhash: true,
          accounts: { encoding: "base64", addresses: [usdcAta.toBase58()] },
        });
        simErr = sim.value.err ?? null;
        simCu  = sim.value.unitsConsumed ?? cuLimit;
        if (!simErr && sim.value.accounts?.[0]?.data && Array.isArray(sim.value.accounts[0].data)) {
          const buf = Buffer.from(sim.value.accounts[0].data[0], "base64");
          if (buf.length >= 72) usdcAfter = buf.readBigUInt64LE(64);
        }
        if (simErr) throw new Error(`DRY_RUN sim fail: ${JSON.stringify(simErr)}`);
      } else {
        txSig = await conn.sendRawTransaction(txBytes, { skipPreflight: false, maxRetries: 2 });
        const conf = await conn.confirmTransaction({ signature: txSig, blockhash, lastValidBlockHeight }, "confirmed");
        if (conf.value.err) throw new Error(`TX failed: ${JSON.stringify(conf.value.err)}`);
        const usdcAccAfter = await getAccount(conn, usdcAta, "confirmed").catch(() => null);
        usdcAfter = usdcAccAfter?.amount ?? usdcBefore;
      }

      const usdcDelta = usdcAfter - usdcBefore;
      const usdcDeltaUi = Number(usdcDelta) / 1e6;
      const gasLamports = 5000n + BigInt(simCu) * cuPrice / 1_000_000n + jitoTip;
      const gasUsd      = Number(gasLamports) / 1e9 * SOL_USD;
      const netUsd      = usdcDeltaUi - gasUsd;
      const elapsedMs   = Date.now() - startMs;

      totalUsdcUi += usdcDeltaUi;
      consecutiveFails = 0;

      console.log(
        `[${cycleCount}] ${dryRun ? "SIM" : "TX"}: ${txSig ? txSig.slice(0, 16) + "..." : "dry"} ` +
        `| USDC+${usdcDeltaUi.toFixed(6)} net+${netUsd.toFixed(6)} ` +
        `| total=${totalUsdcUi.toFixed(4)} USDC ` +
        `| ${elapsedMs}ms`
      );

      writeReceipt(`cycle-${startMs}.json`, {
        cycle: cycleCount,
        dryRun,
        txSig,
        activeFeeBps,
        flashAmountUsdc,
        hopAmountPerHopUi: Number(hopAmountPerHop) / 1e6,
        usdcBefore: usdcBefore.toString(),
        usdcAfter:  usdcAfter.toString(),
        usdcDeltaUi,
        gasUsd,
        netUsd,
        totalUsdcUi,
        txBytes: txBytes.length,
        simErr: simErr ?? null,
        simCu,
        elapsedMs,
        generatedAt: new Date().toISOString(),
      });

    } catch (err: unknown) {
      consecutiveFails++;
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[${cycleCount}] FAIL (${consecutiveFails}/3): ${msg}`);

      if (consecutiveFails >= 3) {
        console.error(`3 consecutive failures. Pausing 60s.`);
        await sleep(60_000);
        consecutiveFails = 0;
        continue;
      }
    }

    const elapsed = Date.now() - startMs;
    const waitMs  = Math.max(0, loopIntervalMs - elapsed);
    if (waitMs > 0) await sleep(waitMs);
  }
}

main().catch(e => { console.error(e); process.exitCode = 1; });
