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

/**
 * 统一展示 runtime.sendMessage / API 返回的错误（字符串或 { message, code }）。
 */
export function formatRuntimeError(value, fallback = "操作失败，请稍后再试。") {
  if (value == null || value === "") {
    return fallback;
  }
  if (typeof value === "string") {
    return value || fallback;
  }
  if (typeof value === "object" && typeof value.message === "string" && value.message.trim()) {
    return value.message.trim();
  }
  return fallback;
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

/**
 * 严格白名单机制净化 HTML，防止 XSS 及 DOM Clobbering。
 * 仅保留安全的排版标签和属性，对于未知结构性标签保留内部文本。
 */
export function sanitizeHtml(html) {
  if (!html || typeof html !== "string") {
    return "";
  }

  const doc = new DOMParser().parseFromString(html, "text/html");

  const allowedTags = new Set([
    "html", "head", "body", "div", "span", "p", "br", "hr",
    "h1", "h2", "h3", "h4", "h5", "h6",
    "ul", "ol", "li", "dl", "dt", "dd",
    "strong", "em", "b", "i", "u", "s", "strike", "sub", "sup", "mark",
    "blockquote", "pre", "code", "a", "img", "figure", "figcaption",
    "table", "thead", "tbody", "tfoot", "tr", "th", "td", "caption", "colgroup", "col"
  ]);

  const dangerousTagsToDrop = new Set([
    "script", "style", "iframe", "object", "embed", "form", "input", "textarea", 
    "meta", "base", "svg", "math", "applet", "link", "template", "noscript"
  ]);

  const allowedAttributes = new Set([
    "href", "src", "alt", "title", "class", "style", "width", "height", "target", "rel",
    "rowspan", "colspan", "start", "type"
  ]);

  doc.querySelectorAll("*").forEach((el) => {
    const tagName = el.tagName.toLowerCase();

    // 如果不在白名单内：
    if (!allowedTags.has(tagName)) {
      // 若属于高危节点，连带内部结构彻底删除
      if (dangerousTagsToDrop.has(tagName)) {
        el.remove();
        return;
      }
      // 对于未知的无害节点（如 <article>, <section>, <font>），只剥离标签，保留内部文本
      const docFrag = document.createDocumentFragment();
      while (el.firstChild) {
        docFrag.appendChild(el.firstChild);
      }
      el.replaceWith(docFrag);
      return; // 被剥离后不再需要校验其属性
    }

    // 过滤属性
    for (const attr of [...el.attributes]) {
      const name = attr.name.toLowerCase();
      // 只允许白名单属性和 data- 自定义属性
      if (!allowedAttributes.has(name) && !name.startsWith("data-")) {
        el.removeAttribute(attr.name);
      }
    }

    // 验证链接协议
    if (tagName === "a") {
      const href = el.getAttribute("href");
      if (href) {
        const trimmed = href.trim().toLowerCase();
        // 严格限制 href 开头
        if (!trimmed.startsWith("http://") && !trimmed.startsWith("https://") && !trimmed.startsWith("#")) {
          el.removeAttribute("href");
        }
      }
    }

    // 验证 img src
    if (tagName === "img") {
      const src = el.getAttribute("src");
      if (src) {
        const trimmed = src.trim().toLowerCase();
        // 斩断可能的执行协议和不安全的格式
        if (trimmed.startsWith("javascript:") || trimmed.startsWith("vbscript:") || trimmed.startsWith("data:text/html")) {
          el.removeAttribute("src");
        }
      }
    }
  });

  return doc.body.innerHTML;
}

/**
 * 安全地合并对象，防止原型链污染。
 * 跳过 __proto__、constructor 和 prototype 键。
 */
export function safeObjectMerge(target, source) {
  if (!source || typeof source !== "object" || Array.isArray(source)) {
    return target;
  }
  for (const key of Object.keys(source)) {
    if (key === "__proto__" || key === "constructor" || key === "prototype") {
      continue;
    }
    target[key] = source[key];
  }
  return target;
}