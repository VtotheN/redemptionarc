import "dotenv/config";
import dotenv from "dotenv";
import { PublicKey } from "@solana/web3.js";
import { TOKEN_2022_PROGRAM_ID } from "@solana/spl-token";
import { FORBIDDEN_WALLETS } from "../constants.js";
import { loadConfig } from "../config.js";
import { connectionFor } from "../utils/rpc.js";
import { writeReceipt } from "../utils/receipt.js";

if (process.env.ENV_PATH) {
  dotenv.config({ path: process.env.ENV_PATH, override: true });
}

type Holder = {
  account: string;
  amount: string;
  decimals: number;
  uiAmount: number | null;
  uiAmountString?: string;
  owner?: string;
  ownerClass?: "redemption" | "forbidden_legacy" | "external" | "unknown";
};

function classifyOwner(owner: string | undefined, redemptionWallets: Set<string>): Holder["ownerClass"] {
  if (!owner) return "unknown";
  if (redemptionWallets.has(owner)) return "redemption";
  if (FORBIDDEN_WALLETS.has(owner)) return "forbidden_legacy";
  return "external";
}

async function main() {
  const config = loadConfig();
  const connection = connectionFor(config.rpcUrl);
  const mint = config.hopMint;
  const redemptionWallets = new Set(
    [config.treasury?.toBase58(), config.crank?.toBase58(), config.withdrawAuthority?.toBase58()]
      .filter((value): value is string => Boolean(value))
  );

  const errors: string[] = [];
  let supply = null;
  try {
    supply = await connection.getTokenSupply(mint, "confirmed");
  } catch (error) {
    errors.push(`getTokenSupply: ${error instanceof Error ? error.message : String(error)}`);
  }

  const holders: Holder[] = [];
  try {
    const largest = await connection.getTokenLargestAccounts(mint, "confirmed");
    for (const item of largest.value) {
      let owner: string | undefined;
      try {
        const parsed = await connection.getParsedAccountInfo(item.address, "confirmed");
        owner = (parsed.value?.data as any)?.parsed?.info?.owner;
      } catch (error) {
        errors.push(`owner(${item.address.toBase58()}): ${error instanceof Error ? error.message : String(error)}`);
      }
      holders.push({
        account: item.address.toBase58(),
        amount: item.amount,
        decimals: item.decimals,
        uiAmount: item.uiAmount,
        uiAmountString: item.uiAmountString,
        owner,
        ownerClass: classifyOwner(owner, redemptionWallets)
      });
    }
  } catch (error) {
    errors.push(`getTokenLargestAccounts: ${error instanceof Error ? error.message : String(error)}`);
  }

  if (holders.length === 0) {
    try {
      const accounts = await connection.getProgramAccounts(TOKEN_2022_PROGRAM_ID, {
        commitment: "confirmed",
        filters: [
          { memcmp: { offset: 0, bytes: mint.toBase58() } }
        ]
      });
      for (const account of accounts.slice(0, 50)) {
        holders.push({
          account: account.pubkey.toBase58(),
          amount: "unknown",
          decimals: supply?.value.decimals ?? 6,
          uiAmount: null,
          ownerClass: "unknown"
        });
      }
    } catch (error) {
      errors.push(`getProgramAccountsFallback: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  const verdict = holders.length > 0
    ? "HOP_HOLDER_SCAN_COMPLETE"
    : "HOP_HOLDER_SCAN_PARTIAL_SUPPLY_ONLY";

  const receipt = {
    verdict,
    generatedAt: new Date().toISOString(),
    mint: mint.toBase58(),
    supply: supply?.value ?? null,
    holders,
    holderSummary: {
      count: holders.length,
      redemptionOwned: holders.filter((holder) => holder.ownerClass === "redemption").length,
      forbiddenLegacyOwned: holders.filter((holder) => holder.ownerClass === "forbidden_legacy").length,
      externalOwned: holders.filter((holder) => holder.ownerClass === "external").length
    },
    settlementRead: holders.some((holder) => holder.ownerClass === "external")
      ? "External HOP holders exist; still need an executable USDC/SOL market, not just holders."
      : "No external settlement market proven by holder scan.",
    errors
  };

  const out = writeReceipt("REDEMPTION-HOP-HOLDER-SCAN-LATEST.json", receipt);
  console.log(`${verdict} supply=${supply?.value.uiAmountString ?? "unknown"} holders=${holders.length} errors=${errors.length} receipt=${out}`);
  if (holders.length === 0) process.exitCode = 1;
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
