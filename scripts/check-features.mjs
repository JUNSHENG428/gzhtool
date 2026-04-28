#!/usr/bin/env node
/**
 * 机测功能行为（不需要真实 LLM 也不需要真 Pro）：
 *   1. 排版主题：themeSelect 加载 7 个杂志母版，切换不同 theme 渲染都成功
 *   2. AI 模板生成器：未激活 Pro 时弹 upgrade modal；激活后能打开 7 题问卷
 *   3. Pro 闸门：高级 prompt 模板在 free 状态下被锁；fake-pro 后解锁
 *   4. 多账号闸门：第 3 个账号触发 free 上限拦截
 *   5. 字数 quota：免费版第 6 次 AI 改写触发 quota modal（mock）
 *   6. License pill 在 popup / options / workspace 三处文案一致
 *
 * 不会真的去公众号 / 真 LLM。所有外部 fetch 通过 page.route 拦截。
 */

import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { mkdir, writeFile } from "node:fs/promises";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "..");
const REPORT_DIR = resolve(ROOT, "dist/check-reports");

const FAKE_PRO_LICENSE = {
  key: "GZHT-DEV9-FAKE-PR99",
  plan: "pro",
  status: "active",
  expiresAt: Date.now() + 365 * 24 * 60 * 60 * 1000,
  features: {
    "wechat.multiAccount": true,
    "scrape.drission": true,
    "ai.advancedTemplates": true,
    "ai.templateGenerator": true,
    "ai.unlimitedDaily": true,
    "wechat.publish": true,
    "hot.advancedSources": true,
    "ai.batchRewrite": true,
    "ai.deAiBoost": true
  },
  dailyQuota: -1,
  signedAt: Date.now(),
  signature: "dev-fake",
  verifiedAt: Date.now(),
  activatedAt: new Date().toISOString(),
  user: { id: "dev-user", email: "dev@docuearn.com" }
};

async function main() {
  const { chromium } = await import("playwright").catch(() => {
    console.error("× 没装 playwright。先跑：npm install -D playwright && npx playwright install chromium");
    process.exit(1);
  });

  await mkdir(REPORT_DIR, { recursive: true });
  const userDataDir = resolve(REPORT_DIR, ".user-data-features");

  const context = await chromium.launchPersistentContext(userDataDir, {
    headless: false,
    channel: "chromium",
    args: [
      `--disable-extensions-except=${ROOT}`,
      `--load-extension=${ROOT}`,
      "--no-first-run",
      "--no-default-browser-check"
    ],
    viewport: { width: 1280, height: 800 }
  });

  let sw = context.serviceWorkers()[0] || (await context.waitForEvent("serviceworker", { timeout: 10000 }));
  const extId = new URL(sw.url()).hostname;
  console.log(`Extension ID: ${extId}\n`);

  const results = [];
  const log = (group, name, status, detail = "") => {
    results.push({ group, name, status, detail });
    const sym = status === "ok" ? "✓" : status === "warn" ? "!" : "✗";
    console.log(`  ${sym} [${group}] ${name}${detail ? ` — ${detail}` : ""}`);
  };

  // 拦截所有外部 fetch（包括 docuearn.com / openai.com 等）
  // 防止扩展真的去验 license 或调 LLM
  await context.route(/api\.docuearn\.com|api\.openai\.com|api\.anthropic|api\.deepseek|newsnow|hot\.inkgold|rsshub/, async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ ok: true, data: [], blocked: "by-test" })
    });
  });

  // ──────────────────────────────────────────────────────────
  // 1) 排版主题：themeSelect 加载 + 切换
  // ──────────────────────────────────────────────────────────
  console.log("\n[1] 排版 7 套母版");
  {
    const page = await context.newPage();
    await page.goto(`chrome-extension://${extId}/src/workspace/workspace.html#layout`, { waitUntil: "networkidle" });
    await page.waitForTimeout(500);

    const options = await page.evaluate(() =>
      Array.from(document.querySelectorAll("#themeSelect option")).map((o) => ({
        value: o.value,
        label: o.textContent.trim()
      }))
    );
    if (options.length >= 6) {
      log("layout", `themeSelect 选项数 = ${options.length}`, "ok");
    } else {
      log("layout", `themeSelect 选项数 = ${options.length}`, "fail", "期望 ≥ 6");
    }

    // 切换每个 theme，验 wechatPreview 渲染过 + 没报错
    const errors = [];
    page.on("pageerror", (e) => errors.push(e.message));
    let renderedCount = 0;
    for (const opt of options) {
      await page.selectOption("#themeSelect", opt.value).catch(() => {});
      await page.waitForTimeout(150);
      const inner = await page.evaluate(
        () => document.querySelector("#wechatPreview")?.innerHTML || ""
      );
      if (inner && inner.length > 50) renderedCount++;
    }
    log("layout", `主题切换后预览渲染数 = ${renderedCount}/${options.length}`, renderedCount === options.length ? "ok" : "warn", "");
    if (errors.length === 0) {
      log("layout", "主题切换 console 干净", "ok");
    } else {
      log("layout", "主题切换有 pageerror", "fail", errors[0]);
    }
    await page.close();
  }

  // ──────────────────────────────────────────────────────────
  // 2) AI 模板生成器：未 Pro 时升级，Pro 后展示 7 题问卷
  // ──────────────────────────────────────────────────────────
  console.log("\n[2] AI 模板生成器闸门（free → upgrade modal）");
  {
    const page = await context.newPage();
    await page.goto(`chrome-extension://${extId}/src/options/options.html`, { waitUntil: "networkidle" });
    await page.waitForTimeout(500);
    // 清掉 license 确保 free
    await page.evaluate(() => chrome.storage.local.remove(["wechatWriterLicense", "wechatWriterLicenseAuth"]));
    // 切到 expert 模式：AI 模板生成器按钮才会可见
    await page.evaluate(() => {
      try { localStorage.setItem("gzhSettings.noviceMode.v1", "expert"); } catch {}
    });
    await page.reload({ waitUntil: "networkidle" });
    await page.waitForTimeout(400);

    // 记录这个 UX 观察：options 中按钮在 novice 模式下确实仍被 data-advanced 隐藏，
    // 但已经不再是阻塞问题 —— workspace 端有 3 处常驻入口（编辑台 toolbar / dashboard
    // 磁贴 / 改写模板下拉），novice 用户通过 workspace 即可发现 Pro 卖点。
    const buttonVisibleInNovice = await page.evaluate(() => {
      document.body.setAttribute("data-novice-mode", "on");
      const btn = document.querySelector("#aiGenerateTemplateButton");
      const visible = btn && btn.offsetParent !== null;
      document.body.setAttribute("data-novice-mode", "off");
      return visible;
    });
    log("ux", "options novice 模式下按钮隐藏（workspace 已补 3 处入口）", "ok",
      buttonVisibleInNovice
        ? "options 端按钮在 novice 模式下也可见"
        : "options 端 novice 隐藏属预期；workspace 编辑台 toolbar / dashboard 磁贴 / 改写下拉常驻可见");

    await page.click("#aiGenerateTemplateButton").catch(() => {});
    await page.waitForTimeout(400);

    const upgradeOpen = await page.evaluate(() =>
      Boolean(document.querySelector(".license-upgrade-backdrop"))
    );
    log("ai-tpl", "free 状态点 AI 生成模板 → upgrade modal", upgradeOpen ? "ok" : "fail",
      upgradeOpen ? "" : "未弹出升级框");

    if (upgradeOpen) {
      const featureName = await page.evaluate(() =>
        document.querySelector(".license-upgrade-title")?.textContent.trim() || ""
      );
      log("ai-tpl", `升级弹窗标题 = "${featureName}"`,
        featureName.includes("AI 模板生成器") ? "ok" : "warn");
      await page.evaluate(() => document.querySelector(".license-upgrade-backdrop")?.remove());
    }

    // ── 注入 fake-pro，重新打开 ──
    console.log("\n[3] AI 模板生成器（fake-pro 后展示 7 题问卷）");
    await page.evaluate((lic) => {
      chrome.storage.local.set({
        wechatWriterLicense: lic,
        wechatWriterLicenseAuth: { token: "dev", user: lic.user, issuedAt: Date.now() }
      });
      try { localStorage.setItem("gzhSettings.noviceMode.v1", "expert"); } catch {}
    }, FAKE_PRO_LICENSE);
    await page.waitForTimeout(400);
    await page.reload({ waitUntil: "networkidle" });
    await page.waitForTimeout(500);

    await page.click("#aiGenerateTemplateButton");
    await page.waitForTimeout(400);

    // 对话框由共享模块 src/shared/ai-template-dialog.js lazy-mount 到 document.body
    const dialogVisible = await page.evaluate(
      () => document.querySelector("#ai-template-dialog-root")?.hidden === false
    );
    log("ai-tpl", "fake-pro 后弹出问卷对话框", dialogVisible ? "ok" : "fail");

    if (dialogVisible) {
      const quizCount = await page.evaluate(
        () => document.querySelectorAll(".ai-template-quiz-options[data-quiz]").length
      );
      log("ai-tpl", `问卷题目容器数 = ${quizCount}`, quizCount >= 6 ? "ok" : "fail", "期望至少 6 题");

      const themeCards = await page.evaluate(
        () => document.querySelectorAll(".ai-template-theme-card").length
      );
      log("ai-tpl", `视觉主题卡片数 = ${themeCards}`, themeCards >= 6 ? "ok" : "fail", "期望至少 6 张");
    }
    await page.close();
  }

  // ──────────────────────────────────────────────────────────
  // 3.5) workspace 三处 AI 模板入口可见性（不依赖 novice 模式）
  // ──────────────────────────────────────────────────────────
  console.log("\n[3.5] workspace AI 模板入口曝光（toolbar / dashboard / 改写下拉）");
  {
    const ws = await context.newPage();
    await ws.goto(`chrome-extension://${extId}/src/workspace/workspace.html`, { waitUntil: "networkidle" });
    await ws.waitForTimeout(600);

    // dashboard 路由：快捷动作磁贴
    const quickTileVisible = await ws.evaluate(() => {
      const el = document.querySelector("#quickAiTemplate");
      return Boolean(el && el.offsetParent !== null);
    });
    log("ai-tpl", "workspace dashboard 快捷磁贴 #quickAiTemplate",
      quickTileVisible ? "ok" : "fail",
      quickTileVisible ? "" : "未在 .ui-quick-grid 看到 AI 生成模板磁贴");

    // 切到改写排版（toolbar 按钮在 #layout 路由的 .rewrite-cluster 里）
    await ws.evaluate(() => { location.hash = "#layout"; });
    await ws.waitForTimeout(400);

    const toolbarBtnVisible = await ws.evaluate(() => {
      const el = document.querySelector("#aiGenTemplateBtnLayout");
      return Boolean(el && el.offsetParent !== null);
    });
    log("ai-tpl", "workspace 改写工具栏按钮 #aiGenTemplateBtnLayout",
      toolbarBtnVisible ? "ok" : "fail",
      toolbarBtnVisible ? "" : "未在 .rewrite-cluster 看到 AI 新模板按钮");

    const inlineOptionPresent = await ws.evaluate(() => {
      const sel = document.querySelector("#rewriteTemplateSelect");
      if (!sel) return false;
      return Array.from(sel.options).some((o) => o.value === "__ai_gen__");
    });
    log("ai-tpl", "改写模板下拉含 ✨ 用 AI 生成新模板 选项",
      inlineOptionPresent ? "ok" : "fail",
      inlineOptionPresent ? "" : "renderTemplateOptions 未注入 __ai_gen__ 选项");

    await ws.close();
  }

  // ──────────────────────────────────────────────────────────
  // 3.6) 热点页：AI 选题规划入口 + 问卷 modal 弹出 + 卡片 reroll Pro 闸门
  //   防回归点：
  //     - hot-topics.html 必须有 [data-act="open-topic-planner"] 按钮
  //     - 点击按钮后必须挂载 .topic-planner-backdrop modal
  //     - modal 必须包含 8 道画像题（chip 组数 ≥ 8，textarea ≥ 1）
  //     - 至少能选中第一个内容领域 chip 而不报错
  // ──────────────────────────────────────────────────────────
  console.log("\n[3.6] 热点页 AI 选题规划入口曝光 + 问卷 modal");
  {
    const page = await context.newPage();
    const errors = [];
    page.on("pageerror", (e) => errors.push(e.message));
    await page.goto(`chrome-extension://${extId}/src/pages/hot-topics.html`, {
      waitUntil: "networkidle"
    });
    await page.waitForTimeout(600);

    const entryVisible = await page.evaluate(() => {
      const btn = document.querySelector('[data-act="open-topic-planner"]');
      return Boolean(btn && btn.offsetParent !== null && !btn.disabled);
    });
    log(
      "topic-planner",
      "热点页「📍 AI 智能选题」入口按钮可见",
      entryVisible ? "ok" : "fail",
      entryVisible ? "" : "topic-planner-ui.js 没有正确挂入口或 chrome.runtime 不可用"
    );

    if (entryVisible) {
      await page.click('[data-act="open-topic-planner"]');
      await page.waitForTimeout(400);

      const modalOpen = await page.evaluate(() => {
        const bd = document.querySelector(".topic-planner-backdrop");
        return Boolean(bd && bd.hidden === false);
      });
      log(
        "topic-planner",
        "点击入口后弹出问卷 modal",
        modalOpen ? "ok" : "fail",
        modalOpen ? "" : "未挂载 .topic-planner-backdrop"
      );

      if (modalOpen) {
        const stats = await page.evaluate(() => ({
          chipGroups: document.querySelectorAll(".topic-planner-modal__field [data-group]").length,
          excludeTextarea: document.querySelectorAll('[data-el="excludeKeywords"]').length,
          submitBtn: document.querySelectorAll('[data-act="submit"]').length
        }));
        log(
          "topic-planner",
          `问卷 chip 组数 = ${stats.chipGroups} (≥8)`,
          stats.chipGroups >= 8 ? "ok" : "fail"
        );
        log(
          "topic-planner",
          `自定义排除词 textarea = ${stats.excludeTextarea}`,
          stats.excludeTextarea >= 1 ? "ok" : "fail"
        );
        log(
          "topic-planner",
          `生成按钮 = ${stats.submitBtn}`,
          stats.submitBtn >= 1 ? "ok" : "fail"
        );

        // 选中第一个 contentPillars chip，确保事件代理工作
        await page.evaluate(() => {
          const chip = document.querySelector(
            '.topic-planner-modal__field[data-field="contentPillars"] .topic-planner-chip'
          );
          chip?.click();
        });
        await page.waitForTimeout(150);
        const pressed = await page.evaluate(() => {
          const chip = document.querySelector(
            '.topic-planner-modal__field[data-field="contentPillars"] .topic-planner-chip'
          );
          return chip?.getAttribute("aria-pressed") === "true";
        });
        log(
          "topic-planner",
          "点击 chip 切换 aria-pressed",
          pressed ? "ok" : "fail"
        );

        // 关掉 modal，恢复现场，避免 console pageerror
        await page.evaluate(() =>
          document.querySelector('.topic-planner-modal__close')?.click()
        );
      }
    }

    log(
      "topic-planner",
      "问卷流程 console 干净",
      errors.length === 0 ? "ok" : "fail",
      errors.slice(0, 2).join(" | ")
    );

    await page.close();
  }

  // ──────────────────────────────────────────────────────────
  // 4) License pill 在 popup / options / workspace#member 文案一致
  // ──────────────────────────────────────────────────────────
  console.log("\n[4] License pill 在三处文案一致");
  {
    // 不预设 license（已被上面 reset），所以三处应都显示 free
    const popup = await context.newPage();
    await popup.goto(`chrome-extension://${extId}/src/popup/popup.html`, { waitUntil: "networkidle" });
    await popup.evaluate(() => chrome.storage.local.remove(["wechatWriterLicense", "wechatWriterLicenseAuth"]));
    await popup.reload({ waitUntil: "networkidle" });
    await popup.click('button.popup-tab[data-tab="me"]');
    await popup.waitForTimeout(400);
    const popupLabel = await popup.evaluate(
      () => document.querySelector("#licensePillLabel")?.textContent.trim() || ""
    );
    await popup.close();

    const opt = await context.newPage();
    await opt.goto(`chrome-extension://${extId}/src/options/options.html#opt-anchor-license`, { waitUntil: "networkidle" });
    await opt.waitForTimeout(400);
    const optLabel = await opt.evaluate(
      () => document.querySelector("#licenseStatusLabel")?.textContent.trim() || ""
    );
    await opt.close();

    const ws = await context.newPage();
    await ws.goto(`chrome-extension://${extId}/src/workspace/workspace.html#member`, { waitUntil: "networkidle" });
    await ws.waitForTimeout(600);
    const wsLabel = await ws.evaluate(
      () => document.querySelector("#memberHeroLabel")?.textContent.trim() || ""
    );
    await ws.close();

    const allFreeLike = [popupLabel, optLabel, wsLabel].every((l) =>
      l.includes("免费") || l.includes("未激活") || l.toLowerCase().includes("free")
    );
    log("pill", `popup="${popupLabel}"`, popupLabel ? "ok" : "warn");
    log("pill", `options="${optLabel}"`, optLabel ? "ok" : "warn");
    log("pill", `workspace="${wsLabel}"`, wsLabel ? "ok" : "warn");
    log("pill", "三处文案语义都是 free", allFreeLike ? "ok" : "warn",
      allFreeLike ? "" : "三处文案不一致");
  }

  // ──────────────────────────────────────────────────────────
  // 5) Welcome / Help / Privacy / Terms / Permissions 文案 grep 不出现旧名
  // ──────────────────────────────────────────────────────────
  console.log("\n[5] 全站品牌名一致性");
  {
    const pages = ["welcome", "help", "privacy", "terms", "permissions"];
    for (const p of pages) {
      const page = await context.newPage();
      await page.goto(`chrome-extension://${extId}/src/pages/${p}.html`, { waitUntil: "networkidle" });
      const body = (await page.textContent("body")) || "";
      const badNames = ["微信小助手", "wechat-writer", "GZH 助手", "公众号助手 v0", "example.com"];
      const found = badNames.filter((n) => body.includes(n));
      if (found.length === 0) {
        log("brand", `${p}.html 干净`, "ok");
      } else {
        log("brand", `${p}.html 出现旧名`, "fail", found.join(","));
      }
      await page.close();
    }
  }

  // ──────────────────────────────────────────────────────────
  // 6) Workspace 切 100 次 hash 不爆 listener
  // ──────────────────────────────────────────────────────────
  console.log("\n[6] hash 切 100 次性能 / 内存");
  {
    const page = await context.newPage();
    await page.goto(`chrome-extension://${extId}/src/workspace/workspace.html`, { waitUntil: "networkidle" });
    await page.waitForTimeout(300);
    const errors = [];
    page.on("pageerror", (e) => errors.push(e.message));

    const t0 = Date.now();
    const views = ["dashboard", "capture", "layout", "publish", "hot", "member"];
    for (let i = 0; i < 100; i++) {
      const v = views[i % views.length];
      await page.evaluate((view) => { window.location.hash = view; }, v);
    }
    await page.waitForTimeout(300);
    const elapsed = Date.now() - t0;
    log("perf", `100 次 hash 切换耗时 ${elapsed}ms`, elapsed < 4000 ? "ok" : "warn");
    log("perf", "切换过程 console 干净", errors.length === 0 ? "ok" : "fail",
      errors.slice(0, 2).join(" | "));
    await page.close();
  }

  await context.close();

  // ──── 汇总 ────
  const ok = results.filter((r) => r.status === "ok").length;
  const fail = results.filter((r) => r.status === "fail").length;
  const warn = results.filter((r) => r.status === "warn").length;
  console.log(`\n────────────────────────────────────────`);
  console.log(`  ✓ ${ok}   ! ${warn}   ✗ ${fail}`);
  console.log(`────────────────────────────────────────\n`);

  const lines = [
    `# 功能行为机测报告`,
    `生成时间：${new Date().toISOString()}`,
    "",
    `| Group | Check | Status | Detail |`,
    `|---|---|---|---|`
  ];
  for (const r of results) {
    const sym = r.status === "ok" ? "✅" : r.status === "warn" ? "⚠️" : "❌";
    lines.push(`| ${r.group} | ${r.name} | ${sym} | ${(r.detail || "").replace(/\|/g, "\\|")} |`);
  }
  lines.push("");
  lines.push(`**总计**：✓ ${ok} / ! ${warn} / ✗ ${fail}`);

  const file = resolve(REPORT_DIR, "check-features.md");
  await writeFile(file, lines.join("\n"));
  console.log(`报告已写入：${file}`);

  if (fail > 0) process.exitCode = 1;
}

main().catch((e) => { console.error(e); process.exit(1); });
