import "dotenv/config";
import { Connection } from "@solana/web3.js";
import { KPX9_WHIRLPOOLS_CONFIG, KPX9_CONFIG_EXTENSION } from "../constants.js";

async function main() {
  const conn = new Connection(process.env.SOLANA_RPC_URL || "https://api.mainnet-beta.solana.com", "confirmed");

  const cfg = await conn.getAccountInfo(KPX9_WHIRLPOOLS_CONFIG);
  const ext = await conn.getAccountInfo(KPX9_CONFIG_EXTENSION);

  const cfgBuf = Buffer.from(cfg!.data);
  const extBuf = Buffer.from(ext!.data);

  console.log("=== WhirlpoolsConfig ===");
  console.log("length:", cfgBuf.length);
  console.log("bytes 100-108:", cfgBuf.slice(100, 108).toString("hex"));
  console.log("  offset 104 u16LE:", cfgBuf.readUInt16LE(104));
  console.log("  offset 106 u16LE:", cfgBuf.readUInt16LE(106));

  console.log("\n=== ConfigExtension ===");
  console.log("length:", extBuf.length);
  console.log("bytes 100-112:", extBuf.slice(100, 112).toString("hex"));
  console.log("  offset 104 u16LE:", extBuf.readUInt16LE(104));
  console.log("  offset 106 u16LE:", extBuf.readUInt16LE(106));
  console.log("  offset 108 u16LE:", extBuf.readUInt16LE(108));

  // Show all non-zero u16 values across extension
  console.log("\nExtension non-zero u16 positions (even offsets):");
  for (let i = 8; i < extBuf.length - 1; i += 2) {
    const v = extBuf.readUInt16LE(i);
    if (v !== 0 && i > 100) console.log(`  offset ${i}: 0x${v.toString(16).padStart(4,"0")} (${v})`);
  }
}
main().catch(e => { console.error(e); process.exitCode=1; });
