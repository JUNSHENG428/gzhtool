import { escapeHtml, escapeAttribute } from "./utils.js";

/**
 * 把抓取得到的 source（含 blocks/images）转为可直接放入编辑器的 body HTML。
 * 兼容老的 paragraph/heading/quote/listItem/image 与新加的 code/table/list。
 * 返回的 HTML 结构与 renderArticleBody 一致（一组 <section>），可后续叠加主题样式。
 */
export function composeSourceBodyHtml(source) {
  if (!source || !Array.isArray(source.blocks) || source.blocks.length === 0) {
    return "";
  }

  const sourceImages = Array.isArray(source.images) ? source.images : [];
  const blocks = normalizeLegacyListItems(source.blocks);

  const sections = [];
  let buffer = [];
  let firstHeadingTaken = false;

  function flushSection() {
    if (buffer.length === 0) return;
    sections.push(`<section class="article-section">${buffer.join("")}</section>`);
    buffer = [];
  }

  for (const block of blocks) {
    if (!block) continue;

    if (block.type === "heading") {
      const tag = block.level <= 2 ? "h2" : "h3";
      if (tag === "h2" && (buffer.length > 0 || firstHeadingTaken)) {
        flushSection();
      }
      firstHeadingTaken = true;
      buffer.push(`<${tag}>${escapeHtml(block.text || "")}</${tag}>`);
      continue;
    }

    if (block.type === "paragraph") {
      const text = String(block.text || "").trim();
      if (!text) continue;
      buffer.push(`<p>${escapeHtml(text)}</p>`);
      continue;
    }

    if (block.type === "quote") {
      buffer.push(`<blockquote>${escapeHtml(block.text || "")}</blockquote>`);
      continue;
    }

    if (block.type === "list" && Array.isArray(block.items)) {
      const tag = block.ordered ? "ol" : "ul";
      const items = block.items
        .map((item) => `<li>${escapeHtml(String(item || "").trim())}</li>`)
        .join("");
      if (items) buffer.push(`<${tag}>${items}</${tag}>`);
      continue;
    }

    if (block.type === "code") {
      buffer.push(renderCodeBlockHtml(block));
      continue;
    }

    if (block.type === "table") {
      const html = renderTableBlockHtml(block);
      if (html) buffer.push(html);
      continue;
    }

    if (block.type === "image") {
      const idx = Number(block.index || 0);
      const fallback = idx > 0 ? sourceImages[idx - 1] : null;
      const src = block.src || fallback?.src || "";
      if (!src) continue;
      const alt = block.alt || fallback?.alt || "";
      const caption = block.caption || fallback?.caption || alt || "";
      buffer.push(
        `<figure data-image-index="${idx || ""}">` +
          `<img src="${escapeAttribute(src)}" alt="${escapeAttribute(caption)}" />` +
          (caption ? `<figcaption>${escapeHtml(caption)}</figcaption>` : "") +
          `</figure>`
      );
      continue;
    }
  }

  flushSection();
  return sections.join("");
}

export function buildSourceMetaDraft(source) {
  if (!source) return null;
  const description = String(source.description || "").trim();
  const lead = description.slice(0, 160);
  return {
    title: String(source.title || "").trim(),
    subtitle: String(source.siteName || "").trim(),
    lead,
    digest: lead.slice(0, 120)
  };
}

function normalizeLegacyListItems(blocks) {
  const out = [];
  let pending = null;
  for (const block of blocks) {
    if (block && block.type === "listItem") {
      if (!pending) pending = { type: "list", ordered: false, items: [] };
      pending.items.push(block.text || "");
      continue;
    }
    if (pending) {
      out.push(pending);
      pending = null;
    }
    out.push(block);
  }
  if (pending) out.push(pending);
  return out;
}

function renderCodeBlockHtml(block) {
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

function renderTableBlockHtml(block) {
  const headers = Array.isArray(block.headers) ? block.headers : [];
  const rows = Array.isArray(block.rows) ? block.rows : [];
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
