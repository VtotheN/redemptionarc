import fs from "node:fs";
import { writeReceipt } from "../utils/receipt.js";

function readJson(file: string): any | null {
  return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : null;
}

function main() {
  const readiness = readJson("receipts/REDEMPTION-AGGRESSIVE-READINESS-LATEST.json");
  const plan = readJson("receipts/REDEMPTION-AGGRESSIVE-PLAN-LATEST.json");
  const blockers: string[] = [];

  if (!plan?.selected) blockers.push("missing aggressive selected plan");
  if (readiness?.verdict !== "AGGRESSIVE_READINESS_READY_FOR_EXACT_SIM") {
    blockers.push(`readiness not ready: ${readiness?.verdict ?? "missing"}`);
  }

  const verdict = blockers.length === 0
    ? "EXACT_SIM_READY_TO_BUILD_TRANSACTIONS"
    : "EXACT_SIM_BLOCKED_BY_READINESS";

  const receipt = {
    verdict,
    generatedAt: new Date().toISOString(),
    selectedPlan: plan?.selected ?? null,
    readinessVerdict: readiness?.verdict ?? null,
    blockers,
    transactionSkeleton: [
      {
        tx: "TX0",
        purpose: "wrap SOL and Jupiter SOL->USDC cushion into ghost USDC ATA",
        status: blockers.length === 0 ? "next_implementation" : "blocked"
      },
      {
        tx: "TX2",
        purpose: "Kamino borrow + Token-2022 hop ring + feeFirst transfer + Kamino repay",
        status: blockers.length === 0 ? "next_implementation" : "blocked"
      },
      {
        tx: "TX3",
        purpose: "sweep ghost USDC to treasury and harvest/withdraw HOP fees",
        status: blockers.length === 0 ? "next_implementation" : "blocked"
      }
    ],
    next: blockers.length === 0
      ? "Implement real transaction builders and simulate with sigVerify=false."
      : "Fund crank and rerun aggressive-readiness."
  };

  const out = writeReceipt("REDEMPTION-EXACT-SIM-LATEST.json", receipt);
  console.log(`${verdict} blockers=${blockers.length} receipt=${out}`);
  if (blockers.length > 0) process.exitCode = 1;
}

main();
