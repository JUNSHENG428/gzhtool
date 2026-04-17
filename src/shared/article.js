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
  return `<article class="wechat-article">
    ${meta.subtitle ? `<p class="article-subtitle">${escapeHtml(meta.subtitle)}</p>` : ""}
    ${meta.lead ? `<p class="article-lead">${escapeHtml(meta.lead)}</p>` : ""}
    <div class="article-body">${bodyHtml || ""}</div>
    ${meta.cta ? `<div class="cta-box"><p>${escapeHtml(meta.cta)}</p></div>` : ""}
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
  const imageBlocks = (section.imageRefs || [])
    .map((imageRef) => renderImageRef(imageRef, sourceImages))
    .join("");
  const paragraphs = (section.paragraphs || [])
    .map((paragraph) => `<p>${escapeHtml(paragraph)}</p>`)
    .join("");
  const bullets =
    section.bulletPoints?.length > 0
      ? `<ul>${section.bulletPoints
          .map((point) => `<li>${escapeHtml(point)}</li>`)
          .join("")}</ul>`
      : "";
  const quote = section.quote ? `<blockquote>${escapeHtml(section.quote)}</blockquote>` : "";

  return `<section class="article-section">
    ${section.heading ? `<h2>${escapeHtml(section.heading)}</h2>` : ""}
    ${paragraphs}
    ${bullets}
    ${quote}
    ${imageBlocks}
  </section>`;
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
