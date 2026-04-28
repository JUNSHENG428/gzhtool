#!/usr/bin/env node
/**
 * 将 workspace 所需的浏览器端依赖从 node_modules 同步到 src/vendor/。
 * 在升级 marked / mammoth / pdfjs-dist 后运行：npm run vendor:sync
 */
import { copyFileSync, mkdirSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");
const nm = (p) => join(ROOT, "node_modules", p);
const v = (p) => join(ROOT, "src", "vendor", p);

const PAIRS = [
  ["marked/lib/marked.esm.js", "marked/marked.esm.js"],
  ["mammoth/mammoth.browser.min.js", "mammoth/mammoth.browser.min.js"],
  ["pdfjs-dist/build/pdf.mjs", "pdfjs/pdf.mjs"],
  ["pdfjs-dist/build/pdf.worker.mjs", "pdfjs/pdf.worker.mjs"]
];

let ok = true;
for (const [fromRel, toRel] of PAIRS) {
  const from = nm(fromRel);
  const to = v(toRel);
  if (!existsSync(from)) {
    console.error(`[vendor:sync] 缺少 ${from}，请先 npm install`);
    ok = false;
    continue;
  }
  mkdirSync(dirname(to), { recursive: true });
  copyFileSync(from, to);
  console.log(`[vendor:sync] ${toRel}`);
}
if (!ok) process.exit(1);
