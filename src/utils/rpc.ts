import { Connection } from "@solana/web3.js";

export function connectionFor(rpcUrl: string): Connection {
  return new Connection(rpcUrl, {
    commitment: "confirmed",
    confirmTransactionInitialTimeout: 60_000
  });
}
