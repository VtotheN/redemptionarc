import fs from "node:fs";
import path from "node:path";
import { Connection, Keypair, PublicKey } from "@solana/web3.js";
import { loadConfig } from "../config.js";
import { writeReceipt } from "../utils/receipt.js";
import { assertNoForbiddenConfigured } from "../utils/safety.js";

const OUT_RECEIPT = "MAINNET-PROGRAM-CANDIDATE-SCAN-LATEST.json";
const UPGRADEABLE_LOADER = "BPFLoaderUpgradeab1e11111111111111111111111";

const DEFAULT_ATOM_PROGRAM_ID = "BxJMJLxXJhKvuhvvxY57wYY69CAs9RCQWBv9JPCtm9Kx";
const DEFAULT_ENCHANCEDBLOCK_PROGRAM_ID = "61hviwfoDk6ygzJHJaDG2tsoWbBpUYWdNJnSSfRA1vPh";
const DEFAULT_CSDM_PROGRAM_ID = "Q9FMc5YLqjJe96geFtg43ocfyrpJYM2WDHkQEqh8aNv";
const DEFAULT_ORA_CULOXX_PROGRAM_ID = "D2MyTRvKuPDwrAbAbzvizcCC7xKW47gB1DL8Nr9ck2aj";
const DEFAULT_ROLLBLOCK_PROGRAM_ID = "9R2VdiXXby8V5n1nKG5yjmauZjNA74PjteuugogDwnt8";
const DEFAULT_FLYWHEEL_PROGRAM_ID = "8cTuyNMJkz72bqyvU91g2SUcxtJTpmSrD2NcLDd8Kqyn";

type KeyMaterial = {
  path: string;
  exists: boolean;
  pubkey: string | null;
  status: "missing" | "array_keypair" | "metadata_pubkey" | "invalid";
  error?: string;
};

type Candidate = {
  name: string;
  programId: string;
  role: string;
  useRecommendation: string;
  programKeypairPaths: string[];
  authorityKeypairPaths: string[];
  sourcePaths: string[];
};

type ProgramInspection = {
  name: string;
  programId: string;
  role: string;
  useRecommendation: string;
  exists: boolean;
  executable: boolean;
  ownerProgram: string | null;
  lamports: number;
  programDataAddress: string | null;
  programDataSlot: string | null;
  programDataAccountBytes: number | null;
  elfDataLenEstimate: number | null;
  upgradeAuthority: string | null;
  localProgramKeypairs: KeyMaterial[];
  localAuthorityKeypairs: KeyMaterial[];
  localProgramKeypairMatches: boolean;
  localAuthorityMatches: string[];
  classification:
    | "FREE_PROGRAM_ID_CAN_DEPLOY"
    | "MISSING_NO_LOCAL_KEYPAIR"
    | "LIVE_UPGRADEABLE_CONTROLLED"
    | "LIVE_UPGRADEABLE_AUTHORITY_KNOWN_ONLY"
    | "LIVE_IMMUTABLE_DO_NOT_TOUCH"
    | "LIVE_NON_UPGRADEABLE_PROGRAM"
    | "LIVE_NOT_EXECUTABLE"
    | "PROGRAMDATA_MISSING_OR_UNPARSED";
  closeOrUpgradePosition: string;
};

function strEnv(name: string, fallback: string): string {
  const raw = process.env[name];
  return raw == null || raw.trim() === "" ? fallback : raw.trim();
}

function maybeEnvPath(name: string): string[] {
  const raw = process.env[name];
  if (!raw || raw.trim() === "") return [];
  return raw.split(",").map((value) => value.trim()).filter(Boolean);
}

function uniq(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))];
}

function readText(file: string): string {
  return fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "";
}

function fileBytes(file: string): number | null {
  return fs.existsSync(file) ? fs.statSync(file).size : null;
}

function keyMaterial(file: string): KeyMaterial {
  if (!fs.existsSync(file)) {
    return { path: file, exists: false, pubkey: null, status: "missing" };
  }
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as unknown;
    if (Array.isArray(parsed)) {
      const kp = Keypair.fromSecretKey(Uint8Array.from(parsed as number[]));
      return { path: file, exists: true, pubkey: kp.publicKey.toBase58(), status: "array_keypair" };
    }
    if (typeof parsed === "object" && parsed !== null && "pubkey" in parsed) {
      const pubkey = (parsed as { pubkey?: unknown }).pubkey;
      if (typeof pubkey === "string" && pubkey.length > 0) {
        return { path: file, exists: true, pubkey, status: "metadata_pubkey" };
      }
    }
    return { path: file, exists: true, pubkey: null, status: "invalid", error: "JSON is not a keypair array or pubkey metadata object" };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { path: file, exists: true, pubkey: null, status: "invalid", error: message };
  }
}

function parseUpgradeableProgramData(data: Buffer): string | null {
  if (data.length < 36) return null;
  const tag = data.readUInt32LE(0);
  if (tag !== 2) return null;
  return new PublicKey(data.subarray(4, 36)).toBase58();
}

function parseProgramData(data: Buffer): {
  slot: string;
  upgradeAuthority: string | null;
  elfDataLenEstimate: number;
} | null {
  if (data.length < 13) return null;
  const tag = data.readUInt32LE(0);
  if (tag !== 3) return null;
  const slot = data.readBigUInt64LE(4).toString();
  const hasAuthority = data[12] === 1;
  const upgradeAuthority = hasAuthority && data.length >= 45
    ? new PublicKey(data.subarray(13, 45)).toBase58()
    : null;
  const elfOffset = hasAuthority ? 45 : 13;
  return {
    slot,
    upgradeAuthority,
    elfDataLenEstimate: Math.max(0, data.length - elfOffset)
  };
}

function classify(
  exists: boolean,
  executable: boolean,
  ownerProgram: string | null,
  programDataAddress: string | null,
  upgradeAuthority: string | null,
  localProgramKeypairMatches: boolean,
  localAuthorityMatches: string[]
): ProgramInspection["classification"] {
  if (!exists) {
    return localProgramKeypairMatches ? "FREE_PROGRAM_ID_CAN_DEPLOY" : "MISSING_NO_LOCAL_KEYPAIR";
  }
  if (!executable) return "LIVE_NOT_EXECUTABLE";
  if (ownerProgram !== UPGRADEABLE_LOADER) return "LIVE_NON_UPGRADEABLE_PROGRAM";
  if (!programDataAddress) return "PROGRAMDATA_MISSING_OR_UNPARSED";
  if (!upgradeAuthority) return "LIVE_IMMUTABLE_DO_NOT_TOUCH";
  if (localAuthorityMatches.length > 0) return "LIVE_UPGRADEABLE_CONTROLLED";
  return "LIVE_UPGRADEABLE_AUTHORITY_KNOWN_ONLY";
}

function closeOrUpgradePosition(classification: ProgramInspection["classification"], name: string): string {
  if (classification === "FREE_PROGRAM_ID_CAN_DEPLOY") {
    return "clean deploy slot; no close/upgrade needed";
  }
  if (classification === "LIVE_UPGRADEABLE_CONTROLLED") {
    return name === "CSDM"
      ? "upgrade candidate, not close candidate; preserve live ID and add exact receipt before any upgrade"
      : "controlled live infra; do not close by default, upgrade only with exact receipt";
  }
  if (classification === "LIVE_UPGRADEABLE_AUTHORITY_KNOWN_ONLY") {
    return "upgradeable but no local authority keypair match found by this scanner";
  }
  if (classification === "LIVE_IMMUTABLE_DO_NOT_TOUCH") {
    return "immutable or authority removed; cannot be upgraded through normal loader path";
  }
  return "not a usable deploy/upgrade target from this scan";
}

function inspectCsdmSources(): Record<string, unknown> {
  const legacyPath = strEnv(
    "CSDM_LEGACY_LIB_PATH",
    "/Users/velon/gh-src-vtothen/EXPERIMENTO-CanSmelldaMoney/program/src/lib.rs"
  );
  const flashLendLib = strEnv(
    "CSDM_FLASH_LEND_LIB_PATH",
    "/Users/velon/gh-src-vtothen/EXPERIMENTO-lazyloop/csdm/programs/csdm/src/lib.rs"
  );
  const flashLendIx = strEnv(
    "CSDM_FLASH_LEND_IX_PATH",
    "/Users/velon/gh-src-vtothen/EXPERIMENTO-lazyloop/csdm/programs/csdm/src/flash_lend.rs"
  );
  const deployArtifact = strEnv(
    "CSDM_FLASH_LEND_SO_PATH",
    "/Users/velon/gh-src-vtothen/EXPERIMENTO-lazyloop/csdm/programs/csdm/target/deploy/csdm_flash_lend_backing.so"
  );
  const legacy = readText(legacyPath);
  const lib = readText(flashLendLib);
  const ix = readText(flashLendIx);
  return {
    legacyPath,
    flashLendLib,
    flashLendIx,
    legacyRedeemPattern: /Some\(2\)\s*=>\s*ix_withdraw/.test(legacy) && /Burn/.test(legacy) && /Transfer/.test(legacy),
    legacyBackedFlashPattern: /Some\(4\)\s*=>\s*ix_flash_mint_backed/.test(legacy),
    legacySessionPattern: /Some\(6\)\s*=>\s*ix_flash_mint_session/.test(legacy),
    flashLendBackingIx7InSource: /Some\(7\)\s*=>\s*flash_lend::ix_flash_lend_backing/.test(lib),
    releasesRealBacking: /Transfer\s*\{\s*from:\s*pool_account,\s*to:\s*borrower_destination/s.test(ix),
    requiresBackingGrowth: /backing_after\s*<\s*required_after/.test(ix) && /min_repay_delta/.test(ix),
    requiresAllowedBorrower: /allowed_borrower_key/.test(ix) && /borrower_program/.test(ix),
    requiresDeadline: /deadline_slot/.test(ix) && /max_deadline_slots/.test(ix),
    burnsReceipt: /Burn\s*\{/.test(ix) && /pool_csdm_account/.test(ix),
    deployArtifact,
    deployArtifactBytes: fileBytes(deployArtifact),
    liveIx7Assumption: "Do not assume ix7 is live until binary hash or exact ix7 simulation proves it on Q9."
  };
}

function inspectAtomSource(): Record<string, unknown> {
  const repo = strEnv("ATOM_REPO_PATH", "/Users/velon/Desktop/atom_ickk");
  const flashOpen = readText(path.join(repo, "programs/atom_ickk/src/instructions/flash_open.rs"));
  const borrowerExit = readText(path.join(repo, "programs/atom_ickk/src/instructions/borrower_exit.rs"));
  return {
    repo,
    flashOpenFound: flashOpen.length > 0,
    borrowerExitFound: borrowerExit.length > 0,
    supportsMultiSlotWindow: /deadline_slots/.test(flashOpen) && /checked_add\(deadline_slots\)/.test(flashOpen),
    hasTokenMintVaultConstraints: /has_one\s*=\s*token_mint/.test(flashOpen) && /has_one\s*=\s*token_vault/.test(flashOpen),
    use: "fresh deploy slot for atom-style capital window or HOP redeem vault if CSDM upgrade is not chosen"
  };
}

async function inspectPrograms(connection: Connection, candidates: Candidate[]): Promise<ProgramInspection[]> {
  const programKeys = candidates.map((candidate) => new PublicKey(candidate.programId));
  const programAccounts = await connection.getMultipleAccountsInfo(programKeys, "confirmed");
  const programDataAddresses = programAccounts.map((account) => account ? parseUpgradeableProgramData(account.data) : null);
  const programDataKeys = programDataAddresses.map((addr) => addr ? new PublicKey(addr) : null);
  const programDataAccounts = await connection.getMultipleAccountsInfo(
    programDataKeys.filter((key): key is PublicKey => key !== null),
    "confirmed"
  );
  const programDataByAddress = new Map<string, Buffer>();
  let programDataIndex = 0;
  for (const address of programDataAddresses) {
    if (!address) continue;
    const account = programDataAccounts[programDataIndex++];
    if (account) programDataByAddress.set(address, account.data);
  }

  return candidates.map((candidate, index) => {
    const account = programAccounts[index];
    const programDataAddress = programDataAddresses[index];
    const programData = programDataAddress ? programDataByAddress.get(programDataAddress) : null;
    const parsedProgramData = programData ? parseProgramData(programData) : null;
    const localProgramKeypairs = candidate.programKeypairPaths.map(keyMaterial);
    const localAuthorityKeypairs = candidate.authorityKeypairPaths.map(keyMaterial);
    const localProgramKeypairMatches = localProgramKeypairs.some((item) => item.pubkey === candidate.programId);
    const upgradeAuthority = parsedProgramData?.upgradeAuthority ?? null;
    const localAuthorityMatches = localAuthorityKeypairs
      .filter((item) => item.pubkey && item.pubkey === upgradeAuthority)
      .map((item) => item.path);
    const exists = account !== null;
    const executable = account?.executable ?? false;
    const ownerProgram = account?.owner.toBase58() ?? null;
    const classification = classify(
      exists,
      executable,
      ownerProgram,
      programDataAddress,
      upgradeAuthority,
      localProgramKeypairMatches,
      localAuthorityMatches
    );

    return {
      name: candidate.name,
      programId: candidate.programId,
      role: candidate.role,
      useRecommendation: candidate.useRecommendation,
      exists,
      executable,
      ownerProgram,
      lamports: account?.lamports ?? 0,
      programDataAddress,
      programDataSlot: parsedProgramData?.slot ?? null,
      programDataAccountBytes: programData?.length ?? null,
      elfDataLenEstimate: parsedProgramData?.elfDataLenEstimate ?? null,
      upgradeAuthority,
      localProgramKeypairs,
      localAuthorityKeypairs,
      localProgramKeypairMatches,
      localAuthorityMatches,
      classification,
      closeOrUpgradePosition: closeOrUpgradePosition(classification, candidate.name)
    };
  });
}

function candidateList(): Candidate[] {
  const keeperAuthorityPaths = uniq([
    ...maybeEnvPath("KEEPER_AUTHORITY_KEYPAIR_PATHS"),
    "/Users/velon/gh-src-vtothen/EXPERIMENTO-lazyloop/keys/keeper-keypair.json"
  ]);
  const fvxAuthorityPaths = uniq([
    ...maybeEnvPath("FVX_AUTHORITY_KEYPAIR_PATHS"),
    "/Users/velon/gh-src-vtothen/EXPERIMENTO-lazyloop/keys/fvx-admin-mainnet.json"
  ]);
  const oraAuthorityPaths = uniq([
    ...maybeEnvPath("ORA_AUTHORITY_KEYPAIR_PATHS"),
    "/Users/velon/gh-src-vtothen/EXPERIMENTO-lazyloop/keys/ora-admin-keypair.json",
    "/Users/velon/gh-src-vtothen/EXPERIMENTO-ora-culoxx/examples/keys/admin-keypair.json"
  ]);

  return [
    {
      name: "atom_ickk",
      programId: strEnv("ATOM_PROGRAM_ID", DEFAULT_ATOM_PROGRAM_ID),
      role: "fresh multi-slot flash/capital window candidate",
      useRecommendation: "Best clean deploy slot if we avoid touching live infra; not a cash source by itself.",
      programKeypairPaths: uniq([
        ...maybeEnvPath("ATOM_PROGRAM_KEYPAIR_PATHS"),
        "/Users/velon/Desktop/atom_ickk/target/deploy/atom_ickk-keypair.json"
      ]),
      authorityKeypairPaths: keeperAuthorityPaths,
      sourcePaths: ["/Users/velon/Desktop/atom_ickk/programs/atom_ickk/src/lib.rs"]
    },
    {
      name: "CSDM",
      programId: strEnv("CSDM_PROGRAM_ID", DEFAULT_CSDM_PROGRAM_ID),
      role: "backing vault / receipt / flash-lend candidate",
      useRecommendation: "Best live candidate if local authority matches; add HOP redeem or ix7 proof before any cash claim.",
      programKeypairPaths: uniq([
        ...maybeEnvPath("CSDM_PROGRAM_KEYPAIR_PATHS"),
        "/Users/velon/gh-src-vtothen/EXPERIMENTO-CanSmelldaMoney/program/keys/program-keypair.json",
        "/Users/velon/gh-src-vtothen/EXPERIMENTO-lazyloop/keys/csdm-program-keypair.json"
      ]),
      authorityKeypairPaths: keeperAuthorityPaths,
      sourcePaths: [
        "/Users/velon/gh-src-vtothen/EXPERIMENTO-CanSmelldaMoney/program/src/lib.rs",
        "/Users/velon/gh-src-vtothen/EXPERIMENTO-lazyloop/csdm/programs/csdm/src/lib.rs",
        "/Users/velon/gh-src-vtothen/EXPERIMENTO-lazyloop/csdm/programs/csdm/src/flash_lend.rs"
      ]
    },
    {
      name: "ENCHANCEDBLOCK",
      programId: strEnv("ENCHANCEDBLOCK_PROGRAM_ID", DEFAULT_ENCHANCEDBLOCK_PROGRAM_ID),
      role: "authority-controlled venue plus external Orca settlement source",
      useRecommendation: "Keep live; use as actuator/source only after exact sim receipt with SOL/USDC delta.",
      programKeypairPaths: maybeEnvPath("ENCHANCEDBLOCK_PROGRAM_KEYPAIR_PATHS"),
      authorityKeypairPaths: fvxAuthorityPaths,
      sourcePaths: ["/Users/velon/gh-src-vtothen/EXPERIMENTO-ENCHANCEDBLOCK/programs/enchanced-cpmm/src/lib.rs"]
    },
    {
      name: "ora-culoxx",
      programId: strEnv("ORA_CULOXX_PROGRAM_ID", DEFAULT_ORA_CULOXX_PROGRAM_ID),
      role: "price/oracle freshness primitive",
      useRecommendation: "Keep live as oracle truth helper; not a cash source.",
      programKeypairPaths: uniq([
        ...maybeEnvPath("ORA_CULOXX_PROGRAM_KEYPAIR_PATHS"),
        "/Users/velon/gh-src-vtothen/EXPERIMENTO-ora-culoxx/program/keys/program-keypair.json"
      ]),
      authorityKeypairPaths: uniq([...fvxAuthorityPaths, ...oraAuthorityPaths]),
      sourcePaths: ["/Users/velon/gh-src-vtothen/EXPERIMENTO-ora-culoxx/program/src/lib.rs"]
    },
    {
      name: "ROLLBLOCK",
      programId: strEnv("ROLLBLOCK_PROGRAM_ID", DEFAULT_ROLLBLOCK_PROGRAM_ID),
      role: "on-chain invariant/judge candidate",
      useRecommendation: "Optional judge; not required before RedemptionCashRelay receipt path.",
      programKeypairPaths: maybeEnvPath("ROLLBLOCK_PROGRAM_KEYPAIR_PATHS"),
      authorityKeypairPaths: keeperAuthorityPaths,
      sourcePaths: ["/Users/velon/gh-src-vtothen/EXPERIMENTO-ROLLBLOCK/programs/rollblock/src/lib.rs"]
    },
    {
      name: "flywheel-1",
      programId: strEnv("FLYWHEEL_PROGRAM_ID", DEFAULT_FLYWHEEL_PROGRAM_ID),
      role: "legacy receipt/PDA pattern candidate",
      useRecommendation: "Archaeology only unless executable and controlled.",
      programKeypairPaths: maybeEnvPath("FLYWHEEL_PROGRAM_KEYPAIR_PATHS"),
      authorityKeypairPaths: keeperAuthorityPaths,
      sourcePaths: []
    }
  ];
}

async function main(): Promise<void> {
  const config = loadConfig();
  assertNoForbiddenConfigured(config);

  const candidates = candidateList();
  const inspections = await inspectPrograms(new Connection(config.rpcUrl, "confirmed"), candidates);
  const byName = Object.fromEntries(inspections.map((item) => [item.name, item]));
  const csdm = byName.CSDM;
  const atom = byName.atom_ickk;
  const enchancedblock = byName.ENCHANCEDBLOCK;
  const ora = byName["ora-culoxx"];

  const csdmControlled = csdm?.classification === "LIVE_UPGRADEABLE_CONTROLLED";
  const atomDeployable = atom?.classification === "FREE_PROGRAM_ID_CAN_DEPLOY";
  const enchancedblockControlled = enchancedblock?.classification === "LIVE_UPGRADEABLE_CONTROLLED";
  const oraControlled = ora?.classification === "LIVE_UPGRADEABLE_CONTROLLED";
  const csdmSourceInspection = inspectCsdmSources();
  const csdmArtifactBytes = typeof csdmSourceInspection.deployArtifactBytes === "number"
    ? csdmSourceInspection.deployArtifactBytes
    : null;
  const csdmLiveElfBytes = csdm?.elfDataLenEstimate ?? null;
  const csdmUpgradeFitsCurrentProgramData = csdmArtifactBytes !== null && csdmLiveElfBytes !== null
    ? csdmArtifactBytes <= csdmLiveElfBytes
    : null;
  const csdmUpgradeByteHeadroom = csdmArtifactBytes !== null && csdmLiveElfBytes !== null
    ? csdmLiveElfBytes - csdmArtifactBytes
    : null;

  const receipt = {
    verdict: "MAINNET_PROGRAM_CANDIDATE_SCAN_SAVED_NO_LIVE",
    generatedAt: new Date().toISOString(),
    noSend: true,
    dryRun: config.dryRun,
    allowLive: config.allowLive,
    liveIntentIgnored: "This scanner only reads RPC/local files. It never deploys, upgrades, closes, or sends transactions.",
    architectureFinding: {
      csdm: csdmControlled
        ? "CSDM is live, upgradeable, and local keeper authority matches. It is the strongest candidate for backing-vault / flash-lend / HOP-redeem integration."
        : "CSDM is useful as a design, but this scan did not prove local upgrade control.",
      atom: atomDeployable
        ? "atom_ickk program ID is free and local program keypair matches; use as clean fresh deploy slot if we avoid upgrading live CSDM."
        : "atom_ickk is not classified as a clean free deploy slot by this scan.",
      enchancedblock: enchancedblockControlled
        ? "ENCHANCEDBLOCK is controlled live infra; keep it as external Orca actuator/source, not as the redeem vault."
        : "ENCHANCEDBLOCK control was not proven by this scan.",
      ora: oraControlled
        ? "ora-culoxx is controlled live infra; keep as oracle/freshness helper."
        : "ora-culoxx control was not proven by this scan."
    },
    candidateSummary: {
      bestExistingUpgradeTarget: csdmControlled ? "CSDM" : null,
      bestFreshDeployTarget: atomDeployable ? "atom_ickk" : null,
      csdmUpgradeFitsCurrentProgramData,
      csdmArtifactBytes,
      csdmLiveElfBytes,
      csdmUpgradeByteHeadroom,
      recommendedNextBuild: csdmControlled
        ? csdmUpgradeFitsCurrentProgramData === true
          ? "CSDM ix7 artifact appears to fit current Q9 ProgramData; next is exact upgrade simulation/receipt, not live upgrade."
          : "Build exact CSDM upgrade/sim receipt and handle ProgramData extension or fresh deploy if artifact does not fit."
        : atomDeployable
          ? "Deploy atom-derived HOP redeem vault only after exact build receipt."
          : "No safe mainnet program target selected.",
      cashStatus: "No profit booked. Program control only removes an engineering blocker; cash proof still needs wallet SOL/USDC delta through RedemptionCashRelay."
    },
    programInspections: inspections,
    sourceInspections: {
      csdm: csdmSourceInspection,
      atom: inspectAtomSource()
    },
    cashProofGate: {
      pass: false,
      sourceClass: "program_control_scan_only",
      eligibilityProof: csdmControlled || atomDeployable
        ? "Program target exists for build path, but no SOL/USDC source receipt is attached."
        : "No controlled deploy/upgrade target proven.",
      instructionPath: "TBD: exact CSDM ix7 or atom-derived redeem-vault instruction receipt required.",
      settlementPathToSolUsdc: "TBD: HOP/custom/accounting units must burn/lock/redeem into spendable SOL/USDC.",
      costModel: "TBD: upgrade/deploy rent, transaction fees, flash repay, Orca fees, tips, and liabilities must be priced.",
      rejectionReasons: [
        "program control is not cash profit",
        "CSDM/atom still need exact no-send simulation receipt",
        "HOP/custom token value still needs burn/redeem or external SOL/USDC settlement proof",
        "RedemptionCashRelay must receive authority-exclusive SOL/USDC source receipt before live"
      ]
    },
    nextRequiredExactBuild: [
      "For CSDM path: produce exact upgrade simulation/receipt for the ix7 artifact against Q9 before any live upgrade.",
      "For atom path: add HOP redeem-vault instruction and deploy only behind a separate approval receipt.",
      "Wire ENCHANCEDBLOCK source receipt so Orca settlement shows afterRaw > beforeRaw in SOL/USDC after all costs.",
      "Feed the final source receipt into npm run redemption-cash-relay-plan and require READY_NO_LIVE before any live step."
    ]
  };

  const file = writeReceipt(OUT_RECEIPT, receipt);
  console.log(JSON.stringify({
    verdict: receipt.verdict,
    receipt: file,
    bestExistingUpgradeTarget: receipt.candidateSummary.bestExistingUpgradeTarget,
    bestFreshDeployTarget: receipt.candidateSummary.bestFreshDeployTarget,
    cashProofPass: receipt.cashProofGate.pass
  }, null, 2));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
