# 公众号改写排版台 · 授权服务（Cloudflare Workers）

这个目录是一个**独立**的 Cloudflare Workers 项目，给浏览器扩展提供：

- 用户注册 / 登录（邮箱 + 密码）
- License Key 在线验证（带 KV 限速、签名兜底）
- Lemon Squeezy 支付 webhook 自动签发 License Key
- Dashboard 可读接口（套餐 / 到期 / 设备列表）

它**不会**被 Chrome 扩展打包，扩展端只通过 `fetch` 调用它的 HTTPS 接口。

---

## 目录结构

```
server/
├── README.md         # 本文档
├── package.json      # 独立的 npm 配置（只装 wrangler）
├── wrangler.toml     # Cloudflare 项目配置
├── schema.sql        # D1 数据库初始化 SQL
└── worker.js         # 单文件 Worker（路由 / JWT / 验签 / 限速）
```

---

## 一次性准备工作

### 1. 安装 wrangler 与登录

```bash
cd server
npm install
npx wrangler login
```

### 2. 在 Cloudflare 创建 D1 数据库

```bash
# 在 server/ 目录下
npx wrangler d1 create gzh-license
```

把命令输出里的 `database_id` 粘贴到 `wrangler.toml` 的 `[[d1_databases]].database_id`。

### 3. 创建 KV namespace（用作限速）

```bash
npx wrangler kv:namespace create gzh-license-rl
```

把 `id` 粘贴到 `wrangler.toml` 的 `[[kv_namespaces]].id`。

### 4. 注入 secret（**这些不能写明文进 wrangler.toml**）

```bash
# 长度 ≥ 32 的随机串。可用：
# openssl rand -base64 48
npm run secret:jwt

# Lemon Squeezy 后台 → Settings → Webhooks → Signing Secret
npm run secret:webhook

# 自定义随机串，用于服务端给插件返回离线签名
npm run secret:signing
```

### 5. 初始化数据库

```bash
# 远程
npm run db:init

# 本地（wrangler dev 用）
npm run db:init:local
```

### 6. 编辑 `wrangler.toml`

至少改这几个字段：

| 字段 | 改成 |
|---|---|
| `database_id` | 步骤 2 输出 |
| `id`（KV） | 步骤 3 输出 |
| `ALLOWED_ORIGINS` | 你的官网域名 + `chrome-extension://你的扩展ID` |
| `SITE_URL` | 你的官网域名 |
| `LS_STORE_ID` | Lemon Squeezy store id |
| `LS_VARIANT_IDS` | 卖 Pro 的 variant id（多个用逗号分隔；空 = 不过滤） |

---

## 本地联调

```bash
cd server
npm run dev
```

默认起在 `http://127.0.0.1:8787`，扩展端把 `LICENSE_API_BASE` 指到这个地址即可。

测试一下：

```bash
curl http://127.0.0.1:8787/api/health
# {"ok":true,"ts":...}

curl -X POST http://127.0.0.1:8787/api/register \
  -H "Content-Type: application/json" \
  -d '{"email":"test@example.com","password":"12345678"}'
```

---

## 部署到生产

```bash
npm run deploy
```

部署完会拿到一个 `https://gzh-license.<你的子域>.workers.dev` 的 URL。如果要绑自定义域名（推荐 `https://api.your-domain.com`），在 Cloudflare Dashboard 的 Workers Routes 里加路由即可。

---

## 接口速查

| 路由 | 方法 | 用途 | 鉴权 |
|---|---|---|---|
| `/api/health` | GET | 健康检查 | 无 |
| `/api/register` | POST | 注册新账户 | 无 |
| `/api/login` | POST | 登录拿 JWT | 无 |
| `/api/me` | GET | 当前用户 + license 概览 | JWT |
| `/api/license/bind` | POST | 把 key 绑到当前账号 | JWT |
| `/api/license/unbind` | POST | 解绑 | JWT |
| `/api/license/verify` | POST | 插件验证 license（核心） | 无（带限速） |
| `/api/license/deactivate` | POST | 插件解绑当前设备 | 无 |
| `/api/webhook/lemon` | POST | Lemon Squeezy 回调 | HMAC 签名 |

### `/api/license/verify` 请求 / 响应

请求：

```json
{
  "key": "GZHT-XXXX-XXXX-XXXX",
  "deviceFingerprint": "chrome-extension-id|some-random",
  "deviceLabel": "MacBook Pro · Chrome 124"
}
```

响应（成功）：

```json
{
  "ok": true,
  "plan": "pro",
  "status": "active",
  "expiresAt": 1760000000000,
  "features": {
    "wechat.publish": true,
    "wechat.multiAccount": true,
    "scrape.drission": true,
    "hot.advancedSources": true,
    "ai.advancedTemplates": true,
    "ai.batchRewrite": true,
    "ai.deAiBoost": true,
    "ai.unlimitedDaily": true
  },
  "dailyQuota": -1,
  "signedAt": 1750000000000,
  "signature": "..."
}
```

响应（失败）：

```json
{ "ok": false, "error": "License Key 无效" }
```

`signature + signedAt` 让插件能在 24h 内**离线**继续信任 plan，避免每次启动都强制联网。

---

## Lemon Squeezy 配置

1. Lemon Squeezy 后台 → **Settings → Webhooks** → 新建一个 webhook：
   - URL：`https://你的Worker域名/api/webhook/lemon`
   - 勾选事件：`order_created`、`subscription_created`、`subscription_updated`、`subscription_cancelled`、`subscription_expired`、`subscription_resumed`
   - Signing Secret 用 `npm run secret:webhook` 注入。

2. 在你的 Pro 商品页（embed checkout 或 redirect checkout）的 `success_url` 上，可以带 `?email={user_email}`，这样用户付完会回到 Dashboard 自动认领 license。

3. 如果同一邮箱已经在 worker 注册过账户，**webhook 会自动把 license 绑到该用户**（无需手动绑定）。

---

## 安全说明

- **密码**：PBKDF2-SHA256 + 16 字节 salt + 200,000 次迭代，不可逆。
- **JWT**：HS256，7 天有效期。
- **Webhook**：必须验签 + 用 `webhook_events` 表做幂等去重。
- **限速**：`/api/license/verify` 每个 (key, ip) 每 60s 上限 10 次。
- **离线信任签名**：`LICENSE_SIGNING_SECRET` 永不外传，插件只能验证签名时间戳 + plan，不能伪造。

---

## 常见问题

**Q: 我能不能不要自建账户系统，直接用 Lemon Squeezy 自带的 License Keys API？**

A: 当前架构是「账号 + 我们自己签发 key」。如果你后期想完全用 LS 的 License，只需要修改 `dispatchLemonEvent` 里的 `generateLicenseKey()` 调用，把 LS payload 中的 `license_key.attributes.key` 直接写入 `license_keys.key` 字段即可（`ls_license_id` 字段已预留）。

**Q: 我已经有了一些老用户，怎么手动给他们发 key？**

A: 先用 `wrangler d1 execute` 直接 insert：

```sql
INSERT INTO license_keys (key, user_id, plan, status, expires_at, created_at, updated_at)
VALUES ('GZHT-XXXX-XXXX-XXXX', NULL, 'pro', 'active', NULL, strftime('%s','now')*1000, strftime('%s','now')*1000);
```

key 段必须是 32 字符表（去掉 0/1/I/O）里的字符，校验位见 `worker.js` 的 `computeChecksumSegment`。

**Q: 怎么吊销一个被滥用的 key？**

```sql
UPDATE license_keys SET status='revoked' WHERE key='GZHT-XXXX-XXXX-XXXX';
```

下一次插件验证时就会拿到 `403`，自动回退到免费版。
