/**
 * workspace.js — 入口模块（≤200 行）
 * 职责：DOM 引用缓存、组装 ctx、初始化所有子模块、定义入口级工具函数。
 * 业务逻辑全部委托给各 workspace-*.js 子模块。
 */

import { DEFAULT_SETTINGS } from "../shared/defaults.js";
import { getSession, getSettings, saveSettings } from "../shared/storage.js";
import { escapeHtml } from "../shared/utils.js";
import { initWorkspaceShortcuts } from "./shortcuts.js";
import { initWorkspaceRouter } from "./workspace-router.js";
import { initWorkspaceMember } from "./workspace-member.js";
import { initImportFile } from "./workspace-import-file.js";
import { mountTaskCenter } from "./workspace-task-center.js";

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
  addCustomImageFromFile,
  generatePlaceholderCoverDataUrl,
  useGeneratedPlaceholderCover,
  ensureFallbackCoverImage
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

import {
  init as initCapture,
  captureSource,
  importCurrentSourceToArticle,
  applyCaptureTaskResult
} from "./workspace-capture.js";
import {
  init as initRewrite,
  rewriteArticle,
  copyManualPrompt,
  applyRewriteTaskResult
} from "./workspace-rewrite.js";

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
  refreshFieldHints
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
  isPolling,
  renderPublishArticleList
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
  webEditorSyncResult: document.querySelector("#webEditorSyncResult"),
  titleSuggestions: document.querySelector("#titleSuggestions"),
  keywordSuggestions: document.querySelector("#keywordSuggestions"),
  status: document.querySelector("#status"),
  loadingOverlay: document.querySelector("#loadingOverlay"),
  loadingTitle: document.querySelector("#loadingTitle"),
  loadingHint: document.querySelector("#loadingHint"),
  firstRunOverlay: document.querySelector("#firstRunOverlay"),
  emptyPromptCard: document.querySelector("#emptyPromptCard"),
  historyDrawer: document.querySelector("#historyDrawer"),
  historyDrawerBackdrop: document.querySelector("#historyDrawerBackdrop"),
  historyDrawerList: document.querySelector("#historyDrawerList")
};

const controls = {
  bundleImport: document.querySelector("#bundleImportInput"),
  title: document.querySelector("#titleInput"),
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
  coverUploadInput: document.querySelector("#coverUploadInput"),
  publishMode: document.querySelector("#publishModeSelect"),
  needOpenComment: document.querySelector("#openCommentCheckbox"),
  onlyFansCanComment: document.querySelector("#fansOnlyCheckbox"),
  customTemplateSelect: document.querySelector("#customTemplateSelect"),
  saveTemplateButton: document.querySelector("#saveTemplateButton"),
  wechatProfileSelect: document.querySelector("#wechatProfileSelect")
};

// ── 入口级工具 ──

/**
 * 中央加载卡片。
 * 5 处老调用方式 `showLoading("正在 xxx...")` 完全兼容；
 * 想给用户传达「等多久 / 结果落到哪」时再传第二参 `hint`。
 * 见 workspace-rewrite / workspace-publish 等调用点。
 */
export function showLoading(title = "处理中...", hint = "") {
  view.loadingTitle.textContent = title;
  if (hint) {
    view.loadingHint.textContent = hint;
    view.loadingHint.hidden = false;
  } else {
    view.loadingHint.textContent = "";
    view.loadingHint.hidden = true;
  }
  view.loadingOverlay.classList.add("active");
  view.loadingOverlay.setAttribute("aria-hidden", "false");
}

export function hideLoading() {
  view.loadingOverlay.classList.remove("active");
  view.loadingOverlay.setAttribute("aria-hidden", "true");
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
}

export function blurEditor() { view.editor.blur(); }
export function openHelp() { chrome.tabs.create({ url: chrome.runtime.getURL("src/pages/help.html") }); }
export function openHotTopicsPage() {
  chrome.tabs.create({ url: chrome.runtime.getURL("src/pages/hot-topics.html") });
}
export function openSettings() { chrome.runtime.openOptionsPage(); }

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
    deleteSourceImage, reorderSourceImages,
    addCustomImageFromFile, generatePlaceholderCoverDataUrl, useGeneratedPlaceholderCover,
    ensureFallbackCoverImage,
    // workspace-render.js
    syncWorkspace, renderSource, renderCoverPreview, renderHistoryDrawer,
    renderArticleStack, fillThemeOptions, applyTheme,
    // workspace-editor.js
    buildExportHtmlForArticle, buildMarkdownDocumentForArticle, buildPreviewDocument,
    copyHtml, copyMarkdown, downloadHtml, downloadMarkdown,
    toggleOutputPreviewTab, cycleEditorTheme, insertSourceImage, updateEditorWordCount,
    refreshFieldHints,
    // workspace-capture.js
    captureSource, importCurrentSourceToArticle, applyCaptureTaskResult,
    // workspace-rewrite.js
    rewriteArticle, copyManualPrompt, applyRewriteTaskResult,
    // workspace-publish.js
    publishBundle, pollPublishStatus, syncCurrentToWebEditor, maybeResumePublishPolling,
    openHistoryDrawer, closeHistoryDrawer, refreshHistoryRecords,
    saveCurrentDraftRecord, clearPublishPolling, isPolling,
    renderPublishArticleList
  };

  // 初始化各子模块（顺序：state → render → editor → capture → rewrite → publish）
  initState(ctx);
  initRender(ctx);
  initEditor(ctx);
  initImportFile(ctx);
  initCapture(ctx);
  initRewrite(ctx);
  initPublish(ctx);

  // 绑定剩余全局事件（表单字段同步）
  _bindGlobalEvents(ctx);

  // 启动
  fillThemeOptions();
  _bindFirstRunEvents();

  state.settings = await getSettings();
  state.session = await getSession();

  hydrateDefaults();
  restoreSession();
  await refreshHistoryRecords();
  syncWorkspace();
  updateEditorWordCount();
  maybeResumePublishPolling();
  _loadWechatProfiles();
  _bindStorageSync();

  // 挂载右下角任务中心。useTaskCenter=false 时直接跳过 mount，让 rewrite/capture 走老的全屏 modal。
  // 默认开启（DEFAULT_SETTINGS.useTaskCenter = true，Phase 5 注入）。
  if (state.settings.useTaskCenter !== false) {
    mountTaskCenter({
      getCurrentArticleId() {
        return getCurrentArticle()?.id || "";
      },
      async goToArticle(articleId) {
        const idx = state.articleBundle.findIndex((a) => a.id === articleId);
        if (idx < 0) return false;
        // 切到对应 article
        switchArticle(idx);
        // 如果当前不在 layout 路由，hash 切回去
        if ((location.hash || "").replace(/^#/, "") !== "layout") {
          location.hash = "layout";
        }
        return true;
      },
      async onTaskDone(task) {
        // 改写完成时让 workspace-rewrite 应用结果到对应 article
        if (task.type === "rewrite") {
          await ctx.applyRewriteTaskResult?.(task);
        }
        // 抓取完成：applyCaptureTaskResult 内部按 articleId 找目标 article。
        // 用户从抓取触发处直接等到完成的常见路径已经在 captureSource 内同步 apply
        // 过一次了，此处只处理"用户切到别处后从 toast / chip [查看] 跳回"的场景。
        if (task.type === "capture") {
          await ctx.applyCaptureTaskResult?.(task);
        }
      },
      async retryTask(task) {
        // 用户从 task chip / toast 点 [重试]：goToArticle 已切到目标 article，
        // 这里直接调原入口重发任务（产生新 task，老 task 仍在 done 历史里展示）
        if (task.type === "rewrite") {
          await rewriteArticle();
        } else if (task.type === "capture") {
          await captureSource();
        }
      }
    });
  }

  initWorkspaceShortcuts({
    schedulePersist, setStatus,
    captureSource, rewriteArticle,
    copyHtml, copyMarkdown, downloadHtml, downloadMarkdown,
    toggleOutputPreviewTab, cycleEditorTheme,
    openHelp,
    openHotTopics: openHotTopicsPage,
    openSettings,
    openWorkspaceHistory: () => void openHistoryDrawer(),
    closeOverlays, blurEditor, moveCurrentArticle
  });

  // 初始化左侧导航 + hash 路由（依赖 openOptionsButton/openHelpButton 已绑事件）
  initWorkspaceRouter();
  initWorkspaceMember();

  const params = new URLSearchParams(location.search);
  const wantAutoCapture = params.get("autocapture") === "1";
  const wantImportSession = params.get("import") === "1";
  // mp 编辑页悬浮助手「后台静默 workspace」标记：SW 在用户点浮球但找不到打开的
  // workspace tab 时，会用 chrome.tabs.create({ url: "...workspace.html?invisible_for_pull=1",
  // active: false }) 后台开一个；本入口跳过 first-run / autocapture / import 等用户感知副作用，
  // 让 BUILD_PULL_READY_PAYLOAD listener（由 workspace-publish.js init 注册）就绪后
  // 给 SW 发 WORKSPACE_READY_FOR_PULL 通知。整个过程对用户透明（active=false 不夺焦）。
  const isInvisibleForPull = params.get("invisible_for_pull") === "1";
  const validCaptureModes = new Set(["selection", "raw", "readable"]);
  const requestedCaptureMode = params.get("mode");
  const pendingCaptureMode =
    requestedCaptureMode && validCaptureModes.has(requestedCaptureMode)
      ? requestedCaptureMode
      : "readable";

  const isFirstRun =
    !state.session?.lastSourceUrl && !state.settings?.apiKey && !state.settings?.apiBaseUrl;

  // 从工具栏「抓取并打开」或「热点一键入库」进入时优先完成入库，避免被首次引导挡住
  // invisible_for_pull tab 跳过所有用户感知副作用（first-run / autocapture / import）
  // 但 init 已经全跑完，BUILD_PULL_READY_PAYLOAD listener 已就绪，发 ready signal 让 SW 转入 PULL 流程
  if (isInvisibleForPull) {
    chrome.runtime
      .sendMessage({ type: "WORKSPACE_READY_FOR_PULL" })
      .catch(() => {});
    return;
  }

  const incomingFlow = wantAutoCapture || wantImportSession;
  if (isFirstRun && !incomingFlow) {
    view.firstRunOverlay.hidden = false;
    return;
  }
  if (isFirstRun && incomingFlow) {
    view.firstRunOverlay.hidden = true;
  }

  if (!state.source) view.emptyPromptCard.hidden = false;

  // 热点页可以追加 &autoRewrite=1，让用户「抓取 → 入库 → AI 改写」一步完成。
  // 入库失败时不会自动改写（避免在空稿上跑 AI 出空结果）。
  const wantAutoRewrite = params.get("autoRewrite") === "1";

  if (wantAutoCapture) {
    await captureSource(pendingCaptureMode);
    if (wantAutoRewrite && state.source) {
      await rewriteArticle();
    }
  } else if (wantImportSession) {
    // 热点「一键入库」：service worker 已经把 capture 写进 session.lastCapture，
    // 这里负责把它套到当前 article 上，并把正文按当前排版填入编辑器。
    const ok = await importCurrentSourceToArticle();
    if (!ok) {
      setStatus("热点已入库，但解析正文失败，请到来源面板手动检查或重抓。", "warning");
      return;
    }
    if (wantAutoRewrite) {
      // 入库成功后立刻触发改写。rewriteArticle 自己处理 license/AI 配置缺失的提示，
      // 这里不需要额外守护。
      await rewriteArticle();
    }
  }
}

function _bindGlobalEvents(ctx) {
  document.querySelector("#openOptionsButton")?.addEventListener("click", openSettings);
  document.querySelector("#openHotTopicsButton")?.addEventListener("click", openHotTopicsPage);
  document.querySelector("#openHelpButton")?.addEventListener("click", openHelp);

  const syncTargets = [
    controls.title, controls.author, controls.digest,
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
  const activeIndex = Number(state.settings?.activeWechatProfileIndex ?? -1);
  if (activeIndex >= 0 && activeIndex < profiles.length) {
    select.value = String(activeIndex);
  } else {
    select.value = "-1";
  }
  // 选择改变时把 activeWechatProfileIndex 持久化到本地 settings，
  // 这样下次打开编辑台、或刷新页面都能恢复到上次选的账号。
  if (!select.dataset.boundChange) {
    select.dataset.boundChange = "1";
    select.addEventListener("change", async () => {
      const idx = Number(select.value);
      try {
        await saveSettings({
          activeWechatProfileIndex: Number.isFinite(idx) ? idx : -1
        });
        state.settings = await getSettings();
      } catch (error) {
        console.warn("[gzh] persist active wechat profile failed:", error);
      }
    });
  }
}

function _bindStorageSync() {
  if (!chrome?.storage?.onChanged) return;
  chrome.storage.onChanged.addListener(async (changes, area) => {
    if (area !== "local" || !changes.settings) return;
    try {
      state.settings = await getSettings();
      _loadWechatProfiles();
      hydrateDefaults();
    } catch (error) {
      console.warn("[gzh] settings sync failed:", error);
    }
  });
}

function _bindFirstRunEvents() {
  // 主 CTA：免费试一次抓取改写 — 直接关掉 overlay 并触发抓取
  document.querySelector("#firstRunStartTrial")?.addEventListener("click", () => {
    if (view.firstRunOverlay) view.firstRunOverlay.hidden = true;
    document.querySelector("#captureButton")?.click();
  });
  // 副 CTA：稍后配置 — 关掉 overlay，进入空编辑台
  document.querySelector("#firstRunSkipButton")?.addEventListener("click", () => {
    if (view.firstRunOverlay) view.firstRunOverlay.hidden = true;
  });
  document.querySelector("#firstRunHelpLink")?.addEventListener("click", (event) => {
    event.preventDefault();
    chrome.tabs.create({ url: chrome.runtime.getURL("src/pages/help.html") });
  });
  document.querySelector("#emptyPromptCaptureButton")?.addEventListener("click", () => {
    view.emptyPromptCard.hidden = true;
    document.querySelector("#captureButton")?.click();
  });

  // 用 onboarding 共享模块渲染 4 步任务清单到 overlay 内
  void _renderFirstRunChecklist();
  // storage 变化时增量刷新（不跳路由，不重新弹层）
  if (globalThis.chrome?.storage?.onChanged) {
    chrome.storage.onChanged.addListener(() => void _renderFirstRunChecklist());
  }
}

async function _renderFirstRunChecklist() {
  const list = document.querySelector("#firstRunSteps");
  const progress = document.querySelector("#firstRunProgress");
  if (!list) return;

  let snap;
  try {
    const mod = await import("../shared/onboarding.js");
    snap = await mod.getOnboardingSnapshot();
  } catch (err) {
    console.warn("[workspace] onboarding snapshot failed", err);
    return;
  }

  if (progress) {
    if (snap.allDone) {
      progress.textContent = "已全部完成 · 可关闭此弹层";
    } else {
      progress.textContent = `完成 ${snap.completedCount} / ${snap.steps.length} · 还差 ${snap.pendingCount} 步`;
    }
  }

  list.innerHTML = "";
  snap.steps.forEach((step, idx) => {
    const li = document.createElement("li");
    li.className = "onboarding-step";
    li.dataset.stepId = step.id;
    li.dataset.status = step.status;

    const num = document.createElement("span");
    num.className = "onboarding-step-num";
    if (step.status === "completed") {
      num.textContent = "✓";
    } else if (step.status === "skipped") {
      num.textContent = "—";
    } else {
      num.textContent = String(idx + 1);
    }

    const body = document.createElement("div");
    body.className = "onboarding-step-body";

    const titleRow = document.createElement("div");
    titleRow.className = "onboarding-step-title-row";

    const title = document.createElement("p");
    title.className = "onboarding-step-title";
    title.textContent = step.title;

    const badge = document.createElement("span");
    badge.className = "onboarding-step-badge";
    badge.dataset.status = step.status;
    if (step.status === "completed") badge.textContent = "已完成";
    else if (step.status === "skipped") badge.textContent = "已跳过";
    else badge.textContent = step.skippable ? "可跳过" : "未完成";

    titleRow.append(title, badge);

    const desc = document.createElement("p");
    desc.className = "onboarding-step-desc muted";
    desc.textContent = step.desc;

    body.append(titleRow, desc);
    li.append(num, body);
    list.appendChild(li);
  });
}
