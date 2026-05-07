/**
 * 润笔 · Cloudflare Workers 授权服务
 * ----------------------------------------------------------------------
 * 单文件 Worker。所有路由 + 鉴权 + 密码哈希 + JWT + Lemon Squeezy webhook
 * 验签 + 限速都在这里实现，不引入任何 npm 包，全部走 Web Crypto / fetch。
 *
 * 路由总览：
 *   POST /api/register                邮箱密码注册
 *   POST /api/login                   邮箱密码登录 → JWT
 *   GET  /api/me                      JWT 校验 → 当前用户 + 已绑 license 概览
 *   POST /api/license/bind            JWT 校验 → 把一张 license 绑到当前用户
 *   POST /api/license/unbind          JWT 校验 → 解绑某张 license
 *   POST /api/license/verify          公开（带限速） → 插件验证 license（核心）
 *   POST /api/license/deactivate      公开（带限速） → 插件解绑当前设备
 *   POST /api/webhook/lemon           Lemon Squeezy 回调（HMAC-SHA256 验签）
 *   GET  /api/health                  健康检查
 *
 * 安全要点：
 *   1. 密码用 PBKDF2-SHA256 + 100_000 次迭代 + 16 字节随机 salt；
 *      （Cloudflare Workers 的 Web Crypto 上限就是 100k，超出会被 runtime 拒绝；
 *       100k 次 PBKDF2 在常见硬件上仍是几十毫秒级，对密码爆破依然有强约束。）
 *   2. JWT HS256，过期 7 天，secret 走 wrangler secret；
 *   3. /api/license/verify 用 KV 限速：同一 key + ip 每分钟 10 次；
 *   4. webhook 必须验签，且用 webhook_events 做幂等去重；
 *   5. 所有错误信息中文化，避免泄露内部结构。
 */

// 平台 LLM 代理（39th session 起）— 路由 / 配额 / 上游 / 计量
// router.js 是纯函数（决策），upstream.js 是带副作用的 IO（fetch + D1 + KV）
import {
  PLAN_RPM,
  resolveTierForUser,
  selectUpstreamForTier,
  checkQuota,
  currentYyyymm,
  nextResetMs,
  formatUsageReport
} from "./llm/router.js";
import {
  callUpstreamWithFallback,
  streamUpstream,
  recordUsage,
  recordAudit,
  checkAndBumpRateLimit
} from "./llm/upstream.js";
// 39th 续³ #9 · 安全告警邮件抽到独立模块（worker.js 瘦身 + smoke 单测可见性）
import {
  sendSecurityAlertEmail,
  buildSecurityAlertContent
} from "./email/security-alert.js";
// re-export 让 smoke 单测继续从 server/worker.js import（保持兼容）
export { sendSecurityAlertEmail, buildSecurityAlertContent };

const PBKDF2_ITERATIONS = 100_000;
const JWT_ALG = "HS256";
const JWT_TTL_SECONDS = 60 * 60 * 24 * 7; // 7 天

// 付费功能开关清单（与插件端 src/shared/license.js 的 PAID_FEATURES 保持同步）
// 39th session 起新增 plans-based 4 项（ai.bringYourOwnKey / ai.platformLlm.*）
// 这 4 项的真闸门走 license.js mapEffectivePlanToLlmPlan + plans 数组，不依赖
// 此处 features 推送；但仍登记在 KEYS 列表里好让 smoke 前后端对齐测过。
const PAID_FEATURE_KEYS = [
  "wechat.publish",
  "wechat.multiAccount",
  "scrape.drission",
  "hot.advancedSources",
  "ai.advancedTemplates",
  "ai.templateGenerator",
  "ai.batchRewrite",
  "ai.deAiBoost",
  "ai.unlimitedDaily",
  "ai.topicPlanner",
  "ai.bringYourOwnKey",
  "ai.platformLlm.economy",
  "ai.platformLlm.standard",
  "ai.platformLlm.flagship"
];

// 免费版每天 AI 改写次数（pro 不受限）
const FREE_DAILY_AI_QUOTA = 5;

// 39th 续 · 设备激活数上限（Strategy B：Free 1 / Monthly 3 / Yearly 10）
// pro 旧 SKU 向后兼容映射到 yearly 10 台（与 derivePlanForLlm 同口径）。
// 用户撞顶时 verify 返回 403 reason="device_limit_exceeded"，dashboard 引导一键解绑闲置。
// 已激活的老指纹再 verify 不会被卡（仅 INSERT 新 fingerprint 时检查 count >= limit）。
const DEVICE_LIMITS = Object.freeze({
  free: 1,
  monthly: 3,
  yearly: 10
});

// 39th 续 · 设备自动清理阈值（cron 每小时跑一次，删 > 此天数无活跃的）
// 90 天选择理由：覆盖年度旅行 / 出差 / 偶尔用第二台机器的真实场景，
// 同时让"清装系统 / 重装扩展残留的孤儿 fingerprint"自然衰减不污染列表
const STALE_DEVICE_PRUNE_DAYS = 90;

// 39th 续 · plan rank 用于"只升档不降档"逻辑（issueProLicense + loadUserLicenseSummary）
// pro 是历史 SKU（虎皮椒早期 + Lemon Squeezy），向后兼容为最高级别；
// monthly < yearly 的差异由 derivePlanForLlm / devicePlanFromLicenseRow 真实生效
// （export 是为 smoke 单测可见性，CF Worker 只用 default export 不影响 runtime）
export const PLAN_RANK = Object.freeze({ free: 0, monthly: 1, yearly: 2, pro: 3 });

// 39th 续³ · Phase 5 加固 · LLM 请求体大小硬限（防 100MB 单条 message DoS）
// 三层校验：① Content-Length header 预检；② messages 数组长度上限；③ 单条 content 字符上限
// 100KB 选择理由：足够装 200 条 500 字消息（公众号文章 ~3K 字 × 30 篇上下文绰绰有余）
// 单条 20K 字符选择理由：覆盖单篇长文 + 模板 + 改写要求；超过通常是攻击或滥用
export const LLM_MAX_BODY_BYTES = 100_000;
export const LLM_MAX_MESSAGES = 50;
export const LLM_MAX_MESSAGE_CHARS = 20_000;

// 39th 续³ · Phase 5 加固 · KV 缺失 fail-closed 模式（生产 wrangler.toml 必填）
// dev 环境（.dev.vars 不设此 var）→ rateLimit 仍 fail-open 不阻塞调试
// 生产环境（wrangler.toml [vars] 设 STRICT_RATE_LIMIT="1"）→ KV 缺失时关键路径返 503
const STRICT_RATE_LIMIT_ENV = "STRICT_RATE_LIMIT";

// 39th 续 · Phase 4 防滥用 · 单 IP 24 小时内最多注册次数
// 5 次的选择理由：覆盖家庭 / 小公司 NAT 后多人合理共享场景，挡住批量薅账号脚本
// 撞顶返 429 + 友好提示「同 IP 24 小时内已注册 X 次，请明日再试 / 不同网络重试 / 联系 support」
export const MAX_REGISTRATIONS_PER_IP_PER_DAY = 5;

// 39th 续 · Phase 4.3 · token 暴涨告警阈值（5 分钟滑窗内累计 token 超此值 → audit warn）
// 基线推导：plan 月度 cap / 30 天 / 24 小时 ≈ 每小时合理用量；5 分钟阈值 = 每小时基线的 4 倍
//   - Free 30 次/月 ≈ 1 次/天，单次经济档可达 1K token；阈值 5000 ≈ 5 次/5min（正常用户连续点 1-2 篇文章
//     完全够用，5 次内不触发；脚本批量调用才会撞）
//   - Monthly 5M token/月 ≈ 167K/天 ≈ 7K/小时 → 5 分钟 50K = 7 倍 spike
//   - Yearly 20M token/月 ≈ 667K/天 ≈ 28K/小时 → 5 分钟 200K = 7 倍 spike
// 仅 audit_log 写 warn 条不阻塞调用——false positive 风险高于真实滥用，先观察再决定是否硬卡
//
// Free 1000 → 5000 的修订（review 反馈）：经济档单次改写 200-1000 token，正常用户改写 1 篇就可能触发
// 1000 阈值。提到 5000 后正常用户连改 5 篇才命中，仍能挡住自动化脚本批量调用（一秒数十请求）。
export const TOKEN_SPIKE_THRESHOLDS = Object.freeze({
  free: 5_000,
  monthly: 50_000,
  yearly: 200_000
});

// 39th 续 · Phase 4.4 · 同 license 跨设备并发突发检测（5 分钟滑窗内 distinct fingerprint 数）
// 阈值 = DEVICE_LIMITS[plan] + 2（容忍合理 burst：用户重启浏览器 / 切换 chrome profile 重新激活）
// 单 license 5min 内出现 distinct fingerprints > deviceLimit + 2 → verify_log 写 multi_device_burst
// 这通常是「license 被多人共享 / 转售」的信号——单设备的行为不会触发此阈值
export function deviceConcurrentThreshold(plan) {
  const base = DEVICE_LIMITS[plan] ?? DEVICE_LIMITS.free;
  return base + 2;
}

export default {
  async fetch(request, env, ctx) {
    try {
      const url = new URL(request.url);
      // CORS preflight
      if (request.method === "OPTIONS") {
        return corsResponse(request, env, new Response(null, { status: 204 }));
      }

      const route = `${request.method} ${url.pathname}`;
      const handler = ROUTES[route];
      if (!handler) {
        return corsResponse(
          request,
          env,
          jsonResponse({ ok: false, error: "接口不存在" }, 404)
        );
      }
      const result = await handler(request, env, ctx, url);
      return corsResponse(request, env, result);
    } catch (error) {
      console.error("worker error", error);
      return corsResponse(
        request,
        env,
        jsonResponse(
          { ok: false, error: error?.message || "服务器内部错误" },
          500
        )
      );
    }
  },

  /**
   * Cloudflare Workers Cron Trigger 入口（按 wrangler.toml [triggers] crons 调度）。
   *
   * 当前唯一任务：每小时主动反查最近一段时间内的 paid 订单，把虎皮椒后台已退款
   * 但 webhook 漏发的同步回 D1，免去运维手工 SQL（详见 memory-bank/progress.md
   * P1「虎皮椒退款主动同步 Cron Worker」）。
   *
   * 约定：scheduled handler 永不抛错（一抛会让整个 cron 任务被 CF 标记失败），
   * 各子任务自己 try/catch 写日志即可。
   */
  async scheduled(event, env, ctx) {
    try {
      ctx.waitUntil(syncHupijiaoRefunds(env));
      ctx.waitUntil(pruneStaleDeviceActivations(env));
    } catch (error) {
      console.error("[cron] scheduled error", error?.message || error);
    }
  }
};

// ============================================================
// 路由表
// ============================================================
const ROUTES = {
  "GET  /api/health": handleHealth,
  "POST /api/register": handleRegister,
  "POST /api/login": handleLogin,
  "GET  /api/me": handleMe,
  "POST /api/account/change-password": handleChangePassword,
  "POST /api/account/set-password": handleSetPassword,
  "POST /api/auth/request-reset": handleRequestReset,
  "POST /api/auth/reset": handleReset,
  "POST /api/auth/google": handleGoogleAuth,
  "POST /api/license/bind": handleLicenseBind,
  "POST /api/license/unbind": handleLicenseUnbind,
  "POST /api/license/device/unbind": handleDeviceUnbind,
  "POST /api/license/verify": handleLicenseVerify,
  "POST /api/license/deactivate": handleLicenseDeactivate,
  "POST /api/webhook/lemon": handleLemonWebhook,
  "POST /api/payment/hupijiao/create": handleHupijiaoCreate,
  "POST /api/payment/hupijiao/notify": handleHupijiaoNotify,
  "GET /api/payment/hupijiao/query": handleHupijiaoQuery,
  "POST /api/llm/chat": handleLlmChat,
  "POST /api/llm/stream": handleLlmStream,
  "GET /api/llm/usage": handleLlmUsage,
  "POST /api/license/device/prune": handleLicenseDevicePrune
};

// 兼容 method 与 path 之间双空格的问题：路由 key 写时统一两个字符位，避免对齐问题。
// 这里把单空格 / 多空格的 key 统一规整一次。
for (const key of Object.keys(ROUTES)) {
  const fixed = key.replace(/\s+/g, " ");
  if (fixed !== key) {
    ROUTES[fixed] = ROUTES[key];
    delete ROUTES[key];
  }
}

// ============================================================
// /api/health
// ============================================================
async function handleHealth() {
  return jsonResponse({ ok: true, ts: Date.now() });
}

// ============================================================
// /api/register
// body: { email, password }
// ============================================================
async function handleRegister(request, env) {
  // 39th 续³ · Phase 5 加固 · KV strict guard（生产漏配 KV 时直接拒注册防批量薅）
  const kvGuard = assertRateLimitKvAvailable(env, "handleRegister");
  if (kvGuard) return kvGuard;

  const body = await readJson(request);
  const email = normalizeEmail(body.email);
  const password = String(body.password || "");

  if (!email) return jsonResponse({ ok: false, error: "请填写邮箱" }, 400);
  if (!isValidEmail(email))
    return jsonResponse({ ok: false, error: "邮箱格式不正确" }, 400);
  if (password.length < 8)
    return jsonResponse(
      { ok: false, error: "密码长度至少 8 位" },
      400
    );

  // 39th 续 · Phase 4 · 单 IP 24h 注册数限制（挡批量薅账号脚本）
  // KV bucket 按 (ip, UTC-day) 分；同 IP 5 次后撞顶返 429
  // CF-Connecting-IP 是 Cloudflare 注入的真实 IP（不会被客户端 X-Forwarded-For 伪造）
  const ip = request.headers.get("CF-Connecting-IP") || "unknown";
  if (ip !== "unknown") {
    const rl = await rateLimit(env, `register:ip:${ip}`, MAX_REGISTRATIONS_PER_IP_PER_DAY, 86400);
    if (!rl.allowed) {
      return jsonResponse(
        {
          ok: false,
          error: `同一网络 24 小时内已注册 ${MAX_REGISTRATIONS_PER_IP_PER_DAY} 个账号，超过上限。请改日再试或换不同网络重试；如果你是合理使用（如家庭 / 团队共享网络）请邮件 support@docuearn.com 申诉。`,
          reason: "ip_register_limit",
          retryAfterSeconds: rl.retryAfter
        },
        429
      );
    }
  }

  const existing = await env.DB.prepare(
    "SELECT id, oauth_provider FROM users WHERE email = ?"
  )
    .bind(email)
    .first();
  if (existing) {
    if (existing.oauth_provider === "google") {
      return jsonResponse(
        {
          ok: false,
          error: "该邮箱已通过 Google 登录注册。请直接点「使用 Google 登录」。"
        },
        409
      );
    }
    return jsonResponse({ ok: false, error: "该邮箱已注册" }, 409);
  }

  const salt = crypto.getRandomValues(new Uint8Array(16));
  const hash = await pbkdf2Hash(password, salt);
  const id = crypto.randomUUID();
  const now = Date.now();

  await env.DB.prepare(
    `INSERT INTO users (id, email, password_hash, password_salt, created_at)
     VALUES (?, ?, ?, ?, ?)`
  )
    .bind(id, email, base64Encode(hash), base64Encode(salt), now)
    .run();

  // 注册时如果有匹配该邮箱但还没绑定的 license（webhook 已写入但用户还没注册），
  // 自动认领过来。这样用户「先付款 → 再注册」的路径也能丝滑。
  await env.DB.prepare(
    `UPDATE license_keys
        SET user_id = ?, updated_at = ?
      WHERE user_id IS NULL AND lower(ls_customer_email) = ?`
  )
    .bind(id, now, email)
    .run();

  const token = await issueJwt(env, { sub: id, email });
  return jsonResponse({ ok: true, token, user: { id, email } });
}

// ============================================================
// /api/login
// body: { email, password }
// ============================================================
async function handleLogin(request, env) {
  const body = await readJson(request);
  const email = normalizeEmail(body.email);
  const password = String(body.password || "");
  if (!email || !password) {
    return jsonResponse({ ok: false, error: "请填写邮箱和密码" }, 400);
  }

  const user = await env.DB.prepare(
    "SELECT id, email, password_hash, password_salt, oauth_provider FROM users WHERE email = ?"
  )
    .bind(email)
    .first();
  if (!user) {
    return jsonResponse({ ok: false, error: "邮箱或密码错误" }, 401);
  }

  // OAuth-only 账号（注册时是用 Google/GitHub 一键登录建的）走密码登录路径，
  // 直接告诉用户去用对应的 OAuth 入口，避免他对着 dummy hash 试到天荒地老。
  // 用户如果想要密码登录，也可以走「忘记密码」流程主动给账号设一个密码。
  if (user.oauth_provider && !isUsablePasswordHash(user.password_salt)) {
    const hint =
      user.oauth_provider === "google"
        ? "该账号通过 Google 登录，请点击页面上的「使用 Google 登录」按钮。"
        : `该账号通过 ${user.oauth_provider} 登录，请用对应入口登录。`;
    return jsonResponse({ ok: false, error: hint }, 401);
  }

  const expected = await pbkdf2Hash(password, base64Decode(user.password_salt));
  if (!constantTimeEqual(base64Encode(expected), user.password_hash)) {
    return jsonResponse({ ok: false, error: "邮箱或密码错误" }, 401);
  }

  await env.DB.prepare("UPDATE users SET last_login_at = ? WHERE id = ?")
    .bind(Date.now(), user.id)
    .run();

  const token = await issueJwt(env, { sub: user.id, email: user.email });
  return jsonResponse({
    ok: true,
    token,
    user: { id: user.id, email: user.email }
  });
}

// ============================================================
// /api/me
// header: Authorization: Bearer <jwt>
// ============================================================
async function handleMe(request, env) {
  const auth = await requireAuth(request, env);
  if (!auth.ok) return auth.response;

  // 取一次 user 行（拿 created_at / last_login_at + OAuth 标记），减少前端多次往返
  const userRow = await env.DB.prepare(
    "SELECT id, email, created_at, last_login_at, oauth_provider, password_salt FROM users WHERE id = ?"
  )
    .bind(auth.userId)
    .first();
  const summary = await loadUserLicenseSummary(env, auth.userId);

  // OAuth-only 用户没有可用密码 → 在插件端无法登录（插件不支持 Google 一键）。
  // 把 needsPluginPassword 露给前端，dashboard 可以提示用户去设置一个。
  const oauthProvider = userRow?.oauth_provider || "";
  const needsPluginPassword =
    !!oauthProvider && !isUsablePasswordHash(userRow?.password_salt);

  return jsonResponse({
    ok: true,
    user: {
      id: auth.userId,
      email: auth.email,
      created_at: userRow?.created_at || 0,
      last_login_at: userRow?.last_login_at || 0,
      oauth_provider: oauthProvider,
      needsPluginPassword
    },
    license: summary
  });
}

// ============================================================
// /api/license/bind
// body: { key }
// 把一张已存在的 license_keys 行（通常由 webhook 创建后未绑定）
// 绑到当前 JWT 对应的用户上。
// ============================================================
async function handleLicenseBind(request, env) {
  const auth = await requireAuth(request, env);
  if (!auth.ok) return auth.response;

  const body = await readJson(request);
  const key = normalizeLicenseKey(body.key);
  if (!key) return jsonResponse({ ok: false, error: "请填写 License Key" }, 400);

  const row = await env.DB.prepare(
    "SELECT key, user_id, status FROM license_keys WHERE key = ?"
  )
    .bind(key)
    .first();
  if (!row) {
    return jsonResponse({ ok: false, error: "License Key 不存在或未激活" }, 404);
  }
  if (row.user_id && row.user_id !== auth.userId) {
    return jsonResponse(
      { ok: false, error: "该 License Key 已绑定其它账号" },
      409
    );
  }
  if (row.status !== "active") {
    return jsonResponse(
      { ok: false, error: `License Key 状态为 ${row.status}，无法绑定` },
      400
    );
  }

  await env.DB.prepare(
    "UPDATE license_keys SET user_id = ?, updated_at = ? WHERE key = ?"
  )
    .bind(auth.userId, Date.now(), key)
    .run();

  const summary = await loadUserLicenseSummary(env, auth.userId);
  return jsonResponse({ ok: true, license: summary });
}

// ============================================================
// /api/license/unbind
// body: { key }
// ============================================================
async function handleLicenseUnbind(request, env) {
  const auth = await requireAuth(request, env);
  if (!auth.ok) return auth.response;

  const body = await readJson(request);
  const key = normalizeLicenseKey(body.key);
  if (!key) return jsonResponse({ ok: false, error: "请填写 License Key" }, 400);

  const row = await env.DB.prepare(
    "SELECT key, user_id FROM license_keys WHERE key = ?"
  )
    .bind(key)
    .first();
  if (!row || row.user_id !== auth.userId) {
    return jsonResponse({ ok: false, error: "该 Key 不属于当前账号" }, 404);
  }

  await env.DB.prepare(
    "UPDATE license_keys SET user_id = NULL, updated_at = ? WHERE key = ?"
  )
    .bind(Date.now(), key)
    .run();
  // 同时清掉所有设备激活记录
  await env.DB.prepare("DELETE FROM device_activations WHERE license_key = ?")
    .bind(key)
    .run();
  return jsonResponse({ ok: true });
}

// ============================================================
// /api/license/device/unbind
// body: { key, fingerprint }   或   { key, deviceId }
// 让用户在 dashboard 单独撤销某台设备的授权（不影响 license 本身）。
// 必须 JWT 校验，且该 license 必须属于当前账号。
// ============================================================
async function handleDeviceUnbind(request, env) {
  const auth = await requireAuth(request, env);
  if (!auth.ok) return auth.response;

  const body = await readJson(request);
  const key = normalizeLicenseKey(body.key);
  const fingerprint = String(body.fingerprint || "");
  const deviceId = String(body.deviceId || "");
  if (!key || (!fingerprint && !deviceId)) {
    return jsonResponse({ ok: false, error: "缺少参数（需要 key + fingerprint 或 deviceId）" }, 400);
  }

  const owner = await env.DB.prepare(
    "SELECT user_id FROM license_keys WHERE key = ?"
  )
    .bind(key)
    .first();
  if (!owner || owner.user_id !== auth.userId) {
    return jsonResponse({ ok: false, error: "该 Key 不属于当前账号" }, 404);
  }

  if (deviceId) {
    await env.DB.prepare(
      "DELETE FROM device_activations WHERE license_key = ? AND id = ?"
    )
      .bind(key, deviceId)
      .run();
  } else {
    await env.DB.prepare(
      "DELETE FROM device_activations WHERE license_key = ? AND device_fingerprint = ?"
    )
      .bind(key, fingerprint)
      .run();
  }
  return jsonResponse({ ok: true });
}

// ============================================================
// /api/account/change-password
// body: { oldPassword, newPassword }
// 必须 JWT 校验。校验旧密码 → 写入新 hash + 新 salt。
// ============================================================
async function handleChangePassword(request, env) {
  const auth = await requireAuth(request, env);
  if (!auth.ok) return auth.response;

  const body = await readJson(request);
  const oldPassword = String(body.oldPassword || "");
  const newPassword = String(body.newPassword || "");
  if (!oldPassword || !newPassword) {
    return jsonResponse({ ok: false, error: "请填写旧密码和新密码" }, 400);
  }
  if (newPassword.length < 8) {
    return jsonResponse({ ok: false, error: "新密码至少 8 位" }, 400);
  }

  const user = await env.DB.prepare(
    "SELECT id, password_hash, password_salt FROM users WHERE id = ?"
  )
    .bind(auth.userId)
    .first();
  if (!user) return jsonResponse({ ok: false, error: "账号不存在" }, 404);

  const expected = await pbkdf2Hash(oldPassword, base64Decode(user.password_salt));
  if (!constantTimeEqual(base64Encode(expected), user.password_hash)) {
    // 注意：这里必须用 400，不能用 401。
    // 401 会被 site/assets/js/api.js 的 _onUnauthorized() 拦截 → 清 token + 跳登录。
    // 旧密码错是已登录用户的"业务校验失败"，JWT 仍然有效，应留在当前页面让用户重输。
    // 401 仅保留给 JWT 缺失/过期/签名失败（见 requireAuth 与 webhook signature）。
    return jsonResponse({ ok: false, error: "旧密码不正确" }, 400);
  }

  const newSalt = crypto.getRandomValues(new Uint8Array(16));
  const newHash = await pbkdf2Hash(newPassword, newSalt);
  await env.DB.prepare(
    "UPDATE users SET password_hash = ?, password_salt = ? WHERE id = ?"
  )
    .bind(base64Encode(newHash), base64Encode(newSalt), auth.userId)
    .run();

  return jsonResponse({ ok: true });
}

// ============================================================
// /api/account/set-password
// body: { newPassword }
// 必须 JWT 校验。仅当 password_salt 是 dummy（即 OAuth-only 用户）才允许。
// 已经有真实密码的用户必须走 /api/account/change-password（要旧密码），
// 防止当前会话被劫持后攻击者直接覆盖密码。
//
// 主要使用场景：用户用 Google 一键登录注册后，要在 Chrome 插件里登录
// （插件不支持 Google 登录，只能邮箱密码），需要先在 dashboard 设一个密码。
// ============================================================
async function handleSetPassword(request, env) {
  const auth = await requireAuth(request, env);
  if (!auth.ok) return auth.response;

  const body = await readJson(request);
  const newPassword = String(body.newPassword || "");
  if (newPassword.length < 8) {
    return jsonResponse({ ok: false, error: "密码至少 8 位" }, 400);
  }

  const user = await env.DB.prepare(
    "SELECT id, password_salt, oauth_provider FROM users WHERE id = ?"
  )
    .bind(auth.userId)
    .first();
  if (!user) return jsonResponse({ ok: false, error: "账号不存在" }, 404);

  // 已经有真实密码 → 强制走 change-password 流程（要旧密码），不允许越过验证。
  if (isUsablePasswordHash(user.password_salt)) {
    return jsonResponse(
      { ok: false, error: "账号已有密码，请使用「修改密码」入口" },
      400
    );
  }

  const newSalt = crypto.getRandomValues(new Uint8Array(16));
  const newHash = await pbkdf2Hash(newPassword, newSalt);
  await env.DB.prepare(
    "UPDATE users SET password_hash = ?, password_salt = ? WHERE id = ?"
  )
    .bind(base64Encode(newHash), base64Encode(newSalt), auth.userId)
    .run();

  return jsonResponse({ ok: true });
}

// ============================================================
// /api/auth/request-reset
// body: { email }
// 不论邮箱是否存在都返回 ok=true（防枚举）。如果存在，写一条 password_resets
// 行，由后台/邮件服务把 reset URL 发到用户邮箱。
// ============================================================
async function handleRequestReset(request, env) {
  const ip = request.headers.get("CF-Connecting-IP") || "unknown";
  // 同 IP 限速：1 分钟最多 3 次，避免被刷
  const rl = await rateLimit(env, `rl:reset:${ip}`, 3, 60);
  if (!rl.allowed) {
    return jsonResponse(
      { ok: false, error: `请求过于频繁，请 ${rl.retryAfter}s 后重试` },
      429
    );
  }

  const body = await readJson(request);
  const email = normalizeEmail(body.email);
  if (!email || !isValidEmail(email)) {
    return jsonResponse({ ok: false, error: "邮箱格式不正确" }, 400);
  }

  const user = await env.DB.prepare("SELECT id, email FROM users WHERE email = ?")
    .bind(email)
    .first();

  // 不论用户是否存在，都假装成功，防止账号枚举
  if (!user) {
    return jsonResponse({ ok: true, sent: true });
  }

  const token = randomToken(32);
  const tokenHash = await sha256Hex(token);
  const now = Date.now();
  const expiresAt = now + 30 * 60 * 1000; // 30 分钟有效

  await env.DB.prepare(
    `INSERT INTO password_resets (token_hash, user_id, email, created_at, expires_at, used_at)
     VALUES (?, ?, ?, ?, ?, NULL)`
  )
    .bind(tokenHash, user.id, user.email, now, expiresAt)
    .run();

  // 邮件发送：worker 暂未集成邮件服务（Resend / Mailgun / SES 等）。
  // 上线时在这里调对应服务即可；为方便联调，DEBUG 开关下把 reset URL 直接返回。
  const resetUrl = buildResetUrl(env, token);
  const sendStatus = await sendResetEmail(env, user.email, resetUrl);

  // P0-3 hardening：DEBUG_RESET=1 单独不够，必须配合 ENVIRONMENT=development 才暴露
  // resetUrl —— 防止生产环境意外开启 DEBUG_RESET 导致重置链接通过响应体外泄。
  // 部署方在 .dev.vars 同时写 DEBUG_RESET=1 + ENVIRONMENT=development；生产 [vars]
  // 永远别加 ENVIRONMENT=development（默认空 = 生产）。
  const debugAllowed =
    env.DEBUG_RESET === "1" && env.ENVIRONMENT === "development";
  const debugReturn = debugAllowed ? { resetUrl } : {};

  // 39th 续³ Phase 5 加固 · 关闭枚举漏洞（旧 P0-2 hardening 故意暴露 sent:false + reason
  // 让用户知道"不是被丢了"——但已注册邮箱 + Resend 故障时返 sent:false vs 未注册邮箱
  // 返 sent:true 形成 oracle，攻击者可枚举哪些邮箱已注册）。新行为：
  //   ① 用户不存在 → sent:true（与原 P0-1 一致）
  //   ② 用户存在 + Resend 200 → sent:true（正常路径）
  //   ③ 用户存在 + Resend failed → sent:true（与未注册无差异，console.error 内部记录）
  //   ④ 用户存在 + RESEND_API_KEY 未配 → sent:true（开发期不应进生产，console.warn 提示运维）
  // UX 影响：Resend 故障时用户看到"已发送"但收不到邮件。需配套 health endpoint 给运维监控
  // Resend 失败率，超阈值人工 outreach。debugReturn 仅在 dev 环境（DEBUG_RESET=1 + ENVIRONMENT=development）携带。
  if (sendStatus === "not_configured") {
    console.warn("[reset] CRITICAL: RESEND_API_KEY 未配置（生产环境运维错误，对用户返 sent:true 防枚举）");
    return jsonResponse({ ok: true, sent: true, ...debugReturn });
  }
  if (sendStatus === "failed") {
    console.error("[reset] Resend 调用失败但向用户返 sent:true 防枚举（运维需监控失败率）");
    return jsonResponse({ ok: true, sent: true, ...debugReturn });
  }
  return jsonResponse({ ok: true, sent: true, ...debugReturn });
}

// ============================================================
// /api/auth/reset
// body: { token, newPassword }
// ============================================================
async function handleReset(request, env) {
  const body = await readJson(request);
  const token = String(body.token || "");
  const newPassword = String(body.newPassword || "");
  if (!token || !newPassword) {
    return jsonResponse({ ok: false, error: "缺少参数" }, 400);
  }
  if (newPassword.length < 8) {
    return jsonResponse({ ok: false, error: "新密码至少 8 位" }, 400);
  }

  const tokenHash = await sha256Hex(token);
  const row = await env.DB.prepare(
    `SELECT token_hash, user_id, email, expires_at, used_at
       FROM password_resets WHERE token_hash = ?`
  )
    .bind(tokenHash)
    .first();
  if (!row) {
    return jsonResponse({ ok: false, error: "重置链接无效" }, 404);
  }
  if (row.used_at) {
    return jsonResponse({ ok: false, error: "重置链接已使用过，请重新申请" }, 400);
  }
  if (row.expires_at && row.expires_at < Date.now()) {
    return jsonResponse({ ok: false, error: "重置链接已过期，请重新申请" }, 400);
  }

  const newSalt = crypto.getRandomValues(new Uint8Array(16));
  const newHash = await pbkdf2Hash(newPassword, newSalt);
  await env.DB.prepare(
    "UPDATE users SET password_hash = ?, password_salt = ? WHERE id = ?"
  )
    .bind(base64Encode(newHash), base64Encode(newSalt), row.user_id)
    .run();
  await env.DB.prepare(
    "UPDATE password_resets SET used_at = ? WHERE token_hash = ?"
  )
    .bind(Date.now(), tokenHash)
    .run();

  // 重置成功直接发一个新 JWT，用户可立即登录
  const token2 = await issueJwt(env, { sub: row.user_id, email: row.email });
  return jsonResponse({
    ok: true,
    token: token2,
    user: { id: row.user_id, email: row.email }
  });
}

// ============================================================
// /api/auth/google
// body: { credential }
// credential = Google Identity Services 返回的 ID Token (JWT, RS256)
//
// 行为：
//   1. 用 Google 公开 JWKS 验签该 ID Token；
//   2. 校验 iss、aud（=GOOGLE_CLIENT_ID）、exp、email_verified；
//   3. 用 google_sub 找已绑定用户；找不到则用 email 找已注册用户并补绑 google_sub；
//      都没有则创建一个 oauth-only 新用户（password_hash/salt 存 dummy 值，
//      永远走不到密码登录路径，handleLogin 会拦截并提示"请用 Google 登录"）；
//   4. 如果该邮箱有已发但未绑定的 license（webhook 先到 → 后注册场景），自动认领；
//   5. 返回我们自己的 JWT（与邮箱密码登录完全等价）。
// ============================================================
async function handleGoogleAuth(request, env) {
  // 39th 续³ · Phase 5 加固 · KV strict guard（同 register 路径，防 OAuth 批量注册）
  const kvGuard = assertRateLimitKvAvailable(env, "handleGoogleAuth");
  if (kvGuard) return kvGuard;

  if (!env.GOOGLE_CLIENT_ID) {
    return jsonResponse(
      { ok: false, error: "服务端未配置 Google 登录（缺少 GOOGLE_CLIENT_ID）" },
      503
    );
  }

  const body = await readJson(request);
  const credential = String(body.credential || "");
  if (!credential) {
    return jsonResponse({ ok: false, error: "缺少 credential" }, 400);
  }

  // —— 限速：避免有人拿伪造 token 高频打 JWKS 验签 —— //
  const ip = request.headers.get("CF-Connecting-IP") || "unknown";
  const limit = await rateLimit(env, `google-auth:${ip}`, 20, 60);
  if (!limit.allowed) {
    return jsonResponse(
      { ok: false, error: "请求过于频繁，请稍后重试" },
      429
    );
  }

  let payload;
  try {
    payload = await verifyGoogleIdToken(credential, env.GOOGLE_CLIENT_ID, env);
  } catch (error) {
    return jsonResponse(
      { ok: false, error: `Google 凭据校验失败：${error?.message || "未知错误"}` },
      401
    );
  }

  const email = normalizeEmail(payload.email);
  const googleSub = String(payload.sub || "");
  if (!email || !googleSub) {
    return jsonResponse({ ok: false, error: "Google 凭据缺少 email/sub" }, 400);
  }
  // email_verified 是字符串或布尔，统一处理
  const emailVerified =
    payload.email_verified === true || payload.email_verified === "true";
  if (!emailVerified) {
    return jsonResponse(
      { ok: false, error: "Google 邮箱尚未验证，无法用于登录" },
      403
    );
  }

  // ——— 1. 通过 google_sub 查已绑用户 ———
  let user = await env.DB.prepare(
    "SELECT id, email FROM users WHERE google_sub = ?"
  )
    .bind(googleSub)
    .first();

  // ——— 2. 通过 email 查已存在用户（之前用邮箱密码注册过，这次第一次用 Google 登录）———
  if (!user) {
    const byEmail = await env.DB.prepare(
      "SELECT id, email, google_sub FROM users WHERE email = ?"
    )
      .bind(email)
      .first();
    if (byEmail) {
      // 同邮箱已经绑过另一个 Google 账号，拒绝（防止账号被劫持）
      if (byEmail.google_sub && byEmail.google_sub !== googleSub) {
        return jsonResponse(
          {
            ok: false,
            error: "该邮箱已绑定其它 Google 账号，请联系客服解绑后再试。"
          },
          409
        );
      }
      // 把 google_sub 关联过来（首次绑定 Google）
      if (!byEmail.google_sub) {
        await env.DB.prepare(
          "UPDATE users SET google_sub = ? WHERE id = ?"
        )
          .bind(googleSub, byEmail.id)
          .run();
      }
      user = { id: byEmail.id, email: byEmail.email };
    }
  }

  // ——— 3. 全新用户 → 创建 oauth-only 账号 ———
  if (!user) {
    // 39th 续 · Phase 4 · 新建账号也走 IP 24h 注册数限制（与邮箱密码注册同口径）
    // 已存在用户的 Google 登录不计入此配额
    if (ip !== "unknown") {
      const rl = await rateLimit(env, `register:ip:${ip}`, MAX_REGISTRATIONS_PER_IP_PER_DAY, 86400);
      if (!rl.allowed) {
        return jsonResponse(
          {
            ok: false,
            error: `同一网络 24 小时内已注册 ${MAX_REGISTRATIONS_PER_IP_PER_DAY} 个账号，超过上限。请改日再试或换不同网络重试；如果你是合理使用（如家庭 / 团队共享网络）请邮件 support@docuearn.com 申诉。`,
            reason: "ip_register_limit",
            retryAfterSeconds: rl.retryAfter
          },
          429
        );
      }
    }
    const id = crypto.randomUUID();
    const now = Date.now();
    // dummy password_hash/salt：用确定性的非 base64 字符串占位，
    // 任何 PBKDF2 都不可能算出 = 这两个值的输出 → 密码登录永远失败；
    // 同时 handleLogin 里会先看 oauth_provider 字段，提前给出友好提示。
    await env.DB.prepare(
      `INSERT INTO users (id, email, password_hash, password_salt, google_sub, oauth_provider, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    )
      .bind(id, email, "oauth:google", "oauth:google", googleSub, "google", now)
      .run();

    // 自动认领该邮箱已发但未绑定的 license（webhook 先到、后注册的场景）
    await env.DB.prepare(
      `UPDATE license_keys
          SET user_id = ?, updated_at = ?
        WHERE user_id IS NULL AND lower(ls_customer_email) = ?`
    )
      .bind(id, now, email)
      .run();

    user = { id, email };
  }

  await env.DB.prepare("UPDATE users SET last_login_at = ? WHERE id = ?")
    .bind(Date.now(), user.id)
    .run();

  const token = await issueJwt(env, { sub: user.id, email: user.email });
  return jsonResponse({
    ok: true,
    token,
    user: { id: user.id, email: user.email },
    provider: "google"
  });
}

/**
 * isUsablePasswordHash —— 判断某条用户记录是不是可以走密码登录路径。
 * OAuth-only 账号在创建时把 password_salt 存成 "oauth:google"（非 base64），
 * 我们以此作为"该账号没有可用密码"的标记。
 */
function isUsablePasswordHash(passwordSalt) {
  const salt = String(passwordSalt || "");
  if (!salt) return false;
  if (salt.startsWith("oauth:")) return false;
  return true;
}

// ============================================================
// Google ID Token 验签（RS256 + JWKS）
// ============================================================

const GOOGLE_JWKS_URL = "https://www.googleapis.com/oauth2/v3/certs";
const GOOGLE_JWKS_KV_KEY = "google:jwks:v3";
const GOOGLE_JWKS_TTL = 60 * 60; // 1 小时（Google 实际 max-age 通常 6h，我们更保守）
const GOOGLE_ALLOWED_ISS = new Set([
  "accounts.google.com",
  "https://accounts.google.com"
]);

/**
 * 校验 Google 颁发的 ID Token（GIS 的 credential 字段）。
 * 步骤：
 *   1. 解 header 拿 kid + alg；只接受 alg=RS256；
 *   2. 拉 JWKS（KV 缓存 1h），找到 kid 对应的 RSA 公钥 (n, e)；
 *   3. 用 Web Crypto 导入公钥并 verify 签名；
 *   4. 校验 payload：iss / aud / exp / iat（带 60s 容差）；
 *   5. 返回 payload。
 */
async function verifyGoogleIdToken(idToken, expectedAud, env) {
  const parts = String(idToken || "").split(".");
  if (parts.length !== 3) throw new Error("ID Token 格式不正确");

  const [headerB64, payloadB64, sigB64] = parts;
  const header = safeJsonDecode(base64UrlDecode(headerB64));
  const payload = safeJsonDecode(base64UrlDecode(payloadB64));
  if (!header || !payload) throw new Error("ID Token 解析失败");
  if (header.alg !== "RS256") throw new Error(`不支持的算法 ${header.alg}`);
  if (!header.kid) throw new Error("ID Token 缺少 kid");

  // —— 拿 JWKS：先 KV 缓存，缓存里没有 / 没找到 kid 才回源 —— //
  let jwks = await loadGoogleJwksFromCache(env);
  let jwk = jwks?.keys?.find((k) => k.kid === header.kid);
  if (!jwk) {
    // kid 没命中说明 Google 滚了一次密钥，强制刷新一次
    jwks = await fetchAndCacheGoogleJwks(env);
    jwk = jwks?.keys?.find((k) => k.kid === header.kid);
  }
  if (!jwk) throw new Error("找不到匹配 kid 的 Google 公钥");

  const cryptoKey = await crypto.subtle.importKey(
    "jwk",
    {
      kty: jwk.kty,
      n: jwk.n,
      e: jwk.e,
      alg: "RS256",
      ext: true
    },
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["verify"]
  );

  const data = new TextEncoder().encode(`${headerB64}.${payloadB64}`);
  const sig = base64UrlDecode(sigB64);
  const valid = await crypto.subtle.verify(
    "RSASSA-PKCS1-v1_5",
    cryptoKey,
    sig,
    data
  );
  if (!valid) throw new Error("ID Token 签名无效");

  // —— claim 校验 —— //
  const now = Math.floor(Date.now() / 1000);
  if (!GOOGLE_ALLOWED_ISS.has(payload.iss)) {
    throw new Error(`非法的 iss：${payload.iss}`);
  }
  // aud 可能是字符串或数组
  const audOk = Array.isArray(payload.aud)
    ? payload.aud.includes(expectedAud)
    : payload.aud === expectedAud;
  if (!audOk) {
    throw new Error("aud 与 GOOGLE_CLIENT_ID 不匹配");
  }
  if (typeof payload.exp !== "number" || payload.exp + 60 < now) {
    throw new Error("ID Token 已过期");
  }
  if (typeof payload.iat === "number" && payload.iat - 60 > now) {
    throw new Error("ID Token iat 在未来时间");
  }

  return payload;
}

async function loadGoogleJwksFromCache(env) {
  if (!env.RATE_LIMIT_KV) return null;
  try {
    const raw = await env.RATE_LIMIT_KV.get(GOOGLE_JWKS_KV_KEY);
    if (!raw) return null;
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

async function fetchAndCacheGoogleJwks(env) {
  const res = await fetch(GOOGLE_JWKS_URL, {
    cf: { cacheTtl: GOOGLE_JWKS_TTL, cacheEverything: true }
  });
  if (!res.ok) throw new Error(`拉取 Google JWKS 失败：HTTP ${res.status}`);
  const jwks = await res.json();
  if (!jwks?.keys?.length) throw new Error("Google JWKS 为空");
  if (env.RATE_LIMIT_KV) {
    try {
      await env.RATE_LIMIT_KV.put(GOOGLE_JWKS_KV_KEY, JSON.stringify(jwks), {
        expirationTtl: GOOGLE_JWKS_TTL
      });
    } catch {
      // KV 写失败不影响验签，下一次再尝试缓存
    }
  }
  return jwks;
}

function safeJsonDecode(bytes) {
  try {
    return JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    return null;
  }
}

// ============================================================
// /api/license/verify  ← 插件主调用
// body: { key, deviceFingerprint, deviceLabel? }
// 返回:
//   { ok, plan, status, expiresAt, features, dailyQuota, signature, signedAt }
//   - signature/signedAt 让插件做"离线短期信任"：插件本地记下 signedAt，
//     在 24h 内 fallback 时仍可凭 signature + 本地时间判定 pro，避免每次都联网。
// ============================================================
async function handleLicenseVerify(request, env, ctx) {
  // 39th 续³ · Phase 5 加固 · KV strict guard（防限速失效让攻击者随意 verify 撞解锁）
  const kvGuard = assertRateLimitKvAvailable(env, "handleLicenseVerify");
  if (kvGuard) return kvGuard;

  const ip = request.headers.get("CF-Connecting-IP") || "unknown";
  const ua = request.headers.get("User-Agent") || "";

  const body = await readJson(request);
  const key = normalizeLicenseKey(body.key);
  const fingerprint = String(body.deviceFingerprint || "").slice(0, 128);
  const label = String(body.deviceLabel || "").slice(0, 64);

  if (!key) {
    return jsonResponse({ ok: false, error: "缺少 License Key" }, 400);
  }

  // ---- 限速 ----
  const rlKey = `rl:verify:${key}:${ip}`;
  const rl = await rateLimit(env, rlKey, 10, 60);
  if (!rl.allowed) {
    await writeVerifyLog(env, key, ip, ua, "rate_limited", "");
    return jsonResponse(
      { ok: false, error: `验证过于频繁，请 ${rl.retryAfter}s 后重试` },
      429
    );
  }

  const row = await env.DB.prepare(
    `SELECT key, user_id, plan, status, expires_at FROM license_keys WHERE key = ?`
  )
    .bind(key)
    .first();
  if (!row) {
    await writeVerifyLog(env, key, ip, ua, "not_found", "");
    return jsonResponse({ ok: false, error: "License Key 无效" }, 404);
  }
  if (row.status !== "active") {
    await writeVerifyLog(env, key, ip, ua, "invalid", row.status);
    return jsonResponse(
      { ok: false, error: `License Key 已被 ${row.status}` },
      403
    );
  }
  if (row.expires_at && row.expires_at < Date.now()) {
    await writeVerifyLog(env, key, ip, ua, "expired", "");
    return jsonResponse({ ok: false, error: "License Key 已过期" }, 403);
  }

  // ---- 设备激活记录 + 限额检查（39th 续 · Strategy B） ----
  // 老 fingerprint 再 verify 只 UPDATE last_seen 不卡限额；新 fingerprint 才检查 count
  // 撞顶时返 403 reason="device_limit_exceeded"，dashboard 引导一键解绑闲置
  if (fingerprint) {
    const devicePlan = devicePlanFromLicenseRow(row);
    const limit = DEVICE_LIMITS[devicePlan] ?? DEVICE_LIMITS.free;
    const fpId = await sha256Hex(`${key}:${fingerprint}`);
    const now = Date.now();

    // 这台设备之前激活过吗？（用 fpId 做主键查询，比 (license_key, fingerprint) 复合索引更快）
    const existing = await env.DB.prepare(
      "SELECT id FROM device_activations WHERE id = ?"
    )
      .bind(fpId)
      .first();

    if (!existing) {
      // 新 fingerprint —— 检查总数是否撞顶
      const countRow = await env.DB.prepare(
        "SELECT COUNT(*) AS n FROM device_activations WHERE license_key = ?"
      )
        .bind(key)
        .first();
      const activated = Number(countRow?.n) || 0;
      if (activated >= limit) {
        await writeVerifyLog(env, key, ip, ua, "device_limit", `${activated}/${limit}`);
        // 39th 续 · 给 license 持有者发安全告警邮件（ctx.waitUntil 后台跑不阻塞 403 响应）
        if (row.user_id) {
          const emailTask = sendSecurityAlertEmail(env, {
            userId: row.user_id,
            type: "device_limit_exceeded",
            details: { plan: devicePlan, activated, limit, licenseKey: key }
          });
          if (ctx && typeof ctx.waitUntil === "function") {
            ctx.waitUntil(emailTask);
          } else {
            await emailTask;
          }
        }
        return jsonResponse(
          {
            ok: false,
            error: `本 License 已激活 ${activated} 台设备（${devicePlan === "free" ? "免费版" : devicePlan === "monthly" ? "月费会员" : "年费会员"}上限 ${limit} 台）。请到 ${env.SITE_URL || "https://docuearn.com"}/dashboard 解绑闲置设备后重试。`,
            reason: "device_limit_exceeded",
            activated,
            limit,
            plan: devicePlan
          },
          403
        );
      }
    }

    const uaHint = summarizeUserAgent(ua);
    await env.DB.prepare(
      `INSERT INTO device_activations (id, license_key, device_fingerprint, device_label, user_agent_hint, activated_at, last_seen_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(license_key, device_fingerprint)
       DO UPDATE SET
         last_seen_at    = excluded.last_seen_at,
         device_label    = excluded.device_label,
         user_agent_hint = excluded.user_agent_hint`
    )
      .bind(fpId, key, fingerprint, label, uaHint, now, now)
      .run();

    // 39th 续 · Phase 4.4 · 同 license 跨设备并发突发软告警（仅 verify 成功时跑）
    // 与 device_limit 互补：limit 防"加 100 台"硬卡，burst 防"卖给多人同时用"软告警
    // 用 ctx.waitUntil 后台跑（Resend API 调用 ~200ms 不阻塞 verify 响应）；ctx 缺时退化直接 await
    const burstTask = detectAndLogMultiDeviceBurst(env, key, row.user_id, fingerprint, devicePlan, ip, ua);
    if (ctx && typeof ctx.waitUntil === "function") {
      ctx.waitUntil(burstTask);
    } else {
      await burstTask;
    }
  }

  await writeVerifyLog(env, key, ip, ua, "ok", "");

  const plan = row.plan === "pro" ? "pro" : "free";
  const features = featuresForPlan(plan);
  const dailyQuota = plan === "pro" ? -1 : FREE_DAILY_AI_QUOTA;

  // 离线信任签名：插件可在 24h 内不联网也信任 plan
  const signedAt = Date.now();
  const signature = await signOfflineTrust(env, {
    key,
    plan,
    expiresAt: row.expires_at || 0,
    signedAt
  });

  return jsonResponse({
    ok: true,
    plan,
    status: row.status,
    expiresAt: row.expires_at || 0,
    features,
    dailyQuota,
    signedAt,
    signature
  });
}

// ============================================================
// /api/license/deactivate
// body: { key, deviceFingerprint }
// 让插件能把当前设备从 device_activations 里移除
// ============================================================
async function handleLicenseDeactivate(request, env) {
  const body = await readJson(request);
  const key = normalizeLicenseKey(body.key);
  const fingerprint = String(body.deviceFingerprint || "");
  if (!key || !fingerprint) {
    return jsonResponse({ ok: false, error: "缺少参数" }, 400);
  }
  await env.DB.prepare(
    "DELETE FROM device_activations WHERE license_key = ? AND device_fingerprint = ?"
  )
    .bind(key, fingerprint)
    .run();
  return jsonResponse({ ok: true });
}

// ============================================================
// /api/webhook/lemon
// Lemon Squeezy 支付回调
// 关心的事件：
//   order_created, subscription_created, subscription_updated,
//   subscription_cancelled, subscription_expired, subscription_resumed,
//   license_key_created, license_key_updated
// ============================================================
async function handleLemonWebhook(request, env) {
  const signature = request.headers.get("X-Signature") || "";
  const eventName = request.headers.get("X-Event-Name") || "";
  const eventId = request.headers.get("X-Event-Id") || "";
  const rawBody = await request.text();

  if (!env.LS_WEBHOOK_SECRET) {
    return jsonResponse({ ok: false, error: "服务器未配置 webhook secret" }, 500);
  }

  // ---- 验签 ----
  const expected = await hmacSha256Hex(env.LS_WEBHOOK_SECRET, rawBody);
  if (!constantTimeEqual(expected, signature)) {
    return jsonResponse({ ok: false, error: "签名校验失败" }, 401);
  }

  // ---- 幂等 ----
  if (eventId) {
    const dup = await env.DB.prepare(
      "SELECT event_id FROM webhook_events WHERE event_id = ?"
    )
      .bind(eventId)
      .first();
    if (dup) return jsonResponse({ ok: true, dedup: true });
  }

  let payload;
  try {
    payload = JSON.parse(rawBody);
  } catch {
    return jsonResponse({ ok: false, error: "payload 不是合法 JSON" }, 400);
  }

  // ---- 事件分发 ----
  const result = await dispatchLemonEvent(env, eventName, payload);

  if (eventId) {
    await env.DB.prepare(
      `INSERT INTO webhook_events (event_id, event_name, raw, processed_at)
       VALUES (?, ?, ?, ?)`
    )
      .bind(eventId, eventName, rawBody.slice(0, 8000), Date.now())
      .run();
  }

  return jsonResponse({ ok: true, ...result });
}

// ============================================================
// Lemon Squeezy 事件分发
// ============================================================
async function dispatchLemonEvent(env, eventName, payload) {
  const data = payload?.data || {};
  const attrs = data?.attributes || {};
  const meta = payload?.meta || {};

  const orderId =
    String(meta?.order_id || attrs?.order_id || data?.id || "") || "";
  const subscriptionId = String(attrs?.subscription_id || data?.id || "");
  const customerEmail = normalizeEmail(
    attrs?.user_email || attrs?.customer_email || ""
  );
  const variantId = String(attrs?.variant_id || "");

  // 过滤：只对配置过的 variant 生效
  if (env.LS_VARIANT_IDS) {
    const allowList = env.LS_VARIANT_IDS.split(",").map((x) => x.trim());
    if (variantId && !allowList.includes(variantId)) {
      return { skipped: true, reason: "variant_not_in_allowlist" };
    }
  }

  switch (eventName) {
    case "order_created":
    case "subscription_created":
    case "subscription_resumed":
    case "subscription_updated": {
      // 试图复用：同一个 order/subscription 已经发过 license 就不再发
      const existing = await env.DB.prepare(
        `SELECT key FROM license_keys
          WHERE (ls_order_id = ? AND ls_order_id != '')
             OR (ls_subscription_id = ? AND ls_subscription_id != '')`
      )
        .bind(orderId, subscriptionId)
        .first();

      let key;
      const expiresAt = parseLemonRenewsAt(attrs);
      const now = Date.now();
      if (existing) {
        key = existing.key;
        await env.DB.prepare(
          `UPDATE license_keys
              SET status = 'active',
                  plan = 'pro',
                  expires_at = ?,
                  ls_subscription_id = ?,
                  ls_customer_email = ?,
                  updated_at = ?
            WHERE key = ?`
        )
          .bind(expiresAt, subscriptionId, customerEmail, now, key)
          .run();
      } else {
        key = await generateLicenseKey(env);
        await env.DB.prepare(
          `INSERT INTO license_keys
              (key, user_id, plan, status, expires_at,
               ls_order_id, ls_subscription_id, ls_customer_email,
               created_at, updated_at)
            VALUES (?, NULL, 'pro', 'active', ?, ?, ?, ?, ?, ?)`
        )
          .bind(
            key,
            expiresAt,
            orderId,
            subscriptionId,
            customerEmail,
            now,
            now
          )
          .run();
      }

      // 自动绑到已有用户（如果用户用同样邮箱注册过）
      if (customerEmail) {
        await env.DB.prepare(
          `UPDATE license_keys
              SET user_id = (SELECT id FROM users WHERE email = ?)
            WHERE key = ? AND user_id IS NULL`
        )
          .bind(customerEmail, key)
          .run();
      }

      return { key, action: existing ? "renewed" : "issued" };
    }

    case "subscription_cancelled":
    case "subscription_expired": {
      await env.DB.prepare(
        `UPDATE license_keys
            SET status = 'expired', updated_at = ?
          WHERE ls_subscription_id = ?`
      )
        .bind(Date.now(), subscriptionId)
        .run();
      return { action: "expired", subscriptionId };
    }

    default:
      return { ignored: true, eventName };
  }
}

// ============================================================
// 工具函数
// ============================================================

async function readJson(request) {
  try {
    const text = await request.text();
    if (!text) return {};
    return JSON.parse(text);
  } catch {
    return {};
  }
}

function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8" }
  });
}

function corsResponse(request, env, response) {
  const origin = request.headers.get("Origin") || "";
  const allowed = (env.ALLOWED_ORIGINS || "").split(",").map((x) => x.trim());
  const matched =
    allowed.includes("*") ||
    allowed.includes(origin) ||
    allowed.some((pattern) => {
      if (!pattern.includes("*")) return pattern === origin;
      const re = new RegExp(
        "^" +
          pattern.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*") +
          "$"
      );
      return re.test(origin);
    });

  const headers = new Headers(response.headers);
  if (matched && origin) {
    headers.set("Access-Control-Allow-Origin", origin);
    headers.set("Vary", "Origin");
    headers.set("Access-Control-Allow-Credentials", "true");
  }
  headers.set(
    "Access-Control-Allow-Methods",
    "GET, POST, PUT, DELETE, OPTIONS"
  );
  headers.set(
    "Access-Control-Allow-Headers",
    "Authorization, Content-Type, X-Signature, X-Event-Name, X-Event-Id"
  );

  return new Response(response.body, {
    status: response.status,
    headers
  });
}

function normalizeEmail(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .slice(0, 320);
}

function isValidEmail(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

function normalizeLicenseKey(value) {
  const raw = String(value || "")
    .trim()
    .toUpperCase()
    .replace(/\s+/g, "");
  if (!/^GZHT-[2-9A-HJ-NP-Z]{4}-[2-9A-HJ-NP-Z]{4}-[2-9A-HJ-NP-Z]{4}$/.test(raw)) {
    return "";
  }
  return raw;
}

function featuresForPlan(plan) {
  // 39th 续 · monthly / yearly / pro 都视为付费档；plans-based 闸门（ai.bringYourOwnKey 等）
  // 由扩展端 license.js mapEffectivePlanToLlmPlan + meta.plans 数组单独 gating，此处粗粒度即可
  if (plan === "pro" || plan === "yearly" || plan === "monthly") {
    return Object.fromEntries(PAID_FEATURE_KEYS.map((k) => [k, true]));
  }
  return Object.fromEntries(PAID_FEATURE_KEYS.map((k) => [k, false]));
}

async function loadUserLicenseSummary(env, userId) {
  const rows = await env.DB.prepare(
    `SELECT key, plan, status, expires_at, created_at
       FROM license_keys
      WHERE user_id = ?
        AND status != 'refunded'
      ORDER BY created_at DESC`
  )
    .bind(userId)
    .all();
  const list = rows.results || [];

  // 一次性把这些 key 下的设备拉出来，避免 N+1 查询
  const deviceMap = new Map();
  if (list.length) {
    const placeholders = list.map(() => "?").join(",");
    const devRows = await env.DB.prepare(
      `SELECT id, license_key, device_fingerprint, device_label, user_agent_hint, activated_at, last_seen_at
         FROM device_activations
        WHERE license_key IN (${placeholders})
        ORDER BY last_seen_at DESC`
    )
      .bind(...list.map((r) => r.key))
      .all();
    for (const dev of devRows.results || []) {
      const arr = deviceMap.get(dev.license_key) || [];
      arr.push({
        id: dev.id,
        fingerprint: dev.device_fingerprint,
        label: dev.device_label || "",
        userAgentHint: dev.user_agent_hint || "",
        activated_at: dev.activated_at,
        last_seen_at: dev.last_seen_at
      });
      deviceMap.set(dev.license_key, arr);
    }
  }

  // 找出当前最优的 license（active 且未过期 → 按 PLAN_RANK 选最高档）
  let active = null;
  for (const row of list) {
    row.devices = deviceMap.get(row.key) || [];
    // 39th 续 · 暴露每张 license 的设备配额（Free 1 / Monthly 3 / Yearly 10）
    // dashboard 用此值渲染 "8 / 10 台已激活"
    row.deviceLimit = DEVICE_LIMITS[devicePlanFromLicenseRow(row)] ?? DEVICE_LIMITS.free;
    if (row.status !== "active") continue;
    if (row.expires_at && row.expires_at < Date.now()) continue;
    if (!active) {
      active = row;
      continue;
    }
    // 39th 续 · 按 PLAN_RANK 选最高档（pro 3 > yearly 2 > monthly 1 > free 0）
    if ((PLAN_RANK[row.plan] || 0) > (PLAN_RANK[active.plan] || 0)) active = row;
  }

  return {
    plan: active?.plan || "free",
    status: active?.status || "free",
    activeKey: active?.key || "",
    expiresAt: active?.expires_at || 0,
    keys: list,
    features: featuresForPlan(active?.plan || "free")
  };
}

// ---------- 鉴权 ----------
async function requireAuth(request, env) {
  const header = request.headers.get("Authorization") || "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : "";
  if (!token) {
    return {
      ok: false,
      response: jsonResponse({ ok: false, error: "未登录" }, 401)
    };
  }
  try {
    const payload = await verifyJwt(env, token);
    return { ok: true, userId: payload.sub, email: payload.email };
  } catch (error) {
    return {
      ok: false,
      response: jsonResponse(
        { ok: false, error: "登录已过期，请重新登录" },
        401
      )
    };
  }
}

// ---------- JWT (HS256) ----------
async function issueJwt(env, claims) {
  if (!env.JWT_SECRET) throw new Error("缺少 JWT_SECRET");
  const header = { alg: "HS256", typ: "JWT" };
  const now = Math.floor(Date.now() / 1000);
  const payload = {
    ...claims,
    iat: now,
    exp: now + JWT_TTL_SECONDS
  };
  const toSign = `${b64urlJson(header)}.${b64urlJson(payload)}`;
  const sig = await hmacSha256(env.JWT_SECRET, toSign);
  return `${toSign}.${base64UrlEncode(sig)}`;
}

async function verifyJwt(env, token) {
  if (!env.JWT_SECRET) throw new Error("缺少 JWT_SECRET");
  const parts = token.split(".");
  if (parts.length !== 3) throw new Error("invalid jwt");
  const [h, p, s] = parts;
  const expected = await hmacSha256(env.JWT_SECRET, `${h}.${p}`);
  if (!constantTimeEqual(base64UrlEncode(expected), s)) {
    throw new Error("bad signature");
  }
  const payload = JSON.parse(new TextDecoder().decode(base64UrlDecode(p)));
  if (payload.exp && payload.exp * 1000 < Date.now()) {
    throw new Error("expired");
  }
  return payload;
}

// ---------- PBKDF2 + HMAC + SHA256 ----------
async function pbkdf2Hash(password, salt) {
  const baseKey = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(password),
    { name: "PBKDF2" },
    false,
    ["deriveBits"]
  );
  const bits = await crypto.subtle.deriveBits(
    {
      name: "PBKDF2",
      salt,
      iterations: PBKDF2_ITERATIONS,
      hash: "SHA-256"
    },
    baseKey,
    32 * 8
  );
  return new Uint8Array(bits);
}

async function hmacSha256(secret, message) {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const buf = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(message)
  );
  return new Uint8Array(buf);
}

async function hmacSha256Hex(secret, message) {
  const bytes = await hmacSha256(secret, message);
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

async function sha256Hex(message) {
  const buf = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(message)
  );
  return Array.from(new Uint8Array(buf))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

// 离线信任签名：用 LICENSE_SIGNING_SECRET 对 (key|plan|exp|signedAt) 签 HMAC，
// 插件本地存下来后，在 24h 内不联网也能用同一个 secret 校验 — 但 secret 不外泄，
// 所以实际是"插件只验时间戳和 plan"，无法伪造 plan。
async function signOfflineTrust(env, payload) {
  if (!env.LICENSE_SIGNING_SECRET) return "";
  const message = `${payload.key}|${payload.plan}|${payload.expiresAt}|${payload.signedAt}`;
  return await hmacSha256Hex(env.LICENSE_SIGNING_SECRET, message);
}

// ---------- License Key 生成 ----------
async function generateLicenseKey(env) {
  // 形如 GZHT-XXXX-XXXX-XXXX，最后一段为前三段的 djb2 校验位
  const prefix = (env.LICENSE_KEY_PREFIX || "GZHT").toUpperCase();
  const ALPHABET = "23456789ABCDEFGHJKLMNPQRSTUVWXYZ";
  for (let attempt = 0; attempt < 10; attempt++) {
    const seg = (n) => {
      const bytes = crypto.getRandomValues(new Uint8Array(n));
      let s = "";
      for (const b of bytes) s += ALPHABET[b % ALPHABET.length];
      return s;
    };
    const a = seg(4);
    const b = seg(4);
    const c = seg(4);
    const checksum = computeChecksumSegment(a + b + c);
    const key = `${prefix}-${a}-${b}-${checksum}`;

    // PRO 套餐用 P 开头第二段（与插件 license.js 的策略一致）
    // 这里不强制，但若想要插件离线判定也对，可在 a 上做处理。简化做法：
    // 真实部署里完全靠服务端 plan 字段，不依赖 key 段含义。

    const dup = await env.DB.prepare(
      "SELECT key FROM license_keys WHERE key = ?"
    )
      .bind(key)
      .first();
    if (!dup) return key;
  }
  throw new Error("无法生成唯一 license key");
}

function computeChecksumSegment(input) {
  const ALPHABET = "23456789ABCDEFGHJKLMNPQRSTUVWXYZ";
  let hash = 5381;
  for (const ch of input) {
    hash = ((hash << 5) + hash + ch.charCodeAt(0)) >>> 0;
  }
  let acc = "";
  for (let i = 0; i < 4; i++) {
    acc += ALPHABET[hash & 31];
    hash = (hash >>> 5) | ((hash & 31) << 27);
  }
  return acc;
}

// ---------- 限速（KV） ----------
async function rateLimit(env, key, limit, windowSeconds) {
  if (!env.RATE_LIMIT_KV) return { allowed: true };
  const now = Math.floor(Date.now() / 1000);
  const bucket = `${key}:${Math.floor(now / windowSeconds)}`;
  const stored = await env.RATE_LIMIT_KV.get(bucket);
  const count = stored ? parseInt(stored, 10) : 0;
  if (count >= limit) {
    return { allowed: false, retryAfter: windowSeconds - (now % windowSeconds) };
  }
  await env.RATE_LIMIT_KV.put(bucket, String(count + 1), {
    expirationTtl: windowSeconds * 2
  });
  return { allowed: true };
}

async function writeVerifyLog(env, key, ip, ua, result, detail) {
  // 只记录非 ok 结果，避免 D1 行数爆炸
  if (result === "ok") return;
  try {
    await env.DB.prepare(
      `INSERT INTO verify_log (license_key, ip, user_agent, result, detail, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`
    )
      .bind(key, ip, ua.slice(0, 256), result, detail.slice(0, 256), Date.now())
      .run();
  } catch (error) {
    console.warn("write verify_log failed", error);
  }
}

// ---------- Lemon Squeezy 字段解析 ----------
// 注意：根据虎皮椒《商户服务协议》3.12，单次签发的虚拟会员权益最长 ≤ 365 天，
// 因此这里强制把 expires_at 上限封到 now + 365 天；缺失字段时也回退到 365 天，
// 不再签发"永久"。续费由各支付平台 webhook 触发新一次签发。
function parseLemonRenewsAt(attrs) {
  const ONE_YEAR_MS = 365 * 24 * 60 * 60 * 1000;
  const now = Date.now();
  const cap = now + ONE_YEAR_MS;

  const candidate =
    attrs?.renews_at || attrs?.ends_at || attrs?.expires_at || "";
  if (!candidate) return cap;
  const ms = Date.parse(candidate);
  if (!Number.isFinite(ms)) return cap;
  return Math.min(ms, cap);
}

// ---------- base64 / base64url ----------
function base64Encode(bytes) {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
}

function base64Decode(str) {
  const s = atob(str);
  const bytes = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) bytes[i] = s.charCodeAt(i);
  return bytes;
}

function base64UrlEncode(bytes) {
  return base64Encode(bytes)
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

function base64UrlDecode(str) {
  const pad = 4 - (str.length % 4 || 4);
  const padded =
    str.replace(/-/g, "+").replace(/_/g, "/") +
    (pad === 4 ? "" : "=".repeat(pad));
  return base64Decode(padded);
}

function b64urlJson(obj) {
  return base64UrlEncode(new TextEncoder().encode(JSON.stringify(obj)));
}

function constantTimeEqual(a, b) {
  if (typeof a !== "string" || typeof b !== "string") return false;
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}

// ---------- 密码重置工具 ----------

/**
 * 生成 url-safe 的随机 token（默认 32 字节 → 43 个字符的 base64url）。
 * 用于密码重置链接：服务端只存 sha256(token)，URL 上传明文 token。
 * 这样即使 DB 泄露，攻击者也无法用 token 反推回原始链接。
 */
function randomToken(byteLen = 32) {
  const bytes = crypto.getRandomValues(new Uint8Array(byteLen));
  return base64UrlEncode(bytes);
}

/**
 * 把 token 拼成完整 reset URL。优先用 env.SITE_BASE（在 wrangler.toml 里配），
 * 兜底是常见的 Cloudflare Pages 域名占位（明显错误时部署方会一眼看出来）。
 */
function buildResetUrl(env, token) {
  const base = (env.SITE_BASE || "https://gzh.example.com").replace(/\/+$/, "");
  return `${base}/reset.html?token=${encodeURIComponent(token)}`;
}

/**
 * 发送密码重置邮件。
 * Cloudflare Worker 没有内置邮件服务，这里把"集成点"留出来：
 *   - 接 Resend：fetch("https://api.resend.com/emails", { headers: { authorization: `Bearer ${env.RESEND_API_KEY}` }, ... })
 *   - 接 Mailgun / SES / 腾讯云邮件 同理
 *
 * 当 env.RESEND_API_KEY 已配，就走 Resend；否则只在 console 打印（开发环境）。
 * 这样部署方可以"先上线、后接邮件"，不阻塞发布。
 *
 * ⚠️ 调用合约：本函数永远不抛异常（接口对外 ok=true 防枚举），但会把
 * 「请求 + 响应 status + body 前 500 字符」详细 log 出来，按项目 SOP
 * 排查必须用 `wrangler tail --status error` 看 log，不是看 HTTP 返回码。
 * 详见 docs/RESEND_EMAIL_SETUP.md。
 *
 * 返回状态字符串供 handleRequestReset 决定对外响应：
 *   - "sent"            : 真实发出（Resend 200 OK）
 *   - "not_configured"  : 未配置 RESEND_API_KEY（生产环境若返回此值说明运维漏配）
 *   - "failed"          : Resend 接受了请求但返回非 2xx，或网络/TLS 失败
 *
 * 调用方对未注册邮箱仍要返回 ok:true sent:true（防枚举）；只有"用户存在但
 * 邮件实际没发出去"的场景才把 sent:false + reason 透给前端。
 */
async function sendResetEmail(env, toEmail, resetUrl) {
  const subject = "润笔 · 重置你的密码";
  const text = `你好，

我们收到了一个把这个邮箱关联账号密码重置的请求。
点击下方链接（30 分钟内有效）即可设置新密码：

${resetUrl}

如果不是你本人发起的，可以忽略本邮件 —— 你的密码不会被更改。

— 润笔 DocuEarn
让你多一份安稳`;

  if (!env.RESEND_API_KEY) {
    // 没配邮件服务：写日志，方便开发期手动复制 link
    console.log(
      `[reset] (no email provider) to=${toEmail} url=${resetUrl} ` +
        `(配 RESEND_API_KEY 后会真发邮件，详见 docs/RESEND_EMAIL_SETUP.md)`
    );
    return "not_configured";
  }

  const fromEmail = env.RESET_EMAIL_FROM || "no-reply@docuearn.com";

  // 出参 log（按项目 SOP：调外部 API 必须打请求摘要）
  console.log(`[reset] sending via Resend from=${fromEmail} to=${toEmail}`);

  try {
    const resp = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${env.RESEND_API_KEY}`
      },
      body: JSON.stringify({
        from: fromEmail,
        to: [toEmail],
        subject,
        text
      })
    });

    let bodyText = "";
    try {
      bodyText = await resp.text();
    } catch {
      bodyText = "(failed to read body)";
    }
    const bodyPreview = bodyText.slice(0, 500);

    if (!resp.ok) {
      // 入参 log：status + body 前 500 字符（按 SOP）
      // 用 console.error 让 `wrangler tail --status error` 能筛出来
      console.error(
        `[reset] Resend FAILED status=${resp.status} body=${bodyPreview}`
      );
      return "failed";
    }
    console.log(`[reset] Resend ok status=${resp.status} body=${bodyPreview}`);
    return "sent";
  } catch (error) {
    // 网络层失败（DNS / 超时 / TLS）。永远不抛回上层。
    console.error(
      `[reset] Resend network error to=${toEmail}:`,
      error?.message || error
    );
    return "failed";
  }
}

// 39th 续³ #9 · 安全告警邮件已抽到 server/email/security-alert.js（worker.js 瘦身 ~200 行）
// sendSecurityAlertEmail / buildSecurityAlertContent 在文件顶部 import + re-export

// ============================================================
// 虎皮椒（HuPiJiao）支付通路
// ------------------------------------------------------------
// 接入文档：https://www.xunhupay.com/doc/api/pay.html
// 流程：
//   ① 前端 POST /api/payment/hupijiao/create { plan } —— 已登录
//   ② Worker 写 orders.status=pending → POST 虎皮椒 do.html
//      → 拿 url_qrcode 返回前端
//   ③ 前端弹二维码 modal + 每 2s 轮询 /query
//   ④ 用户扫码付款 → 虎皮椒回调 /notify（form-urlencoded）
//      Worker 验签 + 校金额 + 幂等 + 签发 license + 返回字符串 "success"
//   ⑤ 前端轮询拿到 paid → toast → 跳 dashboard
// ============================================================

/**
 * 套餐白名单。前端 site-config.js PLANS 必须与本表完全一致；
 * 价格/天数以 Worker 为准（前端只能传 plan code，价格不可信）。
 */
const HUPIJIAO_PLANS = {
  monthly: { code: "monthly", title: "Pro 月付", fee: 29.0, days: 31 },
  yearly: { code: "yearly", title: "Pro 年付", fee: 288.0, days: 365 }
};

// 单笔订单的有效期（超过没付就算 expired）
const ORDER_TTL_MS = 30 * 60 * 1000; // 30 分钟
// 防重放：同一 nonce_str 在 KV 里 30 分钟内不能重复
const NONCE_TTL_S = 30 * 60;

/* ----------------------------- handler: create ----------------------------- */
async function handleHupijiaoCreate(request, env) {
  const auth = await requireAuth(request, env);
  if (!auth.ok) return auth.response;
  if (!env.HUPIJIAO_APP_ID || !env.HUPIJIAO_APP_SECRET) {
    return jsonResponse({ ok: false, error: "支付通道未配置" }, 503);
  }

  const body = await readJson(request);
  const planCode = String(body?.plan || "").toLowerCase();
  const plan = HUPIJIAO_PLANS[planCode];
  if (!plan) return jsonResponse({ ok: false, error: "套餐不存在" }, 400);

  // 防止用户左下角连点 → 同一用户 1 分钟内已有 pending 单时，复用之
  const recent = await env.DB.prepare(
    `SELECT trade_order_id, pay_qrcode, pay_url, total_fee, status, created_at
       FROM orders
      WHERE user_id = ? AND plan_code = ? AND status = 'pending'
        AND created_at > ?
      ORDER BY id DESC LIMIT 1`
  )
    .bind(auth.userId, planCode, Date.now() - 60_000)
    .first();
  if (recent && recent.pay_qrcode) {
    return jsonResponse({
      ok: true,
      trade_order_id: recent.trade_order_id,
      qrcode: recent.pay_qrcode,
      h5_url: recent.pay_url,
      total_fee: recent.total_fee,
      title: plan.title,
      reused: true
    });
  }

  const tradeOrderId = generateTradeOrderId(auth.userId);
  const notifyUrl = `${env.WORKER_PUBLIC_URL || ""}/api/payment/hupijiao/notify`;
  const returnUrl = `${env.SITE_URL || ""}/dashboard.html?from=checkout&result=success&order=${tradeOrderId}`;

  // 先入库 pending（即使虎皮椒下单失败也保留一条记录，便于排查）
  const now = Date.now();
  await env.DB.prepare(
    `INSERT INTO orders
        (trade_order_id, user_id, user_email, plan_code, total_fee, days,
         status, source, created_at)
      VALUES (?, ?, ?, ?, ?, ?, 'pending', 'hupijiao', ?)`
  )
    .bind(
      tradeOrderId,
      auth.userId,
      auth.email || "",
      planCode,
      plan.fee,
      plan.days,
      now
    )
    .run();

  let res;
  try {
    res = await createHupijiaoOrder(env, {
      tradeOrderId,
      totalFee: plan.fee,
      title: plan.title,
      notifyUrl,
      returnUrl
    });
  } catch (error) {
    console.error("[hpj] createHupijiaoOrder threw:", error?.stack || error);
    await env.DB.prepare(
      `UPDATE orders SET status = 'failed', notify_payload = ? WHERE trade_order_id = ?`
    )
      .bind(JSON.stringify({ error: String(error?.message || error) }), tradeOrderId)
      .run();
    return jsonResponse(
      { ok: false, error: "下单失败：" + (error?.message || "未知错误") },
      502
    );
  }

  if (!res || res.errcode !== 0 || !(res.url || res.url_qrcode)) {
    console.warn("[hpj] hupijiao returned non-success:", JSON.stringify(res));
    await env.DB.prepare(
      `UPDATE orders SET status = 'failed', notify_payload = ? WHERE trade_order_id = ?`
    )
      .bind(JSON.stringify(res || {}), tradeOrderId)
      .run();
    return jsonResponse(
      { ok: false, error: res?.errmsg || "支付平台返回异常" },
      502
    );
  }

  await env.DB.prepare(
    `UPDATE orders SET pay_qrcode = ?, pay_url = ? WHERE trade_order_id = ?`
  )
    .bind(res.url_qrcode || "", res.url || "", tradeOrderId)
    .run();

  return jsonResponse({
    ok: true,
    trade_order_id: tradeOrderId,
    qrcode: res.url_qrcode || "",
    h5_url: res.url || "",
    total_fee: plan.fee,
    title: plan.title
  });
}

/* ----------------------------- handler: notify ----------------------------- */
async function handleHupijiaoNotify(request, env) {
  // 虎皮椒回调是 form-urlencoded，不是 JSON
  const formText = await request.text();
  const params = parseFormUrlEncoded(formText);

  // 防御：必填字段
  const tradeOrderId = String(params.trade_order_id || "");
  const status = String(params.status || "");
  const totalFee = parseFloat(params.total_fee || "0");
  const hash = String(params.hash || "");
  const nonceStr = String(params.nonce_str || "");

  if (!tradeOrderId || !hash || !nonceStr) {
    return new Response("missing required fields", { status: 400 });
  }

  // 防重放：同一 nonce_str 30 分钟内不能再处理
  if (env.RATE_LIMIT_KV) {
    const nonceKey = `hpj:nonce:${nonceStr}`;
    const seen = await env.RATE_LIMIT_KV.get(nonceKey);
    if (seen) return new Response("replayed", { status: 400 });
    await env.RATE_LIMIT_KV.put(nonceKey, "1", { expirationTtl: NONCE_TTL_S });
  }

  // 验签：除 hash 之外所有非空字段，按 key 字典序拼接 + AppSecret，MD5
  const expected = await signHupijiao(params, env.HUPIJIAO_APP_SECRET || "");
  if (!constantTimeEqualString(expected, hash)) {
    console.warn("[hpj] hash mismatch", { tradeOrderId, expected, got: hash });
    return new Response("invalid sign", { status: 401 });
  }

  // 查订单
  const order = await env.DB.prepare(
    `SELECT * FROM orders WHERE trade_order_id = ?`
  )
    .bind(tradeOrderId)
    .first();
  if (!order) return new Response("order not found", { status: 404 });

  // 幂等：已经处理过的，直接回 success（虎皮椒会重试 6 次，必须返回 success 结束）
  if (order.status === "paid") {
    return new Response("success", { status: 200 });
  }

  // 退款 / 退款中 / 退款失败：只更状态，不签发权益
  if (status === "CD" || status === "RD" || status === "UD") {
    await env.DB.prepare(
      `UPDATE orders SET status = 'refunded', notify_payload = ? WHERE trade_order_id = ?`
    )
      .bind(formText, tradeOrderId)
      .run();
    // 这里有需要的话还可以反过来 revoke 对应 license_keys
    return new Response("success", { status: 200 });
  }

  // 只接 OD（已支付）；其他状态拒绝继续
  if (status !== "OD") {
    return new Response("unsupported status", { status: 400 });
  }

  // 金额一致性校验（防止小额订单骗大额开通）
  if (Math.abs(totalFee - Number(order.total_fee)) > 0.01) {
    console.warn("[hpj] amount mismatch", {
      tradeOrderId,
      expected: order.total_fee,
      got: totalFee
    });
    return new Response("amount mismatch", { status: 400 });
  }

  // 签发 license（issueProLicense 内部强制 365d 上限）
  // 39th 续 · 透传 planCode 让 license_keys.plan 写真实 monthly/yearly 而非历史 'pro' 兜底
  const issued = await issueProLicense(env, {
    userId: order.user_id,
    userEmail: order.user_email || "",
    source: "hupijiao",
    sourceOrderId: tradeOrderId,
    days: order.days,
    planCode: order.plan_code || ""
  });

  // 标记 paid + 写入 license key + 存档原始回调
  await env.DB.prepare(
    `UPDATE orders
        SET status = 'paid',
            paid_at = ?,
            granted_license_key = ?,
            hupijiao_open_order_id = ?,
            hupijiao_transaction_id = ?,
            notify_payload = ?
      WHERE trade_order_id = ?`
  )
    .bind(
      Date.now(),
      issued.key,
      String(params.open_order_id || ""),
      String(params.transaction_id || ""),
      formText,
      tradeOrderId
    )
    .run();

  // 必须返回纯字符串 "success"，否则虎皮椒会重试 6 次
  return new Response("success", { status: 200 });
}

/* ----------------------------- handler: query ------------------------------ */
async function handleHupijiaoQuery(request, env, ctx, url) {
  const auth = await requireAuth(request, env);
  if (!auth.ok) return auth.response;

  const tradeOrderId = url.searchParams.get("trade_order_id") || "";
  if (!tradeOrderId) {
    return jsonResponse({ ok: false, error: "缺少 trade_order_id" }, 400);
  }

  const row = await env.DB.prepare(
    `SELECT trade_order_id, status, plan_code, total_fee, paid_at, created_at,
            granted_license_key, user_id
       FROM orders WHERE trade_order_id = ?`
  )
    .bind(tradeOrderId)
    .first();
  if (!row) return jsonResponse({ ok: false, error: "订单不存在" }, 404);
  if (row.user_id !== auth.userId) {
    return jsonResponse({ ok: false, error: "无权查询" }, 403);
  }

  // 自然过期（pending 超过 30 分钟没付）
  let status = row.status;
  if (status === "pending" && Date.now() - row.created_at > ORDER_TTL_MS) {
    status = "expired";
  }

  return jsonResponse({
    ok: true,
    status,
    trade_order_id: row.trade_order_id,
    plan_code: row.plan_code,
    total_fee: row.total_fee,
    paid_at: row.paid_at,
    granted_license_key: row.granted_license_key || ""
  });
}

// ============================================================
// /api/llm/chat 平台 LLM 代理（39th session 起 · OpenAI-compatible）
// ============================================================
// 流程：requireAuth → load license → derivePlanForLlm → resolveTier → 限流 → 配额 →
//      callUpstreamWithFallback → recordUsage（成功才扣额度）→ recordAudit（一定写）
//
// 错误码契约：
//   401 未登录                     ← requireAuth
//   400 messages 字段缺失/非法
//   402 quota_exceeded             ← 月度额度撞顶；扩展端弹「升级会员」引导
//   429 rate_limited               ← 当前分钟 RPM 超限
//   503 upstream_not_configured    ← env 没注入对应 *_API_KEY（运维问题）
//   200 + 上游 body                ← 透传 OpenAI-compatible 响应
//   非 200 + 上游 body             ← 上游报错时也透传（4xx auth/billing 等）
//
// 响应头：
//   X-Platform-Tier-Downgraded   ← 用户请求 tier 越权时降到的实际 tier
//   X-Platform-Fallback-From     ← 真发生 upstream fallback 时记原家
async function handleLlmChat(request, env, ctx) {
  const auth = await requireAuth(request, env);
  if (!auth.ok) return auth.response;

  // 39th 续³ · Phase 5 加固 · KV strict guard（生产 fail-closed 防限速失效）
  const kvGuard = assertRateLimitKvAvailable(env, "handleLlmChat");
  if (kvGuard) return kvGuard;

  const summary = await loadUserLicenseSummary(env, auth.userId);
  const plan = derivePlanForLlm(summary);

  let body;
  try {
    body = await request.json();
  } catch (_) {
    return jsonResponse({ ok: false, error: "请求体不是有效 JSON" }, 400);
  }
  if (!body || !Array.isArray(body.messages) || body.messages.length === 0) {
    return jsonResponse({ ok: false, error: "messages 字段必填且不能为空数组" }, 400);
  }
  // 39th 续³ · Phase 5 加固 · 请求体大小硬限（防 100MB DoS）
  const sizeError = validateLlmBodySize(request, body);
  if (sizeError) return sizeError;

  // 1. tier 解析 + 越权降级
  const { tier, downgraded } = resolveTierForUser(plan, body.tier);
  const { upstream, model } = selectUpstreamForTier(tier);

  // 2. 限流预检（每分钟 RPM）
  const rpm = PLAN_RPM[plan] || PLAN_RPM.free;
  const rl = await checkAndBumpRateLimit(env, auth.userId, rpm);
  if (!rl.ok) {
    ctx.waitUntil(
      recordAudit(env, {
        user_id: auth.userId,
        ts: Date.now(),
        model,
        tier,
        upstream,
        status: "rate_limited",
        error_code: "rpm_exceeded"
      })
    );
    return jsonResponse(
      {
        ok: false,
        error: "请求过于频繁，请稍后再试",
        reason: "rate_limited",
        retry_after_ms: rl.retryAfterMs
      },
      429
    );
  }

  // 3. 配额预检（月度 token / call_count）
  const yyyymm = currentYyyymm();
  const usageRow = await env.DB.prepare(
    "SELECT prompt_tokens, completion_tokens, call_count FROM llm_usage WHERE user_id = ? AND yyyymm = ?"
  )
    .bind(auth.userId, yyyymm)
    .first();
  const quota = checkQuota(plan, usageRow || {});
  if (!quota.ok) {
    ctx.waitUntil(
      recordAudit(env, {
        user_id: auth.userId,
        ts: Date.now(),
        model,
        tier,
        upstream,
        status: "quota_exceeded",
        error_code: quota.reason
      })
    );
    return jsonResponse(
      {
        ok: false,
        error: "本月平台 LLM 额度已用完",
        reason: quota.reason || "quota_exceeded",
        plan,
        limit: quota.limit,
        used: quota.used,
        resets_at: new Date(nextResetMs()).toISOString()
      },
      402
    );
  }

  // 4. 上游 fetch（带降级链）
  const result = await callUpstreamWithFallback({ env, upstream, model, body });

  // 5. 解析 token 用量
  const usage = result.body?.usage || {};
  const promptTokens = Number(usage.prompt_tokens || 0);
  const completionTokens = Number(usage.completion_tokens || 0);

  // 6. audit 一定写（哪怕失败 — 错误率监控用）
  ctx.waitUntil(
    recordAudit(env, {
      user_id: auth.userId,
      ts: Date.now(),
      model: result.actualModel || model,
      tier,
      upstream: result.actualUpstream || upstream,
      prompt_tokens: promptTokens,
      completion_tokens: completionTokens,
      duration_ms: result.durationMs,
      status: result.ok ? "ok" : "error",
      error_code: result.errorCode,
      fallback_from: result.fallbackFrom
    })
  );

  // 7. 计量只在成功 + 有 token 数时扣（失败白扣不公平）
  if (result.ok && (promptTokens > 0 || completionTokens > 0)) {
    ctx.waitUntil(
      recordUsage(env, {
        userId: auth.userId,
        yyyymm,
        promptTokens,
        completionTokens
      })
    );
    // 39th 续 · Phase 4.3 · token 暴涨软告警（audit_log warn 条，不阻塞）
    ctx.waitUntil(
      detectAndLogTokenSpike(env, auth.userId, plan, promptTokens + completionTokens)
    );
  }

  // 8. 透传上游响应；扩展端 ai.js 期待 OpenAI-compatible JSON
  const response = jsonResponse(
    result.body || { ok: false, error: "上游无响应", error_code: result.errorCode || "no_body" },
    result.status || 502
  );
  if (downgraded) response.headers.set("X-Platform-Tier-Downgraded", tier);
  if (result.fallbackFrom) {
    response.headers.set("X-Platform-Fallback-From", result.fallbackFrom);
  }
  return response;
}

// ============================================================
// /api/llm/stream 平台 LLM 代理 · SSE 流式响应（39th 续 · Phase 3）
// ============================================================
// 与 /api/llm/chat 同样的 auth + 限流 + 配额前置检查；通过后转发上游 stream:true 响应。
//
// 与 chat 路径关键差异：
//   - 不做 fallback（流式中途切换 upstream 复杂度极高，半途响应已写入客户端不可回滚）；
//     上游错误直接透传 4xx/5xx
//   - 计量发生在 stream 末尾——上游最后一个 SSE event 携 usage 字段
//     （需 stream_options.include_usage:true，由 streamUpstream 强制注入）
//   - 使用 TransformStream 边转发边解析，flush() 时写 D1
//
// 客户端期望使用 ReadableStream + TextDecoder 增量消费，参考 src/shared/ai.js
// requestRewriteViaPlatformStreaming 实现。
async function handleLlmStream(request, env, ctx) {
  const auth = await requireAuth(request, env);
  if (!auth.ok) return auth.response;

  // 39th 续³ · Phase 5 加固 · KV strict guard（生产 fail-closed 防限速失效）
  const kvGuard = assertRateLimitKvAvailable(env, "handleLlmStream");
  if (kvGuard) return kvGuard;

  const summary = await loadUserLicenseSummary(env, auth.userId);
  const plan = derivePlanForLlm(summary);

  let body;
  try {
    body = await request.json();
  } catch (_) {
    return jsonResponse({ ok: false, error: "请求体不是有效 JSON" }, 400);
  }
  if (!body || !Array.isArray(body.messages) || body.messages.length === 0) {
    return jsonResponse({ ok: false, error: "messages 字段必填且不能为空数组" }, 400);
  }
  // 39th 续³ · Phase 5 加固 · 请求体大小硬限（防 100MB DoS）
  const sizeError = validateLlmBodySize(request, body);
  if (sizeError) return sizeError;

  const { tier, downgraded } = resolveTierForUser(plan, body.tier);
  const { upstream, model } = selectUpstreamForTier(tier);

  // 限流
  const rpm = PLAN_RPM[plan] || PLAN_RPM.free;
  const rl = await checkAndBumpRateLimit(env, auth.userId, rpm);
  if (!rl.ok) {
    ctx.waitUntil(
      recordAudit(env, {
        user_id: auth.userId,
        ts: Date.now(),
        model,
        tier,
        upstream,
        status: "rate_limited",
        error_code: "rpm_exceeded"
      })
    );
    return jsonResponse(
      {
        ok: false,
        error: "请求过于频繁，请稍后再试",
        reason: "rate_limited",
        retry_after_ms: rl.retryAfterMs
      },
      429
    );
  }

  // 配额预检
  const yyyymm = currentYyyymm();
  const usageRow = await env.DB.prepare(
    "SELECT prompt_tokens, completion_tokens, call_count FROM llm_usage WHERE user_id = ? AND yyyymm = ?"
  )
    .bind(auth.userId, yyyymm)
    .first();
  const quota = checkQuota(plan, usageRow || {});
  if (!quota.ok) {
    ctx.waitUntil(
      recordAudit(env, {
        user_id: auth.userId,
        ts: Date.now(),
        model,
        tier,
        upstream,
        status: "quota_exceeded",
        error_code: quota.reason
      })
    );
    return jsonResponse(
      {
        ok: false,
        error: "本月平台 LLM 额度已用完",
        reason: quota.reason || "quota_exceeded",
        plan,
        limit: quota.limit,
        used: quota.used,
        resets_at: new Date(nextResetMs()).toISOString()
      },
      402
    );
  }

  // 调上游（不带 fallback，stream 模式不支持 fallback）
  const result = await streamUpstream({ env, upstream, model, body });
  if (!result.ok) {
    ctx.waitUntil(
      recordAudit(env, {
        user_id: auth.userId,
        ts: Date.now(),
        model,
        tier,
        upstream,
        status: "error",
        error_code: result.errorCode
      })
    );
    if (result.upstreamResponse) {
      // 透传上游错误响应（不流式）
      const headers = new Headers({ "Content-Type": "application/json; charset=utf-8" });
      const errBody = await result.upstreamResponse.text().catch(() => "");
      return new Response(errBody || JSON.stringify({ ok: false, error_code: result.errorCode }), {
        status: result.status,
        headers
      });
    }
    return jsonResponse(
      { ok: false, error: "平台 AI 暂不可用", error_code: result.errorCode },
      result.status || 503
    );
  }

  // ---- TransformStream 边转发边解析最后的 usage 写 D1 ----
  let parseBuffer = "";
  let finalUsage = null;
  const decoder = new TextDecoder();
  const startMs = Date.now();

  const ts = new TransformStream({
    transform(chunk, controller) {
      controller.enqueue(chunk); // 立即透传给客户端
      try {
        parseBuffer += decoder.decode(chunk, { stream: true });
        // SSE 协议：events 用 \n\n 分隔，每个 event 形如 "data: {json}\n"
        const events = parseBuffer.split("\n\n");
        parseBuffer = events.pop() || "";
        for (const ev of events) {
          for (const line of ev.split("\n")) {
            if (!line.startsWith("data:")) continue;
            const data = line.slice(5).trim();
            if (!data || data === "[DONE]") continue;
            try {
              const json = JSON.parse(data);
              if (json && json.usage) {
                finalUsage = json.usage; // OpenAI 格式 stream_options.include_usage 末尾事件
              }
            } catch {
              // 忽略解析失败的事件，继续转发
            }
          }
        }
      } catch (err) {
        console.warn("[llm/stream] parse error", err?.message);
      }
    },
    flush() {
      const promptTokens = Number(finalUsage?.prompt_tokens || 0);
      const completionTokens = Number(finalUsage?.completion_tokens || 0);
      const durationMs = Date.now() - startMs;

      ctx.waitUntil(
        recordAudit(env, {
          user_id: auth.userId,
          ts: Date.now(),
          model,
          tier,
          upstream,
          prompt_tokens: promptTokens,
          completion_tokens: completionTokens,
          duration_ms: durationMs,
          status: "ok",
          error_code: null
        })
      );
      if (promptTokens > 0 || completionTokens > 0) {
        ctx.waitUntil(
          recordUsage(env, {
            userId: auth.userId,
            yyyymm,
            promptTokens,
            completionTokens
          })
        );
        // 39th 续 · Phase 4.3 · 流式路径同样接 token 暴涨软告警
        ctx.waitUntil(
          detectAndLogTokenSpike(env, auth.userId, plan, promptTokens + completionTokens)
        );
      }
    }
  });

  result.upstreamResponse.body.pipeTo(ts.writable).catch((err) => {
    console.warn("[llm/stream] pipe error", err?.message);
  });

  const headers = new Headers({
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no" // 防 proxy 缓冲（Nginx 等）
  });
  if (downgraded) headers.set("X-Platform-Tier-Downgraded", tier);

  return new Response(ts.readable, { status: 200, headers });
}

// ============================================================
// /api/llm/usage 月度用量进度查询
// ============================================================
// 给扩展端 popup / options 进度条用。返回 plan + 当月 used + limit + remaining + resets_at。
async function handleLlmUsage(request, env) {
  const auth = await requireAuth(request, env);
  if (!auth.ok) return auth.response;

  const summary = await loadUserLicenseSummary(env, auth.userId);
  const plan = derivePlanForLlm(summary);
  const yyyymm = currentYyyymm();
  const usageRow = await env.DB.prepare(
    "SELECT prompt_tokens, completion_tokens, call_count, last_call_at FROM llm_usage WHERE user_id = ? AND yyyymm = ?"
  )
    .bind(auth.userId, yyyymm)
    .first();

  return jsonResponse({
    ok: true,
    ...formatUsageReport({ plan, usage: usageRow || {} })
  });
}

// ---------- 设备激活配额相关（39th 续 · Strategy B） ----------
/**
 * 把 license_keys.plan 映射到设备配额维度的 plan 名（free / monthly / yearly）。
 *
 * 与 derivePlanForLlm 同口径：
 *   - plan = "free" → "free"
 *   - plan = "monthly" / "yearly" → 透传（Phase 4 加入虎皮椒新 SKU 后写入此值）
 *   - plan = "pro" → "yearly"（旧 Pro 用户向后兼容，享 10 台设备配额）
 */
function devicePlanFromLicenseRow(row) {
  if (!row) return "free";
  const p = row.plan;
  if (p === "monthly" || p === "yearly") return p;
  if (p === "pro") return "yearly";
  return "free";
}

/**
 * 把完整 User-Agent 浓缩成"浏览器+主版本号 · OS"粗粒度提示。
 *
 * 隐私设计：不存完整 UA（避免 cross-site fingerprinting + 满足 docuearn.com privacy.html
 * 「不收集追踪信号」的承诺），只存够用于"区分这是同一台设备的多次重置 vs 真的不同设备"
 * 的最小信息。同浏览器同 OS 不同 device_fingerprint 大概率是 chrome.storage 被清空过。
 *
 * 输出最长 80 字符，常见结果：
 *   "Chrome 147 · macOS 10.15.7"
 *   "Edg 146 · Windows NT 10.0"
 *   "Firefox 132 · Linux"
 */
function summarizeUserAgent(ua) {
  if (!ua) return "";
  // 顺序：Edge / Edg 优先（避免被 Chrome 正则吞掉）；Firefox/Opera/OPR 也优先于 Chrome；
  //       Safari 最后（很多浏览器 UA 末尾都带 "Safari/537.36" 误命中）
  const browserMatch = ua.match(/(Edge?|Firefox|OPR|Opera|Chrome|Safari)\/(\d+)/i);
  const osMatch = ua.match(/(Windows NT [\d.]+|Mac OS X [\d_.]+|iPhone OS [\d_]+|Android [\d.]+|Linux)/i);
  const browser = browserMatch ? `${browserMatch[1]} ${browserMatch[2]}` : "Unknown";
  const os = osMatch
    ? osMatch[1].replace(/Mac OS X /, "macOS ").replace(/_/g, ".")
    : "Unknown OS";
  return `${browser} · ${os}`.slice(0, 80);
}

/**
 * Cron 每小时跑一次：删 last_seen_at > 90 天的 device_activations 行。
 *
 * 这是 cleanup 不是 enforcement——目的是：
 *   ① 让用户的"已激活设备列表"不被陈年清装系统的 orphan fingerprint 污染；
 *   ② 让 Strategy B 的 device_limit 配额不被 stale 设备占满；
 *   ③ 减小 D1 表行数（device_activations 是少数写入频次较高的表）。
 *
 * 不处理 device_fingerprint = ""（不存在）的行；DELETE 是直接物理删（不软删），
 * 用户重新连上同设备时 worker.handleLicenseVerify INSERT 会自动重建（保留原 device_label
 * 输入，只是 activated_at 是新值）。
 */
async function pruneStaleDeviceActivations(env) {
  if (!env.DB) {
    console.warn("[cron] pruneStaleDeviceActivations skip: D1 binding missing");
    return;
  }
  try {
    const cutoff = Date.now() - STALE_DEVICE_PRUNE_DAYS * 86_400_000;
    const result = await env.DB.prepare(
      "DELETE FROM device_activations WHERE last_seen_at < ?"
    )
      .bind(cutoff)
      .run();
    const n = Number(result?.meta?.changes) || 0;
    if (n > 0) {
      console.log(`[cron] pruneStaleDeviceActivations: deleted ${n} rows older than ${STALE_DEVICE_PRUNE_DAYS} days`);
    }
  } catch (error) {
    console.error("[cron] pruneStaleDeviceActivations failed", error?.message || error);
  }
}

// ============================================================
// /api/license/device/prune  ← dashboard 一键清理 N 天未活跃
// body: { key, days? }（days 默认 30，clamp 到 [7, 365]）
// 返回: { ok, deleted, days, key }
// ============================================================
async function handleLicenseDevicePrune(request, env) {
  const auth = await requireAuth(request, env);
  if (!auth.ok) return auth.response;

  const body = await readJson(request);
  const key = normalizeLicenseKey(body.key);
  if (!key) {
    return jsonResponse({ ok: false, error: "缺少 License Key" }, 400);
  }

  // 必须确认这把 license 属于当前用户（防越权清别人的设备）
  const owner = await env.DB.prepare(
    "SELECT key FROM license_keys WHERE key = ? AND user_id = ?"
  )
    .bind(key, auth.userId)
    .first();
  if (!owner) {
    return jsonResponse({ ok: false, error: "无权操作此 License" }, 403);
  }

  const rawDays = Number(body.days);
  const days = Number.isFinite(rawDays) ? Math.min(Math.max(rawDays, 7), 365) : 30;
  const cutoff = Date.now() - days * 86_400_000;

  const result = await env.DB.prepare(
    "DELETE FROM device_activations WHERE license_key = ? AND last_seen_at < ?"
  )
    .bind(key, cutoff)
    .run();

  return jsonResponse({
    ok: true,
    key,
    days,
    deleted: Number(result?.meta?.changes) || 0
  });
}

// 39th 续³ · Phase 5 加固 · LLM 请求体大小校验（防 100MB DoS）
// 三层兜底：Content-Length header → messages 数组长度 → 单条 content 字符
// 校验失败返 jsonResponse；通过返 null 让调用方继续。
// 调用方：handleLlmChat / handleLlmStream 入口（auth 后、tier 解析前）。
function validateLlmBodySize(request, body) {
  const contentLength = Number(request.headers.get("Content-Length") || 0);
  if (contentLength > LLM_MAX_BODY_BYTES) {
    return jsonResponse(
      {
        ok: false,
        error: `请求体过大（${contentLength} 字节，上限 ${LLM_MAX_BODY_BYTES} 字节）`,
        reason: "body_too_large",
        limit_bytes: LLM_MAX_BODY_BYTES
      },
      413
    );
  }
  if (!Array.isArray(body?.messages)) return null; // 由调用方 messages 必填校验处理
  if (body.messages.length > LLM_MAX_MESSAGES) {
    return jsonResponse(
      {
        ok: false,
        error: `messages 超过 ${LLM_MAX_MESSAGES} 条上限（当前 ${body.messages.length}）`,
        reason: "too_many_messages",
        limit: LLM_MAX_MESSAGES
      },
      400
    );
  }
  for (let i = 0; i < body.messages.length; i++) {
    const msg = body.messages[i];
    const content = typeof msg?.content === "string" ? msg.content : "";
    if (content.length > LLM_MAX_MESSAGE_CHARS) {
      return jsonResponse(
        {
          ok: false,
          error: `messages[${i}].content 超过 ${LLM_MAX_MESSAGE_CHARS} 字符上限（当前 ${content.length}）`,
          reason: "message_too_long",
          limit_chars: LLM_MAX_MESSAGE_CHARS,
          index: i
        },
        400
      );
    }
  }
  return null;
}

// 39th 续³ · Phase 5 加固 · KV 缺失 strict guard（生产 fail-closed）
// 调用方：handleRegister / handleGoogleAuth / handleLicenseVerify / handleLlmChat / handleLlmStream
// 命中时返 jsonResponse 503 + console.error；通过返 null
function assertRateLimitKvAvailable(env, contextLabel) {
  if (env.RATE_LIMIT_KV) return null;
  const isStrict = env[STRICT_RATE_LIMIT_ENV] === "1";
  if (!isStrict) {
    console.warn(`[strict-kv] ${contextLabel}: RATE_LIMIT_KV missing but STRICT_RATE_LIMIT not set; fail-open (dev mode)`);
    return null;
  }
  console.error(`[strict-kv] CRITICAL: RATE_LIMIT_KV missing in production (${contextLabel}) — refusing request`);
  return jsonResponse(
    {
      ok: false,
      error: "服务暂不可用：限速服务未配置（管理员请检查 KV binding）",
      reason: "kv_missing"
    },
    503
  );
}

// 39th 续 · Phase 4.3 · 检测并记录 token 暴涨（audit_log 软告警，不阻塞调用）
//
// 工作原理：
//   - KV bucket 按 (userId, 5min epoch) 分；每次 recordUsage 后累加本次的 token 总数
//   - 累计值首次超过阈值时写一条 llm_audit_log 行 status="suspicious_spike"
//     error_code 字段记入 "{plan}_{cumulative}_{threshold}" 让运维 grep 出真凶
//   - 同一 5 分钟窗口内只触发一次告警（KV 标记 spike_logged:1），避免 audit_log 暴涨
//   - failed-silent：KV / D1 任何写失败都吞掉，不阻塞主链路（防滥用是 nice-to-have observability）
//
// 39th 续³ Phase 5 加固 · 已知 race condition（注释挑明 trade-off）：
//   - KV 没有原子 INCR，sum 累计走 `get + put` 双步，并发请求间窗口内可丢更新
//   - 实测影响：5min 窗口内并发 N 个请求 → 累计值可能低估 ~10%（少计 1-2 个 token 数）
//   - 为什么可接受：① token spike 阈值远超平均（7 倍 spike 才告警），少计 30% 也不影响
//     告警触发；② 软告警语义（不阻塞调用、不通知用户、运维 grep）允许 ±10% 误差
//   - 为什么不修：① KV INCR 不存在；② 改 D1 行级锁会让每次 recordUsage 多 1 次 D1 写
//     拖累 LLM 调用主链路；③ 真打掉攻击者的是配额硬卡（checkQuota），spike 告警仅为观察
//   - 若未来要严格计数（合规审计场景），用 D1 表 + COMMIT 事务替代 KV
//
// 调用方：handleLlmChat 成功路径 + handleLlmStream flush（统一计入流式调用）
export async function detectAndLogTokenSpike(env, userId, plan, tokensThisCall) {
  if (!env.RATE_LIMIT_KV || !env.DB) return;
  const total = Number(tokensThisCall) || 0;
  if (total <= 0) return;
  try {
    const fiveMinEpoch = Math.floor(Date.now() / 300_000);
    const sumKey = `token_spike:sum:${userId}:${fiveMinEpoch}`;
    const flagKey = `token_spike:flag:${userId}:${fiveMinEpoch}`;
    const stored = await env.RATE_LIMIT_KV.get(sumKey);
    const cumulative = (Number(stored) || 0) + total;
    await env.RATE_LIMIT_KV.put(sumKey, String(cumulative), { expirationTtl: 600 });

    const threshold = TOKEN_SPIKE_THRESHOLDS[plan] || TOKEN_SPIKE_THRESHOLDS.free;
    if (cumulative <= threshold) return;

    // 撞阈值：检查是否已经为本窗口写过告警
    const alreadyFlagged = await env.RATE_LIMIT_KV.get(flagKey);
    if (alreadyFlagged) return;
    await env.RATE_LIMIT_KV.put(flagKey, "1", { expirationTtl: 600 });

    // 写 audit_log 软告警条（运维可 grep）
    await env.DB.prepare(
      `INSERT INTO llm_audit_log
         (user_id, ts, model, tier, upstream, prompt_tokens, completion_tokens, status, error_code)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
      .bind(
        userId,
        Date.now(),
        null,
        null,
        null,
        0,
        0,
        "suspicious_spike",
        `${plan}_5min_${cumulative}_threshold_${threshold}`
      )
      .run();

    // 39th 续 · 给用户发安全告警邮件（节流：每类型每日 1 封，KV 把控）
    await sendSecurityAlertEmail(env, {
      userId,
      type: "token_spike",
      details: { plan, cumulative, threshold }
    });
  } catch (err) {
    console.warn("[abuse] detectAndLogTokenSpike failed", err?.message || err);
  }
}

// 39th 续 · Phase 4.4 · 检测并记录 license 跨设备并发突发（verify_log 软告警，不阻塞）
//
// 工作原理：
//   - KV bucket 按 (license_key, 5min epoch) 分；每次 verify 成功后 sha256 fingerprint 加入 set
//     （JSON 数组 + 去重；hash 而非明文 fingerprint，KV 不存可逆设备身份）
//   - 同一 5 分钟窗口内 distinct fingerprint 数超过阈值（deviceLimit + 2）→ verify_log 写 multi_device_burst
//   - 同一窗口内只触发一次告警（KV 标记 burst_logged:1，避免每次 verify 都写日志）
//   - failed-silent：KV / D1 任一写失败都吞掉，不阻塞主链路
//
// 39th 续³ Phase 5 加固 · 已知 race condition（注释挑明）：
//   - set 并发 `get + JSON.parse + push + JSON.stringify + put` 多步非原子
//   - 5min 窗口内若 N 个 verify 同时发起，可能丢失 1-2 个 fingerprint（B 读到 null 用 [] 起步，
//     而 A 已 put 了 [a]；最终 B put [b] 覆盖 → set 实际只剩 [b]）
//   - 实测影响：阈值附近偶发漏告警（实际 13 fingerprint 但 set 长度看到 11）
//   - 为什么可接受：① "license 卖给多人同时用"是持续性场景，下个 5min 窗口仍会撞，最终告警
//     触发只是延迟一两个窗口；② 软告警不阻塞用户；③ device_limit 硬卡已挡 license 总数
//
// 与 Phase 2.7 device_limit 区别：
//   - device_limit 是总数硬卡（INSERT 时 count >= limit 直接 403）
//   - multi_device_burst 是并发软告警（5 分钟内 distinct fingerprints 异常突发）
//   - 两者目标不同：limit 防"狂加 100 台设备"；burst 防"license 被卖给多人同时用"
//
// 调用方：handleLicenseVerify 成功路径（writeVerifyLog "ok" 之后）
// userId 入参用于撞顶时自动给用户发安全告警邮件（节流后台 KV 把控）
export async function detectAndLogMultiDeviceBurst(env, licenseKey, userId, fingerprint, plan, ip, ua) {
  if (!env.RATE_LIMIT_KV || !env.DB || !fingerprint || !licenseKey) return;
  try {
    const fingerprintHash = await sha256Hex(fingerprint);
    const fpShort = fingerprintHash.slice(0, 12); // 12 字符已够分辨同 5min 内 N 设备
    const fiveMinEpoch = Math.floor(Date.now() / 300_000);
    const setKey = `concurrent_dev:set:${licenseKey}:${fiveMinEpoch}`;
    const flagKey = `concurrent_dev:flag:${licenseKey}:${fiveMinEpoch}`;

    const stored = await env.RATE_LIMIT_KV.get(setKey);
    let set;
    try {
      set = stored ? JSON.parse(stored) : [];
    } catch {
      set = [];
    }
    if (!Array.isArray(set)) set = [];
    if (!set.includes(fpShort)) {
      set.push(fpShort);
      // 卡 set 长度避免 KV value 暴涨（极端情况下若有人 1000 个 fingerprint 全打过来）
      if (set.length > 50) set.length = 50;
      await env.RATE_LIMIT_KV.put(setKey, JSON.stringify(set), { expirationTtl: 600 });
    }

    const threshold = deviceConcurrentThreshold(plan);
    if (set.length <= threshold) return;

    // 撞阈值：检查窗口内是否已经写过告警
    const alreadyFlagged = await env.RATE_LIMIT_KV.get(flagKey);
    if (alreadyFlagged) return;
    await env.RATE_LIMIT_KV.put(flagKey, "1", { expirationTtl: 600 });

    // 写 verify_log 软告警条；result="multi_device_burst" 让运维 grep 出真凶
    await env.DB.prepare(
      `INSERT INTO verify_log (license_key, ip, user_agent, result, detail, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`
    )
      .bind(
        licenseKey,
        ip || "unknown",
        (ua || "").slice(0, 256),
        "multi_device_burst",
        `plan=${plan} uniques=${set.length} threshold=${threshold} window=5min`.slice(0, 256),
        Date.now()
      )
      .run();

    // 39th 续 · 给 license 持有者发安全告警邮件（userId 可能为空——未绑定 license）
    if (userId) {
      await sendSecurityAlertEmail(env, {
        userId,
        type: "multi_device_burst",
        details: {
          plan,
          uniques: set.length,
          threshold,
          licenseKey
        }
      });
    }
  } catch (err) {
    console.warn("[abuse] detectAndLogMultiDeviceBurst failed", err?.message || err);
  }
}

// ---------- license_keys.plan → LLM 服务的 plan 映射 ----------
// 当前 license_keys.plan 只有 "free" / "pro" 两值；plan 文件目标三档 free/monthly/yearly。
// Phase 4 加入虎皮椒月费 SKU 后，license_keys.plan 会直接写 "monthly" / "yearly"（透传）。
// 当前过渡期：
//   - 无 active license → "free"
//   - plan = "monthly" / "yearly" → 透传（前向兼容）
//   - plan = "pro" → "yearly"（旧 Pro 用户向后兼容，plan 文件 "## 风险/不做的事" 段）
//   - 其他 → "free"
// 唯一入口：handleLlmChat / handleLlmUsage 都走此函数确定额度档位。
function derivePlanForLlm(licenseSummary) {
  if (!licenseSummary?.activeKey) return "free";
  const p = licenseSummary.plan;
  if (p === "monthly" || p === "yearly") return p;
  if (p === "pro") return "yearly";
  return "free";
}

/* ---------------------- 共用签发函数（hupijiao + 未来其他通道） ---------------------- */
/**
 * 给指定用户签发 / 续期一张 Pro license。
 * - 强制 365d 上限（虎皮椒协议 3.12）
 * - 如果该用户已有 active 的 hupijiao license 且未到期，直接在原 key 上叠加 days
 * - 否则新生成一张
 *
 * 39th 续 · planCode 参数（"monthly" / "yearly" / 缺省）：
 *   - 缺省 → "pro"（向后兼容旧 SKU 与 Lemon Squeezy 通道）
 *   - "monthly" / "yearly" → 写入 license_keys.plan，让 derivePlanForLlm / devicePlanFromLicenseRow
 *     直接区分两档（5M vs 20M token / 3 vs 10 设备）
 *   - 续期时只升档不降档：现有 yearly 续费时买月费不会降级（保留 yearly 直到自然到期）
 */
async function issueProLicense(env, { userId, userEmail, source, sourceOrderId, days, planCode }) {
  const ONE_YEAR_MS = 365 * 24 * 60 * 60 * 1000;
  const now = Date.now();
  const addMs = Math.min(Math.max(Number(days) || 0, 1), 365) * 24 * 60 * 60 * 1000;
  // SKU 映射 · 仅认 monthly / yearly，其他兜底 'pro'（向后兼容）
  const newPlan = planCode === "monthly" || planCode === "yearly" ? planCode : "pro";

  // 找该用户最新一张同 source 的 active license
  const existing = await env.DB.prepare(
    `SELECT key, plan, expires_at FROM license_keys
      WHERE user_id = ? AND source = ? AND status = 'active'
      ORDER BY updated_at DESC LIMIT 1`
  )
    .bind(userId, source)
    .first();

  let key;
  if (existing) {
    key = existing.key;
    const base = Math.max(Number(existing.expires_at) || now, now);
    const newExpires = Math.min(base + addMs, now + ONE_YEAR_MS);
    // 只升档不降档：避免 yearly 用户买月费时被错误降级到 monthly
    const finalPlan =
      (PLAN_RANK[newPlan] || 0) > (PLAN_RANK[existing.plan] || 0)
        ? newPlan
        : existing.plan;
    await env.DB.prepare(
      `UPDATE license_keys
          SET plan = ?, expires_at = ?, ls_order_id = ?, ls_customer_email = ?, updated_at = ?
        WHERE key = ?`
    )
      .bind(finalPlan, newExpires, sourceOrderId, userEmail, now, key)
      .run();
  } else {
    key = await generateLicenseKey(env);
    const expiresAt = Math.min(now + addMs, now + ONE_YEAR_MS);
    await env.DB.prepare(
      `INSERT INTO license_keys
          (key, user_id, plan, status, expires_at,
           ls_order_id, ls_subscription_id, ls_customer_email,
           source, created_at, updated_at)
        VALUES (?, ?, ?, 'active', ?, ?, '', ?, ?, ?, ?)`
    )
      .bind(key, userId, newPlan, expiresAt, sourceOrderId, userEmail, source, now, now)
      .run();
  }
  return { key };
}

/* ---------------------- 调虎皮椒下单 ---------------------- */
async function createHupijiaoOrder(env, { tradeOrderId, totalFee, title, notifyUrl, returnUrl }) {
  const params = {
    version: "1.1",
    appid: env.HUPIJIAO_APP_ID,
    trade_order_id: tradeOrderId,
    total_fee: Number(totalFee).toFixed(2),
    title,
    time: Math.floor(Date.now() / 1000).toString(),
    notify_url: notifyUrl,
    return_url: returnUrl,
    nonce_str: randomToken(8).replace(/[^a-zA-Z0-9]/g, "").slice(0, 16) || "n" + Date.now(),
    plugins: "docuearn-worker"
  };
  params.hash = await signHupijiao(params, env.HUPIJIAO_APP_SECRET);

  const apiUrl = env.HUPIJIAO_API_URL || "https://api.xunhupay.com/payment/do.html";
  console.log("[hpj] POST", apiUrl, "params:", JSON.stringify({ ...params, hash: params.hash.slice(0, 6) + "..." }));
  const resp = await fetch(apiUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(params)
  });
  const text = await resp.text();
  console.log("[hpj] response", resp.status, "body:", text.slice(0, 500));
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    throw new Error("虎皮椒返回非 JSON：" + text.slice(0, 120));
  }
  return json;
}

/* ---------------------- 退款主动同步 Cron 任务 ---------------------- */
/**
 * 反查虎皮椒后台订单状态，把"用户在虎皮椒后台已退款但 notify webhook 漏发"
 * 的订单同步回 D1。每小时由 scheduled handler 触发。
 *
 * 为什么需要：notify webhook 是"推"模型，CF Worker 出口异常 / 重试上限耗尽
 * / 虎皮椒侧 bug 都会导致 D1 与虎皮椒后台不一致。表现为：用户在虎皮椒后台
 * 已退款，但 dashboard / license 仍按 paid 显示，运维只能跑手工 SQL 同步。
 * 这条 cron 把那条手工 SQL 自动化掉。
 *
 * 安全约束：
 *   - 单次最多查 50 条（D1 写限速 + Cron 单次执行 ≤ 30s）
 *   - 仅查 90 天内 paid 订单（更老的订单退款窗口已关）
 *   - 任意单条失败只 log 不抛，不影响其他订单
 *   - 退款时只更新 orders.status='refunded' + notify_payload，
 *     **不**自动 revoke license_keys（Pro 权益的 expires_at 通常已签到云端，
 *     强行撤销可能误伤已用部分；保留运维手工 deactivate 的余地）
 *
 * 虎皮椒 query API 字段说明（与 do.html 同款签名规则）：
 *   POST https://api.xunhupay.com/payment/query.html
 *   { appid, time, nonce_str, out_trade_order, hash }
 *   响应 JSON 含 status: "OD"(已支付) / "WP"(待支付) / "CD"(关闭) /
 *                     "RD"(退款中) / "UD"(退款失败) 等。
 *   实际字段名以虎皮椒最新文档为准；首次部署若返回 "errcode≠0" 请按
 *   虎皮椒后台 → 接口文档 校准 out_trade_order 参数名。
 */
async function syncHupijiaoRefunds(env) {
  if (!env.DB) {
    console.warn("[cron] syncHupijiaoRefunds skip: D1 binding missing");
    return;
  }
  if (!env.HUPIJIAO_APP_ID || !env.HUPIJIAO_APP_SECRET) {
    console.warn("[cron] syncHupijiaoRefunds skip: HUPIJIAO_* env missing");
    return;
  }

  const NINETY_DAYS_MS = 90 * 24 * 60 * 60 * 1000;
  const cutoff = Date.now() - NINETY_DAYS_MS;
  let rows;
  try {
    const result = await env.DB.prepare(
      `SELECT trade_order_id, user_email
         FROM orders
        WHERE source = 'hupijiao'
          AND status = 'paid'
          AND paid_at >= ?
        ORDER BY paid_at DESC
        LIMIT 50`
    )
      .bind(cutoff)
      .all();
    rows = result?.results || [];
  } catch (err) {
    console.error("[cron] hpj refund sync: D1 select failed", err?.message || err);
    return;
  }

  if (rows.length === 0) {
    console.log("[cron] hpj refund sync: nothing to check");
    return;
  }

  console.log(`[cron] hpj refund sync: checking ${rows.length} paid orders`);

  let refundedCount = 0;
  let errorCount = 0;
  for (const row of rows) {
    try {
      const remoteStatus = await queryHupijiaoOrderStatus(
        env,
        row.trade_order_id
      );
      // CD 关闭 / RD 退款中 / UD 退款失败 都视为"用户曾发起退款"，
      // 与 handleHupijiaoNotify 的判定一致；这里保守取 RD / UD（CD 可能是
      // 用户主动取消未支付的订单 —— 但 paid 订单的 CD 也可能意味着退款关闭）。
      if (
        remoteStatus.kind === "refunded" ||
        remoteStatus.kind === "refunding" ||
        remoteStatus.kind === "refund_failed"
      ) {
        await env.DB.prepare(
          `UPDATE orders
              SET status = 'refunded',
                  notify_payload = ?
            WHERE trade_order_id = ? AND status = 'paid'`
        )
          .bind(
            JSON.stringify({
              source: "cron-refund-sync",
              checkedAt: Date.now(),
              remoteStatus: remoteStatus.raw
            }),
            row.trade_order_id
          )
          .run();
        refundedCount += 1;
        console.log(
          `[cron] hpj refund sync: ${row.trade_order_id} → refunded (${remoteStatus.kind})`
        );
      }
    } catch (err) {
      errorCount += 1;
      console.error(
        `[cron] hpj refund sync: query ${row.trade_order_id} failed`,
        err?.message || err
      );
    }
  }

  console.log(
    `[cron] hpj refund sync done: refunded=${refundedCount} errors=${errorCount} total=${rows.length}`
  );
}

/**
 * 查询单笔虎皮椒订单状态。返回归一化的 { kind, raw }：
 *   kind: "paid" | "pending" | "closed" | "refunded" | "refunding" | "refund_failed" | "unknown"
 *   raw:  虎皮椒原始响应 JSON（用于落库追溯）
 *
 * 不抛错（cron 上层希望单条失败只 log 不影响其他）—— 失败返 unknown + raw 含错误信息。
 */
async function queryHupijiaoOrderStatus(env, tradeOrderId) {
  const params = {
    appid: env.HUPIJIAO_APP_ID,
    out_trade_order: tradeOrderId,
    time: Math.floor(Date.now() / 1000).toString(),
    nonce_str:
      randomToken(8).replace(/[^a-zA-Z0-9]/g, "").slice(0, 16) || "n" + Date.now()
  };
  params.hash = await signHupijiao(params, env.HUPIJIAO_APP_SECRET);

  const queryUrl = (env.HUPIJIAO_API_URL || "https://api.xunhupay.com/payment/do.html")
    .replace(/\/payment\/do\.html$/, "/payment/query.html");

  const resp = await fetch(queryUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(params)
  });
  const text = await resp.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    return { kind: "unknown", raw: { httpStatus: resp.status, body: text.slice(0, 500) } };
  }

  // status 字段名以虎皮椒文档为准；保险起见也尝试常见别名
  const remoteStatus = String(json?.status || json?.data?.status || "").toUpperCase();
  let kind = "unknown";
  if (remoteStatus === "OD") kind = "paid";
  else if (remoteStatus === "WP") kind = "pending";
  else if (remoteStatus === "CD") kind = "closed";
  else if (remoteStatus === "RD") kind = "refunding";
  else if (remoteStatus === "UD") kind = "refund_failed";
  else if (remoteStatus === "RS" || remoteStatus === "REFUND") kind = "refunded";

  return { kind, raw: json };
}

/* ---------------------- 签名 / 验签（与虎皮椒文档一致） ---------------------- */
async function signHupijiao(params, appSecret) {
  // 1. 收集所有非空、非 hash 字段
  const keys = Object.keys(params)
    .filter((k) => k !== "hash" && params[k] !== "" && params[k] !== null && params[k] !== undefined)
    .sort();
  // 2. 按字典序拼成 key1=value1&key2=value2...
  const pairs = keys.map((k) => `${k}=${params[k]}`).join("&");
  // 3. 末尾直接拼 AppSecret（无任何分隔符），MD5（32 位小写）
  return md5Hex(pairs + (appSecret || ""));
}

/* ---------------------- 工具：trade_order_id / form 解析 ---------------------- */
function generateTradeOrderId(userId) {
  // 虎皮椒只允许数字字母 _-*；最长 32
  const userPart = String(userId || "")
    .replace(/[^a-zA-Z0-9]/g, "")
    .slice(0, 8) || "anon";
  const tsPart = Date.now().toString(36);
  const randPart = Math.random().toString(36).slice(2, 6);
  return `GZHO_${userPart}_${tsPart}_${randPart}`.slice(0, 32);
}

function parseFormUrlEncoded(text) {
  const out = {};
  if (!text) return out;
  for (const part of text.split("&")) {
    if (!part) continue;
    const eq = part.indexOf("=");
    const k = decodeURIComponent((eq >= 0 ? part.slice(0, eq) : part).replace(/\+/g, " "));
    const v = eq >= 0 ? decodeURIComponent(part.slice(eq + 1).replace(/\+/g, " ")) : "";
    out[k] = v;
  }
  return out;
}

function constantTimeEqualString(a, b) {
  if (typeof a !== "string" || typeof b !== "string") return false;
  if (a.length !== b.length) return false;
  let r = 0;
  for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
}

/* ============================================================
   MD5 纯 JS 实现 — Cloudflare Workers SubtleCrypto 不支持 MD5
   ------------------------------------------------------------
   Source: 经典 RFC 1321 实现的 UTF-8 友好压缩版（无外部依赖）
   ============================================================ */
function md5Hex(input) {
  const bytes = new TextEncoder().encode(String(input));
  const h = md5Bytes(bytes);
  return Array.from(h, (b) => b.toString(16).padStart(2, "0")).join("");
}

function md5Bytes(bytes) {
  // 预处理：补 0x80，然后补 0x00 到 (length % 64) === 56，最后追加 64-bit 长度（低位在前）
  const len = bytes.length;
  const bitLenLo = (len << 3) >>> 0;
  const bitLenHi = Math.floor(len / 0x20000000) >>> 0;
  const padLen = (len % 64 < 56 ? 56 - (len % 64) : 120 - (len % 64));
  const buf = new Uint8Array(len + padLen + 8);
  buf.set(bytes);
  buf[len] = 0x80;
  buf[buf.length - 8] = bitLenLo & 0xff;
  buf[buf.length - 7] = (bitLenLo >>> 8) & 0xff;
  buf[buf.length - 6] = (bitLenLo >>> 16) & 0xff;
  buf[buf.length - 5] = (bitLenLo >>> 24) & 0xff;
  buf[buf.length - 4] = bitLenHi & 0xff;
  buf[buf.length - 3] = (bitLenHi >>> 8) & 0xff;
  buf[buf.length - 2] = (bitLenHi >>> 16) & 0xff;
  buf[buf.length - 1] = (bitLenHi >>> 24) & 0xff;

  let a = 0x67452301, b = 0xefcdab89, c = 0x98badcfe, d = 0x10325476;
  const M = new Int32Array(16);
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  for (let off = 0; off < buf.length; off += 64) {
    for (let i = 0; i < 16; i++) M[i] = dv.getInt32(off + i * 4, true);
    let A = a, B = b, C = c, D = d;
    // Round 1
    A = ff(A,B,C,D, M[0], 7,-680876936); D = ff(D,A,B,C, M[1],12,-389564586);
    C = ff(C,D,A,B, M[2],17, 606105819); B = ff(B,C,D,A, M[3],22,-1044525330);
    A = ff(A,B,C,D, M[4], 7,-176418897); D = ff(D,A,B,C, M[5],12, 1200080426);
    C = ff(C,D,A,B, M[6],17,-1473231341); B = ff(B,C,D,A, M[7],22,-45705983);
    A = ff(A,B,C,D, M[8], 7, 1770035416); D = ff(D,A,B,C, M[9],12,-1958414417);
    C = ff(C,D,A,B, M[10],17,-42063);     B = ff(B,C,D,A, M[11],22,-1990404162);
    A = ff(A,B,C,D, M[12], 7, 1804603682); D = ff(D,A,B,C, M[13],12,-40341101);
    C = ff(C,D,A,B, M[14],17,-1502002290); B = ff(B,C,D,A, M[15],22, 1236535329);
    // Round 2
    A = gg(A,B,C,D, M[1], 5,-165796510); D = gg(D,A,B,C, M[6], 9,-1069501632);
    C = gg(C,D,A,B, M[11],14, 643717713); B = gg(B,C,D,A, M[0],20,-373897302);
    A = gg(A,B,C,D, M[5], 5,-701558691); D = gg(D,A,B,C, M[10], 9, 38016083);
    C = gg(C,D,A,B, M[15],14,-660478335); B = gg(B,C,D,A, M[4],20,-405537848);
    A = gg(A,B,C,D, M[9], 5, 568446438); D = gg(D,A,B,C, M[14], 9,-1019803690);
    C = gg(C,D,A,B, M[3],14,-187363961); B = gg(B,C,D,A, M[8],20, 1163531501);
    A = gg(A,B,C,D, M[13], 5,-1444681467); D = gg(D,A,B,C, M[2], 9,-51403784);
    C = gg(C,D,A,B, M[7],14, 1735328473); B = gg(B,C,D,A, M[12],20,-1926607734);
    // Round 3
    A = hh(A,B,C,D, M[5], 4,-378558); D = hh(D,A,B,C, M[8],11,-2022574463);
    C = hh(C,D,A,B, M[11],16, 1839030562); B = hh(B,C,D,A, M[14],23,-35309556);
    A = hh(A,B,C,D, M[1], 4,-1530992060); D = hh(D,A,B,C, M[4],11, 1272893353);
    C = hh(C,D,A,B, M[7],16,-155497632); B = hh(B,C,D,A, M[10],23,-1094730640);
    A = hh(A,B,C,D, M[13], 4, 681279174); D = hh(D,A,B,C, M[0],11,-358537222);
    C = hh(C,D,A,B, M[3],16,-722521979); B = hh(B,C,D,A, M[6],23, 76029189);
    A = hh(A,B,C,D, M[9], 4,-640364487); D = hh(D,A,B,C, M[12],11,-421815835);
    C = hh(C,D,A,B, M[15],16, 530742520); B = hh(B,C,D,A, M[2],23,-995338651);
    // Round 4
    A = ii(A,B,C,D, M[0], 6,-198630844); D = ii(D,A,B,C, M[7],10, 1126891415);
    C = ii(C,D,A,B, M[14],15,-1416354905); B = ii(B,C,D,A, M[5],21,-57434055);
    A = ii(A,B,C,D, M[12], 6, 1700485571); D = ii(D,A,B,C, M[3],10,-1894986606);
    C = ii(C,D,A,B, M[10],15,-1051523); B = ii(B,C,D,A, M[1],21,-2054922799);
    A = ii(A,B,C,D, M[8], 6, 1873313359); D = ii(D,A,B,C, M[15],10,-30611744);
    C = ii(C,D,A,B, M[6],15,-1560198380); B = ii(B,C,D,A, M[13],21, 1309151649);
    A = ii(A,B,C,D, M[4], 6,-145523070); D = ii(D,A,B,C, M[11],10,-1120210379);
    C = ii(C,D,A,B, M[2],15, 718787259); B = ii(B,C,D,A, M[9],21,-343485551);

    a = (a + A) | 0; b = (b + B) | 0; c = (c + C) | 0; d = (d + D) | 0;
  }
  const out = new Uint8Array(16);
  const dv2 = new DataView(out.buffer);
  dv2.setInt32(0, a, true);
  dv2.setInt32(4, b, true);
  dv2.setInt32(8, c, true);
  dv2.setInt32(12, d, true);
  return out;
}
function md5_add(a, b) { return (a + b) | 0; }
function md5_rol(x, n) { return ((x << n) | (x >>> (32 - n))) | 0; }
function md5_cmn(q, a, b, x, s, t) { return md5_add(md5_rol(md5_add(md5_add(a, q), md5_add(x, t)), s), b); }
function ff(a, b, c, d, x, s, t) { return md5_cmn((b & c) | (~b & d), a, b, x, s, t); }
function gg(a, b, c, d, x, s, t) { return md5_cmn((b & d) | (c & ~d), a, b, x, s, t); }
function hh(a, b, c, d, x, s, t) { return md5_cmn(b ^ c ^ d, a, b, x, s, t); }
function ii(a, b, c, d, x, s, t) { return md5_cmn(c ^ (b | ~d), a, b, x, s, t); }
