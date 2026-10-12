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

## 2026-10-12：改写可读性回归

- 主改写、旧模板、自拟主题、二次润色、深度评审与返工采用准确性和可读性优先的编辑规则；不再强制句长随机、第一人称口头禅或反方观点。
- `npm run test:rewrite-quality`：11/11 通过，覆盖提示词传递、空 CTA、完整句摘要、小数/引号/emoji 边界，以及模拟润色时的图片和列表保全。
- `npm test` 全部通过；`npm run check:js` 和 `npx tsc --noEmit -p tsconfig.bundle.json` 通过。
- 构建后运行原核心改写切片及跨页面保存切片：4/4 通过。三家模拟接口均断言摘要在完整句结束、徽标标注“规则分”、关闭润色时正确显示状态，面板说明分数的适用范围。
- 测试全部使用本地素材及模拟 AI；验证的是请求约束、数据处理和界面行为，未评估真实模型成稿质量，也未核实用户素材中的事实。

## 2026-10-12：公众号浏览器导入切片

- 新增 `scripts/test-wechat-import.mjs`：13 项回归覆盖严格 URL 路由、另开新页、待导入持久化/过期、并发点击、Chrome storage 属性重排、取消及陈旧回执、状态区分和多篇拒绝静默截断；已纳入 `npm test` 与 GitHub CI。
- 新增 `tests/e2e/wechat-editor-import.spec.ts`：8 个场景覆盖确认前不覆盖、账号不匹配/未知账号、完整字段/正文/图片回读、保存失败与成功提示区分、编辑后重新保存、恢复副本、刷新续接、切篇和最新 DOM、草稿按钮与发布确认、编辑器回滚、React/旧版浮球列表页入口及另建一篇。
- 工作目录全量 `npm test`、原有 4 项抓取改写/跨页面保存 E2E 通过；仅含本次提交内容的独立快照中 `npm test`、JavaScript 检查、TypeScript 检查及 7 项导入 E2E 通过；另建一篇场景单独验证。
- 每项扩展 E2E 构建浮球，从仓库根目录加载 headed persistent Chrome，使用独立用户目录、service worker URL 动态取 ID、显式 DOM/存储等待，无 `waitForTimeout`。
- 测试素材、公众号 DOM、保存结果与 AI/平台后端均为 fixture/mock。Chrome 的扩展发起新标签页导航绕过 Playwright 路由，因此“另建一篇”测试仅将新 tab 初始 URL 替换为 about:blank，再在同一 tab 加载所请求 URL 的本地 fixture；新 URL 参数由路由单测和此场景断言，真实建 tab、任务迁移及 helper 续接仍在扩展内执行。
- 截图：`dist/e2e-observations/wechat-import-confirm.png`、`wechat-import-restored.png`；独立测试上下文的 `.webm` 录像位于 `dist/e2e-videos/`。没有登录真实账号或提交真实草稿/发布；实际公众号 DOM、图片上传与后台保存仍需生产账号人工验收。

执行命令：

```bash
npm test
npm run check:js
npx tsc --noEmit -p tsconfig.bundle.json
npm run build:floating-ball
npx playwright test tests/e2e/wechat-editor-import.spec.ts tests/e2e/session-persistence.spec.ts tests/e2e/scrape-ai-rewrite.spec.ts --workers=1 --reporter=list
```
