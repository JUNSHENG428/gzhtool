#!/usr/bin/env node
/**
 * 校验 src/content-scripts/floating-ball.bundle.js 是否落后于 floating-ball/ 下任一源文件。
 *
 * Why：浮球 bundle 提交进 git，开发者改 .tsx 后必须 npm run build:floating-ball 重新编译。
 * 这个脚本在 CI / pre-commit 兜底，避免漏跑。
 *
 * 输出格式与 check:js / check:features 一致（开头 1 行 summary，失败时 exit 1）。
 */
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SOURCE_DIR = path.join(ROOT, "src/content-scripts/floating-ball");
const BUNDLE_PATH = path.join(ROOT, "src/content-scripts/floating-ball.bundle.js");

async function walkSourceFiles(dir) {
  const result = [];
  let entries;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch (err) {
    if (err.code === "ENOENT") return [];
    throw err;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      result.push(...(await walkSourceFiles(full)));
    } else if (/\.(tsx?|jsx?|css)$/.test(entry.name)) {
      result.push(full);
    }
  }
  return result;
}

async function main() {
  const sources = await walkSourceFiles(SOURCE_DIR);
  if (sources.length === 0) {
    console.log("ℹ floating-ball/ 还没有任何源文件，跳过 bundle-fresh 校验");
    return;
  }

  let bundleStat;
  try {
    bundleStat = await fs.stat(BUNDLE_PATH);
  } catch (err) {
    if (err.code === "ENOENT") {
      console.error(
        "✗ 没有找到 floating-ball.bundle.js。先跑 npm run build:floating-ball"
      );
      process.exit(1);
    }
    throw err;
  }

  const stale = [];
  for (const file of sources) {
    const stat = await fs.stat(file);
    if (stat.mtimeMs > bundleStat.mtimeMs + 100) {
      // +100ms 缓冲：fs 时间精度抖动
      stale.push(path.relative(ROOT, file));
    }
  }

  if (stale.length > 0) {
    console.error(
      `✗ 浮球 bundle 落后于 ${stale.length} 个源文件（mtime 较新）。请跑 npm run build:floating-ball 重新编译：`
    );
    stale.forEach((f) => console.error(`  - ${f}`));
    process.exit(1);
  }

  console.log(
    `✔ 浮球 bundle 与源文件同步（${sources.length} 个源、${path.relative(ROOT, BUNDLE_PATH)}）`
  );
}

main().catch((err) => {
  console.error("✗ check:bundle-fresh 失败：", err?.message || err);
  process.exit(1);
});
