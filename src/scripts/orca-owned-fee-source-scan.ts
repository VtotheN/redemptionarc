/**
 * Read-only Orca owned-fee source scanner.
 *
 * Finds Whirlpool configs controlled by local/partner authorities, scans pools
 * under those configs, and classifies claimable protocol fees by whether they
 * are already spendable cash assets (USDC/wSOL) or non-cash inventory.
 */
import "dotenv/config";
import dotenv from "dotenv";
import fs from "node:fs";
import path from "node:path";
import { AccountInfo, Connection, PublicKey } from "@solana/web3.js";
import { TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID } from "@solana/spl-token";
import { loadConfig } from "../config.js";
import { USDC_MINT_DEFAULT } from "../constants.js";
import { publicKeyFromKeypairFile } from "../utils/keypair.js";
import { writeReceipt } from "../utils/receipt.js";

if (process.env.ENV_PATH) {
  dotenv.config({ path: process.env.ENV_PATH, override: true });
}

const OFFICIAL_ORCA = new PublicKey("whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc");
const FORK_ORCA = new PublicKey("GxRHMB9a6XE8BqGPeNb9UkJUPvbvrPoPgNTJPJJA4n8h");
const USDC_MINT = new PublicKey(USDC_MINT_DEFAULT);
const WSOL_MINT = new PublicKey("So11111111111111111111111111111111111111112");
const CRANK = new PublicKey("8pWEfpJas2tgS8iE7ZyHKNjeDSEixqSwK12W4tagNJ3S");
const STACC_WZMA = new PublicKey("WzMaL78srutrF6CsxEkWuhMaDF5HZA6jNRaEPengqpb");

const KNOWN_CONFIGS: Array<{ program: PublicKey; label: string; config: PublicKey; source: string }> = [
  {
    program: OFFICIAL_ORCA,
    label: "official-orca",
    config: new PublicKey("KPX9QQP4GLWiRkh4pGpkagwoPGaGixarRQs1LQKb9dt"),
    source: "gifted-kpx9",
  },
  {
    program: OFFICIAL_ORCA,
    label: "official-orca",
    config: new PublicKey("D8WBXfePEmWoK27pRoCKvzfsjZrWZJVmGN9tZguvnKBB"),
    source: "stacc-screenshot-d8wb",
  },
  {
    program: OFFICIAL_ORCA,
    label: "official-orca",
    config: new PublicKey("12yTE48QR6bGK4EMcyY8XsARbX1TRTEbwHYSuuxR1Hp8"),
    source: "stacc-autopsy-bzk",
  },
  {
    program: FORK_ORCA,
    label: "redemption-fork",
    config: new PublicKey("9Nr7o1muxPfcsxv4WtTN2GdUFKhUsdR7WHejyJdesTmZ"),
    source: "redemption-fork-config",
  },
];

const SCREENSHOT_AUTHORITIES = [
  "71hN8QaTfNoDTRTQGULCzbUT3PHwPDTu5Brcu4iT2paP",
  "PoNA1qzqHWar3g8Hy9cxA2Ubi3hV7q84dtXAxD77CSD",
  "Gf3sbc5Jb62jH7WcTr3WSNGDQLk1w6wcKMZXk1SC1E6",
  "89VB5UmvopuCFmp5Mf8YPX28fGvvqn79afCgoUQuPyhY",
  "BuFT4LG7Qxn9iJfNHoWscwHYQetTTq6PABauKffehnkh",
  "2jGGDaSpPKyatSXmmgDj5M9PHWmQ5TuSjxGr13cuHh27",
  "E5kD72fg28dcyNmxJNUzEJeDqccQnGWEtYH8aQUUNhXP",
];

type ProgramSpec = {
  program: PublicKey;
  label: string;
};

type ConfigDecoded = {
  feeAuthority: string | null;
  collectProtocolFeesAuthority: string | null;
  rewardEmissionsSuperAuthority: string | null;
  defaultProtocolFeeRate: number | null;
};

type MintMeta = {
  mint: string;
  exists: boolean;
  ownerProgram: string | null;
  decimals: number | null;
  symbol: "USDC" | "wSOL" | "UNKNOWN";
  cashClass: "usdc" | "sol" | "non_cash";
};

type PoolDecoded = {
  whirlpoolsConfig: string;
  whirlpoolBump: number | null;
  tickSpacing: number | null;
  feeRate: number | null;
  protocolFeeRate: number | null;
  liquidity: string | null;
  sqrtPrice: string | null;
  tickCurrentIndex: number | null;
  protocolFeeOwedA: string | null;
  protocolFeeOwedB: string | null;
  tokenMintA: string | null;
  tokenVaultA: string | null;
  tokenMintB: string | null;
  tokenVaultB: string | null;
};

function envCsv(name: string): string[] {
  return (process.env[name] || "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
}

function boolEnv(name: string, fallback: boolean): boolean {
  const raw = process.env[name];
  if (!raw) return fallback;
  return ["1", "true", "yes", "y"].includes(raw.toLowerCase());
}

function numberEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) throw new Error(`Invalid ${name}=${raw}`);
  return parsed;
}

function tryPublicKey(value: string): PublicKey | null {
  try {
    return new PublicKey(value);
  } catch {
    return null;
  }
}

function dedupePubkeys(values: PublicKey[]): PublicKey[] {
  const seen = new Set<string>();
  const out: PublicKey[] = [];
  for (const value of values) {
    const key = value.toBase58();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(value);
  }
  return out;
}

function readU16(data: Buffer, offset: number): number | null {
  return data.length >= offset + 2 ? data.readUInt16LE(offset) : null;
}

function readI32(data: Buffer, offset: number): number | null {
  return data.length >= offset + 4 ? data.readInt32LE(offset) : null;
}

function readU64(data: Buffer, offset: number): string | null {
  return data.length >= offset + 8 ? data.readBigUInt64LE(offset).toString() : null;
}

function readU128(data: Buffer, offset: number): string | null {
  if (data.length < offset + 16) return null;
  const lo = data.readBigUInt64LE(offset);
  const hi = data.readBigUInt64LE(offset + 8);
  return (lo | (hi << 64n)).toString();
}

function readPubkey(data: Buffer, offset: number): string | null {
  return data.length >= offset + 32 ? new PublicKey(data.subarray(offset, offset + 32)).toBase58() : null;
}

function decodeConfig(data: Buffer): ConfigDecoded {
  return {
    feeAuthority: readPubkey(data, 8),
    collectProtocolFeesAuthority: readPubkey(data, 40),
    rewardEmissionsSuperAuthority: readPubkey(data, 72),
    defaultProtocolFeeRate: readU16(data, 104),
  };
}

function decodeWhirlpool(data: Buffer): PoolDecoded {
  return {
    whirlpoolsConfig: readPubkey(data, 8) ?? "",
    whirlpoolBump: data.length >= 41 ? data[40] : null,
    tickSpacing: readU16(data, 41),
    feeRate: readU16(data, 45),
    protocolFeeRate: readU16(data, 47),
    liquidity: readU128(data, 49),
    sqrtPrice: readU128(data, 65),
    tickCurrentIndex: readI32(data, 81),
    protocolFeeOwedA: readU64(data, 85),
    protocolFeeOwedB: readU64(data, 93),
    tokenMintA: readPubkey(data, 101),
    tokenVaultA: readPubkey(data, 133),
    tokenMintB: readPubkey(data, 181),
    tokenVaultB: readPubkey(data, 213),
  };
}

function parseTokenAccountAmount(info: AccountInfo<Buffer> | null): string | null {
  if (!info || info.data.length < 72) return null;
  return info.data.readBigUInt64LE(64).toString();
}

function decodeMint(mint: string, info: AccountInfo<Buffer> | null): MintMeta {
  const symbol = mint === USDC_MINT.toBase58() ? "USDC" : mint === WSOL_MINT.toBase58() ? "wSOL" : "UNKNOWN";
  const cashClass = symbol === "USDC" ? "usdc" : symbol === "wSOL" ? "sol" : "non_cash";
  return {
    mint,
    exists: Boolean(info),
    ownerProgram: info?.owner.toBase58() ?? null,
    decimals: info && info.data.length >= 45 ? info.data[44] : null,
    symbol,
    cashClass,
  };
}

function uiAmount(raw: string | null, decimals: number | null): number | null {
  if (raw == null || decimals == null) return null;
  return Number(BigInt(raw)) / 10 ** decimals;
}

function cashUsd(raw: string | null, meta: MintMeta | undefined, solPriceUsd: number | null): number | null {
  if (!raw || !meta || meta.decimals == null) return null;
  const ui = uiAmount(raw, meta.decimals);
  if (ui == null) return null;
  if (meta.cashClass === "usdc") return ui;
  if (meta.cashClass === "sol" && solPriceUsd != null) return ui * solPriceUsd;
  return null;
}

async function jupiterSolUsdc(): Promise<number | null> {
  try {
    const url = "https://lite-api.jup.ag/swap/v1/quote?inputMint=So11111111111111111111111111111111111111112&outputMint=EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v&amount=1000000000&slippageBps=10";
    const response = await fetch(url, { headers: { accept: "application/json" } });
    if (!response.ok) return null;
    const json = await response.json() as { outAmount?: string };
    return json.outAmount ? Number(json.outAmount) / 1e6 : null;
  } catch {
    return null;
  }
}

function keypairPubkeys(paths: string[]) {
  const out: Array<{ path: string; pubkey: string }> = [];
  for (const keypairPath of paths) {
    if (!fs.existsSync(keypairPath)) continue;
    try {
      out.push({ path: keypairPath, pubkey: publicKeyFromKeypairFile(keypairPath).toBase58() });
    } catch {
      // Ignore malformed/non-keypair JSON without printing file contents.
    }
  }
  return out;
}

function controlStatus(authority: string | null, localSigners: Set<string>): string {
  if (!authority) return "unknown";
  if (localSigners.has(authority)) return "local_signer";
  if (authority === CRANK.toBase58()) return "configured_crank_no_local_key_loaded";
  if (authority === STACC_WZMA.toBase58()) return "stacc_partner_observed_not_local";
  if (SCREENSHOT_AUTHORITIES.includes(authority)) return "screenshot_authority_unverified";
  return "unverified_authority";
}

async function getConfigInfo(connection: Connection, program: PublicKey, config: PublicKey) {
  const account = await connection.getAccountInfo(config, "confirmed");
  if (!account) {
    return { exists: false, owner: null, decoded: null as ConfigDecoded | null };
  }
  return {
    exists: true,
    owner: account.owner.toBase58(),
    dataLength: account.data.length,
    ownerMatchesProgram: account.owner.equals(program),
    decoded: decodeConfig(Buffer.from(account.data)),
  };
}

async function discoverConfigsByAuthority(
  connection: Connection,
  programs: ProgramSpec[],
  authorities: PublicKey[],
  warnings: string[],
) {
  const out: Array<{ program: PublicKey; label: string; config: PublicKey; source: string }> = [];
  for (const spec of programs) {
    for (const authority of authorities) {
      try {
        const accounts = await connection.getProgramAccounts(spec.program, {
          commitment: "confirmed",
          filters: [
            { dataSize: 108 },
            { memcmp: { offset: 40, bytes: authority.toBase58() } },
          ],
        });
        for (const account of accounts) {
          out.push({
            program: spec.program,
            label: spec.label,
            config: account.pubkey,
            source: `collect-authority:${authority.toBase58()}`,
          });
        }
      } catch (error) {
        warnings.push(`config authority scan failed program=${spec.label} authority=${authority.toBase58()} error=${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }
  return out;
}

async function scanPoolsForConfig(connection: Connection, program: PublicKey, config: PublicKey, warnings: string[]) {
  try {
    return await connection.getProgramAccounts(program, {
      commitment: "confirmed",
      filters: [
        { dataSize: 653 },
        { memcmp: { offset: 8, bytes: config.toBase58() } },
      ],
    });
  } catch (error) {
    warnings.push(`pool scan failed program=${program.toBase58()} config=${config.toBase58()} error=${error instanceof Error ? error.message : String(error)}`);
    return [];
  }
}

async function getMany(connection: Connection, pubkeys: PublicKey[]) {
  const out = new Map<string, AccountInfo<Buffer> | null>();
  for (let i = 0; i < pubkeys.length; i += 100) {
    const chunk = pubkeys.slice(i, i + 100);
    const infos = await connection.getMultipleAccountsInfo(chunk, "confirmed");
    infos.forEach((info, idx) => out.set(chunk[idx].toBase58(), info));
  }
  return out;
}

async function main() {
  const config = loadConfig();
  const connection = new Connection(config.rpcUrl, "confirmed");
  const warnings: string[] = [];
  const includeScreenshotAuthorities = boolEnv("INCLUDE_STACC_SCREENSHOT_AUTHORITIES", true);
  const maxConfigs = numberEnv("OWNED_FEE_MAX_CONFIGS", 0);
  const solPriceUsd = config.solPriceUsd ?? await jupiterSolUsdc();

  const programs: ProgramSpec[] = [
    { program: OFFICIAL_ORCA, label: "official-orca" },
    { program: FORK_ORCA, label: "redemption-fork" },
  ];

  const extraConfigSpecs = envCsv("OWNED_FEE_CONFIGS").flatMap((entry) => {
    const [programRaw, configRaw] = entry.includes(":") ? entry.split(":") : [OFFICIAL_ORCA.toBase58(), entry];
    const program = tryPublicKey(programRaw);
    const configPk = tryPublicKey(configRaw);
    if (!program || !configPk) return [];
    return [{
      program,
      label: program.equals(FORK_ORCA) ? "redemption-fork" : program.equals(OFFICIAL_ORCA) ? "official-orca" : "custom-program",
      config: configPk,
      source: "env:OWNED_FEE_CONFIGS",
    }];
  });

  const authorityCandidates = [
    CRANK,
    STACC_WZMA,
    ...envCsv("OWNED_FEE_AUTHORITIES").flatMap((value) => tryPublicKey(value) ?? []),
    ...(includeScreenshotAuthorities ? SCREENSHOT_AUTHORITIES.flatMap((value) => tryPublicKey(value) ?? []) : []),
  ];
  const authorities = dedupePubkeys(authorityCandidates);

  const signerPaths = [
    "keys/crank.json",
    "keys/kpx9-authority.json",
    "keys/orca-config.json",
    ...envCsv("OWNED_FEE_KEYPAIR_PATHS"),
  ].map((value) => path.resolve(value));
  const localSignerList = keypairPubkeys(signerPaths);
  const localSigners = new Set(localSignerList.map((entry) => entry.pubkey));

  const discoveredConfigs = await discoverConfigsByAuthority(connection, programs, authorities, warnings);
  const mergedConfigMap = new Map<string, { program: PublicKey; label: string; config: PublicKey; source: string }>();
  for (const item of [...KNOWN_CONFIGS, ...extraConfigSpecs, ...discoveredConfigs]) {
    const key = `${item.program.toBase58()}:${item.config.toBase58()}`;
    if (!mergedConfigMap.has(key)) mergedConfigMap.set(key, item);
  }
  const allConfigSpecs = [...mergedConfigMap.values()].slice(0, maxConfigs > 0 ? maxConfigs : undefined);

  const configRows = [];
  const poolRowsRaw = [];
  for (const item of allConfigSpecs) {
    const configInfo = await getConfigInfo(connection, item.program, item.config);
    const decoded = configInfo.decoded;
    const status = controlStatus(decoded?.collectProtocolFeesAuthority ?? null, localSigners);
    const poolAccounts = configInfo.exists && configInfo.ownerMatchesProgram !== false
      ? await scanPoolsForConfig(connection, item.program, item.config, warnings)
      : [];

    configRows.push({
      program: item.program.toBase58(),
      programLabel: item.label,
      config: item.config.toBase58(),
      source: item.source,
      exists: configInfo.exists,
      owner: configInfo.owner,
      dataLength: configInfo.dataLength ?? null,
      ownerMatchesProgram: configInfo.ownerMatchesProgram ?? false,
      decoded,
      controlStatus: status,
      poolCount: poolAccounts.length,
    });

    for (const account of poolAccounts) {
      const decodedPool = decodeWhirlpool(Buffer.from(account.account.data));
      poolRowsRaw.push({
        program: item.program,
        programLabel: item.label,
        whirlpool: account.pubkey,
        config: item.config,
        configSource: item.source,
        collectProtocolFeesAuthority: decoded?.collectProtocolFeesAuthority ?? null,
        controlStatus: status,
        decoded: decodedPool,
      });
    }
  }

  const mintPubkeys = dedupePubkeys(poolRowsRaw.flatMap((pool) =>
    [pool.decoded.tokenMintA, pool.decoded.tokenMintB].flatMap((value) => value ? [new PublicKey(value)] : [])
  ));
  const vaultPubkeys = dedupePubkeys(poolRowsRaw.flatMap((pool) =>
    [pool.decoded.tokenVaultA, pool.decoded.tokenVaultB].flatMap((value) => value ? [new PublicKey(value)] : [])
  ));
  const [mintInfos, vaultInfos] = await Promise.all([
    getMany(connection, mintPubkeys),
    getMany(connection, vaultPubkeys),
  ]);
  const mintMetas = new Map<string, MintMeta>();
  for (const mint of mintPubkeys) {
    mintMetas.set(mint.toBase58(), decodeMint(mint.toBase58(), mintInfos.get(mint.toBase58()) ?? null));
  }

  const pools = poolRowsRaw.map((pool) => {
    const d = pool.decoded;
    const metaA = d.tokenMintA ? mintMetas.get(d.tokenMintA) : undefined;
    const metaB = d.tokenMintB ? mintMetas.get(d.tokenMintB) : undefined;
    const vaultAmountA = parseTokenAccountAmount(d.tokenVaultA ? vaultInfos.get(d.tokenVaultA) ?? null : null);
    const vaultAmountB = parseTokenAccountAmount(d.tokenVaultB ? vaultInfos.get(d.tokenVaultB) ?? null : null);
    const protocolFeeOwedAUi = uiAmount(d.protocolFeeOwedA, metaA?.decimals ?? null);
    const protocolFeeOwedBUi = uiAmount(d.protocolFeeOwedB, metaB?.decimals ?? null);
    const protocolFeeOwedAUsd = cashUsd(d.protocolFeeOwedA, metaA, solPriceUsd);
    const protocolFeeOwedBUsd = cashUsd(d.protocolFeeOwedB, metaB, solPriceUsd);
    const vaultAUsd = cashUsd(vaultAmountA, metaA, solPriceUsd);
    const vaultBUsd = cashUsd(vaultAmountB, metaB, solPriceUsd);
    const cashClaimableUsd = (protocolFeeOwedAUsd ?? 0) + (protocolFeeOwedBUsd ?? 0);
    const cashTvlUsd = (vaultAUsd ?? 0) + (vaultBUsd ?? 0);
    const hasUnknownClaimable =
      (BigInt(d.protocolFeeOwedA ?? "0") > 0n && protocolFeeOwedAUsd == null) ||
      (BigInt(d.protocolFeeOwedB ?? "0") > 0n && protocolFeeOwedBUsd == null);
    const active = BigInt(d.liquidity ?? "0") > 0n || BigInt(vaultAmountA ?? "0") > 0n || BigInt(vaultAmountB ?? "0") > 0n;

    return {
      program: pool.program.toBase58(),
      programLabel: pool.programLabel,
      whirlpool: pool.whirlpool.toBase58(),
      config: pool.config.toBase58(),
      configSource: pool.configSource,
      collectProtocolFeesAuthority: pool.collectProtocolFeesAuthority,
      controlStatus: pool.controlStatus,
      directLocalCollect: pool.controlStatus === "local_signer",
      tickSpacing: d.tickSpacing,
      feeRate: d.feeRate,
      feeRatePercent: d.feeRate == null ? null : d.feeRate / 10_000,
      protocolFeeRate: d.protocolFeeRate,
      protocolFeeRatePercentOfSwapFee: d.protocolFeeRate == null ? null : d.protocolFeeRate / 100,
      liquidity: d.liquidity,
      sqrtPrice: d.sqrtPrice,
      tickCurrentIndex: d.tickCurrentIndex,
      active,
      tokenA: {
        mint: d.tokenMintA,
        vault: d.tokenVaultA,
        mintMeta: metaA ?? null,
        vaultRaw: vaultAmountA,
        vaultUi: uiAmount(vaultAmountA, metaA?.decimals ?? null),
        vaultCashUsd: vaultAUsd,
        protocolFeeOwedRaw: d.protocolFeeOwedA,
        protocolFeeOwedUi: protocolFeeOwedAUi,
        protocolFeeOwedCashUsd: protocolFeeOwedAUsd,
      },
      tokenB: {
        mint: d.tokenMintB,
        vault: d.tokenVaultB,
        mintMeta: metaB ?? null,
        vaultRaw: vaultAmountB,
        vaultUi: uiAmount(vaultAmountB, metaB?.decimals ?? null),
        vaultCashUsd: vaultBUsd,
        protocolFeeOwedRaw: d.protocolFeeOwedB,
        protocolFeeOwedUi: protocolFeeOwedBUi,
        protocolFeeOwedCashUsd: protocolFeeOwedBUsd,
      },
      cashClaimableUsd,
      cashTvlUsd,
      hasClaimableProtocolFees: BigInt(d.protocolFeeOwedA ?? "0") > 0n || BigInt(d.protocolFeeOwedB ?? "0") > 0n,
      hasUnknownClaimable,
      executionClass: pool.controlStatus === "local_signer" && cashClaimableUsd > 0
        ? "DIRECT_COLLECTABLE_CASH"
        : pool.controlStatus === "local_signer" && hasUnknownClaimable
          ? "DIRECT_COLLECTABLE_NONCASH_OR_UNPRICED"
          : pool.controlStatus !== "local_signer" && cashClaimableUsd > 0
            ? "PARTNER_OR_UNVERIFIED_CLAIMABLE_CASH"
            : active
              ? "ACTIVE_FEE_SOURCE"
              : "INACTIVE_OR_EMPTY",
    };
  });

  const summary = {
    configCount: configRows.length,
    poolCount: pools.length,
    activePoolCount: pools.filter((pool) => pool.active).length,
    claimableProtocolFeePoolCount: pools.filter((pool) => pool.hasClaimableProtocolFees).length,
    directLocalCollectableCashPoolCount: pools.filter((pool) => pool.executionClass === "DIRECT_COLLECTABLE_CASH").length,
    directLocalCollectableCashUsd: pools
      .filter((pool) => pool.executionClass === "DIRECT_COLLECTABLE_CASH")
      .reduce((sum, pool) => sum + pool.cashClaimableUsd, 0),
    partnerOrUnverifiedClaimableCashUsd: pools
      .filter((pool) => pool.executionClass === "PARTNER_OR_UNVERIFIED_CLAIMABLE_CASH")
      .reduce((sum, pool) => sum + pool.cashClaimableUsd, 0),
    topCashClaimablePools: pools
      .filter((pool) => pool.cashClaimableUsd > 0)
      .sort((a, b) => b.cashClaimableUsd - a.cashClaimableUsd)
      .slice(0, 20)
      .map((pool) => ({
        whirlpool: pool.whirlpool,
        programLabel: pool.programLabel,
        config: pool.config,
        controlStatus: pool.controlStatus,
        executionClass: pool.executionClass,
        cashClaimableUsd: pool.cashClaimableUsd,
        tokenA: pool.tokenA.mintMeta?.symbol,
        tokenAFeesUi: pool.tokenA.protocolFeeOwedUi,
        tokenB: pool.tokenB.mintMeta?.symbol,
        tokenBFeesUi: pool.tokenB.protocolFeeOwedUi,
      })),
    topActiveFeeSources: pools
      .filter((pool) => pool.active)
      .sort((a, b) => (b.cashTvlUsd || 0) - (a.cashTvlUsd || 0))
      .slice(0, 20)
      .map((pool) => ({
        whirlpool: pool.whirlpool,
        programLabel: pool.programLabel,
        config: pool.config,
        controlStatus: pool.controlStatus,
        feeRate: pool.feeRate,
        protocolFeeRate: pool.protocolFeeRate,
        cashTvlUsd: pool.cashTvlUsd,
        tokenA: pool.tokenA.mint,
        tokenB: pool.tokenB.mint,
      })),
  };

  const receipt = {
    verdict: "ORCA_OWNED_FEE_SOURCE_SCAN_READ_ONLY",
    generatedAt: new Date().toISOString(),
    rpcUrlRedacted: config.rpcUrl.replace(/api-key=([^&]+)/, "api-key=<redacted>"),
    noSend: true,
    solPriceUsd,
    programs: programs.map((program) => ({ label: program.label, program: program.program.toBase58() })),
    authoritiesScanned: authorities.map((authority) => ({
      authority: authority.toBase58(),
      localSigner: localSigners.has(authority.toBase58()),
      status: controlStatus(authority.toBase58(), localSigners),
    })),
    localSignerPubkeys: localSignerList.map((entry) => ({ label: path.basename(entry.path), pubkey: entry.pubkey })),
    configs: configRows,
    pools,
    summary,
    warnings,
    notes: [
      "Only USDC and wSOL are counted as cash-settled value. Other mints remain non-cash until a bounded settlement route is proven.",
      "screenshot_authority_unverified means the address came from Stxxx screenshots; local signing authority is not proven.",
      "ACTIVE_FEE_SOURCE means a pool could earn fees from future orderflow; it is not current wallet profit.",
    ],
  };

  const out = writeReceipt("ORCA-OWNED-FEE-SOURCE-SCAN-LATEST.json", receipt);
  console.log(`${receipt.verdict} configs=${summary.configCount} pools=${summary.poolCount} active=${summary.activePoolCount} claimable=${summary.claimableProtocolFeePoolCount} directCashUsd=${summary.directLocalCollectableCashUsd.toFixed(6)} receipt=${out}`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
