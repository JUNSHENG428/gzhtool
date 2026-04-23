/**
 * src/shared/wechat-html.js
 *
 * 公众号 add_draft 接口对 HTML 极其挑剔：
 *   1. <article> <div> <header> 这些容器经常被静默 unwrap，挂在它们身上的
 *      class / inline-style 会一并丢失，主题样式因此错乱。
 *   2. <script> <style> <link> <iframe> <video> <form> 等会被剥离。
 *   3. class / id / data-* 几乎全部失效，必须把样式写成 inline style。
 *   4. 表格、代码块、引用块如果没有 inline style，公众号渲染成无样式裸结构。
 *   5. 字符层面：零宽字符 (U+200B/200C/200D/2060/FEFF)、BOM、控制字符、
 *      未规范化的 Unicode 组合形式，会让微信草稿出现「乱码」、断字、空白。
 *
 * 这个模块在 workspace 端（有 DOMParser 的环境）跑一次清洗，输出可以直接
 * 喂给微信草稿接口的 HTML。Service Worker 端只需要做 token 替换 + 字节裁剪，
 * 不再依赖 DOM。
 */

const DROP_WITH_CONTENT = new Set([
  "script",
  "style",
  "link",
  "meta",
  "base",
  "title",
  "head",
  "iframe",
  "object",
  "embed",
  "form",
  "input",
  "textarea",
  "select",
  "button",
  "video",
  "audio",
  "canvas",
  "noscript",
  "template",
  "applet",
  "svg",
  "math",
  "frame",
  "frameset"
]);

// 这些容器在公众号侧多半会被剥壳；遇到带 inline style 的我们把它转成 <section>
// 保留样式；否则直接 unwrap。
const UNWRAP_OR_SECTION = new Set([
  "div",
  "article",
  "section",
  "header",
  "footer",
  "main",
  "nav",
  "aside",
  "details",
  "summary",
  "font",
  "center",
  "html",
  "body"
]);

const ALLOWED_TAGS = new Set([
  "p",
  "br",
  "hr",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "strong",
  "em",
  "b",
  "i",
  "u",
  "s",
  "strike",
  "mark",
  "del",
  "ins",
  "sub",
  "sup",
  "small",
  "blockquote",
  "pre",
  "code",
  "kbd",
  "samp",
  "var",
  "ul",
  "ol",
  "li",
  "dl",
  "dt",
  "dd",
  "a",
  "img",
  "figure",
  "figcaption",
  "table",
  "thead",
  "tbody",
  "tfoot",
  "tr",
  "th",
  "td",
  "caption",
  "colgroup",
  "col",
  "section",
  "span"
]);

const ALLOWED_ATTRS = new Set([
  "style",
  "href",
  "src",
  "alt",
  "title",
  "target",
  "rel",
  "width",
  "height",
  "colspan",
  "rowspan",
  "start",
  "type"
]);

const ALLOWED_DATA_ATTRS = new Set([
  "data-image-index",
  "data-fileid",
  "data-w",
  "data-h",
  "data-cropselx1",
  "data-cropsely1",
  "data-cropselx2",
  "data-cropsely2",
  "data-ratio"
]);

// 给关键标签补默认 inline style，已有的 style 优先级更高（详见 mergeStyle）。
// 这里的样式都是公众号编辑器默认能稳定渲染的，不依赖 @media / @font-face。
const DEFAULT_STYLES = {
  p: "margin:0 0 16px;line-height:1.85;font-size:16px;color:inherit;word-wrap:break-word;",
  h1: "margin:24px 0 16px;font-size:24px;font-weight:700;line-height:1.35;",
  h2: "margin:24px 0 12px;font-size:20px;font-weight:700;line-height:1.4;",
  h3: "margin:20px 0 10px;font-size:18px;font-weight:700;line-height:1.5;",
  h4: "margin:18px 0 10px;font-size:16px;font-weight:700;line-height:1.5;",
  h5: "margin:16px 0 10px;font-size:15px;font-weight:700;line-height:1.5;",
  h6: "margin:14px 0 10px;font-size:14px;font-weight:700;line-height:1.5;",
  blockquote:
    "margin:16px 0;padding:12px 16px;border-left:4px solid #cfd8dc;background:#f7f7f7;color:#37474f;border-radius:4px;line-height:1.85;",
  pre:
    "margin:16px 0;padding:12px 14px;background:#f6f8fa;border:1px solid #e5e7eb;border-radius:6px;font-family:Menlo,Consolas,'Courier New',monospace;font-size:13px;line-height:1.6;white-space:pre-wrap;word-wrap:break-word;color:#1f2937;overflow-x:auto;",
  code:
    "padding:1px 5px;background:#f4f5f7;border-radius:4px;font-family:Menlo,Consolas,'Courier New',monospace;font-size:0.92em;color:#c7254e;",
  kbd:
    "padding:1px 5px;background:#f4f5f7;border:1px solid #d0d0d0;border-radius:3px;font-family:Menlo,Consolas,monospace;font-size:0.9em;",
  ul: "margin:0 0 16px;padding-left:1.4em;line-height:1.85;",
  ol: "margin:0 0 16px;padding-left:1.4em;line-height:1.85;",
  li: "margin:0 0 6px;line-height:1.85;",
  table:
    "width:100%;border-collapse:collapse;margin:16px 0;font-size:14px;line-height:1.6;",
  thead: "background:#f5f5f5;",
  th:
    "border:1px solid #d0d0d0;padding:8px 10px;background:#f5f5f5;font-weight:700;text-align:left;vertical-align:top;",
  td: "border:1px solid #d0d0d0;padding:8px 10px;vertical-align:top;",
  caption: "padding:6px;font-size:13px;color:#666;text-align:center;",
  hr: "border:none;border-top:1px solid #e5e7eb;margin:20px 0;",
  img:
    "display:block;max-width:100%;height:auto;margin:12px auto;border-radius:6px;",
  figure: "margin:16px 0;",
  figcaption:
    "margin-top:6px;font-size:13px;color:#888;text-align:center;line-height:1.6;",
  a:
    "color:#1f6feb;text-decoration:none;border-bottom:1px solid rgba(31,111,235,0.3);word-break:break-all;"
};

const URL_SAFE_PROTOCOLS = /^(https?:|#|mailto:)/i;
const URL_BLOCKED_PROTOCOLS = /^(javascript:|vbscript:|data:text\/html)/i;

/**
 * 公众号 add_draft 对 inline style 的"雷区"清洗（参考 AIWriteX 项目梳理的限制）：
 *   - position:absolute / fixed / sticky 会被微信静默移除，导致排版垮塌；统一降级为 relative。
 *   - background / background-image 含 url(...) 的整段会被去掉，连带文字位置错乱；直接删 declaration。
 *   - background-clip:text + color:transparent 在微信暗色模式下文字会消失（无 fallback color），
 *     这种组合补一个 fallback color 让暗色下仍可读。
 *   - display:none / visibility:hidden / opacity:0 ：偷偷藏内容，发布后等于占位无意义，删除。
 *   - !important 在公众号侧多数会被剥掉，统一去掉避免计 style 长度多余字节。
 *   - position:relative 已是公众号支持的，不动。
 */
const STYLE_DROP_KEYS = new Set([
  "display",
  "visibility",
  "opacity",
  "z-index",
  "transform",
  "transform-origin",
  "transition",
  "animation"
]);
const STYLE_DROP_VALUES = {
  display: /^(none)$/i,
  visibility: /^(hidden|collapse)$/i,
  opacity: /^0(\.0+)?$/
};

export function sanitizeInlineStyle(style) {
  if (!style || typeof style !== "string") return "";
  const map = new Map();
  let needsTextFallback = false;
  let hasBackgroundClipText = false;
  let textColorIsTransparent = false;

  for (const segment of style.split(";")) {
    const colonIdx = segment.indexOf(":");
    if (colonIdx <= 0) continue;
    const key = segment.slice(0, colonIdx).trim().toLowerCase();
    let value = segment.slice(colonIdx + 1).trim();
    if (!key || !value) continue;

    value = value.replace(/!important/gi, "").trim();
    if (!value) continue;

    if (key === "position" && /^(absolute|fixed|sticky)$/i.test(value)) {
      map.set("position", "relative");
      continue;
    }
    if ((key === "background" || key === "background-image") && /url\s*\(/i.test(value)) {
      continue;
    }
    if ((key === "background-clip" || key === "-webkit-background-clip") && /text/i.test(value)) {
      hasBackgroundClipText = true;
    }
    if (key === "color" && /^transparent$/i.test(value)) {
      textColorIsTransparent = true;
    }
    if (STYLE_DROP_KEYS.has(key)) {
      const dropPattern = STYLE_DROP_VALUES[key];
      if (dropPattern && dropPattern.test(value)) continue;
      // transform / transition / animation 整段丢，公众号支持有限且容易引发布局抖动
      if (!dropPattern) continue;
    }
    map.set(key, value);
  }

  // 渐变文字 fallback：保留原效果，但暗色模式有兜底色。
  if (hasBackgroundClipText && textColorIsTransparent) {
    needsTextFallback = true;
  }
  if (needsTextFallback && !map.has("-webkit-text-fill-color")) {
    map.set("-webkit-text-fill-color", "currentColor");
  }

  return Array.from(map.entries())
    .map(([k, v]) => `${k}:${v}`)
    .join(";");
}

/**
 * 把零宽字符、BOM、不可见控制字符清掉，并做 NFC 规范化。
 * 这是公众号草稿出现「乱码 / 缺字 / 莫名空白」的最常见来源。
 */
export function cleanInvisibleChars(input) {
  if (typeof input !== "string" || input.length === 0) return "";
  // 去掉零宽 / BOM / 软连字符 / BIDI / 不可见标记。
  let out = input.replace(/[\u200B-\u200F\u2028-\u202F\u205F-\u206F\uFEFF\u00AD]/g, "");
  // 去掉控制字符（保留 \t \n \r）。
  out = out.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "");
  // NFC 规范化，避免组合字符在公众号侧错位。
  if (typeof out.normalize === "function") {
    try {
      out = out.normalize("NFC");
    } catch {
      // 个别 runtime 不支持 NFC 时静默退化。
    }
  }
  return out;
}

/**
 * 把任意富文本 HTML 转成「公众号 add_draft 友好」的 HTML：
 *   - 移除危险标签 / 不支持容器
 *   - class/id/data-*（除白名单）一律剥掉
 *   - 给标题、段落、表格、代码块、图片等补 inline style
 *   - 清理零宽字符 / 控制字符 / NFC
 *
 * @param {string} rawHtml
 * @returns {string} 清洗后的 HTML，可直接作为 add_draft.content。
 */
export function prepareHtmlForWechat(rawHtml) {
  if (!rawHtml || typeof rawHtml !== "string") return "";
  if (typeof DOMParser === "undefined") {
    // service worker 等无 DOM 环境，至少做字符层清理，别让上层崩。
    return cleanInvisibleChars(rawHtml);
  }

  const cleanedSource = cleanInvisibleChars(rawHtml);
  const doc = new DOMParser().parseFromString(
    `<!doctype html><html><body><div id="__gzh_root__">${cleanedSource}</div></body></html>`,
    "text/html"
  );
  const root = doc.getElementById("__gzh_root__");
  if (!root) return cleanedSource;

  // 第一遍：节点级清洗（删危险节点、unwrap 容器、白名单属性）。
  walk(root, doc);

  // 第二遍：给关键标签补默认 inline style。
  applyDefaultStyles(root);

  // 第三遍：合并相邻空白 <p>，去除空段落，避免微信渲染出大块空隙。
  collapseEmptyBlocks(root);

  return root.innerHTML.trim();
}

function walk(node, doc) {
  // 倒序遍历子节点，避免 unwrap 时索引错位。
  const children = Array.from(node.children);
  for (const child of children) {
    walk(child, doc);
  }

  if (node.id === "__gzh_root__") return;
  const tag = (node.tagName || "").toLowerCase();
  if (!tag) return;

  if (DROP_WITH_CONTENT.has(tag)) {
    node.remove();
    return;
  }

  if (UNWRAP_OR_SECTION.has(tag)) {
    convertContainer(node, doc);
    return;
  }

  if (!ALLOWED_TAGS.has(tag)) {
    unwrap(node);
    return;
  }

  cleanAttributes(node);
  validateUrls(node, tag);
  if (tag === "img" && !node.getAttribute("src")) {
    node.remove();
  }
}

function convertContainer(node, doc) {
  const style = (node.getAttribute("style") || "").trim();
  const tag = node.tagName.toLowerCase();
  // 带 inline style 的容器改成 <section> 保住样式。section 在公众号侧能保留 style。
  if (style && tag !== "html" && tag !== "body") {
    const section = doc.createElement("section");
    section.setAttribute("style", style);
    while (node.firstChild) section.appendChild(node.firstChild);
    node.parentNode?.replaceChild(section, node);
    return;
  }
  unwrap(node);
}

function unwrap(node) {
  const parent = node.parentNode;
  if (!parent) return;
  while (node.firstChild) parent.insertBefore(node.firstChild, node);
  parent.removeChild(node);
}

function cleanAttributes(node) {
  for (const attr of Array.from(node.attributes)) {
    const name = attr.name.toLowerCase();
    if (name.startsWith("on")) {
      node.removeAttribute(attr.name);
      continue;
    }
    if (name.startsWith("data-")) {
      if (!ALLOWED_DATA_ATTRS.has(name)) {
        node.removeAttribute(attr.name);
      }
      continue;
    }
    if (!ALLOWED_ATTRS.has(name)) {
      node.removeAttribute(attr.name);
    }
  }
  // 保留下来的 style 先过一道公众号雷区清洗（位置、url() 背景、display:none 等）
  const style = node.getAttribute("style");
  if (style) {
    const cleaned = sanitizeInlineStyle(style);
    if (cleaned) {
      node.setAttribute("style", cleaned);
    } else {
      node.removeAttribute("style");
    }
  }
}

function validateUrls(node, tag) {
  if (tag === "a") {
    const href = (node.getAttribute("href") || "").trim();
    if (!href) {
      // 空链接：unwrap 成纯文本。
      unwrap(node);
      return;
    }
    if (URL_BLOCKED_PROTOCOLS.test(href) || !URL_SAFE_PROTOCOLS.test(href)) {
      node.removeAttribute("href");
    } else {
      // 公众号要求外链统一加 rel/target，避免被吞。
      node.setAttribute("target", "_blank");
      node.setAttribute("rel", "noopener");
    }
  }
  if (tag === "img") {
    const src = (node.getAttribute("src") || "").trim();
    if (URL_BLOCKED_PROTOCOLS.test(src)) {
      node.removeAttribute("src");
      return;
    }
    // 微信渲染时 width/height 容易和容器宽度冲突，统一用 inline style 控制。
    node.removeAttribute("width");
    node.removeAttribute("height");
  }
}

function applyDefaultStyles(root) {
  for (const [tag, base] of Object.entries(DEFAULT_STYLES)) {
    const elements = root.querySelectorAll(tag);
    elements.forEach((el) => {
      const existing = el.getAttribute("style") || "";
      el.setAttribute("style", mergeStyle(base, existing));
    });
  }
}

/**
 * 合并 base / override 两段 inline style；override 优先。
 * base = "margin:0 0 16px;color:inherit;"
 * override = "margin:24px 0 12px;font-weight:700;"
 * → "margin:24px 0 12px;color:inherit;font-weight:700;"
 */
export function mergeStyle(base, override) {
  const map = new Map();
  for (const piece of [base, override]) {
    if (!piece) continue;
    for (const segment of piece.split(";")) {
      const colonIdx = segment.indexOf(":");
      if (colonIdx <= 0) continue;
      const key = segment.slice(0, colonIdx).trim().toLowerCase();
      const value = segment.slice(colonIdx + 1).trim();
      if (!key || !value) continue;
      // 尊重 !important，但不要把 !important 重复叠加。
      map.set(key, value);
    }
  }
  return sanitizeInlineStyle(
    Array.from(map.entries())
      .map(([k, v]) => `${k}:${v}`)
      .join(";")
  );
}

function collapseEmptyBlocks(root) {
  const blocks = root.querySelectorAll("p, h1, h2, h3, h4, h5, h6, li, blockquote");
  blocks.forEach((el) => {
    if (el.children.length === 0 && !el.textContent.trim()) {
      el.remove();
    }
  });
  // 连续 <br> 收敛到最多两个，避免空白爆炸。
  const html = root.innerHTML.replace(/(<br\s*\/?>\s*){3,}/gi, "<br/><br/>");
  if (html !== root.innerHTML) {
    root.innerHTML = html;
  }
}
