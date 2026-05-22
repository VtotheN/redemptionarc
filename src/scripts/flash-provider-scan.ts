import "dotenv/config";
import dotenv from "dotenv";
import fs from "node:fs";
import { loadConfig } from "../config.js";
import { writeReceipt } from "../utils/receipt.js";

if (process.env.ENV_PATH) {
  dotenv.config({ path: process.env.ENV_PATH, override: true });
}

type Provider = {
  name: string;
  modeledFeeBps: number;
  integration: "existing" | "sdk-required" | "aggregator-sdk";
  notes: string;
};

type CycleReceipt = {
  solPriceUsd: number;
  result: {
    treasuryUsdcDelta: string;
    crankSolBefore: string;
    crankSolAfter: string;
  };
};

const PROVIDERS: Provider[] = [
  {
    name: "marginfi",
    modeledFeeBps: 0,
    integration: "sdk-required",
    notes: "Docs/support state flash loans do not incur fees; needs exact SDK instruction builder and account path."
  },
  {
    name: "vaea",
    modeledFeeBps: 2,
    integration: "aggregator-sdk",
    notes: "Public SDK aggregator advertises 2 bps flat flash-loan fee across Marginfi/Kamino/Jupiter Lend."
  },
  {
    name: "kamino-current",
    modeledFeeBps: 9,
    integration: "existing",
    notes: "Current live path."
  },
  {
    name: "save-solend",
    modeledFeeBps: 10,
    integration: "sdk-required",
    notes: "Save/Solend docs describe common origination fees around 10 bps; not better for this edge."
  }
];

function latestCycle(): CycleReceipt | null {
  const files = fs.readdirSync("receipts")
    .filter((name) => /^REDEMPTION-LIVE-CYCLE-\d+\.json$/.test(name))
    .sort();
  const last = files.at(-1);
  return last ? JSON.parse(fs.readFileSync(`receipts/${last}`, "utf8")) as CycleReceipt : null;
}

function main() {
  const config = loadConfig();
  const cycle = latestCycle();
  if (!cycle) {
    const receipt = {
      verdict: "FLASH_PROVIDER_SCAN_BLOCKED_NO_LIVE_BASELINE",
      generatedAt: new Date().toISOString()
    };
    const out = writeReceipt("REDEMPTION-FLASH-PROVIDER-SCAN-LATEST.json", receipt);
    console.log(`${receipt.verdict} receipt=${out}`);
    process.exitCode = 1;
    return;
  }

  const solPriceUsd = config.solPriceUsd ?? cycle.solPriceUsd;
  const routeVolumeUsdc = config.routeVolumeUsdc;
  const currentFeeBps = Number(process.env.CURRENT_FLASH_FEE_BPS || "9");
  const treasuryUsdcDelta = Number(cycle.result.treasuryUsdcDelta) / 1e6;
  const crankSolDelta =
    (Number(cycle.result.crankSolAfter) - Number(cycle.result.crankSolBefore)) / 1e9;
  const baselineNetUsd = treasuryUsdcDelta + crankSolDelta * solPriceUsd;

  const table = PROVIDERS.map((provider) => {
    const feeSavingsUsd = routeVolumeUsdc * Math.max(0, currentFeeBps - provider.modeledFeeBps) / 10_000;
    const modeledNetUsd = baselineNetUsd + feeSavingsUsd;
    return {
      ...provider,
      feeSavingsUsd,
      modeledNetUsd,
      passesMinNet: modeledNetUsd >= config.minNetUsd
    };
  }).sort((a, b) => b.modeledNetUsd - a.modeledNetUsd);

  const best = table[0] ?? null;
  const receipt = {
    verdict: table.some((row) => row.passesMinNet)
      ? "FLASH_PROVIDER_SCAN_READY_TO_INTEGRATE"
      : "FLASH_PROVIDER_SCAN_NO_PROVIDER_CROSSES_GATE",
    generatedAt: new Date().toISOString(),
    basis: "Latest RedemptionArc live cycle total-system cash, adjusted only for flash-loan fee bps.",
    solPriceUsd,
    routeVolumeUsdc,
    currentFeeBps,
    minNetUsd: config.minNetUsd,
    baseline: {
      treasuryUsdcDelta,
      crankSolDelta,
      baselineNetUsd
    },
    best,
    table,
    next: best?.passesMinNet
      ? `Build ${best.name} flash-loan adapter and exact no-send simulation before live.`
      : "Provider fee alone is not enough; continue with source/route redesign."
  };

  const out = writeReceipt("REDEMPTION-FLASH-PROVIDER-SCAN-LATEST.json", receipt);
  console.log(`${receipt.verdict} best=${best?.name ?? "none"} modeledNet=${best?.modeledNetUsd.toFixed(6) ?? "n/a"} receipt=${out}`);
  if (!table.some((row) => row.passesMinNet)) process.exitCode = 1;
}

main();
