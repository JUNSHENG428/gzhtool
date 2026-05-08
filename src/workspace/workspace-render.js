/**
 * workspace-render.js
 * 负责：所有 DOM 渲染函数（renderXXX、syncWorkspace、fillThemeOptions 等）。
 * 通过 init(ctx) 接收跨模块依赖，不直接 import 其他 workspace-* 模块。
 */

import { WECHAT_WEB_EDITOR_URL, THEME_PRESETS } from "../shared/defaults.js";
import { escapeHtml, escapeAttribute, normalizeText, sanitizeHtml } from "../shared/utils.js";

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
  // 36th session 后续：发布面板「本次发布」列表跟着 bundle 同步
  _ctx.renderPublishArticleList?.();
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

  // 38th 续 9：渲染 block 列表带 checkbox + 置信度标记，让用户能在改写前
  // 剔除噪声段（评论/推荐/广告等抓取规则没去净的）。改写时 filter _disabled=true。
  const blocks = source.blocks || [];
  const visible = blocks.slice(0, 32);
  const totalEnabled = blocks.filter((b) => !b?._disabled).length;
  const headerHtml = `
    <header class="source-preview-head">
      <span class="source-preview-stat" id="sourcePreviewStat">已选 ${totalEnabled} / ${blocks.length} 块用于改写</span>
      <span class="source-preview-actions">
        <button type="button" class="ghost-button-mini" data-source-toggle-all="enable">全选</button>
        <button type="button" class="ghost-button-mini" data-source-toggle-all="disable">全不选</button>
      </span>
    </header>
  `;
  const moreHint = blocks.length > visible.length
    ? `<p class="source-preview-more-hint">仅显示前 ${visible.length} 块；剩余 ${blocks.length - visible.length} 块已默认选中，改写时会一起送入。</p>`
    : "";
  view.sourcePreview.innerHTML = headerHtml + visible
    .map((block, idx) => renderSourceBlock(block, source.images, idx))
    .join("") + moreHint;
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
    // 空态：不再让用户去对面找按钮，直接在这里就能上传 / 一键生成
    view.coverPreview.innerHTML = `
      <p><strong>还没有封面图。</strong>请用以下任一方式补一张：</p>
      <div class="cover-empty-actions">
        <button type="button" class="ghost" data-cover-action="upload">📷 上传本地图片</button>
        <button type="button" class="ghost" data-cover-action="generate">✨ 一键生成占位封面</button>
      </div>
      <p class="muted" style="margin-top:8px;">也可以到「编辑」页 → 采集信息里点任意图片「设为封面」。</p>
    `;
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

  const failedImages = state.lastPublishResult.failedImages || [];
  if (failedImages.length > 0) {
    lines.push(
      `<strong style="color:#c0392b">以下图片上传失败：</strong>` +
      failedImages
        .map(
          (f) =>
            `<br/>· 第 ${f.articleIndex} 篇 · ${f.type === "cover" ? "封面" : "正文图片"}：${escapeHtml(f.error || "上传失败")}`
        )
        .join("")
    );
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
  // 39th 续³ Batch 7 · Bug 2 · 状态卡入口与「mp 浮球 PULL」语义解耦标记：
  // 此卡只在用户主动点「💬 同步到公众号编辑页」按钮（syncCurrentToWebEditor）后更新；
  // mp 浮球 PULL（_buildPullReadyPayload + 浮球 toast「已同步...来自润笔」）走另一条流程
  // 不更新此 state。如果 syncedAt 距今 > 5 分钟，加陈旧标记，避免用户混淆「为什么浮球 toast
  // 显示成功，但状态卡还是『未完成』」（实际是上次主动同步留下的旧结果）。
  const syncedTs = Date.parse(state.lastWebSyncResult.syncedAt);
  const ageMs = Number.isFinite(syncedTs) ? Date.now() - syncedTs : 0;
  const isStale = ageMs > 5 * 60 * 1000;
  const syncedAt = new Date(state.lastWebSyncResult.syncedAt).toLocaleString("zh-CN");
  const lines = [];
  if (isStale) {
    lines.push(
      `<em style="color:#7a6f62;">这是 ${formatRelativeAge(ageMs)} 前主动「💬 同步到公众号编辑页」的结果。</em>`,
      `<em style="color:#7a6f62;">如果你刚通过 mp 浮球拉过新草稿，浮球 toast「已同步…」才是当前操作的最终状态——本卡片不会随浮球 PULL 更新。</em>`,
      ""
    );
  }
  lines.push(
    `<strong>网页编辑器同步结果</strong>`,
    `标题：${escapeHtml(state.lastWebSyncResult.articleTitle || "")}`,
    `页面：${escapeHtml(state.lastWebSyncResult.pageUrl || WECHAT_WEB_EDITOR_URL)}`,
    `标题写入：${state.lastWebSyncResult.titleWritten ? "成功" : "未完成"}`,
    `摘要写入：${state.lastWebSyncResult.digestWritten ? "成功" : "未完成"}`,
    `正文写入：${state.lastWebSyncResult.bodyWritten ? "成功" : "未完成"}`,
    `时间：${escapeHtml(syncedAt)}`
  );
  if (state.lastWebSyncResult.message) {
    lines.push(`说明：${escapeHtml(state.lastWebSyncResult.message)}`);
  }
  view.webEditorSyncResult.innerHTML = lines.join("<br />");
}

// 39th 续³ Batch 7 · 相对时间格式化（用于状态卡陈旧标记）
function formatRelativeAge(ms) {
  if (!Number.isFinite(ms) || ms <= 0) return "刚刚";
  const sec = Math.floor(ms / 1000);
  if (sec < 60) return `${sec} 秒`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min} 分钟`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr} 小时`;
  const day = Math.floor(hr / 24);
  return `${day} 天`;
}

// ── 预览 / 输出 ──

function renderPreview() {
  const { view, state } = _ctx;
  const article = _ctx.getCurrentArticle();
  const bodyHtml = sanitizeHtml(_ctx.buildExportHtmlForArticle(article));
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

/**
 * 38th 续 9：给 block 一个轻量"主体置信度"启发式评分。
 *  - 高（绿）：长段落 + 不含订阅/推荐/导航关键词
 *  - 中（黄）：中等长度 / 含部分可疑词 / 列表
 *  - 低（红）：短促 + 高密度 URL/CTA 字样 + 评论 UGC 风格 / 单 image 无 caption
 *  这是给用户的视觉提示，不强制剔除——用户自己决定是否取消勾选。
 */
function blockConfidence(block) {
  if (!block) return "low";
  if (block.type === "image") {
    const text = `${block.alt || ""} ${block.caption || ""}`.trim();
    return text.length > 6 ? "mid" : "low";
  }
  const text = String(block.text || "").trim();
  const len = text.length;
  if (len === 0) return "low";

  // 噪声特征（对应 buildHardConstraintMessage 主体识别 prompt 的 4 个判定信号）
  const noiseRe = /^(点击|click|share|分享|订阅|subscribe|关注|相关|推荐|更多|read more|continue|猜你喜欢|热门评论|相关阅读|广告|sponsored|advertisement|sponsor)/i;
  const ugcRe = /^(@\w|楼主|沙发|板凳|前排|顶|赞|回复\s|reply\s)/i;
  const urlDensity = (text.match(/https?:\/\//g) || []).length / Math.max(1, len / 200);
  if (noiseRe.test(text) || ugcRe.test(text)) return "low";
  if (len < 30 && urlDensity > 0.3) return "low";
  if (len < 20) return "low";
  if (len < 80) return "mid";
  return "high";
}

const CONFIDENCE_LABEL = { high: "主体", mid: "可能主体", low: "疑似噪声" };
const CONFIDENCE_TONE = { high: "ok", mid: "warn", low: "danger" };

function renderSourceBlock(block, images, idx) {
  const enabled = !block?._disabled;
  const confidence = blockConfidence(block);
  const checkboxId = `source-block-toggle-${idx}`;
  const confidenceBadge = `
    <span class="source-block-confidence" data-tone="${CONFIDENCE_TONE[confidence]}" title="启发式评估：${CONFIDENCE_LABEL[confidence]}">
      ${CONFIDENCE_LABEL[confidence]}
    </span>
  `;
  const toggleControls = `
    <label class="source-block-toggle" for="${checkboxId}">
      <input type="checkbox" id="${checkboxId}" data-source-block-index="${idx}" ${enabled ? "checked" : ""} aria-label="是否参与改写" />
      ${confidenceBadge}
    </label>
  `;

  if (block.type === "image") {
    const image = images[block.index - 1] || block;
    return `<article class="source-block image${enabled ? "" : " is-disabled"}" data-source-idx="${idx}">
      ${toggleControls}
      <img src="${escapeAttribute(image.src)}" alt="${escapeAttribute(image.alt || "")}" />
      <p>图片 ${block.index}${image.caption || image.alt ? `：${escapeHtml(image.caption || image.alt)}` : ""}</p>
    </article>`;
  }
  return `<article class="source-block ${escapeAttribute(block.type)}${enabled ? "" : " is-disabled"}" data-source-idx="${idx}">
    ${toggleControls}
    <div class="source-block-text">${escapeHtml(block.text || "")}</div>
  </article>`;
}
