/**
 * workspace-editor.js
 * 负责：工具栏命令、模板插入、复制/下载、字数统计、字段提示、文章 HTML 构建函数。
 * 通过 init(ctx) 接收跨模块依赖，不直接 import 其他 workspace-* 模块。
 */

import { composeArticleBodyHtml, decorateHtmlForTheme, htmlToMarkdown } from "../shared/article.js";
import { THEME_PRESETS } from "../shared/defaults.js";
import { escapeHtml, escapeAttribute } from "../shared/utils.js";

let _ctx;

export function init(ctx) {
  _ctx = ctx;
  _bindEditorEvents();
  bindFieldHints();
}

function _bindEditorEvents() {
  const { view } = _ctx;

  // 工具栏格式命令
  document.querySelectorAll(".editor-toolbar button[data-command]").forEach((button) => {
    button.addEventListener("click", () => runEditorCommand(button));
  });

  // 工具栏模板插入
  document.querySelectorAll(".editor-toolbar button[data-template]").forEach((button) => {
    button.addEventListener("click", () => insertTemplate(button.dataset.template));
  });

  // 面板 Tab 切换
  document.querySelectorAll(".tab").forEach((tab) => {
    tab.addEventListener("click", () => _ctx.activateTab(tab.dataset.tab));
  });

  // 复制 / 下载按钮（部分可能由快捷键直接触发，此处绑定按钮）
  document.querySelector("#copyHtmlButton")?.addEventListener("click", copyHtml);
  document.querySelector("#copyMarkdownButton")?.addEventListener("click", copyMarkdown);
  document.querySelector("#downloadHtmlButton")?.addEventListener("click", downloadHtml);

  // 编辑器输入 → 字数统计（onWorkspaceInput 在 workspace.js 的 bindEvents 里额外绑定）
  view.editor.addEventListener("input", updateEditorWordCount);
}

// ── 文章 HTML 构建（被 render 和 publish 模块通过 ctx 调用）──

function buildRawBodyHtmlForArticle(article) {
  return composeArticleBodyHtml(article.meta, article.bodyHtml);
}

export function buildExportHtmlForArticle(article) {
  return decorateHtmlForTheme(buildRawBodyHtmlForArticle(article), _ctx.controls.theme.value);
}

export function buildMarkdownDocumentForArticle(article) {
  const markdownBody = htmlToMarkdown(buildRawBodyHtmlForArticle(article));
  return [`# ${article.meta.title || "未命名文章"}`, markdownBody].filter(Boolean).join("\n\n");
}

export function buildPreviewDocument(article) {
  return `<!doctype html>
<html lang="zh-CN">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>${escapeHtml(article.meta.title || "公众号预览")}</title>
    <style>
      body{margin:0;background:#efe8db;font-family:"IBM Plex Sans","PingFang SC","Hiragino Sans GB",sans-serif;color:#1c2e24;padding:24px;}
      .preview-header{max-width:900px;margin:0 auto 16px;padding:18px 20px;border-radius:20px;background:#fffdf8;border:1px solid #e4dccf;}
      .preview-header h1{margin:0;font-family:"Source Han Serif SC","Noto Serif SC",serif;font-size:34px;line-height:1.25;}
      .preview-header p{margin:10px 0 0;line-height:1.8;color:#617268;}
      .preview-body{max-width:900px;margin:0 auto;}
    </style>
  </head>
  <body>
    <div class="preview-header">
      <h1>${escapeHtml(article.meta.title || "未命名文章")}</h1>
      <p>${escapeHtml(article.meta.author || "")}${
        article.meta.contentSourceUrl ? ` · ${escapeHtml(article.meta.contentSourceUrl)}` : ""
      }</p>
      ${article.meta.digest ? `<p>${escapeHtml(article.meta.digest)}</p>` : ""}
    </div>
    <div class="preview-body">${buildExportHtmlForArticle(article)}</div>
  </body>
</html>`;
}

// ── 复制 / 下载 ──

export async function copyHtml() {
  const { syncCurrentArticleFromControls, getCurrentArticle, activateTab, setStatus } = _ctx;
  syncCurrentArticleFromControls();
  const html = buildExportHtmlForArticle(getCurrentArticle());
  await navigator.clipboard.writeText(html);
  activateTab("html");
  setStatus("当前篇正文 HTML 已复制。", "success");
}

export async function copyMarkdown() {
  const { view, syncCurrentArticleFromControls, getCurrentArticle, activateTab, setStatus } = _ctx;
  syncCurrentArticleFromControls();
  const markdown = buildMarkdownDocumentForArticle(getCurrentArticle());
  view.markdownOutput.value = markdown;
  await navigator.clipboard.writeText(markdown);
  activateTab("markdown");
  setStatus("当前篇 Markdown 已复制。", "success");
}

export function downloadHtml() {
  const { syncCurrentArticleFromControls, getCurrentArticle, setStatus } = _ctx;
  syncCurrentArticleFromControls();
  const current = getCurrentArticle();
  const fullHtml = buildPreviewDocument(current);
  const title = (current.meta.title || "wechat-article").replace(/[^\w\u4e00-\u9fa5-]+/g, "-");
  const blob = new Blob([fullHtml], { type: "text/html;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = `${title || "wechat-article"}.html`;
  anchor.click();
  URL.revokeObjectURL(url);
  setStatus("当前篇预览 HTML 已导出。", "success");
}

export function downloadMarkdown() {
  const { syncCurrentArticleFromControls, getCurrentArticle, setStatus } = _ctx;
  syncCurrentArticleFromControls();
  const current = getCurrentArticle();
  const markdown = buildMarkdownDocumentForArticle(current);
  const title = (current.meta.title || "wechat-article").replace(/[^\w\u4e00-\u9fa5-]+/g, "-");
  const blob = new Blob([markdown], { type: "text/markdown;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = `${title || "wechat-article"}.md`;
  anchor.click();
  URL.revokeObjectURL(url);
  setStatus("当前篇 Markdown 已导出。", "success");
}

export function toggleOutputPreviewTab() {
  const { activateTab, setStatus } = _ctx;
  const active = document.querySelector(".output-panel .tab.active");
  const current = active?.dataset.tab || "html";
  const next = current === "html" ? "markdown" : "html";
  activateTab(next);
  setStatus(next === "html" ? "已切换到 HTML 输出。" : "已切换到 Markdown 输出。", "info");
}

// ── 主题 ──

export function cycleEditorTheme() {
  const { controls, applyTheme, onWorkspaceInput, setStatus } = _ctx;
  const keys = Object.keys(THEME_PRESETS);
  const cur = controls.theme.value;
  const idx = Math.max(0, keys.indexOf(cur));
  const next = keys[(idx + 1) % keys.length];
  controls.theme.value = next;
  applyTheme(next);
  onWorkspaceInput();
  const label = THEME_PRESETS[next]?.label || next;
  setStatus(`已切换主题为：${label}`, "success");
}

// ── 工具栏命令 ──

export function runEditorCommand(button) {
  const { view, onWorkspaceInput } = _ctx;
  view.editor.focus();
  const command = button.dataset.command;
  const value = button.dataset.value;

  if (command === "formatBlock") {
    document.execCommand("formatBlock", false, String(value || "").toUpperCase());
  } else if (command === "insertHorizontalRule") {
    document.execCommand("insertHorizontalRule", false);
  } else {
    document.execCommand(command, false, null);
  }
  onWorkspaceInput();
}

export function insertTemplate(templateName) {
  const { view, getSelectedImage, setStatus, onWorkspaceInput } = _ctx;
  view.editor.focus();
  const selectedImage = getSelectedImage();
  const templates = {
    section: "<h2>新增章节标题</h2><p>在这里继续写这一部分的正文。</p>",
    insight: "<p><strong>一句判断：</strong>把这句改成真正有观点的结论。</p>",
    note: "<blockquote>这里插入一个重点提醒、方法总结，或你想强调的编辑观点。</blockquote>",
    checklist: "<ul><li>第一步</li><li>第二步</li><li>第三步</li></ul>",
    image: selectedImage ? _buildFigureHtml(selectedImage) : ""
  };
  const html = templates[templateName] || "";
  if (!html) {
    setStatus(templateName === "image" ? "请先在左侧选中一张图片。" : "模板插入失败。", "warning");
    return;
  }
  document.execCommand("insertHTML", false, html);
  onWorkspaceInput();
}

export function insertSourceImage(index) {
  const { view, state, setStatus, onWorkspaceInput } = _ctx;
  const image = state.source?.images?.[index - 1];
  if (!image) {
    setStatus("没有找到对应图片。", "warning");
    return;
  }
  view.editor.focus();
  document.execCommand("insertHTML", false, _buildFigureHtml(image));
  onWorkspaceInput();
}

function _buildFigureHtml(image) {
  const caption = image.caption || image.alt || "图片说明";
  return `<figure><img src="${escapeAttribute(image.src)}" alt="${escapeAttribute(caption)}" /><figcaption>${escapeHtml(caption)}</figcaption></figure>`;
}

// ── 字数统计 ──

export function updateEditorWordCount() {
  const { view } = _ctx;
  const text = view.editor.innerText.replace(/\s+/g, "");
  const count = text.length;
  const el = view.editorWordCount;
  el.textContent = `正文 ${count} 字`;
  el.classList.remove("under", "good", "over");
  if (count < 800) el.classList.add("under");
  else if (count > 4000) el.classList.add("over");
  else el.classList.add("good");
}

// ── 字段长度提示 ──

export function bindFieldHints() {
  const { controls } = _ctx;
  bindLengthHint(controls.title, document.querySelector('[data-for="titleInput"]'), 64, { hard: true });
  bindLengthHint(controls.subtitle, document.querySelector('[data-for="subtitleInput"]'), 32, { hard: true });
  bindLengthHint(controls.author, document.querySelector('[data-for="authorInput"]'), 8, { hard: true });
  bindLengthHint(controls.digest, document.querySelector('[data-for="digestInput"]'), 120, { hard: true });
}

function bindLengthHint(inputEl, hintEl, limit, { hard = true } = {}) {
  if (!inputEl || !hintEl) return;

  function update() {
    const length = inputEl.value.length;
    const ratio = length / limit;
    const remaining = limit - length;

    if (length > limit) {
      const over = length - limit;
      hintEl.textContent = `已超出公众号限制 ${over} 字`;
      hintEl.classList.add("over");
      hintEl.classList.remove("warning");
    } else if (ratio >= 0.9) {
      hintEl.textContent = `还能输入 ${remaining} 字`;
      hintEl.classList.add("warning");
      hintEl.classList.remove("over");
    } else {
      hintEl.textContent = `${length} / ${limit}`;
      hintEl.classList.remove("warning", "over");
    }

    if (inputEl.id === "titleInput" && length > 32) {
      const extra = hintEl.classList.contains("over") || hintEl.classList.contains("warning");
      if (!extra) {
        hintEl.textContent += " · 公众号列表页最多显示 32 字，超出部分会截断";
      } else if (length <= limit) {
        hintEl.textContent += " · 列表页最多显示 32 字";
      }
    }
  }

  inputEl.addEventListener("input", update);
  update();
}
