import "dotenv/config";
import { PublicKey, AccountInfo } from "@solana/web3.js";
import { unpackMint, getTransferFeeConfig, TOKEN_2022_PROGRAM_ID } from "@solana/spl-token";
import { connectionFor } from "../utils/rpc.js";

const RPC_URL = process.env.SOLANA_RPC_URL || "https://api.mainnet-beta.solana.com";

async function main() {
  const connection = connectionFor(RPC_URL);
  const candidateAddrs = [
    "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", // USDC
    "So11111111111111111111111111111111111111112",    // SOL
    "HZF5k7h39hkysoSZ4ZfmWc55PhvW7ntVvVqdXFCyYGh3", // HOP
  ];
  
  for (const addr of candidateAddrs) {
    const info = await connection.getAccountInfo(new PublicKey(addr));
    console.log(addr, "owner:", info?.owner.toBase58(), "len:", info?.data.length);
    if (info && info.owner.equals(TOKEN_2022_PROGRAM_ID)) {
      const mint = unpackMint(new PublicKey(addr), info, TOKEN_2022_PROGRAM_ID);
      const cfg = getTransferFeeConfig(mint);
      if (cfg) {
        const epoch = BigInt((await connection.getEpochInfo("confirmed")).epoch);
        const active = epoch >= cfg.newerTransferFee.epoch ? cfg.newerTransferFee : cfg.olderTransferFee;
        console.log("  feeBps:", active.transferFeeBasisPoints, "maxFee:", active.maximumFee.toString());
      }
    }
  }
}
main().catch(console.error);
