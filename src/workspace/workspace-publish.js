/**
 * workspace-publish.js
 * 负责：推草稿/发布、发布状态轮询、同步网页编辑器、历史记录抽屉操作。
 * 通过 init(ctx) 接收跨模块依赖，不直接 import 其他 workspace-* 模块。
 */

import { deleteSnapshot, listSnapshots, loadSnapshot, saveSnapshot } from "../shared/history.js";
import { getSettings } from "../shared/storage.js";
import { WECHAT_WEB_EDITOR_URL, THEME_PRESETS } from "../shared/defaults.js";
import { clampIndex, formatRuntimeError } from "../shared/utils.js";

let _ctx;

// 发布轮询内部状态（通过 isPolling() 导出只读视图）
let publishPollTimer = null;
let publishPollAttempts = 0;

/** 供 workspace-render.js 通过 ctx.isPolling() 查询轮询状态 */
export function isPolling() {
  return publishPollTimer !== null;
}

export function init(ctx) {
  _ctx = ctx;
  _bindPublishEvents();
}

function _bindPublishEvents() {
  const { controls, view, state } = _ctx;

  // 发布 / 草稿
  document.querySelector("#publishCurrentButton").addEventListener("click", () =>
    publishBundle(controls.publishMode.value)
  );
  document.querySelector("#publishNowButton").addEventListener("click", () =>
    publishBundle("publish")
  );
  document.querySelector("#pollStatusButton").addEventListener("click", () =>
    pollPublishStatus({ auto: false })
  );
  document.querySelector("#syncWebEditorButton").addEventListener("click", syncCurrentToWebEditor);

  // 历史记录抽屉
  document.querySelector("#historyButton").addEventListener("click", () => void openHistoryDrawer());
  document.querySelector("#closeHistoryDrawerButton").addEventListener("click", closeHistoryDrawer);
  view.historyDrawerBackdrop.addEventListener("click", closeHistoryDrawer);
  view.historyDrawer.addEventListener("click", (event) => {
    const button = event.target.closest("[data-history-action]");
    if (!button) return;
    const id = button.dataset.historyId || "";
    const action = button.dataset.historyAction || "";
    if (!id || !action) return;

    if (action === "restore") {
      state.pendingRestoreHistoryId = id;
      _ctx.renderHistoryDrawer();
      return;
    }
    if (action === "cancel-restore") {
      state.pendingRestoreHistoryId = null;
      _ctx.renderHistoryDrawer();
      return;
    }
    if (action === "confirm-restore") {
      void restoreHistoryRecord(id);
      return;
    }
    if (action === "delete") {
      void deleteHistoryRecord(id);
    }
  });
}

// ── 发布 / 草稿 ──

export async function publishBundle(mode) {
  const {
    state,
    setStatus,
    setErrorStatus,
    showLoading,
    hideLoading,
    syncCurrentArticleFromControls,
    syncWorkspace,
    schedulePersist,
    validateCurrentArticleForPublish,
    buildExportHtmlForArticle,
    resetRetryCount
  } = _ctx;

  try {
    syncCurrentArticleFromControls();
    const validationError = validateCurrentArticleForPublish();
    if (validationError) {
      setStatus(validationError, "warning");
      return;
    }

    showLoading(mode === "publish" ? "正在提交多图文发布..." : "正在推送多图文草稿包...");
    state.settings = await getSettings();

    // 多账号切换：如果选中了某个 profile，用 profile 的凭证覆盖默认凭证
    const profileIndex = Number(_ctx.controls.wechatProfileSelect?.value || -1);
    const profiles = state.settings.wechatProfiles || [];
    if (profileIndex >= 0 && profiles[profileIndex]) {
      const profile = profiles[profileIndex];
      state.settings = {
        ...state.settings,
        wechatAppId: profile.appId,
        wechatAppSecret: profile.appSecret,
        wechatDefaultAuthor: profile.author || state.settings.wechatDefaultAuthor
      };
    }

    const payload = _buildWechatPublishPayload(mode);
    const response = await chrome.runtime.sendMessage({ type: "PUBLISH_TO_WECHAT", payload });

    if (!response?.ok) {
      throw new Error(formatRuntimeError(response?.error, "公众号发布失败。"));
    }

    state.lastPublishResult = {
      ...response.data,
      title: state.articleBundle[0]?.meta.title || "",
      performedAt: new Date().toISOString(),
      requestedMode: mode
    };
    syncWorkspace();
    schedulePersist();
    await saveCurrentDraftRecord(mode === "publish" ? "发布完成" : "推送到公众号草稿箱");

    if (response.data.publishId) {
      startPublishStatusPolling(response.data.publishId);
    } else {
      clearPublishPolling();
    }

    const failedImages = response.data.failedImages || [];
    if (failedImages.length > 0) {
      const lines = failedImages.map(
        (f) => `第 ${f.articleIndex} 篇 · ${f.type === "cover" ? "封面" : "正文图片"}：${f.error || "上传失败"}`
      );
      setStatus(
        (mode === "publish" ? "已提交发布，但部分图片上传失败。" : "草稿已推送，但部分图片上传失败。") +
          " " +
          lines.join("；"),
        "warning"
      );
    } else {
      setStatus(
        mode === "publish"
          ? "已提交发布请求，正在自动查询发布状态。"
          : "已成功推送到公众号草稿箱。",
        "success"
      );
    }
    resetRetryCount();
  } catch (error) {
    setErrorStatus(
      error._errorObj || { code: "UNKNOWN", message: error.message || "公众号发布失败。", retryable: false },
      "公众号发布失败。",
      () => publishBundle(mode)
    );
  } finally {
    hideLoading();
  }
}

function _buildWechatPublishPayload(mode) {
  const { state, buildExportHtmlForArticle } = _ctx;
  const articles = state.articleBundle.map((article, index) => {
    const coverImage = state.source?.images?.[Number(article.meta.coverImageIndex || 0) - 1] || null;
    if (!article.meta.title.trim()) throw new Error(`第 ${index + 1} 篇没有填写标题。`);
    if (!coverImage?.src) throw new Error(`第 ${index + 1} 篇还没有选择封面图。`);

    const preparedHtml = _tokenizeImages(buildExportHtmlForArticle(article));
    return {
      meta: {
        title: article.meta.title.trim(),
        author: article.meta.author.trim(),
        digest: article.meta.digest.trim() || _ctx.deriveDigestFromArticle(article),
        contentSourceUrl: article.meta.contentSourceUrl.trim(),
        needOpenComment: Boolean(article.meta.needOpenComment),
        onlyFansCanComment: Boolean(article.meta.onlyFansCanComment)
      },
      html: preparedHtml.html,
      inlineImages: preparedHtml.inlineImages,
      cover: { src: coverImage.src, filename: _deriveFilename(coverImage.src, `cover-${index + 1}`) }
    };
  });
  return { articles, publishMode: mode };
}

function _tokenizeImages(html) {
  const doc = new DOMParser().parseFromString(html, "text/html");
  const inlineImages = [];
  doc.querySelectorAll("img").forEach((image, index) => {
    const src = image.getAttribute("src");
    if (!src || _isWechatHostedUrl(src)) return;
    const token = `__WECHAT_IMAGE_${index + 1}_${Date.now()}__`;
    inlineImages.push({ token, src, filename: _deriveFilename(src, `inline-${index + 1}`) });
    image.setAttribute("src", token);
  });
  return { html: doc.body.innerHTML.trim(), inlineImages };
}

function _isWechatHostedUrl(url) {
  return /mmbiz\.(qpic|qlogo)\.cn/i.test(url);
}

function _deriveFilename(url, fallback) {
  try {
    const pathname = new URL(url).pathname;
    const filename = pathname.split("/").filter(Boolean).pop();
    if (filename) return filename;
  } catch {}
  return `${fallback}.png`;
}

// ── 发布状态轮询 ──

export async function pollPublishStatus({ auto = false } = {}) {
  const { state, setStatus, setErrorStatus, syncWorkspace, schedulePersist } = _ctx;
  if (!state.lastPublishResult?.publishId) {
    setStatus("还没有可查询的 publish_id。", "warning");
    return;
  }

  const response = await chrome.runtime.sendMessage({
    type: "GET_WECHAT_PUBLISH_STATUS",
    payload: { publishId: state.lastPublishResult.publishId }
  });

  if (!response?.ok) {
    if (auto && publishPollAttempts < 12) { scheduleNextPublishPoll(); return; }
    setErrorStatus(response?.error, "查询发布状态失败。", null);
    return;
  }

  state.lastPublishResult = {
    ...state.lastPublishResult,
    statusInfo: response.data,
    lastPolledAt: new Date().toISOString()
  };
  syncWorkspace();
  schedulePersist();

  if (auto && !response.data.isTerminal && publishPollAttempts < 12) {
    scheduleNextPublishPoll();
    setStatus(`公众号仍在处理中：${response.data.statusText}，继续轮询中...`, "info");
    return;
  }
  clearPublishPolling();
  setStatus(`最新发布状态：${response.data.statusText}`, "success");
}

export function startPublishStatusPolling(publishId) {
  clearPublishPolling();
  publishPollAttempts = 0;
  _ctx.state.lastPublishResult = { ..._ctx.state.lastPublishResult, publishId };
  void pollPublishStatus({ auto: true });
}

function scheduleNextPublishPoll() {
  clearTimeout(publishPollTimer);
  publishPollAttempts += 1;
  publishPollTimer = setTimeout(() => void pollPublishStatus({ auto: true }), 8000);
}

export function clearPublishPolling() {
  clearTimeout(publishPollTimer);
  publishPollTimer = null;
  publishPollAttempts = 0;
}

export function maybeResumePublishPolling() {
  const { state, setStatus } = _ctx;
  if (!state.lastPublishResult?.publishId) return;
  if (state.lastPublishResult.statusInfo?.isTerminal) return;
  startPublishStatusPolling(state.lastPublishResult.publishId);
  setStatus("检测到未完成的发布任务，已恢复自动轮询。", "info");
}

// ── 网页编辑器同步 ──

export async function syncCurrentToWebEditor() {
  const {
    state,
    setStatus,
    setErrorStatus,
    showLoading,
    hideLoading,
    syncCurrentArticleFromControls,
    getCurrentArticle,
    syncWorkspace,
    schedulePersist,
    buildExportHtmlForArticle,
    resetRetryCount
  } = _ctx;

  try {
    syncCurrentArticleFromControls();
    const current = getCurrentArticle();
    showLoading("正在打开并同步到公众号网页编辑器...");
    const response = await chrome.runtime.sendMessage({
      type: "SYNC_TO_WECHAT_WEB_EDITOR",
      payload: {
        meta: {
          title: current.meta.title,
          author: current.meta.author,
          digest: current.meta.digest,
          contentSourceUrl: current.meta.contentSourceUrl
        },
        html: buildExportHtmlForArticle(current),
        editorUrl: WECHAT_WEB_EDITOR_URL
      }
    });

    if (!response?.ok) {
      throw new Error(formatRuntimeError(response?.error, "同步网页编辑器失败。"));
    }

    state.lastWebSyncResult = {
      ...response.data,
      articleTitle: current.meta.title,
      syncedAt: new Date().toISOString()
    };
    syncWorkspace();
    schedulePersist();
    setStatus(
      response.data.bodyWritten
        ? "已尝试同步到网页编辑器。若正文未自动落入，请看编辑页右下角助手面板。"
        : "已打开网页编辑器，但未完全自动写入。请看编辑页右下角助手面板。",
      "warning"
    );
    resetRetryCount();
  } catch (error) {
    setErrorStatus(
      error._errorObj || { code: "UNKNOWN", message: error.message || "同步网页编辑器失败。", retryable: false },
      "同步网页编辑器失败。",
      () => syncCurrentToWebEditor()
    );
  } finally {
    hideLoading();
  }
}

// ── 历史记录 ──

export async function openHistoryDrawer() {
  _ctx.state.isHistoryDrawerOpen = true;
  _ctx.state.pendingRestoreHistoryId = null;
  await refreshHistoryRecords();
}

export function closeHistoryDrawer() {
  _ctx.state.isHistoryDrawerOpen = false;
  _ctx.state.pendingRestoreHistoryId = null;
  _ctx.renderHistoryDrawer();
}

export async function refreshHistoryRecords() {
  _ctx.state.historyEntries = await listSnapshots();
  _ctx.renderHistoryDrawer();
}

export async function saveCurrentDraftRecord(label) {
  const { syncCurrentArticleFromControls, state, controls, buildHistoryLabel } = _ctx;
  syncCurrentArticleFromControls();
  await saveSnapshot(buildHistoryLabel(label), state.articleBundle, state.source, {
    currentArticleIndex: state.currentArticleIndex,
    selectedImageIndex: state.selectedImageIndex,
    theme: controls.theme.value
  });
  await refreshHistoryRecords();
}

async function restoreHistoryRecord(id) {
  const {
    state,
    controls,
    setStatus,
    syncCurrentArticleFromControls,
    applyCurrentArticleToControls,
    syncWorkspace,
    updateEditorWordCount,
    normalizeImportedSource,
    normalizeImportedSelectedImageIndex,
    normalizeArticleDoc,
    createEmptyArticleDoc,
    hasMeaningfulDraftState,
    buildHistoryLabel
  } = _ctx;

  syncCurrentArticleFromControls();
  const record = await loadSnapshot(id);
  if (!record) {
    await refreshHistoryRecords();
    setStatus("这条草稿记录已经不存在了。", "warning");
    return;
  }

  if (hasMeaningfulDraftState()) {
    await saveSnapshot(buildHistoryLabel("恢复前备份"), state.articleBundle, state.source, {
      currentArticleIndex: state.currentArticleIndex,
      selectedImageIndex: state.selectedImageIndex,
      theme: controls.theme.value
    });
  }

  state.source = normalizeImportedSource(record.source);
  state.articleBundle =
    Array.isArray(record.articleBundle) && record.articleBundle.length > 0
      ? record.articleBundle.map(normalizeArticleDoc)
      : [createEmptyArticleDoc()];
  state.currentArticleIndex = clampIndex(
    Number(record.currentArticleIndex || 0),
    state.articleBundle.length
  );
  state.selectedImageIndex = normalizeImportedSelectedImageIndex(
    record.selectedImageIndex,
    state.source?.images?.length || 0
  );
  state.lastPublishResult = null;
  state.lastWebSyncResult = null;
  clearPublishPolling();

  if (record.theme && THEME_PRESETS[record.theme]) {
    controls.theme.value = record.theme;
  }

  applyCurrentArticleToControls();
  syncWorkspace();
  updateEditorWordCount();
  try {
    await _ctx.schedulePersist.flush?.();
  } catch {}
  await refreshHistoryRecords();
  closeHistoryDrawer();
  setStatus("已恢复这篇的草稿记录，刚才的内容也留了一份"恢复前备份"。", "success");
}

async function deleteHistoryRecord(id) {
  const { state, setStatus } = _ctx;
  const deleted = await deleteSnapshot(id);
  state.pendingRestoreHistoryId = null;
  await refreshHistoryRecords();
  setStatus(
    deleted ? "已删除这条草稿记录。" : "这条草稿记录已经不存在了。",
    deleted ? "success" : "warning"
  );
}
