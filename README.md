# 公众号改写排版台

Chrome **Manifest V3** 扩展：在本地完成「网页抓取 → AI 改写 → 公众号风排版 → 多图文草稿 / 发布 / 状态查询」，并带热点捕捉、欢迎页与帮助文档。

**版本号唯一真源**：`manifest.json` 的 `version`。修改版本后请执行：

```bash
npm run version:sync
```

使 `package.json` 的 `version` 与之一致。

## 当前能力（与代码一致）

1. **网页抓取**：默认向当前标签页注入 `src/content-scripts/scrape-article.js`，支持滚动展开懒加载后抽取正文与配图；也可选配本地 **DrissionPage helper** 作为增强抓取通道。
2. **三种抓取模式**（弹窗菜单或带参打开编辑台时生效，编辑台内「抓取网页」沿用当前模式）：
   - **只抓取选中文字**：依赖页面上已有文本选区；无选区或过短会提示错误。
   - **智能识别正文**（默认）：在候选 `article` / `main` 等容器中择优根节点抽取。
   - **原样整页**：以 `document.body` 为主范围，放宽侧栏等启发式过滤，内容更全、噪声也可能更多。
3. **AI 改写**：OpenAI 兼容接口（设置中的 Base URL / Key / Model），见 `src/shared/ai.js`。
4. **编辑台**：多图文（主篇 + 副篇上限见 `shared/defaults.js`）、封面、预览、撤销栈、改写 diff、历史草稿等（`src/workspace/`）。
5. **公众号**：直连 `api.weixin.qq.com` 上传图片、建草稿、发布与 `publish_id` 状态轮询（`src/shared/wechat.js`）。
6. **发布轮询恢复**：会话中若存在未结束的 `lastPublishResult.publishId`，打开编辑台会尝试 `maybeResumePublishPolling` 继续查询（见 `workspace-publish.js`）；若已判定为终态或超过冷却则不再自动拉。
7. **同步到网页编辑器**：向 `mp.weixin.qq.com` 注入辅助脚本，将当前篇同步到图文编辑页（`wechat-editor-helper.js`）。
8. **热点捕捉**：数据源与解析在 `src/shared/hot-topics-sources.js`（RSSHub、备用 HTTP 接口等），**不是**已删除的 `hot-topics.js`。
9. **内置页面**：`src/pages/` 下欢迎、帮助、热点、权限说明、隐私、条款；字体可 `npm run fonts:sync` 自托管。

## 工程脚本

| 命令 | 作用 |
|------|------|
| `npm run check:js` | 对 `src/`、`scripts/` 下 `.js`/`.mjs` 做 `node --check` |
| `npm run test:smoke` | manifest / 关键文件 / 图标 / HTML 存在性 + `check:js` |
| `npm run fonts:sync` | 从 `@fontsource` 同步 woff2 并生成 `fonts.css` |
| `npm run version:sync` | 将 `manifest.json` 的 version 写回 `package.json` |
| `npm test` | 等同于 `test:smoke` |

## DrissionPage 增强抓取

项目已接入一个**可选的本地 DrissionPage helper**，适合动态页面、重懒加载和部分注入抓取不稳定的站点。详细启动方式见 **[docs/DRISSIONPAGE_HELPER.md](./docs/DRISSIONPAGE_HELPER.md)**。

最简启动：

```bash
pip install DrissionPage
python3 scripts/drissionpage_helper.py
```

然后到扩展设置页勾选「增强抓取（DrissionPage）」并测试服务连通性。

## 权限与上架

- 开发态默认 **宽** `host_permissions`（`http/https` 通配）的原因与上架收窄建议见 **[docs/PERMISSIONS_AND_STORE.md](./docs/PERMISSIONS_AND_STORE.md)**。
- 热点依赖的第三方公开接口（RSSHub、各类热榜镜像）**适合自用与验证**；若商用分发，建议评估稳定性、合规与替换为自有后端。

## 上架前检查清单

1. `manifest.json` 的 `version`、`name`、`description` 与商店文案一致；已执行 `npm run version:sync`。
2. `npm run test:smoke` 通过。
3. 在 Chrome **正式版**（≥ manifest `minimum_chrome_version`）用「加载已解压的扩展程序」跑通：设置保存、抓取三种模式、改写、发布或草稿、热点页。
4. 隐私政策 / 服务条款：若提交 Chrome Web Store，通常需**可公网访问的 URL**；仓库内页面可作为开发副本，上架时替换为托管地址。
5. 根据目标审核要求收窄 `host_permissions`，并在商店「单用途说明」中写清：抓取、AI、公众号接口、热点数据网络用途。
6. 截图与宣传语与真实能力一致（尤其：无自有账号体系、无云端草稿同步，除非自行二次开发）。

## 目录结构（摘要）

```text
manifest.json
docs/
  DRISSIONPAGE_HELPER.md
  PERMISSIONS_AND_STORE.md
scripts/
  check-js.mjs
  drissionpage_helper.py
  smoke.mjs
  version-sync.mjs
  sync-fonts.sh
src/
  background/service-worker.js
  content-scripts/scrape-article.js
  content-scripts/wechat-editor-helper.js
  options/
  popup/
  pages/
  shared/           # ai.js、wechat.js、hot-topics-sources.js、errors.js 等
  workspace/
```

## 当前限制

- 公众号接口对正文长度、素材大小有限制；超长文需手动拆分或精简。
- 强防盗链图片可能导致下载失败。
- 网页编辑器 DOM 变更可能导致辅助同步失败，可退回复制 HTML。
- 无内置用户系统、无云端协作；`AppSecret` 等保存在本机 `chrome.storage`，仅适合个人或小团队自用场景。

## 加载与调试

1. 打开 `chrome://extensions/`，开启「开发者模式」
2. 「加载已解压的扩展程序」→ 选择本仓库根目录
3. 首次安装会打开欢迎页；之后在选项页配置 AI 与公众号参数
