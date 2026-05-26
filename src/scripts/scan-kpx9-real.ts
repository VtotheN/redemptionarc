import { Connection, PublicKey } from '@solana/web3.js';

async function main() {
  const rpc = process.env.SOLANA_RPC_URL || 'https://api.mainnet-beta.solana.com';
  const conn = new Connection(rpc, 'confirmed');
  const CONFIG = new PublicKey('KPX9QQP4GLWiRkh4pGpkagwoPGaGixarRQs1LQKb9dt');
  const WHIRLPOOL_PROGRAM = new PublicKey('whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc');

  console.log('Fetching whirlpools under KPX9 config...');
  const accounts = await conn.getProgramAccounts(WHIRLPOOL_PROGRAM, {
    filters: [
      { dataSize: 653 },
    ]
  });
  console.log('Total whirlpools fetched:', accounts.length);

  const matches: any[] = [];
  for (const acc of accounts) {
    const configBytes = acc.account.data.subarray(8, 40);
    if (configBytes.equals(CONFIG.toBuffer())) {
      const feeRate = acc.account.data.readUInt16LE(45);
      const protocolFeeRate = acc.account.data.readUInt16LE(47);
      const tickCurrent = acc.account.data.readInt32LE(81);
      const protoFeeA = BigInt('0x' + acc.account.data.subarray(85, 93).toString('hex').match(/../g)!.reverse().join(''));
      const protoFeeB = BigInt('0x' + acc.account.data.subarray(93, 101).toString('hex').match(/../g)!.reverse().join(''));
      const tokenMintA = new PublicKey(acc.account.data.subarray(101, 133)).toBase58();
      const tokenMintB = new PublicKey(acc.account.data.subarray(133, 165)).toBase58();
      matches.push({
        whirlpool: acc.pubkey.toBase58(),
        feeRate,
        protocolFeeRate,
        tickCurrent,
        protoFeeA: Number(protoFeeA),
        protoFeeB: Number(protoFeeB),
        tokenMintA,
        tokenMintB,
      });
    }
  }
  console.log('Pools under KPX9 config:', matches.length);
  console.log(JSON.stringify(matches, null, 2));
}

main().catch(console.error);
