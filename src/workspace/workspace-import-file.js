/**
 * 从本机 Word / PDF / Markdown 导入到当前（或新副篇）正文。
 * 依赖：../vendor/marked、全局 mammoth（见 workspace.html）、../vendor/pdfjs（动态 import）。
 */

import { marked } from "../vendor/marked/marked.esm.js";
import { escapeHtml, sanitizeHtml } from "../shared/utils.js";

let _ctx;

function _kindFromFile(file) {
  const n = (file.name || "").toLowerCase();
  if (n.endsWith(".md") || n.endsWith(".markdown")) return "markdown";
  if (n.endsWith(".docx")) return "docx";
  if (n.endsWith(".doc")) return "doc-legacy";
  if (n.endsWith(".pdf")) return "pdf";
  return "unknown";
}

function _baseTitleFromFileName(name) {
  return String(name || "")
    .replace(/\.[^.]+$/, "")
    .replace(/[-_]+/g, " ")
    .trim();
}

/**
 * 首行 # 标题 从 markdown 中拆出，返回 { bodyText, lineTitle }。
 */
function _splitLeadingMarkdownTitle(text) {
  const raw = String(text || "").replace(/^\uFEFF/, "");
  const lines = raw.split(/\r?\n/);
  if (lines.length === 0) return { bodyText: raw, lineTitle: "" };
  const first = lines[0].trim();
  const m = first.match(/^#\s+(.+)$/);
  if (m) {
    const lineTitle = m[1].trim();
    const rest = lines.slice(1).join("\n").replace(/^\n+/, "");
    return { bodyText: rest, lineTitle };
  }
  return { bodyText: raw, lineTitle: "" };
}

function _applySuggestedTitle(suggested) {
  const t = String(suggested || "").trim();
  if (!t) return;
  const { controls, getCurrentArticle } = _ctx;
  const cur = getCurrentArticle();
  if (cur?.meta?.title && String(cur.meta.title).trim()) return;
  controls.title.value = t;
}

async function _markdownToHtml(file) {
  const text = await file.text();
  const { bodyText, lineTitle } = _splitLeadingMarkdownTitle(text);
  const lineTitleOrFile = lineTitle || _baseTitleFromFileName(file.name);
  const html = marked.parse(bodyText || text, { gfm: true, breaks: true });
  return { html: String(html || ""), suggestedTitle: lineTitleOrFile };
}

async function _docxToHtml(file) {
  const mammoth = globalThis.mammoth;
  if (!mammoth || typeof mammoth.convertToHtml !== "function") {
    throw new Error("Word 导入模块未加载，请刷新编辑台后重试。");
  }
  const arrayBuffer = await file.arrayBuffer();
  const { value: html } = await mammoth.convertToHtml({ arrayBuffer });
  return { html: String(html || ""), suggestedTitle: _baseTitleFromFileName(file.name) };
}

async function _pdfToHtml(file) {
  const { getDocument, GlobalWorkerOptions } = await import("../vendor/pdfjs/pdf.mjs");
  const workerUrl = chrome.runtime.getURL("src/vendor/pdfjs/pdf.worker.mjs");
  GlobalWorkerOptions.workerSrc = workerUrl;

  const data = new Uint8Array(await file.arrayBuffer());
  const loadingTask = getDocument({ data, useSystemFonts: true });
  const pdf = await loadingTask.promise;
  const parts = [];
  for (let i = 1; i <= pdf.numPages; i++) {
    const page = await pdf.getPage(i);
    const tc = await page.getTextContent();
    const line = tc.items
      .map((it) => (typeof it.str === "string" ? it.str : ""))
      .filter(Boolean)
      .join(" ")
      .replace(/\s+/g, " ")
      .trim();
    if (line) parts.push(line);
  }
  const big = parts.join("\n\n");
  if (!big.trim()) {
    throw new Error(
      "从该 PDF 读不到文字。可能是扫描件或纯图片，请先 OCR 或复制文字后再试。"
    );
  }
  const blocks = big
    .split(/\n{2,}/)
    .map((s) => s.trim())
    .filter(Boolean);
  const safe = blocks.map((p) => `<p>${escapeHtml(p)}</p>`).join("");
  return { html: safe, suggestedTitle: _baseTitleFromFileName(file.name) };
}

function _bodyOnlyHtml(html) {
  const s = sanitizeHtml(String(html || ""));
  return s.trim() || "<p></p>";
}

/**
 * 选文件后写入当前篇或新副篇。
 */
export async function importFileFromEvent(event) {
  const file = event.target?.files?.[0];
  event.target.value = "";
  if (!file) return;

  const kind = _kindFromFile(file);
  if (kind === "unknown") {
    _ctx.setStatus("不支持的文件类型。请选 Word（.docx）、PDF 或 Markdown（.md）。", "error");
    return;
  }
  if (kind === "doc-legacy") {
    _ctx.setStatus("旧版 .doc 请先在 Word 中另存为 .docx，再重新选择。", "warning");
    return;
  }

  const asSub = Boolean(document.querySelector("#importFileAsSubArticle")?.checked);
  const fileLabel = `「${file.name}」`;

  try {
    _ctx.showLoading("正在从文件生成正文", "在本地转换，不会上传到我们的服务器。");

    let rawHtml;
    let suggestedTitle = "";
    if (kind === "markdown") {
      const r = await _markdownToHtml(file);
      rawHtml = r.html;
      suggestedTitle = r.suggestedTitle;
    } else if (kind === "docx") {
      const r = await _docxToHtml(file);
      rawHtml = r.html;
      suggestedTitle = r.suggestedTitle;
    } else if (kind === "pdf") {
      const r = await _pdfToHtml(file);
      rawHtml = r.html;
      suggestedTitle = r.suggestedTitle;
    }

    const bodyHtml = _bodyOnlyHtml(rawHtml);
    if (!bodyHtml || bodyHtml === "<p></p>") {
      _ctx.setStatus("转换后没有可写入的正文，请换一份文件或检查内容是否为空。", "warning");
      return;
    }

    _ctx.syncCurrentArticleFromControls();
    if (asSub) {
      const nBefore = _ctx.state.articleBundle.length;
      _ctx.addSubArticle();
      if (_ctx.state.articleBundle.length === nBefore) {
        return;
      }
    }
    const article = _ctx.getCurrentArticle();
    if (article) {
      article.bodyHtml = bodyHtml;
    }
    _applySuggestedTitle(suggestedTitle);
    _ctx.applyCurrentArticleToControls();
    _ctx.syncWorkspace();
    _ctx.schedulePersist();
    if (_ctx.view?.emptyPromptCard) {
      _ctx.view.emptyPromptCard.hidden = true;
    }

    const subHint = asSub ? "已写入新副篇。" : "已写入当前篇，复杂版式会简化处理。";
    if (kind === "pdf") {
      _ctx.setStatus(`已把 ${fileLabel} 中的文字导入（PDF 以纯文本为主）。${subHint}`, "success");
    } else {
      _ctx.setStatus(`已把 ${fileLabel} 导入。${subHint}`, "success");
    }
  } catch (err) {
    const msg = err?.message || "文件导入失败，请重试或换种格式。";
    console.warn("[import file]", err);
    _ctx.setStatus(msg, "error");
  } finally {
    _ctx.hideLoading();
  }
}

export function initImportFile(ctx) {
  _ctx = ctx;
  const btn = document.querySelector("#importFileButton");
  const input = document.querySelector("#importFileInput");
  if (!btn || !input) return;
  btn.addEventListener("click", () => {
    input.value = "";
    input.click();
  });
  input.addEventListener("change", (e) => {
    void importFileFromEvent(e);
  });
}
