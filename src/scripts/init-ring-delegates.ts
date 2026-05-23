/**
 * One-time ring setup:
 *   1. Create HOP ATAs for crank + ring1/2/3
 *   2. Mint HOP to crank ATA (using mint authority)
 *   3. Approve crank as delegate (u64::MAX) on ring1/2/3 ATAs
 *   4. Create USDC ATA for crank (idempotent)
 *
 * Signers: crank + mint-auth + ring1 + ring2 + ring3
 * (ring keys only needed to sign approve; they need 0 SOL)
 */
import "dotenv/config";
import fs from "node:fs";
import {
  Connection, Keypair, PublicKey, Transaction, sendAndConfirmTransaction,
  SystemProgram,
} from "@solana/web3.js";
import {
  TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID,
  getAssociatedTokenAddressSync,
  createAssociatedTokenAccountIdempotentInstruction,
  createMintToInstruction,
  createApproveCheckedInstruction,
} from "@solana/spl-token";
import { writeReceipt } from "../utils/receipt.js";

const HOP_MINT = new PublicKey("HZF5k7h39hkysoSZ4ZfmWc55PhvW7ntVvVqdXFCyYGh3");
const HOP_DECIMALS = 6;
const USDC_MINT = new PublicKey("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v");

function loadKeypair(p: string) {
  return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(p, "utf8")) as number[]));
}

async function main() {
  const rpcUrl = process.env.SOLANA_RPC_URL || "https://api.mainnet-beta.solana.com";
  const dryRun = process.env.DRY_RUN !== "false";
  const allowLive = process.env.ALLOW_LIVE === "true";
  const conn = new Connection(rpcUrl, "confirmed");

  const crank = loadKeypair(process.env.CRANK_KEYPAIR_PATH || "keys/crank.json");
  const mintAuth = loadKeypair(process.env.MINT_AUTH_PATH || "keys/old-fee-config-auth.json"); // FVxMBH = mint authority
  const ring1 = loadKeypair(process.env.RING1_KEYPAIR_PATH || "keys/ring1.json");
  const ring2 = loadKeypair(process.env.RING2_KEYPAIR_PATH || "keys/ring2.json");
  const ring3 = loadKeypair(process.env.RING3_KEYPAIR_PATH || "keys/ring3.json");

  const mintAmountHop = BigInt(process.env.MINT_AMOUNT_HOP || "100000") * BigInt(10 ** HOP_DECIMALS);
  const delegateAmount = BigInt("18446744073709551615"); // u64::MAX

  const ataA = getAssociatedTokenAddressSync(HOP_MINT, crank.publicKey, false, TOKEN_2022_PROGRAM_ID);
  const ataB = getAssociatedTokenAddressSync(HOP_MINT, ring1.publicKey, false, TOKEN_2022_PROGRAM_ID);
  const ataC = getAssociatedTokenAddressSync(HOP_MINT, ring2.publicKey, false, TOKEN_2022_PROGRAM_ID);
  const ataD = getAssociatedTokenAddressSync(HOP_MINT, ring3.publicKey, false, TOKEN_2022_PROGRAM_ID);
  const crankUsdcAta = getAssociatedTokenAddressSync(USDC_MINT, crank.publicKey, false, TOKEN_PROGRAM_ID);

  console.log("=== INIT RING DELEGATES ===");
  console.log("crank:    ", crank.publicKey.toBase58());
  console.log("mintAuth: ", mintAuth.publicKey.toBase58());
  console.log("ataA:     ", ataA.toBase58());
  console.log("ataB:     ", ataB.toBase58(), "(ring1:", ring1.publicKey.toBase58().slice(0,8)+")");
  console.log("ataC:     ", ataC.toBase58(), "(ring2:", ring2.publicKey.toBase58().slice(0,8)+")");
  console.log("ataD:     ", ataD.toBase58(), "(ring3:", ring3.publicKey.toBase58().slice(0,8)+")");
  console.log("mintHOP:  ", Number(mintAmountHop) / 10**HOP_DECIMALS, "HOP → ataA");
  console.log("delegate: u64::MAX on ataB/C/D → crank");
  console.log();

  const tx = new Transaction();

  // 1. Create HOP ATAs (idempotent)
  tx.add(createAssociatedTokenAccountIdempotentInstruction(crank.publicKey, ataA, crank.publicKey, HOP_MINT, TOKEN_2022_PROGRAM_ID));
  tx.add(createAssociatedTokenAccountIdempotentInstruction(crank.publicKey, ataB, ring1.publicKey, HOP_MINT, TOKEN_2022_PROGRAM_ID));
  tx.add(createAssociatedTokenAccountIdempotentInstruction(crank.publicKey, ataC, ring2.publicKey, HOP_MINT, TOKEN_2022_PROGRAM_ID));
  tx.add(createAssociatedTokenAccountIdempotentInstruction(crank.publicKey, ataD, ring3.publicKey, HOP_MINT, TOKEN_2022_PROGRAM_ID));

  // 2. Mint HOP to ataA
  tx.add(createMintToInstruction(HOP_MINT, ataA, mintAuth.publicKey, mintAmountHop, [], TOKEN_2022_PROGRAM_ID));

  // 3. Approve crank as delegate on ataB/C/D (ring wallets sign)
  tx.add(createApproveCheckedInstruction(ataB, HOP_MINT, crank.publicKey, ring1.publicKey, delegateAmount, HOP_DECIMALS, [], TOKEN_2022_PROGRAM_ID));
  tx.add(createApproveCheckedInstruction(ataC, HOP_MINT, crank.publicKey, ring2.publicKey, delegateAmount, HOP_DECIMALS, [], TOKEN_2022_PROGRAM_ID));
  tx.add(createApproveCheckedInstruction(ataD, HOP_MINT, crank.publicKey, ring3.publicKey, delegateAmount, HOP_DECIMALS, [], TOKEN_2022_PROGRAM_ID));

  // 4. Create USDC ATA for crank (idempotent)
  tx.add(createAssociatedTokenAccountIdempotentInstruction(crank.publicKey, crankUsdcAta, crank.publicKey, USDC_MINT));

  tx.recentBlockhash = (await conn.getLatestBlockhash("confirmed")).blockhash;
  tx.feePayer = crank.publicKey;

  const signers = [crank, mintAuth, ring1, ring2, ring3];

  if (dryRun || !allowLive) {
    tx.partialSign(...signers);
    const sim = await conn.simulateTransaction(tx);
    console.log("SIM:", sim.value.err ? "FAILED" : "OK");
    if (sim.value.err) console.log("err:", sim.value.err);
    console.log("logs:", sim.value.logs?.slice(-6));
  } else {
    const sig = await sendAndConfirmTransaction(conn, tx, signers, { commitment: "confirmed" });
    console.log("EXECUTED:", sig);
    writeReceipt("init-ring-delegates", {
      sig,
      ataA: ataA.toBase58(),
      ataB: ataB.toBase58(),
      ataC: ataC.toBase58(),
      ataD: ataD.toBase58(),
      mintedHop: Number(mintAmountHop) / 10**HOP_DECIMALS,
    });
  }
}

main().catch(e => { console.error(e); process.exitCode = 1; });
