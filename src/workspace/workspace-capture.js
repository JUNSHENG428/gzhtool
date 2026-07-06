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
 * 取目标 URL 的方式：从 session 读 lastSourceUrl —— 这是上次「抓取当前网页」
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
  // debounce 提到 click handler 而不是 captureSource 函数体内：
  // captureSource 也被代码内部调用（错误条 [重试] 按钮 / 任务中心 retry / autoRewrite 引导），
  // 这些调用不该被"按钮防抖"误拦——之前 _lastCaptureClickAt < 1s 时连"用户点重试"都被
  // 阻挡，表现为"抓取功能失灵"（用户实测报障 38th session 续）。
  document.querySelector("#captureButton").addEventListener("click", (event) => {
    const now = Date.now();
    if (now - _lastCaptureClickAt < CAPTURE_CLICK_DEBOUNCE_MS) return;
    _lastCaptureClickAt = now;
    // 44th session · 抓取视图的「只抓选中/原样抓取」快捷按钮通过 dataset.captureMode
    // 传模式（见 workspace-router bindCaptureShortcuts）——此前这里从不读取，
    // 三个按钮实际全走 readable，UI 承诺与行为不符。读完即清，避免残留影响下次直点。
    const btn = event.currentTarget;
    const mode = btn?.dataset?.captureMode || "";
    if (btn?.dataset) delete btn.dataset.captureMode;
    captureSource(mode || undefined);
  });
}

const VALID_CAPTURE_MODES = new Set(["selection", "raw", "readable"]);

const CAPTURE_MODE_LABELS = {
  selection: "正在抓取选中文字...",
  raw: "正在抓取整页...",
  readable: "正在抓取页面内容..."
};

/**
 * 抓取按钮防抖：1s 内重复点 #captureButton 直接 return。
 * **debounce 在 init() 里的 click handler 做，不在 captureSource 函数体内**——
 * captureSource 也被代码内部调用（错误条[重试]、task center retry、autoRewrite 引导），
 * 这些调用不该被按钮防抖误拦。
 */
const CAPTURE_CLICK_DEBOUNCE_MS = 1000;
let _lastCaptureClickAt = 0;

/**
 * 44th session · 抓取结果 apply 去重：
 * task-center 模式下同一次抓取有两条 apply 路径——captureSource 同步 sendResponse 后
 * 立即 apply（用户停在原稿的即时反馈）+ onTaskDone → applyCaptureTaskResult（用户切走
 * 后跳回的场景）。此前两条路径**都会无条件执行**：第二次 apply 时当前稿已有内容，
 * `_hasMeaningfulArticle` 命中 → 又 addSubArticle 一篇，用户看到重复副篇。
 * 用 requestId 标记「已 apply」，先到先得，后到跳过。
 */
const _appliedCaptureRequestIds = new Set();
function _markCaptureApplied(requestId) {
  if (!requestId) return true; // 没有 requestId 的老路径不做去重
  if (_appliedCaptureRequestIds.has(requestId)) return false;
  _appliedCaptureRequestIds.add(requestId);
  if (_appliedCaptureRequestIds.size > 50) {
    const first = _appliedCaptureRequestIds.values().next().value;
    _appliedCaptureRequestIds.delete(first);
  }
  return true;
}

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
      // task-center 模式：用户停在触发抓取的 article 时同步 apply（即时反馈）；
      // 抓取期间切走了就跳过，交给 onTaskDone → applyCaptureTaskResult 按 articleId
      // 路由（否则会把结果写进用户正在编辑的**另一篇**稿件）。requestId 去重防双 apply。
      const currentNow = getCurrentArticle();
      const stillOnSameArticle =
        !currentForRequest?.id || currentNow?.id === currentForRequest.id;
      if (stillOnSameArticle && _markCaptureApplied(requestId)) {
        _applyCaptureSourceToCurrentArticle(response.data);
      }
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
 *
 * **保护用户旧草稿不被覆盖**（36th session 在 importCurrentSourceToArticle 加过同款逻辑，
 *  38th 续 5 同步到本函数）：当前 article 有"用户编辑过的有意义内容"时，自动新建空白
 *  副篇承载新抓的内容，旧草稿原样保留；空白草稿（restoreSession 恢复出的占位）保持
 *  原行为—覆盖空白是首次用户的流畅体验。达 MAX_WECHAT_ARTICLES = 8 时回退覆盖。
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
    addSubArticle,
    controls
  } = _ctx;

  state.source = source;

  // 关键：旧草稿保护——抓新页面 = 换内容，但不应覆盖用户编辑了一半的当前 article
  const currentBeforeCapture = getCurrentArticle();
  if (typeof addSubArticle === "function" && _hasMeaningfulArticle(currentBeforeCapture)) {
    const lengthBefore = state.articleBundle.length;
    addSubArticle();
    // addSubArticle 失败（达上限）时 length 不变，回退覆盖逻辑（保持可用，不破坏体验）
    if (state.articleBundle.length === lengthBefore) {
      setStatus("已达多图文上限 8 篇，新抓内容直接覆盖到当前篇。", "warning");
    }
  }

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

  // 抓取 fallback 标记（38th 续 6）：SW scrapeLastSourceTab 在 readable 抓空时
  // 自动回退到 raw mode，captureMode === "readable-fallback-raw" 时告诉用户
  // "建议在编辑前剔除噪声段"——raw 不过滤 BOILERPLATE_RE，杂质会多
  const usedFallback = state.source.captureMode === "readable-fallback-raw";

  if (usedFallback) {
    setStatus(
      `已自动回退到整页抓取（正文抓取失败 → ${blockCount} 块内容、${imageCount} 张图片）。建议在改写前删除评论 / 推荐 / 广告等噪声段。`,
      "warning"
    );
  } else if (autoFilled) {
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

  // 同一次抓取已在 captureSource 同步路径 apply 过 → 跳过，防重复建副篇
  if (!_markCaptureApplied(task.requestId)) return;

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
    getCurrentArticle,
    addSubArticle
  } = _ctx;

  if (!state.source) return false;

  // 用户在热点页 / topic-planner 点「抓取并改写」时走这条路径：state.source 是
  // 新抓的内容，而 articleBundle[currentArticleIndex] 可能是用户上次留下的旧草稿
  // （restoreSession 从 session.articleBundle 恢复）。直接覆盖会让 bodyHtml 是新的、
  // meta.title/lead/digest 是旧的（autoFillEditorFromSource 是 if-empty 逻辑），
  // 用户视觉上感觉"我的旧草稿被改写覆盖了"。
  //
  // 判定：当前 article 已有用户编辑过的有意义内容 → 自动新建空白副篇承载新抓的
  // 内容，旧草稿原样保留；当前 article 是空白则保持原行为（覆盖空白 article 是
  // 期望的、首次用户的流畅体验）。addSubArticle 内部会顺手 syncCurrentArticleFromControls
  // 保留当前编辑 + push 一篇空 article + 切 currentArticleIndex 到末尾。
  // 达到 MAX_WECHAT_ARTICLES 上限时 addSubArticle 静默不动 + setStatus warning，
  // 此时回退到覆盖逻辑（保持可用，不破坏既有体验）。
  const currentBeforeImport = getCurrentArticle();
  if (typeof addSubArticle === "function" && _hasMeaningfulArticle(currentBeforeImport)) {
    const lengthBefore = state.articleBundle.length;
    addSubArticle();
    // addSubArticle 失败（达上限）时 length 不变，回退覆盖
    if (state.articleBundle.length === lengthBefore) {
      setStatus("已达多图文上限 8 篇，新内容直接覆盖到当前篇。", "warning");
    }
  }

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
 * 判断 article 是否已有"用户编辑过的有意义内容"。用于 importCurrentSourceToArticle
 * 决定是覆盖当前 article 还是新建副篇。
 *
 * 阈值与 isEditorBodySubstantiveForRewrite 对齐（≥ 8 个有效字符 OR 含图片）。
 */
function _hasMeaningfulArticle(article) {
  if (!article) return false;
  const meta = article.meta || {};
  if (meta.title && String(meta.title).trim()) return true;
  if (meta.lead && String(meta.lead).trim()) return true;
  if (meta.digest && String(meta.digest).trim()) return true;
  const raw = String(article.bodyHtml || "").trim();
  if (!raw) return false;
  if (/<\s*img\b/i.test(raw) || /<\s*figure\b/i.test(raw)) return true;
  try {
    const text = (
      new DOMParser().parseFromString(raw, "text/html").body.textContent || ""
    ).replace(/\s+/g, "").trim();
    return text.length >= 8;
  } catch {
    return false;
  }
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

  // 38th 续 13：filter 掉 _disabled blocks（38th 续 9 加的 block 多选 UI 标记）。
  // 之前 autoFillEditorFromSource 把 source 直接拿去 composeSourceBodyHtml，
  // 不 filter _disabled → 用户在「采集信息」面板取消勾选某 block → state.source.blocks[i]._disabled=true
  // → 但 article.bodyHtml 已被全量 fill → 改写时走 buildRewriteSourceFromCurrentArticle
  // 解析 bodyHtml 全部内容，_disabled 完全不生效 = "幽灵漏洞"。
  // 这里 filter 后传给 composeSourceBodyHtml，让 bodyHtml 一开始就只含勾选的 blocks。
  const filteredBlocks = (source.blocks || []).filter((b) => !b?._disabled);
  const filteredSource = { ...source, blocks: filteredBlocks };
  const html = composeSourceBodyHtml(filteredSource);
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
