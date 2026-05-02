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
/**
 * 38th 续 11：检查当前文章是否有 in-flight rewrite task，是的话给 setStatus
 * warning 引导用户等改写完成，并返回 true 让上游 return。
 *
 * 触发场景：用户在改写 task 还在 SW 跑（task center 模式异步）时点
 * 「同步到公众号编辑器」/「立即发布」/「推送到草稿箱」——按钮触发的
 * syncCurrentArticleFromControls() 把当前 editor DOM 同步回 article（editor
 * 仍是改写**前**的内容），后续发到公众号的就是旧版本。等改写 done apply 之后
 * editor 才更新，但同步/发布的请求已经走出去了，无法撤回。
 *
 * 修法：sync / publish 入口顶部 LIST_TASKS 检查同 articleId 的 rewrite task。
 * 找到 running/pending 时阻止操作 + 引导。
 */
async function _hasInFlightRewriteTask(articleId) {
  if (!articleId) return false;
  try {
    const resp = await chrome.runtime.sendMessage({ type: "LIST_TASKS" });
    const running = resp?.data?.running || [];
    const pending = resp?.data?.pending || [];
    return [...running, ...pending].some(
      (t) => t?.type === "rewrite" && t?.articleId === articleId
    );
  } catch {
    // LIST_TASKS 失败不阻塞主流程（task center 关闭等场景），保守返回 false
    return false;
  }
}

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
  // 立即发布是危险操作（直连 mass/sendall 推到粉丝可见无法撤回），加二次确认 modal
  document.querySelector("#publishNowButton").addEventListener("click", () =>
    _openPublishConfirmModal()
  );
  document.querySelector("#cancelPublishConfirmButton")?.addEventListener("click", _closePublishConfirmModal);
  document.querySelector("#publishConfirmBackdrop")?.addEventListener("click", _closePublishConfirmModal);
  document.querySelector("#confirmPublishNowButton")?.addEventListener("click", () => {
    _closePublishConfirmModal();
    void publishBundle("publish");
  });
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

  // 「请先绑定公众号」前置 modal —— 比 setStatus 底部红字更明确
  const closeBindBtn = document.querySelector("#closeNeedWechatProfileModalButton");
  const goBindBtn = document.querySelector("#goBindWechatProfileButton");
  const bindBackdrop = document.querySelector("#needWechatProfileModalBackdrop");
  if (closeBindBtn) closeBindBtn.addEventListener("click", _closeNeedWechatProfileModal);
  if (bindBackdrop) bindBackdrop.addEventListener("click", _closeNeedWechatProfileModal);
  if (goBindBtn) goBindBtn.addEventListener("click", _openOptionsToBindProfile);

  // mp 编辑页悬浮助手「📥 从润笔取最新草稿」按钮 → SW 转发回 workspace tab
  // 让我们在这里构造 payload。复用 _buildWechatPublishPayload 的 themed HTML +
  // sanitize 链路，但跳过封面 fallback 与 _tokenizeImages（PULL 不需要 wxbiz
  // 替换占位符，封面在合规底线下由用户在 mp 后台手动上传）。
  // SW 不能直接调拼装链路因为它依赖 DOMParser（MV3 SW 无 DOM API）。
  if (chrome?.runtime?.onMessage) {
    chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
      if (message?.type !== "BUILD_PULL_READY_PAYLOAD") return false;
      // payload.articleId（可选，多草稿选择器 v0.2）：指明拉哪一篇；不传则拉当前激活那篇
      const requestedArticleId = String(message.payload?.articleId || "").trim();
      _buildPullReadyPayload(requestedArticleId)
        .then((result) => sendResponse({ ok: true, ...result }))
        .catch((err) => {
          sendResponse({
            ok: false,
            error: err?.message || "构造 payload 失败",
            errorCode: err?.code || "FLOATING_BALL_BUILD_FAILED"
          });
        });
      return true; // async sendResponse
    });
  }

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

  // 「本次发布」列表（36th session 后续）：发布面板按勾选状态过滤 articleBundle，
  // 让用户能在多图文里逐篇挑选哪几篇本次发出去。事件委托一次绑定 covers
  // checkbox toggle + [编辑] 跳转。
  const publishArticleList = document.querySelector("#publishArticleList");
  if (publishArticleList) {
    publishArticleList.addEventListener("change", (event) => {
      const target = event.target;
      if (!(target instanceof HTMLInputElement)) return;
      if (target.dataset.publishToggle === undefined) return;
      const idx = Number(target.dataset.index);
      const article = state.articleBundle[idx];
      if (!article) return;
      article.meta = { ...article.meta, publishEnabled: target.checked };
      _ctx.schedulePersist();
      renderPublishArticleList();
    });
    publishArticleList.addEventListener("click", (event) => {
      const jumpBtn = event.target.closest("[data-jump-to-index]");
      if (!jumpBtn) return;
      const idx = Number(jumpBtn.dataset.jumpToIndex);
      if (Number.isFinite(idx) && idx >= 0 && idx < state.articleBundle.length) {
        _ctx.switchArticle?.(idx);
        if ((location.hash || "").replace(/^#/, "") !== "layout") {
          location.hash = "layout";
        }
      }
    });
  }

  // 「📜 从历史草稿拉入」按钮 + picker modal 事件
  const pickHistoryBtn = document.querySelector("#pickFromHistoryButton");
  if (pickHistoryBtn) pickHistoryBtn.addEventListener("click", () => void openPickHistoryModal());
  const closePickHistoryBtn = document.querySelector("#closePickHistoryButton");
  if (closePickHistoryBtn) closePickHistoryBtn.addEventListener("click", _closePickHistoryModal);
  const pickHistoryBackdrop = document.querySelector("#pickHistoryBackdrop");
  if (pickHistoryBackdrop) pickHistoryBackdrop.addEventListener("click", _closePickHistoryModal);
  const pickHistoryBackBtn = document.querySelector("#pickHistoryBackButton");
  if (pickHistoryBackBtn) pickHistoryBackBtn.addEventListener("click", _showPickHistoryRecordList);

  // picker 内列表（事件委托：record 选择 → article 选择 → append）
  const recordList = document.querySelector("#pickHistoryRecordList");
  const articleList = document.querySelector("#pickHistoryArticleList");
  if (recordList) {
    recordList.addEventListener("click", (event) => {
      const btn = event.target.closest("[data-pick-record-id]");
      if (!btn) return;
      _showPickHistoryArticleList(btn.dataset.pickRecordId);
    });
  }
  if (articleList) {
    articleList.addEventListener("click", (event) => {
      const btn = event.target.closest("[data-pick-article-index]");
      if (!btn) return;
      const recordId = btn.dataset.pickRecordId;
      const articleIndex = Number(btn.dataset.pickArticleIndex);
      void pickHistoryArticleAndAppend(recordId, articleIndex);
    });
  }
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

// ── 「请先绑定公众号」前置 modal ──
//
// 触发场景：publishBundle 检测到 hasAnyUsableWechatProfile === false。
// 设计上比 setStatus 底部红字更强：必须用户明确点「去绑定」或「稍后」才消失，
// 避免用户错过提示重复点发布。

function _openNeedWechatProfileModal() {
  const modal = document.querySelector("#needWechatProfileModal");
  const backdrop = document.querySelector("#needWechatProfileModalBackdrop");
  if (!modal || !backdrop) return;
  modal.hidden = false;
  modal.removeAttribute("aria-hidden");
  backdrop.hidden = false;
}

function _closeNeedWechatProfileModal() {
  const modal = document.querySelector("#needWechatProfileModal");
  const backdrop = document.querySelector("#needWechatProfileModalBackdrop");
  if (modal) {
    modal.hidden = true;
    modal.setAttribute("aria-hidden", "true");
  }
  if (backdrop) backdrop.hidden = true;
}

function _openOptionsToBindProfile() {
  // 直达"多账号管理"分区（twenty-third session 重排后此分区已升主线，新手可见）。
  // chrome.runtime.getURL 拼绝对路径，避免 chrome-extension:// 协议下打开 options 页失败。
  const url = chrome.runtime.getURL("src/options/options.html#opt-anchor-profiles");
  try {
    chrome.tabs.create({ url, active: true });
  } catch {
    // 极端兜底：直接 window.open（无关闭 modal 也没关系，用户已经离开 workspace tab）
    window.open(url, "_blank");
  }
  _closeNeedWechatProfileModal();
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

    // 38th 续 11：改写还在跑时拦截——publishBundle batch 发整个 articleBundle，
    // 检查任何 publishEnabled=true 的 article 是否有 in-flight rewrite task；
    // 有则阻止发布，避免把改写**前**的旧 article 推到公众号无法撤回。
    const enabledForPublish = state.articleBundle.filter(
      (a) => a?.meta?.publishEnabled !== false
    );
    for (const article of enabledForPublish) {
      if (await _hasInFlightRewriteTask(article?.id)) {
        const title = article?.meta?.title?.trim() || "未命名";
        setStatus(
          `《${title}》正在 AI 改写中，请等改写完成（看右下角任务中心）再发布，避免发出旧版本。`,
          "warning"
        );
        return;
      }
    }

    state.settings = await getSettings();

    // 早拦截：用户连一个可发布的公众号通道都没有时，弹 modal 强提醒并给"去设置页"
    // CTA。不用 setStatus 底部红字 —— 容易被忽略，且没有可点的"去绑定"出口，
    // 用户会反复点发布拿到同一条无意义错误。
    if (!hasAnyUsableWechatProfile(state.settings)) {
      _openNeedWechatProfileModal();
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

  // 按发布面板「本次发布」勾选状态过滤（meta.publishEnabled !== false 视为勾选）。
  // 保留 originalIndex 用于错误消息——用户视觉里看到的是 bundle 里的"第 N 篇"，
  // filter 只在发布 payload 里跳过未勾选篇，bundle 顺序和位置都不动。
  const enabledEntries = state.articleBundle
    .map((article, originalIndex) => ({ article, originalIndex }))
    .filter(({ article }) => article.meta?.publishEnabled !== false);

  if (enabledEntries.length === 0) {
    throw new Error(
      "没有勾选任何文章。请在发布面板的「本次发布」列表里至少勾选一篇。"
    );
  }

  for (const { article, originalIndex: index } of enabledEntries) {
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

/**
 * 「mp 编辑页悬浮助手」专用 payload 构造（v0.2 升级支持多草稿 + profile 联动）。
 *
 * 返回结构：
 *   { payload: { meta, html, fromFloatingBall, profile }, drafts: [...] }
 *   - payload  → 即将发给 mp content script 的 IMPORT_ARTICLE_TO_WECHAT_EDITOR
 *   - drafts   → 浮球 dock 渲染多草稿选择器用：当前 articleBundle 各篇 + (未来 v0.3) 历史归档
 *
 * 与 _buildWechatPublishPayload 的区别：
 *   - 只处理一篇（articleId 指定，缺省 = currentArticleIndex 当前激活那篇）
 *   - 跳过封面 fallback（合规：mp 后台手动上传）
 *   - 跳过 _tokenizeImages（PULL 不走 cgi-bin/draft/add）
 *   - 注入 profile 元信息（articleId / targetProfileIndex / targetProfileName）让 mp 浮球做账号比对
 *
 * @param {string} articleId - 可选；指明拉哪篇。空 = 当前激活那篇。
 */
async function _buildPullReadyPayload(articleId = "") {
  const { state, buildExportHtmlForArticle } = _ctx;
  const bundle = Array.isArray(state.articleBundle) ? state.articleBundle : [];

  if (bundle.length === 0) {
    const err = new Error("润笔工作台还没有草稿，请先抓一篇内容或 AI 改写一次。");
    err.code = "FLOATING_BALL_NO_DRAFT";
    throw err;
  }

  // 选哪一篇
  let chosenIndex = -1;
  if (articleId) {
    chosenIndex = bundle.findIndex((a) => a?.id === articleId);
  }
  if (chosenIndex < 0) {
    chosenIndex = Number(state.currentArticleIndex || 0);
    if (chosenIndex < 0 || chosenIndex >= bundle.length) chosenIndex = 0;
  }
  const article = bundle[chosenIndex];

  if (!String(article?.meta?.title || "").trim()) {
    const err = new Error(
      `${articleId ? "选中的草稿" : "当前篇"}没有填写标题，请在工作台编辑器里补上标题再来拉。`
    );
    err.code = "FLOATING_BALL_NO_TITLE";
    throw err;
  }

  // 38th 续 13：与 syncCurrentToWebEditor / publishBundle 对齐——浮球 PULL
  // 也走"用户行为终态送出"语义，必须先检查目标 article 是否有 in-flight rewrite，
  // 否则会把改写**前**的旧版本拉到 mp 编辑器（38th 续 11 漏了浮球这条入口）。
  if (await _hasInFlightRewriteTask(article?.id)) {
    const err = new Error(
      `《${article.meta.title.trim()}》正在 AI 改写中，请等改写完成（看右下角任务中心）再从 mp 浮球拉草稿。`
    );
    err.code = "FLOATING_BALL_REWRITE_IN_FLIGHT";
    throw err;
  }

  const themedHtml = buildExportHtmlForArticle(article);
  const sanitizedHtml = prepareHtmlForWechat(themedHtml);

  // 解析 article 关联的 wechatProfile（v0.2 profile 联动完整版）。
  // article.meta.targetProfileIndex 由 collectCurrentArticleMeta 自动跟 wechatProfileSelect 同步。
  // 缺失（老草稿 / 默认账号）→ -1，浮球端 mp 比对时知道"不强制比对"。
  const profiles = Array.isArray(state.settings?.wechatProfiles) ? state.settings.wechatProfiles : [];
  const targetProfileIndex = Number.isFinite(Number(article?.meta?.targetProfileIndex))
    ? Number(article.meta.targetProfileIndex)
    : -1;
  const targetProfileName =
    targetProfileIndex >= 0 && profiles[targetProfileIndex]
      ? String(profiles[targetProfileIndex].name || "").trim()
      : "";

  // 多草稿列表：当前 bundle 所有篇 + 标记当前选中那篇
  const drafts = bundle.map((a, i) => ({
    id: a?.id || `idx-${i}`,
    title: String(a?.meta?.title || "").trim() || `第 ${i + 1} 篇（未命名）`,
    wordCount: typeof a?.bodyHtml === "string" ? a.bodyHtml.replace(/<[^>]+>/g, "").trim().length : 0,
    targetProfileIndex: Number(a?.meta?.targetProfileIndex ?? -1),
    targetProfileName:
      profiles[Number(a?.meta?.targetProfileIndex ?? -1)]?.name || "",
    selected: i === chosenIndex
  }));

  // 38th 续 14：用户报"无法感知是哪一片草稿推送过去了"——给 mp 端透传 bundle
  // 元数据，让 importArticle 完成后能渲染清晰的 toast + 顶部 banner。
  // bodyChars 用 bodyHtml 去标签后字符数（与 collectCurrentArticleMeta 字数统计口径一致）
  const bodyChars = typeof article?.bodyHtml === "string"
    ? article.bodyHtml.replace(/<[^>]+>/g, "").trim().length
    : 0;

  return {
    payload: {
      meta: {
        title: article.meta.title.trim(),
        author: String(article.meta.author || "").trim(),
        digest:
          String(article.meta.digest || "").trim() || _ctx.deriveDigestFromArticle(article),
        contentSourceUrl: String(article.meta.contentSourceUrl || "").trim(),
        // 与浏览器登录模式 push 通道同款：dock 显示合规清单
        publishMode: "browser"
      },
      html: sanitizedHtml,
      fromFloatingBall: true,
      // profile 联动元数据：mp 端 content script 读 mp 后台导航栏当前账号名做匹配
      profile: {
        targetProfileIndex,
        targetProfileName
      },
      // 当前选中的 article id（dock 多草稿 select 默认选中项）
      selectedArticleId: article.id || `idx-${chosenIndex}`,
      // bundle 元数据透传给 mp 端 toast / banner 显示"第 N/M 篇 · K 字"
      bundle: {
        articleId: article.id || `idx-${chosenIndex}`,
        index: chosenIndex + 1,  // 1-based 给用户看
        total: bundle.length,
        bodyChars,
        syncedAt: Date.now()
      }
    },
    drafts
  };
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
    // 38th 续 11：改写还在跑时拦截——避免同步改写前的旧版本到 mp 编辑器
    if (await _hasInFlightRewriteTask(current?.id)) {
      setStatus(
        "当前文章正在 AI 改写中，请等改写完成（看右下角任务中心）再同步，避免同步出旧版本。",
        "warning"
      );
      return;
    }
    showLoading(
      "正在同步到公众号网页编辑器",
      "将打开公众号网页编辑器，并自动写入正文。"
    );
    // 38th 续 12：紧急 revert——c7ea3f0 加的 prepareHtmlForWechat 清洗对 mp
    // web editor DOM 注入逻辑不兼容（unwrap div→section + strip class + 白名单
    // 属性，mp 编辑器吃不下导致 section 内容被 fold 掉，用户实测 7000 字草稿
    // 同步过去只剩 15 字）。prepareHtmlForWechat 仅适合 cgi-bin add_draft API。
    // mp web editor 走 contenteditable 注入路径，需要保留 div + class + 完整
    // inline style 让编辑器自己 sanitize。
    // 直发 buildExportHtmlForArticle 产物（含主题样式）即可——虽然与 publishBundle
    // 经过 prepareHtmlForWechat 后的视觉**不完全一致**，但有内容比"对齐了但全
    // 是空白"重要 100 倍。HTML 一致性问题留待 wechat-editor-helper.js importArticle
    // sanitizer 升级后再做（需要确认它能接受什么标签集）。
    const html = buildExportHtmlForArticle(current);
    const response = await chrome.runtime.sendMessage({
      type: "SYNC_TO_WECHAT_WEB_EDITOR",
      payload: {
        meta: {
          title: current.meta.title,
          author: current.meta.author,
          digest: current.meta.digest,
          contentSourceUrl: current.meta.contentSourceUrl
        },
        html,
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

// =====================================================================
// 「立即发布」二次确认 modal（38th session 续优化）
// =====================================================================

function _openPublishConfirmModal() {
  document.querySelector("#publishConfirmBackdrop")?.removeAttribute("hidden");
  document.querySelector("#publishConfirmModal")?.removeAttribute("hidden");
}

function _closePublishConfirmModal() {
  document.querySelector("#publishConfirmBackdrop")?.setAttribute("hidden", "");
  document.querySelector("#publishConfirmModal")?.setAttribute("hidden", "");
}

// =====================================================================
// 「本次发布」列表渲染 + 历史草稿拉入 picker（36th session 后续）
// =====================================================================

function _escapeHtml(s) {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function _articlePlainTextLength(article) {
  try {
    const text = (
      new DOMParser().parseFromString(article.bodyHtml || "", "text/html").body
        .textContent || ""
    ).replace(/\s+/g, "");
    return text.length;
  } catch {
    return 0;
  }
}

/**
 * 渲染发布面板「本次发布」列表，每篇 article 一行：checkbox + 标题 + 字数 + 编辑按钮。
 * 在 syncWorkspace 链路里被调用，bundle 任何变化都会重新渲染。
 *
 * 也根据当前勾选数动态更新 #publishCurrentButton / #publishNowButton 的 disabled 态。
 */
export function renderPublishArticleList() {
  const list = document.querySelector("#publishArticleList");
  if (!list) return;
  const { state } = _ctx;
  const bundle = Array.isArray(state.articleBundle) ? state.articleBundle : [];

  if (bundle.length === 0) {
    list.innerHTML = `<li class="publish-bundle-empty">还没有草稿。先去抓取或新建一篇文章。</li>`;
  } else {
    list.innerHTML = bundle
      .map((article, idx) => {
        const enabled = article.meta?.publishEnabled !== false;
        const title = article.meta?.title?.trim() || `（未命名第 ${idx + 1} 篇）`;
        const charCount = _articlePlainTextLength(article);
        const titleLen = (article.meta?.title || "").length;
        const titleWarn = titleLen > 64 ? " ⚠️ 标题超 64 字" : "";
        return `
          <li class="publish-bundle-item${enabled ? "" : " is-disabled"}" role="listitem">
            <label class="publish-bundle-label">
              <input type="checkbox" data-publish-toggle data-index="${idx}" ${enabled ? "checked" : ""} aria-label="发布第 ${idx + 1} 篇" />
              <span class="publish-bundle-info">
                <strong class="publish-bundle-title" title="${_escapeHtml(title)}">${idx + 1}. ${_escapeHtml(title)}</strong>
                <small class="publish-bundle-meta">字数 ${charCount}${titleWarn}</small>
              </span>
            </label>
            <button type="button" class="ghost-button-mini" data-jump-to-index="${idx}" title="切到编辑排版">编辑</button>
          </li>
        `;
      })
      .join("");
  }

  // 同步发布按钮 disabled 态
  const enabledCount = bundle.filter((a) => a.meta?.publishEnabled !== false).length;
  const publishCurrentBtn = document.querySelector("#publishCurrentButton");
  const publishNowBtn = document.querySelector("#publishNowButton");
  const tip = enabledCount === 0 ? "请至少勾选一篇文章再发布" : "";
  if (publishCurrentBtn) {
    publishCurrentBtn.disabled = enabledCount === 0;
    if (tip) publishCurrentBtn.title = tip;
    else publishCurrentBtn.removeAttribute("title");
  }
  if (publishNowBtn) {
    publishNowBtn.disabled = enabledCount === 0;
    if (tip) publishNowBtn.title = tip;
    else publishNowBtn.removeAttribute("title");
  }
}

// ─── 历史拉入 picker ────────────────────────────────────────────────

let _pickHistoryActiveRecordId = null;

async function openPickHistoryModal() {
  const { state, setStatus } = _ctx;
  await refreshHistoryRecords();
  const entries = Array.isArray(state.historyEntries) ? state.historyEntries : [];
  if (entries.length === 0) {
    setStatus("还没有历史草稿快照。先去抓取/改写/发布一篇，系统会自动留存历史。", "info");
    return;
  }
  _pickHistoryActiveRecordId = null;
  _showPickHistoryRecordList();
  document.querySelector("#pickHistoryBackdrop")?.removeAttribute("hidden");
  document.querySelector("#pickHistoryModal")?.removeAttribute("hidden");
}

function _closePickHistoryModal() {
  document.querySelector("#pickHistoryBackdrop")?.setAttribute("hidden", "");
  document.querySelector("#pickHistoryModal")?.setAttribute("hidden", "");
  _pickHistoryActiveRecordId = null;
}

function _showPickHistoryRecordList() {
  const { state } = _ctx;
  const entries = Array.isArray(state.historyEntries) ? state.historyEntries : [];
  const recordList = document.querySelector("#pickHistoryRecordList");
  const articleList = document.querySelector("#pickHistoryArticleList");
  const backBtn = document.querySelector("#pickHistoryBackButton");
  const hint = document.querySelector("#pickHistoryHint");
  _pickHistoryActiveRecordId = null;

  if (recordList) {
    recordList.innerHTML = entries
      .slice(0, 20)
      .map((e) => {
        const dateLabel = e.createdAt ? new Date(e.createdAt).toLocaleString("zh-CN") : "";
        const articleCount = Array.isArray(e.articleBundle) ? e.articleBundle.length : 0;
        const mainTitle = e.articleBundle?.[0]?.meta?.title?.trim()
          || e.sourcePreview?.title
          || "（未命名）";
        return `
          <li>
            <button type="button" class="pick-history-record-btn" data-pick-record-id="${_escapeHtml(e.id)}">
              <strong>${_escapeHtml(e.label || "草稿快照")}</strong>
              <small>${_escapeHtml(dateLabel)} · ${articleCount} 篇 · 《${_escapeHtml(mainTitle)}》</small>
            </button>
          </li>
        `;
      })
      .join("");
  }
  if (articleList) articleList.setAttribute("hidden", "");
  if (recordList) recordList.removeAttribute("hidden");
  if (backBtn) backBtn.setAttribute("hidden", "");
  if (hint) hint.textContent = "先选一份历史快照，再选其中一篇文章追加到本次发布。";
}

function _showPickHistoryArticleList(recordId) {
  const { state } = _ctx;
  const entries = Array.isArray(state.historyEntries) ? state.historyEntries : [];
  const record = entries.find((e) => e.id === recordId);
  if (!record || !Array.isArray(record.articleBundle) || record.articleBundle.length === 0) {
    _ctx.setStatus("这份快照里没有文章。", "warning");
    return;
  }
  _pickHistoryActiveRecordId = recordId;
  const recordList = document.querySelector("#pickHistoryRecordList");
  const articleList = document.querySelector("#pickHistoryArticleList");
  const backBtn = document.querySelector("#pickHistoryBackButton");
  const hint = document.querySelector("#pickHistoryHint");

  if (articleList) {
    articleList.innerHTML = record.articleBundle
      .map((article, idx) => {
        const title = article.meta?.title?.trim() || `（未命名第 ${idx + 1} 篇）`;
        const charCount = _articlePlainTextLength(article);
        return `
          <li>
            <button type="button" class="pick-history-article-btn" data-pick-record-id="${_escapeHtml(recordId)}" data-pick-article-index="${idx}">
              <strong>${idx + 1}. ${_escapeHtml(title)}</strong>
              <small>字数 ${charCount}</small>
            </button>
          </li>
        `;
      })
      .join("");
  }
  if (recordList) recordList.setAttribute("hidden", "");
  if (articleList) articleList.removeAttribute("hidden");
  if (backBtn) backBtn.removeAttribute("hidden");
  if (hint) hint.textContent = `从「${record.label || "草稿快照"}」里选一篇追加到本次发布。`;
}

async function pickHistoryArticleAndAppend(recordId, articleIndex) {
  const { state, setStatus, schedulePersist, applyCurrentArticleToControls, syncWorkspace, normalizeArticleDoc } = _ctx;
  const entries = Array.isArray(state.historyEntries) ? state.historyEntries : [];
  const record = entries.find((e) => e.id === recordId);
  if (!record || !Array.isArray(record.articleBundle)) {
    setStatus("快照已不存在或损坏。", "warning");
    _closePickHistoryModal();
    return;
  }
  const sourceArticle = record.articleBundle[articleIndex];
  if (!sourceArticle) {
    setStatus("找不到这篇文章。", "warning");
    return;
  }

  // 公众号多图文上限 = 8 篇，达上限拒绝
  const MAX = 8;
  if (state.articleBundle.length >= MAX) {
    setStatus(`已达多图文上限 ${MAX} 篇，请先取消勾选或删除一篇再追加。`, "warning");
    return;
  }

  // clone 时去掉 id 让 normalizeArticleDoc 重新生成新 id（避免与 bundle 现有 article 撞 id）
  const cloned = normalizeArticleDoc({
    meta: { ...sourceArticle.meta, publishEnabled: true },
    bodyHtml: sourceArticle.bodyHtml || ""
  });
  state.articleBundle.push(cloned);
  state.currentArticleIndex = state.articleBundle.length - 1;

  schedulePersist();
  applyCurrentArticleToControls();
  syncWorkspace();

  const title = cloned.meta?.title?.trim() || "未命名";
  setStatus(`已添加《${title}》到本次发布。可在「本次发布」列表里取消勾选不发它。`, "success");
  _closePickHistoryModal();
}
