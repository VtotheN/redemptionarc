import fs from "node:fs";
import path from "node:path";

export function writeReceipt(name: string, body: unknown): string {
  const dir = path.resolve("receipts");
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, name);
  fs.writeFileSync(file, `${JSON.stringify(body, null, 2)}\n`);
  return file;
}
