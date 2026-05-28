import "dotenv/config";
import { Connection, LAMPORTS_PER_SOL, PublicKey } from "@solana/web3.js";
import { TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID } from "@solana/spl-token";

const ENCHANCEDBLOCK_USDC_VAULT = new PublicKey("CYaPwtMHcQbbMiEggxpwLvzswqnXqzrsA2AxArrXCazb");
const CSDM_POOL_PDA             = new PublicKey("BSHxRLtdgndvUWdKSH4rkeA1j1iS3TzLMgX25VeDQdCQ");
const HOP_TREASURY              = new PublicKey("BGM3VPeND4xts3J6WeaeRJVFpzAJhyJiqycqYP2vk6dV");
const HOP_MINT                  = new PublicKey("HZF5k7h39hkysoSZ4ZfmWc55PhvW7ntVvVqdXFCyYGh3");
const USDC_MINT                 = new PublicKey("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v");

const SOL_NEEDED_FOR_ENCHANCEDBLOCK = 10;
const MIN_USDC_FOR_GATE1            = 50;

async function fetchTokenBalance(
  conn: Connection,
  account: PublicKey
): Promise<number | null> {
  try {
    const res = await conn.getTokenAccountBalance(account, "confirmed");
    return Number(res.value.uiAmountString ?? res.value.uiAmount ?? 0);
  } catch {
    return null;
  }
}

async function fetchLamports(conn: Connection, account: PublicKey): Promise<number | null> {
  try {
    return await conn.getBalance(account, "confirmed");
  } catch {
    return null;
  }
}

function fmt(v: number | null, prefix = "$", suffix = " USDC"): string {
  if (v === null) return "NOT FOUND";
  return `${prefix}${v.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}${suffix}`;
}

function fmtHop(v: number | null): string {
  if (v === null) return "NOT FOUND";
  return `${Math.round(v).toLocaleString("en-US")} HOP`;
}

async function main() {
  const rpcUrl = process.env.SOLANA_RPC_URL ?? "https://api.mainnet-beta.solana.com";
  const conn = new Connection(rpcUrl, "confirmed");

  const now = new Date().toISOString();
  console.log(`\n=== SETTLEMENT STATUS ${now} ===\n`);

  // --- ENCHANCEDBLOCK ---
  const enchUSDC = await fetchTokenBalance(conn, ENCHANCEDBLOCK_USDC_VAULT);
  // SOL vault not directly derivable without VPS — check lamports on the vault account itself as proxy
  const enchVaultLamports = await fetchLamports(conn, ENCHANCEDBLOCK_USDC_VAULT);
  const enchVaultSOL = enchVaultLamports !== null ? enchVaultLamports / LAMPORTS_PER_SOL : null;

  console.log("--- ENCHANCEDBLOCK (external arb source) ---");
  console.log(`  USDC vault:  ${fmt(enchUSDC)}  ← real external arb earnings`);
  if (enchVaultSOL !== null) {
    const solStatus =
      enchVaultSOL >= SOL_NEEDED_FOR_ENCHANCEDBLOCK
        ? "READY"
        : `UNDERFUNDED (needs ${SOL_NEEDED_FOR_ENCHANCEDBLOCK} SOL, has ${enchVaultSOL.toFixed(3)} SOL)`;
    console.log(`  SOL (vault acct): ${enchVaultSOL.toFixed(3)} SOL`);
    console.log(`  Status:      ${solStatus}`);
  } else {
    console.log("  SOL vault check: requires VPS query (SSH 37.27.214.225)");
  }

  // --- CSDM ---
  const csdmUSDC = await fetchTokenBalance(conn, CSDM_POOL_PDA);

  console.log("\n--- CSDM (flash backing vault) ---");
  console.log(`  Pool USDC:   ${fmt(csdmUSDC)}  ← available for flash lending`);
  console.log(`  IX 7 ready:  ${csdmUSDC !== null && csdmUSDC > 0 ? "YES" : "NO"}`);

  // --- HOP TREASURY ---
  // HOP is Token-2022 — getTokenAccountBalance works regardless of program
  const hopBalance = await fetchTokenBalance(conn, HOP_TREASURY);

  console.log("\n--- HOP TREASURY ---");
  console.log(`  HOP balance: ${fmtHop(hopBalance)}  ← accumulated T22 fees`);

  // --- SETTLEMENT GATES ---
  const gate1 = enchUSDC !== null && enchUSDC >= MIN_USDC_FOR_GATE1;
  const gate2 = enchVaultSOL !== null && enchVaultSOL >= SOL_NEEDED_FOR_ENCHANCEDBLOCK;
  const gate3 = csdmUSDC !== null && csdmUSDC > 0;
  const gate4 = hopBalance !== null && hopBalance > 0;

  const g = (ok: boolean) => (ok ? "✓" : "✗");

  console.log("\n--- SETTLEMENT GATES ---");
  console.log(
    `  [${g(gate1)}] Gate 1 — ENCHANCEDBLOCK USDC > $${MIN_USDC_FOR_GATE1}:` +
    `     ${enchUSDC !== null ? `$${enchUSDC.toFixed(0)}` : "NOT FOUND"} ${g(gate1)}`
  );
  console.log(
    `  [${g(gate2)}] Gate 2 — ENCHANCEDBLOCK SOL >= ${SOL_NEEDED_FOR_ENCHANCEDBLOCK}:` +
    `       ${enchVaultSOL !== null ? `${enchVaultSOL.toFixed(3)} SOL` : "VPS required"} ${g(gate2)}`
  );
  console.log(
    `  [${g(gate3)}] Gate 3 — CSDM backing available:` +
    `         ${csdmUSDC !== null ? `$${csdmUSDC.toFixed(0)}` : "NOT FOUND"} ${g(gate3)}`
  );
  console.log(
    `  [${g(gate4)}] Gate 4 — HOP treasury non-empty:` +
    `         ${hopBalance !== null ? `${Math.round(hopBalance).toLocaleString()} HOP` : "NOT FOUND"} ${g(gate4)}`
  );

  const allGates = gate1 && gate2 && gate3 && gate4;
  const blockers: string[] = [];
  if (!gate1) blockers.push(`fund ENCHANCEDBLOCK USDC vault (need $${MIN_USDC_FOR_GATE1}, have $${enchUSDC?.toFixed(2) ?? "?"}})`);
  if (!gate2) {
    const missing =
      enchVaultSOL !== null
        ? `${(SOL_NEEDED_FOR_ENCHANCEDBLOCK - enchVaultSOL).toFixed(3)} SOL`
        : `${SOL_NEEDED_FOR_ENCHANCEDBLOCK} SOL (unverified — check VPS)`;
    blockers.push(`fund ENCHANCEDBLOCK sol_vault with ${missing}`);
  }
  if (!gate3) blockers.push("fund CSDM pool PDA with USDC");
  if (!gate4) blockers.push("HOP treasury empty — run collect-hop-fees");

  console.log();
  if (allGates) {
    console.log(
      "  STATUS: READY — run not-stacc-replicate.ts with SETTLEMENT_CONFIRMED=true"
    );
  } else {
    console.log(`  STATUS: BLOCKED — ${blockers[0]}`);
    if (blockers.length > 1) {
      for (let i = 1; i < blockers.length; i++) {
        console.log(`           also: ${blockers[i]}`);
      }
    }
  }

  console.log("\n===\n");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
