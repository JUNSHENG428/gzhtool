import { test as base, expect, chromium, type BrowserContext, type Page, type Worker } from "playwright/test";
import { execFileSync } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";

export const repoRoot = path.resolve(__dirname, "../../..");
export const articleFixtureUrl = "https://techcrunch.com/runbi-fixtures/local-article";

export type ExtensionHarness = {
  context: BrowserContext;
  extensionId: string;
  serviceWorker: Worker;
  articleFixtureUrl: string;
};

type Fixtures = {
  extension: ExtensionHarness;
};

export const test = base.extend<Fixtures>({
  extension: async ({}, use, testInfo) => {
      execFileSync("npm", ["run", "build:floating-ball"], {
        cwd: repoRoot,
        stdio: "inherit"
      });

      const safeTitle = testInfo.title
        .replace(/[^\p{L}\p{N}.-]+/gu, "-")
        .replace(/^-+|-+$/g, "")
        .slice(0, 80);
      const userDataDir = path.join(
        repoRoot,
        "dist",
        "e2e-user-data",
        `${testInfo.workerIndex}-${testInfo.retry}-${safeTitle}`
      );
      await fs.rm(userDataDir, { recursive: true, force: true });
      await fs.mkdir(userDataDir, { recursive: true });

      const context = await chromium.launchPersistentContext(userDataDir, {
        headless: false,
        channel: "chromium",
        args: [
          `--disable-extensions-except=${repoRoot}`,
          `--load-extension=${repoRoot}`,
          "--no-first-run",
          "--no-default-browser-check"
        ],
        viewport: { width: 1365, height: 900 },
        recordVideo: {
          dir: path.join(repoRoot, "dist", "e2e-videos"),
          size: { width: 1365, height: 900 }
        }
      });

      await installArticleFixtureRoutes(context);
      const serviceWorker = await waitForServiceWorker(context);
      const extensionId = new URL(serviceWorker.url()).hostname;

      await use({
        context,
        extensionId,
        serviceWorker,
        articleFixtureUrl
      });

      await context.close();
  }
});

export { expect };

export async function waitForServiceWorker(context: BrowserContext): Promise<Worker> {
  const existing = context
    .serviceWorkers()
    .find((worker) => worker.url().startsWith("chrome-extension://"));
  if (existing) return existing;
  return context.waitForEvent("serviceworker", {
    predicate: (worker) => worker.url().startsWith("chrome-extension://"),
    timeout: 15_000
  });
}

export async function openExtensionPage(extension: ExtensionHarness, relativePath: string): Promise<Page> {
  const page = await extension.context.newPage();
  await page.goto(`chrome-extension://${extension.extensionId}/${relativePath}`, {
    waitUntil: "domcontentloaded"
  });
  return page;
}

export async function sendRuntimeMessage(page: Page, message: unknown): Promise<any> {
  return page.evaluate((payload) => {
    return new Promise((resolve) => {
      chrome.runtime.sendMessage(payload, (response) => {
        resolve(response || { ok: false, error: chrome.runtime.lastError?.message || "no response" });
      });
    });
  }, message);
}

export async function setExtensionStorage(page: Page, values: Record<string, unknown>): Promise<void> {
  await page.evaluate((payload) => {
    return new Promise<void>((resolve) => {
      chrome.storage.local.set(payload, () => resolve());
    });
  }, values);
}

export async function getExtensionStorage(page: Page, keys: string[]): Promise<Record<string, unknown>> {
  return page.evaluate((storageKeys) => {
    return new Promise<Record<string, unknown>>((resolve) => {
      chrome.storage.local.get(storageKeys, (data) => resolve(data || {}));
    });
  }, keys);
}

export async function waitForTaskDone(
  page: Page,
  type: "capture" | "rewrite",
  titlePart?: string,
  startedAfter = 0
) {
  let latest: any = null;
  await expect
    .poll(
      async () => {
        const response = await sendRuntimeMessage(page, { type: "LIST_TASKS" });
        const data = response?.data || {};
        const tasks = [...(data.done || []), ...(data.running || []), ...(data.pending || [])];
        latest = tasks.find((task) => {
          if (task.type !== type) return false;
          if (startedAfter && Number(task.startedAt || 0) < startedAfter) return false;
          if (!titlePart) return true;
          return String(task.articleTitle || "").includes(titlePart);
        });
        return latest?.status || "missing";
      },
      {
        timeout: 75_000,
        intervals: [100, 250, 500, 1_000]
      }
    )
    .toBe("done");
  return latest;
}

export async function installServiceWorkerAiMock(
  extension: ExtensionHarness,
  payload: unknown
): Promise<void> {
  const worker = await waitForServiceWorker(extension.context);
  await worker.evaluate((mockPayload) => {
    const g = globalThis as any;
    const originalFetch = g.__runbiOriginalFetch || globalThis.fetch.bind(globalThis);
    g.__runbiOriginalFetch = originalFetch;
    g.__runbiAiMockHits = [];
    globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (/api\.openai\.com|api\.deepseek\.com|dashscope\.aliyuncs\.com/i.test(url)) {
        g.__runbiAiMockHits.push({
          url,
          method: init?.method || "GET",
          body: typeof init?.body === "string" ? init.body.slice(0, 4_000) : "",
          at: Date.now()
        });
        return new Response(JSON.stringify(mockPayload), {
          status: 200,
          headers: { "Content-Type": "application/json" }
        });
      }
      return originalFetch(input as any, init);
    };
  }, payload);
}

export async function getServiceWorkerAiMockHits(extension: ExtensionHarness) {
  const worker = await waitForServiceWorker(extension.context);
  return worker.evaluate(() => (globalThis as any).__runbiAiMockHits || []);
}

export async function collectVisibleTexts(page: Page) {
  return page.evaluate(() => {
    const seen = new Set<string>();
    const out: Array<{ tag: string; text: string; role: string; id: string; classes: string }> = [];
    const isVisible = (el: Element) => {
      const rect = el.getBoundingClientRect();
      const style = window.getComputedStyle(el);
      return rect.width > 0 && rect.height > 0 && style.visibility !== "hidden" && style.display !== "none";
    };
    for (const el of Array.from(document.body.querySelectorAll("button,a,label,h1,h2,h3,p,span,small,input,textarea,option"))) {
      if (!isVisible(el)) continue;
      const text =
        el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement
          ? el.placeholder || el.value || ""
          : (el as HTMLElement).innerText || el.textContent || "";
      const normalized = text.replace(/\s+/g, " ").trim();
      if (!normalized || normalized.length > 180 || seen.has(normalized)) continue;
      seen.add(normalized);
      out.push({
        tag: el.tagName.toLowerCase(),
        text: normalized,
        role: el.getAttribute("role") || "",
        id: el.id || "",
        classes: el.className ? String(el.className).slice(0, 120) : ""
      });
    }
    return out;
  });
}

export function fakeYearlyLicense() {
  const now = Date.now();
  const features = {
    "wechat.multiAccount": true,
    "scrape.drission": true,
    "ai.advancedTemplates": true,
    "ai.templateGenerator": true,
    "ai.unlimitedDaily": true,
    "wechat.publish": true,
    "hot.advancedSources": true,
    "ai.batchRewrite": true,
    "ai.deAiBoost": true,
    "ai.voiceMimic": true,
    "ai.bringYourOwnKey": true,
    "ai.platformLlm.economy": true,
    "ai.platformLlm.standard": true,
    "ai.platformLlm.flagship": true
  };
  return {
    key: "GZHT-DEV9-FAKE-PR99",
    plan: "yearly",
    status: "active",
    expiresAt: now + 365 * 24 * 60 * 60 * 1_000,
    features,
    dailyQuota: -1,
    signedAt: now,
    signature: "dev-fake-signature",
    verifiedAt: now,
    activatedAt: new Date(now).toISOString(),
    user: { id: "dev-user", email: "dev@docuearn.com" }
  };
}

async function installArticleFixtureRoutes(context: BrowserContext): Promise<void> {
  await context.route("**/runbi-fixtures/local-article**", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "text/html; charset=utf-8",
      body: articleFixtureHtml()
    });
  });
  await context.route("**/runbi-fixtures/cover.jpg**", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "image/svg+xml",
      body: `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="630"><rect width="1200" height="630" fill="#173722"/><text x="90" y="330" font-size="72" fill="#f7f5ef" font-family="serif">Runbi E2E Fixture</text></svg>`
    });
  });
}

function articleFixtureHtml() {
  return `<!doctype html>
<html lang="zh-CN">
  <head>
    <meta charset="utf-8" />
    <title>Runbi E2E Fixture: AI 工具进入内容团队的真实拐点</title>
    <meta name="description" content="一篇本地 Playwright fixture，用于稳定验证润笔抓取和 AI 改写链路。" />
    <meta name="author" content="林知远" />
    <meta property="og:site_name" content="Runbi Local Fixture" />
    <style>
      body { margin: 0; font-family: -apple-system, BlinkMacSystemFont, "PingFang SC", sans-serif; color: #17231d; background: #f7f5ef; }
      header, footer, aside, nav { padding: 20px; background: #eee8dc; }
      article { max-width: 760px; margin: 48px auto; padding: 0 24px 80px; background: white; }
      h1 { font-size: 40px; line-height: 1.2; padding-top: 40px; }
      p { font-size: 18px; line-height: 1.9; }
      figure { margin: 28px 0; }
      img { max-width: 100%; border-radius: 8px; }
      figcaption { color: #6b746e; font-size: 14px; }
      .byline { color: #5a6b60; }
    </style>
  </head>
  <body>
    <nav>导航噪声 · 首页 · 分类 · 订阅</nav>
    <article>
      <h1>AI 工具进入内容团队的真实拐点</h1>
      <p class="byline">作者：林知远 · Runbi Local Fixture · 2026-07-06</p>
      <p>过去一年，内容团队对 AI 工具的期待从“帮我快一点”变成了“帮我少返工”。真正的拐点并不是模型又多聪明，而是工作流开始围绕确定的步骤重新组织：抓取资料、理解结构、改写成适合公众号阅读的版本，再把排版和发布连接起来。</p>
      <p>这个变化对小团队尤其明显。一个两三人的创作者团队，以前要在浏览器、文档、排版工具和公众号后台之间来回复制；现在更重要的问题变成：每一步有没有明确反馈，失败时能不能知道卡在哪里，输出是否能直接进入下一步。</p>
      <figure>
        <img src="https://techcrunch.com/runbi-fixtures/cover.jpg" alt="内容团队工作流示意图" />
        <figcaption>本地 fixture 图片：用于断言抓取图片非空。</figcaption>
      </figure>
      <h2>从素材到草稿，最怕的是“看似成功”</h2>
      <p>抓取为空却显示完成，是最容易误导用户的体验。用户不会先去检查 DOM，也不会理解 service worker 是否休眠；他们只会看到按钮点了，页面没变，或者进入编辑台后正文是空的。对第一次安装插件的人来说，这种沉默失败会直接终止信任。</p>
      <blockquote>一个可靠的内容工具，首先要把失败变得可见，其次才是把成功变得漂亮。</blockquote>
      <p>因此 E2E 测试不能只检查“流程没有抛异常”。它必须断言标题、作者、正文、图片和原文链接都真实进入状态；还要确认 AI 改写不是空结构，至少有导语、章节和正文段落。否则测试通过只是在证明按钮还能点击。</p>
      <ul>
        <li>标题必须非空，避免公众号草稿列表不可识别。</li>
        <li>正文必须有足够字数，避免抓到登录墙或错误页。</li>
        <li>图片必须保留，避免后续封面流程被阻断。</li>
      </ul>
      <p>这篇 fixture 的长度、段落和图片都保持稳定，不依赖真实外站，所以适合反复验证“抓取 → 改写”的核心链路。</p>
    </article>
    <aside>相关阅读、广告位、订阅弹窗等噪声内容不应进入正文。</aside>
    <footer>页脚噪声</footer>
  </body>
</html>`;
}
