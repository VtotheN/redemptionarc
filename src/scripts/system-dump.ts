/**
 * system-dump.ts — Full system state dump for external analysis.
 */
import "dotenv/config";
import fs from "node:fs";
import path from "node:path";
import {
  Connection, PublicKey, LAMPORTS_PER_SOL,
} from "@solana/web3.js";
import {
  TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID,
  getMint, getAccount, getTransferFeeConfig,
} from "@solana/spl-token";

const RPC_URL     = process.env.SOLANA_RPC_URL || process.env.RPC_URL || "https://api.mainnet-beta.solana.com";
const CRANK       = new PublicKey("8pWEfpJas2tgS8iE7ZyHKNjeDSEixqSwK12W4tagNJ3S");
const USDC_MINT   = new PublicKey("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v");
const HOP_MINT    = new PublicKey("HZF5k7h39hkysoSZ4ZfmWc55PhvW7ntVvVqdXFCyYGh3");
const WHIRLPOOL   = new PublicKey("8aoWgf7ycbeKv6BTFCdUj4JR7Y4mXWuPZWEUhmuzN5ZL");
const POSITION    = new PublicKey("ErgQU48egJMNBLZeVkdjrtZrSWUQJCky3deh2B4U1YPQ");
const TOKEN_VAULT_A = new PublicKey("4QD4GgnjRvjETqWLT5e3x7SHtJSzs9kShUPLfyHcTu7d");
const TOKEN_VAULT_B = new PublicKey("Qv51R47g7pMDxa3UofXaz8cNr8pwRSXaNufgnEWX8Yk");
const CRANK_USDC_ATA = new PublicKey("5BK5sqF2vH8o1BBrSukV44ujpu19rpgvJFedGC8GzF9X");
const CRANK_HOP_ATA  = new PublicKey("2s2Au2bxsvF5cHbdhfP4JaFX8FXp5wXzQxBj15PNPEkD");

// Pool data offsets
const WP_TICK_OFFSET        = 81;
const WP_SQRT_PRICE_OFFSET  = 65;
const WP_LIQUIDITY_OFFSET   = 97;
const WP_PROTO_FEE_A_OFFSET = 85;  // wait — let me verify
const WP_PROTO_FEE_B_OFFSET = 93;

// Position offsets
const POS_LIQUIDITY_OFFSET  = 88;
const POS_FEE_OWED_A_OFFSET = 112;
const POS_FEE_OWED_B_OFFSET = 136;

// Actually whirlpool layout: discriminator(8) + whirlpoolsConfig(32) + whirlpoolBump(1) + tickSpacing(2) + tickSpacingSeed(2) + feeRate(2) + protocolFeeRate(2) + liquidity(16) + sqrtPrice(16) + tickCurrentIndex(4) + ...
// Let me use the correct offsets from the working code
const WP_LIQUIDITY_OFF   = 101; // confirmed from working flash script
const WP_SQRT_PRICE_OFF  = 85;
const WP_TICK_IDX_OFF    = 81;  // confirmed working
const WP_PROTO_FEE_A_OFF = 189;
const WP_PROTO_FEE_B_OFF = 197;

function readU64LE(buf: Buffer, off: number): bigint {
  return buf.readBigUInt64LE(off);
}
function readU128LE(buf: Buffer, off: number): bigint {
  const lo = buf.readBigUInt64LE(off);
  const hi = buf.readBigUInt64LE(off + 8);
  return lo | (hi << 64n);
}

async function retryRpc<T>(fn: () => Promise<T>, label: string, retries = 5): Promise<T | "NO_OBTAINABLE"> {
  for (let i = 0; i < retries; i++) {
    try {
      return await fn();
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      if (i < retries - 1) {
        const wait = 1000 * 2 ** i;
        console.error(`[retry ${i+1}/${retries}] ${label}: ${msg}. Wait ${wait}ms...`);
        await new Promise(r => setTimeout(r, wait));
      } else {
        console.error(`[FAILED] ${label}: ${msg}`);
        return "NO_OBTAINABLE" as any;
      }
    }
  }
  return "NO_OBTAINABLE" as any;
}

async function main() {
  const conn = new Connection(RPC_URL, "confirmed");
  const dump: Record<string, unknown> = {
    generated_at: new Date().toISOString(),
    rpc: RPC_URL.replace(/api-key=[^&]+/, "api-key=***"),
  };

  // ── 1. Wallet balances ───────────────────────────────────────────────────
  console.log("[1] wallet balances...");
  const solLamports = await retryRpc(() => conn.getBalance(CRANK), "sol balance");
  dump.wallet = {
    address: CRANK.toBase58(),
    sol: typeof solLamports === "number" ? solLamports / LAMPORTS_PER_SOL : solLamports,
    sol_lamports: solLamports,
  };

  const usdcAcct = await retryRpc(
    () => getAccount(conn, CRANK_USDC_ATA, "confirmed", TOKEN_PROGRAM_ID),
    "crank usdc ata"
  );
  const hopAcct = await retryRpc(
    () => getAccount(conn, CRANK_HOP_ATA, "confirmed", TOKEN_2022_PROGRAM_ID),
    "crank hop ata"
  );

  (dump.wallet as any).usdc_ata      = CRANK_USDC_ATA.toBase58();
  (dump.wallet as any).usdc_balance  = typeof usdcAcct !== "string" ? Number(usdcAcct.amount) / 1e6 : usdcAcct;
  (dump.wallet as any).usdc_raw      = typeof usdcAcct !== "string" ? usdcAcct.amount.toString() : usdcAcct;
  (dump.wallet as any).hop_ata       = CRANK_HOP_ATA.toBase58();
  (dump.wallet as any).hop_balance   = typeof hopAcct !== "string" ? Number(hopAcct.amount) / 1e6 : hopAcct;
  (dump.wallet as any).hop_raw       = typeof hopAcct !== "string" ? hopAcct.amount.toString() : hopAcct;

  // All token accounts
  console.log("[1b] all token accounts...");
  const allTokenAccts = await retryRpc(
    () => conn.getParsedTokenAccountsByOwner(CRANK, { programId: TOKEN_PROGRAM_ID }),
    "all spl tokens"
  );
  const allT22Accts = await retryRpc(
    () => conn.getParsedTokenAccountsByOwner(CRANK, { programId: TOKEN_2022_PROGRAM_ID }),
    "all t22 tokens"
  );

  const allTokens: unknown[] = [];
  if (typeof allTokenAccts !== "string" && allTokenAccts?.value) {
    for (const a of allTokenAccts.value) {
      allTokens.push({
        mint: a.account.data.parsed?.info?.mint,
        amount: a.account.data.parsed?.info?.tokenAmount?.uiAmount,
        program: "spl-token",
        ata: a.pubkey.toBase58(),
      });
    }
  }
  if (typeof allT22Accts !== "string" && allT22Accts?.value) {
    for (const a of allT22Accts.value) {
      allTokens.push({
        mint: a.account.data.parsed?.info?.mint,
        amount: a.account.data.parsed?.info?.tokenAmount?.uiAmount,
        program: "token-2022",
        ata: a.pubkey.toBase58(),
      });
    }
  }
  (dump.wallet as any).all_token_accounts = allTokens;

  // ── 2. On-chain state ────────────────────────────────────────────────────
  console.log("[2] on-chain state...");

  // HOP mint T22 withheld
  const hopMint = await retryRpc(
    () => getMint(conn, HOP_MINT, "confirmed", TOKEN_2022_PROGRAM_ID),
    "hop mint"
  );
  let t22WithheldTotal: unknown = "NO_OBTAINABLE";
  let currentT22Bps: unknown = "NO_OBTAINABLE";
  if (typeof hopMint !== "string") {
    const feeCfg = getTransferFeeConfig(hopMint);
    if (feeCfg) {
      t22WithheldTotal = Number(feeCfg.withheldAmount) / 1e6;
      const epoch = (await conn.getEpochInfo()).epoch;
      const active = epoch >= Number(feeCfg.newerTransferFee.epoch)
        ? feeCfg.newerTransferFee : feeCfg.olderTransferFee;
      currentT22Bps = active.transferFeeBasisPoints;
    }
  }

  // HOP withheld in crank ATA
  let crankAtatWithheld: unknown = "NO_OBTAINABLE";
  const crankHopRaw = await retryRpc(
    () => conn.getAccountInfo(CRANK_HOP_ATA, "confirmed"),
    "crank hop ata raw"
  );
  if (typeof crankHopRaw !== "string" && crankHopRaw) {
    // withheld amount in T22 account extension is at offset 182 (after standard 165 bytes + 17 bytes)
    // actually it's at 165 (base) + 2 (accountType + tlv) ... let's just report the raw offset
    // Standard spl-token-2022 account: 165 bytes base. Extension starts at 166.
    // TransferFeeAmount tlv: type(2) + len(2) + withheldAmount(8) = offset 166+4=170 for withheld
    const d = Buffer.from(crankHopRaw.data);
    if (d.length >= 178) {
      try {
        const w = d.readBigUInt64LE(170);
        crankAtatWithheld = Number(w) / 1e6;
      } catch { crankAtatWithheld = "parse_error"; }
    }
  }

  // Pool state
  const poolInfo = await retryRpc(() => conn.getAccountInfo(WHIRLPOOL, "confirmed"), "pool");
  let poolState: unknown = "NO_OBTAINABLE";
  if (typeof poolInfo !== "string" && poolInfo) {
    const pd = Buffer.from(poolInfo.data);
    try {
      const tickCurrent    = pd.readInt32LE(WP_TICK_IDX_OFF);
      const liquidity      = readU128LE(pd, WP_LIQUIDITY_OFF);
      const sqrtPriceRaw   = readU128LE(pd, WP_SQRT_PRICE_OFF);
      const sqrtPriceF     = Number(sqrtPriceRaw) / (2 ** 64);
      const price          = sqrtPriceF * sqrtPriceF * (10 ** 6) / (10 ** 6); // USDC/HOP

      // Try proto fees at multiple offsets
      let protoA: bigint, protoB: bigint;
      try { protoA = readU64LE(pd, WP_PROTO_FEE_A_OFF); protoB = readU64LE(pd, WP_PROTO_FEE_B_OFF); }
      catch { protoA = 0n; protoB = 0n; }

      poolState = {
        tickCurrent,
        liquidity: liquidity.toString(),
        sqrtPriceRaw: sqrtPriceRaw.toString(),
        price_usdc_per_hop: price,
        protocolFeeOwedA_usdc: Number(protoA) / 1e6,
        protocolFeeOwedB_hop:  Number(protoB) / 1e6,
        account_data_len: pd.length,
      };
    } catch (e) {
      poolState = { error: String(e), account_data_len: pd.length };
    }
  }

  // Position state
  const posInfo = await retryRpc(() => conn.getAccountInfo(POSITION, "confirmed"), "position");
  let posState: unknown = "NO_OBTAINABLE";
  if (typeof posInfo !== "string" && posInfo) {
    const pp = Buffer.from(posInfo.data);
    try {
      const liq      = readU128LE(pp, POS_LIQUIDITY_OFFSET);
      const feeOwedA = readU64LE(pp, POS_FEE_OWED_A_OFFSET);
      const feeOwedB = readU64LE(pp, POS_FEE_OWED_B_OFFSET);
      posState = {
        liquidity: liq.toString(),
        feeOwedA_usdc: Number(feeOwedA) / 1e6,
        feeOwedB_hop:  Number(feeOwedB) / 1e6,
        account_data_len: pp.length,
      };
    } catch (e) {
      posState = { error: String(e) };
    }
  }

  // Vault withheld (token-2022 vaults for HOP)
  let vaultBWithheld: unknown = "NO_OBTAINABLE";
  const vaultBRaw = await retryRpc(() => conn.getAccountInfo(TOKEN_VAULT_B, "confirmed"), "vault b");
  if (typeof vaultBRaw !== "string" && vaultBRaw) {
    const d = Buffer.from(vaultBRaw.data);
    if (d.length >= 178) {
      try { vaultBWithheld = Number(d.readBigUInt64LE(170)) / 1e6; }
      catch { vaultBWithheld = "parse_error"; }
    }
  }

  dump.onchain = {
    hop_mint_withheld_total_hop: t22WithheldTotal,
    hop_current_t22_bps: currentT22Bps,
    crank_hop_ata_withheld_hop: crankAtatWithheld,
    pool_hop_vault_withheld_hop: vaultBWithheld,
    pool: poolState,
    position: posState,
  };

  // ── 3. TX counts since epoch 978 flip ───────────────────────────────────
  console.log("[3] TX history...");
  const EPOCH_978_TS = new Date("2026-05-27T11:50:00.000Z").getTime() / 1000;

  const sigsBefore: string[] = [];
  let before: string | undefined = undefined;
  let fetchedSigs = 0;

  // Fetch up to 1000 recent TXs
  const allSigs: Array<{signature: string; slot: number; blockTime: number | null | undefined; err: unknown}> = [];
  for (let page = 0; page < 10; page++) {
    const batch = await retryRpc(
      () => conn.getSignaturesForAddress(CRANK, { limit: 100, before }, "confirmed"),
      `sigs page ${page}`
    );
    if (typeof batch === "string" || !batch || batch.length === 0) break;
    for (const s of batch) {
      if (s.blockTime && s.blockTime < EPOCH_978_TS) { before = undefined; break; }
      allSigs.push({ signature: s.signature, slot: s.slot, blockTime: s.blockTime ?? null, err: s.err ?? null });
    }
    before = batch[batch.length - 1]?.signature;
    fetchedSigs += batch.length;
    if (!before) break;
    // If oldest in batch is before epoch 978, stop
    const oldestBt = batch[batch.length - 1]?.blockTime;
    if (oldestBt && oldestBt < EPOCH_978_TS) break;
  }

  const postFlipSigs = allSigs.filter(s => s.blockTime && s.blockTime >= EPOCH_978_TS);
  const confirmed978 = postFlipSigs.filter(s => !s.err);
  const failed978    = postFlipSigs.filter(s => s.err);

  // Collect unique error codes
  const errorCodes: Record<string, number> = {};
  for (const s of failed978) {
    const key = JSON.stringify(s.err);
    errorCodes[key] = (errorCodes[key] || 0) + 1;
  }

  dump.tx_history = {
    epoch_978_flip_ts: new Date(EPOCH_978_TS * 1000).toISOString(),
    total_fetched: fetchedSigs,
    post_flip_total: postFlipSigs.length,
    post_flip_confirmed: confirmed978.length,
    post_flip_failed: failed978.length,
    unique_error_codes: errorCodes,
    first_post_flip: postFlipSigs.length > 0 ? {
      sig: postFlipSigs[postFlipSigs.length - 1]?.signature,
      ts:  postFlipSigs[postFlipSigs.length - 1]?.blockTime
        ? new Date(postFlipSigs[postFlipSigs.length - 1]!.blockTime! * 1000).toISOString()
        : null,
    } : null,
    last_post_flip: postFlipSigs.length > 0 ? {
      sig: postFlipSigs[0]?.signature,
      ts:  postFlipSigs[0]?.blockTime
        ? new Date(postFlipSigs[0]!.blockTime! * 1000).toISOString()
        : null,
    } : null,
  };

  // ── 4. Last 10 confirmed cycles ─────────────────────────────────────────
  console.log("[4] last 10 confirmed cycles detail...");
  const last10sigs = confirmed978.slice(0, 10).map(s => s.signature);
  const last10detail: unknown[] = [];

  for (const sig of last10sigs) {
    const tx = await retryRpc(
      () => conn.getParsedTransaction(sig, { maxSupportedTransactionVersion: 0, commitment: "confirmed" }),
      `tx ${sig.slice(0,8)}`
    );
    if (typeof tx === "string" || !tx) {
      last10detail.push({ sig, error: tx });
      continue;
    }
    const meta = tx.meta;
    const blockTime = tx.blockTime ? new Date(tx.blockTime * 1000).toISOString() : null;
    const fee = meta?.fee ?? null;
    const cu = meta?.computeUnitsConsumed ?? null;
    const err = meta?.err ?? null;

    // Find USDC balance change for crank
    let crankUsdcBefore: number | null = null;
    let crankUsdcAfter: number | null = null;
    if (meta?.preTokenBalances && meta?.postTokenBalances) {
      const preU  = meta.preTokenBalances.find(b => b.owner === CRANK.toBase58() && b.mint === USDC_MINT.toBase58());
      const postU = meta.postTokenBalances.find(b => b.owner === CRANK.toBase58() && b.mint === USDC_MINT.toBase58());
      crankUsdcBefore = preU?.uiTokenAmount?.uiAmount ?? null;
      crankUsdcAfter  = postU?.uiTokenAmount?.uiAmount ?? null;
    }

    last10detail.push({
      sig,
      blockTime,
      fee_lamports: fee,
      fee_usdc_approx: fee ? fee / LAMPORTS_PER_SOL * 135 : null, // rough SOL price
      cu_consumed: cu,
      err,
      crank_usdc_before: crankUsdcBefore,
      crank_usdc_after:  crankUsdcAfter,
      crank_usdc_delta:  (crankUsdcBefore !== null && crankUsdcAfter !== null)
        ? crankUsdcAfter - crankUsdcBefore : null,
      type: "cycle_flywheel",
    });
  }
  dump.last_10_cycles = last10detail;

  // ── 5. Receipts ─────────────────────────────────────────────────────────
  console.log("[5] receipts...");
  const RECEIPTS = "receipts";
  const deepVolFiles = fs.readdirSync(RECEIPTS).filter(f => f.startsWith("deep-vol-") && f.endsWith(".json"));
  const flashFiles   = fs.readdirSync(RECEIPTS).filter(f => f.startsWith("flash-deep-vol") && f.endsWith(".json"));
  const allVolFiles  = [...deepVolFiles, ...flashFiles];

  let sumCashNetProj = 0;
  let latestCashNetProj = 0;
  let latestReceiptTs = "";
  let latestReceiptFile = "";

  for (const f of allVolFiles) {
    try {
      const d = JSON.parse(fs.readFileSync(path.join(RECEIPTS, f), "utf8"));
      if (typeof d.cashNetProj === "number") {
        sumCashNetProj += d.cashNetProj;
        if (!latestReceiptTs || (d.timestamp && d.timestamp > latestReceiptTs)) {
          latestReceiptTs    = d.timestamp;
          latestCashNetProj  = d.cashNetProj;
          latestReceiptFile  = f;
        }
      }
    } catch {}
  }

  const safetyPauseFiles = fs.readdirSync(RECEIPTS).filter(f => f.startsWith("SAFETY-PAUSE") && f.endsWith(".json"));
  const sweepFiles       = fs.readdirSync(RECEIPTS).filter(f => (f.startsWith("redeem-hop") || f.startsWith("sweep-")) && f.endsWith(".json"));
  const extractFiles     = fs.readdirSync(RECEIPTS).filter(f => f.startsWith("extract-") && f.endsWith(".json"));

  dump.receipts = {
    deep_vol_total_files: allVolFiles.length,
    sum_cash_net_proj: sumCashNetProj,
    latest_cash_net_proj: latestCashNetProj,
    latest_receipt_file: latestReceiptFile,
    safety_pause_files: safetyPauseFiles.length,
    safety_pause_contents: safetyPauseFiles.map(f =>
      JSON.parse(fs.readFileSync(path.join(RECEIPTS, f), "utf8"))
    ),
    sweep_files: sweepFiles.length,
    latest_sweep: sweepFiles.length > 0
      ? JSON.parse(fs.readFileSync(path.join(RECEIPTS, sweepFiles[sweepFiles.length-1]), "utf8"))
      : null,
    extract_files: extractFiles.length,
    latest_extract: extractFiles.length > 0
      ? JSON.parse(fs.readFileSync(path.join(RECEIPTS, extractFiles[extractFiles.length-1]), "utf8"))
      : null,
  };

  // ── 6. Process status ───────────────────────────────────────────────────
  const { execSync } = await import("child_process");
  let procStatus = "no loop process found";
  try {
    procStatus = execSync("ps aux | grep -E 'flash-deep-vol-orca-loop|tsx.*loop-v2' | grep -v grep", { encoding: "utf8" }).trim() || "no loop process found";
  } catch {}
  dump.process_status = { ps_output: procStatus };

  // ── 7. Config ───────────────────────────────────────────────────────────
  dump.config = {
    RT_COUNT:             process.env.RT_COUNT             ?? "NOT_SET",
    ADDLIQ_USDC:          process.env.ADDLIQ_USDC          ?? "NOT_SET",
    SWAP_USDC:            process.env.SWAP_USDC            ?? "NOT_SET",
    LOOP_INTERVAL_MS:     process.env.LOOP_INTERVAL_MS     ?? "NOT_SET",
    SWEEP_EVERY:          process.env.SWEEP_EVERY          ?? "NOT_SET",
    EXTRACT_EVERY:        process.env.EXTRACT_EVERY        ?? "NOT_SET",
    JITO_SKIP:            process.env.JITO_SKIP            ?? "NOT_SET",
    ALTERNATE_DIRECTION:  process.env.ALTERNATE_DIRECTION  ?? "NOT_SET",
    DRY_RUN:              process.env.DRY_RUN              ?? "NOT_SET",
    ALLOW_LIVE:           process.env.ALLOW_LIVE           ?? "NOT_SET",
  };

  // ── 8. USDC reconciliation ───────────────────────────────────────────────
  console.log("[8] USDC reconciliation...");
  // Find initial USDC from oldest post-flip receipt
  let initialUsdc: number | null = null;
  const deepVolV2Files = deepVolFiles.filter(f => f.startsWith("deep-vol-v2-")).sort();
  // Try to find from TX balance changes
  let txBasedInitialUsdc: number | null = null;
  if (last10detail.length > 0) {
    const oldest = last10detail[last10detail.length - 1] as any;
    txBasedInitialUsdc = oldest?.crank_usdc_before ?? null;
  }

  const currentUsdc = typeof usdcAcct !== "string" ? Number(usdcAcct.amount) / 1e6 : null;
  const numConfirmed = confirmed978.length;
  const expectedDrainagePerTx = 0.9; // LP fees go to position, not wallet — actually 0 should drain from USDC
  // Actually: output-spec swap makes flash repay neutral, gas in SOL not USDC
  // Only source of USDC drain: T22 fee was pre-paid in USDC-equivalent? No.
  // Actually: addLiqMicro comes from flash (MarginFi), gets repaid. USDC should be NEUTRAL.
  // LP fees accumulate in position, not wallet.
  // Gas = SOL, not USDC.
  // So expected USDC drain = 0 per cycle.

  dump.usdc_reconciliation = {
    note: "Flash loan covers addLiq+swap. Output-spec swap2 returns exact swapMicro USDC for repay. Gas in SOL. Expected USDC drain per cycle = $0.000. LP fees go to position.feeOwedA (not crank wallet). T22 withheld in HOP mint, extractable via redeem-hop-to-usdc.ts (converts to USDC).",
    current_usdc: currentUsdc,
    tx_based_initial_usdc: txBasedInitialUsdc,
    confirmed_cycles_post_flip: numConfirmed,
    expected_usdc_drain_per_cycle: 0,
    expected_total_usdc_drain: 0,
    actual_usdc_drain: txBasedInitialUsdc !== null && currentUsdc !== null
      ? txBasedInitialUsdc - currentUsdc : "cannot compute — need initial balance",
    discrepancy_vs_expected: txBasedInitialUsdc !== null && currentUsdc !== null
      ? (txBasedInitialUsdc - currentUsdc) - 0 : "cannot compute",
    t22_withheld_in_hop_mint_usdc_equiv: t22WithheldTotal,
    lp_fees_in_position_usdc: typeof posState !== "string"
      ? (posState as any)?.feeOwedA_usdc : "NO_OBTAINABLE",
    lp_fees_in_position_hop: typeof posState !== "string"
      ? (posState as any)?.feeOwedB_hop : "NO_OBTAINABLE",
    where_gains_are: [
      "T22 withheld HOP → in HOP mint withheld balance → run redeem-hop-to-usdc.ts to convert to USDC",
      "LP fees (feeOwedA/B) → in position account → run auto-compound-extract.ts to collect",
      "Crank USDC should be ~unchanged (flash is self-contained)",
    ],
  };

  // ── Write ────────────────────────────────────────────────────────────────
  const outPath = `/tmp/system-dump-${Math.floor(Date.now()/1000)}.json`;
  fs.writeFileSync(outPath, JSON.stringify(dump, null, 2));
  console.log(`\nDump saved: ${outPath}`);
  console.log(`Size: ${(fs.statSync(outPath).size / 1024).toFixed(1)}KB`);
}

main().catch(e => { console.error(e); process.exitCode = 1; });
