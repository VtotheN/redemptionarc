/**
 * live-test-snapshot.ts — Capture on-chain state for live cycle test analysis.
 * Reads: pool, balances, T22 withheld (mint + vaultB + crankATA), position fees.
 * Saves to receipts/live-test-post.json (or SNAPSHOT_NAME env override).
 */
import "dotenv/config";
import fs from "node:fs";
import {
  Connection, Keypair, PublicKey,
} from "@solana/web3.js";
import {
  TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID,
  getAssociatedTokenAddressSync,
  getMint, getTransferFeeConfig, getAccount,
} from "@solana/spl-token";

const HOP_MINT       = new PublicKey("HZF5k7h39hkysoSZ4ZfmWc55PhvW7ntVvVqdXFCyYGh3");
const USDC_MINT      = new PublicKey("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v");
const WHIRLPOOL      = new PublicKey("8aoWgf7ycbeKv6BTFCdUj4JR7Y4mXWuPZWEUhmuzN5ZL");
const TOKEN_VAULT_B  = new PublicKey("Qv51R47g7pMDxa3UofXaz8cNr8pwRSXaNufgnEWX8Yk");
const POSITION       = new PublicKey("ErgQU48egJMNBLZeVkdjrtZrSWUQJCky3deh2B4U1YPQ");

const RING_ATAS = [
  new PublicKey("6y8Q9u9psmrwfiAhV4NwR34ap7GZhU4Vc78PpRequijn"),
  new PublicKey("Fq9x3SMf7DLHTVo3yhApFUsM1KibGodbEvcDuGFkiUMJ"),
  new PublicKey("DsKieWX5AtrHpefetBe8kxueQXx7TwEH1R2ScCnDN9Jn"),
];

const Q64 = 1n << 64n;
const WP_LIQUIDITY_OFFSET  = 49;
const WP_SQRT_PRICE_OFFSET = 65;
const WP_TICK_INDEX_OFFSET = 81;
const WP_FEE_RATE_OFFSET   = 45;

function readU64LE(buf: Buffer, off: number): bigint { return buf.readBigUInt64LE(off); }
function readI32LE(buf: Buffer, off: number): number  { return buf.readInt32LE(off); }
function readU128LE(buf: Buffer, off: number): bigint {
  return buf.readBigUInt64LE(off) | (buf.readBigUInt64LE(off + 8) << 64n);
}

// Position layout offsets (Orca Whirlpool anchor)
const POS_LIQUIDITY_OFF     = 72;
const POS_TICK_LOWER_OFF    = 88;
const POS_TICK_UPPER_OFF    = 92;
const POS_FGC_A_OFF         = 96;
const POS_FEE_OWED_A_OFF    = 112;
const POS_FGC_B_OFF         = 120;
const POS_FEE_OWED_B_OFF    = 136;

async function getT22Withheld(conn: Connection, accounts: PublicKey[]): Promise<{ [key: string]: bigint }> {
  const result: { [key: string]: bigint } = {};
  for (const acc of accounts) {
    try {
      const info = await conn.getAccountInfo(acc, "confirmed");
      if (!info) { result[acc.toBase58()] = 0n; continue; }
      // T22 TransferFeeAmount extension: search for it after base account data (165 bytes)
      // Extension format: 2-byte type + 2-byte len + data
      // TransferFeeAmount type = 1, data = 8 bytes withheld
      const data = info.data;
      let withheld = 0n;
      if (data.length > 165) {
        let off = 165;
        while (off + 4 <= data.length) {
          const extType = data.readUInt16LE(off);
          const extLen  = data.readUInt16LE(off + 2);
          if (extType === 1 && extLen >= 8) {
            withheld = data.readBigUInt64LE(off + 4);
            break;
          }
          off += 4 + extLen;
        }
      }
      result[acc.toBase58()] = withheld;
    } catch { result[acc.toBase58()] = 0n; }
  }
  return result;
}

async function main() {
  const rpc = process.env.SOLANA_RPC_URL || process.env.RPC_URL || "https://api.mainnet-beta.solana.com";
  const conn = new Connection(rpc, "confirmed");
  const crankPath = process.env.CRANK_KEYPAIR_PATH || "keys/crank.json";
  const outName   = process.env.SNAPSHOT_NAME || "live-test-post.json";

  const crank = Keypair.fromSecretKey(
    Uint8Array.from(JSON.parse(fs.readFileSync(crankPath, "utf8")) as number[])
  );
  const crankUsdcAta = getAssociatedTokenAddressSync(USDC_MINT, crank.publicKey, false, TOKEN_PROGRAM_ID);
  const crankHopAta  = getAssociatedTokenAddressSync(HOP_MINT,  crank.publicKey, false, TOKEN_2022_PROGRAM_ID);

  console.log(`crank: ${crank.publicKey.toBase58()}`);
  console.log(`crankUsdcAta: ${crankUsdcAta.toBase58()}`);
  console.log(`crankHopAta:  ${crankHopAta.toBase58()}`);

  // ── Pool state ───────────────────────────────────────────────────────────────
  const wpInfo = await conn.getAccountInfo(WHIRLPOOL, "confirmed");
  if (!wpInfo) throw new Error("pool not found");
  const wpData   = wpInfo.data as Buffer;
  const liquidity = readU128LE(wpData, WP_LIQUIDITY_OFFSET);
  const sqrtPrice = readU128LE(wpData, WP_SQRT_PRICE_OFFSET);
  const tickIdx   = readI32LE(wpData, WP_TICK_INDEX_OFFSET);
  const feeRate   = wpData.readUInt16LE(WP_FEE_RATE_OFFSET);

  // hopPrice = (sqrtPrice/2^64)^2 × (10^6/10^6) in USDC per HOP
  const sqrtF  = Number(sqrtPrice) / Number(Q64);
  const hopPriceUsdc = sqrtF * sqrtF;  // USDC per HOP (both 6 decimals → price in USDC/HOP)
  const hopPriceUsd  = hopPriceUsdc;
  const hopPerUsdc   = 1 / hopPriceUsdc;

  // ── Balances ─────────────────────────────────────────────────────────────────
  const [solLamports, usdcBal, hopBal] = await Promise.all([
    conn.getBalance(crank.publicKey, "confirmed"),
    conn.getTokenAccountBalance(crankUsdcAta, "confirmed").catch(() => null),
    conn.getTokenAccountBalance(crankHopAta,  "confirmed").catch(() => null),
  ]);

  // ── T22 withheld on mint ─────────────────────────────────────────────────────
  const hopMintInfo = await getMint(conn, HOP_MINT, "confirmed", TOKEN_2022_PROGRAM_ID);
  const feeCfg = getTransferFeeConfig(hopMintInfo);
  const mintWithheld = feeCfg?.withheldAmount ?? 0n;
  const epoch = (await conn.getEpochInfo()).epoch;
  const t22Bps = epoch >= Number(feeCfg?.newerTransferFee.epoch ?? 0n)
    ? feeCfg?.newerTransferFee.transferFeeBasisPoints ?? 0
    : feeCfg?.olderTransferFee.transferFeeBasisPoints ?? 0;

  // ── T22 withheld on token accounts (vaultB + crankHopAta + ring ATAs) ────────
  const allSources = [TOKEN_VAULT_B, crankHopAta, ...RING_ATAS];
  const withheldMap = await getT22Withheld(conn, allSources);

  const vaultBWithheld    = withheldMap[TOKEN_VAULT_B.toBase58()] ?? 0n;
  const crankHopWithheld  = withheldMap[crankHopAta.toBase58()]   ?? 0n;
  const ringWithheld      = RING_ATAS.reduce((s, a) => s + (withheldMap[a.toBase58()] ?? 0n), 0n);
  const totalWithheld     = mintWithheld + vaultBWithheld + crankHopWithheld + ringWithheld;

  // ── Position state ───────────────────────────────────────────────────────────
  const posInfo = await conn.getAccountInfo(POSITION, "confirmed");
  let posLiquidity = 0n, tickLower = 0, tickUpper = 0, feeOwedA = 0n, feeOwedB = 0n;
  if (posInfo) {
    const pd = posInfo.data as Buffer;
    posLiquidity = readU128LE(pd, POS_LIQUIDITY_OFF);
    tickLower    = readI32LE(pd, POS_TICK_LOWER_OFF);
    tickUpper    = readI32LE(pd, POS_TICK_UPPER_OFF);
    feeOwedA     = readU64LE(pd, POS_FEE_OWED_A_OFF);
    feeOwedB     = readU64LE(pd, POS_FEE_OWED_B_OFF);
  }

  const snap = {
    timestamp:  new Date().toISOString(),
    epoch,
    slot:       await conn.getSlot("confirmed"),
    t22Bps,
    pool: {
      sqrtPrice:   sqrtPrice.toString(),
      tick:        tickIdx,
      liquidity:   liquidity.toString(),
      feeRate,
      hopPriceUsd: hopPriceUsd.toFixed(8),
      hopPerUsdc:  hopPerUsdc.toFixed(2),
    },
    balances: {
      sol:  (solLamports / 1e9).toFixed(9),
      usdc: usdcBal?.value.uiAmountString ?? "0",
      hop:  hopBal?.value.uiAmountString  ?? "0",
    },
    withheld: {
      mint:        (Number(mintWithheld)    / 1e6).toFixed(6),
      crankHopAta: (Number(crankHopWithheld) / 1e6).toFixed(6),
      vaultB:      (Number(vaultBWithheld)  / 1e6).toFixed(6),
      ringATAs:    (Number(ringWithheld)    / 1e6).toFixed(6),
      total:       (Number(totalWithheld)   / 1e6).toFixed(6),
    },
    position: {
      liquidity:  posLiquidity.toString(),
      tickLower,
      tickUpper,
      feeOwedA:   feeOwedA.toString(),
      feeOwedB:   feeOwedB.toString(),
      feeOwedAUi: (Number(feeOwedA) / 1e6).toFixed(6),
      feeOwedBUi: (Number(feeOwedB) / 1e6).toFixed(6),
    },
  };

  console.log("\n=== POST-TX SNAPSHOT ===");
  console.log(`epoch=${snap.epoch} slot=${snap.slot} t22Bps=${snap.t22Bps}`);
  console.log(`pool: tick=${snap.pool.tick} liquidity=${snap.pool.liquidity} hopPrice=$${snap.pool.hopPriceUsd}`);
  console.log(`balances: SOL=${snap.balances.sol} USDC=${snap.balances.usdc} HOP=${snap.balances.hop}`);
  console.log(`withheld: mint=${snap.withheld.mint} crankATA=${snap.withheld.crankHopAta} vaultB=${snap.withheld.vaultB} ring=${snap.withheld.ringATAs} total=${snap.withheld.total}`);
  console.log(`position: liq=${snap.position.liquidity} feeA=${snap.position.feeOwedAUi}USDC feeB=${snap.position.feeOwedBUi}HOP`);

  const outPath = `receipts/${outName}`;
  fs.mkdirSync("receipts", { recursive: true });
  fs.writeFileSync(outPath, JSON.stringify(snap, null, 2));
  console.log(`\nSaved: ${outPath}`);
}

main().catch((e) => { console.error(e); process.exitCode = 1; });
