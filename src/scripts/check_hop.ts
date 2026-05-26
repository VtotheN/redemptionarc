import { Connection, PublicKey } from "@solana/web3.js";
import { getMint, getTransferFeeConfig, TOKEN_2022_PROGRAM_ID } from "@solana/spl-token";

const RPC = "https://mainnet.helius-rpc.com/?api-key=5b121325-36cb-473b-bbeb-47490d21479c";
const MINT = "HZF5k7h39hkysoSZ4ZfmWc55PhvW7ntVvVqdXFCyYGh3";

async function main() {
  const conn = new Connection(RPC, "confirmed");
  const mint = new PublicKey(MINT);
  const info = await conn.getAccountInfo(mint);
  console.log("Owner:", info?.owner.toBase58());
  console.log("Data length:", info?.data.length);
  
  if (info?.owner.equals(TOKEN_2022_PROGRAM_ID)) {
    const mintInfo = await getMint(conn, mint, "confirmed", TOKEN_2022_PROGRAM_ID);
    const cfg = getTransferFeeConfig(mintInfo);
    console.log("TransferFeeConfig:", cfg ? "YES" : "NO");
    if (cfg) {
      const epoch = BigInt((await conn.getEpochInfo("confirmed")).epoch);
      const active = epoch >= cfg.newerTransferFee.epoch ? cfg.newerTransferFee : cfg.olderTransferFee;
      console.log("Fee bps:", active.transferFeeBasisPoints);
      console.log("Max fee:", active.maximumFee.toString());
      console.log("TransferFeeConfigAuthority:", cfg.transferFeeConfigAuthority?.toBase58() ?? null);
      console.log("WithdrawWithheldAuthority:", cfg.withdrawWithheldAuthority?.toBase58() ?? null);
    }
  }
}
main().catch(console.error);
