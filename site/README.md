# 润笔 · 官网（site/）

这个目录是「润笔」的营销与控制台站点，纯静态：HTML + 原生 ES Modules + CSS，
无任何打包步骤，可直接拖到 Cloudflare Pages 部署。

## 页面结构

| 路径               | 说明                                                       |
| ------------------ | ---------------------------------------------------------- |
| `/index.html`      | 首页（hero 插画 + 6 项核心能力 + 定价 CTA）                |
| `/pricing.html`    | 定价（Free / Pro 月付 / Pro 年付 + FAQ + Lemon overlay）   |
| `/login.html`      | 登录 + 注册（密码强度 / 可见 / 记住邮箱 / 忘记密码入口）   |
| `/forgot.html`     | 忘记密码（提交邮箱 → worker 发重置链接，60s 防刷）         |
| `/reset.html`      | 设置新密码（?token=… → 直接发新 JWT 自动登录）             |
| `/dashboard.html`  | 控制台（账号 / 套餐 / License / 设备列表 / 解绑 / 改密码） |

`_redirects` 把 `/pricing`、`/login`、`/register`、`/forgot`、`/reset`、`/dashboard`
这种"无后缀" URL 内部重写到 `.html`，更利于 SEO 与好看的链接。

## 设计 / 视觉

- 字体：[Noto Serif SC](https://fonts.google.com/noto/specimen/Noto+Serif+SC) +
  [Noto Sans SC](https://fonts.google.com/noto/specimen/Noto+Sans+SC)，
  通过 `<link rel="stylesheet" href="https://fonts.googleapis.com/css2?...&display=swap">`
  异步加载；未到达时无缝降级到系统字体（`PingFang SC`、`Hiragino Sans GB` 等）。
- Hero 插画：首页一张全 inline SVG（不依赖任何外部资源），抽象的"杂志桌面 + 盆栽 + 飘出的小标签"，
  颜色完全用 CSS 变量复用主题。
- 入场动效：`.hero-stagger > *` CSS-only 错开淡入；`.reveal` 类配合
  `IntersectionObserver` 在元素进入视口时淡入上推。`prefers-reduced-motion` 用户
  会一次性跳过所有动效。

## 配置

### API base

每个 .html 顶部都有：

```html
<meta name="api-base" content="" />
```

部署时把 `content` 替换为真正的 worker 地址，例如：

```html
<meta name="api-base" content="https://gzh-license.your-account.workers.dev" />
```

或者在 `assets/js/api.js` 改 `FALLBACK_BASE`。

### Lemon Squeezy 结账链接 + 全站环境配置

所有"和环境绑定"的字符串都集中在 [`assets/js/site-config.js`](./assets/js/site-config.js)：

```js
export const SITE_CONFIG = {
  WORKER_BASE: "https://gzh-license.workers.dev",
  LEMON_LINKS: {
    monthly: "https://yourstore.lemonsqueezy.com/buy/REPLACE-ME-MONTHLY",
    yearly:  "https://yourstore.lemonsqueezy.com/buy/REPLACE-ME-YEARLY"
  },
  LEMON_USE_OVERLAY: true,
  CHECKOUT_SUCCESS_URL: "/dashboard.html?from=checkout&result=success",
  CHECKOUT_CANCEL_URL:  "/pricing.html?from=checkout&result=cancel",
  SUPPORT_EMAIL: "hello@example.com"
};
```

上线前**必须**改的：

1. `WORKER_BASE` → 你的 Cloudflare Worker 域名
2. `LEMON_LINKS.{monthly,yearly}` → 真实 Lemon Squeezy variant URL
3. `SUPPORT_EMAIL` → 你的客服邮箱

`pricing.js` 的行为：

- 当用户已登录时，自动把 `?checkout[email]=…` 预填到结账页
- 如果配置了 `CHECKOUT_SUCCESS_URL`，付款成功后用户回到 dashboard，
  并在 dashboard 弹一个 toast「License Key 几分钟内会出现」（同时 5s 后自动重新 `/api/me`）
- `LEMON_USE_OVERLAY: true` 时按钮加 `.lemonsqueezy-button` class，并自动注入 `lemon.js`
  实现弹窗式结账（不跳出当前 tab）。设为 `false` 则走 `target="_blank"` 跳转。
- 配置占位为 `REPLACE-ME` 时按钮自动禁用并提示，避免上线时跳到 404。

### 忘记密码邮件

worker 端在 `handleRequestReset` 通过 `sendResetEmail()` 发送邮件。集成方式：

- 配 `RESEND_API_KEY` 与 `RESET_EMAIL_FROM`（wrangler secret），即走 [Resend](https://resend.com)；
- 没配时会在 worker 日志打印 reset URL（开发环境联调用）；
- 把 `DEBUG_RESET=1` 通过 wrangler env 设上后，`/api/auth/request-reset` 会
  在响应里直接返回 `resetUrl` 字段（**只在开发环境开**）。

## 本地预览

任意静态文件服务器都行：

```bash
# Python 3
python3 -m http.server -d site 5173

# 或 npm
npx serve site -l 5173
```

打开 http://localhost:5173 即可。

## 部署到 Cloudflare Pages

### 方式一：Dashboard 拖拽（最快）

1. 登录 Cloudflare Dashboard → Workers & Pages → Create → Pages → Upload assets
2. 把 `site/` 这个目录整体拖进去
3. 项目名建议 `gzh-site`
4. 部署完成后绑自定义域名（推荐 `www.your-domain.com`）

### 方式二：Git 集成（推荐长期使用）

1. 把仓库推到 GitHub
2. Cloudflare Pages → Create → Pages → Connect to Git
3. 选择仓库 + 分支 `main`
4. 构建设置：
   - **Framework preset**: None
   - **Build command**: 留空
   - **Build output directory**: `site`
5. 部署后每次 push 都会自动重新发布

### 方式三：Wrangler CLI（适合脚本化）

```bash
npm i -g wrangler
wrangler pages deploy site --project-name=gzh-site
```

## 域名 + HTTPS

Cloudflare Pages 默认给 `*.pages.dev` 子域，并自动签 HTTPS。
绑自定义域名也是一键：在项目 → Custom domains → Set up a custom domain。
DNS 记录会自动建好。

## 与扩展的关系

- 站点数据来自 `server/worker.js`（Cloudflare Worker）。
- 扩展内的设置页 → 会员激活 Tab 也调用同一个 worker。
- 所以**站点和扩展共用一个用户体系**，用户可以：
  1. 在站点 / 扩展任一处注册
  2. 在站点购买 → 收到 License Key 邮件
  3. 在扩展激活，或先在站点把 Key 绑到账号、再在扩展登录账号 → 自动同步

## 后续可选优化

- [ ] 自托管中文衬线字体（思源宋）替代系统兜底，进一步去模板感
- [ ] 接入 Plausible / Umami 做轻量统计（不上传隐私）
- [ ] 加 i18n（en / zh）
- [ ] 加退款 / 隐私 / 服务条款的法律页
