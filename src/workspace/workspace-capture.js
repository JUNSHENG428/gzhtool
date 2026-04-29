/**
 * workspace-capture.js
 * 负责：抓取网页（captureSource）。
 * 通过 init(ctx) 接收跨模块依赖，不直接 import 其他 workspace-* 模块。
 *
 * 抓取成功后，会把 source.blocks（含图片、表格、代码、列表）按当前选中的主题
 * 自动填入编辑器正文，并补齐标题/副标题/导语；用户可以直接编辑或再点 AI 改写。
 */

import { composeSourceBodyHtml, buildSourceMetaDraft } from "../shared/source-to-html.js";
import { getSession } from "../shared/storage.js";
import { originPatternFromUrl } from "../shared/host-permissions.js";

let _ctx;

/**
 * 在前端用户手势上下文里把目标网页 origin 的 host permission 先要好。
 *
 * 后台 service worker 没有 user activation，调 `chrome.permissions.request` 必抛
 * "must be called during a user gesture"。把 grant 这一步提前到 click handler 里
 * 同步发起，SW 后续 contains 检查就直接返回 true。
 *
 * 取目标 URL 的方式：从 session 读 lastSourceUrl —— 这是上次「抓取最近浏览页」
 * 时 SW 存进去的（service-worker.js:796 / 836）。第一次抓取（没 lastSourceUrl）
 * 由 SW 去 chrome.tabs.query 取活跃 tab 决定，那种情况下前端不知道 URL，
 * 直接放行让 SW 自己处理 —— 此时 SW 走 contains 路径基本能通过（Chrome 在
 * activeTab 模式下自动给当前 tab 临时授权），不再撞 user gesture。
 */
async function ensureScrapeHostPermission() {
  if (!globalThis.chrome?.permissions) return true;
  let session;
  try {
    session = await getSession();
  } catch {
    return true;
  }
  const origin = originPatternFromUrl(session?.lastSourceUrl || "");
  if (!origin) return true;
  const granted = await chrome.permissions.contains({ origins: [origin] });
  if (granted) return true;
  return chrome.permissions.request({ origins: [origin] });
}

export function init(ctx) {
  _ctx = ctx;
  document.querySelector("#captureButton").addEventListener("click", () => captureSource());
}

const VALID_CAPTURE_MODES = new Set(["selection", "raw", "readable"]);

const CAPTURE_MODE_LABELS = {
  selection: "正在抓取选中文字...",
  raw: "正在原样抓取整页...",
  readable: "正在抓取页面内容..."
};

export async function captureSource(captureMode) {
  const {
    view,
    state,
    setStatus,
    setErrorStatus,
    showLoading,
    hideLoading,
    applyCurrentArticleToControls,
    syncWorkspace,
    schedulePersist,
    saveCurrentDraftRecord,
    resetRetryCount,
    getCurrentArticle,
    controls
  } = _ctx;

  const mode = VALID_CAPTURE_MODES.has(captureMode) ? captureMode : "readable";
  const useTaskCenter = state.settings.useTaskCenter !== false;
  const requestId = `cap-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

  if (useTaskCenter) {
    setStatus("已加入抓取队列，进度看右下角任务中心。可以继续做别的事。", "info");
  } else {
    showLoading(
      CAPTURE_MODE_LABELS[mode] || CAPTURE_MODE_LABELS.readable,
      "通常 1–3 秒，结果会出现在「采集信息」面板。"
    );
  }

  try {
    // 必须在 click handler 还在用户手势上下文时同步发起 grant，
    // 否则 SW 那边 chrome.permissions.request 会抛 "must be called during a user gesture"。
    const permitted = await ensureScrapeHostPermission();
    if (!permitted) {
      setErrorStatus(
        null,
        "需要授权访问该网页才能抓取，请在弹窗里点「允许」后重试。",
        () => captureSource(mode)
      );
      return;
    }

    const currentForRequest = getCurrentArticle();
    const response = await chrome.runtime.sendMessage({
      type: "SCRAPE_LAST_SOURCE_TAB",
      payload: {
        captureMode: mode,
        requestId,
        articleId: currentForRequest?.id || "",
        articleTitle: currentForRequest?.meta?.title?.trim() || "抓取页面"
      }
    });
    if (!response?.ok) {
      setErrorStatus(response?.error, "抓取失败。", () => captureSource(mode));
      return;
    }

    if (useTaskCenter) {
      // task-center 模式：apply 由 onTaskDone 触发（按 articleId 路由）。
      // 但 capture 还有个特殊语义——抓取**当前**触发的页面，绝大多数场景用户就停在该 article，
      // 所以为了"用户体验立刻反馈"在当前 article 也直接写一遍。task-center.onTaskDone 后续
      // 触发 applyCaptureTaskResult 时会基于 articleId 二次确认（同 article 不会双重 apply，
      // 已有 source 的话 autoFill 是幂等的）。
      _applyCaptureSourceToCurrentArticle(response.data);
      resetRetryCount();
      return;
    }

    // 老 modal 模式：直接 apply
    _applyCaptureSourceToCurrentArticle(response.data);
    resetRetryCount();
  } finally {
    if (!useTaskCenter) {
      hideLoading();
    }
  }
}

/**
 * 把抓取结果（source）apply 到当前 article。当前模式下用户大概率停在触发抓取的 article。
 * task-center 模式 apply 路径与老 modal 模式共用此函数。
 */
function _applyCaptureSourceToCurrentArticle(source) {
  const {
    view,
    state,
    setStatus,
    applyCurrentArticleToControls,
    syncWorkspace,
    schedulePersist,
    saveCurrentDraftRecord,
    getCurrentArticle,
    controls
  } = _ctx;

  state.source = source;
  for (const article of state.articleBundle) {
    if (!article.meta.contentSourceUrl) {
      article.meta.contentSourceUrl = state.source.url || "";
    }
    if (!article.meta.coverImageIndex && state.source.images.length > 0) {
      article.meta.coverImageIndex = 1;
    }
  }

  const currentForCapture = getCurrentArticle();
  if (currentForCapture) {
    currentForCapture.meta.contentSourceUrl = state.source.url || "";
    currentForCapture.meta.cta = "";
  }

  if (!state.selectedImageIndex && state.source.images.length > 0) {
    state.selectedImageIndex = 1;
  }

  const autoFilled = autoFillEditorFromSource(currentForCapture);

  applyCurrentArticleToControls();
  syncWorkspace();
  schedulePersist();
  void saveCurrentDraftRecord("抓取网页");

  const blockCount = state.source.blocks?.length || 0;
  const imageCount = state.source.images?.length || 0;
  const themeLabel = controls?.theme?.value ? `（主题：${controls.theme.value}）` : "";
  if (autoFilled) {
    setStatus(
      `已抓取 ${blockCount} 块内容、${imageCount} 张图片，并按当前排版填入正文${themeLabel}。可直接编辑或点「AI 改写」。`,
      "success"
    );
  } else {
    setStatus(`已抓取 ${blockCount} 个内容块和 ${imageCount} 张图片。`, "success");
  }

  view.emptyPromptCard.hidden = true;
}

/**
 * task-center.onTaskDone 触发：处理用户已切走时回来点[查看]的场景。
 * 当前 article 切回到任务关联 article 后再 apply source。
 */
export async function applyCaptureTaskResult(task) {
  const {
    state,
    setStatus
  } = _ctx;
  const result = task?.result;
  if (!result?.source) return;

  const articleId = task.articleId || result.articleId || "";
  // 用户切回了发起抓取的 article 才 apply（task-center.goToArticle 触发）
  const idx = articleId
    ? state.articleBundle.findIndex((a) => a.id === articleId)
    : -1;
  if (idx < 0) {
    setStatus(
      `《${task.articleTitle || "抓取页面"}》抓取完成，但目标稿件已删除。`,
      "warning"
    );
    return;
  }

  // 切到该 article（如果还没切）+ apply
  if (state.currentArticleIndex !== idx) {
    state.currentArticleIndex = idx;
  }
  _applyCaptureSourceToCurrentArticle(result.source);
}

/**
 * 把已经在 state.source 里的 capture（例如热点「一键入库」走 SCRAPE_BACKGROUND_AND_IMPORT
 * 后存到 session 的那份）自动套用到当前文章上。
 *
 * 与 captureSource 不同：不再走 service worker 抓页，仅做「source → article」的本地填充。
 * 当前 article 的 bodyHtml 会被覆盖（与 captureSource 一致：换页面 = 换正文）；
 * meta 字段仅在原值为空时才补上，避免冲掉用户已经填的标题/导语。
 *
 * 返回 true 表示完成自动填充，false 表示没有 source 或 source 没有可用正文。
 */
export async function importCurrentSourceToArticle() {
  const {
    view,
    state,
    setStatus,
    controls,
    applyCurrentArticleToControls,
    syncWorkspace,
    schedulePersist,
    saveCurrentDraftRecord,
    getCurrentArticle
  } = _ctx;

  if (!state.source) return false;

  for (const article of state.articleBundle) {
    if (!article.meta.contentSourceUrl) {
      article.meta.contentSourceUrl = state.source.url || "";
    }
    if (!article.meta.coverImageIndex && state.source.images.length > 0) {
      article.meta.coverImageIndex = 1;
    }
  }

  // 与 captureSource 同步：热点「一键入库」也是"换页面 = 换正文"语义，
  // 当前篇的原文链接 / 结尾语都按新一轮抓取覆盖。
  const currentForImport = getCurrentArticle();
  if (currentForImport) {
    currentForImport.meta.contentSourceUrl = state.source.url || "";
    currentForImport.meta.cta = "";
  }

  if (!state.selectedImageIndex && state.source.images.length > 0) {
    state.selectedImageIndex = 1;
  }

  const autoFilled = autoFillEditorFromSource(currentForImport);

  applyCurrentArticleToControls();
  syncWorkspace();
  schedulePersist();

  if (!autoFilled) {
    return false;
  }

  await saveCurrentDraftRecord("热点入库");

  const blockCount = state.source.blocks?.length || 0;
  const imageCount = state.source.images?.length || 0;
  const themeLabel = controls?.theme?.value ? `（主题：${controls.theme.value}）` : "";
  setStatus(
    `已把热点正文入库：${blockCount} 块内容、${imageCount} 张图片，按当前排版填入${themeLabel}。可直接编辑或点「AI 改写」。`,
    "success"
  );
  view.emptyPromptCard.hidden = true;
  return true;
}

/**
 * 把当前抓到的 source 自动套用到当前文章上：
 *   - 标题/副标题/导语：仅当原来为空才填，避免覆盖用户的编辑
 *   - 正文 bodyHtml：每次抓取都重写（与现有「换页面 = 换正文」的产品语义一致）
 *
 * 返回 true 表示完成自动填充，false 表示 source 没有正文可填。
 */
function autoFillEditorFromSource(article) {
  if (!article || !_ctx?.state?.source) return false;
  const source = _ctx.state.source;
  const html = composeSourceBodyHtml(source);
  if (!html) return false;

  article.bodyHtml = html;

  const draft = buildSourceMetaDraft(source);
  if (draft) {
    article.meta = article.meta || {};
    if (!article.meta.title && draft.title) article.meta.title = draft.title;
    if (!article.meta.subtitle && draft.subtitle) article.meta.subtitle = draft.subtitle;
    // author 仅在原值（含设置里的默认作者）为空时填，避免覆盖用户的署名习惯
    if (!article.meta.author && draft.author) article.meta.author = draft.author;
    if (!article.meta.lead && draft.lead) article.meta.lead = draft.lead;
    if (!article.meta.digest && draft.digest) article.meta.digest = draft.digest;
  }

  // 抓到图就把第一张设成封面（不覆盖已设置的封面）
  if (
    !article.meta.coverImageIndex &&
    Array.isArray(source.images) &&
    source.images.length > 0
  ) {
    article.meta.coverImageIndex = 1;
  }

  return true;
}
