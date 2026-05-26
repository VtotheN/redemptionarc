import { Connection, PublicKey } from "@solana/web3.js";
import crypto from "node:crypto";
async function main() {
  const conn = new Connection(process.env.SOLANA_RPC_URL || "https://api.mainnet-beta.solana.com", "confirmed");
  const ORCA = new PublicKey("whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc");
  // Check if program is upgradeable and what IDL it might expose
  const prog = await conn.getAccountInfo(ORCA, "confirmed");
  console.log("program owner:", prog?.owner?.toBase58());
  console.log("program data len:", prog?.data.length);
  // Check if there's an IDL account at the canonical Anchor IDL PDA
  // Anchor IDL PDA = findProgramAddress(["anchor:idl"], programId)[0]... actually it's different
  // Anchor IDL = sha256("anchor") + first 8 bytes as seeds... let me try:
  // IDL account = PDA from base seeds [program_id]
  const [idlAddr] = PublicKey.findProgramAddressSync(
    [Buffer.from("anchor:idl"), ORCA.toBuffer()],
    new PublicKey("Fg6PaFpoGXkYsidMpWTK6W2BeZ7FEfcYkg476zPFsLnS") // Anchor IDL program
  );
  console.log("Potential IDL addr:", idlAddr.toBase58());
  const idl = await conn.getAccountInfo(idlAddr, "confirmed");
  console.log("IDL exists:", !!idl, "size:", idl?.data.length ?? 0);
}
main().catch(console.error);
