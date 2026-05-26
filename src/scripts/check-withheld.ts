import "dotenv/config";
import { Connection, PublicKey } from "@solana/web3.js";
import { getAccount, getMint, getTransferFeeConfig, TOKEN_2022_PROGRAM_ID } from "@solana/spl-token";

const conn = new Connection(process.env.SOLANA_RPC_URL || "https://mainnet.helius-rpc.com/?api-key=5b121325-36cb-473b-bbeb-47490d21479c", "confirmed");
const HOP_MINT = new PublicKey("HZF5k7h39hkysoSZ4ZfmWc55PhvW7ntVvVqdXFCyYGh3");
const TOKEN_VAULT_B = new PublicKey("Qv51R47g7pMDxa3UofXaz8cNr8pwRSXaNufgnEWX8Yk");
const RING_ATAS = [
  { name: "ring1", addr: new PublicKey("6y8Q9u9psmrwfiAhV4NwR34ap7GZhU4Vc78PpRequijn") },
  { name: "ring2", addr: new PublicKey("Fq9x3SMf7DLHTVo3yhApFUsM1KibGodbEvcDuGFkiUMJ") },
  { name: "ring3", addr: new PublicKey("DsKieWX5AtrHpefetBe8kxueQXx7TwEH1R2ScCnDN9Jn") },
];

async function main() {
  const mintInfo = await getMint(conn, HOP_MINT, "confirmed", TOKEN_2022_PROGRAM_ID);
  const fc = getTransferFeeConfig(mintInfo)!;
  console.log("=== Withheld State ===");
  console.log(`Mint withheld:  ${(Number(fc.withheldAmount) / 1e6).toFixed(6)} HOP`);
  console.log(`olderFee:       ${fc.olderTransferFee.transferFeeBasisPoints} bps`);
  console.log(`newerFee:       ${fc.newerTransferFee.transferFeeBasisPoints} bps at epoch ${fc.newerTransferFee.epoch}`);

  let totalRingWithheld = 0n;
  for (const { name, addr } of RING_ATAS) {
    const raw = await conn.getAccountInfo(addr, "confirmed");
    if (!raw) { console.log(`${name}: no account`); continue; }
    const buf = raw.data;
    // Standard Token-2022 account: amount at 64, withheldAmount is in TransferFeeAmount extension
    const amount = buf.readBigUInt64LE(64);
    // TransferFeeAmount extension starts at 165+4+8 = 177 typically, type=1
    // Scan for extension type 1 (TransferFeeAmount)
    let withheld = 0n;
    if (buf.length > 165) {
      let off = 165 + 1; // skip account_type byte
      while (off + 4 <= buf.length) {
        const extType = buf.readUInt16LE(off);
        const extLen  = buf.readUInt16LE(off + 2);
        if (extType === 1 && extLen >= 8) {
          withheld = buf.readBigUInt64LE(off + 4);
          break;
        }
        off += 4 + extLen;
      }
    }
    totalRingWithheld += withheld;
    console.log(`${name}: amount=${(Number(amount)/1e6).toFixed(6)} HOP  withheld=${(Number(withheld)/1e6).toFixed(6)} HOP`);
  }

  const vaultRaw = await conn.getAccountInfo(TOKEN_VAULT_B, "confirmed");
  let vaultWithheld = 0n;
  let vaultAmount = 0n;
  if (vaultRaw) {
    const buf = vaultRaw.data;
    vaultAmount = buf.readBigUInt64LE(64);
    if (buf.length > 165) {
      let off = 165 + 1;
      while (off + 4 <= buf.length) {
        const extType = buf.readUInt16LE(off);
        const extLen  = buf.readUInt16LE(off + 2);
        if (extType === 1 && extLen >= 8) {
          vaultWithheld = buf.readBigUInt64LE(off + 4);
          break;
        }
        off += 4 + extLen;
      }
    }
  }
  console.log(`TOKEN_VAULT_B:  amount=${(Number(vaultAmount)/1e6).toFixed(6)} HOP  withheld=${(Number(vaultWithheld)/1e6).toFixed(6)} HOP`);

  const total = totalRingWithheld + vaultWithheld + fc.withheldAmount;
  console.log(`\nTotal harvestable: ${(Number(total)/1e6).toFixed(6)} HOP (~$${(Number(total)/1e6*0.0001).toFixed(4)} @ $0.0001)`);
}

main().catch(e => { console.error(e); process.exit(1); });
