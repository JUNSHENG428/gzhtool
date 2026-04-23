/**
 * 公众号改写排版台 · Cloudflare Workers 授权服务
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
 *   1. 密码用 PBKDF2-SHA256 + 200_000 次迭代 + 16 字节随机 salt；
 *   2. JWT HS256，过期 7 天，secret 走 wrangler secret；
 *   3. /api/license/verify 用 KV 限速：同一 key + ip 每分钟 10 次；
 *   4. webhook 必须验签，且用 webhook_events 做幂等去重；
 *   5. 所有错误信息中文化，避免泄露内部结构。
 */

const PBKDF2_ITERATIONS = 200_000;
const JWT_ALG = "HS256";
const JWT_TTL_SECONDS = 60 * 60 * 24 * 7; // 7 天

// 付费功能开关清单（与插件端 src/shared/license.js 的 PAID_FEATURES 保持同步）
const PAID_FEATURE_KEYS = [
  "wechat.publish",
  "wechat.multiAccount",
  "scrape.drission",
  "hot.advancedSources",
  "ai.advancedTemplates",
  "ai.batchRewrite",
  "ai.deAiBoost",
  "ai.unlimitedDaily"
];

// 免费版每天 AI 改写次数（pro 不受限）
const FREE_DAILY_AI_QUOTA = 5;

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
  "POST /api/auth/request-reset": handleRequestReset,
  "POST /api/auth/reset": handleReset,
  "POST /api/license/bind": handleLicenseBind,
  "POST /api/license/unbind": handleLicenseUnbind,
  "POST /api/license/device/unbind": handleDeviceUnbind,
  "POST /api/license/verify": handleLicenseVerify,
  "POST /api/license/deactivate": handleLicenseDeactivate,
  "POST /api/webhook/lemon": handleLemonWebhook
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

  const existing = await env.DB.prepare(
    "SELECT id FROM users WHERE email = ?"
  )
    .bind(email)
    .first();
  if (existing) {
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
    "SELECT id, email, password_hash, password_salt FROM users WHERE email = ?"
  )
    .bind(email)
    .first();
  if (!user) {
    return jsonResponse({ ok: false, error: "邮箱或密码错误" }, 401);
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

  // 取一次 user 行（拿 created_at / last_login_at），减少前端多次往返
  const userRow = await env.DB.prepare(
    "SELECT id, email, created_at, last_login_at FROM users WHERE id = ?"
  )
    .bind(auth.userId)
    .first();
  const summary = await loadUserLicenseSummary(env, auth.userId);
  return jsonResponse({
    ok: true,
    user: {
      id: auth.userId,
      email: auth.email,
      created_at: userRow?.created_at || 0,
      last_login_at: userRow?.last_login_at || 0
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
    return jsonResponse({ ok: false, error: "旧密码不正确" }, 401);
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
  await sendResetEmail(env, user.email, resetUrl);

  const debugReturn = env.DEBUG_RESET === "1" ? { resetUrl } : {};
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
// /api/license/verify  ← 插件主调用
// body: { key, deviceFingerprint, deviceLabel? }
// 返回:
//   { ok, plan, status, expiresAt, features, dailyQuota, signature, signedAt }
//   - signature/signedAt 让插件做"离线短期信任"：插件本地记下 signedAt，
//     在 24h 内 fallback 时仍可凭 signature + 本地时间判定 pro，避免每次都联网。
// ============================================================
async function handleLicenseVerify(request, env) {
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

  // ---- 设备激活记录（不限制数量，仅做留痕） ----
  if (fingerprint) {
    const fpId = await sha256Hex(`${key}:${fingerprint}`);
    const now = Date.now();
    await env.DB.prepare(
      `INSERT INTO device_activations (id, license_key, device_fingerprint, device_label, activated_at, last_seen_at)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(license_key, device_fingerprint)
       DO UPDATE SET last_seen_at = excluded.last_seen_at, device_label = excluded.device_label`
    )
      .bind(fpId, key, fingerprint, label, now, now)
      .run();
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
  if (plan === "pro") {
    return Object.fromEntries(PAID_FEATURE_KEYS.map((k) => [k, true]));
  }
  return Object.fromEntries(PAID_FEATURE_KEYS.map((k) => [k, false]));
}

async function loadUserLicenseSummary(env, userId) {
  const rows = await env.DB.prepare(
    `SELECT key, plan, status, expires_at, created_at
       FROM license_keys
      WHERE user_id = ?
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
      `SELECT id, license_key, device_fingerprint, device_label, activated_at, last_seen_at
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
        activated_at: dev.activated_at,
        last_seen_at: dev.last_seen_at
      });
      deviceMap.set(dev.license_key, arr);
    }
  }

  // 找出当前最优的 license（active 且未过期 → pro 优先）
  let active = null;
  for (const row of list) {
    row.devices = deviceMap.get(row.key) || [];
    if (row.status !== "active") continue;
    if (row.expires_at && row.expires_at < Date.now()) continue;
    if (!active) {
      active = row;
      continue;
    }
    if (row.plan === "pro" && active.plan !== "pro") active = row;
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
function parseLemonRenewsAt(attrs) {
  // 一次性订单：没有 renews_at；订阅：renews_at 有效
  const candidate =
    attrs?.renews_at || attrs?.ends_at || attrs?.expires_at || "";
  if (!candidate) return null; // null = 永久
  const ms = Date.parse(candidate);
  return Number.isFinite(ms) ? ms : null;
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
 */
async function sendResetEmail(env, toEmail, resetUrl) {
  const subject = "公众号写手 · 重置你的密码";
  const text = `你好，

我们收到了一个把这个邮箱关联账号密码重置的请求。
点击下方链接（30 分钟内有效）即可设置新密码：

${resetUrl}

如果不是你本人发起的，可以忽略本邮件 —— 你的密码不会被更改。

— 公众号写手`;

  if (env.RESEND_API_KEY) {
    try {
      await fetch("https://api.resend.com/emails", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${env.RESEND_API_KEY}`
        },
        body: JSON.stringify({
          from: env.RESET_EMAIL_FROM || "no-reply@gzh.example.com",
          to: [toEmail],
          subject,
          text
        })
      });
    } catch (error) {
      console.warn("[reset] send email failed", error);
    }
    return;
  }

  // 没配邮件服务：写日志，方便开发期手动复制 link
  console.log(`[reset] (no email provider) to=${toEmail} url=${resetUrl}`);
}
