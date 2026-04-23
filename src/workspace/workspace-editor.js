/**
 * workspace-editor.js
 * 负责：工具栏命令、模板插入、复制/下载、字数统计、字段提示、文章 HTML 构建函数。
 * 通过 init(ctx) 接收跨模块依赖，不直接 import 其他 workspace-* 模块。
 */

import { composeArticleBodyHtml, decorateHtmlForTheme, htmlToMarkdown } from "../shared/article.js";
import { THEME_PRESETS } from "../shared/defaults.js";
import { escapeHtml, escapeAttribute, sanitizeHtml } from "../shared/utils.js";
import { getSettings, saveSettings } from "../shared/storage.js";

let _ctx;

export function init(ctx) {
  _ctx = ctx;
  _bindEditorEvents();
  bindFieldHints();
  _loadCustomTemplates();
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

  // 自定义模板下拉
  _ctx.controls.customTemplateSelect?.addEventListener("change", () => {
    const name = _ctx.controls.customTemplateSelect.value;
    if (!name) return;
    const templates = _ctx.state.settings?.customTemplates || {};
    const html = templates[name];
    if (html) {
      view.editor.focus();
      document.execCommand("insertHTML", false, sanitizeHtml(html));
      _ctx.onWorkspaceInput();
    }
    _ctx.controls.customTemplateSelect.value = "";
  });

  // 保存自定义模板
  document.querySelector("#saveTemplateButton")?.addEventListener("click", saveCustomTemplate);

  // 面板 Tab 切换
  document.querySelectorAll(".tab").forEach((tab) => {
    tab.addEventListener("click", () => _ctx.activateTab(tab.dataset.tab));
    tab.addEventListener("keydown", (event) => {
      _handleOutputTabKeydown(event);
    });
  });

  // 复制 / 下载按钮（部分可能由快捷键直接触发，此处绑定按钮）
  document.querySelector("#copyHtmlButton")?.addEventListener("click", copyHtml);
  document.querySelector("#copyMarkdownButton")?.addEventListener("click", copyMarkdown);
  document.querySelector("#downloadHtmlButton")?.addEventListener("click", downloadHtml);

  // 编辑器输入 → 字数统计（onWorkspaceInput 在 workspace.js 的 bindEvents 里额外绑定）
  view.editor.addEventListener("input", updateEditorWordCount);

  // Markdown 粘贴导入
  view.editor.addEventListener("paste", _handleEditorPaste);

  // 工具栏禁用态
  view.editor.addEventListener("keyup", updateToolbarState);
  view.editor.addEventListener("mouseup", updateToolbarState);
  document.addEventListener("selectionchange", () => {
    if (document.activeElement === view.editor || view.editor.contains(document.activeElement)) {
      updateToolbarState();
    }
  });

  // 阅读进度条
  view.editor.addEventListener("scroll", updateReadingProgress);
  window.addEventListener("resize", updateReadingProgress);
}

function _handleOutputTabKeydown(event) {
  const supportedKeys = new Set(["ArrowLeft", "ArrowRight", "Home", "End"]);
  if (!supportedKeys.has(event.key)) {
    return;
  }

  const tabs = Array.from(document.querySelectorAll(".editor-tabs [role='tab']"));
  const currentIndex = tabs.indexOf(event.currentTarget);
  if (currentIndex < 0 || tabs.length === 0) {
    return;
  }

  event.preventDefault();

  let nextIndex = currentIndex;
  if (event.key === "ArrowRight") {
    nextIndex = (currentIndex + 1) % tabs.length;
  } else if (event.key === "ArrowLeft") {
    nextIndex = (currentIndex - 1 + tabs.length) % tabs.length;
  } else if (event.key === "Home") {
    nextIndex = 0;
  } else if (event.key === "End") {
    nextIndex = tabs.length - 1;
  }

  const nextTab = tabs[nextIndex];
  if (!nextTab) {
    return;
  }

  nextTab.focus();
  _ctx.activateTab(nextTab.dataset.tab);
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
  const { view, syncCurrentArticleFromControls, getCurrentArticle, activateTab, setStatus } = _ctx;
  syncCurrentArticleFromControls();
  const article = getCurrentArticle();
  if (_isArticleEmpty(view, article)) {
    setStatus("当前文章正文还是空的，复制取消了。先抓取内容或粘贴正文再试。", "error");
    return;
  }
  const html = buildExportHtmlForArticle(article);
  await navigator.clipboard.writeText(html);
  activateTab("html");
  setStatus("当前篇正文 HTML 已复制。", "success");
}

export async function copyMarkdown() {
  const { view, syncCurrentArticleFromControls, getCurrentArticle, activateTab, setStatus } = _ctx;
  syncCurrentArticleFromControls();
  const article = getCurrentArticle();
  if (_isArticleEmpty(view, article)) {
    setStatus("当前文章正文还是空的，复制取消了。先抓取内容或粘贴正文再试。", "error");
    return;
  }
  const markdown = buildMarkdownDocumentForArticle(article);
  view.markdownOutput.value = markdown;
  await navigator.clipboard.writeText(markdown);
  activateTab("markdown");
  setStatus("当前篇 Markdown 已复制。", "success");
}

function _isArticleEmpty(view, article) {
  const editorText = (view?.editor?.textContent || "").trim();
  if (editorText.length > 0) return false;
  const meta = article?.meta || {};
  const fields = [meta.title, meta.subtitle, meta.lead, meta.digest];
  return fields.every((v) => !v || !String(v).trim());
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

// ── 阅读进度条 ──

export function updateReadingProgress() {
  const { view } = _ctx;
  const progressBar = document.querySelector("#readingProgressBar");
  if (!progressBar || !view.editor) return;

  const editor = view.editor;
  const scrollTop = editor.scrollTop;
  const scrollHeight = editor.scrollHeight - editor.clientHeight;
  const progress = scrollHeight > 0 ? (scrollTop / scrollHeight) * 100 : 0;
  progressBar.style.width = `${Math.min(100, Math.max(0, progress))}%`;
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

// ── 工具栏禁用态 ──

export function updateToolbarState() {
  const { view } = _ctx;
  const selection = document.getSelection();
  const isInEditor = selection?.rangeCount > 0 && view.editor.contains(selection.anchorNode);

  let isInImage = false;
  let hasSelection = false;

  if (isInEditor && selection) {
    const node = selection.anchorNode;
    if (node?.nodeType === Node.ELEMENT_NODE) {
      isInImage = node.closest?.("figure, img") != null;
    } else if (node?.parentElement) {
      isInImage = node.parentElement.closest?.("figure, img") != null;
    }
    hasSelection = !selection.isCollapsed;
  }

  document.querySelectorAll(".editor-toolbar button[data-command]").forEach((button) => {
    const command = button.dataset.command;
    let disabled = !isInEditor;

    if (!disabled && isInImage) {
      disabled = !["insertHorizontalRule", "removeFormat"].includes(command);
    }
    if (!disabled && command === "bold" && !hasSelection) {
      disabled = true;
    }

    button.disabled = disabled;
    button.style.opacity = disabled ? "0.4" : "";
    button.style.cursor = disabled ? "not-allowed" : "";
  });

  document.querySelectorAll(".editor-toolbar.secondary button[data-template]").forEach((button) => {
    const template = button.dataset.template;
    let disabled = !isInEditor;

    if (!disabled && template !== "image" && isInImage) {
      disabled = true;
    }

    button.disabled = disabled;
    button.style.opacity = disabled ? "0.4" : "";
    button.style.cursor = disabled ? "not-allowed" : "";
  });
}

// ── 自定义模板 ──

async function saveCustomTemplate() {
  const { view, setStatus, onWorkspaceInput } = _ctx;
  const selection = document.getSelection();
  if (!selection || selection.isCollapsed) {
    setStatus("请先选中编辑器中的一段内容，再保存为模板。", "warning");
    return;
  }

  const range = selection.getRangeAt(0);
  const container = document.createElement("div");
  container.appendChild(range.cloneContents());
  const html = container.innerHTML;

  const name = prompt("给这个模板起个名字：", "我的模板");
  if (!name || !name.trim()) return;

  const settings = await getSettings();
  const templates = { ...(settings.customTemplates || {}), [name.trim()]: html };
  await saveSettings({ customTemplates: templates });
  _ctx.state.settings = await getSettings();
  _loadCustomTemplates();
  setStatus(`模板「${name.trim()}」已保存。`, "success");
}

function _loadCustomTemplates() {
  const { controls } = _ctx;
  const templates = _ctx.state.settings?.customTemplates || {};
  const names = Object.keys(templates);
  if (!controls.customTemplateSelect) return;

  controls.customTemplateSelect.innerHTML = [
    '<option value="">自定义模板...</option>',
    ...names.map((n) => `<option value="${escapeAttribute(n)}">${escapeHtml(n)}</option>`)
  ].join("");
}

// ── Markdown 粘贴导入 ──

function _handleEditorPaste(event) {
  const { setStatus, onWorkspaceInput } = _ctx;
  const text = event.clipboardData.getData("text/plain");
  if (!text || text.length < 10) return;

  // 简单启发式：如果包含 # 标题或 * 列表，认为是 Markdown
  const looksLikeMarkdown = /^#+\s/m.test(text) || /^[\-*+]\s/m.test(text) || /\[.*?\]\(.*?\)/.test(text);
  if (!looksLikeMarkdown) return;

  event.preventDefault();
  const html = _simpleMarkdownToHtml(text);
  document.execCommand("insertHTML", false, html);
  onWorkspaceInput();
  setStatus("已识别 Markdown 并转换为富文本插入。", "success");
}

function _simpleMarkdownToHtml(md) {
  let html = escapeHtml(md);

  // 代码块
  html = html.replace(/```([\s\S]*?)```/g, "<pre><code>$1</code></pre>");

  // 标题
  html = html.replace(/^####\s+(.*)$/gm, "<h4>$1</h4>");
  html = html.replace(/^###\s+(.*)$/gm, "<h3>$1</h3>");
  html = html.replace(/^##\s+(.*)$/gm, "<h2>$1</h2>");
  html = html.replace(/^#\s+(.*)$/gm, "<h1>$1</h1>");

  // 粗体 / 斜体
  html = html.replace(/\*\*\*(.+?)\*\*\*/g, "<strong><em>$1</em></strong>");
  html = html.replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>");
  html = html.replace(/\*(.+?)\*/g, "<em>$1</em>");

  // 引用
  html = html.replace(/^&gt;\s+(.*)$/gm, "<blockquote>$1</blockquote>");

  // 无序列表
  html = html.replace(/^[\-*+]\s+(.*)$/gm, "<li>$1</li>");
  html = html.replace(/(<li>.*<\/li>\n?)+/g, (match) => `<ul>${match}</ul>`);

  // 链接 — 只允许 http/https 协议
  html = html.replace(/\[(.+?)\]\((.+?)\)/g, (match, text, url) => {
    const trimmed = (url || "").trim();
    if (!/^https?:\/\//i.test(trimmed)) {
      return escapeHtml(match);
    }
    return `<a href="${escapeAttribute(trimmed)}">${escapeHtml(text)}</a>`;
  });

  // 分隔线
  html = html.replace(/^---$/gm, "<hr />");

  // 段落
  html = html.replace(/\n\n/g, "</p><p>");
  html = html.replace(/\n/g, "<br />");

  return `<p>${html}</p>`;
}
