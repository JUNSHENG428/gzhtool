/**
 * 站点的 API 客户端：单一职责 = 把 worker 的 HTTP 接口包成 Promise。
 * --------------------------------------------------------------
 * - API base 优先读 <meta name="api-base" content="...">
 *   未设置时退回到 window.__SITE_API_BASE__，再退回到 hardcoded fallback
 * - 自动从 localStorage 拿 JWT，附在 Authorization header
 * - 401 时调用 onUnauthorized()（默认：清空 token + 跳 /login.html）
 *
 * 部署时只要在 .html 头部加 <meta name="api-base" content="https://api.your.com">
 * 就能切换到生产环境，无需改 JS。
 */

const FALLBACK_BASE = "https://gzh-license.workers.dev";
const TOKEN_KEY = "gzh_site_token";

export function getApiBase() {
  if (typeof window !== "undefined") {
    if (typeof window.__SITE_API_BASE__ === "string" && window.__SITE_API_BASE__) {
      return window.__SITE_API_BASE__.replace(/\/+$/, "");
    }
    const meta = document.querySelector('meta[name="api-base"]');
    if (meta?.content) return meta.content.replace(/\/+$/, "");
  }
  return FALLBACK_BASE;
}

export function getToken() {
  try {
    return localStorage.getItem(TOKEN_KEY) || "";
  } catch {
    return "";
  }
}

export function setToken(token) {
  try {
    if (token) localStorage.setItem(TOKEN_KEY, token);
    else localStorage.removeItem(TOKEN_KEY);
  } catch {
    // ignore
  }
}

export function clearToken() {
  setToken("");
}

let _onUnauthorized = () => {
  clearToken();
  // pathname 在 Cloudflare Pages 上既可能是 /login 也可能是 /login.html
  // （取决于用户是不是直接输的带后缀地址），两种都不要再循环跳。
  if (typeof window !== "undefined" && !/\/login(\.html)?$/.test(location.pathname)) {
    location.href = "./login?from=expired";
  }
};

export function setOnUnauthorized(fn) {
  if (typeof fn === "function") _onUnauthorized = fn;
}

/**
 * 通用 fetch 包装。
 * - 自动序列化 body 为 JSON
 * - 自动注入 Authorization
 * - HTTP !ok 时抛出 { status, message } 形式 Error
 * - 401 触发 onUnauthorized（避免每个调用方都写一遍）
 *
 * ⚠️ 契约（与 server/worker.js 守约配对）：
 *   - 401 在本拦截器里**无差别**触发 _onUnauthorized() → 清 token + 跳登录页。
 *   - 这意味着 worker 端**只允许** requireAuth (缺/坏 token) 与 webhook signature
 *     失败返回 401；任何**已认证路径下的业务校验失败**（如旧密码错、状态非法、
 *     数量超限）必须用 400/403/409/422 等其它状态码。否则用户输错一次旧密码
 *     就会被踢登出，体验灾难（曾踩坑：handleChangePassword 历史返 401，
 *     2026-04-29 twenty-fourth session 已修为 400）。
 *   - 新加 worker 路由前必读本注释；改本拦截器（path-specific 例外、文案匹配等）
 *     前先盘清服务端契约面是否还能一致维护。
 */
export async function api(path, { method = "GET", body, auth = true, headers = {} } = {}) {
  const base = getApiBase();
  const opts = {
    method,
    headers: {
      "content-type": "application/json",
      ...headers
    }
  };
  if (auth) {
    const token = getToken();
    if (token) opts.headers["authorization"] = `Bearer ${token}`;
  }
  if (body != null) {
    opts.body = typeof body === "string" ? body : JSON.stringify(body);
  }

  let resp;
  try {
    resp = await fetch(`${base}${path}`, opts);
  } catch (error) {
    const e = new Error(error?.message || "网络异常，请检查网络后重试");
    e.kind = "network";
    throw e;
  }

  let data = null;
  try {
    data = await resp.json();
  } catch {
    // worker 应该总返回 JSON；解析失败时仍按 status 判定
  }

  if (resp.status === 401) {
    _onUnauthorized();
    const e = new Error(data?.error || "登录已过期，请重新登录");
    e.status = 401;
    throw e;
  }

  if (!resp.ok || data?.ok === false) {
    const message = data?.error || data?.message || `请求失败（${resp.status}）`;
    const e = new Error(message);
    e.status = resp.status;
    e.payload = data;
    throw e;
  }
  return data;
}

/* === API 方法（与 server/worker.js 一一对应） === */

export const auth = {
  register: (email, password) => api("/api/register", { method: "POST", body: { email, password }, auth: false }),
  login: (email, password) => api("/api/login", { method: "POST", body: { email, password }, auth: false }),
  me: () => api("/api/me", { method: "GET" }),
  changePassword: (oldPassword, newPassword) =>
    api("/api/account/change-password", {
      method: "POST",
      body: { oldPassword, newPassword }
    }),
  /**
   * 给 OAuth-only 账号设置首个密码（无需旧密码）。
   * 仅当 /api/me 返回 user.needsPluginPassword === true 时显示入口。
   * 主要场景：用 Google 注册的用户要在 Chrome 插件里登录（插件不支持 Google）。
   */
  setPassword: (newPassword) =>
    api("/api/account/set-password", {
      method: "POST",
      body: { newPassword }
    }),
  requestReset: (email) =>
    api("/api/auth/request-reset", { method: "POST", body: { email }, auth: false }),
  reset: (token, newPassword) =>
    api("/api/auth/reset", { method: "POST", body: { token, newPassword }, auth: false }),
  /**
   * Google 登录：把 GIS 回调里的 ID Token (credential) 发到后端。
   * 后端会验签、自动关联同邮箱已注册账号、新邮箱直接建账号，并下发我们自己的 JWT。
   * 失败场景由 api() 抛 Error，调用方 catch 后走通用 humanizeAuthError。
   */
  google: (credential) =>
    api("/api/auth/google", {
      method: "POST",
      body: { credential },
      auth: false
    })
};

export const license = {
  bind: (key) => api("/api/license/bind", { method: "POST", body: { key } }),
  unbind: (key) => api("/api/license/unbind", { method: "POST", body: { key } }),
  unbindDevice: (key, fingerprint, deviceId) =>
    api("/api/license/device/unbind", {
      method: "POST",
      body: { key, fingerprint, deviceId }
    })
};

export const health = () => api("/api/health", { auth: false });
