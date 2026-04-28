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

