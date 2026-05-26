import "dotenv/config";
import { Connection, PublicKey } from "@solana/web3.js";

const CONN = new Connection(process.env.SOLANA_RPC_URL || "https://api.mainnet-beta.solana.com", "confirmed");
const OFFICIAL_CONFIG = new PublicKey("2LecshUwdy9xi7meFgHtFJQNSKk4KdTrcpvaB56dP2NQ");

async function main() {
  const info = await CONN.getAccountInfo(OFFICIAL_CONFIG);
  const buf = Buffer.from(info!.data);
  console.log("Official Orca config:");
  console.log("Full hex:", buf.toString("hex"));
  console.log("Length:", buf.length);
  console.log("offset 104 u16LE:", buf.readUInt16LE(104));
  console.log("offset 106 u16LE:", buf.readUInt16LE(106));

  // Also get extension for official config
  // Extension PDA = seeds ["whirlpools_config_extension", config_pubkey]
  const ORCA_PROG = new PublicKey("whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc");
  const [extPda] = PublicKey.findProgramAddressSync(
    [Buffer.from("whirlpools_config_extension"), OFFICIAL_CONFIG.toBuffer()],
    ORCA_PROG
  );
  console.log("\nOfficial extension PDA:", extPda.toBase58());
  const extInfo = await CONN.getAccountInfo(extPda);
  if (!extInfo) { console.log("Extension not found"); return; }
  const extBuf = Buffer.from(extInfo.data);
  console.log("Extension length:", extBuf.length);
  console.log("Ext offset 104 u16LE:", extBuf.readUInt16LE(104));
  console.log("Ext offset 106 u16LE:", extBuf.readUInt16LE(106));
  console.log("Ext bytes 100-112:", extBuf.slice(100, 112).toString("hex"));

  // Also check KPX9 extension PDA
  const KPX9_CFG = new PublicKey("KPX9QQP4GLWiRkh4pGpkagwoPGaGixarRQs1LQKb9dt");
  const [kpx9Ext] = PublicKey.findProgramAddressSync(
    [Buffer.from("whirlpools_config_extension"), KPX9_CFG.toBuffer()],
    ORCA_PROG
  );
  console.log("\nKPX9 extension PDA:", kpx9Ext.toBase58());
  const kpx9Info = await CONN.getAccountInfo(kpx9Ext);
  if (!kpx9Info) { console.log("KPX9 extension PDA not found"); return; }
  const kpx9Buf = Buffer.from(kpx9Info.data);
  console.log("KPX9 ext length:", kpx9Buf.length);
  console.log("KPX9 ext offset 104 u16LE:", kpx9Buf.readUInt16LE(104));
  console.log("KPX9 ext offset 106 u16LE:", kpx9Buf.readUInt16LE(106));
}
main().catch(console.error);
