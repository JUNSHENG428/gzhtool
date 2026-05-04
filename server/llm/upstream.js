/**
 * server/llm/upstream.js · 平台 LLM 代理 · 上游 fetch + 计量 + 限流
 *
 * 配套 ./router.js（纯决策模块）。这里承担 IO 副作用：
 *   - 转发请求到 OpenAI / DeepSeek 等上游（OpenAI-compatible /v1/chat/completions）
 *   - 5xx / network 时降级到下一家
 *   - 累计 D1 llm_usage 表 + 写入 llm_audit_log
 *   - Cloudflare KV 维护每分钟 RPM 限流
 *
 * 当前支持上游：openai / deepseek（共享 OpenAI chat/completions 协议，无需翻译层）
 * Claude / Kimi 等异构上游放将来 — 需要 body / response shape 翻译，且这俩家
 * 当前不在 router.js MODEL_TIERS 主路径里。
 *
 * 与 .claude/plans/iridescent-sprouting-moore.md "Phase 1.5-1.6" 对应。
 */

import { MODEL_TIERS } from "./router.js";

// ---------------------------------------------------------------------
// 上游配置（URL + secret env 变量名）
// ---------------------------------------------------------------------

/**
 * 各 upstream 的 chat/completions 端点。
 * 添加新 upstream 时：
 *   1. 此处加 url + keyVar
 *   2. FALLBACK_CHAIN 配降级到哪家
 *   3. wrangler.toml 注释 + `wrangler secret put XXX_API_KEY` 注入实际 key
 *   4. 异构上游（claude/kimi 等）需在 callUpstream 里加 body/response 翻译分支
 */
const UPSTREAM_CONFIG = Object.freeze({
  openai: {
    url: "https://api.openai.com/v1/chat/completions",
    keyVar: "OPENAI_API_KEY"
  },
  deepseek: {
    url: "https://api.deepseek.com/chat/completions",
    keyVar: "DEEPSEEK_API_KEY"
  }
});

/**
 * 上游故障时的降级链。
 *   key:   原本要调的 upstream
 *   value: 按优先级降级到的 upstream 列表
 *
 * 简化版：openai ↔ deepseek 互相 fallback。MODEL_TIERS 当前 standard/flagship
 * 也只在这两家 — 一致。
 */
const FALLBACK_CHAIN = Object.freeze({
  openai: ["deepseek"],
  deepseek: ["openai"]
});

/**
 * fallback 时该 upstream 上选哪个 model？
 * 当前策略：fallback 都退到对方家的 economy 模型保底（保证响应能落地）。
 * 用户花的钱可能换到次档结果，但起码可用 — UI 端通过 X-Platform-Fallback-From
 * 响应头能感知到、并提示用户。
 */
function pickFallbackModel(targetUpstream) {
  const map = {
    openai: "gpt-4o-mini",
    deepseek: "deepseek-v4-flash"
  };
  return map[targetUpstream] || MODEL_TIERS.economy.model;
}

// ---------------------------------------------------------------------
// 上游 fetch（单次调用，无降级）
// ---------------------------------------------------------------------

/**
 * 调一次 upstream，不做降级。
 * 永远不抛错（除非 env 完全坏）— 所有上游 / 网络错误用 ok=false 返回，让调用方决定。
 *
 * 返回：
 *   { ok: true,  status: 200,  body: <upstream json>, errorCode: null,    durationMs }
 *   { ok: false, status: 503,  body: null,            errorCode: "...",   durationMs: 0 }
 *   { ok: false, status: 5xx,  body: <upstream err>,  errorCode: "...",   durationMs }
 */
export async function callUpstream({ env, upstream, model, body }) {
  const config = UPSTREAM_CONFIG[upstream];
  if (!config) {
    return {
      ok: false,
      status: 503,
      body: null,
      errorCode: "unknown_upstream",
      durationMs: 0
    };
  }
  const apiKey = env[config.keyVar];
  if (!apiKey) {
    return {
      ok: false,
      status: 503,
      body: null,
      errorCode: "upstream_not_configured",
      durationMs: 0
    };
  }

  // 强制 stream=false（Phase 3 才支持 SSE，当前直返 JSON）
  // 强制 model（不让客户端 body.model 覆盖路由结果，防越权调旗舰）
  // 删 tier（平台内部字段，上游不认）
  const forwardBody = { ...body, model, stream: false };
  delete forwardBody.tier;

  const startMs = Date.now();
  let resp;
  try {
    resp = await fetch(config.url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`
      },
      body: JSON.stringify(forwardBody)
    });
  } catch (err) {
    // 网络层错误（DNS / TCP / TLS）
    return {
      ok: false,
      status: 502,
      body: null,
      errorCode: `network_${(err?.message || "unknown").slice(0, 60)}`,
      durationMs: Date.now() - startMs
    };
  }

  const durationMs = Date.now() - startMs;
  let json = null;
  try {
    json = await resp.json();
  } catch (_) {
    // 非 JSON 响应（HTML 错误页 / 空 body）
    json = null;
  }

  if (!resp.ok) {
    return {
      ok: false,
      status: resp.status,
      body: json,
      errorCode: json?.error?.code || `upstream_${resp.status}`,
      durationMs
    };
  }
  return { ok: true, status: resp.status, body: json, errorCode: null, durationMs };
}

/**
 * 调 upstream 带降级链。
 *
 * 5xx / network → 按 FALLBACK_CHAIN try 下一家
 * 4xx → 不降级（auth / billing / payload 错误换家也没用，避免无限循环）
 *
 * 返回：callUpstream 的 shape 加上：
 *   actualUpstream: 最终实际命中的 upstream（成功的 / 最后失败的）
 *   actualModel:    最终实际命中的 model 名（fallback 时 ≠ 原 model）
 *   fallbackFrom:   原本要调的 upstream（仅 fallback 实际发生时非空）
 */
export async function callUpstreamWithFallback({ env, upstream, model, body }) {
  // 第一次按原计划调
  const first = await callUpstream({ env, upstream, model, body });
  if (first.ok) {
    return { ...first, fallbackFrom: null, actualUpstream: upstream, actualModel: model };
  }
  // 4xx 不 fallback
  if (first.status >= 400 && first.status < 500) {
    return { ...first, fallbackFrom: null, actualUpstream: upstream, actualModel: model };
  }
  // 5xx / network → 按 chain try 一次
  const chain = FALLBACK_CHAIN[upstream] || [];
  for (const altUpstream of chain) {
    const altModel = pickFallbackModel(altUpstream);
    const alt = await callUpstream({ env, upstream: altUpstream, model: altModel, body });
    if (alt.ok) {
      return {
        ...alt,
        fallbackFrom: upstream,
        actualUpstream: altUpstream,
        actualModel: altModel
      };
    }
  }
  // 全 chain 都挂 → 返回原始错误（最有诊断价值）
  return { ...first, fallbackFrom: null, actualUpstream: upstream, actualModel: model };
}

// ---------------------------------------------------------------------
// 流式上游（39th 续 · Phase 3 SSE streaming）
// ---------------------------------------------------------------------

/**
 * 调一次 upstream，**保留 SSE 流式响应**（不解析 body，直接返回 fetch Response）。
 *
 * 设计要点：
 *   - 强制 stream:true（与 callUpstream 强制 stream:false 形成镜像）
 *   - 强制 stream_options:{include_usage:true}（OpenAI 协议扩展，让最后一个 event 携完整 usage 数据）
 *   - 不做降级（fallback 在流中途切换 upstream 极其复杂——半途响应已写客户端无法回滚）；
 *     上游失败就直接把 4xx/5xx 透传给客户端
 *   - 永不抛错（除 env 完全坏）；网络层错以 ok=false + status=502 返回
 *   - 不做计量——usage 数据在 stream 末尾才到，需要调用方在 TransformStream flush 中读取
 *
 * 返回：
 *   { ok: true,  status: 200,        upstreamResponse, errorCode: null }   ← caller pipe upstreamResponse.body 到客户端
 *   { ok: false, status: 502/4xx/5xx, upstreamResponse, errorCode: "..." } ← caller 透传错误（不流式）
 */
export async function streamUpstream({ env, upstream, model, body }) {
  const config = UPSTREAM_CONFIG[upstream];
  if (!config) {
    return { ok: false, status: 503, upstreamResponse: null, errorCode: "unknown_upstream" };
  }
  const apiKey = env[config.keyVar];
  if (!apiKey) {
    return {
      ok: false,
      status: 503,
      upstreamResponse: null,
      errorCode: "upstream_not_configured"
    };
  }

  const forwardBody = {
    ...body,
    model,
    stream: true,
    stream_options: { include_usage: true }
  };
  delete forwardBody.tier;

  let resp;
  try {
    resp = await fetch(config.url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`
      },
      body: JSON.stringify(forwardBody)
    });
  } catch (err) {
    return {
      ok: false,
      status: 502,
      upstreamResponse: null,
      errorCode: `network_${(err?.message || "unknown").slice(0, 60)}`
    };
  }

  if (!resp.ok) {
    return {
      ok: false,
      status: resp.status,
      upstreamResponse: resp,
      errorCode: `upstream_${resp.status}`
    };
  }
  return { ok: true, status: resp.status, upstreamResponse: resp, errorCode: null };
}

// ---------------------------------------------------------------------
// 计量（D1 写入）
// ---------------------------------------------------------------------

/**
 * 增量更新 llm_usage（用户当月聚合用量）。
 * SQLite ON CONFLICT 原子 upsert，无需 SELECT-then-UPDATE。
 *
 * yyyymm 由调用方用 router.currentYyyymm() 算好。
 */
export async function recordUsage(env, { userId, yyyymm, promptTokens, completionTokens }) {
  const now = Date.now();
  await env.DB.prepare(
    `INSERT INTO llm_usage (user_id, yyyymm, prompt_tokens, completion_tokens, call_count, last_call_at)
     VALUES (?, ?, ?, ?, 1, ?)
     ON CONFLICT(user_id, yyyymm) DO UPDATE SET
       prompt_tokens     = prompt_tokens + excluded.prompt_tokens,
       completion_tokens = completion_tokens + excluded.completion_tokens,
       call_count        = call_count + 1,
       last_call_at      = excluded.last_call_at`
  )
    .bind(userId, yyyymm, Number(promptTokens) || 0, Number(completionTokens) || 0, now)
    .run();
}

/**
 * 写入 llm_audit_log（逐次调用流水）。
 * 哪怕 upstream 失败也写（status="error"/"rate_limited"/"quota_exceeded"），
 * 后台才能算 upstream 错误率。
 *
 * 字段语义见 server/migrations/003_llm_usage.sql 注释。
 */
export async function recordAudit(env, audit) {
  await env.DB.prepare(
    `INSERT INTO llm_audit_log
       (user_id, ts, model, tier, upstream, prompt_tokens, completion_tokens, duration_ms, status, error_code, fallback_from)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  )
    .bind(
      audit.user_id,
      Number(audit.ts) || Date.now(),
      audit.model || null,
      audit.tier || null,
      audit.upstream || null,
      Number(audit.prompt_tokens) || 0,
      Number(audit.completion_tokens) || 0,
      Number.isFinite(audit.duration_ms) ? audit.duration_ms : null,
      audit.status,
      audit.error_code || null,
      audit.fallback_from || null
    )
    .run();
}

// ---------------------------------------------------------------------
// 限流（Cloudflare KV，sliding-minute 窗口）
// ---------------------------------------------------------------------

/**
 * 检查 + 累加用户当前分钟内的调用次数。
 *
 * KV key: `ratelimit:llm:{userId}:{epoch_minute}`
 *   - get → 若 >= rpm 拒绝
 *   - 否则 put（KV 没有真原子 INCR；并发 ±1 误差可接受 — 限流允许少量穿透）
 *   - TTL 120s，自然过期（本分钟 + 1 分钟 grace）
 *
 * 返回：
 *   { ok: true,  used: <new>,  limit: rpm }
 *   { ok: false, used: <cur>,  limit: rpm, retryAfterMs: <ms 距下分钟> }
 *
 * RATE_LIMIT_KV 未绑定（dev / 缺配置）→ ok:true（不限流，但 console.warn）。
 */
export async function checkAndBumpRateLimit(env, userId, rpm) {
  if (!env.RATE_LIMIT_KV) {
    console.warn("[llm] RATE_LIMIT_KV not bound, skipping rate limit");
    return { ok: true, used: 0, limit: rpm };
  }
  const now = Date.now();
  const minute = Math.floor(now / 60_000);
  const key = `ratelimit:llm:${userId}:${minute}`;

  const raw = await env.RATE_LIMIT_KV.get(key);
  const count = Number(raw || 0);
  if (count >= rpm) {
    const minuteEnd = (minute + 1) * 60_000;
    return {
      ok: false,
      used: count,
      limit: rpm,
      retryAfterMs: Math.max(minuteEnd - now, 1000)
    };
  }
  await env.RATE_LIMIT_KV.put(key, String(count + 1), { expirationTtl: 120 });
  return { ok: true, used: count + 1, limit: rpm };
}
