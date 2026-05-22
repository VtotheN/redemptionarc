import { FORBIDDEN_WALLETS } from "../constants.js";
import { loadConfig } from "../config.js";
import { writeReceipt } from "../utils/receipt.js";

type Finding = {
  level: "error" | "warn" | "info";
  code: string;
  detail: string;
};

function configuredWallets(config: ReturnType<typeof loadConfig>) {
  return [
    ["REDEMPTION_TREASURY", config.treasury?.toBase58()],
    ["REDEMPTION_CRANK", config.crank?.toBase58()],
    ["REDEMPTION_WITHDRAW_AUTHORITY", config.withdrawAuthority?.toBase58()]
  ].filter((entry): entry is [string, string] => Boolean(entry[1]));
}

function main() {
  const config = loadConfig();
  const findings: Finding[] = [];

  for (const [name, value] of configuredWallets(config)) {
    if (FORBIDDEN_WALLETS.has(value)) {
      findings.push({
        level: "error",
        code: "FORBIDDEN_KIMI_WALLET",
        detail: `${name} points to forbidden wallet ${value}`
      });
    }
  }

  if (!config.treasury) {
    findings.push({
      level: "error",
      code: "MISSING_TREASURY",
      detail: "Set REDEMPTION_TREASURY to a new wallet before measuring cash."
    });
  }

  if (!config.crank) {
    findings.push({
      level: "warn",
      code: "MISSING_CRANK",
      detail: "Set REDEMPTION_CRANK before building executable cycles."
    });
  }

  if (!config.withdrawAuthority) {
    findings.push({
      level: "warn",
      code: "MISSING_WITHDRAW_AUTHORITY",
      detail: "Set REDEMPTION_WITHDRAW_AUTHORITY before Token-2022 settlement work."
    });
  }

  if (!config.dryRun && !config.allowLive) {
    findings.push({
      level: "error",
      code: "LIVE_NOT_ARMED",
      detail: "DRY_RUN=false requires ALLOW_LIVE=true, plus explicit Velon approval."
    });
  }

  const hasErrors = findings.some((finding) => finding.level === "error");
  const verdict = hasErrors
    ? "REDEMPTION_PREFLIGHT_BLOCKED"
    : config.dryRun
      ? "REDEMPTION_PREFLIGHT_READY_NO_LIVE"
      : "REDEMPTION_PREFLIGHT_LIVE_ARMED";

  const receipt = {
    verdict,
    generatedAt: new Date().toISOString(),
    dryRun: config.dryRun,
    allowLive: config.allowLive,
    configuredWallets: Object.fromEntries(configuredWallets(config)),
    forbiddenWallets: Array.from(FORBIDDEN_WALLETS),
    findings
  };

  const path = writeReceipt("REDEMPTION-PREFLIGHT-LATEST.json", receipt);
  console.log(`${verdict} receipt=${path}`);

  if (hasErrors) {
    process.exitCode = 1;
  }
}

main();
