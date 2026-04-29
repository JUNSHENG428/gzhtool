#!/usr/bin/env node
/**
 * 编译 src/content-scripts/floating-ball/index.tsx 到
 * src/content-scripts/floating-ball.bundle.js（IIFE / 生产 minify / target Chrome 116）。
 *
 * 用法：
 *   node scripts/build-floating-ball.mjs              # 单次生产构建
 *   node scripts/build-floating-ball.mjs --watch      # 开发态 watch 模式
 *
 * 输出 bundle 提交进 git，让"load unpacked"零构建工作流仍然生效。
 * Phase 2.1 阶段 bundle 还未挂进 manifest，仅验证工具链跑通。
 */
import { context, build } from "esbuild";
import { fileURLToPath } from "node:url";
import path from "node:path";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ENTRY = path.join(ROOT, "src/content-scripts/floating-ball/index.tsx");
const OUTFILE = path.join(ROOT, "src/content-scripts/floating-ball.bundle.js");

const baseConfig = {
  entryPoints: [ENTRY],
  bundle: true,
  format: "iife",
  target: ["chrome116"],
  jsx: "automatic",
  outfile: OUTFILE,
  // process.env.NODE_ENV 在 React 里必须替换为字符串字面量，
  // 不替换的话 production 会保留开发态校验和 warning，体积涨 ~30%。
  define: {
    "process.env.NODE_ENV": JSON.stringify("production")
  },
  loader: { ".tsx": "tsx", ".ts": "ts" },
  // 给 bundle 文件头加 banner，方便人类一眼识别这是构建产物
  banner: {
    js: "/* 润笔砚台 mp 浮球 React bundle · 由 scripts/build-floating-ball.mjs 编译产生 · 不要手动编辑 */"
  },
  legalComments: "none",
  minify: true,
  sourcemap: false,
  logLevel: "info"
};

async function runOnce() {
  const start = Date.now();
  await build(baseConfig);
  const ms = Date.now() - start;
  console.log(`✔ 浮球 bundle 构建完成（${ms}ms）→ ${path.relative(ROOT, OUTFILE)}`);
}

async function runWatch() {
  const ctx = await context(baseConfig);
  await ctx.watch();
  console.log("→ 浮球 bundle watch 模式启动；改 src/content-scripts/floating-ball/*.tsx 自动重编译");
  // 不主动退出，进程由 SIGINT 关闭
  process.on("SIGINT", async () => {
    await ctx.dispose();
    process.exit(0);
  });
}

const isWatch = process.argv.includes("--watch");

(isWatch ? runWatch() : runOnce()).catch((err) => {
  console.error("✗ 浮球 bundle 构建失败：", err?.message || err);
  process.exit(1);
});
