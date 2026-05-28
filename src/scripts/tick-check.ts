import "dotenv/config";
import { Connection, PublicKey } from "@solana/web3.js";

const conn = new Connection(process.env.SOLANA_RPC_URL!, "confirmed");
const wp = new PublicKey("8aoWgf7ycbeKv6BTFCdUj4JR7Y4mXWuPZWEUhmuzN5ZL");

async function main() {
  const info = await conn.getAccountInfo(wp, "confirmed");
  const buf = Buffer.from(info!.data);
  // scan all plausible tick offsets
  for (const off of [77,78,79,80,81,82,83,84,85]) {
    const v = buf.readInt32LE(off);
    if (v > 80000 && v < 110000) console.log(`tick offset ${off} = ${v}`);
  }
  // sqrt price Q64.64
  const sqrtX64 = buf.readBigUInt64LE(65) | (buf.readBigUInt64LE(73) << 64n);
  const sqrtF = Number(sqrtX64) / 2**64;
  const hopPerUsdc = sqrtF * sqrtF;
  const usdcPerHop = 1 / hopPerUsdc;
  console.log(`sqrtPriceX64: ${sqrtX64}`);
  console.log(`1 HOP = $${usdcPerHop.toFixed(8)} USDC`);
  console.log(`(${(hopPerUsdc).toFixed(0)} HOP per USDC)`);
}
main().catch(console.error);
