import { writeUnderwheelCashSourceReceipt } from "./redemption-underwheel-source.js";

const source = writeUnderwheelCashSourceReceipt();
console.log(`${source.receipt.verdict} payerClass=${source.receipt.payerClass} receipt=${source.path}`);

process.env.CASH_SOURCE_RECEIPT_PATH = source.path;
await import("./redemption-cash-relay-plan.js");
