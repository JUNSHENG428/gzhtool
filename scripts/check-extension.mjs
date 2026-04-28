#!/usr/bin/env node
/**
 * 加载未打包扩展，验证：
 *   1. service worker 能启动（Chrome MV3）
 *   2. popup / options / workspace / 5 个 pages 都能打开且 console 干净
 *   3. workspace 7 条 hash 路由切换正常
 *   4. options 11 个 section 锚点都存在
 *
 * 失败的检查不会让脚本立即退出，会汇总到结尾的 markdown 报告里。
 */

import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { mkdir, writeFile } from "node:fs/promises";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "..");
const REPORT_DIR = resolve(ROOT, "dist/check-reports");

async function main() {
  const playwright = await tryImportPlaywright();
  if (!playwright) return;

  const { chromium } = playwright;

  await mkdir(REPORT_DIR, { recursive: true });

  const userDataDir = resolve(REPORT_DIR, ".user-data-dir");
  // launch persistent context with extension loaded
  const context = await chromium.launchPersistentContext(userDataDir, {
    headless: false, // chromium MV3 extensions need headed=false; use new headless via channel if desired
    channel: "chromium",
    args: [
      `--disable-extensions-except=${ROOT}`,
      `--load-extension=${ROOT}`,
      "--no-default-browser-check",
      "--no-first-run"
    ],
    viewport: { width: 1280, height: 800 }
  });

  const results = [];
  const log = (group, name, status, detail = "") => {
    results.push({ group, name, status, detail });
    const sym = status === "ok" ? "✓" : status === "warn" ? "!" : "✗";
    console.log(`  ${sym} [${group}] ${name}${detail ? ` — ${detail}` : ""}`);
  };

  // 1) Wait for service worker
  console.log("\n[1] Service Worker 启动检查");
  let extensionId = null;
  let sw = context.serviceWorkers()[0];
  if (!sw) {
    sw = await context.waitForEvent("serviceworker", { timeout: 10000 }).catch(() => null);
  }
  if (!sw) {
    log("sw", "service worker 未启动", "fail", "10s 超时未拿到 SW");
  } else {
    extensionId = new URL(sw.url()).hostname;
    log("sw", "service worker 已启动", "ok", `extId=${extensionId}`);

    // 监听 SW console error（如果支持）
    const swErrors = [];
    sw.on?.("console", (msg) => {
      if (msg.type() === "error") swErrors.push(msg.text());
    });
    await new Promise((r) => setTimeout(r, 1500));
    if (swErrors.length === 0) {
      log("sw", "service worker console 干净", "ok");
    } else {
      log("sw", "service worker 有 console error", "fail", swErrors.slice(0, 3).join(" | "));
    }
  }

  if (!extensionId) {
    console.log("\n× 拿不到 Extension ID，无法继续。请检查 manifest 是否合法。");
    await context.close();
    return writeReport(results);
  }

  // 2) Pages to check
  console.log("\n[2] 扩展页面加载 + console 扫错");
  const pages = [
    { name: "popup", path: `chrome-extension://${extensionId}/src/popup/popup.html` },
    { name: "options", path: `chrome-extension://${extensionId}/src/options/options.html` },
    { name: "workspace#dashboard", path: `chrome-extension://${extensionId}/src/workspace/workspace.html#dashboard` },
    { name: "workspace#capture", path: `chrome-extension://${extensionId}/src/workspace/workspace.html#capture` },
    { name: "workspace#layout", path: `chrome-extension://${extensionId}/src/workspace/workspace.html#layout` },
    { name: "workspace#publish", path: `chrome-extension://${extensionId}/src/workspace/workspace.html#publish` },
    { name: "workspace#hot", path: `chrome-extension://${extensionId}/src/workspace/workspace.html#hot` },
    { name: "workspace#member", path: `chrome-extension://${extensionId}/src/workspace/workspace.html#member` },
    { name: "welcome", path: `chrome-extension://${extensionId}/src/pages/welcome.html` },
    { name: "help", path: `chrome-extension://${extensionId}/src/pages/help.html` },
    { name: "permissions", path: `chrome-extension://${extensionId}/src/pages/permissions.html` },
    { name: "privacy", path: `chrome-extension://${extensionId}/src/pages/privacy.html` },
    { name: "terms", path: `chrome-extension://${extensionId}/src/pages/terms.html` },
    { name: "hot-topics", path: `chrome-extension://${extensionId}/src/pages/hot-topics.html` }
  ];

  for (const p of pages) {
    const errors = [];
    const warnings = [];
    const page = await context.newPage();
    page.on("console", (msg) => {
      const t = msg.type();
      const text = msg.text();
      if (t === "error") errors.push(text);
      else if (t === "warning") warnings.push(text);
    });
    page.on("pageerror", (err) => errors.push(`pageerror: ${err.message}`));

    try {
      const resp = await page.goto(p.path, { waitUntil: "networkidle", timeout: 15000 });
      if (!resp || !resp.ok()) {
        log("page", p.name, "fail", `HTTP ${resp?.status()}`);
        await page.close();
        continue;
      }
      await page.waitForTimeout(800); // 给 SPA / async init
      // 过滤已知噪音 warning（404 favicon、external font cors warning 等）
      const realErrors = errors.filter(
        (e) => !/favicon|MODULE_TYPELESS|http-equiv content for "X-Frame-Options"/.test(e)
      );
      if (realErrors.length === 0) {
        log("page", p.name, "ok", warnings.length ? `(${warnings.length} warn)` : "");
      } else {
        log("page", p.name, "fail", realErrors.slice(0, 2).join(" | "));
      }
    } catch (err) {
      log("page", p.name, "fail", `goto: ${err.message}`);
    }
    await page.close();
  }

  // 3) Workspace router: 单页打开 → 切 6 个 hash → 验 data-active
  console.log("\n[3] Workspace 6 个 hash 路由切换");
  const wsPage = await context.newPage();
  const wsErrors = [];
  wsPage.on("pageerror", (e) => wsErrors.push(e.message));
  wsPage.on("console", (m) => {
    if (m.type() === "error") wsErrors.push(m.text());
  });
  await wsPage.goto(`chrome-extension://${extensionId}/src/workspace/workspace.html`, {
    waitUntil: "networkidle"
  });

  for (const view of ["dashboard", "capture", "layout", "publish", "hot", "member"]) {
    await wsPage.evaluate((v) => {
      window.location.hash = v;
    }, view);
    await wsPage.waitForTimeout(250);
    const active = await wsPage.evaluate(
      () =>
        document
          .querySelector(".workspace-view[data-active='true']")
          ?.getAttribute("data-view") || null
    );
    if (active === view) {
      log("router", `#${view}`, "ok");
    } else {
      log("router", `#${view}`, "fail", `active=${active}`);
    }
  }

  if (wsErrors.length === 0) {
    log("router", "切换过程 console 干净", "ok");
  } else {
    log(
      "router",
      "切换过程 console 报错",
      "fail",
      wsErrors.slice(0, 3).join(" | ")
    );
  }
  await wsPage.close();

  // 4) Options 10 个 section 锚点存在
  console.log("\n[4] Options 10 个 section 锚点检查");
  const optPage = await context.newPage();
  await optPage.goto(`chrome-extension://${extensionId}/src/options/options.html`, {
    waitUntil: "networkidle"
  });
  const sectionKeys = [
    "start", "ai", "pref", "prompt",
    "wechat", "profiles", "drission", "hot",
    "license", "pages"
  ];
  for (const key of sectionKeys) {
    const present = await optPage.evaluate(
      (k) => Boolean(document.querySelector(`[data-section-key="${k}"]`)),
      key
    );
    log("options", `section[${key}]`, present ? "ok" : "fail");
  }
  await optPage.close();

  // 5) Popup 3 tab 切换
  console.log("\n[5] Popup 3 tab 切换");
  const popupPage = await context.newPage();
  await popupPage.goto(`chrome-extension://${extensionId}/src/popup/popup.html`, {
    waitUntil: "networkidle"
  });
  for (const tab of ["write", "hot", "me"]) {
    await popupPage.click(`button.popup-tab[data-tab="${tab}"]`);
    await popupPage.waitForTimeout(150);
    const isActive = await popupPage.evaluate(
      (t) =>
        document
          .querySelector(`button.popup-tab[data-tab="${t}"]`)
          ?.getAttribute("aria-selected") === "true",
      tab
    );
    log("popup", `tab[${tab}]`, isActive ? "ok" : "fail");
  }
  await popupPage.close();

  // 6) 静态健康检查：member 页面 4 卡 DOM 是否齐全
  console.log("\n[6] Member 页 4 个核心卡渲染");
  const memPage = await context.newPage();
  await memPage.goto(`chrome-extension://${extensionId}/src/workspace/workspace.html#member`, {
    waitUntil: "networkidle"
  });
  await memPage.waitForTimeout(500);
  for (const sel of [
    ".member-hero",
    ".member-quota",
    ".member-features",
    ".member-actions"
  ]) {
    const present = await memPage.evaluate((s) => Boolean(document.querySelector(s)), sel);
    log("member", sel, present ? "ok" : "fail");
  }
  await memPage.close();

  await context.close();
  await writeReport(results);
}

async function writeReport(results) {
  const ok = results.filter((r) => r.status === "ok").length;
  const fail = results.filter((r) => r.status === "fail").length;
  const warn = results.filter((r) => r.status === "warn").length;

  const summary = `\n────────────────────────────────────────\n` +
    `  ✓ ${ok}   ! ${warn}   ✗ ${fail}\n` +
    `────────────────────────────────────────\n`;

  console.log(summary);

  // markdown report
  const lines = [];
  lines.push(`# 扩展加载机测报告`);
  lines.push(`生成时间：${new Date().toISOString()}`);
  lines.push("");
  lines.push(`| Group | Check | Status | Detail |`);
  lines.push(`|---|---|---|---|`);
  for (const r of results) {
    const sym = r.status === "ok" ? "✅" : r.status === "warn" ? "⚠️" : "❌";
    lines.push(`| ${r.group} | ${r.name} | ${sym} | ${r.detail.replace(/\|/g, "\\|")} |`);
  }
  lines.push("");
  lines.push(`**总计**：✓ ${ok} / ! ${warn} / ✗ ${fail}`);

  const file = resolve(REPORT_DIR, "check-extension.md");
  await writeFile(file, lines.join("\n"));
  console.log(`报告已写入：${file}`);

  if (fail > 0) {
    process.exitCode = 1;
  }
}

async function tryImportPlaywright() {
  try {
    return await import("playwright");
  } catch {
    console.error("");
    console.error("× 没装 playwright。先跑：");
    console.error("    npm install -D playwright");
    console.error("    npx playwright install chromium");
    console.error("");
    process.exit(1);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
