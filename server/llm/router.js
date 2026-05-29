/**
 * server/llm/router.js · 平台 LLM 代理 · 路由与配额纯函数模块
 *
 * 39th session 起接入。本模块**100% 纯函数**——不 fetch 上游，不查 D1，不读
 * Worker env，所有外部依赖（usage / recentCallCount）由调用方传入。这样可以
 * 在 scripts/smoke.mjs 里独立单测，零 mock 成本。
 *
 * 上游 fetch + D1 写入 + KV 限流计数走 server/llm/upstream.js（下一 session 加），
 * 该文件只负责"输入决策"——给定用户 plan + 当前用量，返回该用什么模型 / 是否
 * 该 quota_exceeded / 是否该 rate_limited。
 *
 * 与 plan 文件 .claude/plans/iridescent-sprouting-moore.md 的 "Phase 1.4 模型路由
 * 层" 一一对应。
 */

// ---------------------------------------------------------------------
// 配置常量（修改时同步 src/shared/license.js PAID_FEATURES + plan 文件能力矩阵）
// ---------------------------------------------------------------------

/**
 * 模型档位定义。tier → { upstream, model }。
 * upstream 命名与 src/shared/providers.js 8 家服务商 key 对齐：
 *   openai / deepseek / claude / kimi / qwen / glm / minimax / openrouter
 *
 * 当前选型理由（plan 文件「决策点」段）：
 *   - economy: DeepSeek V4 Flash 性价比最高 + 中文好 + 支持推理
 *   - standard: DeepSeek V4 Pro（同家升档，避免跨家 Key 管理）
 *   - flagship: GPT-4o（标杆质量，年费用户旗舰档）
 *
 * 改 model 名时不要改 tier key（tier 是对外契约，前端 settings.platformTier 用）。
 */
export const MODEL_TIERS = Object.freeze({
  economy: { upstream: "deepseek", model: "deepseek-v4-flash" },
  standard: { upstream: "deepseek", model: "deepseek-v4-pro" },
  flagship: { upstream: "openai", model: "gpt-4o" }
});

/**
 * 各 plan 能访问的 tier 白名单（按从经济到旗舰排序）。
 * 用户请求的 tier 不在白名单时降级到列表最后一个允许的 tier。
 */
export const PLAN_TIER_ACCESS = Object.freeze({
  free: ["economy"],
  monthly: ["economy", "standard"],
  yearly: ["economy", "standard", "flagship"]
});

/**
 * 月度配额上限。
 * - free: 次数制（30 次/月）—— Free 用户简单易理解，不引入 token 概念
 * - monthly / yearly: token 制（5M / 20M token/月）—— 精确反映 LLM 实际成本
 *
 * 字段含义：
 *   tokenCap  · 月度 token 上限（prompt+completion 总和）。null = 不卡 token。
 *   callCap   · 月度调用次数上限。null = 不卡次数。
 * 至少其中一个字段非 null（否则 free 计费）。
 */
export const PLAN_QUOTA = Object.freeze({
  free: { tokenCap: null, callCap: 30 },
  monthly: { tokenCap: 5_000_000, callCap: null },
  yearly: { tokenCap: 20_000_000, callCap: null }
});

/**
 * 限流 RPM（每分钟最大调用数）。防恶意刷 + 防 cost 暴涨。
 * 月费/年费的 RPM 选大一些（用户可能多 article 并发改写）；free 严格限。
 */
export const PLAN_RPM = Object.freeze({
  free: 5,
  monthly: 30,
  yearly: 100
});

/**
 * 单次请求的输出 token 硬上限（按 plan）。
 *
 * 安全用途：配额按「调用次数 / 累计 token」计，与单次 `max_tokens` / `n` 无关。
 * 若不钳制，攻击者可在配额次数内用 `{n:128, max_tokens:16000}` 把单次请求放大成
 * 数百万 token 的真实上游账单（财务 DoS）。upstream.js sanitizeForwardBody 用这个
 * 上限钳制 max_tokens / max_completion_tokens，并删除 n / best_of 等放大字段。
 *
 * 取值偏宽松（长文改写正常 3000-5000 token 输出），仍能把单次成本封顶。
 */
export const PLAN_MAX_OUTPUT_TOKENS = Object.freeze({
  free: 8_192,
  monthly: 16_384,
  yearly: 32_768
});

// ---------------------------------------------------------------------
// 决策函数（纯函数）
// ---------------------------------------------------------------------

/**
 * 把用户请求的 tier 解析为最终允许的 tier。
 *
 * 规则：
 *  - 用户传的 tier 在 plan 白名单里 → 原样用
 *  - 不在白名单 → 降级到该 plan 允许的最高档
 *  - plan 未知 → 视为 free
 *
 * 返回 { tier, downgraded }。downgraded=true 时调用方应在 audit log 里记下（
 * 这意味着用户花钱但拿到的不是他要的）。
 */
export function resolveTierForUser(plan, requestedTier) {
  const allowed = PLAN_TIER_ACCESS[plan] || PLAN_TIER_ACCESS.free;
  if (!requestedTier) {
    // 没指定时给最高允许档（年费默认 flagship，月费默认 standard）
    return { tier: allowed[allowed.length - 1], downgraded: false };
  }
  if (allowed.includes(requestedTier)) {
    return { tier: requestedTier, downgraded: false };
  }
  // 越权请求 → 降级
  return { tier: allowed[allowed.length - 1], downgraded: true };
}

/**
 * 解析 tier 到具体的 upstream + model。
 * tier 不在 MODEL_TIERS 时回退 economy（最后防护，正常路径不会走到）。
 */
export function selectUpstreamForTier(tier) {
  const config = MODEL_TIERS[tier] || MODEL_TIERS.economy;
  return { upstream: config.upstream, model: config.model, tier };
}

/**
 * 检查用户当前月度用量是否还能再发一次请求。
 *
 * 入参 usage 形如：{ prompt_tokens, completion_tokens, call_count }
 * （从 D1 llm_usage WHERE user_id=? AND yyyymm=current 取，缺时视为 0）。
 *
 * 返回：
 *   { ok: true, remaining: { tokens?, calls? } }                     —— 还能调
 *   { ok: false, reason: "quota_exceeded", limit, used, remaining: 0 } —— 配额用完
 *   { ok: false, reason: "unknown_plan", limit: null }                —— plan 字段错
 *
 * 注意：本函数不做"预扣"——只判定当前是否能调一次。实际 token 数要等上游响应
 * 后增量写入 llm_usage 表。所以**理论上一次调用可能略超 cap**（比如剩 100K
 * token 但发了一次 200K token 的请求），这是 acceptable trade-off：实时预扣
 * 需要 streaming 关闭 + 双阶段提交，复杂度太高。
 */
export function checkQuota(plan, usage = {}) {
  const quota = PLAN_QUOTA[plan];
  if (!quota) {
    return { ok: false, reason: "unknown_plan", limit: null };
  }
  const promptTokens = Number(usage.prompt_tokens || 0);
  const completionTokens = Number(usage.completion_tokens || 0);
  const callCount = Number(usage.call_count || 0);
  const totalTokens = promptTokens + completionTokens;

  // 次数制（free）
  if (quota.callCap !== null) {
    if (callCount >= quota.callCap) {
      return {
        ok: false,
        reason: "quota_exceeded",
        limit: { calls: quota.callCap },
        used: { calls: callCount },
        remaining: { calls: 0 }
      };
    }
    return {
      ok: true,
      limit: { calls: quota.callCap },
      used: { calls: callCount },
      remaining: { calls: quota.callCap - callCount }
    };
  }

  // token 制（monthly / yearly）
  if (quota.tokenCap !== null) {
    if (totalTokens >= quota.tokenCap) {
      return {
        ok: false,
        reason: "quota_exceeded",
        limit: { tokens: quota.tokenCap },
        used: { tokens: totalTokens },
        remaining: { tokens: 0 }
      };
    }
    return {
      ok: true,
      limit: { tokens: quota.tokenCap },
      used: { tokens: totalTokens },
      remaining: { tokens: quota.tokenCap - totalTokens }
    };
  }

  // 既无 callCap 也无 tokenCap = 配置错
  return { ok: false, reason: "no_quota_configured", limit: null };
}

/**
 * 限流检查：本分钟内已经调了几次？
 *
 * recentCount 由调用方从 cf KV 取（KEY: ratelimit:user:{user_id}:{epoch_minute}）。
 * 缺时视为 0。
 *
 * 返回：
 *   { ok: true }                                  —— 可调
 *   { ok: false, reason: "rate_limited",
 *     limit: N, used: M, retryAfterMs: ~60000 }   —— 限流
 */
export function checkRateLimit(plan, recentCount = 0) {
  const rpm = PLAN_RPM[plan] || PLAN_RPM.free;
  if (recentCount >= rpm) {
    // retryAfter = 当前自然分钟剩余毫秒（最多 60s，下分钟刷新）
    const now = Date.now();
    const minuteEnd = Math.ceil(now / 60_000) * 60_000;
    return {
      ok: false,
      reason: "rate_limited",
      limit: rpm,
      used: recentCount,
      retryAfterMs: minuteEnd - now
    };
  }
  return { ok: true, limit: rpm, used: recentCount };
}

/**
 * 当前自然月（"YYYY-MM"），用于 D1 llm_usage 主键。
 * 默认 UTC——服务端时区一致是关键，不要用 local time。
 *
 * 测试时可传 epochMs 注入特定时间。
 */
export function currentYyyymm(epochMs = Date.now()) {
  const d = new Date(epochMs);
  const year = d.getUTCFullYear();
  const month = String(d.getUTCMonth() + 1).padStart(2, "0");
  return `${year}-${month}`;
}

/**
 * 下次配额重置时间（UTC 自然月翌月 1 日 00:00:00.000Z）。
 * 给前端"距下次重置：12 天"显示用。
 */
export function nextResetMs(epochMs = Date.now()) {
  const d = new Date(epochMs);
  const next = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1, 0, 0, 0, 0));
  return next.getTime();
}

/**
 * GET /api/llm/usage 的响应数据格式化。
 * 把 usage（D1 行）+ plan 转成对前端友好的结构。
 *
 * 用 checkQuota 内部相同逻辑判断 remaining 形态，避免两处同样代码漂移。
 */
export function formatUsageReport({ plan, usage = {}, epochMs = Date.now() }) {
  const yyyymm = currentYyyymm(epochMs);
  const quotaCheck = checkQuota(plan, usage);
  const promptTokens = Number(usage.prompt_tokens || 0);
  const completionTokens = Number(usage.completion_tokens || 0);
  const callCount = Number(usage.call_count || 0);
  const totalTokens = promptTokens + completionTokens;

  return {
    plan: plan || "free",
    yyyymm,
    used: {
      prompt_tokens: promptTokens,
      completion_tokens: completionTokens,
      total_tokens: totalTokens,
      call_count: callCount
    },
    limit: quotaCheck.limit || {},
    remaining: quotaCheck.remaining || {},
    quota_exceeded: !quotaCheck.ok && quotaCheck.reason === "quota_exceeded",
    resets_at: new Date(nextResetMs(epochMs)).toISOString()
  };
}
