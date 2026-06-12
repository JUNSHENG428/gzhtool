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
import { debounce, clampIndex, createId, normalizeText, sanitizeHtml, safeObjectMerge } from "../shared/utils.js";

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

  // 38th 续 9：「采集信息」block 列表的可勾选交互
  // - checkbox change：切换 state.source.blocks[idx]._disabled 标记 + 刷新统计 + 重渲染
  // - "全选/全不选"按钮：批量切
  // 改写时 workspace-rewrite.js 走 state.source 路径会 filter _disabled，
  // 让用户能精确控制哪些段进 LLM
  view.sourcePreview?.addEventListener("change", (event) => {
    const target = event.target;
    if (!(target instanceof HTMLInputElement)) return;
    if (target.dataset.sourceBlockIndex === undefined) return;
    const idx = Number(target.dataset.sourceBlockIndex);
    const block = state.source?.blocks?.[idx];
    if (!block) return;
    block._disabled = !target.checked;
    schedulePersist();
    _ctx.renderSource();
  });
  view.sourcePreview?.addEventListener("click", (event) => {
    const allBtn = event.target.closest("[data-source-toggle-all]");
    if (!allBtn) return;
    const blocks = state.source?.blocks;
    if (!Array.isArray(blocks) || blocks.length === 0) return;
    const enableAll = allBtn.dataset.sourceToggleAll === "enable";
    blocks.forEach((b) => {
      if (b) b._disabled = !enableAll;
    });
    schedulePersist();
    _ctx.renderSource();
  });

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
    _ctx.refreshFieldHints?.();
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

  // P1.3 · 封面救济：上传本地图片做封面 / 一键生成占位封面
  // 这两个按钮放在「采集信息」面板顶部，无图也能补图，直接复用现有图片管线。
  const uploadCoverButton = document.querySelector("#uploadCoverButton");
  const generateCoverButton = document.querySelector("#generateCoverButton");
  if (uploadCoverButton && _ctx.controls.coverUploadInput) {
    uploadCoverButton.addEventListener("click", () => {
      _ctx.controls.coverUploadInput.value = "";
      _ctx.controls.coverUploadInput.click();
    });
    _ctx.controls.coverUploadInput.addEventListener("change", async (event) => {
      const file = event.target.files?.[0];
      if (!file) return;
      try {
        await addCustomImageFromFile(file);
        _ctx.setStatus(
          `已上传「${file.name}」并设为当前文章封面。要放进正文，请在左侧图库中点该图，再使用编辑区「插入选中图片」。`,
          "success"
        );
      } catch (error) {
        _ctx.setStatus(error?.message || "上传图片失败。", "error");
      } finally {
        _ctx.controls.coverUploadInput.value = "";
      }
    });
  }
  if (generateCoverButton) {
    generateCoverButton.addEventListener("click", async () => {
      try {
        await useGeneratedPlaceholderCover();
        _ctx.setStatus("已生成简洁占位封面并设为当前文章封面。", "success");
      } catch (error) {
        _ctx.setStatus(error?.message || "生成占位封面失败。", "error");
      }
    });
  }

  // 「发布」面板里 #coverPreview 空态也提供同样两个按钮，不用切回编辑页
  _ctx.view.coverPreview.addEventListener("click", async (event) => {
    const button = event.target.closest("[data-cover-action]");
    if (!button) return;
    const action = button.dataset.coverAction;
    if (action === "upload" && _ctx.controls.coverUploadInput) {
      _ctx.controls.coverUploadInput.value = "";
      _ctx.controls.coverUploadInput.click();
    } else if (action === "generate") {
      try {
        await useGeneratedPlaceholderCover();
        _ctx.setStatus("已生成简洁占位封面并设为当前文章封面。", "success");
      } catch (error) {
        _ctx.setStatus(error?.message || "生成占位封面失败。", "error");
      }
    }
  });
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
  const meta = safeObjectMerge(buildBaseArticleMeta(), articleDoc?.meta || {});
  return {
    id: articleDoc?.id || createArticleId(),
    meta: {
      ...meta,
      titleOptions: Array.isArray(meta.titleOptions) ? meta.titleOptions : [],
      keywords: Array.isArray(meta.keywords) ? meta.keywords : [],
      // 旧 storage 没 publishEnabled 字段时默认 true，向后兼容（首次升级用户
      // 看到的行为：所有现有文章都默认勾选 = 原行为，无任何破坏）
      publishEnabled: meta.publishEnabled !== false
    },
    bodyHtml: sanitizeHtml(String(articleDoc?.bodyHtml || ""))
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

  // 程序化赋值不会触发 input 事件，需要手动刷新字数计数（标题/作者/摘要三个字段提示）。
  _ctx.refreshFieldHints?.();
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
  // 当前编辑台「发布账号」下拉选中的 wechatProfile index。-1 = 默认账号（未关联具体 profile）。
  // 浮球 PULL 时与 mp 后台导航栏当前账号名做匹配防止串号。每次 syncCurrentArticleFromControls
  // 都同步写一次，让用户在编辑台切换发布账号时草稿元数据立刻更新。
  const profileIndexRaw = Number(controls.wechatProfileSelect?.value ?? -1);
  const targetProfileIndex = Number.isFinite(profileIndexRaw) ? profileIndexRaw : -1;
  return {
    ...DEFAULT_ARTICLE_META,
    ...current.meta,
    title: controls.title.value.trim(),
    lead: controls.lead.value.trim(),
    cta: controls.cta.value.trim(),
    author: controls.author.value.trim(),
    digest: controls.digest.value.trim() || deriveDigestFromEditor(),
    contentSourceUrl: controls.sourceUrl.value.trim() || state.source?.url || "",
    coverImageIndex: Number(controls.coverImageIndex.value || 0),
    needOpenComment: controls.needOpenComment.checked,
    onlyFansCanComment: controls.onlyFansCanComment.checked,
    publishMode: controls.publishMode.value,
    targetProfileIndex
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
  _ctx.setStatus("草稿包备份已保存到本机。", "success");
}

function _userFacingBundleImportError(error) {
  if (error instanceof SyntaxError) {
    return "无法识别该文件内容。请确认所选文件是用「导出备份」保存的草稿包。";
  }
  const msg = String(error?.message || "");
  if (msg.includes("articleBundle")) {
    return "这个文件不是本扩展的草稿备份。请选「导出备份」生成的 .bundle 文件。";
  }
  return msg || "恢复失败，请重试。";
}

export async function importBundleFromFile(event) {
  const file = event.target.files?.[0];
  event.target.value = "";
  if (!file) return;
  try {
    _ctx.showLoading("正在从备份恢复", "读取并校验本机文件…");
    const text = await file.text();
    const payload = JSON.parse(text);
    applyImportedBundle(payload);
    schedulePersist();
    _ctx.setStatus("已从备份恢复草稿包。", "success");
  } catch (error) {
    const detail = error instanceof Error ? error : new Error(String(error));
    console.warn("[import bundle]", detail);
    _ctx.setStatus(_userFacingBundleImportError(detail), "error");
  } finally {
    _ctx.hideLoading();
  }
}

export function applyImportedBundle(payload) {
  const { controls } = _ctx;
  if (!Array.isArray(payload?.articleBundle) || payload.articleBundle.length === 0) {
    throw new Error("这个文件不是有效的草稿备份（缺少可恢复的稿件）。");
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
    // 新增：保留 author / siteName，让 autoFillEditorFromSource 能填进作者输入框
    // 公众号 author API 上限 16 字符
    author: String(source.author || "").trim().slice(0, 16),
    siteName: String(source.siteName || "").trim(),
    // 45th 续：保留 origin（"brief" = 自拟主题创作），备份恢复后重试仍走创作语义
    origin: String(source.origin || "").trim(),
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

// ── 封面救济（P1.3）────────────────────────────────────────────────
// 三套自助补图工具：
//   - addCustomImageFromFile(file)：用户上传本地图，转 data URL 后 push 进 source.images
//   - generatePlaceholderCoverDataUrl(title)：纯函数，用 OffscreenCanvas/Canvas 画一张 900x500 渐变 + 标题封面
//   - useGeneratedPlaceholderCover()：高层 helper，给当前文章一键生成并设为封面
//   - ensureFallbackCoverImage(article)：发布兜底，用于 publishBundle 在用户没选时自动补
//
// 为什么要走 source.images 这条线：
//   微信 add_draft 必填 thumb_media_id，且现有 wechat.js 上传管线只认 cover.src。
//   把"补的图"也作为 source.images 的一员，复用现有 cover preview / cover select / 上传管线，
//   避免对 wechat.js 做"虚拟封面源"的特殊分支，最少侵入。

const MAX_LOCAL_COVER_BYTES = 5 * 1024 * 1024; // 5MB；wechat.js 内部还会再压到 2MB
const ALLOWED_COVER_MIME = new Set([
  "image/jpeg",
  "image/jpg",
  "image/png",
  "image/gif",
  "image/webp",
  "image/bmp"
]);

function _ensureSourceShell() {
  if (!state.source) {
    state.source = {
      title: "",
      url: "",
      description: "",
      author: "",
      siteName: "",
      wordCount: 0,
      images: [],
      blocks: []
    };
  }
  if (!Array.isArray(state.source.images)) state.source.images = [];
  if (!Array.isArray(state.source.blocks)) state.source.blocks = [];
}

function _readFileAsDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ""));
    reader.onerror = () => reject(new Error("读取本地图片失败，请换一张试试。"));
    reader.readAsDataURL(file);
  });
}

export async function addCustomImageFromFile(file) {
  if (!file || typeof file !== "object") {
    throw new Error("没有选择文件。");
  }
  const mime = String(file.type || "").toLowerCase();
  if (!mime.startsWith("image/") || !ALLOWED_COVER_MIME.has(mime)) {
    throw new Error("只能上传 JPG / PNG / GIF / WEBP / BMP 格式的图片。");
  }
  if (Number(file.size) > MAX_LOCAL_COVER_BYTES) {
    throw new Error(
      `图片体积 ${(file.size / 1024 / 1024).toFixed(1)}MB 超过 5MB 上限，请压缩后再上传（公众号封面最终会进一步压到 ≤ 2MB）。`
    );
  }
  const dataUrl = await _readFileAsDataUrl(file);
  if (!dataUrl.startsWith("data:image/")) {
    throw new Error("文件内容不是有效图片。");
  }

  _ensureSourceShell();
  const newImage = {
    src: dataUrl,
    alt: file.name || "本地上传图片",
    caption: "本地上传"
  };
  state.source.images.push(newImage);
  const newIndex = state.source.images.length;

  const article = getCurrentArticle();
  article.meta.coverImageIndex = newIndex;
  state.selectedImageIndex = newIndex;
  if (_ctx.controls.coverImageIndex) {
    _ctx.controls.coverImageIndex.value = String(newIndex);
  }
  _ctx.syncWorkspace();
  schedulePersist();
  return newImage;
}

export async function generatePlaceholderCoverDataUrl(title) {
  const W = 900;
  const H = 500;
  const text = String(title || "公众号文章").trim().slice(0, 60) || "公众号文章";

  // 优先 OffscreenCanvas（service worker 可复用），不可用就回落 DOM canvas
  let canvas;
  if (typeof OffscreenCanvas !== "undefined") {
    canvas = new OffscreenCanvas(W, H);
  } else {
    canvas = document.createElement("canvas");
    canvas.width = W;
    canvas.height = H;
  }
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("当前环境不支持 canvas，无法生成占位封面。");

  // 渐变背景 + 一个微妙的高光圆，避免纯色发黑或廉价
  const grad = ctx.createLinearGradient(0, 0, W, H);
  grad.addColorStop(0, "#1f3a5f");
  grad.addColorStop(1, "#3d6b8f");
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, W, H);

  ctx.save();
  ctx.globalAlpha = 0.18;
  const radial = ctx.createRadialGradient(W * 0.78, H * 0.25, 20, W * 0.78, H * 0.25, 380);
  radial.addColorStop(0, "#ffffff");
  radial.addColorStop(1, "rgba(255,255,255,0)");
  ctx.fillStyle = radial;
  ctx.fillRect(0, 0, W, H);
  ctx.restore();

  // 顶部标签
  ctx.fillStyle = "rgba(255,255,255,0.65)";
  ctx.font = "500 22px -apple-system, 'PingFang SC', 'Microsoft YaHei', sans-serif";
  ctx.textBaseline = "top";
  ctx.fillText("DocuEarn · 占位封面", 48, 44);

  // 标题（自动换行，最多 3 行）
  ctx.fillStyle = "#ffffff";
  ctx.textBaseline = "middle";
  ctx.font = "700 56px -apple-system, 'PingFang SC', 'Microsoft YaHei', sans-serif";
  _drawWrappedText(ctx, text, 48, H / 2, W - 96, 70, 3);

  // 底部辅助线 + 副标题
  ctx.strokeStyle = "rgba(255,255,255,0.45)";
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(48, H - 80);
  ctx.lineTo(160, H - 80);
  ctx.stroke();
  ctx.fillStyle = "rgba(255,255,255,0.7)";
  ctx.font = "500 20px -apple-system, 'PingFang SC', 'Microsoft YaHei', sans-serif";
  ctx.textBaseline = "top";
  ctx.fillText("自动生成 · 建议替换为更合适的图片", 48, H - 60);

  if (typeof canvas.convertToBlob === "function") {
    const blob = await canvas.convertToBlob({ type: "image/png" });
    return await new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result || ""));
      reader.onerror = () => reject(new Error("生成的封面无法序列化。"));
      reader.readAsDataURL(blob);
    });
  }
  return canvas.toDataURL("image/png");
}

function _drawWrappedText(ctx, text, x, centerY, maxWidth, lineHeight, maxLines) {
  // 中文逐字测；英文按空格切再保底逐字
  const chars = Array.from(text);
  const lines = [];
  let buffer = "";
  for (const ch of chars) {
    const test = buffer + ch;
    if (ctx.measureText(test).width > maxWidth && buffer) {
      lines.push(buffer);
      buffer = ch;
      if (lines.length >= maxLines - 1) break;
    } else {
      buffer = test;
    }
  }
  if (buffer && lines.length < maxLines) {
    if (chars.length > Array.from(lines.join("")).length + Array.from(buffer).length) {
      buffer = buffer.slice(0, Math.max(0, buffer.length - 1)) + "…";
    }
    lines.push(buffer);
  }

  const totalHeight = lines.length * lineHeight;
  let y = centerY - totalHeight / 2 + lineHeight / 2;
  for (const line of lines) {
    ctx.fillText(line, x, y);
    y += lineHeight;
  }
}

export async function useGeneratedPlaceholderCover() {
  const article = getCurrentArticle();
  const title =
    article?.meta?.title?.trim() ||
    state.source?.title ||
    _ctx.controls?.title?.value?.trim() ||
    "公众号文章";
  const dataUrl = await generatePlaceholderCoverDataUrl(title);
  if (!dataUrl) throw new Error("生成占位封面失败。");

  _ensureSourceShell();
  const newImage = {
    src: dataUrl,
    alt: `自动生成的占位封面 · ${title}`,
    caption: "自动生成的占位封面"
  };
  state.source.images.push(newImage);
  const newIndex = state.source.images.length;

  article.meta.coverImageIndex = newIndex;
  state.selectedImageIndex = newIndex;
  if (_ctx.controls.coverImageIndex) {
    _ctx.controls.coverImageIndex.value = String(newIndex);
  }
  _ctx.syncWorkspace();
  schedulePersist();
  return newImage;
}

/**
 * 发布兜底：当 publishBundle 发现某篇没封面时，悄悄给它补一张占位封面，
 * 让"无封面图也能推"对用户感知就是"一键就能推"。
 * 返回新封面对象（含 src / alt / caption）。
 */
export async function ensureFallbackCoverImage(article) {
  if (!article) throw new Error("缺少文章引用。");
  const existing = getCoverImageForArticle(article);
  if (existing?.src) return existing;
  const title =
    article.meta?.title?.trim() ||
    state.source?.title ||
    "公众号文章";
  const dataUrl = await generatePlaceholderCoverDataUrl(title);
  _ensureSourceShell();
  const newImage = {
    src: dataUrl,
    alt: `自动生成的占位封面 · ${title}`,
    caption: "自动生成的占位封面"
  };
  state.source.images.push(newImage);
  article.meta.coverImageIndex = state.source.images.length;
  return newImage;
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

export function deleteSourceImage(index) {
  if (!state.source?.images || index < 1 || index > state.source.images.length) return;
  const removed = state.source.images.splice(index - 1, 1)[0];

  state.articleBundle.forEach((article) => {
    const currentCover = Number(article.meta.coverImageIndex || 0);
    if (currentCover === index) {
      article.meta.coverImageIndex = 0;
    } else if (currentCover > index) {
      article.meta.coverImageIndex = currentCover - 1;
    }
  });

  if (state.selectedImageIndex === index) {
    state.selectedImageIndex = 0;
  } else if (state.selectedImageIndex > index) {
    state.selectedImageIndex -= 1;
  }

  if (state.source.blocks) {
    state.source.blocks = state.source.blocks.filter((block) => {
      if (block.type === "image" && block.index === index) return false;
      if (block.type === "image" && block.index > index) block.index -= 1;
      return true;
    });
  }

  _ctx.syncWorkspace();
  schedulePersist();
  _ctx.setStatus(`已删除图片「${removed.caption || removed.alt || "未命名"}」`, "success");
}

export function reorderSourceImages(fromIndex, toIndex) {
  if (!state.source?.images || fromIndex < 0 || toIndex < 0) return;
  const images = state.source.images;
  if (fromIndex >= images.length || toIndex >= images.length) return;

  const [moved] = images.splice(fromIndex, 1);
  images.splice(toIndex, 0, moved);

  // 重建索引映射
  const oldImages = [...images];
  oldImages.splice(toIndex, 0, oldImages.splice(fromIndex, 1)[0]);

  const indexMap = new Map();
  oldImages.forEach((img, oldIdx) => {
    const newIdx = images.indexOf(img) + 1;
    indexMap.set(oldIdx + 1, newIdx);
  });

  state.articleBundle.forEach((article) => {
    const oldCover = Number(article.meta.coverImageIndex || 0);
    if (oldCover > 0 && indexMap.has(oldCover)) {
      article.meta.coverImageIndex = indexMap.get(oldCover);
    }
  });

  if (state.selectedImageIndex > 0 && indexMap.has(state.selectedImageIndex)) {
    state.selectedImageIndex = indexMap.get(state.selectedImageIndex);
  }

  if (state.source.blocks) {
    state.source.blocks.forEach((block) => {
      if (block.type === "image" && block.index > 0 && indexMap.has(block.index)) {
        block.index = indexMap.get(block.index);
      }
    });
  }

  _ctx.syncWorkspace();
  schedulePersist();
  _ctx.setStatus("图片顺序已调整", "success");
}

export function validateCurrentArticleForPublish() {
  const article = getCurrentArticle();
  const meta = article.meta;
  const errors = [];
  if (meta.title.length > 64)
    errors.push(`标题超出公众号限制（当前 ${meta.title.length} 字，最多 64 字）`);
  if (meta.author.length > 8)
    errors.push(`作者超出公众号限制（当前 ${meta.author.length} 字，最多 8 字）`);
  if (meta.digest.length > 120)
    errors.push(`摘要超出公众号限制（当前 ${meta.digest.length} 字，最多 120 字）`);
  if (errors.length > 0) return errors.join("；") + "。请修正后再发布。";
  return null;
}
