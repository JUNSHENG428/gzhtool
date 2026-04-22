#!/usr/bin/env node
/**
 * 对 src/ 与 scripts/ 下业务脚本做语法检查（node --check），不含 node_modules。
 */
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { execSync } from "child_process";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");

function walkJs(dir, out = []) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const ent of entries) {
    const p = path.join(dir, ent.name);
    if (ent.isDirectory()) {
      if (ent.name === "node_modules" || ent.name === ".git") continue;
      walkJs(p, out);
    } else if (ent.name.endsWith(".js") || ent.name.endsWith(".mjs")) {
      out.push(p);
    }
  }
  return out;
}

const files = ["src", "scripts"]
  .map((d) => walkJs(path.join(root, d)))
  .flat();

let failed = false;
for (const file of files) {
  try {
    execSync(`node --check "${file}"`, { stdio: "pipe" });
    process.stdout.write(".");
  } catch {
    failed = true;
    console.error(`\n语法错误: ${path.relative(root, file)}`);
  }
}
console.log(`\n已检查 ${files.length} 个文件`);
if (failed) {
  process.exit(1);
}
