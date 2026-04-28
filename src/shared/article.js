import { THEME_PRESETS } from "./defaults.js";
import { escapeHtml, escapeAttribute } from "./utils.js";

export function createArticleDraftState(article, sourceImages = []) {
  return {
    meta: {
      title: article.title || "",
      subtitle: article.subtitle || "",
      lead: article.lead || "",
      cta: article.cta || "",
      digest: createDigest(article),
      coverImageIndex: findCoverImageIndex(article, sourceImages),
      titleOptions: normalizeStringArray(article.wechatTitleOptions).slice(0, 4),
      keywords: normalizeStringArray(article.keywords).slice(0, 8)
    },
    bodyHtml: renderArticleBody(article, sourceImages)
  };
}

export function renderArticleBody(article, sourceImages = []) {
  const sections = (article.sections || [])
    .map((section) => renderSection(section, sourceImages))
    .join("");

  return [
    sections,
    article.closing ? `<p>${escapeHtml(article.closing)}</p>` : ""
  ]
    .filter(Boolean)
    .join("");
}

export function composeArticleBodyHtml(meta, bodyHtml) {
  // 注：meta.subtitle 历史上会渲染成 <p class="article-subtitle">，2026-04-26 fifteenth session
  // 把副标题输入栏从 UI 下线后此处也同步移除——meta.subtitle 字段在 article doc / draft history 里保留
  // （capture/rewrite 仍会写入），但既然用户没有 UI 可编辑，就不应该把它推到公众号草稿 HTML 里。
  // 主题应用层 (decorateHtmlForTheme) 的 .article-subtitle 选择器自动 no-op（querySelector 找不到元素）。
  // CTA 内段落显式 color:inherit；CTA 外层 div 上已有主题色（theme.cta 含 color），
  // 保险起见让内层 p 强制继承父级颜色，避免预览/导出环境里被读者侧 reader/dark mode
  // CSS 重置成默认深色，导致"深底深字"读不出来（用户反馈：CTA 文字框背景深，字体应是白）。
  // 同时 margin:0 抹掉浏览器默认 1em 上下 margin，让 CTA box 不会因 p 默认 margin
  // 越界破相。decorateHtmlForTheme 里专门 skip 了 cta-box 内的 p，所以这里写死安全。
  return `<article class="wechat-article">
    ${meta.lead ? `<p class="article-lead">${escapeHtml(meta.lead)}</p>` : ""}
    <div class="article-body">${bodyHtml || ""}</div>
    ${meta.cta ? `<div class="cta-box"><p style="margin:0;color:inherit;">${escapeHtml(meta.cta)}</p></div>` : ""}
  </article>`;
}

export function decorateHtmlForTheme(rawHtml, themeName) {
  const theme = THEME_PRESETS[themeName] || THEME_PRESETS["editorial-green"];
  const doc = new DOMParser().parseFromString(rawHtml, "text/html");
  let root = doc.body.firstElementChild;

  if (!root) {
    return rawHtml;
  }

  if (doc.body.children.length > 1) {
    const wrapper = doc.createElement("article");
    wrapper.className = "export-root";
    wrapper.innerHTML = doc.body.innerHTML;
    doc.body.innerHTML = "";
    doc.body.appendChild(wrapper);
    root = wrapper;
  }

  root.setAttribute("style", theme.root);
  applyStyle(root.querySelector(".article-subtitle"), theme.subtitle);
  applyStyle(root.querySelector(".article-lead"), theme.lead);
  root.querySelectorAll("h2").forEach((element) => applyStyle(element, theme.h2));
  root.querySelectorAll("h3").forEach((element) => applyStyle(element, theme.h3));
  root.querySelectorAll("p").forEach((element) => {
    if (
      element.classList.contains("article-subtitle") ||
      element.classList.contains("article-lead") ||
      element.closest(".cta-box")
    ) {
      return;
    }
    applyStyle(element, theme.p);
  });
  root.querySelectorAll("blockquote").forEach((element) =>
    applyStyle(element, theme.blockquote)
  );
  root.querySelectorAll("ul, ol").forEach((element) => applyStyle(element, theme.list));
  root.querySelectorAll("li").forEach((element) => applyStyle(element, theme.li));
  root.querySelectorAll("figure").forEach((element) => applyStyle(element, theme.figure));
  root.querySelectorAll("figure img").forEach((element) => applyStyle(element, theme.image));
  root.querySelectorAll("figcaption").forEach((element) =>
    applyStyle(element, theme.figcaption)
  );
  root.querySelectorAll("hr").forEach((element) => applyStyle(element, theme.hr));
  root.querySelectorAll("strong").forEach((element) => applyStyle(element, theme.strong));
  root.querySelectorAll(".cta-box").forEach((element) => applyStyle(element, theme.cta));

  return root.outerHTML;
}

export function htmlToMarkdown(rawHtml) {
  const doc = new DOMParser().parseFromString(`<div>${rawHtml}</div>`, "text/html");
  const root = doc.body.firstElementChild;
  if (!root) {
    return "";
  }

  return walkChildren(root)
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function walkChildren(root) {
  return Array.from(root.childNodes)
    .map((node) => nodeToMarkdown(node))
    .join("")
    .trim();
}

function nodeToMarkdown(node) {
  if (node.nodeType === Node.TEXT_NODE) {
    return collapseWhitespace(node.textContent || "");
  }

  if (node.nodeType !== Node.ELEMENT_NODE) {
    return "";
  }

  const element = node;
  const tag = element.tagName.toLowerCase();
  const text = walkChildren(element);

  switch (tag) {
    case "h2":
      return `## ${text}\n\n`;
    case "h3":
      return `### ${text}\n\n`;
    case "p":
      return `${text}\n\n`;
    case "strong":
      return `**${text}**`;
    case "blockquote":
      return `${text
        .split("\n")
        .map((line) => `> ${line}`)
        .join("\n")}\n\n`;
    case "ul":
      return `${Array.from(element.children)
        .map((child) => `- ${walkChildren(child).trim()}`)
        .join("\n")}\n\n`;
    case "ol":
      return `${Array.from(element.children)
        .map((child, index) => `${index + 1}. ${walkChildren(child).trim()}`)
        .join("\n")}\n\n`;
    case "li":
      return `${text}\n`;
    case "figure": {
      const img = element.querySelector("img");
      const caption = element.querySelector("figcaption")?.textContent?.trim();
      const src = img?.getAttribute("src") || "";
      if (!src) return "";
      return `![${caption || ""}](${src})${caption ? `\n*${caption}*` : ""}\n\n`;
    }
    case "hr":
      return `---\n\n`;
    case "div":
    case "section":
    case "article":
      return `${text}\n\n`;
    default:
      return text;
  }
}

function renderSection(section, sourceImages) {
  const heading = section.heading
    ? `<h2>${escapeHtml(section.heading)}</h2>`
    : "";
  const paragraphs = (section.paragraphs || []).map(
    (paragraph) => `<p>${escapeHtml(paragraph)}</p>`
  );
  const bullets =
    section.bulletPoints?.length > 0
      ? `<ul>${section.bulletPoints
          .map((point) => `<li>${escapeHtml(point)}</li>`)
          .join("")}</ul>`
      : "";
  const quote = section.quote
    ? `<blockquote>${escapeHtml(section.quote)}</blockquote>`
    : "";

  const codeHtml = (section.codeBlocks || [])
    .map((block) => renderCodeBlock(block))
    .join("");
  const tableHtml = (section.tables || [])
    .map((table) => renderTableBlock(table))
    .join("");
  const mathHtml = (section.mathBlocks || [])
    .map((block) => renderMathBlock(block))
    .join("");
  const imageBlocks = (section.imageRefs || [])
    .map((imageRef) => renderImageRef(imageRef, sourceImages));

  // 让图片不再总是粘在 section 末尾：把 imageRefs 均匀分布到 paragraphs 之间，
  // 每张图后面跟一段相邻段落（如果还有的话）。结构、代码、表格、数学块依次跟在最后，
  // 它们更像"补充信息"，放结尾不会破坏阅读节奏。
  const inlineImages = [...imageBlocks];
  const interleaved = [];
  for (let i = 0; i < paragraphs.length; i += 1) {
    interleaved.push(paragraphs[i]);
    if (inlineImages.length > 0) {
      const everyN = Math.max(1, Math.ceil(paragraphs.length / inlineImages.length));
      if ((i + 1) % everyN === 0) {
        interleaved.push(inlineImages.shift());
      }
    }
  }
  // 剩下没塞下的图按原顺序追加在段落之后、结构块之前
  while (inlineImages.length > 0) interleaved.push(inlineImages.shift());

  return `<section class="article-section">
    ${heading}
    ${interleaved.join("")}
    ${bullets}
    ${quote}
    ${tableHtml}
    ${codeHtml}
    ${mathHtml}
  </section>`;
}

function renderCodeBlock(block) {
  const language = String(block.language || "").trim();
  const text = String(block.text || "");
  const preStyle =
    "background:#0f172a;color:#e2e8f0;padding:14px 16px;border-radius:8px;overflow-x:auto;" +
    "font-family:'SFMono-Regular',Menlo,Consolas,'Liberation Mono',monospace;font-size:13px;" +
    "line-height:1.6;white-space:pre-wrap;word-break:break-all;margin:1em 0;";
  const codeStyle =
    "font-family:inherit;font-size:inherit;color:inherit;background:transparent;padding:0;";
  const langTag = language
    ? `<span style="display:inline-block;font-size:11px;color:#94a3b8;margin-bottom:6px;">${escapeHtml(
        language.toUpperCase()
      )}</span>`
    : "";
  return `<pre style="${preStyle}">${langTag}<code style="${codeStyle}">${escapeHtml(text)}</code></pre>`;
}

function renderTableBlock(table) {
  const headers = Array.isArray(table.headers) ? table.headers : [];
  const rows = Array.isArray(table.rows) ? table.rows : [];
  if (headers.length === 0 && rows.length === 0) return "";
  const tableStyle =
    "width:100%;border-collapse:collapse;margin:1em 0;font-size:14px;line-height:1.6;";
  const thStyle =
    "border:1px solid #d1d5db;background:#f3f4f6;padding:8px 12px;text-align:left;font-weight:600;";
  const tdStyle = "border:1px solid #d1d5db;padding:8px 12px;vertical-align:top;";
  const thead = headers.length
    ? `<thead><tr>${headers
        .map((h) => `<th style="${thStyle}">${escapeHtml(h || "")}</th>`)
        .join("")}</tr></thead>`
    : "";
  const tbody = rows.length
    ? `<tbody>${rows
        .map(
          (row) =>
            `<tr>${row
              .map((cell) => `<td style="${tdStyle}">${escapeHtml(cell || "")}</td>`)
              .join("")}</tr>`
        )
        .join("")}</tbody>`
    : "";
  return `<table style="${tableStyle}">${thead}${tbody}</table>`;
}

function renderMathBlock(block) {
  // 公众号原生不支持 KaTeX/MathJax；为保留信息又不让公式渲染失败，
  // 我们把 latex 用代码块样式包起来，并加一行小字提示「数学公式（LaTeX）」。
  // 这样阅读时仍能看到公式来源；后期如要真渲染，可在 workspace 端做 KaTeX → SVG 替换。
  const latex = String(block.latex || "").trim();
  if (!latex) return "";
  const wrap =
    "background:#fdf6e3;color:#2c2720;padding:12px 16px;border-left:3px solid #d6a86a;" +
    "border-radius:6px;font-family:'Times New Roman',serif;font-size:15px;line-height:1.7;" +
    "margin:1em 0;white-space:pre-wrap;";
  const tag =
    "display:inline-block;font-size:11px;color:#a87548;margin-bottom:6px;font-family:sans-serif;";
  return `<div style="${wrap}"><span style="${tag}">数学公式（LaTeX）</span><br/>${escapeHtml(latex)}</div>`;
}

function renderImageRef(imageRef, sourceImages) {
  const image = sourceImages[imageRef.index - 1];
  if (!image?.src) {
    return "";
  }

  const caption = imageRef.caption || image.caption || image.alt || "";
  return `<figure data-image-index="${imageRef.index}">
    <img src="${escapeAttribute(image.src)}" alt="${escapeAttribute(caption)}" />
    ${caption ? `<figcaption>${escapeHtml(caption)}</figcaption>` : ""}
  </figure>`;
}

function createDigest(article) {
  if (article.lead?.trim()) {
    return article.lead.trim().slice(0, 120);
  }

  const firstParagraph = article.sections?.find((section) => section.paragraphs?.length)?.paragraphs?.[0];
  return String(firstParagraph || "").trim().slice(0, 120);
}

function findCoverImageIndex(article, sourceImages) {
  for (const section of article.sections || []) {
    const index = Number(section.imageRefs?.[0]?.index || 0);
    if (index > 0 && index <= sourceImages.length) {
      return index;
    }
  }

  return sourceImages.length > 0 ? 1 : 0;
}

function normalizeStringArray(value) {
  if (!Array.isArray(value)) {
    return [];
  }

  return value
    .map((item) => String(item || "").trim())
    .filter(Boolean);
}

function applyStyle(element, style) {
  if (!element || !style) {
    return;
  }
  const existing = element.getAttribute("style");
  element.setAttribute("style", `${existing ? `${existing};` : ""}${style}`);
}

function collapseWhitespace(value) {
  return value.replace(/\s+/g, " ").trim();
}
