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
| 支持邮箱 | hello@docuearn.com |
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
> · AI 选题代笔：通过 chrome.cookies API 检测你已登录的小红书 / X / 知乎 / Reddit，自动从这些平台抓取近期内容生成选题清单。我们 **只读取 cookie name 不读取 value**。
>
> 隐私承诺
>
> 我们没有任何服务器在你与 AI / 公众号之间的请求路径上。你的文章正文、AI prompt、改写结果、公众号 token 全部只存在你本机的 chrome.storage.local 中。详见隐私政策：https://docuearn.com/privacy
>
> 免费 vs Pro
>
> · 免费版：1 个公众号、每天 5 次 AI 改写、5 套基础模板，永久免费。
> · Pro 月付 ¥29：无限改写、最多 5 个公众号、6 套杂志级母版、AI 模板生成器、DrissionPage 反爬抓取、3 台设备同时激活。
> · Pro 年付 ¥288：等同月付能力，每月折合 ¥24。
>
> 反馈 / 客服：hello@docuearn.com

---

## 3. 单一目的声明（Single Purpose）

> 协助微信公众号创作者完成"抓取参考资料 → AI 改写 → 排版 → 推送公众号草稿"的写作发布流程。

---

## 4. 权限 Justifications（每项必填）

Chrome Web Store 后台会逐个让你解释为什么需要。直接复制下面对应文案到对应字段：

### `activeTab`
> 用户在网页上点击扩展图标时，临时获得当前 tab 的访问权限，用来读取正文 HTML 并交给抓取脚本清洗成草稿。仅在用户主动点击图标 / 快捷键时生效，无后台监控。

### `tabs`
> 用户从 popup / workspace 中点击「打开热点」「打开 AI 选题代笔」「打开欢迎页」等入口时，需要 chrome.tabs.create 在新 tab 打开扩展自带的页面。同时用于将「抓取后跳到公众号编辑器」的导航流程串起来。

### `storage`
> 通过 chrome.storage.local 保存：用户的 AI 接口配置、公众号凭据、改写偏好、提示词模板、本地草稿、本地产能埋点。所有数据仅在用户当前浏览器内，从不同步到云端，从不上传到开发者服务器。

### `scripting`
> 通过 chrome.scripting.executeScript 把 src/content-scripts/ 下的抓取脚本注入到用户主动选择的网页（如知乎答案页），读取正文与图片 URL。仅在用户点击「抓取」时执行，不在后台扫描。

### `cookies`
> 仅用于「AI 选题代笔」功能：通过 chrome.cookies.getAll() 检测用户是否已在小红书 / X / Reddit / 知乎登录（即检测「关键 cookie 名字是否存在」）。**只读取 cookie name，不读取 value**，判断结果只在本地内存使用，不写入存储、不发送到任何服务器。缺登录时只引导用户开新 tab 自行登录，不会模拟登录、不会代用户提交账号密码。

### `alarms`
> 注册一个每 12 小时触发一次的 alarm，用于在合适的时机静默复验 Pro 会员的 license 状态（实际是否触发请求由内部 24h 节流控制）。不用于其它定时任务，不在用户未购买 Pro 时唤起。

### `host_permissions`: `https://*/*` 和 `http://*/*`
> 扩展支持以下三类需要任意域名访问的场景：
>
> 1. **用户主动抓取的任意公开网页**：用户可能从知乎、X、Reddit、小红书、各类新闻博客等任何域名抓取参考资料，无法预先枚举完整列表。
> 2. **用户自行配置的 AI 接口**：用户可在设置页填写自己的 OpenAI 兼容 API base URL，可能是官方 OpenAI、Anthropic、Azure OpenAI、自建 vLLM 网关等，域名由用户决定。
> 3. **公众号 API 与素材图片**：发布到公众号需访问 api.weixin.qq.com；文章里引用的外部图片需先从原域名下载再上传公众号素材库。
>
> 所有网络请求都由用户主动操作触发，扩展不在后台扫描或抓取。少数 self-hosted AI 网关使用 http:// 协议，因此保留 http://*/* 仅用于服务这部分用户场景；新版本将逐步推动改用 optional_host_permissions 在使用时按需申请。

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
4. 热点 / AI 选题代笔
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
