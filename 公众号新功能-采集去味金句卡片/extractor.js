/**
 * extractor.js —— 网页正文提取模块
 * 运行环境：content script（能访问当前页面 DOM）
 *
 * 职责：从用户当前浏览的任意网页中，提取出"主正文"——
 *   去掉导航/广告/页脚/评论等噪声，保留标题、段落、图片、来源。
 *
 * 实现思路（轻量版可读性算法，参考 Readability 思路但更小巧）：
 *   1. 候选容器打分：根据文本密度、<p> 数量、负面 class 名扣分
 *   2. 选出得分最高的容器作为正文根
 *   3. 结构化抽取标题 / 段落 / 图片 / 来源信息
 *
 * 若需要更强鲁棒性，可替换为 @mozilla/readability（见方案文档 §6）。
 */

const POSITIVE_HINTS = /(article|content|post|main|body|entry|text|story|markdown|rich_media)/i;
const NEGATIVE_HINTS = /(comment|footer|footnote|sidebar|nav|menu|ad|advert|promo|banner|share|related|recommend|copyright|subscribe)/i;
const SKIP_TAGS = new Set(["SCRIPT", "STYLE", "NOSCRIPT", "IFRAME", "FORM", "NAV", "ASIDE", "FOOTER", "HEADER", "BUTTON"]);

/**
 * 主入口：提取当前页面正文
 * @returns {{title:string, sourceUrl:string, paragraphs:string[], images:{src:string,alt:string}[], rawText:string}}
 */
export function extractArticle(doc = document) {
  const title = extractTitle(doc);
  const root = findContentRoot(doc);

  if (!root) {
    return { title, sourceUrl: location.href, paragraphs: [], images: [], rawText: "" };
  }

  const paragraphs = extractParagraphs(root);
  const images = extractImages(root);
  const rawText = paragraphs.join("\n\n");

  return { title, sourceUrl: location.href, paragraphs, images, rawText };
}

function extractTitle(doc) {
  // 优先 og:title / article:title，其次 <h1>，最后 document.title
  const meta =
    doc.querySelector('meta[property="og:title"]')?.content ||
    doc.querySelector('meta[name="title"]')?.content;
  if (meta?.trim()) return meta.trim();

  const h1 = doc.querySelector("h1")?.textContent?.trim();
  if (h1) return h1;

  return (doc.title || "").trim();
}

/** 给每个候选容器打分，返回得分最高者 */
function findContentRoot(doc) {
  const candidates = Array.from(doc.querySelectorAll("article, main, section, div"));
  let best = null;
  let bestScore = 0;

  for (const el of candidates) {
    const score = scoreElement(el);
    if (score > bestScore) {
      bestScore = score;
      best = el;
    }
  }
  // 兜底：得分太低就退回 <body>
  return bestScore > 20 ? best : doc.body;
}

function scoreElement(el) {
  const idClass = `${el.id} ${el.className}`;
  if (NEGATIVE_HINTS.test(idClass)) return 0;

  const paragraphs = el.querySelectorAll("p");
  const text = (el.textContent || "").trim();
  if (text.length < 200) return 0; // 文本太少直接淘汰

  let score = 0;
  score += paragraphs.length * 3;            // 段落越多越像正文
  score += Math.min(text.length / 100, 50);  // 文本密度（封顶防超长容器通杀）
  if (POSITIVE_HINTS.test(idClass)) score += 25;

  // 链接密度高 → 像导航/列表页，扣分
  const linkText = Array.from(el.querySelectorAll("a"))
    .reduce((sum, a) => sum + (a.textContent || "").length, 0);
  const linkDensity = text.length ? linkText / text.length : 0;
  if (linkDensity > 0.5) score *= 0.3;

  return score;
}

function extractParagraphs(root) {
  const blocks = Array.from(root.querySelectorAll("p, h2, h3, blockquote, li"));
  const seen = new Set();
  const out = [];

  for (const el of blocks) {
    if (isInSkippedAncestor(el)) continue;
    const text = (el.textContent || "").replace(/\s+/g, " ").trim();
    if (text.length < 8) continue;       // 过滤碎片
    if (seen.has(text)) continue;        // 去重
    seen.add(text);
    out.push(text);
  }
  return out;
}

function extractImages(root) {
  const imgs = Array.from(root.querySelectorAll("img"));
  const out = [];
  for (const img of imgs) {
    // 兼容懒加载：data-src / data-original
    const src =
      img.currentSrc ||
      img.src ||
      img.getAttribute("data-src") ||
      img.getAttribute("data-original") ||
      "";
    if (!src || src.startsWith("data:")) continue;          // 跳过占位/base64
    const w = img.naturalWidth || parseInt(img.getAttribute("width") || "0", 10);
    if (w && w < 200) continue;                              // 跳过小图标/广告位
    out.push({ src: toAbsoluteUrl(src), alt: img.alt || "" });
  }
  return out;
}

function isInSkippedAncestor(el) {
  let node = el;
  while (node && node !== document.body) {
    if (SKIP_TAGS.has(node.tagName)) return true;
    if (NEGATIVE_HINTS.test(`${node.id} ${node.className}`)) return true;
    node = node.parentElement;
  }
  return false;
}

function toAbsoluteUrl(src) {
  try {
    return new URL(src, location.href).href;
  } catch {
    return src;
  }
}
