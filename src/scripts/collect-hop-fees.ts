/**
 * Sweep ALL withheld HOP fees from ecosystem ATAs → treasury (ataA).
 * Uses withdrawWithheldAuthority = arc-crank (8pWEfpJ...).
 *
 * ENV:
 *   SOLANA_RPC_URL
 *   DRY_RUN=true|false (default true)
 *   ALLOW_LIVE=true (required to send)
 *   BATCH_SIZE=20 (ATAs per harvestWithheldTokensToMint ix — limit 35)
 */
import "dotenv/config";
import fs from "node:fs";
import {
  Connection, Keypair, PublicKey, Transaction, sendAndConfirmTransaction,
  ComputeBudgetProgram,
} from "@solana/web3.js";
import {
  TOKEN_2022_PROGRAM_ID,
  getMint, getTransferFeeConfig,
  getAccount,
  createHarvestWithheldTokensToMintInstruction,
  createWithdrawWithheldTokensFromMintInstruction,
  getAssociatedTokenAddressSync,
} from "@solana/spl-token";
import { writeReceipt } from "../utils/receipt.js";

const HOP_MINT = new PublicKey("HZF5k7h39hkysoSZ4ZfmWc55PhvW7ntVvVqdXFCyYGh3");
const HOP_DECIMALS = 6;
const BATCH_SIZE = Number(process.env.BATCH_SIZE || "20");

// Known ring ATAs — always include these in harvest sweep
const KNOWN_RING_ATAS = [
  "6y8Q9u9psmrwfiAhV4NwR34ap7GZhU4Vc78PpRequijn",  // ataB (ring1)
  "Fq9x3SMf7DLHTVo3yhApFUsM1KibGodbEvcDuGFkiUMJ",  // ataC (ring2)
  "DsKieWX5AtrHpefetBe8kxueQXx7TwEH1R2ScCnDN9Jn",  // ataD (ring3)
].map(pk => new PublicKey(pk));

function loadKeypair(p: string) {
  return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(p, "utf8")) as number[]));
}

async function getWithheldATAs(conn: Connection): Promise<PublicKey[]> {
  // Try full ecosystem scan via getProgramAccounts (requires RPC with secondary indexes)
  try {
    const accounts = await conn.getProgramAccounts(TOKEN_2022_PROGRAM_ID, {
      filters: [
        {
          memcmp: {
            offset: 0,
            bytes: HOP_MINT.toBase58(),
          }
        }
      ]
    });
    const scanned = accounts.map(a => a.pubkey);
    // Merge with known ATAs (dedup)
    const all = [...new Set([
      ...scanned.map(pk => pk.toBase58()),
      ...KNOWN_RING_ATAS.map(pk => pk.toBase58()),
    ])].map(pk => new PublicKey(pk));
    console.log(`Found ${scanned.length} HOP ATAs via getProgramAccounts + ${KNOWN_RING_ATAS.length} known ring ATAs = ${all.length} total`);
    return all;
  } catch (e) {
    // Public RPC or Triton may block getProgramAccounts for T22 — fall back to known ATAs
    const msg = e instanceof Error ? e.message : String(e);
    console.log(`getProgramAccounts unavailable (${msg.slice(0, 80)})`);
    console.log(`Falling back to ${KNOWN_RING_ATAS.length} known ring ATAs`);
    return KNOWN_RING_ATAS;
  }
}

async function main() {
  const rpc = process.env.SOLANA_RPC_URL || "https://api.mainnet-beta.solana.com";
  const dryRun = process.env.DRY_RUN !== "false";
  const allowLive = process.env.ALLOW_LIVE === "true";
  const conn = new Connection(rpc, "confirmed");

  const crank = loadKeypair("keys/crank.json");
  const withdrawAuth = crank; // arc-crank = withdrawWithheldAuthority

  const ataA = getAssociatedTokenAddressSync(HOP_MINT, crank.publicKey, false, TOKEN_2022_PROGRAM_ID);

  // Read current ataA balance
  const before = await getAccount(conn, ataA, "confirmed", TOKEN_2022_PROGRAM_ID);
  const beforeBalance = Number(before.amount) / 10 ** HOP_DECIMALS;

  // Verify withdraw authority
  const mintInfo = await getMint(conn, HOP_MINT, "confirmed", TOKEN_2022_PROGRAM_ID);
  const feeConfig = getTransferFeeConfig(mintInfo);
  const onChainWithdrawAuth = feeConfig?.withdrawWithheldAuthority;

  if (!onChainWithdrawAuth?.equals(withdrawAuth.publicKey)) {
    throw new Error(
      `withdraw authority mismatch: on-chain=${onChainWithdrawAuth?.toBase58()} signer=${withdrawAuth.publicKey.toBase58()}`
    );
  }

  const withheldInMint = Number(feeConfig?.withheldAmount ?? 0) / 10 ** HOP_DECIMALS;
  console.log(`mint withheld: ${withheldInMint.toFixed(6)} HOP`);
  console.log(`ataA before:   ${beforeBalance.toFixed(6)} HOP`);

  // Scan for ATAs with withheld fees
  const allATAs = await getWithheldATAs(conn);

  // Build harvests in batches
  const txSigs: string[] = [];
  let totalHarvested = 0;

  // First: harvestWithheldTokensToMint (ataList → mint withheld bucket)
  for (let i = 0; i < allATAs.length; i += BATCH_SIZE) {
    const batch = allATAs.slice(i, i + BATCH_SIZE);
    const ix = createHarvestWithheldTokensToMintInstruction(
      HOP_MINT,
      batch,
      TOKEN_2022_PROGRAM_ID
    );
    const { blockhash } = await conn.getLatestBlockhash("confirmed");
    const tx = new Transaction({
      recentBlockhash: blockhash,
      feePayer: crank.publicKey
    }).add(
      ComputeBudgetProgram.setComputeUnitLimit({ units: 200_000 }),
      ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 1_000 }),
      ix
    );

    if (dryRun || !allowLive) {
      const sim = await conn.simulateTransaction(tx);
      console.log(`HARVEST batch[${i}..${i + batch.length}] SIM: ${sim.value.err ? "FAIL " + JSON.stringify(sim.value.err) : "OK"}`);
    } else {
      const sig = await sendAndConfirmTransaction(conn, tx, [crank], { commitment: "confirmed" });
      console.log(`HARVEST batch[${i}..${i + batch.length}]: ${sig}`);
      txSigs.push(sig);
    }
  }

  // Second: withdrawWithheldTokensFromMint (mint withheld → ataA)
  const mintInfoAfter = await getMint(conn, HOP_MINT, "confirmed", TOKEN_2022_PROGRAM_ID);
  const feeConfigAfter = getTransferFeeConfig(mintInfoAfter);
  const withheldNow = Number(feeConfigAfter?.withheldAmount ?? 0) / 10 ** HOP_DECIMALS;
  console.log(`mint withheld after harvest: ${withheldNow.toFixed(6)} HOP`);

  if (withheldNow > 0 || withheldInMint > 0) {
    const withdrawIx = createWithdrawWithheldTokensFromMintInstruction(
      HOP_MINT,
      ataA,
      withdrawAuth.publicKey,
      [],
      TOKEN_2022_PROGRAM_ID
    );
    const { blockhash } = await conn.getLatestBlockhash("confirmed");
    const tx = new Transaction({
      recentBlockhash: blockhash,
      feePayer: crank.publicKey
    }).add(
      ComputeBudgetProgram.setComputeUnitLimit({ units: 100_000 }),
      ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 1_000 }),
      withdrawIx
    );

    if (dryRun || !allowLive) {
      const sim = await conn.simulateTransaction(tx);
      console.log(`WITHDRAW SIM: ${sim.value.err ? "FAIL " + JSON.stringify(sim.value.err) : "OK"}`);
    } else {
      const sig = await sendAndConfirmTransaction(conn, tx, [crank], { commitment: "confirmed" });
      console.log(`WITHDRAW: ${sig}`);
      txSigs.push(sig);
      totalHarvested = withheldNow;
    }
  } else {
    console.log("No withheld fees to withdraw");
  }

  // Check final ataA balance
  const after = await getAccount(conn, ataA, "confirmed", TOKEN_2022_PROGRAM_ID);
  const afterBalance = Number(after.amount) / 10 ** HOP_DECIMALS;
  const delta = afterBalance - beforeBalance;

  const receipt = {
    verdict: dryRun ? "DRY_RUN" : "EXECUTED",
    ataA: ataA.toBase58(),
    beforeBalance,
    afterBalance,
    deltaHop: delta,
    withheldInMintBefore: withheldInMint,
    txs: txSigs,
    ataCount: allATAs.length,
  };
  writeReceipt("collect-hop-fees", receipt);
  console.log(`\ndelta: +${delta.toFixed(6)} HOP | ataA: ${afterBalance.toFixed(6)} HOP`);
}

main().catch(e => { console.error(e); process.exitCode = 1; });
