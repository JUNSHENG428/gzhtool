/**
 * 润笔 · 热点接口公共代理（Cloudflare Workers）
 *
 * 这是为方案 A "上线后用户开箱即用" 设计的官方公共服务：
 *  - 自部署一份，扩展默认走这里，免费用户也能用，无需自己装服务
 *  - 上游可在 Wrangler 环境变量里换（默认 imsyy DailyHotApi）
 *  - 自带 KV 缓存（5 分钟），避免对上游造成 N 倍放大
 *  - 内置粗粒度速率限制：未带 license token 时按 IP 每分钟 10 次；
 *    带合法 license token（值由你定）时无限制
 *  - 失败时 JSON 化错误，不抛 5xx，让客户端能优雅降级
 *
 * 部署：
 *   1. cd cloudflare/hot-topics-proxy
 *   2. npm install -g wrangler
 *   3. wrangler login
 *   4. wrangler kv:namespace create HOT_CACHE
 *      把生成的 id 填到 wrangler.toml 的 kv_namespaces.id
 *   5. wrangler deploy
 *   6. 部署完拿到 https://hot-topics-proxy.<your-name>.workers.dev
 *      把这个 URL 填到扩展「设置 → 热点接口 → DailyHotApi 地址」
 */

const DEFAULT_UPSTREAM = "https://api-hot.imsyy.top";
const CACHE_TTL_SECONDS = 300; // 5 分钟，与扩展内的 12 分钟客户端缓存配合
const FREE_RATE_LIMIT_PER_MIN = 10;

// 允许的源列表：白名单防止有人拿你的 worker 当全互联网 proxy
// 改成 imsyy 上游支持的全部 source id（与扩展 HOT_SOURCE_META 对齐）
const ALLOWED_SOURCES = new Set([
  "zhihu", "weibo", "tieba", "baidu", "toutiao", "hupu", "thepaper",
  "qq-news", "netease-news", "weread",
  "sspai", "juejin", "coolapk", "ithome", "36kr", "v2ex", "github",
  "hackernews", "producthunt", "hellogithub", "nodeseek", "csdn", "huxiu",
  "wallstreetcn", "xueqiu",
  "bilibili", "douyin", "douban-movie", "douban-group", "acfun",
  "zaobao"
]);

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, X-License-Token",
  "Access-Control-Max-Age": "86400"
};

export default {
  /**
   * @param {Request} request
   * @param {{ HOT_CACHE: KVNamespace, UPSTREAM_BASE?: string, PRO_LICENSE_SECRET?: string }} env
   */
  async fetch(request, env, ctx) {
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: CORS_HEADERS });
    }
    if (request.method !== "GET") {
      return jsonError(405, "method_not_allowed", "Only GET is supported.");
    }

    const url = new URL(request.url);

    // 健康检查 / 调试用
    if (url.pathname === "/" || url.pathname === "/health") {
      return jsonOk({
        ok: true,
        service: "runbi-hot-topics-proxy",
        upstream: env.UPSTREAM_BASE || DEFAULT_UPSTREAM,
        cacheTtl: CACHE_TTL_SECONDS,
        sources: ALLOWED_SOURCES.size
      });
    }

    // /:source → 取榜单。pathname 头会有 "/"，去掉后剩下 source id
    const sourceId = url.pathname.replace(/^\/+|\/+$/g, "");
    if (!sourceId) {
      return jsonError(404, "missing_source", "URL 路径必须是 /<source_id>");
    }
    if (!ALLOWED_SOURCES.has(sourceId)) {
      return jsonError(
        400,
        "invalid_source",
        `不在白名单的源：${sourceId}。如需新增请提交 PR 修改 ALLOWED_SOURCES。`
      );
    }

    // 速率限制（按 IP）：免费用户每分钟 FREE_RATE_LIMIT_PER_MIN 次
    // 带合法 license token 的请求不计入限制
    const licenseToken = request.headers.get("X-License-Token") || "";
    const isPro = await isValidProToken(licenseToken, env);

    if (!isPro) {
      const ip =
        request.headers.get("CF-Connecting-IP") ||
        request.headers.get("X-Forwarded-For") ||
        "unknown";
      const overLimit = await checkAndBumpRate(env, ip);
      if (overLimit) {
        return jsonError(
          429,
          "rate_limited",
          `当前 IP 每分钟最多 ${FREE_RATE_LIMIT_PER_MIN} 次。建议升级 Pro 解除限制，或自部署一份脚手架（见 cloudflare/hot-topics-proxy/README）。`,
          { "Retry-After": "60" }
        );
      }
    }

    // 命中缓存
    const cacheKey = `cache:${sourceId}`;
    const cached = await env.HOT_CACHE.get(cacheKey, "json");
    if (cached) {
      return jsonOk(cached, {
        "X-Cache": "HIT",
        "Cache-Control": `public, max-age=${CACHE_TTL_SECONDS}`
      });
    }

    // 回源
    const upstreamBase = (env.UPSTREAM_BASE || DEFAULT_UPSTREAM).replace(/\/+$/, "");
    const upstreamUrl = `${upstreamBase}/${sourceId}?cache=true`;
    let upstreamData;
    try {
      const res = await fetch(upstreamUrl, {
        cf: { cacheTtl: CACHE_TTL_SECONDS, cacheEverything: true },
        headers: {
          "User-Agent":
            "RunbiHotProxy/1.0 (+https://github.com/your-repo/cloudflare/hot-topics-proxy)",
          Accept: "application/json"
        }
      });
      if (!res.ok) {
        return jsonError(
          502,
          "upstream_http",
          `上游 ${upstreamUrl} 返回 ${res.status}`
        );
      }
      upstreamData = await res.json();
    } catch (e) {
      return jsonError(502, "upstream_fetch_failed", String(e?.message || e));
    }

    // 写入缓存（异步，不阻塞响应）
    ctx.waitUntil(
      env.HOT_CACHE.put(cacheKey, JSON.stringify(upstreamData), {
        expirationTtl: CACHE_TTL_SECONDS
      })
    );

    return jsonOk(upstreamData, {
      "X-Cache": "MISS",
      "Cache-Control": `public, max-age=${CACHE_TTL_SECONDS}`
    });
  }
};

// ── helpers ──

function jsonOk(body, extraHeaders = {}) {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      ...CORS_HEADERS,
      ...extraHeaders
    }
  });
}

function jsonError(status, code, message, extraHeaders = {}) {
  // 注意：上游 DailyHotApi 用 code 字段做业务码，我们沿用 200 + code 让客户端
  // 现有的解析逻辑能识别错误。但为了便于调试，仍设置 HTTP status。
  return new Response(
    JSON.stringify({ code: status, name: code, message, data: [] }),
    {
      status,
      headers: {
        "Content-Type": "application/json; charset=utf-8",
        ...CORS_HEADERS,
        ...extraHeaders
      }
    }
  );
}

async function isValidProToken(token, env) {
  if (!token || !env.PRO_LICENSE_SECRET) return false;
  // 最简实现：持有共享密钥就算 Pro。生产环境请改成 JWT 校验或调你的 license worker。
  return token === env.PRO_LICENSE_SECRET;
}

async function checkAndBumpRate(env, ip) {
  const minuteBucket = Math.floor(Date.now() / 60000);
  const key = `rate:${ip}:${minuteBucket}`;
  const currentRaw = await env.HOT_CACHE.get(key);
  const current = Number(currentRaw) || 0;
  if (current >= FREE_RATE_LIMIT_PER_MIN) return true;
  await env.HOT_CACHE.put(key, String(current + 1), { expirationTtl: 90 });
  return false;
}
