# Google OAuth 接入指南

> **目标读者**：你是这个项目的运维 / 部署者，想给登录页加一个 "使用 Google 继续" 按钮，并且让用户的 Google 账号能直接登录现有的润笔账号体系，与邮箱密码完全打通。
>
> **预计耗时**：12～20 分钟（其中等 GCP 项目创建、OAuth 同意屏审核 = 大头）。
> **资质要求**：**无**。任何 Google 账号都能创建 OAuth Client，不需要企业认证、不需要付费、不需要审核（只要 scope 控制在 `openid email profile` 内，永远是 "Self-certified"）。

---

## 前置条件

| 项 | 要求 |
|---|---|
| 域名 | 已经在用 `docuearn.com`（或你自己的）跑 site/，HTTPS 已配 |
| 后端 | `api.docuearn.com` 已经跑着 `server/worker.js`，能拿到 D1 + KV |
| 前端 | `site/` 已经部署到 Cloudflare Pages（或同级别静态托管） |
| Google 账号 | 一个能登录 GCP 的账号（个人/企业都行） |

---

## Step 1 · 创建 Google Cloud 项目

1. 打开 https://console.cloud.google.com/ ，登录你常用的 Google 账号
2. 顶栏点项目名 → 弹窗 → **NEW PROJECT**
   - **Project name**: `DocuEarn`（或你喜欢的名字，跟产品同名最省事）
   - **Organization** / **Location**: 个人开发者保持默认 "No organization" 即可
   - 点 **CREATE**，等约 20 秒
3. 创建完成后顶栏切换到这个新项目

---

## Step 2 · 配置 OAuth 同意屏（Consent Screen）

> 这一步决定用户点 Google 登录时弹窗里看到什么。**个人开发者 = External + Testing 模式**就够，永远免费、不需要 Google 审核，唯一限制是默认最多 100 个测试用户（足够 MVP 期）。

1. 左栏 **APIs & Services → OAuth consent screen**
2. 选 **External**，点 CREATE
3. 填 App information：
   - **App name**: `润笔 DocuEarn`
   - **User support email**: 你的邮箱
   - **App logo**: 上传 `dist/store/icon-128.png`（润笔 logo，可选）
4. 填 App domain：
   - **Application home page**: `https://docuearn.com`
   - **Application privacy policy**: `https://docuearn.com/privacy`
   - **Application terms of service**: `https://docuearn.com/terms`
5. **Authorized domains**: 加 `docuearn.com`（不带 https://，不带斜杠）
6. **Developer contact**: 你的邮箱 → SAVE AND CONTINUE
7. **Scopes** 页：什么都不要加（默认隐式包含 `openid`），直接 SAVE AND CONTINUE
   - 我们前端只用 `id_token`，不申请任何敏感权限，永远不用走 verification
8. **Test users**: 把你自己的测试 Google 邮箱加上几个 → SAVE AND CONTINUE
9. **Summary** → BACK TO DASHBOARD

> **要不要发布到 Production？** 在 Testing 模式下任何"测试用户"都可以登录；当你准备让所有人用时，回到这个页面点 **PUBLISH APP** 即可，**不需要任何 Google 审核**（因为 scope 都是基础的）。

---

## Step 3 · 创建 OAuth 2.0 Client ID

1. 左栏 **APIs & Services → Credentials**
2. 顶栏 **+ CREATE CREDENTIALS → OAuth client ID**
3. **Application type**: `Web application`
4. **Name**: `DocuEarn Web Client`（仅内部识别用）
5. **Authorized JavaScript origins**：把所有要支持 Google 登录的前端域名都加上，**注意不要带尾斜杠**：

   ```
   https://docuearn.com
   https://www.docuearn.com
   http://localhost:5173       ← 本地开发用
   http://localhost:8788       ← cloudflare pages dev 默认端口
   ```

6. **Authorized redirect URIs**：**留空即可**
   - 我们走的是 Google Identity Services（GIS）的 popup 流程，不走传统 redirect，所以不需要回调 URL
7. 点 **CREATE**
8. 弹窗里复制 **Client ID**（形如 `1234567890-abc...xyz.apps.googleusercontent.com`），下一步要用
   - **Client secret 用不到**，GIS 走 ID Token 流程，不需要 secret 交换 code → token

---

## Step 4 · 配置到前端 + 后端

### 4.1 前端

打开 `site/assets/js/site-config.js`，把 `GOOGLE_CLIENT_ID` 字段填上：

```js
export const SITE_CONFIG = {
  // ... 其它配置不变 ...
  GOOGLE_CLIENT_ID: "1234567890-abcdefghij.apps.googleusercontent.com"
};
```

> **可选**：如果你不想动 `site-config.js`（比如多个环境用不同 client id），也可以在某张登录页 HTML 头部加 `<meta name="google-client-id" content="...">` 来覆盖。`login.js` 里 `getGoogleClientId()` 会优先用 meta。

### 4.2 后端

打开 `server/wrangler.toml`，把 `GOOGLE_CLIENT_ID` 字段填上同一个值：

```toml
[vars]
GOOGLE_CLIENT_ID = "1234567890-abcdefghij.apps.googleusercontent.com"
```

> 前端和后端用的 **必须是同一个 Client ID**：前端用它去发起授权，后端用它校验 ID Token 的 `aud` 字段。**两边不一致 → 后端永远拒登。**

---

## Step 5 · 数据库迁移（仅老数据库需要）

如果你的 `gzh-license` D1 数据库是 **新部署**（之前没初始化过），跳过这一步——`server/schema.sql` 已经包含 `google_sub` / `oauth_provider` 字段。

如果是 **已经在跑的老数据库**，跑一次迁移：

```bash
# 远程
wrangler d1 execute gzh-license \
  --file=./server/migrations/2026-04-23-add-google-oauth.sql

# 本地（如果你本地也跑 wrangler dev）
wrangler d1 execute gzh-license --local \
  --file=./server/migrations/2026-04-23-add-google-oauth.sql
```

迁移做的事：
- `users` 表新增 `google_sub` (TEXT, UNIQUE) 和 `oauth_provider` (TEXT) 两列
- 加 `idx_users_google_sub` 唯一索引
- 加 `idx_users_oauth_provider` 普通索引

幂等：用 `IF NOT EXISTS` 写的索引，重复跑无害。但 `ALTER TABLE ADD COLUMN` 不是幂等的，**只能跑一次**。

---

## Step 6 · 部署 + 自测

```bash
# 1. 部署后端
cd server
wrangler deploy

# 2. 部署前端（取决于你的部署方式，例如 Cloudflare Pages 自动从 git 拉）
git add . && git commit -m "feat(auth): 接入 Google OAuth 登录" && git push
```

打开 `https://docuearn.com/login`，应该能看到：

- 登录卡片顶部出现 **"继续使用 Google"** 按钮（带 G 图标）
- 下方一行小字提示「用 Google 登录将自动用同邮箱关联已有账号…」
- 再下方 "或使用邮箱" 分隔线，再下方是原有的邮箱密码表单

测试 4 种关键场景：

| 场景 | 预期 |
|---|---|
| 全新 Google 账号点登录 | 直接进 dashboard，`/api/me` 看到 user.email = Google 邮箱 |
| 同邮箱已经用密码注册过 | Google 登录后，自动关联到原账号，license 不丢 |
| OAuth-only 账号又用密码登录 | 提示「该账号通过 Google 登录，请点击页面上的"使用 Google 登录"按钮」 |
| 同邮箱去注册页注册 | 提示「该邮箱已通过 Google 登录注册。请直接点「使用 Google 登录」。」 |

---

## 常见问题排查

### 浏览器控制台报 `[GSI_LOGGER]: The given origin is not allowed for the given client ID`

→ Step 3 的 **Authorized JavaScript origins** 没加当前域名。注意 `http://localhost:5173` 和 `https://docuearn.com` 是两个不同的 origin，都得加。

### 后端返回 `503 服务端未配置 Google 登录`

→ `wrangler.toml` 的 `GOOGLE_CLIENT_ID` 没填，或者改完忘了 `wrangler deploy`。

### 后端返回 `aud 与 GOOGLE_CLIENT_ID 不匹配`

→ 前端 `site-config.js` 和后端 `wrangler.toml` 用的不是同一个 Client ID。

### 后端返回 `找不到匹配 kid 的 Google 公钥`

→ 极少出现。Google 大约每 6 小时滚一次密钥，KV 缓存过期前可能短暂落空。Worker 已经有自动 refetch 兜底，让用户重试即可；持续失败说明 worker 出站访问 https://www.googleapis.com 被拦了。

### 用户在中国大陆能用吗

→ Google Identity Services 的 SDK 来自 `accounts.google.com`，在中国大陆默认不可访问。`login.js` 里的 `waitForGoogleSdk()` 有 10 秒超时，**SDK 加载失败 → Google 按钮区直接保持隐藏**，用户体感是只看到邮箱密码登录，**不会卡白屏**。

---

## 安全要点（已实现）

- ID Token 验签走 Google 官方 JWKS（`https://www.googleapis.com/oauth2/v3/certs`），KV 缓存 1 小时
- 校验 `iss` 必须是 `accounts.google.com` 或 `https://accounts.google.com`
- 校验 `aud` 必须等于 `GOOGLE_CLIENT_ID`（前后端一致才行）
- 校验 `exp`（带 60 秒容差）
- 校验 `email_verified` 必须为 true
- 同一 IP 调 `/api/auth/google` 限速 20 次/分钟（防暴力枚举）
- 同邮箱已经绑过另一个 google_sub 时，拒绝再次绑定（防账号劫持）
- OAuth-only 账号的 `password_hash` / `password_salt` 存非 base64 占位（`oauth:google`），密码登录路径里 PBKDF2 永远算不出匹配值；同时 `oauth_provider` 字段双重保险，提前拦截给出友好提示

---

## 后续可扩展的事

- **GitHub OAuth**：照搬本套架构，加 `github_sub` 字段 + `verifyGithubAccessToken()`，再前端加一个 `<button>`，~2 小时；
- **多 OAuth 同账号合并**：用户在 dashboard 加 "已绑定登录方式" 区，能解绑/绑定 Google/GitHub；
- **OAuth-only 账号补设密码**：dashboard 加 "设置密码" 入口，让用户后续也能用邮箱密码登录（适合切机器场景）；
- **微信扫码登录**：需要企业认证，暂不在本次 scope，详见 `docs/PERMISSIONS_AND_STORE.md`。
