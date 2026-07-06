export function escapeHtml(value) {
  // 用 ?? 而非 ||：数字 0 / 字符串 "0" 是合法内容，不应被吞成空串
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export function escapeAttribute(value) {
  return escapeHtml(value);
}

/**
 * 只放行 http(s) 链接。第三方/抓取来源的 URL 可能是 javascript: / data: 等危险 scheme，
 * 直接进 <a href> 点击会执行脚本（扩展页上下文可触达 chrome.* / storage）。
 * 非法协议返回 ""，调用方应降级为纯文本或丢弃 href。
 */
export function safeHttpUrl(value) {
  const raw = String(value ?? "").trim();
  if (!raw) return "";
  try {
    const u = new URL(raw, "https://docuearn.com");
    return u.protocol === "http:" || u.protocol === "https:" ? raw : "";
  } catch {
    return "";
  }
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

/**
 * 把抓取模式归一化到三档：selection / readable / raw。
 * - selection: 抓取选中文字（页内选区，永远走 content script，不走 DrissionPage）
 * - readable:  抓取正文（推荐，默认）
 * - raw:       抓取整页
 *
 * 任何不认识的值都回退到 "readable"，让链路一致。
 * （之前 drission.js 错误地从 utils.js import 了一个不存在的同名函数，
 *  这里把它落地为正经的实现，方便所有抓取分支共享。）
 */
export function normalizeCaptureMode(value) {
  const raw = String(value || "").trim().toLowerCase();
  if (raw === "selection") return "selection";
  if (raw === "raw") return "raw";
  return "readable";
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
    "table", "thead", "tbody", "tfoot", "tr", "th", "td", "caption", "colgroup", "col",
    // article/section 是 HTML5 安全的语义化容器；之前被剥到只剩内文，
    // 会把 buildExportHtmlForArticle 给 <article> 节点设置的主题 root inline-style
    // （背景 / 文字色 / 字体 / 内边距）一并丢掉——表现就是「换主题但预览没变」，
    // 深色主题（wired-neon 等）尤其严重，文字在默认浅色预览底色上几乎不可见。
    // 保留这两个 tag 的同时只允许 style/class 这类无害属性，安全无回退。
    "article", "section"
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
