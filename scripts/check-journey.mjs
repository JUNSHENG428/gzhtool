#!/usr/bin/env node
/**
 * 端到端 user journey · 模拟真人操作 + 真实抓取 + mock LLM
 *
 * 流程：
 *   J1 - 安装扩展，打开 popup，看到 free 状态
 *   J2 - 真去抓一个公开网页（依次试候选 URL，直到拿到非空 capture）
 *   J3 - 打开 workspace，验证编辑器即时填入、内容完整
 *   J4 - 切换 6 套杂志母版，验证每套都自动套入排版
 *   J5 - mock 一个 LLM endpoint，触发 AI 改写，验证流程跑通 + 结构落到预览
 *
 * 每一步截图存在 dist/journey-shots/，最后输出 docs/JOURNEY_REPORT.md
 *
 * 不需要：真 OpenAI key、真公众号登录、真 Pro
 */

import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { mkdir, writeFile, rm } from "node:fs/promises";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "..");
const SHOTS_DIR = resolve(ROOT, "dist/journey-shots");
const REPORT = resolve(ROOT, "docs/JOURNEY_REPORT.md");
const USER_DATA_DIR = resolve(ROOT, "dist/check-reports/.user-data-journey");

// 候选 URL：免登录公开中文文章，按反爬难度从易到难
// 抓到的内容如果 block < 2 或字数 < 300 视为"抓失败"自动跳下一个
const CANDIDATE_URLS = [
  // 少数派 2025 年度征文（已 WebFetch 验证存在）
  "https://sspai.com/a/JZbWkJ",
  // MDN 中文文档（HTML 结构标准、绝无反爬）
  "https://developer.mozilla.org/zh-CN/docs/Web/HTML/Element/article",
  // Wikipedia 中文（最稳的 fallback）
  "https://zh.wikipedia.org/wiki/%E5%85%AC%E4%BC%97%E5%8F%B7"
];

const MIN_BLOCKS = 2;
const MIN_TEXT_LEN = 300;

const FAKE_PRO_LICENSE = {
  key: "GZHT-DEV9-FAKE-PR99",
  plan: "pro",
  status: "active",
  expiresAt: Date.now() + 365 * 24 * 3600 * 1000,
  features: {
    "wechat.multiAccount": true, "scrape.drission": true,
    "ai.advancedTemplates": true, "ai.templateGenerator": true,
    "ai.unlimitedDaily": true, "wechat.publish": true,
    "hot.advancedSources": true, "ai.batchRewrite": true, "ai.deAiBoost": true
  },
  dailyQuota: -1, signedAt: Date.now(), signature: "dev",
  verifiedAt: Date.now(), activatedAt: new Date().toISOString(),
  user: { id: "dev-user", email: "dev@docuearn.com" }
};

// Mock LLM 返回的 chat completion，content 是合法 article JSON
const MOCK_REWRITE_PAYLOAD = {
  choices: [{
    message: {
      content: JSON.stringify({
        title: "【AI 改写测试】知乎万赞答案的二创范式",
        subtitle: "从原稿到公众号的整段重述",
        lead: "这是一段由 mock LLM 返回的导语。如果你看到了这段文字，说明 AI 改写的整条流式 / 解析 / 渲染链路都通了。",
        sections: [
          {
            heading: "第一节 · 结构化叙述",
            paragraphs: [
              "Mock 返回的第一段——证明 normalizeArticle 能正确接住 sections.paragraphs 字段。",
              "Mock 返回的第二段——这一段会被排版主题加上 inline style，如果模板生效，你会看到字号、行距、颜色都按主题渲染。"
            ],
            bulletPoints: [
              "结构 1：能渲染 bullet",
              "结构 2：能渲染多条 bullet",
              "结构 3：bullet 也带主题样式"
            ],
            quote: "如果连 quote 块都能正确显示，那基本上每种段落类型都过了。"
          },
          {
            heading: "第二节 · 漏图兜底测试",
            paragraphs: [
              "这一段不显式引用图片，但 normalizeArticle 里的 injectMissingImages 应该会把原文图片补回来。"
            ]
          }
        ],
        closing: "测试结束。如果能看到这一段，说明 closing 字段也走通了。",
        cta: "（mock cta）",
        wechatTitleOptions: [
          "【备选 1】Mock 标题 · 短",
          "【备选 2】Mock 标题 · 中等长度，看下排版是否会自动换行处理",
          "【备选 3】Mock 标题 · 一种比较冗长的标题写法看下截断"
        ],
        keywords: ["mock", "测试", "改写", "排版", "公众号"]
      })
    }
  }]
};

import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

let shotIdx = 0;
async function shot(page, name, selector = null) {
  shotIdx += 1;
  const file = resolve(SHOTS_DIR, `${String(shotIdx).padStart(2, "0")}-${name}.png`);
  if (selector) {
    // 用 clip 而不是 element screenshot，避免 visibility 问题
    try {
      const box = await page.evaluate((sel) => {
        const el = document.querySelector(sel);
        if (!el) return null;
        el.scrollIntoView({ block: "center" });
        const r = el.getBoundingClientRect();
        return { x: Math.max(0, r.x), y: Math.max(0, r.y),
                 width: Math.min(1280, r.width), height: Math.min(800, r.height) };
      }, selector);
      if (box && box.width > 50 && box.height > 50) {
        await page.waitForTimeout(150);
        await page.screenshot({ path: file, clip: box });
        return file;
      }
    } catch {}
  }
  await page.screenshot({ path: file, fullPage: false });
  return file;
}

async function fileHash(path) {
  const buf = await readFile(path);
  return createHash("sha1").update(buf).digest("hex").slice(0, 12);
}

const findings = [];
const log = (group, name, status, detail = "") => {
  findings.push({ group, name, status, detail });
  const sym = status === "ok" ? "✓" : status === "warn" ? "!" : "✗";
  console.log(`  ${sym} [${group}] ${name}${detail ? ` — ${detail}` : ""}`);
};

async function main() {
  const { chromium } = await import("playwright").catch(() => {
    console.error("× 没装 playwright");
    process.exit(1);
  });

  // 清掉上次的 user data dir 防止状态污染
  await rm(USER_DATA_DIR, { recursive: true, force: true });
  await rm(SHOTS_DIR, { recursive: true, force: true });
  await mkdir(SHOTS_DIR, { recursive: true });

  const context = await chromium.launchPersistentContext(USER_DATA_DIR, {
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

  let sw = context.serviceWorkers()[0] || await context.waitForEvent("serviceworker", { timeout: 15000 });
  const extId = new URL(sw.url()).hostname;
  console.log(`Extension ID: ${extId}\n`);

  // ════════════════════════════════════════════════════════
  // J1 · 打开 popup，看到 free 状态
  // ════════════════════════════════════════════════════════
  console.log("═════ J1 · 首次打开 popup ═════");
  const popup = await context.newPage();
  await popup.goto(`chrome-extension://${extId}/src/popup/popup.html`, { waitUntil: "networkidle" });
  await popup.waitForTimeout(800);
  await popup.click('button.popup-tab[data-tab="me"]');
  await popup.waitForTimeout(500);
  const freeLabel = await popup.evaluate(() =>
    document.querySelector("#licensePillLabel")?.textContent?.trim() || ""
  );
  log("J1", `popup 我的页 license 文案 = "${freeLabel}"`,
    freeLabel === "免费版" ? "ok" : "warn");
  await shot(popup, "popup-me-free");
  await popup.close();

  // ════════════════════════════════════════════════════════
  // J2 · 真去抓一个公开网页（依次尝试候选）
  // ════════════════════════════════════════════════════════
  console.log("\n═════ J2 · 真实抓取（按候选 URL 顺序尝试）═════");
  const trigger = await context.newPage();
  await trigger.goto(`chrome-extension://${extId}/src/popup/popup.html`, { waitUntil: "networkidle" });
  await trigger.waitForTimeout(400);

  // J2-pre · 先验证一下新加的健全检查：故意喂一个 302→错误页的 URL
  console.log("  [pre-check] 验证错误页兜底（喂 sspai.com/post/96000 → 302 /whoops）");
  const errCheck = await trigger.evaluate(async () => {
    return await new Promise((resolve) => {
      const t = setTimeout(() => resolve({ ok: false, error: "timeout" }), 25000);
      chrome.runtime.sendMessage(
        { type: "SCRAPE_BACKGROUND_AND_IMPORT", payload: { url: "https://sspai.com/post/96000" } },
        (resp) => { clearTimeout(t); resolve(resp || { ok: false, error: "no-resp" }); }
      );
    });
  });
  const errMsg = typeof errCheck?.error === "string"
    ? errCheck.error
    : (errCheck?.error?.message || JSON.stringify(errCheck?.error || ""));
  const wasRejected = !errCheck?.ok &&
    (errMsg.includes("内容太少") || errMsg.includes("登录墙") || errMsg.includes("反爬") || errMsg.includes("正文为空"));
  log("J2-guard", "错误页/302 抓取被健全检查拦截", wasRejected ? "ok" : "fail",
    wasRejected ? errMsg.slice(0, 80) : `期望抛错被拦，实际：${JSON.stringify(errCheck).slice(0, 120)}`);

  let captureResult = null;
  let usedUrl = null;
  for (const url of CANDIDATE_URLS) {
    console.log(`  → 尝试 ${url}`);
    const result = await trigger.evaluate(async (target) => {
      try {
        return await new Promise((resolve) => {
          const t = setTimeout(() => resolve({ ok: false, error: "timeout 30s" }), 30000);
          chrome.runtime.sendMessage(
            { type: "SCRAPE_BACKGROUND_AND_IMPORT", payload: { url: target } },
            (resp) => {
              clearTimeout(t);
              resolve(resp || { ok: false, error: "no response" });
            }
          );
        });
      } catch (e) {
        return { ok: false, error: String(e?.message || e) };
      }
    }, url);

    if (result?.ok && result?.data?.blocks?.length) {
      const data = result.data;
      const textLen = data.blocks
        .filter((b) => b.type === "paragraph" || b.type === "heading")
        .map((b) => String(b.text || "").length)
        .reduce((a, b) => a + b, 0);
      // 健全检查：抓到的不能是错误页 / 首页 fallback
      if (data.blocks.length < MIN_BLOCKS || textLen < MIN_TEXT_LEN) {
        log("J2", `抓取看似成功但内容太少：${url}`, "warn",
          `blocks=${data.blocks.length} 字数=${textLen} → 跳下一个候选`);
        continue;
      }
      captureResult = data;
      usedUrl = url;
      log("J2", `抓取成功：${url}`, "ok",
        `title="${(data.title || "").slice(0, 24)}…" blocks=${data.blocks.length} 字数=${textLen}`);
      break;
    } else {
      log("J2", `抓取失败：${url}`, "warn", String(result?.error || "未知错误").slice(0, 80));
    }
  }

  if (!captureResult) {
    log("J2", "所有候选 URL 都抓取失败", "fail",
      "可能是网络受限 / 站点反爬升级 / DrissionPage helper 未启动");
    await context.close();
    await writeReport();
    process.exit(1);
  }

  // 详细评估抓取质量
  console.log("\n  · 抓取质量分析：");
  const meta = {
    title: captureResult.title || "",
    url: captureResult.url || "",
    siteName: captureResult.siteName || captureResult.site || "",
    author: captureResult.author || "",
    blocks: captureResult.blocks || [],
    images: captureResult.images || []
  };
  log("J2-quality", `标题非空`, meta.title ? "ok" : "fail", meta.title);
  log("J2-quality", `站点识别`, meta.siteName ? "ok" : "warn", meta.siteName);
  log("J2-quality", `作者识别`, meta.author ? "ok" : "warn", meta.author || "(空)");
  log("J2-quality", `block 数量`, meta.blocks.length >= 3 ? "ok" : "warn", `${meta.blocks.length} 块`);
  log("J2-quality", `图片识别`, meta.images.length > 0 ? "ok" : "warn", `${meta.images.length} 张`);
  // 文本量（粗估）
  const textLen = meta.blocks
    .filter((b) => b.type === "paragraph" || b.type === "heading")
    .map((b) => String(b.text || "").length)
    .reduce((a, b) => a + b, 0);
  log("J2-quality", `正文字数`, textLen >= 200 ? "ok" : "warn", `${textLen} 字`);

  await trigger.close();

  // ════════════════════════════════════════════════════════
  // J3 · 打开 workspace 验证编辑器即时填入
  // ════════════════════════════════════════════════════════
  console.log("\n═════ J3 · 打开编辑台 → 验证内容填入 ═════");
  const ws = await context.newPage();
  const wsErrors = [];
  ws.on("pageerror", (e) => wsErrors.push(`pageerror: ${e.message}`));
  ws.on("console", (m) => {
    if (m.type() !== "error") return;
    const txt = m.text();
    // 外域资源 4xx/5xx（图床防盗链等）不计扩展错
    if (/Failed to load resource.*\b(40[0-9]|5[0-9]{2})\b/i.test(txt)) return;
    wsErrors.push(txt);
  });
  // 拦截真正的 page network failure 而不是图片 403
  ws.on("requestfailed", (req) => {
    if (req.url().startsWith(`chrome-extension://${extId}`)) {
      wsErrors.push(`reqfail (own): ${req.url()} ${req.failure()?.errorText}`);
    }
  });

  const t0 = Date.now();
  await ws.goto(`chrome-extension://${extId}/src/workspace/workspace.html?import=1#layout`, {
    waitUntil: "networkidle"
  });
  await ws.waitForTimeout(1500); // 给 import + render 一点时间

  // 检查标题/作者输入是否填入
  const titleVal = await ws.inputValue("#titleInput").catch(() => "");
  const authorVal = await ws.inputValue("#authorInput").catch(() => "");
  const previewLen = await ws.evaluate(() =>
    document.querySelector("#wechatPreview")?.innerHTML?.length || 0
  );
  // 字数提示是否包含 HTML 字符 / 20000 这条警告
  const wordCountText = await ws.evaluate(() =>
    document.querySelector("#editorWordCount")?.textContent || ""
  );
  const elapsed = Date.now() - t0;

  log("J3", `编辑器加载 + 内容回填耗时 ${elapsed}ms`,
    elapsed < 8000 ? "ok" : "warn");
  log("J3", `标题输入框被自动填入`, titleVal ? "ok" : "fail",
    titleVal ? `"${titleVal.slice(0, 30)}…" (${titleVal.length}/64)` : "空");
  log("J3", `作者输入框被自动填入`, authorVal ? "ok" : "fail",
    authorVal ? `"${authorVal}" (${authorVal.length}/16)` : "空（scrape 链路没接住 author）");
  log("J3", `公众号预览有内容（≥500 字符 HTML）`,
    previewLen >= 500 ? "ok" : "fail", `${previewLen} chars`);
  log("J3", `字数面板显示 HTML 字符 / 20000`,
    wordCountText.includes("HTML") && wordCountText.includes("20,000") ? "ok" : "fail",
    wordCountText.slice(0, 80));

  await shot(ws, "workspace-after-import");

  // ════════════════════════════════════════════════════════
  // J4 · 切换 6 套杂志母版，每套都自动套入排版
  // ════════════════════════════════════════════════════════
  console.log("\n═════ J4 · 切换 6 套杂志母版 ═════");
  // wechatPreview 在 #publish 视图，必须先切过去才能截到肉眼差异
  await ws.evaluate(() => { window.location.hash = "#publish"; });
  await ws.waitForTimeout(600);
  const previewVisible = await ws.evaluate(() => {
    const el = document.querySelector("#wechatPreview");
    if (!el) return { found: false };
    const r = el.getBoundingClientRect();
    return { found: true, w: r.width, h: r.height, top: r.top };
  });
  log("J4", `切到「发布」视图后预览面板可见`,
    previewVisible.found && previewVisible.w > 100 ? "ok" : "fail",
    JSON.stringify(previewVisible));

  const themeOpts = await ws.evaluate(() =>
    Array.from(document.querySelectorAll("#themeSelect option")).map((o) => ({
      value: o.value, label: o.textContent.trim()
    }))
  );
  log("J4", `themeSelect 总数 = ${themeOpts.length}`, "ok",
    themeOpts.map(t => t.value).join(", "));

  // 6 套杂志母版的 ID
  const MAGAZINE_IDS = ["editorial-newyorker", "ink-classic", "wired-neon",
    "monocle-soft", "clean-card", "paper-zine"];

  const themeShots = {};
  for (const themeId of MAGAZINE_IDS) {
    const exists = themeOpts.find((o) => o.value === themeId);
    if (!exists) {
      log("J4", `主题 ${themeId} 不在 select 中`, "fail");
      continue;
    }
    // themeSelect 在 layout 视图里（隐藏），用 evaluate dispatch change
    await ws.evaluate((id) => {
      const sel = document.querySelector("#themeSelect");
      if (!sel) return;
      sel.value = id;
      sel.dispatchEvent(new Event("change", { bubbles: true }));
    }, themeId);
    await ws.waitForTimeout(600);
    // 抓取预览的 inline-style 指纹 + style 字符串签名
    const fingerprint = await ws.evaluate(() => {
      const root = document.querySelector("#wechatPreview");
      if (!root) return null;
      const all = root.querySelectorAll("[style]");
      const styles = Array.from(all).map((el) => el.getAttribute("style") || "").join("|");
      // 把整段 style 字符串做 hash 签名 → 主题切换前后必须不同
      let h = 0;
      for (let i = 0; i < styles.length; i++) {
        h = ((h << 5) - h + styles.charCodeAt(i)) | 0;
      }
      return {
        len: root.innerHTML.length,
        styledNodes: all.length,
        styleSig: h.toString(16)
      };
    });
    if (fingerprint && fingerprint.styledNodes > 0) {
      log("J4", `主题 ${exists.label}（${themeId}）`, "ok",
        `inline-style ${fingerprint.styledNodes} 节点 / sig=${fingerprint.styleSig}`);
    } else {
      log("J4", `主题 ${exists.label}（${themeId}）`, "fail",
        "切换后 preview 无 inline-style");
    }
    // 截 #wechatPreview 区域而不是整个页面，保证主题差异可见
    const file = await shot(ws, `theme-${themeId}`, "#wechatPreview");
    themeShots[themeId] = { fingerprint, file, sig: fingerprint?.styleSig };
  }

  // 6 套主题样式签名必须互不相同
  const sigs = Object.values(themeShots).map((t) => t.sig).filter(Boolean);
  const uniqueSigs = new Set(sigs);
  log("J4", `6 套主题样式签名互异性`,
    uniqueSigs.size === sigs.length ? "ok" : "fail",
    `${uniqueSigs.size}/${sigs.length} 个唯一签名`);

  // 6 套主题截图文件 hash 视觉差异检查
  // 注意：styleSig 已确认 CSS 不同；若截图相同说明肉眼差异太小（设计反馈），降级为 warn
  const shotHashes = await Promise.all(
    Object.entries(themeShots).map(async ([id, s]) => ({ id, hash: await fileHash(s.file) }))
  );
  const uniqueShots = new Set(shotHashes.map((h) => h.hash));
  // 找出视觉重复的主题对
  const dupGroups = {};
  for (const { id, hash } of shotHashes) {
    (dupGroups[hash] ||= []).push(id);
  }
  const dupPairs = Object.values(dupGroups).filter((g) => g.length > 1);
  if (uniqueShots.size === shotHashes.length) {
    log("J4", `6 套主题截图视觉差异`, "ok",
      `${uniqueShots.size}/${shotHashes.length} 张图视觉不同`);
  } else {
    log("J4", `6 套主题肉眼差异不足`, "warn",
      `${uniqueShots.size}/${shotHashes.length} 张图唯一；视觉相似的主题对：${dupPairs.map((g) => g.join("≈")).join(", ")} · CSS 签名都不同（说明真有套色），但截图区域看不出 → 建议设计上拉大字号/色相差异`);
  }

  // ════════════════════════════════════════════════════════
  // J5 · Mock LLM → 触发 AI 改写
  // ════════════════════════════════════════════════════════
  console.log("\n═════ J5 · Mock LLM 触发 AI 改写 ═════");

  // 1. 注入 fake-pro（绕过 quota）+ 配置一个可识别的 mock baseUrl + apiKey
  await ws.evaluate(async ({ lic }) => {
    return new Promise((resolve) => {
      chrome.storage.local.set({
        wechatWriterLicense: lic,
        wechatWriterLicenseAuth: { token: "dev", user: lic.user, issuedAt: Date.now() },
        wechatWriterSettings: {
          apiBaseUrl: "https://mock.openai.test/v1/chat/completions",
          apiKey: "sk-mock-key-1234567890",
          model: "gpt-mock",
          temperature: 0.8
        }
      }, () => resolve());
    });
  }, { lic: FAKE_PRO_LICENSE });

  // 2. 拦截 mock baseUrl 的所有 POST，返回我们准备好的 chat completion
  let mockHits = 0;
  await context.route("https://mock.openai.test/**", async (route) => {
    mockHits += 1;
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(MOCK_REWRITE_PAYLOAD)
    });
  });

  // 3. 给 SW 也注入 fetch 拦截（service-worker 自己 fetch 不会走 page.route）
  // 实际上 page.route 只拦 page 发起的 fetch；SW 的 fetch 由 chromium 自己分派，
  // playwright 在 launchPersistentContext + extensions 模式下能拦 SW
  // 但保险起见，直接走 REWRITE_ARTICLE 消息从 page 发，让 SW 用 page session？
  // 不行，AI 改写本身是 SW 在 fetch。我们必须让 page.route 同时拦 SW。
  // playwright 1.40+ 默认 launchPersistentContext.route 会拦 SW，但 channel:chromium 可能不会。
  // 兜底：试一下，看 mockHits 是否 > 0；如果 0，明确告知"机测到此为止"。

  // 重新加载让 settings 生效
  await ws.reload({ waitUntil: "networkidle" });
  await ws.waitForTimeout(800);
  // 改写按钮在「编辑排版」视图
  await ws.evaluate(() => { window.location.hash = "#layout"; });
  await ws.waitForTimeout(500);

  // 4. 点 AI 改写按钮
  const rewriteBtn = ws.locator("#rewriteButton");
  if (await rewriteBtn.isVisible()) {
    log("J5", "AI 改写按钮可见", "ok");
    await shot(ws, "before-rewrite");
    const t1 = Date.now();
    await rewriteBtn.click();

    // 等改写完成：标题 / 预览 / lead 任一被替换
    let succeeded = false;
    for (let i = 0; i < 60; i++) { // 最多等 30s
      await ws.waitForTimeout(500);
      const currentTitle = await ws.inputValue("#titleInput").catch(() => "");
      if (currentTitle.includes("AI 改写测试") || currentTitle.includes("Mock")) {
        succeeded = true;
        break;
      }
    }
    const elapsedR = Date.now() - t1;
    log("J5", `mock LLM 命中次数`, mockHits > 0 ? "ok" : "warn", `${mockHits} 次`);
    log("J5", `AI 改写流程完成`,
      succeeded ? "ok" : (mockHits > 0 ? "fail" : "warn"),
      `耗时 ${elapsedR}ms${succeeded ? "" : "（标题没变成 mock 内容）"}`);
    await shot(ws, "after-rewrite");

    if (succeeded) {
      // 验证 mock 数据真的渲染到 preview
      const previewSnippet = await ws.evaluate(() => {
        const root = document.querySelector("#wechatPreview");
        return root ? root.textContent.slice(0, 600) : "";
      });
      const leadOk = previewSnippet.includes("由 mock LLM 返回的导语");
      const sectionOk = previewSnippet.includes("结构化叙述") || previewSnippet.includes("漏图兜底");
      log("J5", "mock 导语渲染到 preview", leadOk ? "ok" : "fail");
      log("J5", "mock 章节标题渲染到 preview", sectionOk ? "ok" : "fail");
    }
  } else {
    log("J5", "AI 改写按钮不可见", "fail", "可能 layout 视图未激活");
  }

  if (wsErrors.length === 0) {
    log("J5", "整个 J3-J5 过程 console 干净", "ok");
  } else {
    log("J5", "整个 J3-J5 过程有 console error", "fail",
      wsErrors.slice(0, 2).join(" | ").slice(0, 200));
  }

  await ws.close();
  await context.close();
  await writeReport(usedUrl);
}

async function writeReport(usedUrl) {
  const ok = findings.filter((r) => r.status === "ok").length;
  const warn = findings.filter((r) => r.status === "warn").length;
  const fail = findings.filter((r) => r.status === "fail").length;

  console.log(`\n────────────────────────────────────────`);
  console.log(`  ✓ ${ok}   ! ${warn}   ✗ ${fail}`);
  console.log(`────────────────────────────────────────`);

  const lines = [
    `# 端到端 user journey 报告`,
    ``,
    `生成时间：${new Date().toISOString()}`,
    usedUrl ? `真实抓取的 URL：${usedUrl}` : "",
    ``,
    `**总计**：✓ ${ok} ・ ! ${warn} ・ ✗ ${fail}`,
    ``,
    `所有截图存在：\`dist/journey-shots/\``,
    ``,
    `| Stage | Check | Status | Detail |`,
    `|---|---|---|---|`
  ];
  for (const r of findings) {
    const sym = r.status === "ok" ? "✅" : r.status === "warn" ? "⚠️" : "❌";
    lines.push(`| ${r.group} | ${r.name} | ${sym} | ${(r.detail || "").replace(/\|/g, "\\|").slice(0, 200)} |`);
  }
  await writeFile(REPORT, lines.join("\n"));
  console.log(`报告：${REPORT}`);
  console.log(`截图：${SHOTS_DIR}\n`);

  if (fail > 0) process.exitCode = 1;
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
