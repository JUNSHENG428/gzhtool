/**
 * workspace.js — 入口模块（≤200 行）
 * 职责：DOM 引用缓存、组装 ctx、初始化所有子模块、定义入口级工具函数。
 * 业务逻辑全部委托给各 workspace-*.js 子模块。
 */

import { DEFAULT_SETTINGS } from "../shared/defaults.js";
import { getSession, getSettings } from "../shared/storage.js";
import { escapeHtml } from "../shared/utils.js";
import { initWorkspaceShortcuts } from "./shortcuts.js";

import {
  init as initState,
  state,
  schedulePersist,
  getCurrentArticle,
  applyCurrentArticleToControls,
  syncCurrentArticleFromControls,
  onWorkspaceInput,
  collectRewritePreferences,
  hydrateDefaults,
  restoreSession,
  addSubArticle,
  duplicateCurrentArticle,
  moveCurrentArticle,
  removeCurrentArticle,
  switchArticle,
  exportBundle,
  importBundleFromFile,
  normalizeImportedSource,
  normalizeImportedSelectedImageIndex,
  normalizeArticleDoc,
  createEmptyArticleDoc,
  hasMeaningfulDraftState,
  buildHistoryLabel,
  validateCurrentArticleForPublish,
  collectCurrentArticleMeta,
  deriveDigestFromEditor,
  deriveDigestFromArticle,
  getCoverImageForArticle,
  getSelectedImage,
  deleteSourceImage,
  reorderSourceImages,
  appendLocalImages
} from "./workspace-state.js";

import {
  init as initRender,
  syncWorkspace,
  renderSource,
  renderCoverPreview,
  renderHistoryDrawer,
  renderArticleStack,
  fillThemeOptions,
  applyTheme
} from "./workspace-render.js";

import { init as initCapture, captureSource } from "./workspace-capture.js";
import { init as initRewrite, rewriteArticle, copyManualPrompt, hideRewriteDiffBarUI } from "./workspace-rewrite.js";

import {
  init as initEditor,
  buildExportHtmlForArticle,
  buildMarkdownDocumentForArticle,
  buildPreviewDocument,
  copyHtml,
  copyMarkdown,
  downloadHtml,
  downloadMarkdown,
  toggleOutputPreviewTab,
  cycleEditorTheme,
  insertSourceImage,
  updateEditorWordCount,
  resetEditorHistory,
  pushEditorSnapshotAfterRewrite,
  editorUndo,
  editorRedo
} from "./workspace-editor.js";

import {
  init as initPublish,
  publishBundle,
  pollPublishStatus,
  syncCurrentToWebEditor,
  maybeResumePublishPolling,
  openHistoryDrawer,
  closeHistoryDrawer,
  refreshHistoryRecords,
  saveCurrentDraftRecord,
  clearPublishPolling,
  isPolling
} from "./workspace-publish.js";

// ── DOM 引用 ──

const view = {
  sourceMeta: document.querySelector("#sourceMeta"),
  sourcePreview: document.querySelector("#sourcePreview"),
  imageRail: document.querySelector("#imageRail"),
  articleStack: document.querySelector("#articleStack"),
  bundleSummary: document.querySelector("#bundleSummary"),
  editor: document.querySelector("#editor"),
  editorWordCount: document.querySelector("#editorWordCount"),
  htmlOutput: document.querySelector("#htmlOutput"),
  markdownOutput: document.querySelector("#markdownOutput"),
  wechatPreview: document.querySelector("#wechatPreview"),
  coverPreview: document.querySelector("#coverPreview"),
  publishResult: document.querySelector("#publishResult"),
  pollProgress: document.querySelector("#pollProgress"),
  pollProgressText: document.querySelector("#pollProgressText"),
  pollProgressRing: document.querySelector("#pollProgressRing"),
  pollProgressCountdown: document.querySelector("#pollProgressCountdown"),
  webEditorSyncResult: document.querySelector("#webEditorSyncResult"),
  titleSuggestions: document.querySelector("#titleSuggestions"),
  keywordSuggestions: document.querySelector("#keywordSuggestions"),
  status: document.querySelector("#status"),
  loadingOverlay: document.querySelector("#loadingOverlay"),
  loadingMessage: document.querySelector("#loadingMessage"),
  firstRunOverlay: document.querySelector("#firstRunOverlay"),
  emptyPromptCard: document.querySelector("#emptyPromptCard"),
  historyDrawer: document.querySelector("#historyDrawer"),
  historyDrawerBackdrop: document.querySelector("#historyDrawerBackdrop"),
  historyDrawerList: document.querySelector("#historyDrawerList"),
  rewriteDiffBar: document.querySelector("#rewriteDiffBar"),
  rewriteDiffBarTime: document.querySelector("#rewriteDiffBarTime"),
  rewriteDiffBackdrop: document.querySelector("#rewriteDiffBackdrop"),
  rewriteDiffLeft: document.querySelector("#rewriteDiffLeft"),
  rewriteDiffRight: document.querySelector("#rewriteDiffRight")
};

const controls = {
  bundleImport: document.querySelector("#bundleImportInput"),
  title: document.querySelector("#titleInput"),
  subtitle: document.querySelector("#subtitleInput"),
  author: document.querySelector("#authorInput"),
  digest: document.querySelector("#digestInput"),
  sourceUrl: document.querySelector("#sourceUrlInput"),
  lead: document.querySelector("#leadInput"),
  cta: document.querySelector("#ctaInput"),
  audience: document.querySelector("#audienceInput"),
  tone: document.querySelector("#toneInput"),
  angle: document.querySelector("#angleInput"),
  length: document.querySelector("#lengthSelect"),
  theme: document.querySelector("#themeSelect"),
  coverImageIndex: document.querySelector("#coverImageSelect"),
  publishMode: document.querySelector("#publishModeSelect"),
  needOpenComment: document.querySelector("#openCommentCheckbox"),
  onlyFansCanComment: document.querySelector("#fansOnlyCheckbox"),
  customTemplateSelect: document.querySelector("#customTemplateSelect"),
  saveTemplateButton: document.querySelector("#saveTemplateButton"),
  wechatProfileSelect: document.querySelector("#wechatProfileSelect")
};

// ── 入口级工具 ──

export function showLoading(message = "处理中...", { onCancel } = {}) {
  view.loadingMessage.textContent = message;
  view.loadingOverlay.classList.add("active");
  view.loadingOverlay.setAttribute("aria-hidden", "false");

  view.cancelLoadingButton = view.cancelLoadingButton || document.querySelector("#cancelLoadingButton");
  if (view.cancelLoadingButton) {
    if (onCancel) {
      view.cancelLoadingButton.hidden = false;
      view.cancelLoadingButton.onclick = () => {
        onCancel();
        hideLoading();
      };
    } else {
      view.cancelLoadingButton.hidden = true;
      view.cancelLoadingButton.onclick = null;
    }
  }
}

export function hideLoading() {
  view.loadingOverlay.classList.remove("active");
  view.loadingOverlay.setAttribute("aria-hidden", "true");
  if (view.cancelLoadingButton) {
    view.cancelLoadingButton.hidden = true;
    view.cancelLoadingButton.onclick = null;
  }
}

export function activateTab(name) {
  document.querySelectorAll(".tab").forEach((tab) => {
    const isActive = tab.dataset.tab === name;
    tab.classList.toggle("active", isActive);
    tab.setAttribute("aria-selected", String(isActive));
    tab.setAttribute("tabindex", isActive ? "0" : "-1");
  });
  document.querySelectorAll(".tab-panel").forEach((panel) => {
    const isActive = panel.id === `${name}Panel`;
    panel.classList.toggle("active", isActive);
    panel.hidden = !isActive;
  });
}

export function closeOverlays() {
  if (state.isHistoryDrawerOpen) closeHistoryDrawer();
  if (view.firstRunOverlay && !view.firstRunOverlay.hidden) view.firstRunOverlay.hidden = true;
  if (view.emptyPromptCard && !view.emptyPromptCard.hidden) view.emptyPromptCard.hidden = true;
  if (view.rewriteDiffBackdrop && !view.rewriteDiffBackdrop.hidden) view.rewriteDiffBackdrop.hidden = true;
}

export function blurEditor() { view.editor.blur(); }
export function openHelp() { chrome.tabs.create({ url: chrome.runtime.getURL("src/pages/help.html") }); }
export function openHotTopicsPage() {
  chrome.tabs.create({ url: chrome.runtime.getURL("src/pages/hot-topics.html") });
}
export function openSettings() { chrome.runtime.openOptionsPage(); }

// ── Dark mode ──

const THEME_STORAGE_KEY = "workspace-theme-preference";

export function getThemePreference() {
  try {
    return localStorage.getItem(THEME_STORAGE_KEY) || "auto";
  } catch {
    return "auto";
  }
}

export function setThemePreference(preference) {
  try {
    localStorage.setItem(THEME_STORAGE_KEY, preference);
  } catch { /* ignore */ }
  applyThemePreference();
}

export function applyThemePreference() {
  const preference = getThemePreference();
  const prefersDark = window.matchMedia("(prefers-color-scheme: dark)").matches;
  const isDark = preference === "dark" || (preference === "auto" && prefersDark);
  document.documentElement.setAttribute("data-theme", isDark ? "dark" : "light");
  updateThemeToggleIcon(isDark);
}

function updateThemeToggleIcon(isDark) {
  const icon = document.querySelector("#themeToggleIcon");
  if (!icon) return;
  if (isDark) {
    icon.innerHTML = '<path d="M20.354 15.354A9 9 0 018.646 3.646 9.003 9.003 0 0012 21a9.003 9.003 0 008.354-5.646z"/>';
  } else {
    icon.innerHTML = '<path d="M12 3v1m0 16v1m9-9h-1M4 12H3m15.364 6.364l-.707-.707M6.343 6.343l-.707-.707m12.728 0l-.707.707M6.343 17.657l-.707.707M16 12a4 4 0 11-8 0 4 4 0 018 0z"/>';
  }
}

function toggleTheme() {
  const current = getThemePreference();
  const prefersDark = window.matchMedia("(prefers-color-scheme: dark)").matches;
  const isCurrentlyDark = current === "dark" || (current === "auto" && prefersDark);
  setThemePreference(isCurrentlyDark ? "light" : "dark");
}

// ── 状态栏 ──

let statusFadeTimer = null;
let _lastRetryFn = null;
let _retryCount = 0;
const MAX_CLIENT_RETRIES = 3;

export function resetRetryCount() { _retryCount = 0; }

export function setStatus(message, type = "info") {
  clearTimeout(statusFadeTimer);
  const validTypes = new Set(["info", "success", "warning", "error"]);
  const safeType = validTypes.has(type) ? type : "info";
  view.status.textContent = message;
  view.status.setAttribute("data-status-type", safeType);
  view.status.classList.remove("is-faded");
  statusFadeTimer = setTimeout(() => { view.status.classList.add("is-faded"); }, safeType === "error" ? 8000 : 4000);
}

export function setErrorStatus(errorObj, fallback, retryFn) {
  clearTimeout(statusFadeTimer);
  const isStructured = errorObj && typeof errorObj === "object";
  const message = isStructured ? (errorObj.message || fallback) : (errorObj || fallback);
  const code = isStructured ? errorObj.code : null;
  const retryable = isStructured ? Boolean(errorObj.retryable) : false;

  let html = `<span class="status-text">${escapeHtml(message)}</span>`;
  if (code === "WECHAT_IP_NOT_WHITELISTED") {
    const helpUrl = chrome.runtime.getURL("src/pages/help.html#wechat-ip");
    html += ` <a class="status-help-link" href="${helpUrl}" target="_blank" rel="noreferrer">查看帮助</a>`;
  }
  if (retryable && retryFn) {
    _lastRetryFn = retryFn;
    if (_retryCount < MAX_CLIENT_RETRIES) {
      html += ` <button class="status-retry-btn" id="statusRetryBtn">重试</button>`;
    } else {
      html += ` <span class="status-retry-exhausted">（已重试 ${MAX_CLIENT_RETRIES} 次）</span>`;
      _lastRetryFn = null;
    }
  } else {
    _lastRetryFn = null;
  }

  view.status.innerHTML = html;
  view.status.setAttribute("data-status-type", "error");
  view.status.classList.remove("is-faded");
  const retryBtn = view.status.querySelector("#statusRetryBtn");
  if (retryBtn && _lastRetryFn) retryBtn.addEventListener("click", () => _retryLastRequest(retryFn));
  statusFadeTimer = setTimeout(() => { view.status.classList.add("is-faded"); }, 10000);
}

function _retryLastRequest(retryFn) {
  if (_retryCount >= MAX_CLIENT_RETRIES) {
    setStatus(`已重试 ${MAX_CLIENT_RETRIES} 次，仍然失败，请检查配置后再试。`, "error");
    _lastRetryFn = null;
    return;
  }
  _retryCount += 1;
  setStatus(`正在重试（第 ${_retryCount} / ${MAX_CLIENT_RETRIES} 次）...`, "info");
  retryFn();
}

// ── 引导 ──

bootstrap();

async function bootstrap() {
  // 组装 ctx — 所有模块复用同一对象，通过 init(ctx) 注入
  const ctx = {
    view, controls, state,
    // 入口级工具
    setStatus, setErrorStatus, showLoading, hideLoading, activateTab,
    closeOverlays, blurEditor, openHelp, openHotTopicsPage, openSettings, resetRetryCount,
    // workspace-state.js
    schedulePersist, getCurrentArticle, applyCurrentArticleToControls,
    syncCurrentArticleFromControls, onWorkspaceInput, collectRewritePreferences,
    collectCurrentArticleMeta, hydrateDefaults, restoreSession,
    addSubArticle, duplicateCurrentArticle, moveCurrentArticle, removeCurrentArticle,
    switchArticle, exportBundle, importBundleFromFile,
    normalizeImportedSource, normalizeImportedSelectedImageIndex,
    normalizeArticleDoc, createEmptyArticleDoc, hasMeaningfulDraftState,
    buildHistoryLabel, validateCurrentArticleForPublish,
    deriveDigestFromEditor, deriveDigestFromArticle, getCoverImageForArticle, getSelectedImage,
    deleteSourceImage, reorderSourceImages, appendLocalImages,
    // workspace-render.js
    syncWorkspace, renderSource, renderCoverPreview, renderHistoryDrawer,
    renderArticleStack, fillThemeOptions, applyTheme,
    // workspace-editor.js
    buildExportHtmlForArticle, buildMarkdownDocumentForArticle, buildPreviewDocument,
    copyHtml, copyMarkdown, downloadHtml, downloadMarkdown,
    toggleOutputPreviewTab, cycleEditorTheme, insertSourceImage, updateEditorWordCount,
    resetEditorHistory, pushEditorSnapshotAfterRewrite, editorUndo, editorRedo,
    // workspace-capture.js
    captureSource,
    // workspace-rewrite.js
    rewriteArticle, copyManualPrompt, hideRewriteDiffBarUI,
    // workspace-publish.js
    publishBundle, pollPublishStatus, syncCurrentToWebEditor, maybeResumePublishPolling,
    openHistoryDrawer, closeHistoryDrawer, refreshHistoryRecords,
    saveCurrentDraftRecord, clearPublishPolling, isPolling
  };

  // 初始化各子模块（顺序：state → render → editor → capture → rewrite → publish）
  initState(ctx);
  initRender(ctx);
  initEditor(ctx);
  initCapture(ctx);
  initRewrite(ctx);
  initPublish(ctx);

  // 绑定剩余全局事件（表单字段同步）
  _bindGlobalEvents(ctx);

  // 启动
  fillThemeOptions();
  _bindFirstRunEvents();
  _bindThemeToggle();
  applyThemePreference();

  state.settings = await getSettings();
  state.session = await getSession();

  hydrateDefaults();
  restoreSession();
  await refreshHistoryRecords();
  syncWorkspace();
  updateEditorWordCount();
  maybeResumePublishPolling();
  _loadWechatProfiles();

  initWorkspaceShortcuts({
    schedulePersist, setStatus,
    captureSource, rewriteArticle,
    copyHtml, copyMarkdown, downloadHtml, downloadMarkdown,
    toggleOutputPreviewTab, cycleEditorTheme,
    openHelp,
    openHotTopics: openHotTopicsPage,
    openSettings,
    openWorkspaceHistory: () => void openHistoryDrawer(),
    closeOverlays, blurEditor, moveCurrentArticle,
    editorUndo,
    editorRedo
  });

  const params = new URLSearchParams(location.search);
  const wantAutoCapture = params.get("autocapture") === "1";

  const isFirstRun =
    !state.session?.lastSourceUrl && !state.settings?.apiKey && !state.settings?.apiBaseUrl;

  // 从工具栏「抓取并打开」进入时优先完成抓取，避免被首次引导挡住
  if (isFirstRun && !wantAutoCapture) {
    view.firstRunOverlay.hidden = false;
    return;
  }
  if (isFirstRun && wantAutoCapture) {
    view.firstRunOverlay.hidden = true;
  }

  if (!state.source) view.emptyPromptCard.hidden = false;

  if (wantAutoCapture) {
    await captureSource();
  }
}

function _bindGlobalEvents(ctx) {
  document.querySelector("#openOptionsButton")?.addEventListener("click", openSettings);
  document.querySelector("#openHotTopicsButton")?.addEventListener("click", openHotTopicsPage);

  const syncTargets = [
    controls.title, controls.subtitle, controls.author, controls.digest,
    controls.sourceUrl, controls.lead, controls.cta,
    controls.audience, controls.tone, controls.angle
  ];
  syncTargets.forEach((field) => field.addEventListener("input", onWorkspaceInput));
  [controls.length, controls.theme, controls.coverImageIndex, controls.publishMode]
    .forEach((field) => field.addEventListener("change", onWorkspaceInput));
  [controls.needOpenComment, controls.onlyFansCanComment]
    .forEach((field) => field.addEventListener("change", onWorkspaceInput));
  view.editor.addEventListener("input", onWorkspaceInput);
}

function _loadWechatProfiles() {
  const select = controls.wechatProfileSelect;
  if (!select) return;
  const profiles = state.settings?.wechatProfiles || [];
  select.innerHTML = [
    '<option value="-1">默认账号</option>',
    ...profiles.map((p, i) => `<option value="${i}">${escapeHtml(p.name || `账号 ${i + 1}`)}</option>`)
  ].join("");
  const activeIndex = Number(state.settings?.activeWechatProfileIndex || -1);
  if (activeIndex >= 0 && activeIndex < profiles.length) {
    select.value = String(activeIndex);
  }
}

function _bindThemeToggle() {
  const toggle = document.querySelector("#themeToggle");
  if (!toggle) return;
  toggle.addEventListener("click", toggleTheme);
}

function _bindFirstRunEvents() {
  document.querySelector("#firstRunOptionsButton")?.addEventListener("click", () => {
    chrome.runtime.openOptionsPage();
  });
  document.querySelector("#firstRunCaptureButton")?.addEventListener("click", () => {
    view.firstRunOverlay.hidden = true;
    document.querySelector("#captureButton")?.click();
  });
  document.querySelector("#firstRunHelpLink")?.addEventListener("click", (event) => {
    event.preventDefault();
    chrome.tabs.create({ url: chrome.runtime.getURL("src/pages/help.html") });
  });
  document.querySelector("#emptyPromptCaptureButton")?.addEventListener("click", () => {
    view.emptyPromptCard.hidden = true;
    document.querySelector("#captureButton")?.click();
  });
}
