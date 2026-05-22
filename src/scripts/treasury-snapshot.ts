import {
  LAMPORTS_PER_SOL,
  PublicKey
} from "@solana/web3.js";
import {
  TOKEN_2022_PROGRAM_ID,
  TOKEN_PROGRAM_ID
} from "@solana/spl-token";
import { loadConfig } from "../config.js";
import { connectionFor } from "../utils/rpc.js";
import { writeReceipt } from "../utils/receipt.js";

type TokenBalance = {
  programId: string;
  mint: string;
  account: string;
  amountUi: number;
  decimals: number;
  classification: "cash_usdc" | "tracked_non_cash" | "other_non_cash";
};

async function parsedTokenAccounts(owner: PublicKey, programId: PublicKey, rpcUrl: string): Promise<TokenBalance[]> {
  const config = loadConfig();
  const connection = connectionFor(rpcUrl);
  const response = await connection.getParsedTokenAccountsByOwner(owner, { programId });

  return response.value.map(({ pubkey, account }) => {
    const info = account.data.parsed.info;
    const mint = String(info.mint);
    const tokenAmount = info.tokenAmount;
    const amountUi = Number(tokenAmount.uiAmountString || tokenAmount.uiAmount || 0);
    const decimals = Number(tokenAmount.decimals || 0);
    const classification =
      mint === config.usdcMint.toBase58()
        ? "cash_usdc"
        : mint === config.hopMint.toBase58()
          ? "tracked_non_cash"
          : "other_non_cash";

    return {
      programId: programId.toBase58(),
      mint,
      account: pubkey.toBase58(),
      amountUi,
      decimals,
      classification
    };
  });
}

async function main() {
  const config = loadConfig();
  if (!config.treasury) {
    const receipt = {
      verdict: "REDEMPTION_SNAPSHOT_BLOCKED_MISSING_TREASURY",
      generatedAt: new Date().toISOString()
    };
    const path = writeReceipt("REDEMPTION-TREASURY-SNAPSHOT-LATEST.json", receipt);
    console.log(`${receipt.verdict} receipt=${path}`);
    process.exitCode = 1;
    return;
  }

  const connection = connectionFor(config.rpcUrl);
  const lamports = await connection.getBalance(config.treasury, "confirmed");
  const tokenAccounts = [
    ...(await parsedTokenAccounts(config.treasury, TOKEN_PROGRAM_ID, config.rpcUrl)),
    ...(await parsedTokenAccounts(config.treasury, TOKEN_2022_PROGRAM_ID, config.rpcUrl))
  ];

  const usdc = tokenAccounts
    .filter((account) => account.classification === "cash_usdc")
    .reduce((sum, account) => sum + account.amountUi, 0);
  const trackedNonCash = tokenAccounts
    .filter((account) => account.classification === "tracked_non_cash")
    .reduce((sum, account) => sum + account.amountUi, 0);

  const sol = lamports / LAMPORTS_PER_SOL;
  const solPriceUsd = config.solPriceUsd ?? null;
  const spendableUsd = solPriceUsd == null ? null : usdc + sol * solPriceUsd;

  const receipt = {
    verdict: "REDEMPTION_TREASURY_SNAPSHOT",
    generatedAt: new Date().toISOString(),
    treasury: config.treasury.toBase58(),
    cash: {
      sol,
      usdc,
      solPriceUsd,
      spendableUsd
    },
    nonCash: {
      trackedHopOrCustomUnits: trackedNonCash
    },
    tokenAccounts
  };

  const path = writeReceipt("REDEMPTION-TREASURY-SNAPSHOT-LATEST.json", receipt);
  console.log(`${receipt.verdict} receipt=${path}`);
  console.log(`cash_sol=${sol.toFixed(9)} cash_usdc=${usdc.toFixed(6)} non_cash_tracked=${trackedNonCash.toFixed(6)}`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
