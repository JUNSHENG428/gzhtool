# E2E Core Functional Report: Capture To AI Rewrite

Date: 2026-07-06

Scope: first slice only, "抓取 → AI 改写". Login/OAuth, formatting-only review, and mp.weixin.qq.com draft push remain next slices.

## Result

Command:

```bash
npm run build:floating-ball
npx playwright test tests/e2e/scrape-ai-rewrite.spec.ts --workers=1 --reporter=list
```

Result: 3 passed.

| Provider | AI Call Mode | Capture Response | Rewrite Output | Console Errors |
|---|---|---:|---:|---:|
| OpenAI | service worker fetch mock | 1985ms | 309ms | 0 |
| DeepSeek | service worker fetch mock | 2006ms | 353ms | 0 |
| DashScope | service worker fetch mock | 1997ms | 315ms | 0 |

## Assertions Covered

| Area | Assertion |
|---|---|
| Extension loading | MV3 extension loaded from repository root with `launchPersistentContext`, `headless: false`; extension ID is read from the service worker URL. |
| Bundle freshness | `npm run build:floating-ball` runs before each E2E test; `npm run check:bundle-fresh` passes after the run. |
| Clean first-user context | Each provider test gets a fresh persistent context and empty extension storage. |
| Local fixture capture | The source page is a Playwright-fulfilled local fixture on `https://techcrunch.com/runbi-fixtures/local-article`; no external article site is hit. |
| Scrape quality | Capture title, author, URL, blocks, text length, and images are non-empty; text length is >300 chars. |
| Workspace import | `workspace.html?import=1#layout` fills title, author, editor body, and WeChat preview. |
| AI rewrite | OpenAI, DeepSeek, and DashScope endpoints are mocked in the MV3 service worker `fetch`; no real model call is made. |
| Structured output | Rewritten title, lead, section headings, paragraphs, quote, preview text, and title options are rendered. |
| Async safety | Rewrite completion is waited through task-center state (`LIST_TASKS`) and visible DOM changes, not fixed sleeps. |

## Artifacts

Screenshots and metrics are written to:

- `dist/e2e-observations/scrape-rewrite-openai-before.png`
- `dist/e2e-observations/scrape-rewrite-openai-after.png`
- `dist/e2e-observations/scrape-rewrite-deepseek-before.png`
- `dist/e2e-observations/scrape-rewrite-deepseek-after.png`
- `dist/e2e-observations/scrape-rewrite-dashscope-before.png`
- `dist/e2e-observations/scrape-rewrite-dashscope-after.png`
- `dist/e2e-observations/scrape-rewrite-*.json`
- `dist/e2e-videos/*.webm`

## Notes

The core slice uses `SCRAPE_LAST_SOURCE_TAB` against an already-open local fixture tab because Playwright routing does not intercept pages opened internally by `chrome.tabs.create` from the extension background. Popup and floating-ball entry-point coverage should be added in the next slice.

## 2026-10-12：P1 修复与跨页面保存回归

构建后执行 `playwright test tests/e2e/session-persistence.spec.ts tests/e2e/scrape-ai-rewrite.spec.ts --workers=1 --reporter=list`：4/4 通过。

- 新增跨页面保存切片：两个真实扩展页面同时更新不同字段，连续 12 轮确认改写、正文与既有主题均保留。
- OpenAI、DeepSeek、DashScope 抓取到改写切片全部通过。
- 使用独立用户目录、headed persistent context、仓库根目录加载扩展、从 service worker URL 获取 ID；不使用固定等待。
- AI mock 覆盖三家服务商及平台 `/api/llm/` 接口；账号/支付的 28 项接口与事务回归见 `npm run test:p1`。
- 此轮未声称完成真实 Google OAuth 跳转或微信草稿推送验收。
