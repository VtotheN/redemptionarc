import fs from "node:fs";
import { Connection, PublicKey } from "@solana/web3.js";
import { loadConfig } from "../config.js";
import { writeReceipt } from "../utils/receipt.js";
import { assertNoForbiddenConfigured } from "../utils/safety.js";

const OUT_RECEIPT = "CSDM-LIVE-SHAPE-SCAN-LATEST.json";
const DEFAULT_CONFIG_PATH = "/Users/velon/gh-src-vtothen/EXPERIMENTO-lazyloop/csdm/keeper/config.mainnet.existing.json";
const TOKEN_PROGRAM_ID = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";

type AccountSummary = {
  address: string;
  exists: boolean;
  executable: boolean;
  ownerProgram: string | null;
  dataLen: number;
  lamports: number;
};

type TokenAccountSummary = AccountSummary & {
  mint: string | null;
  owner: string | null;
  amountRaw: string | null;
};

type MintSummary = AccountSummary & {
  supplyRaw: string | null;
  decimals: number | null;
};

function strEnv(name: string, fallback: string): string {
  const raw = process.env[name];
  return raw == null || raw.trim() === "" ? fallback : raw.trim();
}

function readJson(file: string): Record<string, unknown> {
  return JSON.parse(fs.readFileSync(file, "utf8")) as Record<string, unknown>;
}

function strField(raw: Record<string, unknown>, name: string): string {
  const value = raw[name];
  if (typeof value !== "string" || value.length === 0) throw new Error(`Missing string ${name}`);
  return value;
}

function optionalStr(raw: Record<string, unknown>, name: string): string | null {
  const value = raw[name];
  return typeof value === "string" && value.length > 0 ? value : null;
}

function pubkey(raw: Record<string, unknown>, name: string): PublicKey {
  return new PublicKey(strField(raw, name));
}

function accountSummary(address: PublicKey, account: Awaited<ReturnType<Connection["getMultipleAccountsInfo"]>>[number]): AccountSummary {
  return {
    address: address.toBase58(),
    exists: Boolean(account),
    executable: account?.executable ?? false,
    ownerProgram: account?.owner.toBase58() ?? null,
    dataLen: account?.data.length ?? 0,
    lamports: account?.lamports ?? 0
  };
}

function readU64(data: Buffer, offset: number): string | null {
  if (data.length < offset + 8) return null;
  return data.readBigUInt64LE(offset).toString();
}

function tokenAccountSummary(address: PublicKey, account: Awaited<ReturnType<Connection["getMultipleAccountsInfo"]>>[number]): TokenAccountSummary {
  const base = accountSummary(address, account);
  if (!account || account.data.length < 72) {
    return { ...base, mint: null, owner: null, amountRaw: null };
  }
  return {
    ...base,
    mint: new PublicKey(account.data.subarray(0, 32)).toBase58(),
    owner: new PublicKey(account.data.subarray(32, 64)).toBase58(),
    amountRaw: readU64(account.data, 64)
  };
}

function mintSummary(address: PublicKey, account: Awaited<ReturnType<Connection["getMultipleAccountsInfo"]>>[number]): MintSummary {
  const base = accountSummary(address, account);
  if (!account || account.data.length < 45) {
    return { ...base, supplyRaw: null, decimals: null };
  }
  return {
    ...base,
    supplyRaw: readU64(account.data, 36),
    decimals: account.data[44]
  };
}

function parsePoolState(address: PublicKey, account: Awaited<ReturnType<Connection["getMultipleAccountsInfo"]>>[number]) {
  const base = accountSummary(address, account);
  if (!account || account.data.length < 72) {
    return {
      ...base,
      poolBump: null,
      csdmMintBump: null,
      poolAccountBump: null,
      poolCsdmBump: null,
      poolMint: null,
      csdmMint: null
    };
  }
  return {
    ...base,
    poolBump: account.data[0],
    csdmMintBump: account.data[1],
    poolAccountBump: account.data[2],
    poolCsdmBump: account.data[3],
    poolMint: new PublicKey(account.data.subarray(8, 40)).toBase58(),
    csdmMint: new PublicKey(account.data.subarray(40, 72)).toBase58()
  };
}

function parseAssetConfig(address: PublicKey, account: Awaited<ReturnType<Connection["getMultipleAccountsInfo"]>>[number]) {
  const base = accountSummary(address, account);
  if (!account || account.data.length < 232) {
    return {
      ...base,
      bump: null,
      paused: null,
      backingDecimals: null,
      repayDecimals: null,
      poolMint: null,
      repayMint: null,
      backingOracle: null,
      repayOracle: null,
      allowedBorrower: null,
      maxAmountRaw: null,
      maxDeadlineSlots: null,
      minProfitMicros: null,
      authority: null
    };
  }
  return {
    ...base,
    bump: account.data[0],
    paused: account.data[1],
    backingDecimals: account.data[2],
    repayDecimals: account.data[3],
    poolMint: new PublicKey(account.data.subarray(8, 40)).toBase58(),
    repayMint: new PublicKey(account.data.subarray(40, 72)).toBase58(),
    backingOracle: new PublicKey(account.data.subarray(72, 104)).toBase58(),
    repayOracle: new PublicKey(account.data.subarray(104, 136)).toBase58(),
    allowedBorrower: new PublicKey(account.data.subarray(136, 168)).toBase58(),
    maxAmountRaw: readU64(account.data, 168),
    maxDeadlineSlots: readU64(account.data, 176),
    minProfitMicros: readU64(account.data, 184),
    authority: new PublicKey(account.data.subarray(200, 232)).toBase58()
  };
}

function deriveCsdmPdas(programId: PublicKey, poolMint: PublicKey, repayMint: PublicKey) {
  const [poolStatePda, poolStateBump] = PublicKey.findProgramAddressSync(
    [Buffer.from("csdm_pool"), poolMint.toBuffer()],
    programId
  );
  const [poolAccountPda, poolAccountBump] = PublicKey.findProgramAddressSync(
    [Buffer.from("pool_account"), poolMint.toBuffer()],
    programId
  );
  const [csdmMintPda, csdmMintBump] = PublicKey.findProgramAddressSync(
    [Buffer.from("csdm_mint"), poolMint.toBuffer()],
    programId
  );
  const [poolCsdmAccountPda, poolCsdmAccountBump] = PublicKey.findProgramAddressSync(
    [Buffer.from("pool_csdm"), poolMint.toBuffer()],
    programId
  );
  const [assetConfigPda, assetConfigBump] = PublicKey.findProgramAddressSync(
    [Buffer.from("asset_config"), poolMint.toBuffer(), repayMint.toBuffer()],
    programId
  );
  return {
    poolStatePda,
    poolStateBump,
    poolAccountPda,
    poolAccountBump,
    csdmMintPda,
    csdmMintBump,
    poolCsdmAccountPda,
    poolCsdmAccountBump,
    assetConfigPda,
    assetConfigBump
  };
}

async function main(): Promise<void> {
  const config = loadConfig();
  assertNoForbiddenConfigured(config);

  const configPath = strEnv("CSDM_MAINNET_CONFIG_PATH", DEFAULT_CONFIG_PATH);
  const raw = readJson(configPath);
  const csdmProgramId = pubkey(raw, "csdmProgramId");
  const poolMint = pubkey(raw, "poolMint");
  const repayMint = optionalStr(raw, "repayMint") ? pubkey(raw, "repayMint") : poolMint;
  const pool1ProgramId = pubkey(raw, "pool1ProgramId");
  const expectedBackingOracle = pubkey(raw, "oraCuloxxAccount");
  const expectedAuthority = optionalStr(raw, "backingVault") ?? optionalStr(raw, "abrakSettlement");
  const expected = deriveCsdmPdas(csdmProgramId, poolMint, repayMint);

  const configuredAddresses = {
    csdmPoolStatePda: strField(raw, "csdmPoolStatePda"),
    csdmPoolAccountPda: strField(raw, "csdmPoolAccountPda"),
    csdmMintPda: strField(raw, "csdmMintPda"),
    csdmPoolCsdmAccountPda: strField(raw, "csdmPoolCsdmAccountPda"),
    csdmAssetConfigPda: strField(raw, "csdmAssetConfigPda")
  };

  const addresses = [
    expected.poolStatePda,
    expected.poolAccountPda,
    expected.csdmMintPda,
    expected.poolCsdmAccountPda,
    expected.assetConfigPda,
    poolMint,
    repayMint,
    pool1ProgramId,
    expectedBackingOracle
  ];
  const accounts = await new Connection(config.rpcUrl, "confirmed").getMultipleAccountsInfo(addresses, "confirmed");

  const poolState = parsePoolState(expected.poolStatePda, accounts[0]);
  const poolAccount = tokenAccountSummary(expected.poolAccountPda, accounts[1]);
  const csdmMint = mintSummary(expected.csdmMintPda, accounts[2]);
  const poolCsdmAccount = tokenAccountSummary(expected.poolCsdmAccountPda, accounts[3]);
  const assetConfig = parseAssetConfig(expected.assetConfigPda, accounts[4]);
  const backingMint = mintSummary(poolMint, accounts[5]);
  const repayMintAccount = mintSummary(repayMint, accounts[6]);
  const borrowerProgram = accountSummary(pool1ProgramId, accounts[7]);
  const backingOracle = accountSummary(expectedBackingOracle, accounts[8]);

  const pdaMatches = {
    csdmPoolStatePda: configuredAddresses.csdmPoolStatePda === expected.poolStatePda.toBase58(),
    csdmPoolAccountPda: configuredAddresses.csdmPoolAccountPda === expected.poolAccountPda.toBase58(),
    csdmMintPda: configuredAddresses.csdmMintPda === expected.csdmMintPda.toBase58(),
    csdmPoolCsdmAccountPda: configuredAddresses.csdmPoolCsdmAccountPda === expected.poolCsdmAccountPda.toBase58(),
    csdmAssetConfigPda: configuredAddresses.csdmAssetConfigPda === expected.assetConfigPda.toBase58()
  };

  const shapeRejections = [
    Object.values(pdaMatches).every(Boolean) ? null : "configured CSDM PDAs do not match seed derivation",
    poolState.exists ? null : "CSDM pool state PDA missing",
    poolAccount.exists ? null : "CSDM backing pool token account missing",
    csdmMint.exists ? null : "CSDM receipt mint missing",
    poolCsdmAccount.exists ? null : "CSDM pool receipt token account missing",
    assetConfig.exists ? null : "CSDM asset_config PDA missing",
    poolAccount.mint === poolMint.toBase58() ? null : "pool_account mint does not match poolMint",
    poolAccount.owner === expected.poolStatePda.toBase58() ? null : "pool_account owner is not pool PDA",
    csdmMint.address === poolState.csdmMint ? null : "pool state csdm mint does not match derived mint",
    poolCsdmAccount.mint === csdmMint.address ? null : "pool_csdm_account mint does not match CSDM mint",
    poolCsdmAccount.owner === expected.poolStatePda.toBase58() ? null : "pool_csdm_account owner is not pool PDA",
    assetConfig.paused === 0 ? null : "asset_config is paused or uninitialized",
    assetConfig.allowedBorrower === pool1ProgramId.toBase58() ? null : "asset_config allowedBorrower does not match pool1 program",
    borrowerProgram.exists && borrowerProgram.executable ? null : "allowed borrower program missing or not executable",
    backingOracle.exists ? null : "backing oracle account missing",
    BigInt(poolAccount.amountRaw ?? "0") > 0n ? null : "CSDM backing pool account has zero backing"
  ].filter((value): value is string => value !== null);
  const shapeWarnings = [
    assetConfig.backingOracle === expectedBackingOracle.toBase58()
      ? null
      : "asset_config stores an older oracle; ix7 does not enforce this field, so pass the fresh oracle account explicitly",
    poolCsdmAccount.amountRaw === "0"
      ? "pool_csdm_account is zero before flash, which is expected; borrower must return receipt during ix7"
      : null
  ].filter((value): value is string => value !== null);

  const receipt = {
    verdict: shapeRejections.length === 0
      ? "CSDM_LIVE_SHAPE_READY_NO_LIVE"
      : "CSDM_LIVE_SHAPE_BLOCKED",
    generatedAt: new Date().toISOString(),
    noSend: true,
    dryRun: config.dryRun,
    allowLive: config.allowLive,
    liveIntentIgnored: "This scanner only reads accounts. It never creates pools, seeds backing, upgrades, or sends ix7.",
    configPath,
    expectedAuthority,
    seeds: {
      csdmProgramId: csdmProgramId.toBase58(),
      poolMint: poolMint.toBase58(),
      repayMint: repayMint.toBase58(),
      bumps: {
        poolState: expected.poolStateBump,
        poolAccount: expected.poolAccountBump,
        csdmMint: expected.csdmMintBump,
        poolCsdmAccount: expected.poolCsdmAccountBump,
        assetConfig: expected.assetConfigBump
      }
    },
    configuredAddresses,
    derivedAddresses: {
      csdmPoolStatePda: expected.poolStatePda.toBase58(),
      csdmPoolAccountPda: expected.poolAccountPda.toBase58(),
      csdmMintPda: expected.csdmMintPda.toBase58(),
      csdmPoolCsdmAccountPda: expected.poolCsdmAccountPda.toBase58(),
      csdmAssetConfigPda: expected.assetConfigPda.toBase58()
    },
    pdaMatches,
    accounts: {
      poolState,
      poolAccount,
      csdmMint,
      poolCsdmAccount,
      assetConfig,
      backingMint,
      repayMint: repayMintAccount,
      borrowerProgram,
      backingOracle
    },
    liveShape: {
      pass: shapeRejections.length === 0,
      readyForIx7SimulationAfterUpgrade: shapeRejections.length === 0,
      backingRaw: poolAccount.amountRaw,
      maxAmountRaw: assetConfig.maxAmountRaw,
      storedBackingOracle: assetConfig.backingOracle,
      runtimeBackingOracleToPass: expectedBackingOracle.toBase58(),
      minRepayDeltaRawFromConfig: optionalStr(raw, "minRepayDeltaAtoms"),
      configuredFlashAmountRaw: optionalStr(raw, "flashAmountAtoms"),
      configuredDeadlineSlotOffset: raw.deadlineSlotOffset
    },
    cashProofGate: {
      pass: false,
      reason: "Account shape is not cash profit. It only says whether ix7 can be simulated after upgrade.",
      required: "A source receipt must show spendable SOL/USDC growth after flash lend, borrower CPI, repay, fees, and liabilities."
    },
    shapeWarnings,
    shapeRejections,
    nextRequiredExactBuild: shapeRejections.length === 0
      ? [
        "After explicit upgrade approval, simulate ix7 flash_lend_backing against these exact accounts.",
        "If ix7 simulation passes, emit CashRelay source receipt with SOL/USDC beforeRaw/afterRaw.",
        "Do not book HOP/CSDM receipt units as profit."
      ]
      : [
        "Create missing CSDM pool/config/backing accounts only behind separate no-live plan and receipt.",
        "Rerun this scanner until CSDM_LIVE_SHAPE_READY_NO_LIVE."
      ]
  };

  const file = writeReceipt(OUT_RECEIPT, receipt);
  console.log(JSON.stringify({
    verdict: receipt.verdict,
    receipt: file,
    liveShapePass: receipt.liveShape.pass,
    backingRaw: receipt.liveShape.backingRaw,
    shapeWarnings,
    shapeRejections,
    cashProofPass: receipt.cashProofGate.pass
  }, null, 2));

  if (shapeRejections.length > 0) process.exit(1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
