import fs from "node:fs/promises";
import path from "node:path";
import {
  collectVisibleTexts,
  expect,
  fakeYearlyLicense,
  getExtensionStorage,
  getServiceWorkerAiMockHits,
  installServiceWorkerAiMock,
  openExtensionPage,
  repoRoot,
  sendRuntimeMessage,
  setExtensionStorage,
  test,
  waitForTaskDone
} from "./fixtures/extension";

const mockRewritePayload = {
  choices: [
    {
      message: {
        content: JSON.stringify({
          title: "AI 改写测试：内容团队的新工作流",
          subtitle: "从抓取、改写到排版的稳定链路",
          lead: "这是一段由 E2E mock LLM 返回的导语，用来确认改写结果不是空内容。",
          sections: [
            {
              heading: "第一节：把失败变得可见",
              paragraphs: [
                "内容团队真正需要的不是一个孤立按钮，而是一条每一步都有反馈的流水线。",
                "当抓取结果、正文结构和图片都能被保留下来，后续改写才有可靠的输入。"
              ],
              bulletPoints: ["标题非空", "正文非空", "图片非空"],
              quote: "可靠的工具先让失败可见，再让成功漂亮。"
            },
            {
              heading: "第二节：改写要能直接进入排版",
              paragraphs: [
                "改写后的文章必须包含导语、章节和可渲染正文，否则它无法支撑公众号发布前的排版检查。"
              ]
            }
          ],
          closing: "这就是本次核心链路要守住的底线。",
          cta: "继续用润笔完成排版和发布前检查。",
          wechatTitleOptions: ["AI 改写测试：内容团队的新工作流", "抓取到改写，怎样避免假通过？"],
          keywords: ["E2E", "抓取", "AI 改写", "公众号"]
        })
      }
    }
  ]
};

const providerCases = [
  {
    name: "openai",
    apiBaseUrl: "https://api.openai.com/v1/chat/completions",
    model: "gpt-4.1-mini"
  },
  {
    name: "deepseek",
    apiBaseUrl: "https://api.deepseek.com/chat/completions",
    model: "deepseek-chat"
  },
  {
    name: "dashscope",
    apiBaseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions",
    model: "qwen-plus"
  }
];

test.describe("抓取 → AI 改写核心链路", () => {
  for (const provider of providerCases) {
    test(`本地 fixture 抓取非空，并用 mocked ${provider.name} 改写出结构化文章`, async ({
      extension
    }, testInfo) => {
      const control = await openExtensionPage(extension, "src/workspace/workspace.html#layout");
      const license = fakeYearlyLicense();
      await setExtensionStorage(control, {
        wechatWriterLicense: license,
        wechatWriterLicenseAuth: { token: "dev-fake-token", user: license.user, issuedAt: Date.now() },
        wechatWriterSettings: {
          aiSourceMode: "byok",
          apiBaseUrl: provider.apiBaseUrl,
          apiKey: "sk-e2e-mock",
          model: provider.model,
          temperature: 0.7,
          humanizeEnabled: false,
          useTaskCenter: true,
          defaultAudience: "公众号创作者",
          defaultTone: "清晰、克制、像真人编辑",
          defaultAngle: "解释 AI 工具进入内容团队后的真实变化",
          defaultLength: "medium"
        },
        wechatWriterSession: {
          lastSourceTabId: null,
          lastSourceTitle: "",
          lastSourceUrl: "",
          lastCapture: null,
          lastDraft: null,
          articleBundle: [],
          currentArticleIndex: 0,
          lastBodyHtml: "",
          lastArticleMeta: {},
          lastTheme: "editorial-green",
          selectedImageIndex: 0
        }
      });
      await installServiceWorkerAiMock(extension, mockRewritePayload);

      const fixturePage = await extension.context.newPage();
      await fixturePage.goto(extension.articleFixtureUrl, { waitUntil: "domcontentloaded" });
      await expect(fixturePage.locator("article h1")).toContainText("AI 工具进入内容团队的真实拐点");
      const sourceTabs = await control.evaluate((url) => {
        return new Promise<Array<{ id?: number; title?: string; url?: string }>>((resolve) => {
          chrome.tabs.query({ url }, (tabs) =>
            resolve(tabs.map((tab) => ({ id: tab.id, title: tab.title, url: tab.url })))
          );
        });
      }, extension.articleFixtureUrl);
      expect(sourceTabs[0]?.id).toBeTruthy();
      await setExtensionStorage(control, {
        wechatWriterSession: {
          lastSourceTabId: sourceTabs[0].id,
          lastSourceTitle: sourceTabs[0].title || "",
          lastSourceUrl: sourceTabs[0].url || extension.articleFixtureUrl,
          lastCapture: null,
          lastDraft: null,
          articleBundle: [],
          currentArticleIndex: 0,
          lastBodyHtml: "",
          lastArticleMeta: {},
          lastTheme: "editorial-green",
          selectedImageIndex: 0
        }
      });

      const scrapeStart = Date.now();
      const scrapeResponse = await sendRuntimeMessage(control, {
        type: "SCRAPE_LAST_SOURCE_TAB",
        payload: {
          captureMode: "readable",
          requestId: `cap-e2e-${provider.name}-${Date.now()}`,
          articleTitle: "Runbi E2E fixture"
        }
      });
      const scrapeMs = Date.now() - scrapeStart;

      expect(scrapeResponse?.ok, JSON.stringify(scrapeResponse?.error || scrapeResponse)).toBe(true);
      const capture = scrapeResponse.data;
      expect(capture.title).toContain("AI 工具进入内容团队的真实拐点");
      expect(capture.author).not.toBe("");
      expect(capture.url).not.toBe("");
      expect(capture.blocks?.length || 0).toBeGreaterThan(2);
      expect(capture.images?.length || 0).toBeGreaterThan(0);
      const captureText = (capture.blocks || [])
        .map((block: any) => block.text || (Array.isArray(block.items) ? block.items.join("") : ""))
        .join("");
      expect(captureText).not.toBe("");
      expect(captureText.length).toBeGreaterThan(300);

      const storedAfterScrape = await getExtensionStorage(control, ["wechatWriterSession"]);
      expect((storedAfterScrape.wechatWriterSession as any)?.lastCapture?.title).not.toBe("");

      const workspace = await extension.context.newPage();
      const workspaceErrors: string[] = [];
      workspace.on("pageerror", (error) => workspaceErrors.push(`pageerror: ${error.message}`));
      workspace.on("console", (message) => {
        if (message.type() === "error") workspaceErrors.push(message.text());
      });
      await workspace.goto(`chrome-extension://${extension.extensionId}/src/workspace/workspace.html?import=1#layout`, {
        waitUntil: "domcontentloaded"
      });

      await expect(workspace.locator("#titleInput")).toHaveValue(/AI 工具进入内容团队/);
      await expect(workspace.locator("#authorInput")).toHaveValue(/林知远|Runbi Local Fixture/);
      await expect
        .poll(async () => workspace.locator("#editor").evaluate((el) => el.textContent?.trim().length || 0), {
          timeout: 20_000,
          intervals: [100, 250, 500]
        })
        .toBeGreaterThan(300);
      await expect
        .poll(async () => workspace.locator("#wechatPreview").evaluate((el) => el.innerHTML.length), {
          timeout: 20_000,
          intervals: [100, 250, 500]
        })
        .toBeGreaterThan(500);

      const copyTextsBeforeRewrite = await collectVisibleTexts(workspace);
      await testInfo.attach(`${provider.name}-visible-text-before-rewrite.json`, {
        body: JSON.stringify(copyTextsBeforeRewrite, null, 2),
        contentType: "application/json"
      });
      const observationDir = path.join(repoRoot, "dist", "e2e-observations");
      await fs.mkdir(observationDir, { recursive: true });
      const beforeRewriteScreenshot = path.join(observationDir, `scrape-rewrite-${provider.name}-before.png`);
      await workspace.screenshot({ path: beforeRewriteScreenshot, fullPage: true });

      const rewriteButton = workspace.locator("#rewriteButton");
      await expect(rewriteButton).toBeVisible();
      const rewriteStart = Date.now();
      await rewriteButton.click();
      await expect(workspace.locator("#status")).toContainText(/改写队列|AI 创作队列|主改写|改写完成/);
      await waitForTaskDone(workspace, "rewrite", "AI 工具进入内容团队", rewriteStart);

      await expect(workspace.locator("#titleInput")).toHaveValue(/AI 改写测试/);
      await expect(workspace.locator("#leadInput")).toHaveValue(/E2E mock LLM/);
      await expect(workspace.locator("#editor")).toContainText("第一节：把失败变得可见");
      await expect(workspace.locator("#editor")).toContainText("第二节：改写要能直接进入排版");
      await expect(workspace.locator("#wechatPreview")).toContainText("可靠的工具先让失败可见");
      const afterRewriteScreenshot = path.join(observationDir, `scrape-rewrite-${provider.name}-after.png`);
      await workspace.screenshot({ path: afterRewriteScreenshot, fullPage: true });

      const mockHits = await getServiceWorkerAiMockHits(extension);
      expect(mockHits.length).toBeGreaterThan(0);
      expect(mockHits.some((hit: any) => hit.url.includes(new URL(provider.apiBaseUrl).hostname))).toBe(true);

      const metrics = {
        provider: provider.name,
        clicks: {
          scrape: 0,
          rewrite: 1
        },
        feedbackLatencyMs: {
          scrapeToResponse: scrapeMs,
          rewriteToStructuredOutput: Date.now() - rewriteStart
        },
        blockers: {
          scrapeEmpty: false,
          aiMockHits: mockHits.length,
          consoleErrors: workspaceErrors
        },
        screenshots: {
          beforeRewrite: beforeRewriteScreenshot,
          afterRewrite: afterRewriteScreenshot
        }
      };
      await fs.writeFile(
        path.join(observationDir, `scrape-rewrite-${provider.name}.json`),
        JSON.stringify(metrics, null, 2)
      );
      await testInfo.attach(`${provider.name}-ux-metrics.json`, {
        body: JSON.stringify(metrics, null, 2),
        contentType: "application/json"
      });

      expect(workspaceErrors.filter((entry) => !/Failed to load resource/i.test(entry))).toEqual([]);

      await workspace.close();
      await fixturePage.close();
      await control.close();
    });
  }
});
