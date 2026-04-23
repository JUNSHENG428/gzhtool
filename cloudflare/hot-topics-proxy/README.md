# 热点接口公共代理（方案 A）

让你的扩展用户**开箱即用**而不是要他们各自部一份服务。

```
[扩展用户]
   │
   ├─→ [自己填的自托地址]  （Pro 引导，最稳）
   │      └─ 没填时退到 ↓
   │
   ├─→ [你的 Cloudflare Workers 公共代理]  ←── 这就是本目录
   │      └─ 配额耗尽或挂掉时退到 ↓
   │
   └─→ [imsyy 公共 demo]  （最后兜底，限流是常态）
```

## 这个 Worker 干了什么

- **薄代理**：转发到上游 DailyHotApi（默认 `api-hot.imsyy.top`，可换）
- **KV 缓存 5 分钟**：100 个用户同一分钟内只触发 1 次回源
- **IP 限速**：免费用户每分钟最多 10 次刷新；带合法 license token 的请求无限制
- **白名单**：只代理 30 个有效 source id，避免被人当 open proxy
- **CORS 全开**：扩展可以从任何上下文 fetch
- **错误标准化**：上游挂掉时返回 `{ code, name, message, data: [] }`，与扩展现有解析逻辑兼容

## 5 分钟部署

> **重要**：所有命令必须在**项目根目录**进入 `cloudflare/hot-topics-proxy/`
> 之后再执行。如果你停留在别的子目录（比如 `server/`，那是 license worker），
> `wrangler deploy` 会去部署那个目录里的 worker，跟本目录无关。

```bash
# 0. 必须从项目根目录开始 —— 千万别在 server/ 里跑
cd /path/to/gzh   # 你的项目根（含 manifest.json 的那一层）
cd cloudflare/hot-topics-proxy

# 1. 安装 wrangler（如果之前装过可跳过）
npm install -g wrangler
wrangler login    # 已登录可跳过

# 2. 创建 KV namespace（wrangler v4 语法是 `kv namespace`，空格不是冒号）
wrangler kv namespace create HOT_CACHE
# 输出形如：
#   ✨ Success!
#   Add the following to your configuration file in your kv_namespaces array:
#   {
#     "binding": "HOT_CACHE",
#     "id": "abc123def456..."
#   }
# 把这个 id 填到 wrangler.toml 里 [[kv_namespaces]] 的 id 和 preview_id 字段，
# 替换掉 REPLACE_WITH_YOUR_KV_ID 占位

# 3. 设置 Pro license 共享密钥（可选，生产环境推荐）
wrangler secret put PRO_LICENSE_SECRET
# 输入一个长随机字符串，留作 Pro 用户的 X-License-Token

# 4. 部署
wrangler deploy
# 拿到 https://hot-topics-proxy.<your-cf-username>.workers.dev
```

部署完后**立即验证**（替换成你拿到的 URL）：

```bash
curl https://hot-topics-proxy.<your-cf-username>.workers.dev/health
# 应该返回 { ok: true, service: "runbi-hot-topics-proxy", ... }

curl https://hot-topics-proxy.<your-cf-username>.workers.dev/zhihu | head -c 300
# 应该返回知乎热榜 JSON 的前 300 字节
```

## 部署后接到扩展

把上一步拿到的 URL 填到 `src/shared/defaults.js` 里：

```js
// 替换 hotTopicsDailyHotBase 字段的默认值（原来是空字符串）
hotTopicsDailyHotBase: "https://hot-topics-proxy.your-name.workers.dev/",
```

或者更稳的做法是在 `src/shared/hot-topics.js` 里改默认 base：

```js
export const DEFAULT_DAILYHOT_BASE = "https://hot-topics-proxy.your-name.workers.dev/";
```

这样**所有用户开箱即用**，他们不需要做任何事就能享受你的 5 分钟 KV 缓存。

## Pro 用户怎么走加速通道

扩展端在 fetch DailyHotApi 时带上 `X-License-Token` header（值就是 `PRO_LICENSE_SECRET`）即可绕过限速。具体接入点：

```js
// src/shared/hot-topics.js fetchDailyHotApi 里
headers: {
  "User-Agent": UA,
  Accept: "application/json",
  ...(license?.proSecret ? { "X-License-Token": license.proSecret } : {})
}
```

后续做：发 license 时把 `proSecret` 一同下发到客户端。

## 配额上限

Cloudflare Workers Free Plan：
- 每天 10 万次请求
- 每天 1 GB KV 读取，1000 次 KV 写入
- 30 ms CPU / 请求

按 100 个活跃用户每天平均刷 30 次算，每天 3000 次请求 + KV 缓存命中率 70%，**完全在免费额度内**。

如果用户量到了万级，升级到 Workers Paid（$5/月）：
- 每月 1000 万次请求
- 1000 万次 KV 读取，10 万次 KV 写入
- 50 ms CPU / 请求

## 调试

```bash
# 本地开发
wrangler dev

# 测一下健康检查
curl http://localhost:8787/health

# 测一下知乎热榜
curl http://localhost:8787/zhihu

# 测一下限速（连续请求 11 次）
for i in {1..11}; do curl -s http://localhost:8787/zhihu | head -c 80; echo; done

# 看日志
wrangler tail
```

## 增加新源

修改 `worker.js` 顶部的 `ALLOWED_SOURCES` 集合，加上你想代理的 source id（必须是上游 DailyHotApi 支持的）。

支持的全部 source id 列表：https://github.com/imsyy/DailyHotApi#-api-列表
