# 权限说明与上架收窄策略

## 当前上架态（仓库默认）

`manifest.json` 默认只声明固定生产域名的 `host_permissions`，例如微信接口、
DocuEarn 授权服务、默认 AI 服务和默认热点源。

**原因简述：**

1. **固定服务可预先枚举**：微信 `api.weixin.qq.com` / `mp.weixin.qq.com`、
   DocuEarn `api.docuearn.com`、默认 OpenAI/DeepSeek/Anthropic/DashScope、
   `hot.inkgold.info`、`rsshub.app` 等写在默认权限里。
2. **动态 URL 改为按需申请**：用户主动抓取的任意网页、远程文章图片、
   自托 RSSHub / NewsNow、用户自填 OpenAI 兼容 API、微信 API 代理、
   自定义授权服务等，都走 `optional_host_permissions`。
3. **运行时申请只发生在用户触发动作时**：例如点击「抓取」、点击「发布」、
   点击「测试 AI 接口」或使用 AI 模板生成器时，才针对对应 origin 弹出授权。

这样安装时不再默认要求访问所有网站，同时仍保留用户主动抓取任意公开网页的能力。
旧「AI 选题代笔 Agent」已下线，因此不再声明 `cookies` 权限，也不再为小红书 / X / 知乎等登录态检测保留固定 host 权限。

## 上架态（Chrome Web Store）建议

商店审核通常希望 **权限与功能一一对应、尽量最小化**。可按下面顺序收窄（需实测每个发布流程）：

| 能力 | 默认 `host_permissions` / 运行时权限 | 说明 |
|------|------------------------------|------|
| 微信开放平台 | `https://api.weixin.qq.com/*` | 获取 token、上传素材、草稿、发布查询 |
| 用户 AI 接口 | 常见官方域名默认列入；自建 / 代理域名走 `optional_host_permissions` | 兼容用户自己的 OpenAI 兼容网关 |
| 热点 RSS / 聚合 | 默认源列入；自托 NewsNow / RSSHub 走 `optional_host_permissions` | 减少默认第三方域名，同时保留自托能力 |
| 网页抓取 | 任意网页不放默认权限；用户点击抓取时按该网页 origin 申请 | 与“用户主动抓取”行为一致 |
| 远程文章图片 | 发布前按图片 origin 申请 | 用于把外部图片下载后上传到公众号素材库 |

`http://*/*` 仅作为 optional 权限保留，用于用户主动抓取 http 文章页或本地/自托服务；
默认权限不再包含全域 http。

## `optional_host_permissions`（可选）

Manifest V3 支持将部分域名列为可选权限，在运行时 `chrome.permissions.request` 再申请。
当前仓库已经接入：

- `src/shared/host-permissions.js` 负责把 URL 转成 origin match pattern，并先 `contains` 后 `request`。
- `src/background/service-worker.js` 在后台抓取、公众号发布、热点自托源、AI 选题规划等入口前申请。
- `src/shared/ai.js` / `template-generator.js` / `voice-samples.js` / `humanize-pass.js`
  在用户自填 AI 接口调用前申请。
- `src/shared/license.js` 在自定义 `licenseApiBase` 前申请。

## 与隐私政策、商店表单的关系

- 默认 `host_permissions` 只覆盖产品固定服务；任意网页访问通过用户主动触发时的 optional 权限完成。
- 隐私政策与商店表单需说明：访问网络用于用户主动触发的抓取、用户配置的 AI、公众号接口、热点数据源等。
- **不上传**用户正文到扩展方服务器（本扩展默认无自有后端；若你 fork 加了 analytics，需另述）。
