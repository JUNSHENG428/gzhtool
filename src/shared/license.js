/**
 * src/shared/license.js
 * ====================================================================
 * 会员授权模块（联网验证 + 本地缓存 + 闸门 API）
 *
 * ---- 设计要点 ----
 * 1. 付费功能清单（PAID_FEATURES）与服务端 worker.js 中 PAID_FEATURE_KEYS 严格对齐。
 *    新增/删除功能时需两边同步。
 * 2. 三类持久化数据：
 *    - wechatWriterLicense       : 完整 license 缓存（plan/features/quota/signature/verifiedAt）
 *    - wechatWriterLicenseAuth   : 用户登录态（JWT token + user info）
 *    - wechatWriterLicenseDevice : 当前设备指纹（首次生成的 UUID + 友好 label）
 * 3. 验证策略：
 *    - 用户在 options 输入 key 后立刻联网验证（必须）。
 *    - 之后每 24h 静默复验一次；网络挂了进入 7 天宽限期，仍按缓存的 plan 发放 feature。
 *    - 超过 7 天没验证 → 强制视为 free（避免无限期信任本地数据）。
 * 4. 闸门：
 *    - checkLicense(featureKey) 同步返回 { ok, plan, reason, hint }。
 *    - 配额类（如 ai.unlimitedDaily）走 checkDailyQuota("rewrite")，与 usage-stats 联动。
 *    - 多账号上限走 checkAccountLimit(currentCount)，免费 2 个、pro 无限。
 * 5. 没有联网时：服务端是唯一 source of truth；插件本地仅承担"在签发的有效期内放行"职责，
 *    无法伪造 plan。
 *
 * ---- 不抛错策略 ----
 * 任何方法都不会向上抛异常，失败时静默降级到 free。这保证主业务（抓取/改写/发布）
 * 不会因为授权模块联网失败而崩溃。
 */

const STORAGE_LICENSE = "wechatWriterLicense";
const STORAGE_AUTH = "wechatWriterLicenseAuth";
const STORAGE_DEVICE = "wechatWriterLicenseDevice";

// 兼容老的导出，避免外部代码 import 报错
export const LICENSE_STORAGE_KEY = STORAGE_LICENSE;

const DEFAULT_API_BASE = "https://api.docuearn.com";
const VERIFY_INTERVAL_MS = 24 * 60 * 60 * 1000;       // 24h 主动复验
const STALE_GRACE_MS = 7 * 24 * 60 * 60 * 1000;        // 7 天宽限期
const FREE_DAILY_REWRITE_QUOTA = 5;                    // 与 worker FREE_DAILY_AI_QUOTA 对齐
const FREE_MULTI_ACCOUNT_LIMIT = 2;                    // 免费版多账号上限

// License Key 离线格式校验（仍保留，避免无意义请求打到服务器）
const KEY_PATTERN = /^GZHT-[2-9A-HJ-NP-Z]{4}-[2-9A-HJ-NP-Z]{4}-[2-9A-HJ-NP-Z]{4}$/;

// =====================================================================
// 付费功能清单（front-end 端的"权威表"）
// 每项必须标 tier=free|pro 与 hint，便于 UI 在闸门拦截时给出有人味的提示。
// =====================================================================

export const PAID_FEATURES = Object.freeze({
  // ---- 已实装闸门（4 项核心，与本期需求对齐）----
  "wechat.multiAccount": {
    name: "多公众号管理",
    tier: "pro",
    softLimit: { free: FREE_MULTI_ACCOUNT_LIMIT, pro: -1 },
    hint: `免费版最多绑定 ${FREE_MULTI_ACCOUNT_LIMIT} 个公众号；升级 Pro 可无限切换矩阵账号。`
  },
  "scrape.drission": {
    name: "DrissionPage 增强抓取",
    tier: "pro",
    hint: "免费版仅支持内置抓取；Pro 可启用 DrissionPage helper 走真实 Chromium，绕过反爬与懒加载。"
  },
  "ai.advancedTemplates": {
    name: "高级改写模板",
    tier: "pro",
    hint: "深度行业观察 / 故事化叙述 / 教程拆解 等高级模板需要 Pro；免费版可用清单整理与新闻速读。"
  },
  "ai.templateGenerator": {
    name: "AI 模板生成器",
    tier: "pro",
    hint: "用一句话描述你的公众号风格，AI 自动写出一个专属改写模板（自带角色设定、写作纪律、默认偏好）。Pro 专享。"
  },
  "ai.unlimitedDaily": {
    name: "无限 AI 改写次数",
    tier: "pro",
    quota: { free: FREE_DAILY_REWRITE_QUOTA, pro: -1 },
    hint: `免费版每天可改写 ${FREE_DAILY_REWRITE_QUOTA} 篇，明天 0 点重置；Pro 不限次数。`
  },

  // ---- 预留（worker 已声明但本期不强制闸门，后续可平滑接入）----
  "wechat.publish": {
    name: "一键推送公众号草稿/发布",
    tier: "free",
    hint: "公众号发布对全员开放（核心功能不会关在付费墙后）。"
  },
  "hot.advancedSources": {
    name: "高级热点信息源",
    tier: "pro",
    hint: "Pro 可解锁更多优质热榜源（X / Reddit / 海外科技媒体）。"
  },
  "ai.batchRewrite": {
    name: "批量改写",
    tier: "pro",
    hint: "Pro 支持一次喂入 5+ 篇来源批量改写。"
  },
  "ai.deAiBoost": {
    name: "去 AI 味增强",
    tier: "pro",
    hint: "Pro 启用 turnitin-humanizer 风格的二次润色，更难被 AI 检测。"
  }
});

// 高级 prompt 模板 ID 白名单（与 src/shared/defaults.js DEFAULT_PROMPT_TEMPLATES 对齐）
// 免费版可用：清单整理 / 新闻速读 / 自定义模板（custom-* 视为用户自有）
// Pro 限定：深度行业观察 / 故事化叙述 / 教程拆解
export const PRO_TEMPLATE_IDS = Object.freeze([
  "preset-deep-analysis",
  "preset-storytelling",
  "preset-tutorial"
]);

// =====================================================================
// 存储读写
// =====================================================================

async function storageGet(keys) {
  if (!globalThis.chrome?.storage?.local) return {};
  return new Promise((resolve) => {
    chrome.storage.local.get(keys, (data) => resolve(data || {}));
  });
}

async function storageSet(value) {
  if (!globalThis.chrome?.storage?.local) return;
  return new Promise((resolve) => {
    chrome.storage.local.set(value, () => resolve());
  });
}

async function storageRemove(keys) {
  if (!globalThis.chrome?.storage?.local) return;
  return new Promise((resolve) => {
    chrome.storage.local.remove(keys, () => resolve());
  });
}

export async function getLicenseRecord() {
  const data = await storageGet([STORAGE_LICENSE]);
  return data[STORAGE_LICENSE] || null;
}

export async function saveLicenseRecord(record) {
  if (!record) {
    await storageRemove(STORAGE_LICENSE);
    return;
  }
  await storageSet({
    [STORAGE_LICENSE]: {
      key: String(record.key || "").trim().toUpperCase(),
      plan: record.plan === "pro" ? "pro" : "free",
      status: record.status || (record.plan === "pro" ? "active" : "free"),
      expiresAt: Number(record.expiresAt) || 0,
      features: record.features || {},
      dailyQuota: Number.isFinite(record.dailyQuota) ? record.dailyQuota : null,
      signedAt: Number(record.signedAt) || 0,
      signature: String(record.signature || ""),
      verifiedAt: Number(record.verifiedAt) || Date.now(),
      activatedAt: record.activatedAt || new Date().toISOString(),
      user: record.user || null
    }
  });
}

export async function clearLicenseRecord() {
  await storageRemove(STORAGE_LICENSE);
}

export async function getAuthRecord() {
  const data = await storageGet([STORAGE_AUTH]);
  return data[STORAGE_AUTH] || null;
}

export async function saveAuthRecord(record) {
  if (!record) {
    await storageRemove(STORAGE_AUTH);
    return;
  }
  await storageSet({
    [STORAGE_AUTH]: {
      token: String(record.token || ""),
      user: record.user || null,
      issuedAt: Number(record.issuedAt) || Date.now()
    }
  });
}

export async function clearAuthRecord() {
  await storageRemove(STORAGE_AUTH);
}

// =====================================================================
// 设备指纹（首次生成，永不更换）
// =====================================================================

export async function getDeviceFingerprint() {
  const data = await storageGet([STORAGE_DEVICE]);
  if (data[STORAGE_DEVICE]?.fingerprint) {
    return data[STORAGE_DEVICE];
  }
  const fingerprint = generateUuid();
  const label = inferDeviceLabel();
  await storageSet({
    [STORAGE_DEVICE]: { fingerprint, label }
  });
  return { fingerprint, label };
}

function generateUuid() {
  if (globalThis.crypto?.randomUUID) {
    return globalThis.crypto.randomUUID();
  }
  // 兜底实现（极旧环境）
  const bytes = new Uint8Array(16);
  if (globalThis.crypto?.getRandomValues) {
    crypto.getRandomValues(bytes);
  } else {
    for (let i = 0; i < 16; i++) bytes[i] = Math.floor(Math.random() * 256);
  }
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = Array.from(bytes).map((b) => b.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function inferDeviceLabel() {
  try {
    const ua = globalThis.navigator?.userAgent || "";
    const platform =
      (globalThis.navigator?.userAgentData?.platform) ||
      (ua.match(/\(([^;)]+)/)?.[1]) ||
      "Unknown";
    return `Chrome on ${String(platform).slice(0, 32)}`;
  } catch {
    return "Chrome Extension Device";
  }
}

// =====================================================================
// API base 解析（用户可在 settings 自定义；默认走 DEFAULT_API_BASE）
// =====================================================================

export async function getApiBase() {
  try {
    const data = await storageGet(["wechatWriterSettings"]);
    const settings = data["wechatWriterSettings"];
    const customBase = String(settings?.licenseApiBase || "").trim();
    if (customBase) return customBase.replace(/\/+$/, "");
  } catch {
    // ignore
  }
  return DEFAULT_API_BASE;
}

async function apiFetch(path, { method = "GET", body, token, signal } = {}) {
  const base = await getApiBase();
  const headers = { "Content-Type": "application/json" };
  if (token) headers["Authorization"] = `Bearer ${token}`;
  const res = await fetch(`${base}${path}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
    signal
  });
  let data = null;
  try {
    data = await res.json();
  } catch {
    data = null;
  }
  if (!res.ok) {
    const message = data?.error || `请求失败（HTTP ${res.status}）`;
    const err = new Error(message);
    err.status = res.status;
    err.data = data;
    throw err;
  }
  return data || {};
}

// =====================================================================
// 账号 API：注册 / 登录 / me / 解绑 token
// =====================================================================

export async function register(email, password) {
  const data = await apiFetch("/api/register", {
    method: "POST",
    body: { email, password }
  });
  if (data?.ok && data.token) {
    await saveAuthRecord({ token: data.token, user: data.user });
  }
  return data;
}

export async function login(email, password) {
  const data = await apiFetch("/api/login", {
    method: "POST",
    body: { email, password }
  });
  if (data?.ok && data.token) {
    await saveAuthRecord({ token: data.token, user: data.user });
  }
  return data;
}

export async function logout() {
  await clearAuthRecord();
}

export async function fetchAccountSummary() {
  const auth = await getAuthRecord();
  if (!auth?.token) {
    return { ok: false, error: "未登录" };
  }
  try {
    return await apiFetch("/api/me", { token: auth.token });
  } catch (error) {
    if (error.status === 401) await clearAuthRecord();
    throw error;
  }
}

// =====================================================================
// License 绑定 / 解绑 / 验证
// =====================================================================

export async function bindLicenseToAccount(key) {
  const auth = await getAuthRecord();
  if (!auth?.token) throw new Error("请先登录账号再绑定 License");
  return apiFetch("/api/license/bind", {
    method: "POST",
    body: { key },
    token: auth.token
  });
}

export async function unbindLicenseFromAccount(key) {
  const auth = await getAuthRecord();
  if (!auth?.token) throw new Error("请先登录账号");
  return apiFetch("/api/license/unbind", {
    method: "POST",
    body: { key },
    token: auth.token
  });
}

/**
 * 联网验证 license key 并写本地缓存。这是激活流程的核心入口。
 * 返回完整服务端响应；调用方拿到后可直接渲染。
 */
export async function verifyLicenseRemote(key, { silent = false } = {}) {
  const trimmed = normalizeKey(key);
  if (!trimmed) {
    if (!silent) throw new Error("License Key 格式无效");
    return null;
  }
  const device = await getDeviceFingerprint();
  const data = await apiFetch("/api/license/verify", {
    method: "POST",
    body: {
      key: trimmed,
      deviceFingerprint: device.fingerprint,
      deviceLabel: device.label
    }
  });
  if (data?.ok) {
    await saveLicenseRecord({
      key: trimmed,
      plan: data.plan,
      status: data.status,
      expiresAt: data.expiresAt,
      features: data.features,
      dailyQuota: data.dailyQuota,
      signedAt: data.signedAt,
      signature: data.signature,
      verifiedAt: Date.now()
    });
  }
  return data;
}

/** 把当前设备从远端 device_activations 清除 */
export async function deactivateDevice(key) {
  const trimmed = normalizeKey(key);
  if (!trimmed) return { ok: false, error: "缺少 License Key" };
  const device = await getDeviceFingerprint();
  return apiFetch("/api/license/deactivate", {
    method: "POST",
    body: { key: trimmed, deviceFingerprint: device.fingerprint }
  });
}

// =====================================================================
// 后台静默复验（每 24h 一次）
// =====================================================================

let _verifyInFlight = null;

/**
 * 触发一次"如果需要就复验"的检查。多处调用会自动去重，不会并发。
 * 只在 record.verifiedAt 距今 > 24h 时真的发请求。
 */
export async function maybeRefreshLicense() {
  if (_verifyInFlight) return _verifyInFlight;
  _verifyInFlight = (async () => {
    try {
      const record = await getLicenseRecord();
      if (!record?.key) return null;
      const verifiedAt = Number(record.verifiedAt) || 0;
      if (Date.now() - verifiedAt < VERIFY_INTERVAL_MS) return record;
      try {
        return await verifyLicenseRemote(record.key, { silent: true });
      } catch {
        // 网络挂了：保持原状，由 evaluateLicense 通过 STALE_GRACE_MS 决定是否降级
        return record;
      }
    } finally {
      _verifyInFlight = null;
    }
  })();
  return _verifyInFlight;
}

// =====================================================================
// 状态评估
// =====================================================================

/**
 * 把存储里的 record 翻译成"可以直接给 UI 用"的状态。
 * 同时承担"过期/陈旧降级"判断 —— 任何时候 evaluateLicense 都不会信任非法状态。
 */
export function evaluateLicense(record) {
  if (!record || typeof record !== "object" || !record.key) {
    return makeFreeState("未激活会员，所有基础功能均可使用");
  }

  // 1) 服务端明确说 expired/revoked → 直接判定
  if (record.status && record.status !== "active") {
    return {
      status: record.status === "expired" ? "expired" : "invalid",
      label: record.status === "expired" ? "已过期" : "授权异常",
      hint:
        record.status === "expired"
          ? "会员已到期，可在「设置 → 会员激活」续费"
          : "License 已被服务端禁用，请联系客服或重新购买",
      key: record.key,
      displayKey: maskKey(record.key),
      plan: "free",
      effectivePlan: "free",
      expiresAt: record.expiresAt || 0,
      features: emptyFeatures(),
      dailyQuota: FREE_DAILY_REWRITE_QUOTA,
      user: record.user || null
    };
  }

  // 2) 到期时间检查（unix ms；0 表示永久）
  if (record.expiresAt && Number(record.expiresAt) > 0 && Number(record.expiresAt) < Date.now()) {
    return {
      status: "expired",
      label: "已过期",
      hint: `会员已于 ${formatDate(record.expiresAt)} 到期，可在设置页续费`,
      key: record.key,
      displayKey: maskKey(record.key),
      plan: "free",
      effectivePlan: "free",
      expiresAt: record.expiresAt,
      features: emptyFeatures(),
      dailyQuota: FREE_DAILY_REWRITE_QUOTA,
      user: record.user || null
    };
  }

  // 3) 陈旧检查：超过 7 天没成功验证 → 强制降级到 free
  const verifiedAt = Number(record.verifiedAt) || 0;
  const stale = verifiedAt && Date.now() - verifiedAt > STALE_GRACE_MS;
  if (stale) {
    return {
      status: "stale",
      label: "需要重新验证",
      hint: "已超过 7 天未联网核验，请在「会员激活」页点一次「刷新状态」",
      key: record.key,
      displayKey: maskKey(record.key),
      plan: "free",
      effectivePlan: "free",
      expiresAt: record.expiresAt || 0,
      features: emptyFeatures(),
      dailyQuota: FREE_DAILY_REWRITE_QUOTA,
      user: record.user || null
    };
  }

  // 4) 正常活跃
  const plan = record.plan === "pro" ? "pro" : "free";
  const features = sanitizeFeatures(record.features, plan);
  const dailyQuota = Number.isFinite(record.dailyQuota)
    ? record.dailyQuota
    : plan === "pro"
      ? -1
      : FREE_DAILY_REWRITE_QUOTA;

  if (plan !== "pro") {
    return {
      status: "free",
      label: "免费版",
      hint: "已绑定 License，但该 Key 不属于 Pro 套餐",
      key: record.key,
      displayKey: maskKey(record.key),
      plan: "free",
      effectivePlan: "free",
      expiresAt: record.expiresAt || 0,
      features,
      dailyQuota,
      user: record.user || null
    };
  }

  const expireText =
    record.expiresAt && Number(record.expiresAt) > 0
      ? `Pro 会员有效至 ${formatDate(record.expiresAt)}`
      : "Pro 会员（按订阅周期续费）";
  return {
    status: "pro",
    label: "Pro 会员",
    hint: expireText,
    key: record.key,
    displayKey: maskKey(record.key),
    plan: "pro",
    effectivePlan: "pro",
    expiresAt: record.expiresAt || 0,
    features,
    dailyQuota,
    user: record.user || null
  };
}

/** UI 通用入口：拿到「可以直接渲染」的状态。 */
export async function getLicenseState({ refresh = true } = {}) {
  const record = await getLicenseRecord();
  const state = evaluateLicense(record);
  // 后台静默触发"看是否要复验"，不阻塞调用方
  if (refresh && record?.key) {
    void maybeRefreshLicense().catch(() => {});
  }
  return state;
}

// =====================================================================
// 闸门 API（供 service-worker / options / workspace 调用）
// =====================================================================

/**
 * 判断当前用户是否有权使用某个付费功能。
 * 返回 { ok, plan, reason, hint, feature }
 *   - ok=true  → 放行
 *   - ok=false → reason ∈ "no_plan" | "feature_off" | "expired" | "stale"
 */
export async function checkLicense(featureKey) {
  const meta = PAID_FEATURES[featureKey];
  if (!meta) {
    // 未登记的 key 默认放行（但 console 警告，避免拼写错误悄无声息）
    if (typeof console !== "undefined") {
      console.warn(`[license] checkLicense 未知 featureKey=${featureKey}，默认放行`);
    }
    return { ok: true, plan: "unknown", reason: "", hint: "", feature: null };
  }
  if (meta.tier === "free") {
    return { ok: true, plan: "any", reason: "", hint: "", feature: meta };
  }
  const state = await getLicenseState({ refresh: true });
  if (state.effectivePlan === "pro") {
    // Pro 还要看具体 feature flag 是否打开（worker 决定）
    if (state.features?.[featureKey]) {
      return { ok: true, plan: "pro", reason: "", hint: "", feature: meta };
    }
    return {
      ok: false,
      plan: "pro",
      reason: "feature_off",
      hint: "该功能暂未开放，请等待版本升级",
      feature: meta
    };
  }
  return {
    ok: false,
    plan: "free",
    reason: state.status === "expired" ? "expired" : state.status === "stale" ? "stale" : "no_plan",
    hint: meta.hint,
    feature: meta
  };
}

/**
 * 检查"今日改写次数"配额。
 * 与 src/shared/usage-stats.js 联动 —— 直接动态 import 避免循环依赖。
 * 返回 { ok, used, limit, remaining, hint }；limit=-1 表示无限。
 */
export async function checkDailyQuota(kind = "rewrite") {
  const state = await getLicenseState({ refresh: true });
  if (state.effectivePlan === "pro") {
    return { ok: true, used: 0, limit: -1, remaining: -1, hint: "" };
  }
  const limit = state.dailyQuota > 0 ? state.dailyQuota : FREE_DAILY_REWRITE_QUOTA;
  let used = 0;
  try {
    const mod = await import("./usage-stats.js");
    const snap = await mod.getUsageSnapshot();
    used = Number(snap?.today?.[kind]) || 0;
  } catch {
    used = 0;
  }
  if (used >= limit) {
    return {
      ok: false,
      used,
      limit,
      remaining: 0,
      hint: `今天已用完免费版的 ${limit} 次 AI 改写额度，明日 0 点重置；升级 Pro 即刻无限。`
    };
  }
  return {
    ok: true,
    used,
    limit,
    remaining: limit - used,
    hint: `免费版今日剩余 ${limit - used}/${limit} 次 AI 改写`
  };
}

/**
 * 检查"多账号绑定上限"。currentCount 是当前已绑定数量，要再加一个时调用。
 * 返回 { ok, current, limit, hint }
 */
export async function checkAccountLimit(currentCount = 0) {
  const state = await getLicenseState({ refresh: false });
  if (state.effectivePlan === "pro") {
    return { ok: true, current: currentCount, limit: -1, hint: "" };
  }
  const limit = FREE_MULTI_ACCOUNT_LIMIT;
  if (currentCount >= limit) {
    return {
      ok: false,
      current: currentCount,
      limit,
      hint: PAID_FEATURES["wechat.multiAccount"].hint
    };
  }
  return {
    ok: true,
    current: currentCount,
    limit,
    hint: `免费版可绑定 ${limit} 个公众号，当前已绑 ${currentCount} 个`
  };
}

/**
 * 检查 prompt 模板是否在用户当前套餐内可用。
 * - 自定义模板（custom-* 或用户导入的非 preset-）一律放行
 * - 预设模板根据 PRO_TEMPLATE_IDS 判断
 */
export async function checkTemplateAccess(templateId) {
  const id = String(templateId || "").trim();
  if (!id) return { ok: true, plan: "any", hint: "", reason: "" };
  if (!PRO_TEMPLATE_IDS.includes(id)) {
    return { ok: true, plan: "any", hint: "", reason: "" };
  }
  const state = await getLicenseState({ refresh: false });
  if (state.effectivePlan === "pro") {
    return { ok: true, plan: "pro", hint: "", reason: "" };
  }
  return {
    ok: false,
    plan: "free",
    reason: "no_plan",
    hint: PAID_FEATURES["ai.advancedTemplates"].hint
  };
}

// =====================================================================
// 工具函数
// =====================================================================

export function normalizeKey(input) {
  const raw = String(input || "").trim().toUpperCase().replace(/\s+/g, "");
  if (!KEY_PATTERN.test(raw)) return "";
  return raw;
}

/**
 * 离线格式校验（兼容老接口名）。仅用于"用户输入时的即时反馈"，
 * 不再用于授权判定 —— 实际授权一律以服务端 verify 结果为准。
 */
export function validateLicenseKeyOffline(input) {
  const raw = String(input || "").trim().toUpperCase();
  if (!raw) return { ok: false, reason: "empty", key: "", plan: "free" };
  if (!KEY_PATTERN.test(raw)) return { ok: false, reason: "format", key: raw, plan: "free" };
  return { ok: true, reason: "", key: raw, plan: "unknown" };
}

function maskKey(key) {
  const raw = String(key || "").trim();
  if (!raw) return "";
  const segments = raw.split("-");
  if (segments.length !== 4) return raw;
  return `${segments[0]}-****-****-${segments[3]}`;
}

function formatDate(timestamp) {
  if (!timestamp) return "";
  const d = new Date(Number(timestamp));
  if (!Number.isFinite(d.getTime())) return "";
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function makeFreeState(hint) {
  return {
    status: "free",
    label: "免费版",
    hint,
    key: "",
    displayKey: "",
    plan: "free",
    effectivePlan: "free",
    expiresAt: 0,
    features: emptyFeatures(),
    dailyQuota: FREE_DAILY_REWRITE_QUOTA,
    user: null
  };
}

function emptyFeatures() {
  const out = {};
  for (const key of Object.keys(PAID_FEATURES)) {
    out[key] = PAID_FEATURES[key].tier === "free";
  }
  return out;
}

function sanitizeFeatures(features, plan) {
  const out = emptyFeatures();
  if (plan === "pro") {
    // pro 默认全部功能开（除非 worker 显式关闭某项）
    for (const key of Object.keys(PAID_FEATURES)) {
      out[key] = features?.[key] !== false;
    }
  } else if (features && typeof features === "object") {
    for (const key of Object.keys(out)) {
      out[key] = Boolean(features[key]);
    }
  }
  return out;
}

// 暴露常量给 UI 用
export const LICENSE_CONSTANTS = Object.freeze({
  FREE_DAILY_REWRITE_QUOTA,
  FREE_MULTI_ACCOUNT_LIMIT,
  VERIFY_INTERVAL_MS,
  STALE_GRACE_MS,
  DEFAULT_API_BASE
});

/**
 * 统一的 license 状态变化订阅入口。
 * - 监听 license / auth 两个 chrome.storage.local key（一个变就触发回调）
 * - 不传播 storage 详情，调用方自己 re-fetch + re-render
 * - 返回取消订阅函数
 *
 * 这个函数是「闸门点实时刷新」的基石：插件任意一处账号 / Key 变化（包括 sw 后台
 * 刷新），其它视图（popup pill / workspace 顶部 / options 列表 / prompt 模板的
 * PRO badge）都会自动刷新，避免用户激活后还要手动 reload 才能解锁。
 */
export function subscribeLicenseChanges(callback) {
  if (typeof callback !== "function") return () => {};
  if (typeof chrome === "undefined" || !chrome?.storage?.onChanged) {
    return () => {};
  }
  const listener = (changes, area) => {
    if (area !== "local") return;
    if (changes[STORAGE_LICENSE] || changes[STORAGE_AUTH]) {
      try {
        callback({
          licenseChanged: Boolean(changes[STORAGE_LICENSE]),
          authChanged: Boolean(changes[STORAGE_AUTH])
        });
      } catch (error) {
        console.warn("[license] subscriber failed", error);
      }
    }
  };
  chrome.storage.onChanged.addListener(listener);
  return () => {
    try {
      chrome.storage.onChanged.removeListener(listener);
    } catch {
      // ignore
    }
  };
}

export const LICENSE_AUTH_STORAGE_KEY = STORAGE_AUTH;
