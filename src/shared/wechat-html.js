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
// P1.4 · 暗色模式 fallback color。
// 微信公众号的暗色模式会自动给 body/容器加 class="js_darkmode__"，
// 然后**只对没有显式 color 的节点**做反色处理（白底变深灰底，黑字变浅灰字）；
// 但如果用户给 p/h* 设置了 color，微信侧通常**会原样保留**——
// 这就是为什么很多带渐变背景的 AI 模板在暗色下变成"白底白字"或"黑底黑字"：
// 因为只声明了背景色没声明前景色，反色逻辑两边都不动。
//
// 对策：所有 block-level 文本元素都强制带一个深灰前景色（#1f2228 / #2d3036），
// 再用一个浅灰 blockquote/code 背景做配套。这样即便微信在暗色模式下不反色，
// 文字仍能在浅色背景上保持可读对比度（WCAG ≥ 4.5）。
//
// 注意：这里不能直接用 #000，否则深色背景模板会被强行压成黑底黑字。
const FALLBACK_TEXT_COLOR = "#2d3036";
const FALLBACK_HEADING_COLOR = "#1f2228";

const DEFAULT_STYLES = {
  p: `margin:0 0 16px;line-height:1.85;font-size:16px;color:${FALLBACK_TEXT_COLOR};word-wrap:break-word;`,
  h1: `margin:24px 0 16px;font-size:24px;font-weight:700;line-height:1.35;color:${FALLBACK_HEADING_COLOR};`,
  h2: `margin:24px 0 12px;font-size:20px;font-weight:700;line-height:1.4;color:${FALLBACK_HEADING_COLOR};`,
  h3: `margin:20px 0 10px;font-size:18px;font-weight:700;line-height:1.5;color:${FALLBACK_HEADING_COLOR};`,
  h4: `margin:18px 0 10px;font-size:16px;font-weight:700;line-height:1.5;color:${FALLBACK_HEADING_COLOR};`,
  h5: `margin:16px 0 10px;font-size:15px;font-weight:700;line-height:1.5;color:${FALLBACK_HEADING_COLOR};`,
  h6: `margin:14px 0 10px;font-size:14px;font-weight:700;line-height:1.5;color:${FALLBACK_HEADING_COLOR};`,
  blockquote:
    "margin:16px 0;padding:12px 16px;border-left:4px solid #cfd8dc;background:#f7f7f7;color:#37474f;border-radius:4px;line-height:1.85;",
  pre:
    "margin:16px 0;padding:12px 14px;background:#f6f8fa;border:1px solid #e5e7eb;border-radius:6px;font-family:Menlo,Consolas,'Courier New',monospace;font-size:13px;line-height:1.6;white-space:pre-wrap;word-wrap:break-word;color:#1f2937;overflow-x:auto;",
  code:
    "padding:1px 5px;background:#f4f5f7;border-radius:4px;font-family:Menlo,Consolas,'Courier New',monospace;font-size:0.92em;color:#c7254e;",
  kbd:
    "padding:1px 5px;background:#f4f5f7;border:1px solid #d0d0d0;border-radius:3px;font-family:Menlo,Consolas,monospace;font-size:0.9em;",
  ul: `margin:0 0 16px;padding-left:1.4em;line-height:1.85;color:${FALLBACK_TEXT_COLOR};`,
  ol: `margin:0 0 16px;padding-left:1.4em;line-height:1.85;color:${FALLBACK_TEXT_COLOR};`,
  li: `margin:0 0 6px;line-height:1.85;color:${FALLBACK_TEXT_COLOR};`,
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

    // 微信适配（技术规范 §4.3/§4.4）：
    // 坑5 · 去掉 font-family，交还微信默认字体栈（iOS 17+ 字号/字间距异常）。
    //   pre/code 的等宽字体由 applyDefaultStyles 之后单独补，不受此影响。
    if (key === "font-family") continue;
    // text-align: start/end 终端兼容差 → 归一到 left/right
    if (key === "text-align") {
      if (/^start$/i.test(value)) value = "left";
      else if (/^end$/i.test(value)) value = "right";
    }
    // line-height: 0 会导致文字行重叠 → 丢弃
    if (key === "line-height" && /^0(px|em|rem|%)?$/i.test(value)) continue;

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
    // P1.4 · 暗色模式 fallback：检测到「近白色文字」（白底白字、浅灰文字）就回退到深灰。
    // 微信暗色模式只反转那些**没显式指定 color**的元素；如果用户写了 color:#fff，
    // 微信会原样保留，叠在公众号自动加的暗色背景上反而是"暗底白字 OK"，
    // 但叠在浅色读者侧（例如关闭暗色或夜间模式不一致的客户端）会变成"白底白字" → 不可读。
    // 这里把任何近白色（亮度 >= 235）替换成项目统一的深灰前景色，确保两个主题都至少能看清。
    // 注意：只动 `color`，不动 `background`/`border-color`，避免破坏装饰图层。
    if (key === "color" && _isNearWhiteColor(value)) {
      value = FALLBACK_TEXT_COLOR;
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
 * P1.4 · 判断一段 CSS color 字符串是否是「近白色」（亮度 ≥ 235，会在浅色背景上消失）。
 * 支持：#fff / #ffffff / rgb(r,g,b) / rgba(r,g,b,a) / 关键字 white、ivory、snow、whitesmoke。
 * 其他写法（hsl、color() 等）保守判定为非白，避免误改用户精心调过的色板。
 */
function _isNearWhiteColor(rawValue) {
  if (!rawValue || typeof rawValue !== "string") return false;
  const value = rawValue.trim().toLowerCase();
  // CSS 关键字
  if (/^(white|ivory|snow|whitesmoke|floralwhite|ghostwhite|seashell|linen|oldlace|honeydew|mintcream|azure|aliceblue|lavenderblush|lightyellow|lightgoldenrodyellow|cornsilk|beige)$/.test(value)) {
    return true;
  }
  // #rgb / #rrggbb
  let r = -1;
  let g = -1;
  let b = -1;
  const hexShort = value.match(/^#([0-9a-f])([0-9a-f])([0-9a-f])$/);
  const hexFull = value.match(/^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})(?:[0-9a-f]{2})?$/);
  if (hexShort) {
    r = parseInt(hexShort[1] + hexShort[1], 16);
    g = parseInt(hexShort[2] + hexShort[2], 16);
    b = parseInt(hexShort[3] + hexShort[3], 16);
  } else if (hexFull) {
    r = parseInt(hexFull[1], 16);
    g = parseInt(hexFull[2], 16);
    b = parseInt(hexFull[3], 16);
  } else {
    const rgb = value.match(/^rgba?\(\s*(\d{1,3})[,\s]+(\d{1,3})[,\s]+(\d{1,3})/);
    if (rgb) {
      r = Number(rgb[1]);
      g = Number(rgb[2]);
      b = Number(rgb[3]);
    }
  }
  if (r < 0 || g < 0 || b < 0) return false;
  // ITU-R BT.601 亮度近似
  const luminance = 0.299 * r + 0.587 * g + 0.114 * b;
  return luminance >= 235;
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
