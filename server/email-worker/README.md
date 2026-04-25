# support-autoreply · 自动回复 Worker

> **触发地址**：`support@docuearn.com`
> **首发**：2026-04-24（sixth session 跑通 → 2026-04-25 代码进 repo）
> **决策依据**：见 `memory-bank/activeContext.md` 2026-04-24 sixth session "support@docuearn.com 自动回复全链路上线"

---

## 它做什么

用户发邮件到 `support@docuearn.com` 之后，**30 秒内**会收到一封带工单号 `[DOC-YYYYMMDD-NNNN]` 的自动回复，正文包含：

- 已收到通知 + 24 小时回复承诺
- 3 条自助链接（FAQ / 使用文档 / 更新日志）
- 6 项请求用户补充的诊断信息（插件版本 / Chrome 版本 / 系统 / 截图 / Console / 购买邮箱）
- 早期用户私人微信快速通道

同时把原邮件转发到运营 Gmail 由真人接手。

---

## 架构

```
用户 → support@docuearn.com
        ↓ Cloudflare Email Routing
        ↓ ("Send to a Worker" action)
   support-autoreply Worker
        ├─→ message.forward(env.FORWARD_TO)  → 运营 Gmail
        └─→ fetch(api.resend.com)            → 自动回复给用户
```

**收信走 Cloudflare**（免费、不限量），**发信走 Resend**（100 封/天免费），各司其职。⚠️ **绝对不要在 Resend 打开 "Enable Receiving"**，会冲掉 Cloudflare Email Routing 的 MX，整条链路废掉。

---

## 首次部署 SOP

### Step 1 · Resend 域名验证

按 `docs/RESEND_EMAIL_SETUP.md` 跑通 Step 1-3：注册 Resend → 加 docuearn.com → 配 3 条 DNS → Verified。

完成后拿到 `re_xxxxxxxx` 这个 API Key。

### Step 2 · Cloudflare 加并验证 destination address

1. Cloudflare Dashboard → 选 docuearn.com → Email → Email Routing → **Destination addresses**
2. **+ Add destination address**，填 `wrangler.jsonc` 里 `FORWARD_TO` 那个 Gmail
3. Gmail 收到 Cloudflare 的验证邮件 → 点链接
4. 该地址旁边显示 `Verified ✓`

⚠️ 不做这步直接部署，Worker 跑起来会抛 `destination address not verified`。

### Step 3 · 改占位符 + 部署

```bash
cd server/email-worker
```

**编辑 `wrangler.jsonc`**：
- `vars.FORWARD_TO` 改成你 Step 2 验证好的真实 Gmail
- `vars.WECHAT_ID` 改成客服微信号

**部署**：

```bash
npx wrangler deploy
```

部署完成后顶部会输出新版本号。

### Step 4 · 注入 Resend API Key（Secret）

```bash
npx wrangler secret put RESEND_API_KEY --name support-autoreply
# 粘贴 re_xxxxxxxx，回车
```

⚠️ **必须用 secret 不要用 vars**，否则 Cloudflare Dashboard 会明文显示 API Key。

### Step 5 · 把 support@ 路由切到本 Worker

1. Cloudflare → Email Routing → **Routes**
2. 找到 `support@docuearn.com` → Edit
3. **Action**: `Send to a Worker`
4. **Destination**: `support-autoreply`
5. Save

### Step 6 · 真人测试

```bash
npx wrangler tail support-autoreply --format pretty
```

用任意外部邮箱（foxmail / qq / 同事的 Gmail）发一封到 `support@docuearn.com`，预期看到：

```
Email from:xxx@xxx.com to:support@docuearn.com ... - Ok
[autoreply] sent ticket=DOC-20260425-1234 to=xxx@xxx.com
```

同时：
- 测试发件箱（包括垃圾邮件文件夹）应收到带 `[DOC-20260425-1234]` 工单号的自动回复
- 运营 Gmail 应收到原邮件（用于人工接手）

---

## 改动 / 维护

### 想改自动回复正文文案？

直接改 `support-autoreply.js` 的 `buildAutoReplyText()` / `buildAutoReplyHtml()` 两个函数，然后 `npx wrangler deploy`。

两个函数共享同一份信息（HTML 是带样式版本，text 是纯文本兜底），改文案时**必须两边同步改**，否则邮件客户端切到纯文本视图会看到旧文案。

### 想加 FAQ 链接 / 更换文档站？

改文件顶部的 3 个常量：

```js
const FAQ_URL = "https://docuearn.com/faq";
const DOCS_URL = "https://docuearn.com/docs";
const CHANGELOG_URL = "https://docuearn.com/changelog";
```

### 想换运营 Gmail？

1. 先去 Cloudflare → Email Routing → Destination addresses 加新 Gmail + 验证
2. 改 `wrangler.jsonc` 的 `vars.FORWARD_TO`
3. `npx wrangler deploy`

不要先部署再加 destination，会有一段时间所有邮件转发失败。

### 想加分类 / 路由（"退款" 走不同模板）？

在 `email()` handler 顶部根据 `originalSubject` 或 `message.raw` 关键词判断分支，比如：

```js
const subject = (message.headers.get("subject") || "").toLowerCase();
const isRefund = subject.includes("退款") || subject.includes("refund");
const replyHtml = isRefund
  ? buildRefundReplyHtml(ticketId, wechatId)
  : buildAutoReplyHtml(ticketId, wechatId);
```

---

## 常见报错排查

| 日志 / Resend 返回 | 原因 | 修复 |
|---|---|---|
| `Error: destination address not verified` | `FORWARD_TO` 没在 Cloudflare Email Routing 加并验证 | 跑首次部署 SOP 的 Step 2 |
| `[autoreply] failed ... status=403 ... domain is not verified` | Resend 那边 docuearn.com 还没验证 / 验证掉了 | 回 `docs/RESEND_EMAIL_SETUP.md` Step 2 |
| `[autoreply] failed ... status=401 Invalid API Key` | RESEND_API_KEY 错了 / 被 Resend 撤销了 | 重新生成 + `wrangler secret put` |
| `[autoreply] failed ... status=422 from is required` | `FROM_ADDR` 不是 `xxx@已验证域名` 格式 | 检查 `wrangler.jsonc` 里 `FROM_ADDR` 拼写 |
| `[autoreply] failed ... status=429 Too many requests` | Resend Free 额度（100 封/天）用完了 | 等次日 0 点 UTC 重置 / 升级 Resend Pro |
| 没有任何日志，邮件石沉大海 | Email Routing 还没切到 Worker | 跑首次部署 SOP 的 Step 5 |
| 自动回复无限循环 | `FROM_ADDR` 没配置导致自循环防护失效 | 检查 `wrangler.jsonc` `vars.FROM_ADDR` 是否存在 |

---

## 相关文档

- 首次接 Resend：`docs/RESEND_EMAIL_SETUP.md`
- 历史决策：`memory-bank/activeContext.md` 2026-04-24 sixth session
- 长期阶段触发器（什么时候升级到 Plain）：`memory-bank/activeContext.md` 同 session "长期阶段触发器（写进备忘）" 表
- 自动回复正文里引用的 3 个支撑页：`site/faq.html` / `site/docs.html` / `site/changelog.html`

---

## 已知约束

- **Resend Free 100 封/天**：早期够用。如果某天接近上限，要么升 Resend Pro（$20/月 / 50000 封），要么把这个 Worker 改成「先看 KV 计数器，超过阈值不回复（只转发 Gmail）」。
- **Cloudflare Email Worker 不能调 Durable Objects / D1**：官方限制。所以工单号目前只是无状态生成（同一封邮件每次重发会拿到新工单号）。如果以后要做"用户在 Gmail 里回复同一工单 = 同一对话"，需要把工单号 → 原始 Message-ID 映射存到 KV / D1 里。
- **没接 Plain / Crisp 等工单系统**：早期 < 50 工单/周用 Gmail 标签足够。升级触发指标见 activeContext.md 同 session "长期阶段触发器" 表。
