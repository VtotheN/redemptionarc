import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { Keypair, PublicKey } from "@solana/web3.js";

export function loadKeypair(file: string): Keypair {
  return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(file, "utf8")) as number[]));
}

export function publicKeyFromKeypairFile(file: string): PublicKey {
  const secret = Uint8Array.from(JSON.parse(fs.readFileSync(file, "utf8")) as number[]);
  return new PublicKey(secret.slice(32, 64));
}

export function saveKeypair(file: string, keypair: Keypair): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(Array.from(keypair.secretKey)));
  fs.chmodSync(file, 0o600);
}

export function ensureKeypair(file: string, options: { useSolanaKeygen?: boolean } = {}): Keypair {
  if (fs.existsSync(file)) return loadKeypair(file);
  fs.mkdirSync(path.dirname(file), { recursive: true });

  if (options.useSolanaKeygen) {
    const result = spawnSync("solana-keygen", ["new", "--no-bip39-passphrase", "--force", "-o", file], {
      encoding: "utf8",
      stdio: "pipe"
    });
    if (result.status === 0 && fs.existsSync(file)) {
      fs.chmodSync(file, 0o600);
      return loadKeypair(file);
    }
  }

  const keypair = Keypair.generate();
  saveKeypair(file, keypair);
  return keypair;
}

export function assertKeypairMatches(name: string, keypair: Keypair, expected?: PublicKey): void {
  if (expected && !keypair.publicKey.equals(expected)) {
    throw new Error(`${name} keypair ${keypair.publicKey.toBase58()} does not match configured ${expected.toBase58()}`);
  }
}

