/**
 * workspace-state.js
 * 负责：state 对象、所有文章包操作、表单同步、持久化、schedulePersist。
 * 通过 init(ctx) 接收跨模块依赖，不直接 import 其他 workspace-* 模块。
 */

import { createArticleDraftState } from "../shared/article.js";
import {
  DEFAULT_ARTICLE_META,
  DEFAULT_SETTINGS,
  MAX_WECHAT_ARTICLES,
  THEME_PRESETS
} from "../shared/defaults.js";
import { saveSnapshot } from "../shared/history.js";
import { getSettings, saveSession } from "../shared/storage.js";
import { debounce, clampIndex, createId, normalizeText } from "../shared/utils.js";

let _ctx;

// ── 共享状态对象（可变引用，各模块通过 ctx.state 访问同一对象）──
export const state = {
  settings: DEFAULT_SETTINGS,
  session: null,
  source: null,
  articleBundle: [],
  currentArticleIndex: 0,
  selectedImageIndex: 0,
  lastPublishResult: null,
  lastWebSyncResult: null,
  historyEntries: [],
  isHistoryDrawerOpen: false,
  pendingRestoreHistoryId: null
};

export function init(ctx) {
  _ctx = ctx;
  _bindStateEvents();
}

function _bindStateEvents() {
  const { view, controls } = _ctx;

  // 图片列表操作
  view.imageRail.addEventListener("click", (event) => {
    const button = event.target.closest("[data-image-action]");
    if (!button) return;
    const index = Number(button.dataset.index);
    if (!index) return;

    if (button.dataset.imageAction === "insert") {
      state.selectedImageIndex = index;
      _ctx.insertSourceImage(index);
      return;
    }
    if (button.dataset.imageAction === "cover") {
      state.selectedImageIndex = index;
      controls.coverImageIndex.value = String(index);
      onWorkspaceInput();
      return;
    }
    if (button.dataset.imageAction === "select") {
      state.selectedImageIndex = index;
      _ctx.renderSource();
      _ctx.renderCoverPreview();
      schedulePersist();
      return;
    }
    if (button.dataset.imageAction === "delete") {
      deleteSourceImage(index);
      return;
    }
  });

  // 图片拖拽排序
  let dragSrcIndex = null;
  view.imageRail.addEventListener("dragstart", (event) => {
    const card = event.target.closest("[data-image-index]");
    if (!card) return;
    dragSrcIndex = Number(card.dataset.imageIndex);
    card.style.opacity = "0.4";
    event.dataTransfer.effectAllowed = "move";
  });
  view.imageRail.addEventListener("dragend", (event) => {
    const card = event.target.closest("[data-image-index]");
    if (card) card.style.opacity = "";
    dragSrcIndex = null;
  });
  view.imageRail.addEventListener("dragover", (event) => {
    event.preventDefault();
    event.dataTransfer.dropEffect = "move";
    const card = event.target.closest("[data-image-index]");
    if (card) card.style.borderColor = "#4f83c2";
  });
  view.imageRail.addEventListener("dragleave", (event) => {
    const card = event.target.closest("[data-image-index]");
    if (card) card.style.borderColor = "";
  });
  view.imageRail.addEventListener("drop", (event) => {
    event.preventDefault();
    const card = event.target.closest("[data-image-index]");
    if (!card || dragSrcIndex === null) return;
    const dropTargetIndex = Number(card.dataset.imageIndex);
    if (dropTargetIndex === dragSrcIndex) return;
    reorderSourceImages(dragSrcIndex - 1, dropTargetIndex - 1);
  });

  // 文章堆叠切换
  view.articleStack.addEventListener("click", (event) => {
    const button = event.target.closest("[data-article-index]");
    if (!button) return;
    const index = Number(button.dataset.articleIndex);
    if (!Number.isInteger(index)) return;
    switchArticle(index);
  });

  // 标题建议 chip
  view.titleSuggestions.addEventListener("click", (event) => {
    const chip = event.target.closest("[data-title-option]");
    if (!chip) return;
    controls.title.value = chip.dataset.titleOption || "";
    onWorkspaceInput();
  });

  // 文章包管理按钮
  document.querySelector("#addSubArticleButton").addEventListener("click", addSubArticle);
  document.querySelector("#moveArticleUpButton").addEventListener("click", () => moveCurrentArticle(-1));
  document.querySelector("#moveArticleDownButton").addEventListener("click", () => moveCurrentArticle(1));
  document.querySelector("#duplicateArticleButton").addEventListener("click", duplicateCurrentArticle);
  document.querySelector("#removeArticleButton").addEventListener("click", removeCurrentArticle);
  document.querySelector("#exportBundleButton").addEventListener("click", exportBundle);
  document.querySelector("#importBundleButton").addEventListener("click", () => {
    _ctx.controls.bundleImport.click();
  });
  _ctx.controls.bundleImport.addEventListener("change", importBundleFromFile);
}

// ── 初始化 ──

export function hydrateDefaults() {
  const { controls } = _ctx;
  controls.audience.value = state.settings.defaultAudience || DEFAULT_SETTINGS.defaultAudience;
  controls.tone.value = state.settings.defaultTone || DEFAULT_SETTINGS.defaultTone;
  controls.angle.value = state.settings.defaultAngle || DEFAULT_SETTINGS.defaultAngle;
  controls.cta.value = state.settings.defaultCta || DEFAULT_SETTINGS.defaultCta;
  controls.length.value = state.settings.defaultLength || DEFAULT_SETTINGS.defaultLength;
  controls.theme.value = state.session?.lastTheme || "editorial-green";
  _ctx.applyTheme(controls.theme.value);
}

export function restoreSession() {
  state.source = state.session?.lastCapture || null;
  state.lastPublishResult = state.session?.lastPublishResult || null;
  state.lastWebSyncResult = state.session?.lastWebSyncResult || null;
  state.selectedImageIndex = Number(state.session?.selectedImageIndex || 0);

  if (Array.isArray(state.session?.articleBundle) && state.session.articleBundle.length > 0) {
    state.articleBundle = state.session.articleBundle.map(normalizeArticleDoc);
    state.currentArticleIndex = clampIndex(
      Number(state.session?.currentArticleIndex || 0),
      state.articleBundle.length
    );
  } else if (state.session?.lastDraft) {
    const draftState = createArticleDraftState(state.session.lastDraft, state.source?.images || []);
    state.articleBundle = [_createArticleDocFromDraftState(draftState)];
  } else if (state.session?.lastBodyHtml || state.session?.lastArticleMeta) {
    state.articleBundle = [
      normalizeArticleDoc({
        id: createArticleId(),
        meta: { ...buildBaseArticleMeta(), ...(state.session.lastArticleMeta || {}) },
        bodyHtml: state.session.lastBodyHtml || ""
      })
    ];
  } else {
    state.articleBundle = [createEmptyArticleDoc()];
  }

  applyCurrentArticleToControls();
}

function _createArticleDocFromDraftState(draftState) {
  return normalizeArticleDoc({
    id: createArticleId(),
    meta: {
      ...buildBaseArticleMeta(),
      title: draftState.meta.title || "",
      subtitle: draftState.meta.subtitle || "",
      lead: draftState.meta.lead || "",
      cta: draftState.meta.cta || "",
      digest: draftState.meta.digest || "",
      coverImageIndex: draftState.meta.coverImageIndex || 0,
      titleOptions: draftState.meta.titleOptions || [],
      keywords: draftState.meta.keywords || []
    },
    bodyHtml: draftState.bodyHtml || ""
  });
}

export function createEmptyArticleDoc() {
  return normalizeArticleDoc({ id: createArticleId(), meta: buildBaseArticleMeta(), bodyHtml: "" });
}

export function normalizeArticleDoc(articleDoc) {
  const meta = { ...buildBaseArticleMeta(), ...(articleDoc?.meta || {}) };
  return {
    id: articleDoc?.id || createArticleId(),
    meta: {
      ...meta,
      titleOptions: Array.isArray(meta.titleOptions) ? meta.titleOptions : [],
      keywords: Array.isArray(meta.keywords) ? meta.keywords : []
    },
    bodyHtml: String(articleDoc?.bodyHtml || "")
  };
}

function buildBaseArticleMeta() {
  return {
    ...DEFAULT_ARTICLE_META,
    author: state.settings.wechatDefaultAuthor || "",
    contentSourceUrl: state.source?.url || state.settings.wechatDefaultSourceUrl || "",
    publishMode: state.settings.wechatDefaultPublishMode || DEFAULT_SETTINGS.wechatDefaultPublishMode,
    needOpenComment: Boolean(state.settings.wechatDefaultOpenComment),
    onlyFansCanComment: Boolean(state.settings.wechatDefaultOnlyFansCanComment)
  };
}

// ── 文章读写 ──

export function getCurrentArticle() {
  if (state.articleBundle.length === 0) {
    state.articleBundle = [createEmptyArticleDoc()];
    state.currentArticleIndex = 0;
  }
  return state.articleBundle[state.currentArticleIndex];
}

export function applyCurrentArticleToControls() {
  const { controls, view } = _ctx;
  const article = getCurrentArticle();
  if (!article) return;

  controls.title.value = article.meta.title || "";
  controls.subtitle.value = article.meta.subtitle || "";
  controls.author.value = article.meta.author || state.settings.wechatDefaultAuthor || "";
  controls.digest.value = article.meta.digest || "";
  controls.sourceUrl.value =
    article.meta.contentSourceUrl || state.source?.url || state.settings.wechatDefaultSourceUrl || "";
  controls.lead.value = article.meta.lead || "";
  controls.cta.value = article.meta.cta || state.settings.defaultCta || "";
  controls.publishMode.value = article.meta.publishMode || controls.publishMode.value || "draft";
  controls.needOpenComment.checked = Boolean(article.meta.needOpenComment);
  controls.onlyFansCanComment.checked = Boolean(article.meta.onlyFansCanComment);
  controls.coverImageIndex.value = String(article.meta.coverImageIndex || 0);
  view.editor.innerHTML = article.bodyHtml || "";

  if (!state.selectedImageIndex && article.meta.coverImageIndex) {
    state.selectedImageIndex = article.meta.coverImageIndex;
  }
}

export function syncCurrentArticleFromControls() {
  const { view } = _ctx;
  const article = getCurrentArticle();
  if (!article) return;
  article.meta = collectCurrentArticleMeta();
  article.bodyHtml = view.editor.innerHTML;
}

export function collectRewritePreferences() {
  const { controls } = _ctx;
  return {
    audience: controls.audience.value.trim(),
    tone: controls.tone.value.trim(),
    angle: controls.angle.value.trim(),
    cta: controls.cta.value.trim(),
    length: controls.length.value
  };
}

export function collectCurrentArticleMeta() {
  const { controls } = _ctx;
  const current = getCurrentArticle();
  return {
    ...DEFAULT_ARTICLE_META,
    ...current.meta,
    title: controls.title.value.trim(),
    subtitle: controls.subtitle.value.trim(),
    lead: controls.lead.value.trim(),
    cta: controls.cta.value.trim(),
    author: controls.author.value.trim(),
    digest: controls.digest.value.trim() || deriveDigestFromEditor(),
    contentSourceUrl: controls.sourceUrl.value.trim() || state.source?.url || "",
    coverImageIndex: Number(controls.coverImageIndex.value || 0),
    needOpenComment: controls.needOpenComment.checked,
    onlyFansCanComment: controls.onlyFansCanComment.checked,
    publishMode: controls.publishMode.value
  };
}

// ── 文章包操作 ──

export function addSubArticle() {
  syncCurrentArticleFromControls();
  if (state.articleBundle.length >= MAX_WECHAT_ARTICLES) {
    _ctx.setStatus(`最多支持 ${MAX_WECHAT_ARTICLES} 篇图文。`, "warning");
    return;
  }
  const next = createEmptyArticleDoc();
  next.meta.title = `副篇 ${state.articleBundle.length}`;
  state.articleBundle.push(next);
  state.currentArticleIndex = state.articleBundle.length - 1;
  applyCurrentArticleToControls();
  _ctx.syncWorkspace();
  schedulePersist();
}

export function duplicateCurrentArticle() {
  syncCurrentArticleFromControls();
  if (state.articleBundle.length >= MAX_WECHAT_ARTICLES) {
    _ctx.setStatus(`最多支持 ${MAX_WECHAT_ARTICLES} 篇图文。`, "warning");
    return;
  }
  const current = getCurrentArticle();
  const clone = normalizeArticleDoc({
    id: createArticleId(),
    meta: {
      ...current.meta,
      title: current.meta.title ? `${current.meta.title}（副本）` : "未命名副本"
    },
    bodyHtml: current.bodyHtml
  });
  state.articleBundle.splice(state.currentArticleIndex + 1, 0, clone);
  state.currentArticleIndex += 1;
  applyCurrentArticleToControls();
  _ctx.syncWorkspace();
  schedulePersist();
}

export function moveCurrentArticle(direction) {
  syncCurrentArticleFromControls();
  const nextIndex = state.currentArticleIndex + Number(direction || 0);
  if (nextIndex < 0 || nextIndex >= state.articleBundle.length) {
    _ctx.setStatus(direction < 0 ? "当前篇已经在最前面。" : "当前篇已经在最后面。", "warning");
    return;
  }
  const [current] = state.articleBundle.splice(state.currentArticleIndex, 1);
  state.articleBundle.splice(nextIndex, 0, current);
  state.currentArticleIndex = nextIndex;
  applyCurrentArticleToControls();
  _ctx.syncWorkspace();
  schedulePersist();
  _ctx.setStatus(direction < 0 ? "当前篇已前移。" : "当前篇已后移。", "success");
}

export function removeCurrentArticle() {
  syncCurrentArticleFromControls();
  if (state.articleBundle.length <= 1) {
    _ctx.setStatus("至少保留一篇文章。", "warning");
    return;
  }
  state.articleBundle.splice(state.currentArticleIndex, 1);
  state.currentArticleIndex = clampIndex(state.currentArticleIndex, state.articleBundle.length);
  applyCurrentArticleToControls();
  _ctx.syncWorkspace();
  schedulePersist();
}

export function switchArticle(index) {
  if (index === state.currentArticleIndex) return;
  syncCurrentArticleFromControls();
  state.currentArticleIndex = clampIndex(index, state.articleBundle.length);
  applyCurrentArticleToControls();
  _ctx.syncWorkspace();
  schedulePersist();
}

// ── 导入 / 导出 ──

export async function exportBundle() {
  const { controls } = _ctx;
  syncCurrentArticleFromControls();
  const payload = {
    version: 1,
    exportedAt: new Date().toISOString(),
    source: state.source,
    articleBundle: state.articleBundle,
    currentArticleIndex: state.currentArticleIndex,
    selectedImageIndex: state.selectedImageIndex,
    theme: controls.theme.value
  };
  const title = (state.articleBundle[0]?.meta.title || "wechat-bundle").replace(/[^\w\u4e00-\u9fa5-]+/g, "-");
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = `${title || "wechat-bundle"}.bundle.json`;
  anchor.click();
  URL.revokeObjectURL(url);
  _ctx.setStatus("草稿包 JSON 已导出。", "success");
}

export async function importBundleFromFile(event) {
  const file = event.target.files?.[0];
  event.target.value = "";
  if (!file) return;
  try {
    _ctx.showLoading("正在导入草稿包...");
    const text = await file.text();
    const payload = JSON.parse(text);
    applyImportedBundle(payload);
    schedulePersist();
    _ctx.setStatus("草稿包已导入。", "success");
  } catch (error) {
    _ctx.setStatus(error.message || "草稿包导入失败。", "error");
  } finally {
    _ctx.hideLoading();
  }
}

export function applyImportedBundle(payload) {
  const { controls } = _ctx;
  if (!Array.isArray(payload?.articleBundle) || payload.articleBundle.length === 0) {
    throw new Error("草稿包格式不正确：缺少 articleBundle。");
  }
  state.source = normalizeImportedSource(payload.source);
  state.articleBundle = payload.articleBundle.map(normalizeArticleDoc);
  state.currentArticleIndex = clampIndex(Number(payload.currentArticleIndex || 0), state.articleBundle.length);
  state.selectedImageIndex = normalizeImportedSelectedImageIndex(
    payload.selectedImageIndex,
    state.source?.images?.length || 0
  );
  state.lastPublishResult = null;
  state.lastWebSyncResult = null;
  _ctx.clearPublishPolling();
  if (payload.theme && THEME_PRESETS[payload.theme]) {
    controls.theme.value = payload.theme;
  }
  applyCurrentArticleToControls();
  _ctx.syncWorkspace();
}

// ── 持久化 ──

export function onWorkspaceInput() {
  syncCurrentArticleFromControls();
  _ctx.syncWorkspace();
  _ctx.updateEditorWordCount();
  schedulePersist();
}

export const schedulePersist = debounce(() => {
  _persistWorkspaceState().catch(() => {});
}, 250);

async function _persistWorkspaceState() {
  const { controls } = _ctx;
  state.session = await saveSession({
    lastCapture: state.source,
    articleBundle: state.articleBundle,
    currentArticleIndex: state.currentArticleIndex,
    lastBodyHtml: getCurrentArticle().bodyHtml,
    lastArticleMeta: getCurrentArticle().meta,
    lastTheme: controls.theme.value,
    lastPublishResult: state.lastPublishResult,
    lastWebSyncResult: state.lastWebSyncResult,
    selectedImageIndex: state.selectedImageIndex
  });
}

// ── 辅助函数 ──

export function normalizeImportedSource(source) {
  if (!source || typeof source !== "object") return null;
  const images = Array.isArray(source.images)
    ? source.images
        .map((image) => ({
          src: String(image?.src || "").trim(),
          alt: String(image?.alt || "").trim(),
          caption: String(image?.caption || "").trim()
        }))
        .filter((image) => image.src)
    : [];
  const blocks = Array.isArray(source.blocks)
    ? source.blocks
        .map((block, index) => ({
          type: String(block?.type || "paragraph"),
          text: String(block?.text || ""),
          index: Number(block?.index || index + 1)
        }))
        .filter((block) => block.text || block.type === "image")
    : [];
  return {
    title: String(source.title || "").trim(),
    url: String(source.url || "").trim(),
    description: String(source.description || "").trim(),
    wordCount:
      Number(source.wordCount || 0) || blocks.reduce((sum, block) => sum + String(block.text || "").length, 0),
    images,
    blocks
  };
}

export function normalizeImportedSelectedImageIndex(value, imageCount) {
  const index = Number(value || 0);
  if (!Number.isInteger(index) || index < 0) return 0;
  if (index > imageCount) return imageCount > 0 ? 1 : 0;
  return index;
}

export function deriveDigestFromEditor() {
  const { view } = _ctx;
  const text = normalizeText(view.editor.textContent || "");
  return text.slice(0, 120);
}

export function deriveDigestFromArticle(article) {
  const text = normalizeText(
    new DOMParser().parseFromString(article.bodyHtml || "", "text/html").body.textContent || ""
  );
  return (article.meta.digest || text).slice(0, 120);
}

export function getCoverImageForArticle(article) {
  return state.source?.images?.[Number(article.meta.coverImageIndex || 0) - 1] || null;
}

export function getSelectedImage() {
  if (state.selectedImageIndex) {
    return state.source?.images?.[state.selectedImageIndex - 1] || null;
  }
  return getCoverImageForArticle(getCurrentArticle());
}

export function createArticleId() {
  return createId("article");
}

export function hasMeaningfulDraftState() {
  if (state.source) return true;
  return state.articleBundle.some((article) => {
    const bodyText = normalizeText(
      new DOMParser().parseFromString(article.bodyHtml || "", "text/html").body.textContent || ""
    );
    return Boolean(
      article.meta.title || article.meta.digest || article.meta.subtitle ||
      article.meta.contentSourceUrl || bodyText
    );
  });
}

export function buildHistoryLabel(label) {
  const mainTitle = state.articleBundle?.[0]?.meta?.title?.trim() || state.source?.title || "";
  return mainTitle ? `${label} · ${mainTitle}` : label;
}

export function validateCurrentArticleForPublish() {
  const article = getCurrentArticle();
  const meta = article.meta;
  const errors = [];
  if (meta.title.length > 64)
    errors.push(`标题超出公众号限制（当前 ${meta.title.length} 字，最多 64 字）`);
  if (meta.subtitle.length > 32)
    errors.push(`副标题超出公众号限制（当前 ${meta.subtitle.length} 字，最多 32 字）`);
  if (meta.author.length > 8)
    errors.push(`作者超出公众号限制（当前 ${meta.author.length} 字，最多 8 字）`);
  if (meta.digest.length > 120)
    errors.push(`摘要超出公众号限制（当前 ${meta.digest.length} 字，最多 120 字）`);
  if (errors.length > 0) return errors.join("；") + "。请修正后再发布。";
  return null;
}
