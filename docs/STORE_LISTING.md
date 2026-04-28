# Chrome Web Store 上架资料

本文是上架 **润笔 · DocuEarn** 时填写 Chrome Web Store 开发者后台所需的全部信息汇总。
所有字段都按 [Chrome Web Store Listing](https://chrome.google.com/webstore/devconsole/) 的实际表单顺序排列，
直接复制粘贴即可。

---

## 1. 基本信息

| 字段 | 值 |
|---|---|
| 名称（Name） | 润笔 · 公众号创作者的得力助手 |
| 简短描述（Summary，<132 字符） | 为公众号创作者提供选题、AI 改写、杂志级排版与一键推送草稿的全流程工具。 |
| 类目（Category） | Productivity / Workflow & Planning |
| 语言（Language） | Chinese (Simplified) — `zh-CN` |
| 官网 URL | https://docuearn.com |
| 支持邮箱 | support@docuearn.com |
| 隐私政策 URL | https://docuearn.com/privacy |
| 服务条款 URL | https://docuearn.com/terms |

---

## 2. 详细描述（Description，最多 16,000 字符）

> 润笔（DocuEarn）是为微信公众号创作者打造的写作助手。它把"找选题 → AI 改写 → 杂志级排版 → 一键推送公众号草稿"四个环节合并到一个 Chrome 扩展里，让你不再在 10 个工具之间复制粘贴。
>
> 核心能力
>
> · 一键抓取：从你正在浏览的任意网页（知乎、X、Reddit、小红书、新闻站等）抓取正文与配图，自动清洗成可改写的草稿。
>
> · AI 改写：使用你自己的 OpenAI / Anthropic / 兼容 API（密钥只在本机），按你选择的模板与偏好生成中文公众号文风。10+ 个内置高级模板（深度行业观察、故事化叙述、教程拆解…）。
>
> · 杂志级排版：6 套手工照搬 The New Yorker / Wired / Monocle / Vogue / Kinfolk / Paper 版式语言的母版，告别 AI 套模板感。
>
> · AI 模板生成器（Pro）：7 题问卷描述你的写作风格，AI 自动写出一个专属改写模板。
>
> · 一键推送：抓完、改完、排好版，直接推送到你的公众号草稿箱（你需要在公众号后台配置 IP 白名单）。
>
> · AI 智能选题（Pro）：基于公开热点源、用户画像问卷和你的 AI 接口，生成更适合公众号的选题建议与开稿提纲。
>
> 隐私承诺
>
> 我们没有任何服务器在你与 AI / 公众号之间的请求路径上。你的文章正文、AI prompt、改写结果、公众号 token 全部只存在你本机的 chrome.storage.local 中。详见隐私政策：https://docuearn.com/privacy
>
> 免费 vs Pro 会员
>
> · 免费版：可绑定 1 个公众号、每天 5 次 AI 改写、基础排版模板，免费可用。
> · Pro 会员（月度订阅 / 年度订阅）：解锁无限 AI 改写、最多绑定 5 个公众号、全部杂志级排版模板、AI 模板生成器、DrissionPage 深度抓取、3 台设备同时激活。
> · 详细定价与开通方式请访问 https://docuearn.com/pricing
>
> 反馈 / 客服：support@docuearn.com

---

## 3. 单一目的声明（Single Purpose）

> 协助微信公众号创作者完成"抓取参考资料 → AI 改写 → 排版 → 推送公众号草稿"的写作发布流程。

---

## 4. 权限 Justifications（每项必填）

Chrome Web Store 后台会逐个让你解释为什么需要。直接复制下面对应文案到对应字段：

### `activeTab`
> 用户在网页上点击扩展图标时，临时获得当前 tab 的访问权限，用来读取正文 HTML 并交给抓取脚本清洗成草稿。仅在用户主动点击图标 / 快捷键时生效，无后台监控。

### `tabs`
> 用户从 popup / workspace 中点击「打开热点」「打开欢迎页」等入口时，需要 chrome.tabs.create 在新 tab 打开扩展自带的页面。同时用于将「抓取后跳到公众号编辑器」的导航流程串起来。

### `storage`
> 通过 chrome.storage.local 保存：用户的 AI 接口配置、公众号凭据、改写偏好、提示词模板、本地草稿、本地产能埋点。所有数据仅在用户当前浏览器内，从不同步到云端，从不上传到开发者服务器。

### `scripting`
> 通过 chrome.scripting.executeScript 把 src/content-scripts/ 下的抓取脚本注入到用户主动选择的网页（如知乎答案页），读取正文与图片 URL。仅在用户点击「抓取」时执行，不在后台扫描。

### `alarms`
> 注册一个每 12 小时触发一次的 alarm，用于在合适的时机静默复验 Pro 会员的 license 状态（实际是否触发请求由内部 24h 节流控制）。不用于其它定时任务，不在用户未购买 Pro 时唤起。

### `host_permissions`
> 扩展默认只访问与核心功能直接相关的固定服务：微信公众号后台与开放接口、DocuEarn 授权服务、用户常用的官方 AI 接口，以及默认热点源。
>
> 这些权限用于以下场景：
>
> 1. **微信公众号发布**：访问 `mp.weixin.qq.com` 与 `api.weixin.qq.com`，用于同步公众号编辑器、获取 access token、上传素材、创建草稿、发布和查询状态。
> 2. **会员授权**：访问 `docuearn.com` / `api.docuearn.com`，用于登录、会员状态同步和 Pro 权益校验。
> 3. **用户配置的 AI 接口**：默认覆盖 OpenAI、DeepSeek、Anthropic、DashScope 等常见官方接口；如果用户填写自建 OpenAI 兼容网关，扩展会在用户点击测试、改写或生成模板时单独申请该域名权限。
> 4. **热点与选题**：默认覆盖 `hot.inkgold.info`、`rsshub.app`、Bilibili / Reddit 等内置热点源；用户配置自托 NewsNow / RSSHub 时按需申请对应域名。

### `optional_host_permissions`: `https://*/*` 和 `http://*/*`
> 仅在用户主动触发动态来源时按需申请，不作为安装时默认权限。
>
> 典型场景包括：
>
> 1. 用户点击「抓取」某个任意公开网页时，扩展只申请该网页所在 origin，用于注入抓取脚本读取正文与图片。
> 2. 用户发布公众号草稿时，文章内的远程图片需要先从原图域名下载，再上传到公众号素材库；扩展会在发布前申请这些图片 origin。
> 3. 用户填写自建 AI 网关、微信 API 代理、自托 NewsNow / RSSHub 或自定义授权服务时，扩展会在点击对应功能时申请该服务 origin。
>
> 扩展不会在后台扫描网页，也不会在用户未触发操作时访问任意网站。

---

## 5. 资料图（Store Assets）

| 类型 | 尺寸 | 数量 | 状态 |
|---|---|---|---|
| 扩展图标 | 128×128 PNG | 1 | ✅ 已有 `src/icons/icon128.png` |
| 商店小图标 | 440×280 PNG | 1 | ❌ 待制作 |
| 主截图 | 1280×800 或 640×400 PNG | 至少 1，最多 5 | ❌ 待截图 |
| 推广横幅 | 1400×560 PNG | 可选 | ❌ 待制作 |

**截图建议拍 5 张：**

1. Workspace 主界面（编辑台 + 抓取的素材）
2. AI 改写过程（带模板选择 + 杂志级排版预览）
3. AI 模板生成器（7 题问卷）
4. 热点 / AI 智能选题
5. 一键推送公众号草稿成功

每张右下角加扩展 logo + 一句话标题，比例参考已发布的高分扩展。

---

## 6. 上架前 Checklist

- [ ] 所有功能在最新稳定版 Chrome 上跑通 (`npm run test`)
- [ ] manifest.version 与 package.json.version 一致 (`npm run version:sync`)
- [ ] 隐私政策已部署在 https://docuearn.com/privacy 且可公网访问
- [ ] 服务条款已部署在 https://docuearn.com/terms 且可公网访问
- [ ] `npm run build:zip` 成功输出 `dist/runbi-v0.3.2.zip`
- [ ] 解压 zip 检查：不含 `.venv/` `node_modules/` `docs/` `scripts/` `server/` `site/` `claude_design_system_prompt.md`
- [ ] 在干净的 Chrome profile（无其它扩展 / 无登录态）下加载未压缩的 stage 目录测试一遍主要流程
- [ ] 截图与 store 描述准备完毕
- [ ] 商店开发者后台付费 $5 注册费已支付（一次性）

---

## 7. 上传后

1. 在开发者后台「分发」标签选择目标地区（建议初次只选「中国大陆 + 海外」即可）。
2. 选择「公开发布」或「私享 trusted testers」。建议第一次先 trusted testers 灰度。
3. 提交审核后通常 1–7 天内有结果。被打回时按 reviewer 邮件中的具体条款逐条回应，并在 manifest.version 升小版本（0.3.3）后重新上传。

---

最后更新：2026-04-23 · 维护者：润笔 DocuEarn
