# 微信公众号 / 自动发文 · 外部约束清单

> 这份文档收录的是**微信平台的外部约束**，不是本项目的 bug。改 `src/shared/wechat-html.js` /
> `src/shared/wechat.js` 任何 sanitizer 或 API 调用前**必读**这份文档，避免把已经规避过的坑
> 又踩回去。
>
> 维护原则：append-only。微信侧策略变化（例如 2025-07 权限回收、暗色模式注入逻辑等）只追加
> 备注「⚠️ 已过期：YYYY-MM-DD 之后改用 XXX」，不要直接删旧条目，未来回溯有据可查。

## 目录

- [一、HTML / CSS 渲染雷区](#一html--css-渲染雷区)
- [二、暗色 / 浅色模式](#二暗色--浅色模式)
- [三、文章列表显示规则](#三文章列表显示规则)
- [四、IP 白名单与公网代理](#四ip-白名单与公网代理)
- [五、2025-07 接口权限收紧](#五2025-07-接口权限收紧)
- [六、本仓库现状映射表](#六本仓库现状映射表)
- [七、未实现 / 待路线](#七未实现--待路线)

---

## 一、HTML / CSS 渲染雷区

公众号 `cgi-bin/draft/add` 接口（草稿）会对你提交的 `content` HTML 做一次激进清洗。下列规则
都是踩过的真实坑：

| # | 规则 | 表现 | 本项目处理 |
|---|---|---|---|
| 1 | `position: absolute / fixed / sticky` 被移除 | 绝对定位排版整体垮塌 | `wechat-html.js` `sanitizeInlineStyle` 把 absolute/fixed/sticky 一律降级为 `relative`（保留布局上下文） |
| 2 | `position: relative` 被保留 | 正常 | 不动 |
| 3 | `<button>` 整段移除 | 按钮消失 | `DROP_WITH_CONTENT` 已黑名单；模板里禁止用 `<button>` 做装饰，必须用 `<span>` + inline style |
| 4 | `background: url(...)` / `background-image: url(...)` 整段被删 | 背景图丢失，连带文字位置错乱 | sanitizer 在 declaration 级别整段丢弃，避免 fallback 文字飘走 |
| 5 | `<linearGradient id="catGradient">` 的 `id` 被剥 → 通过 `fill="url(#catGradient)"` 引用的动画 / 渐变全部失效 | 渐变描边 / SVG 动画失效 | 当前策略：**`<svg>` 整段被剥**（在 `DROP_WITH_CONTENT`），等于一刀切。如果将来要做合规 SVG 装饰，必须自己白名单 svg 子树并跳过 id 引用方案 |
| 6 | SVG `<animateMotion>` 可用，但 `<animate>` 仅支持透明度变化（其他属性会被吃掉） | 动画失效或部分失效 | 同上，整体剥离规避；未来要放开必须先做 template1 那套样的小样本验证 |
| 7 | CSS `@keyframes` / `transition` / `transform` 公众号支持有限，常引发布局抖动 | 抖动或渲染停在中间帧 | sanitizer `STYLE_DROP_KEYS` 把 `transform / transition / animation` 整段丢 |
| 8 | `display:none` / `visibility:hidden` / `opacity:0` 隐藏内容 | 占位无意义、给审核留把柄 | sanitizer 直接删 declaration |
| 9 | `!important` 多数被剥，且会让生成 HTML 多余字节 | 浪费正文 2 万字符配额 | sanitizer 一律去掉 `!important` |
| 10 | `class` / `id` / `data-*`（除白名单 `ALLOWED_DATA_ATTRS`）几乎全部失效 | 主题样式丢失 | 改写所有样式为 inline style；保留少量微信编辑器专用 `data-w/data-h/data-fileid` 等 |
| 11 | `<div>` / `<article>` / `<header>` 等容器经常被静默 unwrap | 主题样式（挂在容器上的 inline style）连带丢失 | `convertContainer()`：带 inline style 的容器自动转成 `<section>` 保住样式 |
| 12 | 正文 HTML 长度 ≤ ~20000 字符 | 超过直接报错 / 被截断 | `wechat.js:140` 在草稿创建前断言 ≤ 20000 字符并提示用户拆分 |
| 13 | 正文图（`uploadimg`）≤ 1MB；封面（`add_material`）≤ 2MB | 超限 40005 / 40113 | `ensureCompatibleImageBlob()` 自动 PNG → JPEG 多档质量降级；仍超限走 `failedImages` UI 反馈 |
| 14 | 仅接受 `jpg/png/gif/bmp`；webp/avif/svg 会 40005/40113 | 图片上传失败 | `convertImageBlob()` 用 OffscreenCanvas 强制转 png/jpeg；filename 后缀按真实 MIME 重写 |
| 15 | 文件名后缀必须和 MIME 一致 | 40005 / 40113 | `normalizeFilename()` 剥所有原后缀，按 blob.type 加唯一正确后缀 |
| 16 | 字符层面：零宽 (U+200B/200C/200D)、BOM、控制字符、未 NFC 规范化的组合字符 → 公众号草稿乱码 / 缺字 / 莫名空白 | 表象很迷惑，常被怀疑成 AI 模型问题 | `cleanInvisibleChars()` 在 workspace 端 + service worker 端各跑一次，双保险 |
| 17 | 公众号多图文最多 8 篇 | 第 9 篇被截 | `validatePublishPayload()` 主动断言并报错 |

> 总原则：**inline style 优先**，**容器收敛到 `<section>`**，**不要依赖 `class` / `id` / 任何
> 动画 / 任何外链资源**。

## 二、暗色 / 浅色模式

| # | 现象 | 本项目处理 |
|---|---|---|
| 1 | 微信暗色模式会自动给文章 body 注入 `class="js_darkmode__"`，**强制覆盖**作者设的背景色 / 文字色 | 无法绕过：`!important` 也会被微信编辑器在保存时移除 |
| 2 | 渐变文字（`background: linear-gradient(...); -webkit-background-clip: text; color: transparent;`）在**暗色模式 + 部分手机机型**下会显示成不可见 / 色块错乱 | sanitizer 检测到 `background-clip:text + color:transparent` 组合时，自动追加 `-webkit-text-fill-color: currentColor` 作为 fallback，至少暗色下能读出文字 |
| 3 | 浅色模式下渐变文字效果**基本可用**（个别老 Android 微信内核例外） | 不动 |
| 4 | 整体策略：**当前生成更倾向适配浅色模式**，暗色模式效果稍差 | 已知短板，写入 progress.md「已知问题」；后续要做的是给所有有彩色文字的元素都加一个**安全的 fallback color**（不是 currentColor，是显式 hex），让 `js_darkmode__` 接管时也能读 |

**实操约束**：模板/AI 生成器输出彩色文字时，应该同时给一个高对比度 fallback color，例如：
```html
<span style="background:linear-gradient(90deg,#4b6cb7,#ff9a9e);
             -webkit-background-clip:text;
             color:transparent;
             -webkit-text-fill-color:#1f2937;">  <!-- 暗色下兜底 -->
  标题文字
</span>
```

## 三、文章列表显示规则

> 这是**目前最容易踩坑且本项目尚未完整实现**的一块。先把规则吃透，再决定要不要做。

### 未认证账号（个人主体 / 未认证企业号 / 不支持认证的账号）

- ✅ 调 `cgi-bin/draft/add` 创建草稿 → ⚠️ 2025-07 起可能丢失此权限（见第五节）
- ❌ **草稿不会自动显示在公众号文章列表**
- ❌ 即使调 `cgi-bin/freepublish/submit`（本项目实现的发布接口），**也不显示在列表**
- ✅ 但**关注者会收到通知**（每日上限 3 篇）
- 💡 唯一能显示到列表的方法：**只能在公众号后台手动操作**——后台「素材管理」里点击草稿 → 手动发表

### 认证账号（已认证服务号 / 订阅号）

要让文章显示到公众号文章列表，**必须调用群发接口**：

```
POST https://api.weixin.qq.com/cgi-bin/message/mass/sendall?access_token=ACCESS_TOKEN
Body:
{
  "filter": {
    "is_to_all": false,    // 见下方
    "tag_id": 100          // 用户标签 ID（is_to_all=false 时必填）
  },
  "mpnews": { "media_id": "DRAFT_MEDIA_ID" },
  "msgtype": "mpnews",
  "send_ignore_reprint": 0
}
```

`is_to_all` 三种情况，行为差异巨大，**建议在设置里让用户三选一**：

| `is_to_all` | 调 sendAll 接口 | 行为 | 适用 |
|---|---|---|---|
| `true` | 是 | 群发给**所有粉丝** + 显示到列表 + 计入当月群发次数（每月 4 次硬限制） | 重要稿件 / 大事件，注意配额 |
| `false` | 是 | 仅群发给**指定标签 `tag_id` 的粉丝** + 显示到列表 + **不计入**月群发次数 | 日常稿件首选；要求公众号至少建过一个用户标签 |
| — | 否（仅 `freepublish/submit`） | **不显示到列表**，仅生成永久链接，关注者无通知 | 用作"非公开存档"或拼接到外部分发渠道时 |

💡 关于 `tag_id`：是公众号后台「用户管理 → 标签」里建的标签 ID。`is_to_all=false` 但调 sendAll
时，**`tag_id` 几乎必填**（少数文档说可选，实测会拒）。建议在设置里强制要求填写，并提供一个
"拉取我的标签列表"按钮（接口 `cgi-bin/tags/get`）。

### 官方文档（云里雾里版）

- 群发接口：[mass/sendall 文档](https://developers.weixin.qq.com/doc/offiaccount/Message_Management/Batch_Sends_and_Originality_Checks.html)
- 草稿接口：[draft/add 文档](https://developers.weixin.qq.com/doc/offiaccount/Draft_Box/Add_draft.html)
- 发布接口：[freepublish/submit 文档](https://developers.weixin.qq.com/doc/offiaccount/Publish/Publish.html)

> 「为什么会有这么逆天的产品」—— 因为微信生态原本是**让用户在后台手动发**的，开放接口是给
> **认证服务号 + 商业 SaaS** 兜的。个人创作者属于"边缘用例"，所以接口能力 = 群发 ⊆ 全部能力。

## 四、IP 白名单与公网代理

### 问题

公众号所有 `cgi-bin/*` API（包括 `token` / `add_draft` / `submit`）都会校验请求方 IP 是否在
公众号后台「开发 → 基本配置 → IP 白名单」里。**不在白名单 → 直接 errcode `40164`**。

| 场景 | 痛点 |
|---|---|
| 用户家用宽带（动态 IP） | 每次拨号变 IP，必须手动改白名单，根本没法用自动化 |
| 用户在公司 / 校园网 | NAT 出口 IP 不固定，且通常不能改公司白名单 |
| 直接从 Chrome 扩展调 API | 用户当前公网 IP 必须在白名单里——大多数个人用户做不到 |

### 解决方案路线（按可落地度排序）

#### 方案 A：阿里云函数计算（FC）反向代理 ✅ 推荐 / 免费额度足

1. 在阿里云 FC 建一个 HTTP 触发器函数（Node.js / Python 都可），固定区域（如杭州）
2. 函数代码：把 `request.path` + `request.body` 原样转发到 `https://api.weixin.qq.com{path}`
   并返回响应
3. FC 出口 IP 是阿里云的固定段，[阿里云官方公布的 FC 出口 IP 列表](https://help.aliyun.com/document_detail/87025.html)
   全部加进公众号白名单（一次性操作）
4. 用户在本扩展设置里把 `wechatApiBase` 改成这个 FC 域名（默认仍是 `https://api.weixin.qq.com`）
5. 阿里云 FC 免费额度：每月 100 万次调用 + 400000 GB-s，普通用户绝对用不完

> ⚠️ 安全提示：FC 函数不要做白名单收紧（任何人请求都会被原样转发），**调用时仍需要带正确的
> AppID/AppSecret**，攻击者拿不到凭证就发不了文。如果担心被刷调用次数，可以加一个 `X-Auth-Token`
> 共享密钥校验。

#### 方案 B：自建 Cloudflare Worker 转发 ⚠️ 不可用

Cloudflare Worker 出口 IP 段是 Cloudflare 全球边缘节点，**每次调用 IP 不同且巨大**，无法
全量加白名单。即使用 Cloudflare 的"按域名固定回源 IP"（Argo Smart Routing）也不稳定。
**不推荐用 CF Worker 代理微信 API**。

#### 方案 C：用户自购固定 IP 云服务器 ⚠️ 门槛高

阿里云/腾讯云轻量级服务器 ¥30/月，固定公网 IP，nginx 反代 `api.weixin.qq.com`。门槛高、
不适合普通创作者，仅作为重度用户兜底。

#### 方案 D：本地 helper 转发 ❌ 不能用

桌面助手 Runbi Helper 出口 = 用户本机 IP = 仍然是动态 IP，跟扩展直连没有区别，**对 IP 白名单
问题没有任何改善**。

### 当前项目状态

- ✅ `wechat.js` 错误码 40164 已有友好中文提示
- ❌ 没有 `wechatApiBase` 配置项（硬编码 `api.weixin.qq.com`）
- ❌ 没有 FC 代理函数模板代码 / 部署文档

→ 见第七节「未实现 / 待路线」。

## 五、2025-07 接口权限收紧

> 来源：微信公众号 2025 年 6 月公告

**自 2025 年 7 月起**，下列账号会**失去 `cgi-bin/draft/add` + 后续所有发布相关接口权限**：

- 个人主体公众号（最广泛的影响范围 —— 大多数本项目用户都属于这一类）
- 未认证企业号
- 不支持认证的账号类型（如部分海外主体）

→ 这部分账号**只能登微信后台手动发**，本扩展的「推送到草稿箱」按钮会直接报 `errcode 48001`
（接口未授权）。

### 本项目的应对策略

1. **设置页公众号配置区**应该加一个**显眼的红色横幅**：
   ```
   ⚠️ 微信平台公告：自 2025 年 7 月起，未认证 / 个人主体公众号将失去自动发布权限。
   如果您是未认证账号，建议：
     • 短期：把"推送到公众号草稿"改成"复制 HTML 到剪贴板，手动粘贴到公众号后台"
     • 长期：升级到已认证服务号
   ```

2. **`testWechatConnection()`** 的 OK 提示里已经写了「不能验证草稿/发布接口是否对当前账号开放」，
   这是兜底，但还需要在用户**真发起一次草稿推送**时，看到 48001 后给一个**额外的解释 modal**：

   > 当前账号无法调用草稿接口（48001），最可能的原因：
   > • 账号是未认证 / 个人主体 / 订阅号 → 微信平台对接口有限制（2025-07 后更严）
   > • 接下来推荐：用扩展里的「复制 HTML」功能，手动粘贴到公众号后台

3. 在 `docs/` 和官网 `pricing.html` 文案里**明确说明**：「自动推送草稿仅对已认证服务号有保证」，
   避免未认证用户付费后才发现用不了。

## 六、本仓库现状映射表

> 这是「本仓库代码 vs 上述外部约束」的快照。改 `wechat-html.js` / `wechat.js` 时对照看，
> 不要把已经处理过的坑改回去。

| 外部约束 | 本仓库实现位置 | 状态 |
|---|---|---|
| `position: absolute → relative` | `wechat-html.js:230-233` `sanitizeInlineStyle` | ✅ |
| `background: url(...)` 删 | `wechat-html.js:234-236` | ✅ |
| `<button>` 等危险标签 | `wechat-html.js:18-44` `DROP_WITH_CONTENT` | ✅ |
| `<svg>` / `linearGradient id` 失效 | `wechat-html.js:18-44` 整体剥离 | ✅（一刀切，未来要放开需重审） |
| `display:none / opacity:0` 隐藏 | `wechat-html.js:197-211` `STYLE_DROP_KEYS` | ✅ |
| `transform / transition / animation` | `wechat-html.js:197-206` 整段丢 | ✅ |
| `!important` 剥离 | `wechat-html.js:227` | ✅ |
| `class / id / data-*` 收敛 | `wechat-html.js:118-144` | ✅ |
| `<div>` 容器 unwrap → `<section>` 保留 style | `wechat-html.js:356-368` `convertContainer` | ✅ |
| 正文 ≤ 20000 字符 | `wechat.js:140` | ✅ |
| 图片 ≤ 1MB / 封面 ≤ 2MB | `wechat.js:19-20` + `ensureCompatibleImageBlob` | ✅ |
| 仅 jpg/png/gif/bmp + 后缀和 MIME 对齐 | `wechat.js:621` `convertImageBlob` + `normalizeFilename` | ✅ |
| 多图文 ≤ 8 篇 | `wechat.js:317-319` `validatePublishPayload` | ✅ |
| 零宽字符 / BOM / NFC | `wechat-html.js:269-284` `cleanInvisibleChars` | ✅（双层）|
| 暗色 `background-clip:text` fallback | `wechat-html.js:252-258` | ✅ |
| 错误码 40164 (IP 白名单) 友好提示 | `wechat.js:73-77` | ✅ |
| 错误码 48001/53400 (账号无权限) | `wechat.js:94-104` | ✅ |
| 显式 `<button>` 不要写进模板 | `template-generator.js` | ✅ 模板生成器禁止输出 button |
| **2025-07 未认证账号权限提示** | — | ❌ 待加 UI 横幅 + 失败 modal |
| **草稿不进列表 / 关注者通知 3 篇** | — | ❌ 待写进 settings/help |
| **`mass/sendall` 群发显示到列表** | — | ❌ 完全未实现 |
| **`is_to_all` / `tag_id` 三种策略配置** | — | ❌ 未实现 |
| **`wechatApiBase` 可配 + FC 代理模板** | — | ❌ 仅硬编码 `api.weixin.qq.com` |
| 暗色模式所有彩字加 fallback color | 仅渐变文字处理了 | ⚠️ 待补「显式 hex fallback」策略 |

## 七、未实现 / 待路线

按优先级（待 P1 优化）：

### P1.1 — 2025-07 接口权限提示（最高优先级，否则用户会无解）
- 在 `src/options/options.html` 公众号配置区加一个红色横幅常驻显示，告知 2025-07 政策
- 在 `wechat.js` `ensureWechatOk()` 检测到 48001/53400 时，service worker 派发一个特殊事件，
  让 popup / workspace 弹一个 modal，给出**「复制 HTML 手动粘贴」**的兜底操作建议
- `docs/` 加一节「未认证账号怎么继续用本扩展」

### P1.2 — 群发接口 `mass/sendall` 实现
- `src/shared/wechat.js` 加 `massSendArticle(accessToken, mediaId, options)` 函数
  - `options.mode` ∈ `"all"` / `"tag"` / `"none"`
  - `mode=all`：`is_to_all=true`，无 tag_id
  - `mode=tag`：`is_to_all=false`，要求 `options.tagId`，否则报错
  - `mode=none`：不调群发，直接走现有 `freepublish/submit`
- `src/shared/wechat.js` 加 `listUserTags(accessToken)` 调 `cgi-bin/tags/get`，给 UI 用
- 在工作台「发布」面板加一个 segmented control：「不显示到列表 / 群发给所有粉丝 / 群发给指定标签」
- 在 `src/options/options.html` 加一个「公众号群发策略」配置项（默认值 + 默认 tag_id）
- 加每月群发配额 hint：`is_to_all=true` 每月最多 4 次，UI 显示用户已用次数（接口 `cgi-bin/template/api_get_industry`
  没法直接查；可以用 `chrome.storage.local` 自维护一个本月计数）

### P1.3 — IP 白名单代理（FC 方案）
- `cloudflare/wechat-api-proxy/` → 改为 `aliyun-fc/wechat-api-proxy/` 子目录（CF Worker 不可用，已在第四节说明）
- 提供：
  - `index.js`（Node.js 18 runtime） / `index.py` 函数代码
  - `template.yml`（serverless devs 部署模板）
  - `README.md` 一键部署 SOP（开通 FC → 部署 → 把 FC 域名填到扩展设置）
- 扩展端：
  - `src/shared/defaults.js` 加 `wechatApiBase` 字段（默认 `https://api.weixin.qq.com`）
  - `src/shared/wechat.js` 把所有 `https://api.weixin.qq.com/...` 改为读 `settings.wechatApiBase`
  - `options.html` 加输入框 + 保存
  - `testWechatConnection()` 也走自定义 base

### P1.4 — 暗色模式全量 fallback color
- `wechat-html.js` `sanitizeInlineStyle()` 检测到 `color: <浅色>` 时，自动追加一个 `data-light-color`
  属性 + 显式 hex fallback；并在 `applyDefaultStyles()` 给 `h1-h6 / p` 全部加默认 fallback color
- 提供测试用例：在浅色 + 暗色 wechat 客户端各跑一遍主题渲染，截图对比

### P2 — 长期演进
- 未认证账号「自动发到草稿 → 弹 PWA 提醒 → 用户点一下打开公众号后台并自动跳到草稿页」（需要扩展 host_permissions 加 `mp.weixin.qq.com`，已在）
- 配额监控：服务端 D1 加 `wechat_api_quota` 表记录每个 AppID 当月调用次数，前端展示

---

## 维护日志

- 2026-04-24 创建本文档（assistant + user 共建）。基于现有 `wechat.js` / `wechat-html.js` 实现做现状映射，
  把外部约束和本项目处理方式一一对账，识别出 4 项尚未实现的能力（P1.1–P1.4）。
