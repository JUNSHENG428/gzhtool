# Resend 邮件服务接入指南

> **目标读者**：你是这个项目的运维 / 部署者，想让 `/api/auth/request-reset`（忘记密码 → 收邮件 → 设新密码）真的能把邮件发到用户邮箱。
>
> **预计耗时**：15～30 分钟（其中 DNS 验证传播 = 大头）。
> **资质要求**：能控制 `docuearn.com` 的 DNS（Cloudflare DNS 即可）。免费额度 100 封/天 / 3000 封/月，对早期日常完全够用。

---

## 为什么必须接

Worker 已经写好了 `/api/auth/request-reset` + `/api/auth/reset` 的完整链路，但**邮件实际发出去**这一步留了集成点（见 `server/worker.js` `sendResetEmail`）。如果不接邮件服务：

- **OAuth-only 用户被卡死**：用 Google 一键登录注册的用户没有密码，想在 Chrome 插件里登录就必须先有密码。dashboard 加了「设置插件登录密码」按钮（详见 commit），是首选路径。但万一用户不知道这个按钮、跑去登录页点「忘记密码」，就会发现「请求已收到」但永远收不到邮件 → 投诉。
- **邮箱密码用户忘记密码**：永远找不回账号 → 退款。

简而言之：**A 方案（dashboard 设密码按钮）是 OAuth-only 用户的快速路径，B 方案（接 Resend）是兜底，两者一起做才完整。**

---

## 前置条件

| 项 | 要求 |
|---|---|
| 域名 | 你能控制 `docuearn.com` 的 DNS（推荐 Cloudflare DNS） |
| 后端 | `api.docuearn.com` 已经跑着 `server/worker.js` |
| 邮箱 | 一个能收邮件的工作邮箱（注册 Resend 用） |

---

## Step 1 · 注册 Resend 账号

1. 打开 <https://resend.com>，点右上角 **Sign Up**，用 GitHub 或邮箱登录
2. 验证注册邮箱（收一封邮件，点链接）
3. 默认进入 Free 计划：**100 封/天 / 3000 封/月**，足够 docuearn 早期使用

---

## Step 2 · 添加并验证发件域名

1. 左侧菜单 → **Domains** → 右上 **Add Domain**
2. **Domain**: `docuearn.com`
3. **Region**: 选 **Tokyo (ap-northeast-1)** 或 **Singapore (ap-southeast-1)**（亚洲用户接收更快）
4. 点 **Add** → Resend 会给出 **3 条 DNS 记录**（一般是 1 条 MX + 1 条 TXT/SPF + 1 条 DKIM CNAME）

**到 Cloudflare Dashboard → 选 `docuearn.com` → DNS → 把这 3 条记录都加上**：

> ⚠️ 关键陷阱：Cloudflare 的 CNAME 记录默认会有 **Proxy status = Proxied (橙云)**。
> Resend 验证 DKIM CNAME **必须把橙云改成灰云（DNS only）**，否则永远验证失败。

| Type | Name | Value | Proxy |
|---|---|---|---|
| MX | send | feedback-smtp.\<region\>.amazonses.com | DNS only |
| TXT | send | "v=spf1 include:amazonses.com ~all" | DNS only |
| CNAME | resend._domainkey | resend._domainkey.\<...\>.amazonses.com | **DNS only（灰云！）** |

5. 加完后回 Resend 的 Domain 详情页，等 1-5 分钟，点 **Verify DNS Records**
6. 三个状态都变绿色 ✓ 即可

---

## Step 3 · 创建 API Key

1. 左侧菜单 → **API Keys** → 右上 **Create API Key**
2. **Name**: `docuearn-prod-worker`
3. **Permission**: **Sending access** （只能发邮件，不能改账户配置）
4. **Domain**: 选刚才验证好的 `docuearn.com`
5. 点 **Add** → **复制弹出来的 `re_xxxxxx` 字符串，关闭后再也看不到**

> 把这个 key 立刻贴到密码管理器（1Password / Bitwarden）里存一份。

---

## Step 4 · 注入到 Worker

在你的本地 `server/` 目录下：

```bash
cd /Users/junshengma/Desktop/gzh/server

# 把 API Key 注入为 Cloudflare Worker secret（生产环境）
npx wrangler secret put RESEND_API_KEY
# 粘贴 re_xxxxxx，回车
```

`wrangler.toml` 里**已经预留了 RESET_EMAIL_FROM 的注释占位**。如果发件人不是默认的 `no-reply@docuearn.com`，取消那行注释并改成你的发件地址（必须是已验证域下的地址）。

发件地址做法上的两个建议：
- 用 `no-reply@docuearn.com` 表示"系统通知，请勿回复"
- 真要双向沟通用 `support@docuearn.com`（已经在 Cloudflare Email Routing 转发到你的 Gmail）

---

## Step 5 · 部署 + 真人测试

```bash
cd /Users/junshengma/Desktop/gzh/server
npx wrangler deploy
```

验证流程（3 分钟）：

1. 浏览器打开 <https://docuearn.com/login.html>
2. 点「忘记密码？」→ 输入你自己的邮箱 → 提交
3. 等 30 秒内应该收到一封 `润笔 · 重置你的密码` 邮件
4. 点邮件里的链接 → 跳到 `/reset.html?token=...` → 设新密码
5. 用新密码登录，应该成功

如果第 3 步收不到邮件：

```bash
cd /Users/junshengma/Desktop/gzh/server
npx wrangler tail --format pretty --status error
# 触发一次「忘记密码」请求，看 [reset] 开头的日志
```

按项目 SOP，`sendResetEmail` 已经把请求 + 响应 status + body 前 500 字符都打了出来。常见错误：

| Resend 返回 | 含义 | 修复 |
|---|---|---|
| `403 The from address is not verified` | 发件域名 DNS 没验证完 | 回 Step 2 看 3 条记录是否都绿 |
| `422 from is required` | `RESET_EMAIL_FROM` 写成了无效格式 | 必须是 `xxx@已验证的域名` |
| `401 Invalid API Key` | 注入到 wrangler 的 key 错了 / 被 Resend 撤销了 | 重新跑 Step 3、Step 4 |
| `429 Too many requests` | Free 计划日额超了 | 等次日 0 点 UTC 重置，或升级付费 |

---

## 测试态：DEBUG_RESET 让接口直接返回 reset URL

在 dev 环境（不接邮件、想 curl 测整个 reset 流程）：

```bash
# wrangler.toml [vars] 里临时加：
DEBUG_RESET = "1"

# 然后部署或 wrangler dev
# /api/auth/request-reset 会在 JSON 里多返回 { resetUrl: "https://..." }
# 直接拿这个 URL 在浏览器打开测试 reset 流程，跳过邮件
```

**生产严禁开 DEBUG_RESET**：等于把任何用户邮箱对应的 reset URL 直接吐出来，等于绕过邮箱验证。

---

## 长期监控

- Resend 控制台 → **Logs** 可以看每封邮件的投递详情（送达 / 软退 / 硬退）
- 如果某天日额用完，建议升级 Resend Pro（$20/月 / 50000 封/月），或并接 Mailgun 做 fallback（fallback 实现可参考 `sendResetEmail` 的结构，再加一个 if/else）

---

## 已知限制

- Resend 在 Cloudflare Workers 环境下不需要 SDK，直接 `fetch` 即可（worker 已是这种实现）
- 国内 QQ/163 邮箱**对国外发件域名通常会进垃圾箱**。docuearn 长期可能要给 Gmail 邮箱转发主路径 + 给 QQ/163 邮箱用户在 dashboard 显示「也可去垃圾箱看」的提示，或者自托 SMTP（不在 P0 范围）
- Resend 不支持中国大陆 IP 直接访问控制台 → 需要梯子才能进控制台改配置（API 调用本身从 Cloudflare Worker 出去，不受影响）
