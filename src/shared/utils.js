export function escapeHtml(value) {
  return String(value || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export function escapeAttribute(value) {
  return escapeHtml(value);
}

export function normalizeText(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

export function clampIndex(value, length) {
  if (length <= 1) {
    return 0;
  }
  return Math.max(0, Math.min(Number(value || 0), length - 1));
}

export function createId(prefix = "id") {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

export function debounce(fn, delayMs = 250) {
  let timer = null;
  return (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), delayMs);
  };
}

export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function deriveFilename(url, fallback) {
  try {
    const pathname = new URL(url).pathname;
    const filename = pathname.split("/").filter(Boolean).pop();
    if (filename) {
      return filename;
    }
  } catch {}
  return `${fallback}.png`;
}