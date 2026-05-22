import fs from "node:fs";
import { writeReceipt } from "../utils/receipt.js";

function readVerdict(file: string): string {
  if (!fs.existsSync(file)) return "MISSING";
  return JSON.parse(fs.readFileSync(file, "utf8")).verdict ?? "UNKNOWN";
}

function main() {
  const routeVerdict = readVerdict("receipts/REDEMPTION-SETTLEMENT-ROUTE-SCAN-LATEST.json");
  const holderVerdict = readVerdict("receipts/REDEMPTION-HOP-HOLDER-SCAN-LATEST.json");
  const capVerdict = readVerdict("receipts/REDEMPTION-TOKEN2022-CAP-SCAN-LATEST.json");

  const options = [
    {
      id: "external_jupiter_or_dex_route",
      status: routeVerdict === "SETTLEMENT_ROUTE_READY_JUPITER" ? "ready" : "blocked",
      cashTruth: "valid only if quote and swap instructions settle HOP to USDC/SOL with post-balance proof",
      blocker: routeVerdict
    },
    {
      id: "owned_pool_self_funded",
      status: "rejected_as_profit",
      cashTruth: "swapping HOP into our own USDC pool moves our inventory; it is not profit unless third-party/protocol cash replenishes USDC",
      blocker: "self-funded USDC side"
    },
    {
      id: "owned_venue_external_flow",
      status: "build_candidate",
      cashTruth: "valid if external orderflow/protocol rewards pay fees in USDC/SOL to RedemptionArc",
      blocker: "needs fee-paying external/protocol flow proof"
    },
    {
      id: "protocol_paid_source",
      status: "build_candidate",
      cashTruth: "valid if deterministic claim/collect instruction pays SOL/USDC under RedemptionArc authority",
      blocker: "needs source scanner"
    },
    {
      id: "direct_usdc_fee_mint_or_program",
      status: "design_candidate",
      cashTruth: "valid only if program-owned fee rights accrue USDC from non-self-funded flow",
      blocker: "requires deploy/design and capital/rent"
    }
  ];

  const ready = options.filter((option) => option.status === "ready");
  const buildCandidates = options.filter((option) => option.status === "build_candidate" || option.status === "design_candidate");

  const receipt = {
    verdict: ready.length > 0 ? "SETTLEMENT_OPTION_READY" : "SETTLEMENT_OPTIONS_REQUIRE_BUILD",
    generatedAt: new Date().toISOString(),
    inputs: { routeVerdict, holderVerdict, capVerdict },
    options,
    nextBuild: ready.length > 0
      ? "simulate ready route with swap instructions and post-balance cash proof"
      : "build source scanner and/or owned venue external-flow proof; do not execute self-funded pool as profit",
    selectedForNext: ready[0]?.id ?? buildCandidates[0]?.id ?? null
  };

  const out = writeReceipt("REDEMPTION-SETTLEMENT-OPTIONS-LATEST.json", receipt);
  console.log(`${receipt.verdict} selected=${receipt.selectedForNext} receipt=${out}`);
}

main();
