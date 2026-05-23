/**
 * Read-only STACC on-chain autopsy.
 *
 * Fetches the reference tx plus surrounding WzMaL78 transactions from mainnet
 * RPC, decodes token/native balance deltas, MarginFi/T22/Orca instruction
 * sequence, Jito-tip evidence, and the Bzk TokenBadge PDA state.
 */
import "dotenv/config";
import { createRequire } from "node:module";
import {
  Connection,
  ParsedInstruction,
  PartiallyDecodedInstruction,
  PublicKey,
} from "@solana/web3.js";
import { writeReceipt } from "../utils/receipt.js";

const require = createRequire(import.meta.url);
const bs58 = require("bs58") as { decode: (s: string) => Uint8Array };

const DEFAULT_RPC = "https://mainnet.helius-rpc.com/?api-key=5b121325-36cb-473b-bbeb-47490d21479c";

const REFERENCE_SIG = "2jgoM1pFSH7FRqnLixMs3GAYrNQWDiJyMf1G284FTBWNjXqFy7MAV9cA1uyg4KDLw3dQsYN9xKvTimmRbscMGaLe";
const STACC_WALLET = new PublicKey("WzMaL78srutrF6CsxEkWuhMaDF5HZA6jNRaEPengqpb");
const STACC_CONFIG_FALLBACK = new PublicKey("D8WBXfePEmWoK27pRoCKvzfsjZrWZJVmGN9tZguvnKBB");
const STACC_BZK_POOL = new PublicKey("9edoD8zkgyjTf8YdBQymUNvhWp4FyMPuiwALHyDk2538");
const BZK_MINT = new PublicKey("Bzkdz5AKApsqizBxzqMUqWGJbx4gHXVC6NJekmAY8Gq3");
const HOP_MINT = new PublicKey("HZF5k7h39hkysoSZ4ZfmWc55PhvW7ntVvVqdXFCyYGh3");
const OFFICIAL_ORCA = new PublicKey("whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc");

const MARGINFI_PROGRAM = "MFv2hWf31Z9kbCa1snEPYctwafyhdvnV7FZnsebVacA";
const TOKEN_2022_PROGRAM = "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb";

const DISC = {
  computeBudgetSetLimitPrefix: "02",
  computeBudgetSetPricePrefix: "03",
  marginfiStart: "0e8321dc51bab46b",
  marginfiBorrow: "047e74353005d41f",
  marginfiRepay: "4fd1acb1de33ad97",
  marginfiEnd: "697cc96a9902089c",
  whirlpoolInitializeConfigExtension: "370935097239d134",
  whirlpoolInitializeTickArray: "0bbcc1d68d5b95b8",
  whirlpoolCollectProtocolFeesV2: "6780de8672c816c8",
  whirlpoolInitializeTokenBadge: "fd4dcd5f1be059df",
  whirlpoolInitializeFeeTier: "b74a9ca070022a1e",
  whirlpoolInitializePoolV2: "cf2d57f21b3fcc43",
  whirlpoolOpenPositionWithTokenExtensions: "d42f5f5c726683fa",
  whirlpoolIncreaseLiquidityV2: "851d59df45eeb00a",
  whirlpoolSwapV2: "2b04ed0b1ac91e62",
  jupiterRoute: "bb64facc31c4af14",
} as const;

const JITO_TIP_ACCOUNTS = new Set([
  "96gYZGLnJYVFmbjzopPSU6QiEV5fGqZNyN9nmNhvrZU5",
  "HFqU5x63VTqvQss8hp11i4wVV8bD44PvwucfZ2bU7gRe",
  "CwyzzD8E6FDi3v4CRVwZSTvaLq2XBcjNCsvh9GepPump",
  "ADaUMid9yfUytYkqR1VJb8s3Q5X4m3BZv2HFbSytRsc",
  "DfXygSm4jCyNCybVYYK6DwvWqjKee8pbDmJGcLWNDXjh",
  "ADuUkRmcY7mY1JmXeGpFs8AXAB9vL4WoD4z8J2YfNf3g",
  "DttWaMuVvTiduZRnguLFvRwBv7H6TL9Rghw9vYdqz3d",
  "3AVi9Tg9Uo68tJfuvoKvqKNWKkC5wPdSSdeBnizKZ6jT",
  "2nyhqdwKcJZR2vcqCyrYsaPVdAnFoJjiksCXJ7hfEYgD",
]);

function redactedRpc(url: string): string {
  return url.replace(/api-key=([^&]+)/, "api-key=<redacted>");
}

function u16Le(value: number): Buffer {
  const out = Buffer.alloc(2);
  out.writeUInt16LE(value);
  return out;
}

function readU64(data: Buffer, offset: number): string | null {
  if (data.length < offset + 8) return null;
  return data.readBigUInt64LE(offset).toString();
}

function decodeCustom(programId: string, dataBase58?: string): Record<string, unknown> {
  if (!dataBase58) return {};
  const data = Buffer.from(bs58.decode(dataBase58));
  const disc = data.subarray(0, 8).toString("hex");
  const out: Record<string, unknown> = { discriminator: disc, rawDataBase58: dataBase58 };

  if (programId === "ComputeBudget111111111111111111111111111111") {
    if (data[0] === 2 && data.length >= 5) {
      out.name = "compute_budget.set_compute_unit_limit";
      out.units = data.readUInt32LE(1);
    } else if (data[0] === 3 && data.length >= 9) {
      out.name = "compute_budget.set_compute_unit_price";
      out.microLamports = data.readBigUInt64LE(1).toString();
    }
  } else if (programId === MARGINFI_PROGRAM) {
    if (disc === DISC.marginfiStart) {
      out.name = "marginfi.start_flashloan";
      out.endIndex = readU64(data, 8);
    } else if (disc === DISC.marginfiBorrow) {
      out.name = "marginfi.lending_account_borrow";
      out.amountRaw = readU64(data, 8);
      out.amountUiAssumingUsdc = Number(readU64(data, 8) ?? "0") / 1e6;
    } else if (disc === DISC.marginfiRepay) {
      out.name = "marginfi.lending_account_repay";
      out.amountRaw = readU64(data, 8);
      out.amountUiAssumingUsdc = Number(readU64(data, 8) ?? "0") / 1e6;
      out.repayAllFlag = data.length > 16 ? data[16] : null;
    } else if (disc === DISC.marginfiEnd) {
      out.name = "marginfi.end_flashloan";
    }
  } else if (programId === OFFICIAL_ORCA.toBase58()) {
    if (disc === DISC.whirlpoolInitializeConfigExtension) out.name = "orca.initialize_config_extension";
    if (disc === DISC.whirlpoolInitializeTickArray) out.name = "orca.initialize_tick_array";
    if (disc === DISC.whirlpoolCollectProtocolFeesV2) out.name = "orca.collect_protocol_fees_v2";
    if (disc === DISC.whirlpoolInitializeTokenBadge) out.name = "orca.initialize_token_badge";
    if (disc === DISC.whirlpoolInitializeFeeTier) out.name = "orca.initialize_fee_tier";
    if (disc === DISC.whirlpoolInitializePoolV2) out.name = "orca.initialize_pool_v2";
    if (disc === DISC.whirlpoolOpenPositionWithTokenExtensions) out.name = "orca.open_position_with_token_extensions";
    if (disc === DISC.whirlpoolIncreaseLiquidityV2) out.name = "orca.increase_liquidity_v2";
    if (disc === DISC.whirlpoolSwapV2) out.name = "orca.swap_v2";
  } else if (programId === "JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4") {
    if (disc === DISC.jupiterRoute) out.name = "jupiter.route";
  }

  return out;
}

function ui(raw: bigint, decimals: number): number {
  return Number(raw) / 10 ** decimals;
}

function deriveConfigExtension(config: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("config_extension"), config.toBuffer()],
    OFFICIAL_ORCA
  )[0];
}

function deriveTokenBadge(config: PublicKey, mint: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("token_badge"), config.toBuffer(), mint.toBuffer()],
    OFFICIAL_ORCA
  )[0];
}

function decodeTokenBadge(data: Buffer): Record<string, unknown> {
  return {
    discriminatorHex: data.subarray(0, 8).toString("hex"),
    whirlpoolsConfig: data.length >= 40 ? new PublicKey(data.subarray(8, 40)).toBase58() : null,
    tokenMint: data.length >= 72 ? new PublicKey(data.subarray(40, 72)).toBase58() : null,
    bumpOrTrailingByte: data.length >= 73 ? data[72] : null,
    rawHex: data.toString("hex"),
  };
}

function decodeConfig(data: Buffer): Record<string, unknown> {
  return {
    discriminatorHex: data.subarray(0, 8).toString("hex"),
    feeAuthority: data.length >= 40 ? new PublicKey(data.subarray(8, 40)).toBase58() : null,
    collectProtocolFeesAuthority: data.length >= 72 ? new PublicKey(data.subarray(40, 72)).toBase58() : null,
    rewardEmissionsSuperAuthority: data.length >= 104 ? new PublicKey(data.subarray(72, 104)).toBase58() : null,
    defaultProtocolFeeRate: data.length >= 106 ? data.readUInt16LE(104) : null,
    rawHex: data.toString("hex"),
  };
}

function decodeConfigExtension(data: Buffer): Record<string, unknown> {
  return {
    discriminatorHex: data.subarray(0, 8).toString("hex"),
    whirlpoolsConfig: data.length >= 40 ? new PublicKey(data.subarray(8, 40)).toBase58() : null,
    configExtensionAuthority: data.length >= 72 ? new PublicKey(data.subarray(40, 72)).toBase58() : null,
    tokenBadgeAuthority: data.length >= 104 ? new PublicKey(data.subarray(72, 104)).toBase58() : null,
    trailingBytesHex: data.length > 104 ? data.subarray(104).toString("hex") : "",
    rawHex: data.toString("hex"),
  };
}

function readU16(data: Buffer, offset: number): number | null {
  return data.length >= offset + 2 ? data.readUInt16LE(offset) : null;
}

function readU64Big(data: Buffer, offset: number): string | null {
  return data.length >= offset + 8 ? data.readBigUInt64LE(offset).toString() : null;
}

function readU128Big(data: Buffer, offset: number): string | null {
  if (data.length < offset + 16) return null;
  const lo = data.readBigUInt64LE(offset);
  const hi = data.readBigUInt64LE(offset + 8);
  return (lo | (hi << 64n)).toString();
}

function readI32(data: Buffer, offset: number): number | null {
  return data.length >= offset + 4 ? data.readInt32LE(offset) : null;
}

function decodeWhirlpool(data: Buffer): Record<string, unknown> {
  return {
    discriminatorHex: data.subarray(0, 8).toString("hex"),
    whirlpoolsConfig: data.length >= 40 ? new PublicKey(data.subarray(8, 40)).toBase58() : null,
    tickSpacing: readU16(data, 41),
    feeRate: readU16(data, 45),
    feeRatePercent: readU16(data, 45) === null ? null : Number(readU16(data, 45)) / 10_000,
    protocolFeeRate: readU16(data, 47),
    liquidity: readU128Big(data, 49),
    sqrtPrice: readU128Big(data, 65),
    tickCurrentIndex: readI32(data, 81),
    protocolFeeOwedA: readU64Big(data, 85),
    protocolFeeOwedB: readU64Big(data, 93),
    tokenMintA: data.length >= 133 ? new PublicKey(data.subarray(101, 133)).toBase58() : null,
    tokenVaultA: data.length >= 165 ? new PublicKey(data.subarray(133, 165)).toBase58() : null,
    tokenMintB: data.length >= 213 ? new PublicKey(data.subarray(181, 213)).toBase58() : null,
    tokenVaultB: data.length >= 245 ? new PublicKey(data.subarray(213, 245)).toBase58() : null,
  };
}

function accountKeys(tx: Awaited<ReturnType<Connection["getParsedTransaction"]>>): string[] {
  if (!tx) return [];
  return tx.transaction.message.accountKeys.map((k) => k.pubkey.toBase58());
}

function instructionProgramId(ix: ParsedInstruction | PartiallyDecodedInstruction): string {
  if ("programId" in ix) return ix.programId.toBase58();
  return "";
}

function summarizeInstruction(
  ix: ParsedInstruction | PartiallyDecodedInstruction,
  index: number,
  keys: string[],
  parentIndex: number | null,
): Record<string, unknown> {
  const programId = instructionProgramId(ix);
  if ("parsed" in ix) {
    return {
      index,
      parentIndex,
      program: ix.program,
      programId,
      type: typeof ix.parsed === "object" && ix.parsed && "type" in ix.parsed ? ix.parsed.type : "parsed",
      info: typeof ix.parsed === "object" && ix.parsed && "info" in ix.parsed ? ix.parsed.info : ix.parsed,
    };
  }

  return {
    index,
    parentIndex,
    programId,
    accounts: ix.accounts.map((a) => a.toBase58()),
    ...decodeCustom(programId, ix.data),
    accountLabels: ix.accounts.map((a) => {
      const idx = keys.indexOf(a.toBase58());
      return { pubkey: a.toBase58(), accountIndex: idx >= 0 ? idx : null };
    }),
  };
}

function nativeDeltas(tx: Awaited<ReturnType<Connection["getParsedTransaction"]>>): Record<string, unknown>[] {
  if (!tx?.meta) return [];
  const keys = accountKeys(tx);
  return keys.map((pubkey, i) => {
    const pre = BigInt(tx.meta?.preBalances[i] ?? 0);
    const post = BigInt(tx.meta?.postBalances[i] ?? 0);
    return { account: pubkey, preLamports: pre.toString(), postLamports: post.toString(), deltaLamports: (post - pre).toString() };
  }).filter((x) => x.deltaLamports !== "0");
}

function tokenDeltas(tx: Awaited<ReturnType<Connection["getParsedTransaction"]>>): Record<string, unknown>[] {
  if (!tx?.meta) return [];
  const keys = accountKeys(tx);
  const pre = new Map<string, { amount: bigint; decimals: number; mint: string; owner?: string; programId?: string; accountIndex: number }>();
  for (const b of tx.meta.preTokenBalances ?? []) {
    pre.set(`${b.accountIndex}:${b.mint}`, {
      amount: BigInt(b.uiTokenAmount.amount),
      decimals: b.uiTokenAmount.decimals,
      mint: b.mint,
      owner: b.owner,
      programId: b.programId,
      accountIndex: b.accountIndex,
    });
  }
  const post = new Map(pre);
  for (const b of tx.meta.postTokenBalances ?? []) {
    post.set(`${b.accountIndex}:${b.mint}`, {
      amount: BigInt(b.uiTokenAmount.amount),
      decimals: b.uiTokenAmount.decimals,
      mint: b.mint,
      owner: b.owner,
      programId: b.programId,
      accountIndex: b.accountIndex,
    });
  }

  const allKeys = new Set([...pre.keys(), ...post.keys()]);
  const out: Record<string, unknown>[] = [];
  for (const key of allKeys) {
    const a = pre.get(key);
    const b = post.get(key);
    const decimals = b?.decimals ?? a?.decimals ?? 0;
    const before = a?.amount ?? 0n;
    const after = b?.amount ?? 0n;
    const delta = after - before;
    if (delta === 0n) continue;
    const accountIndex = b?.accountIndex ?? a?.accountIndex ?? -1;
    out.push({
      account: keys[accountIndex] ?? null,
      accountIndex,
      owner: b?.owner ?? a?.owner ?? null,
      mint: b?.mint ?? a?.mint ?? null,
      programId: b?.programId ?? a?.programId ?? null,
      decimals,
      preRaw: before.toString(),
      postRaw: after.toString(),
      deltaRaw: delta.toString(),
      deltaUi: ui(delta, decimals),
    });
  }
  return out;
}

function systemTipTransfers(decoded: Record<string, unknown>[]): Record<string, unknown>[] {
  return decoded.filter((ix) => {
    if (ix.program !== "system" || ix.type !== "transfer") return false;
    const info = ix.info as { destination?: string } | undefined;
    return !!info?.destination && JITO_TIP_ACCOUNTS.has(info.destination);
  });
}

async function summarizeTx(connection: Connection, signature: string): Promise<Record<string, unknown>> {
  const tx = await connection.getParsedTransaction(signature, {
    commitment: "confirmed",
    maxSupportedTransactionVersion: 0,
  });
  if (!tx) return { signature, missing: true };

  const keys = accountKeys(tx);
  const topLevel = tx.transaction.message.instructions.map((ix, i) => summarizeInstruction(ix, i, keys, null));
  const inner = (tx.meta?.innerInstructions ?? []).flatMap((group) =>
    group.instructions.map((ix, i) => summarizeInstruction(ix, i, keys, group.index))
  );
  const decoded = [...topLevel, ...inner];
  const tips = systemTipTransfers(decoded);
  const tokenChanges = tokenDeltas(tx);
  const nativeChanges = nativeDeltas(tx);
  const marginfiBorrowRaw = decoded
    .filter((ix) => ix.name === "marginfi.lending_account_borrow")
    .map((ix) => ix.amountRaw);
  const marginfiRepayRaw = decoded
    .filter((ix) => ix.name === "marginfi.lending_account_repay")
    .map((ix) => ix.amountRaw);
  const t22Transfers = decoded.filter((ix) => ix.programId === TOKEN_2022_PROGRAM && ix.type === "transferCheckedWithFee");
  const withdrawWithheld = decoded.filter((ix) => ix.programId === TOKEN_2022_PROGRAM && ix.type === "withdrawWithheldTokensFromMint");
  const collectProtocolFees = decoded.filter((ix) =>
    ix.name === "orca.collect_protocol_fees_v2" ||
    (typeof ix.name === "string" && ix.name.includes("collect_protocol"))
  );

  return {
    signature,
    slot: tx.slot,
    blockTime: tx.blockTime,
    err: tx.meta?.err ?? null,
    feeLamports: tx.meta?.fee ?? null,
    computeUnitsConsumed: tx.meta?.computeUnitsConsumed ?? null,
    signers: tx.transaction.message.accountKeys.filter((k) => k.signer).map((k) => k.pubkey.toBase58()),
    sequence: topLevel.map((ix) => ({
      index: ix.index,
      program: ix.program ?? ix.programId,
      typeOrName: ix.type ?? ix.name ?? ix.discriminator,
    })),
    decodedInstructions: topLevel,
    innerInstructions: inner,
    tokenDeltas: tokenChanges,
    nativeDeltas: nativeChanges,
    marginfiBorrowRaw,
    marginfiRepayRaw,
    token2022TransferCheckedWithFeeCount: t22Transfers.length,
    token2022Transfers: t22Transfers,
    withdrawWithheldTokensFromMint: withdrawWithheld,
    collectProtocolFees,
    jitoTipPresent: tips.length > 0,
    jitoTips: tips,
  };
}

async function fetchSurroundingSignatures(connection: Connection, referenceSlot: number): Promise<string[]> {
  const minSlot = referenceSlot - 5000;
  const maxSlot = referenceSlot + 5000;
  let before: string | undefined;
  const matches: string[] = [];

  for (let page = 0; page < 12; page++) {
    const sigs = await connection.getSignaturesForAddress(STACC_WALLET, { limit: 1000, before });
    if (sigs.length === 0) break;
    for (const s of sigs) {
      if (s.slot >= minSlot && s.slot <= maxSlot && s.signature !== REFERENCE_SIG) {
        matches.push(s.signature);
      }
    }
    const oldest = sigs[sigs.length - 1];
    before = oldest.signature;
    if (oldest.slot < minSlot) break;
  }

  return matches.slice(0, 20);
}

async function findTokenBadgeCreator(connection: Connection, tokenBadge: PublicKey): Promise<Record<string, unknown> | null> {
  const sigs = await connection.getSignaturesForAddress(tokenBadge, { limit: 100 });
  for (const s of sigs.slice().reverse()) {
    const txSummary = await summarizeTx(connection, s.signature);
    const decoded = [
      ...((txSummary.decodedInstructions as Record<string, unknown>[]) ?? []),
      ...((txSummary.innerInstructions as Record<string, unknown>[]) ?? []),
    ];
    const hasInit = decoded.some((ix) => ix.name === "orca.initialize_token_badge");
    if (hasInit) {
      return {
        signature: s.signature,
        slot: s.slot,
        blockTime: s.blockTime,
        signerKeys: txSummary.signers,
        err: txSummary.err,
        initializeTokenBadgeInstructions: decoded.filter((ix) => ix.name === "orca.initialize_token_badge"),
      };
    }
  }
  return sigs[0] ? { noInitializeTokenBadgeFound: true, firstSeenSignature: sigs[sigs.length - 1], recentSignature: sigs[0] } : null;
}

function bundleRate(txs: Record<string, unknown>[]): Record<string, unknown> {
  const buckets = new Map<number, number>();
  for (const tx of txs) {
    if (typeof tx.blockTime !== "number") continue;
    const minute = Math.floor(tx.blockTime / 60) * 60;
    buckets.set(minute, (buckets.get(minute) ?? 0) + 1);
  }
  const counts = [...buckets.entries()].sort(([a], [b]) => a - b).map(([minute, count]) => ({
    minuteUnix: minute,
    isoMinute: new Date(minute * 1000).toISOString(),
    count,
  }));
  const total = counts.reduce((sum, x) => sum + x.count, 0);
  return {
    buckets: counts,
    maxPerMinute: counts.reduce((m, x) => Math.max(m, x.count), 0),
    averagePerActiveMinute: counts.length ? total / counts.length : 0,
  };
}

async function accountSnapshot(connection: Connection, pubkey: PublicKey, decoder?: (data: Buffer) => Record<string, unknown>) {
  const info = await connection.getAccountInfo(pubkey, "confirmed");
  if (!info) return { address: pubkey.toBase58(), exists: false };
  return {
    address: pubkey.toBase58(),
    exists: true,
    owner: info.owner.toBase58(),
    lamports: info.lamports,
    executable: info.executable,
    dataLength: info.data.length,
    decoded: decoder ? decoder(Buffer.from(info.data)) : { rawHex: Buffer.from(info.data).toString("hex") },
  };
}

async function main() {
  const rpcUrl = process.env.SOLANA_RPC_URL || process.env.RPC_URL || DEFAULT_RPC;
  const connection = new Connection(rpcUrl, "confirmed");

  const reference = await summarizeTx(connection, REFERENCE_SIG);
  if (typeof reference.slot !== "number") throw new Error("Reference transaction missing slot");

  const surroundingSignatures = await fetchSurroundingSignatures(connection, reference.slot);
  const surrounding = [];
  for (const sig of surroundingSignatures) {
    surrounding.push(await summarizeTx(connection, sig));
  }

  const bzkPoolAccount = await accountSnapshot(connection, STACC_BZK_POOL, decodeWhirlpool);
  const bzkPoolDecoded = bzkPoolAccount.decoded as Record<string, unknown> | undefined;
  const observedBzkConfig = typeof bzkPoolDecoded?.whirlpoolsConfig === "string"
    ? new PublicKey(bzkPoolDecoded.whirlpoolsConfig)
    : STACC_CONFIG_FALLBACK;
  const tokenBadge = deriveTokenBadge(observedBzkConfig, BZK_MINT);
  const configExtension = deriveConfigExtension(observedBzkConfig);
  const tokenBadgeCreator = await findTokenBadgeCreator(connection, tokenBadge);

  const allTxs = [reference, ...surrounding];
  const receipt = {
    verdict: "READ_ONLY_STACC_AUTOPSY",
    generatedAt: new Date().toISOString(),
    rpcUrlRedacted: redactedRpc(rpcUrl),
    referenceSignature: REFERENCE_SIG,
    referenceSlot: reference.slot,
    slotWindow: {
      min: Number(reference.slot) - 5000,
      max: Number(reference.slot) + 5000,
      surroundingFetched: surrounding.length,
    },
    staccWallet: STACC_WALLET.toBase58(),
    reference,
    surrounding,
    aggregate: {
      txCount: allTxs.length,
      successfulTxCount: allTxs.filter((tx) => tx.err === null).length,
      jitoTipTxCount: allTxs.filter((tx) => tx.jitoTipPresent === true).length,
      collectProtocolFeesTxCount: allTxs.filter((tx) => Array.isArray(tx.collectProtocolFees) && tx.collectProtocolFees.length > 0).length,
      bundleRate: bundleRate(allTxs),
    },
    bzkTokenBadgeProbe: {
      config: observedBzkConfig.toBase58(),
      configExtension: configExtension.toBase58(),
      mint: BZK_MINT.toBase58(),
      bzkMintAccount: await accountSnapshot(connection, BZK_MINT),
      hopMintAccount: await accountSnapshot(connection, HOP_MINT),
      observedBzkPool: bzkPoolAccount,
      derivedTokenBadge: tokenBadge.toBase58(),
      configAccount: await accountSnapshot(connection, observedBzkConfig, decodeConfig),
      configExtensionAccount: await accountSnapshot(connection, configExtension, decodeConfigExtension),
      tokenBadgeAccount: await accountSnapshot(connection, tokenBadge, decodeTokenBadge),
      tokenBadgeCreator,
    },
    notes: [
      "RPC cannot prove private Jito submission by itself; jitoTipPresent means the transaction paid a known Jito tip account.",
      "TokenBadge layout decoded as Anchor discriminator + whirlpools_config + token_mint + trailing byte when data length is 73.",
      "A positive custom-token delta is not treated as cash-settled USDC/SOL revenue.",
    ],
  };

  writeReceipt("STACC-AUTOPSY-LATEST.json", receipt);
  console.log(`reference slot=${reference.slot} surrounding=${surrounding.length}`);
  console.log(`jitoTipTxCount=${receipt.aggregate.jitoTipTxCount}`);
  console.log(`collectProtocolFeesTxCount=${receipt.aggregate.collectProtocolFeesTxCount}`);
  console.log(`tokenBadge=${tokenBadge.toBase58()} exists=${receipt.bzkTokenBadgeProbe.tokenBadgeAccount.exists}`);
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
