#!/usr/bin/env node
/**
 * CWS 上线素材一键截图
 *
 * 输出到 dist/store/：
 *   - shot-1-workspace.png  ~ shot-5-publish.png   1280×800
 *   - promo-tile.png        440×280  Chrome Web Store 小图
 *   - promo-banner.png      1400×560 推广横幅
 *
 * 用法：
 *   npm install -D playwright
 *   npx playwright install chromium
 *   node scripts/cws-capture.mjs
 *
 * 设计原则：
 *   - 所有 HTML 设计稿都在 assets/store/ 下，可以直接用浏览器打开预览
 *   - 截图通过 playwright headed=false 跑 chromium，CSS 已固定 px 尺寸
 *   - 不依赖任何外部网络资源（字体走系统字体降级）
 */

import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { mkdir, rm } from "node:fs/promises";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "..");
const STAGE = resolve(ROOT, "assets/store");
const OUT = resolve(ROOT, "dist/store");

const TARGETS = [
  { file: "shot-1-workspace.html", out: "shot-1-workspace.png", w: 1280, h: 800 },
  { file: "shot-2-capture.html", out: "shot-2-capture.png", w: 1280, h: 800 },
  { file: "shot-3-rewrite.html", out: "shot-3-rewrite.png", w: 1280, h: 800 },
  { file: "shot-4-templates.html", out: "shot-4-templates.png", w: 1280, h: 800 },
  { file: "shot-5-publish.html", out: "shot-5-publish.png", w: 1280, h: 800 },
  { file: "promo-tile.html", out: "promo-tile.png", w: 440, h: 280 },
  { file: "promo-banner.html", out: "promo-banner.png", w: 1400, h: 560 },
];

async function loadPlaywright() {
  try {
    return await import("playwright");
  } catch (err) {
    console.error("");
    console.error("× 没有找到 playwright，请先安装：");
    console.error("    npm install -D playwright");
    console.error("    npx playwright install chromium");
    console.error("");
    process.exit(1);
  }
}

async function main() {
  const { chromium } = await loadPlaywright();

  await rm(OUT, { recursive: true, force: true });
  await mkdir(OUT, { recursive: true });

  const browser = await chromium.launch({ headless: true });

  for (const t of TARGETS) {
    const url = `file://${resolve(STAGE, t.file)}`;
    const ctx = await browser.newContext({
      viewport: { width: t.w + 80, height: t.h + 80 }, // 留点 padding 给 body 居中
      deviceScaleFactor: 2, // 输出 retina 像素，CWS 接受
      colorScheme: "light",
      reducedMotion: "reduce",
    });
    const page = await ctx.newPage();
    await page.goto(url, { waitUntil: "networkidle" });

    // 等字体/动画稳态
    await page.evaluate(() => document.fonts && document.fonts.ready);
    await page.waitForTimeout(150);

    // 找渲染目标：优先 #capture-target，否则 .shot/.tile/.banner
    const handle = await page.locator(".shot, #capture-target, .tile, .banner").first();
    const box = await handle.boundingBox();
    if (!box) {
      throw new Error(`找不到截图目标元素：${t.file}`);
    }

    const dest = resolve(OUT, t.out);
    await handle.screenshot({
      path: dest,
      omitBackground: false,
      type: "png",
    });

    // 强制按目标尺寸再缩一遍（高保真：deviceScaleFactor=2 已自动 2x 像素）
    console.log(
      `  ✓ ${t.out.padEnd(28)} ${t.w}×${t.h} (2x) ← ${t.file}`
    );

    await ctx.close();
  }

  await browser.close();

  console.log("");
  console.log(`所有素材已生成：${OUT}`);
  console.log("");
  console.log("Chrome Web Store 上传提示：");
  console.log("  - 截图：1280×800 选 shot-1 ~ shot-5 任一为主图");
  console.log("  - 小图标（440×280）：promo-tile.png");
  console.log("  - 大图（1400×560）：promo-banner.png（可选，提交后审核更快通过）");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
