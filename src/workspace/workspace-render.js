/**
 * workspace-render.js
 * 负责：所有 DOM 渲染函数（renderXXX、syncWorkspace、fillThemeOptions 等）。
 * 通过 init(ctx) 接收跨模块依赖，不直接 import 其他 workspace-* 模块。
 */

import { WECHAT_WEB_EDITOR_URL, THEME_PRESETS } from "../shared/defaults.js";
import { escapeHtml, escapeAttribute, normalizeText } from "../shared/utils.js";

let _ctx;

export function init(ctx) {
  _ctx = ctx;
}

// ── 顶层协调器 ──

export function syncWorkspace() {
  renderSource();
  renderArticleStack();
  renderCoverPreview();
  renderTitleSuggestions();
  renderKeywords();
  renderPublishResult();
  renderWebEditorSyncResult();
  renderPreview();
  syncOutputs();
  _ctx.applyTheme(_ctx.controls.theme.value);
}

// ── 主题 ──

export function fillThemeOptions() {
  _ctx.controls.theme.innerHTML = Object.entries(THEME_PRESETS)
    .map(
      ([value, preset]) =>
        `<option value="${escapeAttribute(value)}">${escapeHtml(preset.label)}</option>`
    )
    .join("");
}

export function applyTheme(themeName) {
  const classNames = Object.keys(THEME_PRESETS).map((key) => `theme-${key}`);
  _ctx.view.editor.classList.remove(...classNames);
  _ctx.view.editor.classList.add(`theme-${themeName}`);
}

// ── 来源面板 ──

export function renderSource() {
  const { view, controls, state } = _ctx;
  const source = state.source;
  const current = _ctx.getCurrentArticle();

  if (!source) {
    view.sourceMeta.innerHTML = "";
    view.imageRail.innerHTML = '<div class="source-block">还没有抓取来源页面。</div>';
    view.sourcePreview.innerHTML = "";
    controls.coverImageIndex.innerHTML = '<option value="0">未选择封面</option>';
    return;
  }

  const previousCoverValue =
    Number(controls.coverImageIndex.value || 0) || Number(current.meta.coverImageIndex || 0);

  view.sourceMeta.innerHTML = [
    createMetaItem("标题", source.title || "未识别"),
    createMetaItem("来源链接", source.url || "-"),
    createMetaItem("描述", source.description || "无"),
    createMetaItem(
      "统计",
      `${source.blocks.length} 个内容块 / ${source.images.length} 张图 / 约 ${source.wordCount} 字`
    )
  ].join("");

  controls.coverImageIndex.innerHTML = [
    '<option value="0">未选择封面</option>',
    ...(source.images || []).map(
      (image, index) =>
        `<option value="${index + 1}">图片 ${index + 1}${
          image.caption || image.alt
            ? ` · ${escapeHtml((image.caption || image.alt).slice(0, 24))}`
            : ""
        }</option>`
    )
  ].join("");

  if (previousCoverValue > 0 && previousCoverValue <= source.images.length) {
    controls.coverImageIndex.value = String(previousCoverValue);
  } else if (source.images.length > 0) {
    controls.coverImageIndex.value = "1";
  }

  view.imageRail.innerHTML =
    source.images.length > 0
      ? source.images
          .map((image, index) => {
            const imageIndex = index + 1;
            const isSelected = imageIndex === state.selectedImageIndex;
            const isCover = imageIndex === Number(controls.coverImageIndex.value || 0);
            return `<article class="image-card ${isSelected ? "is-selected" : ""} ${isCover ? "is-cover" : ""}" draggable="true" data-image-index="${imageIndex}">
              <img src="${escapeAttribute(image.src)}" alt="${escapeAttribute(image.alt || `图片 ${imageIndex}`)}" draggable="false" />
              <div>
                <p><strong>图片 ${imageIndex}</strong></p>
                <p>${escapeHtml(image.caption || image.alt || image.src)}</p>
                <div class="image-card-actions">
                  <button data-image-action="select" data-index="${imageIndex}">选中</button>
                  <button data-image-action="insert" data-index="${imageIndex}">插入正文</button>
                  <button data-image-action="cover" data-index="${imageIndex}">设为封面</button>
                  <button data-image-action="delete" data-index="${imageIndex}" class="ghost" style="color:#c0392b">删除</button>
                </div>
              </div>
            </article>`;
          })
          .join("")
      : '<div class="source-block">当前页面没有识别到可用配图。</div>';

  view.sourcePreview.innerHTML = source.blocks
    .slice(0, 32)
    .map((block) => renderSourceBlock(block, source.images))
    .join("");
}

// ── 文章堆叠 ──

export function renderArticleStack() {
  const { view, state } = _ctx;
  view.articleStack.innerHTML = state.articleBundle
    .map((article, index) => {
      const label = index === 0 ? "主篇" : `副篇 ${index}`;
      const digest = (article.meta.digest || _ctx.deriveDigestFromArticle(article)).slice(0, 42);
      const bodyText = normalizeText(
        new DOMParser().parseFromString(article.bodyHtml || "", "text/html").body.textContent || ""
      );
      return `<button class="article-card ${index === state.currentArticleIndex ? "active" : ""}" data-article-index="${index}">
        <div class="article-card-head">
          <span>${label}</span>
          <span class="stack-order">#${index + 1}</span>
        </div>
        <strong>${escapeHtml(article.meta.title || "未命名文章")}</strong>
        <div class="article-card-meta">
          <span>${bodyText.length} 字</span>
          <span>${article.meta.coverImageIndex ? `封面图 ${article.meta.coverImageIndex}` : "未选封面"}</span>
        </div>
        <p>${escapeHtml(digest || "还没有摘要")}</p>
      </button>`;
    })
    .join("");

  view.bundleSummary.textContent = buildBundleSummary();
}

// ── 封面预览 ──

export function renderCoverPreview() {
  const { view } = _ctx;
  const image = _ctx.getCoverImageForArticle(_ctx.getCurrentArticle());
  if (!image?.src) {
    view.coverPreview.innerHTML = "<p>还没有封面图。请在左侧来源图片里点"设为封面"。</p>";
    return;
  }
  view.coverPreview.innerHTML = `
    <img src="${escapeAttribute(image.src)}" alt="${escapeAttribute(image.alt || "封面图")}" />
    <p>${escapeHtml(image.caption || image.alt || "当前封面图")}</p>
  `;
}

// ── 标题建议 / 关键词 ──

function renderTitleSuggestions() {
  const { view } = _ctx;
  const current = _ctx.getCurrentArticle();
  if (current.meta.titleOptions.length === 0) {
    view.titleSuggestions.innerHTML = "";
    return;
  }
  view.titleSuggestions.innerHTML = current.meta.titleOptions
    .map(
      (title) =>
        `<button class="chip actionable" data-title-option="${escapeAttribute(title)}">${escapeHtml(title)}</button>`
    )
    .join("");
}

function renderKeywords() {
  const { view } = _ctx;
  const current = _ctx.getCurrentArticle();
  if (current.meta.keywords.length === 0) {
    view.keywordSuggestions.innerHTML = "";
    return;
  }
  view.keywordSuggestions.innerHTML = current.meta.keywords
    .map((keyword) => `<span class="chip">${escapeHtml(keyword)}</span>`)
    .join("");
}

// ── 发布结果 ──

function renderPublishResult() {
  const { view, state } = _ctx;
  if (!state.lastPublishResult) {
    view.publishResult.innerHTML =
      "发布结果会显示在这里。多图文发布后会显示草稿 media_id、publish_id 和最新轮询状态。";
    return;
  }
  const performedAt = new Date(state.lastPublishResult.performedAt).toLocaleString("zh-CN");
  const statusInfo = state.lastPublishResult.statusInfo;
  const lines = [
    `<strong>${state.lastPublishResult.requestedMode === "publish" ? "已提交发布任务" : "已推送草稿包"}</strong>`,
    `主篇标题：${escapeHtml(state.lastPublishResult.title || "")}`,
    `文章数量：${Number(state.lastPublishResult.articleCount || 1)} 篇`,
    `草稿 media_id：${escapeHtml(state.lastPublishResult.draftMediaId || "")}`,
    state.lastPublishResult.publishId
      ? `publish_id：${escapeHtml(state.lastPublishResult.publishId)}`
      : "",
    `正文图片：${Number(state.lastPublishResult.imageCount || 0)} 张`,
    `时间：${escapeHtml(performedAt)}`,
    state.lastPublishResult.publishId ? `轮询：${_ctx.isPolling() ? "进行中" : "已停止"}` : "",
    statusInfo ? `状态：${escapeHtml(statusInfo.statusText)}` : ""
  ].filter(Boolean);

  if (statusInfo?.articleUrls?.length) {
    lines.push(
      `文章链接：${statusInfo.articleUrls
        .map(
          (item) =>
            `<a href="${escapeAttribute(item.articleUrl)}" target="_blank" rel="noreferrer">第 ${item.index} 篇</a>`
        )
        .join(" / ")}`
    );
  }
  if (statusInfo?.failIndex?.length) {
    lines.push(`失败篇目：第 ${statusInfo.failIndex.join("、")} 篇`);
  }
  view.publishResult.innerHTML = lines.join("<br />");
}

// ── 网页编辑器同步结果 ──

function renderWebEditorSyncResult() {
  const { view, state } = _ctx;
  if (!state.lastWebSyncResult) {
    view.webEditorSyncResult.innerHTML =
      "网页编辑器辅助模式会把当前篇尝试写入 `mp.weixin.qq.com/cgi-bin/appmsg`。自动失败时，编辑页右下角会出现回退助手。";
    return;
  }
  const syncedAt = new Date(state.lastWebSyncResult.syncedAt).toLocaleString("zh-CN");
  const lines = [
    `<strong>网页编辑器同步结果</strong>`,
    `标题：${escapeHtml(state.lastWebSyncResult.articleTitle || "")}`,
    `页面：${escapeHtml(state.lastWebSyncResult.pageUrl || WECHAT_WEB_EDITOR_URL)}`,
    `标题写入：${state.lastWebSyncResult.titleWritten ? "成功" : "未完成"}`,
    `摘要写入：${state.lastWebSyncResult.digestWritten ? "成功" : "未完成"}`,
    `正文写入：${state.lastWebSyncResult.bodyWritten ? "成功" : "未完成"}`,
    `时间：${escapeHtml(syncedAt)}`
  ];
  if (state.lastWebSyncResult.message) {
    lines.push(`说明：${escapeHtml(state.lastWebSyncResult.message)}`);
  }
  view.webEditorSyncResult.innerHTML = lines.join("<br />");
}

// ── 预览 / 输出 ──

function renderPreview() {
  const { view, state } = _ctx;
  const article = _ctx.getCurrentArticle();
  const bodyHtml = _ctx.buildExportHtmlForArticle(article);
  view.wechatPreview.innerHTML = `
    <header class="preview-header">
      <h1>${escapeHtml(article.meta.title || "未命名文章")}</h1>
      <p class="preview-bundle">多图文中的第 ${state.currentArticleIndex + 1} / ${state.articleBundle.length} 篇</p>
      <p class="preview-meta">${escapeHtml(article.meta.author || "作者未填写")}${article.meta.contentSourceUrl ? ` · ${escapeHtml(article.meta.contentSourceUrl)}` : ""}</p>
      ${article.meta.digest ? `<p class="preview-digest">${escapeHtml(article.meta.digest)}</p>` : ""}
    </header>
    ${bodyHtml}
  `;
}

function syncOutputs() {
  const { view } = _ctx;
  const current = _ctx.getCurrentArticle();
  view.htmlOutput.value = _ctx.buildExportHtmlForArticle(current);
  view.markdownOutput.value = _ctx.buildMarkdownDocumentForArticle(current);
}

// ── 历史记录抽屉 ──

export function renderHistoryDrawer() {
  const { view, state } = _ctx;
  view.historyDrawer.classList.toggle("open", state.isHistoryDrawerOpen);
  view.historyDrawer.setAttribute("aria-hidden", String(!state.isHistoryDrawerOpen));
  view.historyDrawerBackdrop.hidden = !state.isHistoryDrawerOpen;

  if (state.historyEntries.length === 0) {
    view.historyDrawerList.innerHTML =
      '<div class="history-empty">还没有这篇的草稿记录。抓取网页、AI 改写或发布后，会自动留一份在这里。</div>';
    return;
  }

  view.historyDrawerList.innerHTML = state.historyEntries
    .map((entry) => {
      const createdAt = formatHistoryTime(entry.createdAt);
      const mainTitle =
        entry.articleBundle?.[0]?.meta?.title?.trim() || entry.sourcePreview?.title || "未命名文章";
      const articleCount = Array.isArray(entry.articleBundle) ? entry.articleBundle.length : 0;
      const sourceText = entry.sourcePreview?.title
        ? ` · 来源《${escapeHtml(entry.sourcePreview.title)}》`
        : "";
      const restoring = state.pendingRestoreHistoryId === entry.id;

      return `<article class="history-record">
        <div class="history-record-head">
          <span class="history-record-time">${escapeHtml(createdAt)}</span>
          <span class="history-record-label">${escapeHtml(entry.label || "自动记录")}</span>
        </div>
        <strong>${escapeHtml(mainTitle)}</strong>
        <p class="history-record-meta">共 ${articleCount} 篇文章${sourceText}</p>
        ${
          restoring
            ? `<p class="history-record-note">恢复前会先给你留一份"恢复前备份"，避免误操作。</p>
               <div class="history-record-actions">
                 <button data-history-action="confirm-restore" data-history-id="${escapeAttribute(entry.id)}">确认恢复</button>
                 <button class="ghost" data-history-action="cancel-restore" data-history-id="${escapeAttribute(entry.id)}">取消</button>
               </div>`
            : `<div class="history-record-actions">
                 <button class="ghost" data-history-action="restore" data-history-id="${escapeAttribute(entry.id)}">恢复</button>
                 <button class="ghost" data-history-action="delete" data-history-id="${escapeAttribute(entry.id)}">删除</button>
               </div>`
        }
      </article>`;
    })
    .join("");
}

// ── 工具函数 ──

function buildBundleSummary() {
  const { state } = _ctx;
  const articleCount = state.articleBundle.length;
  const totalChars = state.articleBundle.reduce((sum, article) => {
    const bodyText = normalizeText(
      new DOMParser().parseFromString(article.bodyHtml || "", "text/html").body.textContent || ""
    );
    return sum + bodyText.length;
  }, 0);
  const coverCount = state.articleBundle.filter(
    (article) => Number(article.meta.coverImageIndex || 0) > 0
  ).length;
  return `支持 1 篇主篇 + 最多 7 篇副篇。当前共 ${articleCount} 篇，约 ${totalChars} 字，已配置 ${coverCount} 张封面。可用 Alt + ↑ / Alt + ↓ 调整顺序。`;
}

function formatHistoryTime(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "时间未知";
  return date.toLocaleString("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit"
  });
}

export function createMetaItem(label, value) {
  return `<div class="meta-item"><span>${escapeHtml(label)}</span><p>${escapeHtml(value)}</p></div>`;
}

function renderSourceBlock(block, images) {
  if (block.type === "image") {
    const image = images[block.index - 1] || block;
    return `<article class="source-block image">
      <img src="${escapeAttribute(image.src)}" alt="${escapeAttribute(image.alt || "")}" />
      <p>图片 ${block.index}${image.caption || image.alt ? `：${escapeHtml(image.caption || image.alt)}` : ""}</p>
    </article>`;
  }
  return `<article class="source-block ${escapeAttribute(block.type)}">${escapeHtml(block.text || "")}</article>`;
}
