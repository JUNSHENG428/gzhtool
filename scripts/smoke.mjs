#!/usr/bin/env node
/**
 * 最小冒烟：manifest、关键入口、图标、HTML、全量 JS 语法。
 */
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { execSync } from "child_process";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");

function assert(cond, msg) {
  if (!cond) {
    console.error("FAIL:", msg);
    process.exit(1);
  }
}

function mustExist(rel) {
  const p = path.join(root, rel);
  assert(fs.existsSync(p), `缺少文件: ${rel}`);
}

// 1) manifest 可读
const manifestPath = path.join(root, "manifest.json");
const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
assert(manifest.manifest_version === 3, "manifest_version 应为 3");
assert(Boolean(manifest.version), "manifest 缺少 version");

// 2) 图标
for (const sz of [16, 32, 48, 128]) {
  mustExist(`src/icons/icon${sz}.png`);
}
mustExist("src/icons/icon.svg");

// 3) 关键 HTML / 入口
const pages = [
  "src/popup/popup.html",
  "src/options/options.html",
  "src/workspace/workspace.html",
  "src/pages/welcome.html",
  "src/pages/help.html",
  "src/pages/hot-topics.html",
  "src/pages/permissions.html",
  "src/pages/privacy.html",
  "src/pages/terms.html"
];
pages.forEach(mustExist);

mustExist("src/background/service-worker.js");
mustExist("src/content-scripts/scrape-article.js");
mustExist("src/content-scripts/wechat-editor-helper.js");

// 4) JS 语法（复用 check-js）
console.log("运行 check:js …");
execSync("node scripts/check-js.mjs", { cwd: root, stdio: "inherit" });

console.log(`\n冒烟通过 · 扩展版本 manifest: ${manifest.version}`);
