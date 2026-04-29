/**
 * workspace-publish.js
 * 负责：推草稿/发布、发布状态轮询、同步网页编辑器、历史记录抽屉操作。
 * 通过 init(ctx) 接收跨模块依赖，不直接 import 其他 workspace-* 模块。
 */

import { deleteSnapshot, listSnapshots, loadSnapshot, saveSnapshot } from "../shared/history.js";
import { getSettings } from "../shared/storage.js";
import { WECHAT_WEB_EDITOR_URL, THEME_PRESETS } from "../shared/defaults.js";
import { clampIndex, formatRuntimeError } from "../shared/utils.js";
import { prepareHtmlForWechat } from "../shared/wechat-html.js";
import { ensureHostPermissionFromGesture } from "../shared/host-permissions.js";
import { collectPublishRemoteUrls } from "../shared/wechat.js";

/**
 * 判断当前 settings 是否有任何"可发布"的公众号通道。
 *
 * - browser 模式 profile：有 name 即可（不需要 AppID/AppSecret，靠 mp 登录态）
 * - api 模式 profile：必须 appId + appSecret 都非空
 * - 兼容历史：用户从未建 profile，但单独填了 settings.wechatAppId/AppSecret 也算可用
 *
 * 用于 publishBundle 早拦截 —— 没绑公众号时给用户清晰的"先去设置页"提示，
 * 而不是让流程跑到 SW 调 chrome.permissions.request 撞 user gesture 错。
 */
function hasAnyUsableWechatProfile(settings) {
  const profiles = Array.isArray(settings?.wechatProfiles) ? settings.wechatProfiles : [];
  const hasUsableProfile = profiles.some((p) => {
    if (!p) return false;
    if (p.mode === "browser") return Boolean(String(p.name || "").trim());
    return Boolean(String(p.appId || "").trim() && String(p.appSecret || "").trim());
  });
  if (hasUsableProfile) return true;
  // 兼容旧用户：没建 profile 但单独填了默认 AppID/AppSecret
  return Boolean(
    String(settings?.wechatAppId || "").trim() &&
      String(settings?.wechatAppSecret || "").trim()
  );
}

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

  // P1.2 · 群发策略 radio + tag_id 输入框联动 + 配额提示。
  // 用户每次切策略都重新 render 提示文案，避免"看不到为什么 tag_id 没生效"。
  document.querySelectorAll('input[name="publishSendStrategy"]').forEach((input) => {
    input.addEventListener("change", _refreshSendStrategyUi);
  });
  // 把设置页的默认值带过来
  void _hydrateSendStrategyDefaults();

  // P1.1 · 「需要认证账号」兜底 modal 的关闭 + 复制 HTML 按钮
  const closeBtn = document.querySelector("#closeVerifiedAccountModalButton");
  const copyBtn = document.querySelector("#copyHtmlForManualPasteButton");
  const verifiedBackdrop = document.querySelector("#verifiedAccountModalBackdrop");
  if (closeBtn) closeBtn.addEventListener("click", _closeVerifiedAccountModal);
  if (verifiedBackdrop) verifiedBackdrop.addEventListener("click", _closeVerifiedAccountModal);
  if (copyBtn) copyBtn.addEventListener("click", _copyCurrentArticleHtmlForPaste);

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

/**
 * P1.2 · 把 settings 里的群发默认值 hydrate 到发布面板上，让用户看到的不是空状态。
 * 不在 init() 里同步取，是因为 storage.get 是 async；用 fire-and-forget 兼顾顺手。
 */
async function _hydrateSendStrategyDefaults() {
  try {
    const settings = await getSettings();
    const radios = document.querySelectorAll('input[name="publishSendStrategy"]');
    const defaultStrategy = ["none", "all", "tag"].includes(settings.wechatSendStrategy)
      ? settings.wechatSendStrategy
      : "none";
    radios.forEach((r) => {
      r.checked = r.value === defaultStrategy;
    });
    const tagInput = document.querySelector("#publishSendTagId");
    if (tagInput && settings.wechatSendTagId) {
      tagInput.value = String(settings.wechatSendTagId);
    }
    const ignoreInput = document.querySelector("#publishSendIgnoreReprint");
    if (ignoreInput) ignoreInput.checked = Boolean(settings.wechatSendIgnoreReprint);
    _refreshSendStrategyUi();
  } catch (err) {
    console.warn("[workspace-publish] hydrate sendStrategy failed:", err);
  }
}

function _refreshSendStrategyUi() {
  const checked = document.querySelector('input[name="publishSendStrategy"]:checked');
  const strategy = checked?.value || "none";
  const tagRow = document.querySelector("#publishSendStrategyTagRow");
  const ignoreRow = document.querySelector("#publishSendIgnoreReprintRow");
  const quotaHint = document.querySelector("#publishSendQuotaHint");
  if (tagRow) tagRow.hidden = strategy !== "tag";
  if (ignoreRow) ignoreRow.hidden = strategy === "none";
  if (quotaHint) {
    if (strategy === "all") {
      // 异步读 storage 渲染本月已用次数，避免在 UI 文案里 hardcode 数值
      void _renderSendAllQuotaHint(quotaHint);
    } else if (strategy === "tag") {
      quotaHint.textContent = "群发到指定标签不计入「全员 4 次/月」配额，可放心使用。";
    } else {
      quotaHint.textContent = "";
    }
  }
}

async function _renderSendAllQuotaHint(el) {
  try {
    const settings = await getSettings();
    const now = new Date();
    const monthKey = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
    const used = settings.wechatSendAllUsageMonth === monthKey
      ? Number(settings.wechatSendAllUsageCount) || 0
      : 0;
    el.textContent = `本月已用 ${used} / 4 次「群发全员」配额（自维护估算，新月自动归零）。`;
  } catch {
    el.textContent = "本月「群发全员」配额读取失败。";
  }
}

// ── P1.1 · 「需要认证账号」兜底 modal ──

/** 显示「需要认证账号」的兜底弹窗。errorPayload = response.error，可能含 errcode / message。 */
function _openVerifiedAccountModal(errorPayload) {
  const modal = document.querySelector("#verifiedAccountModal");
  const backdrop = document.querySelector("#verifiedAccountModalBackdrop");
  const detail = document.querySelector("#verifiedAccountModalDetail");
  if (!modal || !backdrop) return;
  modal.hidden = false;
  modal.removeAttribute("aria-hidden");
  backdrop.hidden = false;
  if (detail) {
    const errcode = errorPayload?.errcode ? `errcode=${errorPayload.errcode} · ` : "";
    const msg = errorPayload?.message || "";
    detail.textContent = msg ? `${errcode}${msg}` : "";
  }
}

function _closeVerifiedAccountModal() {
  const modal = document.querySelector("#verifiedAccountModal");
  const backdrop = document.querySelector("#verifiedAccountModalBackdrop");
  if (modal) {
    modal.hidden = true;
    modal.setAttribute("aria-hidden", "true");
  }
  if (backdrop) backdrop.hidden = true;
}

async function _copyCurrentArticleHtmlForPaste() {
  const { state, getCurrentArticle, buildExportHtmlForArticle, setStatus } = _ctx;
  try {
    const current = typeof getCurrentArticle === "function"
      ? getCurrentArticle()
      : state.articleBundle?.[state.currentArticleIndex || 0];
    if (!current) {
      setStatus("当前没有可复制的文章。", "warning");
      return;
    }
    // 用最终给公众号用的 themed + sanitize 后 HTML，确保粘贴到后台「HTML 源码」时排版完整
    const themed = buildExportHtmlForArticle(current);
    const sanitized = prepareHtmlForWechat(themed);
    await navigator.clipboard.writeText(sanitized);
    setStatus("已复制到剪贴板。请到公众号后台「素材管理 → 新建图文」点正文区右上角『&lt;&gt; HTML 源码』粘贴。", "success");
  } catch (err) {
    setStatus(`复制失败：${err?.message || err}`, "warning");
  }
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

  // 提到 try 外，catch 块才能在错误信息里带上当前账号名
  let accountLabel = "默认账号";

  try {
    syncCurrentArticleFromControls();
    const validationError = validateCurrentArticleForPublish();
    if (validationError) {
      setStatus(validationError, "warning");
      return;
    }

    state.settings = await getSettings();

    // 早拦截：用户连一个可发布的公众号通道都没有时，给清晰文案直接 return；
    // 否则流程会跑到 SW 端调 chrome.permissions.request 撞 user gesture，
    // 用户只能看到无意义的 "This function must be called during a user gesture"。
    if (!hasAnyUsableWechatProfile(state.settings)) {
      setStatus(
        "尚未绑定公众号。请到设置页「公众号发布」分区新建一个账号 —— " +
          "推荐用「浏览器登录模式」（不需要 AppID/AppSecret，复用浏览器登录态），" +
          "或填好 AppID + AppSecret 走 API 模式。",
        "warning"
      );
      return;
    }

    // 多账号切换：把"用户在编辑台选的发布账号"作为 payload 显式传给 background。
    // 之前的实现只在 workspace 端 mutate state.settings，但 background 收到 PUBLISH_TO_WECHAT
    // 后会重新 getSettings()，于是又退回到默认账号——这是多账号发布失效的根因。
    const profileIndex = Number(_ctx.controls.wechatProfileSelect?.value ?? -1);
    const profiles = Array.isArray(state.settings.wechatProfiles) ? state.settings.wechatProfiles : [];
    let accountOverride = null;
    // 缺失 mode 字段视为 "api"，保护历史 profile（向后兼容契约）
    let publishChannel = "api";
    if (profileIndex >= 0 && profiles[profileIndex]) {
      const profile = profiles[profileIndex];
      accountLabel = profile.name?.trim() || `账号 ${profileIndex + 1}`;
      publishChannel = profile.mode === "browser" ? "browser" : "api";

      if (publishChannel === "api") {
        accountOverride = {
          wechatAppId: String(profile.appId || "").trim(),
          wechatAppSecret: String(profile.appSecret || "").trim(),
          wechatDefaultAuthor: String(profile.author || "").trim()
        };
        if (!accountOverride.wechatAppId || !accountOverride.wechatAppSecret) {
          setStatus(
            `选中的发布账号「${accountLabel}」缺少 AppID 或 AppSecret，请先到设置页补全。`,
            "warning"
          );
          return;
        }
      }
    }

    if (publishChannel === "browser") {
      showLoading(
        `正在通过浏览器登录模式同步到公众号编辑器 · 账号「${accountLabel}」`,
        "扩展会自动打开 mp 后台编辑页，把内容写入；最后一步『保存草稿』需要你在 mp 后台手动点。"
      );
    } else {
      showLoading(
        `${mode === "publish" ? "正在提交多图文发布" : "正在推送多图文草稿包"} · 账号「${accountLabel}」`,
        "先上传图片，再创建草稿，通常 5–15 秒。"
      );
    }

    const payload = await _buildWechatPublishPayload(mode);
    payload.accountOverride = accountOverride;
    payload.accountLabel = accountLabel;
    payload.profileIndex = profileIndex;
    // 浏览器登录模式让 SW 短路到 wechat-browser-bridge.js，跳过 cgi-bin 链路
    if (publishChannel === "browser") {
      payload.publishMode = "browser";
    }
    // P1.2 · 把发布面板里临时选的群发策略带过去（API 模式才用得到）
    Object.assign(payload, _readSendStrategyFromUi());

    // 必须在 click handler 用户手势上下文里申请 host permission ——
    // SW 端的 ensureOptionalHostPermission 没有 user activation，调
    // chrome.permissions.request 会抛 "must be called during a user gesture"。
    // 这里 grant 三类 origin：① wechatApiBase 自定义代理（非空才需要） ② 远端
    // 封面 / 正文图片 URL（用户从外部贴入或抓取来源不在 host_permissions 时）。
    // browser 模式下 SW 走 wechat-browser-bridge.js 不调 cgi-bin，但封面图仍可能
    // 是远端 URL，所以这条 grant 对两种 mode 都适用。
    const publishOrigins = [
      state.settings.wechatApiBase || "",
      ...collectPublishRemoteUrls(payload)
    ];
    const permitted = await ensureHostPermissionFromGesture(
      publishOrigins,
      `公众号发布（${accountLabel}）`
    );
    if (!permitted) {
      setStatus(
        `账号「${accountLabel}」：发布需要授权访问相关网站（公众号 API / 封面图来源等），请在弹窗里点「允许」后重试。`,
        "warning"
      );
      return;
    }

    const response = await chrome.runtime.sendMessage({ type: "PUBLISH_TO_WECHAT", payload });

    if (!response?.ok) {
      // P1.1 · 48001/53400：触发"复制 HTML 手动粘贴"弹窗，避免用户对着红 toast 干瞪眼
      if (response?.error?.requiresVerifiedAccount) {
        _openVerifiedAccountModal(response.error);
      }
      // 浏览器登录模式 cookie 失效：顺手帮用户开 mp 登录页，比让他自己复制网址友好
      if (response?.error?.code === "WECHAT_BROWSER_NOT_LOGGED_IN") {
        try {
          await chrome.tabs.create({ url: "https://mp.weixin.qq.com/", active: true });
        } catch {}
      }
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
    // P1.2 · 群发全员后立即重画配额提示，让用户实时看到「3/4」「4/4」
    if (response.data?.sendStrategy === "all") {
      _refreshSendStrategyUi();
    }
    await saveCurrentDraftRecord(mode === "publish" ? "发布完成" : "推送到公众号草稿箱");

    if (response.data.publishId) {
      startPublishStatusPolling(response.data.publishId);
    } else {
      clearPublishPolling();
    }

    const failedImages = response.data.failedImages || [];
    if (response.data?.mode === "browser") {
      // 浏览器登录模式：内容已写入 mp 后台编辑页，提醒用户手动完成最后 3 步
      const tail = response.data?.requiresMultiArticleManual
        ? "（多图文：当前仅同步了第一篇，其余请在 mp 后台「添加一条」后用『复制正文 HTML』粘贴。）"
        : "";
      setStatus(
        `账号「${accountLabel}」已写入公众号编辑器：请在 mp 后台手动 ① 上传封面图 ② 点「保存为草稿」。${tail}`,
        "success"
      );
    } else if (failedImages.length > 0) {
      const lines = failedImages.map(
        (f) => `第 ${f.articleIndex} 篇 · ${f.type === "cover" ? "封面" : "正文图片"}：${f.error || "上传失败"}`
      );
      setStatus(
        `账号「${accountLabel}」` +
          (mode === "publish" ? "已提交发布，但部分图片上传失败。" : "草稿已推送，但部分图片上传失败。") +
          " " +
          lines.join("；"),
        "warning"
      );
    } else {
      setStatus(
        `账号「${accountLabel}」` +
          (mode === "publish"
            ? "已提交发布请求，正在自动查询发布状态。"
            : "已成功推送到公众号草稿箱。"),
        "success"
      );
    }
    resetRetryCount();
  } catch (error) {
    const accountTag = accountLabel ? `账号「${accountLabel}」：` : "";
    setErrorStatus(
      error._errorObj || {
        code: "UNKNOWN",
        message: `${accountTag}${error.message || "公众号发布失败。"}`,
        retryable: false
      },
      `${accountTag}公众号发布失败。`,
      () => publishBundle(mode)
    );
  } finally {
    hideLoading();
  }
}

/**
 * 从发布面板的 radio + 输入框读出群发策略，返回 payload 片段。
 * 永远只返回 publishMode === "publish" 时该带的字段；草稿模式下后端忽略。
 */
function _readSendStrategyFromUi() {
  const checked = document.querySelector('input[name="publishSendStrategy"]:checked');
  const strategy = checked?.value === "all" || checked?.value === "tag" ? checked.value : "none";
  const tagId = Number(document.querySelector("#publishSendTagId")?.value || 0);
  const ignoreReprint = Boolean(document.querySelector("#publishSendIgnoreReprint")?.checked);
  return {
    sendStrategy: strategy,
    sendTagId: strategy === "tag" ? tagId : 0,
    sendIgnoreReprint: ignoreReprint
  };
}

async function _buildWechatPublishPayload(mode) {
  const { state, buildExportHtmlForArticle, ensureFallbackCoverImage } = _ctx;
  const articles = [];
  const autoGeneratedIndexes = [];

  for (const [index, article] of state.articleBundle.entries()) {
    if (!article.meta.title.trim()) throw new Error(`第 ${index + 1} 篇没有填写标题。`);

    // P1.3 · 封面救济：用户没选封面（包括抓取无图、index 为 0、或图被删掉了），
    // 不再硬抛错——自动用文章标题生成一张简洁的占位封面，让"无封面图也能推"对
    // 用户感知就是"一键就能推"。微信 add_draft 仍然能拿到合法 thumb_media_id。
    let coverImage = state.source?.images?.[Number(article.meta.coverImageIndex || 0) - 1] || null;
    if (!coverImage?.src) {
      if (typeof ensureFallbackCoverImage !== "function") {
        throw new Error(
          `第 ${index + 1} 篇还没有封面图。请在「采集信息」面板上传本地图片或一键生成占位封面后重试。`
        );
      }
      coverImage = await ensureFallbackCoverImage(article);
      autoGeneratedIndexes.push(index + 1);
    }

    // 公众号 add_draft 对 HTML 极挑剔：先用 prepareHtmlForWechat 把容器
    // 标签、class、危险节点和零宽字符干净化；再 tokenize 图片以便后台批量
    // 替换为 wxbiz 的 url。两步顺序不能颠倒，否则占位符可能被 sanitizer
    // 当成普通文本而附带样式被改写。
    const themedHtml = buildExportHtmlForArticle(article);
    const sanitizedHtml = prepareHtmlForWechat(themedHtml);
    const preparedHtml = _tokenizeImages(sanitizedHtml);
    articles.push({
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
    });
  }

  // 把自动生成情况告诉用户，避免"莫名多了张占位封面"的困惑
  if (autoGeneratedIndexes.length > 0) {
    _ctx.syncWorkspace();
    _ctx.schedulePersist();
    _ctx.setStatus(
      `第 ${autoGeneratedIndexes.join(" / ")} 篇没有封面图，已为它自动生成简洁占位封面（建议后续替换为更合适的图片）。`,
      "warning"
    );
  }

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
    showLoading(
      "正在同步到公众号网页编辑器",
      "将打开公众号网页编辑器，并自动写入正文。"
    );
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
  setStatus("已恢复这篇的草稿记录，刚才的内容也留了一份「恢复前备份」。", "success");
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
