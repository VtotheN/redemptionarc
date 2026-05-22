import "dotenv/config";
import dotenv from "dotenv";
import fs from "node:fs";
import { execFileSync } from "node:child_process";
import { loadConfig } from "../config.js";
import { writeReceipt } from "../utils/receipt.js";

if (process.env.ENV_PATH) {
  dotenv.config({ path: process.env.ENV_PATH, override: true });
}

function hasCommand(command: string): boolean {
  try {
    execFileSync("which", [command], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

function packageVersion(name: string): string | null {
  try {
    const pkg = JSON.parse(fs.readFileSync(`node_modules/${name}/package.json`, "utf8"));
    return String(pkg.version ?? "");
  } catch {
    return null;
  }
}

function main() {
  const config = loadConfig();
  const marginfiVersion = packageVersion("@mrgnlabs/marginfi-client-v2");
  const mrgnCommonVersion = packageVersion("@mrgnlabs/mrgn-common");
  const pinocchioManifest = "programs/pinocchio-arc/Cargo.toml";
  const blockers: string[] = [];

  if (!marginfiVersion) blockers.push("missing @mrgnlabs/marginfi-client-v2 dependency");
  if (!mrgnCommonVersion) blockers.push("missing @mrgnlabs/mrgn-common dependency");
  if (!fs.existsSync(pinocchioManifest)) blockers.push("missing Pinocchio program manifest");
  if (!hasCommand("rustc")) blockers.push("rustc not installed");
  if (!hasCommand("cargo")) blockers.push("cargo not installed");

  const receipt = {
    verdict: blockers.length === 0
      ? "PINOCCHIO_MARGINFI_PLAN_READY_TO_BUILD"
      : "PINOCCHIO_MARGINFI_PLAN_BLOCKED_TOOLCHAIN",
    generatedAt: new Date().toISOString(),
    objective: "Replace Kamino fee/friction with Marginfi 0 bps path, then reduce callback CU with Pinocchio.",
    config: {
      routeVolumeUsdc: config.routeVolumeUsdc,
      hops: config.hops,
      tx2CuPriceMicroLamports: config.tx2CuPriceMicroLamports,
      minNetUsd: config.minNetUsd
    },
    dependencies: {
      marginfiClientV2: marginfiVersion,
      mrgnCommon: mrgnCommonVersion,
      pinocchioManifest,
      rustc: hasCommand("rustc"),
      cargo: hasCommand("cargo"),
      solana: hasCommand("solana")
    },
    marginfiAdapterShape: {
      sdkTypesFound: [
        "MarginfiAccountWrapper.makeBeginFlashLoanIx(endIndex, authority)",
        "MarginfiAccountWrapper.makeEndFlashLoanIx(projectedActiveBalances, authority)",
        "MarginfiAccountWrapper.buildFlashLoanTx({ ixs, signers, addressLookupTableAccounts })"
      ],
      requiredInputs: [
        "production Marginfi config",
        "RedemptionArc-owned marginfi account",
        "USDC bank address and projected active balances",
        "existing TX0/TX2/TX3 instructions rewritten as flash body",
        "exact no-send simulation with total-system cash gate"
      ]
    },
    pinocchioPath: {
      crate: "programs/pinocchio-arc",
      v0: "read-only callback baseline",
      next: "move Token-2022 hop/settle CPI only after v0 CU is measured"
    },
    blockers,
    next: blockers.length === 0
      ? "Build SBF and implement Marginfi exact no-send adapter."
      : "Install Rust/Cargo, then build Pinocchio SBF; in parallel derive Marginfi account/bank inputs."
  };

  const out = writeReceipt("REDEMPTION-PINOCCHIO-MARGINFI-PLAN-LATEST.json", receipt);
  console.log(`${receipt.verdict} blockers=${blockers.length} marginfi=${marginfiVersion ?? "missing"} receipt=${out}`);
  if (blockers.length > 0) process.exitCode = 1;
}

main();
