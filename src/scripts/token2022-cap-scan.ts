import "dotenv/config";
import dotenv from "dotenv";
import { PublicKey } from "@solana/web3.js";
import { getMint, getTransferFeeConfig, TOKEN_2022_PROGRAM_ID } from "@solana/spl-token";
import { loadConfig } from "../config.js";
import { connectionFor } from "../utils/rpc.js";
import { writeReceipt } from "../utils/receipt.js";

if (process.env.ENV_PATH) {
  dotenv.config({ path: process.env.ENV_PATH, override: true });
}

function calculateTransferFee(args: {
  basisPoints: number;
  maximumFee: bigint;
  amount: bigint;
}): bigint {
  if (args.basisPoints <= 0 || args.amount <= 0n) return 0n;
  const raw = (args.amount * BigInt(args.basisPoints) + 9_999n) / 10_000n;
  return raw > args.maximumFee ? args.maximumFee : raw;
}

function calculateGross(args: {
  volumeMicro: bigint;
  hops: number;
  basisPoints: number;
  maximumFee: bigint;
}): { totalFeeMicro: bigint; finalAmountMicro: bigint; cappedLegs: number } {
  let amount = args.volumeMicro;
  let total = 0n;
  let cappedLegs = 0;

  for (let i = 0; i < args.hops; i++) {
    const raw = (amount * BigInt(args.basisPoints) + 9_999n) / 10_000n;
    const fee = calculateTransferFee({ basisPoints: args.basisPoints, maximumFee: args.maximumFee, amount });
    if (raw > args.maximumFee) cappedLegs += 1;
    total += fee;
    amount -= fee;
  }

  const repayRaw = (amount * BigInt(args.basisPoints) + 9_999n) / 10_000n;
  const repayFee = calculateTransferFee({ basisPoints: args.basisPoints, maximumFee: args.maximumFee, amount });
  if (repayRaw > args.maximumFee) cappedLegs += 1;
  total += repayFee;
  return { totalFeeMicro: total, finalAmountMicro: amount, cappedLegs };
}

async function main() {
  const config = loadConfig();
  const connection = connectionFor(config.rpcUrl);
  const hopMint = new PublicKey(process.env.HOP_MINT || config.hopMint.toBase58());
  const hops = Number(process.env.HOPS || "4");

  const mint = await getMint(connection, hopMint, "confirmed", TOKEN_2022_PROGRAM_ID);
  const cfg = getTransferFeeConfig(mint);
  if (!cfg) {
    const receipt = {
      verdict: "TOKEN2022_CAP_SCAN_REJECTED_NO_TRANSFER_FEE_CONFIG",
      generatedAt: new Date().toISOString(),
      hopMint: hopMint.toBase58()
    };
    const out = writeReceipt("REDEMPTION-TOKEN2022-CAP-SCAN-LATEST.json", receipt);
    console.log(`${receipt.verdict} receipt=${out}`);
    process.exitCode = 1;
    return;
  }

  const epoch = BigInt((await connection.getEpochInfo("confirmed")).epoch);
  const active = epoch >= cfg.newerTransferFee.epoch ? cfg.newerTransferFee : cfg.olderTransferFee;
  const basisPoints = active.transferFeeBasisPoints;
  const maximumFee = active.maximumFee;
  const capStartsAtMicro = basisPoints > 0 ? (maximumFee * 10_000n) / BigInt(basisPoints) : null;

  const testVolumesUsdc = [39, 100, 1_000, 10_000, 100_000, 1_000_000];
  const table = testVolumesUsdc.map((volumeUsdc) => {
    const volumeMicro = BigInt(volumeUsdc) * 1_000_000n;
    const gross = calculateGross({ volumeMicro, hops, basisPoints, maximumFee });
    return {
      volumeUsdc,
      totalFeeUsdc: Number(gross.totalFeeMicro) / 1e6,
      finalAmountUsdc: Number(gross.finalAmountMicro) / 1e6,
      cappedLegs: gross.cappedLegs,
      effectiveFeeBps: Number(gross.totalFeeMicro * 10_000n / volumeMicro)
    };
  });

  const maxGrossPerRingUsdc = Number(maximumFee * BigInt(hops + 1)) / 1e6;

  const receipt = {
    verdict: "TOKEN2022_CAP_SCAN_COMPLETE",
    generatedAt: new Date().toISOString(),
    hopMint: hopMint.toBase58(),
    decimals: mint.decimals,
    epoch: epoch.toString(),
    activeFee: {
      basisPoints,
      maximumFeeMicro: maximumFee.toString(),
      maximumFeeUsdcUnits: Number(maximumFee) / 1e6,
      capStartsAtUsdc: capStartsAtMicro == null ? null : Number(capStartsAtMicro) / 1e6
    },
    hops,
    maxGrossPerRingUsdc,
    table,
    scaleRead: {
      canGetThousandsPerSingleRingByRaisingVolume: maxGrossPerRingUsdc >= 1_000,
      reason: maxGrossPerRingUsdc >= 1_000
        ? "Fee cap allows large single-ring gross; next blocker is liquidity/settlement/CU."
        : "Fee cap prevents thousands per single ring; need many independent rings, new mints/venues, or different source."
    }
  };

  const out = writeReceipt("REDEMPTION-TOKEN2022-CAP-SCAN-LATEST.json", receipt);
  console.log(`${receipt.verdict} maxGrossPerRing=${maxGrossPerRingUsdc.toFixed(6)} capStartsAt=${receipt.activeFee.capStartsAtUsdc?.toFixed(6) ?? "n/a"} receipt=${out}`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
