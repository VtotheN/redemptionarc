import crypto from "node:crypto";
import fs from "node:fs";
import { Connection, Keypair, PublicKey } from "@solana/web3.js";
import { loadConfig } from "../config.js";
import { writeReceipt } from "../utils/receipt.js";
import { assertNoForbiddenConfigured } from "../utils/safety.js";

const OUT_RECEIPT = "CSDM-UPGRADE-PREFLIGHT-LATEST.json";
const UPGRADEABLE_LOADER = "BPFLoaderUpgradeab1e11111111111111111111111";
const DEFAULT_CSDM_PROGRAM_ID = "Q9FMc5YLqjJe96geFtg43ocfyrpJYM2WDHkQEqh8aNv";
const DEFAULT_CSDM_PROGRAM_KEYPAIR = "/Users/velon/gh-src-vtothen/EXPERIMENTO-CanSmelldaMoney/program/keys/program-keypair.json";
const DEFAULT_CSDM_AUTHORITY_KEYPAIR = "/Users/velon/gh-src-vtothen/EXPERIMENTO-lazyloop/keys/keeper-keypair.json";
const DEFAULT_CSDM_ARTIFACT = "/Users/velon/gh-src-vtothen/EXPERIMENTO-lazyloop/csdm/programs/csdm/target/deploy/csdm_flash_lend_backing.so";
const DEFAULT_CSDM_LIB = "/Users/velon/gh-src-vtothen/EXPERIMENTO-lazyloop/csdm/programs/csdm/src/lib.rs";
const DEFAULT_CSDM_FLASH_LEND = "/Users/velon/gh-src-vtothen/EXPERIMENTO-lazyloop/csdm/programs/csdm/src/flash_lend.rs";

type KeyMaterial = {
  path: string;
  exists: boolean;
  pubkey: string | null;
  hasSecret: boolean;
  status: "missing" | "array_keypair" | "metadata_pubkey" | "invalid";
  error?: string;
};

function strEnv(name: string, fallback: string): string {
  const raw = process.env[name];
  return raw == null || raw.trim() === "" ? fallback : raw.trim();
}

function keyMaterial(file: string): KeyMaterial {
  if (!fs.existsSync(file)) {
    return { path: file, exists: false, pubkey: null, hasSecret: false, status: "missing" };
  }
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as unknown;
    if (Array.isArray(parsed)) {
      const kp = Keypair.fromSecretKey(Uint8Array.from(parsed as number[]));
      return { path: file, exists: true, pubkey: kp.publicKey.toBase58(), hasSecret: true, status: "array_keypair" };
    }
    if (typeof parsed === "object" && parsed !== null && "pubkey" in parsed) {
      const pubkey = (parsed as { pubkey?: unknown }).pubkey;
      if (typeof pubkey === "string" && pubkey.length > 0) {
        return { path: file, exists: true, pubkey, hasSecret: false, status: "metadata_pubkey" };
      }
    }
    return { path: file, exists: true, pubkey: null, hasSecret: false, status: "invalid", error: "JSON is not a keypair array or pubkey metadata object" };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { path: file, exists: true, pubkey: null, hasSecret: false, status: "invalid", error: message };
  }
}

function sha256(file: string): string | null {
  if (!fs.existsSync(file)) return null;
  return crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

function sha256Buffer(data: Buffer): string {
  return crypto.createHash("sha256").update(data).digest("hex");
}

function fileBytes(file: string): number | null {
  return fs.existsSync(file) ? fs.statSync(file).size : null;
}

function readText(file: string): string {
  return fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "";
}

function parseUpgradeableProgram(data: Buffer): string | null {
  if (data.length < 36 || data.readUInt32LE(0) !== 2) return null;
  return new PublicKey(data.subarray(4, 36)).toBase58();
}

function parseProgramData(data: Buffer): {
  slot: string;
  upgradeAuthority: string | null;
  elfBytes: Buffer;
} | null {
  if (data.length < 13 || data.readUInt32LE(0) !== 3) return null;
  const slot = data.readBigUInt64LE(4).toString();
  const hasAuthority = data[12] === 1;
  const authorityOffset = 13;
  const elfOffset = hasAuthority ? 45 : 13;
  const upgradeAuthority = hasAuthority && data.length >= 45
    ? new PublicKey(data.subarray(authorityOffset, authorityOffset + 32)).toBase58()
    : null;
  return {
    slot,
    upgradeAuthority,
    elfBytes: data.subarray(elfOffset)
  };
}

function sourceMarkers(libPath: string, flashLendPath: string): Record<string, boolean | string> {
  const lib = readText(libPath);
  const flashLend = readText(flashLendPath);
  return {
    libPath,
    flashLendPath,
    ix7DispatchPresent: /Some\(7\)\s*=>\s*flash_lend::ix_flash_lend_backing/.test(lib),
    realBackingTransfer: /Transfer\s*\{\s*from:\s*pool_account,\s*to:\s*borrower_destination/s.test(flashLend),
    principalPlusDeltaCheck: /backing_after\s*<\s*required_after/.test(flashLend) && /min_repay_delta/.test(flashLend),
    allowedBorrowerCheck: /allowed_borrower_key/.test(flashLend) && /borrower_program/.test(flashLend),
    deadlineCheck: /deadline_slot/.test(flashLend) && /max_deadline_slots/.test(flashLend),
    receiptBurn: /Burn\s*\{/.test(flashLend) && /pool_csdm_account/.test(flashLend)
  };
}

async function main(): Promise<void> {
  const config = loadConfig();
  assertNoForbiddenConfigured(config);

  const programId = strEnv("CSDM_PROGRAM_ID", DEFAULT_CSDM_PROGRAM_ID);
  const programKeypairPath = strEnv("CSDM_PROGRAM_KEYPAIR_PATH", DEFAULT_CSDM_PROGRAM_KEYPAIR);
  const authorityKeypairPath = strEnv("CSDM_UPGRADE_AUTHORITY_KEYPAIR_PATH", DEFAULT_CSDM_AUTHORITY_KEYPAIR);
  const artifactPath = strEnv("CSDM_FLASH_LEND_SO_PATH", DEFAULT_CSDM_ARTIFACT);
  const libPath = strEnv("CSDM_FLASH_LEND_LIB_PATH", DEFAULT_CSDM_LIB);
  const flashLendPath = strEnv("CSDM_FLASH_LEND_IX_PATH", DEFAULT_CSDM_FLASH_LEND);

  const connection = new Connection(config.rpcUrl, "confirmed");
  const programAccount = await connection.getAccountInfo(new PublicKey(programId), "confirmed");
  const programDataAddress = programAccount ? parseUpgradeableProgram(programAccount.data) : null;
  const programDataAccount = programDataAddress
    ? await connection.getAccountInfo(new PublicKey(programDataAddress), "confirmed")
    : null;
  const programData = programDataAccount ? parseProgramData(programDataAccount.data) : null;
  const programKeypair = keyMaterial(programKeypairPath);
  const authorityKeypair = keyMaterial(authorityKeypairPath);
  const artifactBuffer = fs.existsSync(artifactPath) ? fs.readFileSync(artifactPath) : null;
  const artifactBytes = fileBytes(artifactPath);
  const artifactSha256 = artifactBuffer ? sha256Buffer(artifactBuffer) : sha256(artifactPath);
  const liveElfSha256 = programData
    ? sha256Buffer(programData.elfBytes)
    : null;
  const liveElfBytes = programData?.elfBytes.length ?? null;
  const artifactFits = artifactBytes !== null && liveElfBytes !== null ? artifactBytes <= liveElfBytes : false;
  const byteHeadroom = artifactBytes !== null && liveElfBytes !== null ? liveElfBytes - artifactBytes : null;
  const livePrefix = programData && artifactBuffer
    ? programData.elfBytes.subarray(0, artifactBuffer.length)
    : null;
  const liveTail = programData && artifactBuffer && programData.elfBytes.length >= artifactBuffer.length
    ? programData.elfBytes.subarray(artifactBuffer.length)
    : null;
  const liveElfPrefixSha256 = livePrefix ? sha256Buffer(livePrefix) : null;
  const liveElfPrefixMatchesArtifact = livePrefix && artifactBuffer
    ? Buffer.compare(livePrefix, artifactBuffer) === 0
    : false;
  const liveElfTailBytes = liveTail ? liveTail.length : null;
  const liveElfTailSha256 = liveTail ? sha256Buffer(liveTail) : null;
  const markers = sourceMarkers(libPath, flashLendPath);
  const markerPass = Object.entries(markers)
    .filter(([_, value]) => typeof value === "boolean")
    .every(([_, value]) => value === true);

  const engineeringRejections = [
    programAccount ? null : "CSDM program account missing",
    programAccount?.executable === true ? null : "CSDM program account is not executable",
    programAccount?.owner.toBase58() === UPGRADEABLE_LOADER ? null : "CSDM is not owned by BPF upgradeable loader",
    programDataAddress ? null : "CSDM ProgramData address missing",
    programData ? null : "CSDM ProgramData account missing or unparsed",
    programKeypair.pubkey === programId ? null : "local CSDM program keypair does not match program id",
    authorityKeypair.hasSecret ? null : "local CSDM upgrade authority keypair must contain a signing secret",
    authorityKeypair.pubkey === programData?.upgradeAuthority ? null : "local CSDM upgrade authority does not match ProgramData authority",
    artifactBytes !== null ? null : "CSDM ix7 artifact .so missing; run PATH=\"$HOME/.cargo/bin:$PATH\" cargo-build-sbf --manifest-path programs/csdm/Cargo.toml",
    artifactFits ? null : "CSDM ix7 artifact does not fit current ProgramData length",
    markerPass ? null : "CSDM source markers for ix7 backing invariant are incomplete"
  ].filter((value): value is string => value !== null);

  const receipt = {
    verdict: engineeringRejections.length === 0
      ? "CSDM_UPGRADE_PREFLIGHT_READY_NO_LIVE"
      : "CSDM_UPGRADE_PREFLIGHT_BLOCKED",
    generatedAt: new Date().toISOString(),
    noSend: true,
    dryRun: config.dryRun,
    allowLive: config.allowLive,
    liveIntentIgnored: "This preflight never invokes solana program deploy. A live upgrade requires a separate approval and fresh receipt.",
    program: {
      programId,
      exists: Boolean(programAccount),
      executable: programAccount?.executable ?? false,
      ownerProgram: programAccount?.owner.toBase58() ?? null,
      programDataAddress,
      programDataSlot: programData?.slot ?? null,
      upgradeAuthority: programData?.upgradeAuthority ?? null,
      liveElfBytes,
      liveElfSha256,
      liveElfSha256Full: liveElfSha256,
      liveElfPrefixSha256,
      liveElfPrefixMatchesArtifact,
      liveElfTailBytes,
      liveElfTailSha256,
      lastUpgradeSignature: strEnv("CSDM_LAST_UPGRADE_SIGNATURE", "") || null
    },
    localInputs: {
      programKeypair,
      authorityKeypair,
      artifactPath,
      artifactExists: artifactBytes !== null,
      artifactBytes,
      artifactSha256,
      artifactFitsCurrentProgramData: artifactFits,
      byteHeadroom,
      buildCommand: "cd /Users/velon/gh-src-vtothen/EXPERIMENTO-lazyloop/csdm && PATH=\"$HOME/.cargo/bin:$PATH\" cargo-build-sbf --manifest-path programs/csdm/Cargo.toml"
    },
    sourceMarkers: markers,
    upgradeReadiness: {
      pass: engineeringRejections.length === 0,
      classification: "engineering_preflight_only",
      exactLiveCommandNotRun: "solana program deploy --program-id <CSDM_PROGRAM_KEYPAIR> --upgrade-authority <AUTHORITY> --no-auto-extend <ARTIFACT>",
      requiresSeparateApproval: true,
      rollbackRequirement: "Capture current ProgramData slot/hash, artifact hash, authority, and cash gate status before any live upgrade.",
      deploymentComparisonNote: "liveElfSha256Full includes allocated ProgramData tail bytes; liveElfPrefixMatchesArtifact is the exact deployed-artifact check."
    },
    cashProofGate: {
      pass: false,
      reason: "Upgrade readiness is not cash profit. HOP/custom/accounting value must still settle to spendable SOL/USDC through RedemptionCashRelay.",
      requiredAfterUpgrade: [
        "exact ix7 simulation against live-shaped accounts",
        "ENCHANCEDBLOCK source receipt with afterRaw > beforeRaw in SOL/USDC after all costs",
        "HOP burn/redeem or external settlement receipt",
        "REDEMPTION_CASH_RELAY_READY_NO_LIVE"
      ]
    },
    engineeringRejections,
    nextRequiredExactBuild: engineeringRejections.length === 0
      && liveElfPrefixMatchesArtifact
      ? [
        "Run exact ix7 simulation against live-shaped accounts.",
        "Do not run live ix7 until the simulation produces a source receipt with real SOL/USDC afterRaw > beforeRaw after all costs.",
        "Do not report profit until RedemptionCashRelay sees real SOL/USDC growth."
      ]
      : engineeringRejections.length === 0
      ? [
        "Create a no-send live-upgrade approval receipt that pins artifactSha256, liveElfSha256, authority, and byteHeadroom.",
        "After explicit approval only, upgrade Q9 with --no-auto-extend and immediately run ix7 simulation.",
        "Do not report profit until RedemptionCashRelay sees real SOL/USDC growth."
      ]
      : [
        "Fix engineeringRejections, rebuild the artifact, rerun this preflight, and commit the new receipt."
      ]
  };

  const file = writeReceipt(OUT_RECEIPT, receipt);
  console.log(JSON.stringify({
    verdict: receipt.verdict,
    receipt: file,
    upgradeReadinessPass: receipt.upgradeReadiness.pass,
    artifactBytes,
    liveElfBytes,
    byteHeadroom,
    liveElfPrefixMatchesArtifact,
    cashProofPass: receipt.cashProofGate.pass
  }, null, 2));

  if (engineeringRejections.length > 0) process.exit(1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
