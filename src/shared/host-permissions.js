/**
 * Runtime host permission helpers for MV3 optional_host_permissions.
 *
 * Default host_permissions only cover fixed production services. User-provided
 * URLs (article pages, custom AI gateways, self-hosted RSSHub/NewsNow, remote
 * article images) must request their origin at the moment the user triggers the
 * action.
 */

export function originPatternFromUrl(value) {
  const raw = String(value || "").trim();
  if (!raw) return "";
  try {
    const url = new URL(raw);
    if (url.protocol !== "http:" && url.protocol !== "https:") return "";
    return `${url.protocol}//${url.host}/*`;
  } catch {
    return "";
  }
}

/**
 * 前端用户手势上下文里申请 host permission。
 *
 * 必须在 options / popup / extension page 的按钮 click handler 同步链路里调用，
 * 不能放到 service worker —— MV3 的 SW 永远没有用户激活，
 * `chrome.permissions.request` 会抛 "must be called during a user gesture"。
 *
 * 一旦用户在前端授权过，service-worker 后续调 `ensureOptionalHostPermission`
 * 时 contains 直接返回 true，不会再触发 request 路径。
 *
 * 接受单个 URL 或 URL 数组。空 / 无效 / 非 http(s) 的 URL 自动忽略；
 * 如果筛掉空值后没有任何 origin 需要 grant，直接返回 true（短路）。
 * 多个 origin 一次性 chrome.permissions.request 用一个权限弹窗解决，体验更好。
 *
 * 用法：
 *   const ok = await ensureHostPermissionFromGesture(url, "抓取并改写");
 *   const ok = await ensureHostPermissionFromGesture([baseUrl, ...imgUrls], "公众号发布");
 *   if (!ok) { 显示用户友好的提示，不要继续 sendMessage; return; }
 *
 * 返回 true = 已有权限或刚授权成功；false = 用户拒绝授权。
 * 不抛错（前端调用者通常希望提示用户而不是把异常冒到全局）。
 */
export async function ensureHostPermissionFromGesture(value, context = "当前操作") {
  const inputs = Array.isArray(value) ? value : [value];
  const origins = Array.from(
    new Set(inputs.map(originPatternFromUrl).filter(Boolean))
  );
  if (origins.length === 0) return true;
  if (!globalThis.chrome?.permissions) return true;
  try {
    const missing = [];
    for (const origin of origins) {
      const granted = await chrome.permissions.contains({ origins: [origin] });
      if (!granted) missing.push(origin);
    }
    if (missing.length === 0) return true;
    return await chrome.permissions.request({ origins: missing });
  } catch (err) {
    console.warn(`[host-permissions] grant failed for ${context}:`, err);
    return false;
  }
}

export async function ensureOptionalHostPermission(values, context = "当前操作") {
  const origins = Array.from(
    new Set(
      (Array.isArray(values) ? values : [values])
        .map(originPatternFromUrl)
        .filter(Boolean)
    )
  );

  if (origins.length === 0) return true;

  // Node smoke tests and non-extension previews do not expose chrome.permissions.
  if (!globalThis.chrome?.permissions) return true;

  const missing = [];
  for (const origin of origins) {
    const granted = await chrome.permissions.contains({ origins: [origin] });
    if (!granted) missing.push(origin);
  }

  if (missing.length === 0) return true;

  const granted = await chrome.permissions.request({ origins: missing });
  if (!granted) {
    throw new Error(
      `${context}需要访问以下网站，但你没有授予权限：${missing.join("、")}。请允许后重试。`
    );
  }
  return true;
}

