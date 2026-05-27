import "dotenv/config";
import fs from "node:fs";
import { Connection, PublicKey, Keypair, TransactionInstruction, ComputeBudgetProgram, VersionedTransaction, TransactionMessage } from "@solana/web3.js";

const conn = new Connection(process.env.SOLANA_RPC_URL || "https://api.mainnet-beta.solana.com", "confirmed");
const crank = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync("/Users/velon/Desktop/redemptionarc/keys/crank.json", "utf8"))));

const WHIRLPOOL_PROGRAM = new PublicKey("GxRHMB9a6XE8BqGPeNb9UkJUPvbvrPoPgNTJPJJA4n8h");
const WHIRLPOOL        = new PublicKey("8aoWgf7ycbeKv6BTFCdUj4JR7Y4mXWuPZWEUhmuzN5ZL");
const TOKEN_VAULT_A    = new PublicKey("4QD4GgnjRvjETqWLT5e3x7SHtJSzs9kShUPLfyHcTu7d");
const TOKEN_VAULT_B    = new PublicKey("Qv51R47g7pMDxa3UofXaz8cNr8pwRSXaNufgnEWX8Yk");
const TICK_ARRAY_84480 = new PublicKey("be9QKj4mYB8erh6r4ZDrKxxSvSYSUNRfpTxqJUgd3jG");
const TICK_ARRAY_95744 = new PublicKey("MXd8HXPjcH9ZCuyr4uKKyN7GkJ5YizZQkgUndB6J8Gz");
const POSITION         = new PublicKey("ErgQU48egJMNBLZeVkdjrtZrSWUQJCky3deh2B4U1YPQ");
const POSITION_TA      = new PublicKey("GgLpt3VY9vWKLnNa5Dj3FKvBn3JEDL4KTKpabCAfL54Q");
const USDC_MINT        = new PublicKey("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v");
const HOP_MINT         = new PublicKey("HZF5k7h39hkysoSZ4ZfmWc55PhvW7ntVvVqdXFCyYGh3");
const TOKEN_PROGRAM_ID     = new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
const TOKEN_2022_PROGRAM_ID = new PublicKey("TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb");
const SPL_MEMO = new PublicKey("MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr");

const CRANK_USDC_ATA = new PublicKey("5BK5sqF2vH8o1BBrSukV44ujpu19rpgvJFedGC8GzF9X");
const CRANK_HOP_ATA  = new PublicKey("2s2Au2bxsvF5cHbdhfP4JaFX8FXp5wXzQxBj15PNPEkD");

const INCREASE_LIQ_DISC = Buffer.from([0x85, 0x1d, 0x59, 0xdf, 0x45, 0xee, 0xb0, 0x0a]);

function u128Le(n: bigint) { const b = Buffer.alloc(16); b.writeBigUInt64LE(n & 0xFFFFFFFFFFFFFFFFn); b.writeBigUInt64LE(n >> 64n, 8); return b; }
function u64Le(n: bigint) { const b = Buffer.alloc(8); b.writeBigUInt64LE(n); return b; }

async function main() {
  const liquidityDelta = 1000000n; // tiny amount
  const tokenMaxA = 1000000n;      // 1 USDC max
  const tokenMaxB = 1000000000n;   // 1000 HOP max

  const ix = new TransactionInstruction({
    programId: WHIRLPOOL_PROGRAM,
    keys: [
      { pubkey: WHIRLPOOL,              isSigner: false, isWritable: true  },
      { pubkey: TOKEN_PROGRAM_ID,       isSigner: false, isWritable: false },
      { pubkey: TOKEN_2022_PROGRAM_ID,  isSigner: false, isWritable: false },
      { pubkey: SPL_MEMO,               isSigner: false, isWritable: false },
      { pubkey: crank.publicKey,        isSigner: true,  isWritable: false },
      { pubkey: POSITION,               isSigner: false, isWritable: true  },
      { pubkey: POSITION_TA,            isSigner: false, isWritable: false },
      { pubkey: USDC_MINT,              isSigner: false, isWritable: false },
      { pubkey: HOP_MINT,               isSigner: false, isWritable: false },
      { pubkey: CRANK_USDC_ATA,         isSigner: false, isWritable: true  },
      { pubkey: CRANK_HOP_ATA,          isSigner: false, isWritable: true  },
      { pubkey: TOKEN_VAULT_A,          isSigner: false, isWritable: true  },
      { pubkey: TOKEN_VAULT_B,          isSigner: false, isWritable: true  },
      { pubkey: TICK_ARRAY_84480,       isSigner: false, isWritable: true  },
      { pubkey: TICK_ARRAY_95744,       isSigner: false, isWritable: true  },
    ],
    data: Buffer.concat([
      INCREASE_LIQ_DISC,
      u128Le(liquidityDelta),
      u64Le(tokenMaxA),
      u64Le(tokenMaxB),
      Buffer.from([0x00]),
    ]),
  });

  const cuIx = ComputeBudgetProgram.setComputeUnitLimit({ units: 400000 });
  const { blockhash } = await conn.getLatestBlockhash("confirmed");
  const msg = new TransactionMessage({
    payerKey: crank.publicKey,
    recentBlockhash: blockhash,
    instructions: [cuIx, ix],
  }).compileToV0Message();
  const tx = new VersionedTransaction(msg);
  tx.sign([crank]);

  const sim = await conn.simulateTransaction(tx, { commitment: "confirmed", sigVerify: false, replaceRecentBlockhash: true });
  console.log("OK:", !sim.value.err);
  console.log("Error:", JSON.stringify(sim.value.err));
  console.log("CU:", sim.value.unitsConsumed);
  (sim.value.logs || []).forEach(l => console.log(" ", l));
}

main().catch(e => { console.error(e); process.exitCode = 1; });
