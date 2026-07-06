#!/usr/bin/env node
/**
 * scrape-article.js 反爬增强验证（抓取引擎反爬增强）：
 *   - 模块一：CSS 隐藏元素过滤（display:none / visibility:hidden / font-size:0 / 屏幕外定位）
 *   - 模块二：z-index 遮罩识别（空遮罩不影响底下真实文字；带假内容的遮罩视觉上最终显示）
 *   - 模块三：浏览器端 canvas 字体反爬还原（Unicode 私有使用区编码点还原成真实数字）
 *
 * 用 Playwright 起一个真实 headless Chromium，加载本地 fixture，直接在页面里
 * 注入 scrape-article.js 并调用 window.__gzhRunFullCapture，断言输出干净。
 * 不访问任何真实网站。
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "..");

let failures = 0;

function assert(condition, message) {
  if (!condition) {
    failures += 1;
    console.error("  ✗ " + message);
  } else {
    console.log("  ✓ " + message);
  }
}

function blocksToPlainText(blocks) {
  return (blocks || [])
    .map((block) => {
      if (block.type === "image") return "";
      if (block.type === "list") return (block.items || []).join("\n");
      if (block.type === "table") {
        const rows = [];
        if (block.headers && block.headers.length) rows.push(block.headers.join(" | "));
        for (const row of block.rows || []) rows.push(row.join(" | "));
        return rows.join("\n");
      }
      return block.text || "";
    })
    .join("\n\n");
}

function buildFixtureHtml(fontBase64) {
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8" />
<style>
  @font-face {
    font-family: 'gzhTestPua7x2q';
    src: url('data:font/ttf;base64,${fontBase64}');
  }
  .salary { font-family: 'gzhTestPua7x2q', sans-serif; }
  .noise-display-none { display: none; }
  .noise-visibility-hidden { visibility: hidden; }
  .noise-font-zero { font-size: 0; }
  .noise-offscreen { position: absolute; left: -9999px; top: -9999px; }
  .mask-wrap { position: relative; display: inline-block; }
  .mask-empty { position: absolute; inset: 0; z-index: 5; }
  .real-under-empty-mask { position: relative; z-index: 1; }
  .mask-decoy { position: absolute; inset: 0; z-index: 10; background: #fff; }
  .real-under-decoy { position: relative; z-index: 1; }
</style>
</head>
<body>
  <article>
    <h1>正常标题不受影响</h1>
    <p>
      岗位职责：负责后端服务开发与维护<span class="noise-display-none">kanzhun</span>，
      参与核心系统架构设计<span class="noise-visibility-hidden">直聘噪音</span>。
    </p>
    <p>
      任职要求：<span class="noise-font-zero">垂圾垂圾</span>本科及以上学历，
      三年以上相关工作经验。
    </p>
    <div class="noise-offscreen">这段屏幕外的文字不应该出现在结果里</div>
    <p>
      薪资：
      <span class="mask-wrap">
        <span class="mask-empty"></span>
        <span class="real-under-empty-mask">10k-20k</span>
      </span>
      。
    </p>
    <p>
      工作地点：
      <span class="mask-wrap">
        <span class="mask-decoy">虚假占位地址</span>
        <span class="real-under-decoy">上海市浦东新区</span>
      </span>
    </p>
    <p>薪资范围加密：<span class="salary">&#xE001;&#xE005;k-&#xE002;&#xE005;k</span>，13薪。</p>
    <p>欢迎有志之士加入我们的团队，共同成长，一起把产品做得更好。</p>
  </article>
</body>
</html>`;
}

async function main() {
  const { chromium } = await import("playwright").catch(() => {
    console.error("× 没装 playwright。先跑：npm install -D playwright && npx playwright install chromium");
    process.exit(1);
  });

  const scraperSource = readFileSync(
    resolve(ROOT, "src/content-scripts/scrape-article.js"),
    "utf8"
  );
  const fontBase64 = readFileSync(resolve(HERE, "fixtures/pua-test-font.ttf")).toString("base64");
  const html = buildFixtureHtml(fontBase64);

  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    await page.setContent(html, { waitUntil: "load" });
    // 等自定义字体真正加载完成，否则模块三的 canvas 渲染可能还在用 fallback 字体
    await page.evaluate(() => document.fonts.ready);

    await page.addScriptTag({ content: scraperSource });
    const capture = await page.evaluate(() =>
      window.__gzhRunFullCapture({ mode: "readable" })
    );

    console.log("\n运行 scrape-article.js 反爬增强 fixture 验证 …");
    assert(capture && Array.isArray(capture.blocks), "capture.blocks 必须是数组");
    const plainText = blocksToPlainText(capture.blocks);

    console.log("  —— 基线：正常内容必须原样保留 ——");
    for (const expected of [
      "正常标题不受影响",
      "负责后端服务开发与维护",
      "参与核心系统架构设计",
      "本科及以上学历",
      "欢迎有志之士加入我们的团队"
    ]) {
      assert(plainText.includes(expected), `保留正常正文: ${expected}`);
    }

    console.log("  —— 模块一：CSS 隐藏噪音必须被剔除 ——");
    for (const noise of [
      "kanzhun",
      "直聘噪音",
      "垂圾垂圾",
      "这段屏幕外的文字不应该出现在结果里"
    ]) {
      assert(!plainText.includes(noise), `剔除 CSS 隐藏噪音: ${noise}`);
    }

    console.log("  —— 模块二：z-index 遮罩识别 ——");
    assert(
      plainText.includes("10k-20k"),
      "空遮罩（纯劫持型，无自身文字）不应影响底下真实文字: 10k-20k"
    );
    assert(
      plainText.includes("虚假占位地址"),
      "带假内容的不透明遮罩视觉上是最终显示层，应保留: 虚假占位地址"
    );
    assert(
      !plainText.includes("上海市浦东新区"),
      "被不透明假遮罩盖住的真实文字应被排除: 上海市浦东新区"
    );

    console.log("  —— 模块三：浏览器端字体反爬还原 ——");
    assert(
      plainText.includes("15k-25k"),
      `私有使用区编码应还原成真实数字: 15k-25k（实际片段: ${plainText.slice(0, 200)}）`
    );
    assert(
      !/[\uE000-\uF8FF]/.test(plainText),
      "输出文本不应残留任何 Unicode 私有使用区编码点"
    );

    console.log("  —— 抓取契约字段完整性（防回归） ——");
    assert(capture.captureMode === "readable", "captureMode 字段保持契约");
    assert(
      typeof capture.wordCount === "number" && capture.wordCount > 0,
      "wordCount 字段保持契约且大于 0"
    );
  } finally {
    await browser.close();
  }

  if (failures > 0) {
    console.error(`\n✗ scrape-article.js 反爬增强验证失败：${failures} 项`);
    process.exit(1);
  }
  console.log("\n✓ scrape-article.js 反爬增强验证全部通过");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
