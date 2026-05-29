/**
 * workspace-rewrite.js
 * 负责：AI 改写（rewriteArticle）和复制手动 Prompt（copyManualPrompt）。
 * 通过 init(ctx) 接收跨模块依赖，不直接 import 其他 workspace-* 模块。
 */

import { createArticleDraftState } from "../shared/article.js";
import {
  getActiveTemplateId,
  getPromptTemplates,
  getSettings,
  saveSettings,
  savePromptTemplates,
  setActiveTemplateId
} from "../shared/storage.js";
import { PAID_FEATURES, checkDeAiBoostAccess } from "../shared/license.js";
import { showUpgradeModal } from "../shared/upgrade-modal.js";
import { openAiTemplateDialog } from "../shared/ai-template-dialog.js";
import {
  buildManualPrompt,
  buildRewriteSourceFromCurrentArticle,
  isEditorBodySubstantiveForRewrite
} from "../shared/ai.js";

const AI_GEN_OPTION_VALUE = "__ai_gen__";

/**
 * 判断 settings 是否有"可用的 AI 配置"。
 * 至少要 apiBaseUrl + apiKey 都非空才能跑 chat completions；model 缺失时
 * ai.js 会用 settings.model 兜底，但若也空则 requestRewrite 直接抛错。
 * 这里采用"接口地址 + Key 都填了就放行"的最低门槛 —— model 是否合法等
 * 服务端报错由测试连接 / 实际改写时的 fallback 处理。
 */
function hasUsableAiConfig(settings) {
  if (!settings) return false;
  const baseUrl = String(settings.apiBaseUrl || "").trim();
  const apiKey = String(settings.apiKey || "").trim();
  return Boolean(baseUrl && apiKey);
}

function _openNeedAiConfigModal() {
  const modal = document.querySelector("#needAiConfigModal");
  const backdrop = document.querySelector("#needAiConfigModalBackdrop");
  if (!modal || !backdrop) return;
  modal.hidden = false;
  modal.removeAttribute("aria-hidden");
  backdrop.hidden = false;
}

function _closeNeedAiConfigModal() {
  const modal = document.querySelector("#needAiConfigModal");
  const backdrop = document.querySelector("#needAiConfigModalBackdrop");
  if (modal) {
    modal.hidden = true;
    modal.setAttribute("aria-hidden", "true");
  }
  if (backdrop) backdrop.hidden = true;
}

function _openOptionsToBindAi() {
  // 直达「AI 改写接口」分区（twenty-third session 重排后此分区是首屏第一个）
  const url = chrome.runtime.getURL("src/options/options.html#opt-anchor-ai");
  try {
    chrome.tabs.create({ url, active: true });
  } catch {
    window.open(url, "_blank");
  }
  _closeNeedAiConfigModal();
}

let _ctx;
let _templates = [];
let _selectedTemplateId = "";
let _templateSelect = null;
// 当前 in-flight 的 rewrite requestId。SKIP_HUMANIZE_PASS 用它精确取消那一篇的 S2，
// 同时也是 REWRITE_PROGRESS 监听里筛选事件的 key（避免接收到别的 tab 的进度）。
let _currentRewriteRequestId = "";

export function init(ctx) {
  _ctx = ctx;
  // debounce 在 click handler 而非 rewriteArticle 函数体内：
  // rewriteArticle 也被代码内部调用（错误条 [重试] / 任务中心 retry / autoRewrite 引导），
  // 这些不该被按钮防抖误拦——之前用户点失败重试因 < 1s 被 return 表现为"功能失灵"。
  document.querySelector("#rewriteButton").addEventListener("click", () => {
    const now = Date.now();
    if (now - _lastRewriteClickAt < REWRITE_CLICK_DEBOUNCE_MS) return;
    _lastRewriteClickAt = now;
    void rewriteArticle();
  });
  document.querySelector("#copyPromptButton").addEventListener("click", copyManualPrompt);

  // 「请先配置 AI 接口」前置 modal 的关闭 + 跳转
  const closeAiBtn = document.querySelector("#closeNeedAiConfigModalButton");
  const goAiBtn = document.querySelector("#goBindAiConfigButton");
  const aiBackdrop = document.querySelector("#needAiConfigModalBackdrop");
  if (closeAiBtn) closeAiBtn.addEventListener("click", _closeNeedAiConfigModal);
  if (aiBackdrop) aiBackdrop.addEventListener("click", _closeNeedAiConfigModal);
  if (goAiBtn) goAiBtn.addEventListener("click", _openOptionsToBindAi);

  _templateSelect = document.querySelector("#rewriteTemplateSelect");
  hydrateTemplatePicker();

  // 「去 AI 味」检测 badge：点击切换详情面板
  const badgeBtn = document.querySelector("#humanizeBadge");
  badgeBtn?.addEventListener("click", () => {
    const panel = document.querySelector("#humanizePanel");
    if (!panel) return;
    const opened = !panel.hasAttribute("hidden") ? false : true;
    if (opened) panel.removeAttribute("hidden");
    else panel.setAttribute("hidden", "");
    badgeBtn.setAttribute("aria-expanded", String(opened));
  });

  // 「合规检查」badge：点击切换详情面板
  const complianceBadgeBtn = document.querySelector("#complianceBadge");
  complianceBadgeBtn?.addEventListener("click", () => {
    const panel = document.querySelector("#compliancePanel");
    if (!panel) return;
    const opened = panel.hasAttribute("hidden");
    if (opened) panel.removeAttribute("hidden");
    else panel.setAttribute("hidden", "");
    complianceBadgeBtn.setAttribute("aria-expanded", String(opened));
  });

  // 「去 AI 味」开关 chip：与 settings.humanizeEnabled 双向绑定
  initHumanizeToggleChip();

  // 「跳过润色」按钮：触发后立即取消当前 in-flight 的 humanize-pass，
  // 让 service-worker 用主 pass 结果直接 sendResponse。按钮平时隐藏，
  // 只有进入 pass2 阶段才由 progress 事件 unhide。
  initSkipHumanizeButton();

  // 监听 service-worker 推过来的 REWRITE_PROGRESS，更新顶部状态条进度文案
  if (chrome?.runtime?.onMessage) {
    chrome.runtime.onMessage.addListener((message) => {
      if (!message || message.type !== "REWRITE_PROGRESS") return;
      handleRewriteProgress(message.payload || {});
    });
  }

  if (chrome?.storage?.onChanged) {
    chrome.storage.onChanged.addListener((changes, areaName) => {
      if (areaName !== "local") return;
      if (
        changes.wechatWriterPromptTemplates ||
        changes.wechatWriterActiveTemplateId
      ) {
        hydrateTemplatePicker();
      }
      // 用户在 options 页切换了 humanizeEnabled，编辑台 chip 同步刷新
      if (changes.wechatWriterSettings) {
        refreshHumanizeChip().catch(() => {});
      }
    });
  }

  _templateSelect?.addEventListener("change", async () => {
    const value = _templateSelect.value || "";
    if (value === AI_GEN_OPTION_VALUE) {
      _templateSelect.value = _selectedTemplateId || "";
      const opened = await openAiGenTemplateFlow();
      if (!opened) {
        _templateSelect.value = _selectedTemplateId || "";
      }
      return;
    }
    _selectedTemplateId = value;
    await setActiveTemplateId(value);
    // 39th 续³ Batch 10：模板有 suggestedTheme 时自动切排版主题。
    // 用户报：「ai 模板的视觉排版风没出效果，基本是排版主题那里决定的」。
    // 根因：AI 模板生成器问卷里选的"视觉主题"被存到 template.suggestedTheme，
    // 但实际改写文章时 workspace 完全不读这个字段——视觉主题永远由 #themeSelect
    // 下拉决定。原代码只在保存 AI 模板时 toast 文案口头让用户「去编辑台手动切到 X」，
    // 用户经常没看 toast / 没耐心切，导致模板的视觉风格永远出不来。
    // 修法：用户切模板时自动应用其 suggestedTheme（保留 escape hatch—— 显式 toast
    // 告知"已自动切"+ 老主题名，用户想换随时点 #themeSelect 手动切回）。
    applyTemplateSuggestedTheme(value);
  });

  document
    .querySelector("#aiGenTemplateBtnLayout")
    ?.addEventListener("click", openAiGenTemplateFlow);
}

/**
 * 打开 AI 模板生成对话框，生成成功后自动保存 + 选中。
 * 由共享模块 src/shared/ai-template-dialog.js 处理 Pro 闸门 / 升级弹窗 / 表单。
 */
async function openAiGenTemplateFlow() {
  const setStatus = _ctx?.setStatus || (() => {});
  return openAiTemplateDialog({
    pricingUrl: (typeof window !== "undefined" && window.__pricingUrl) || undefined,
    setStatus,
    onSaved: async (template) => {
      const next = [..._templates, template];
      await savePromptTemplates(next);
      await setActiveTemplateId(template.id);
      _templates = next;
      _selectedTemplateId = template.id;
      renderTemplateOptions();
      // 39th 续³ Batch 10：AI 生成模板保存后也自动应用 suggestedTheme
      // （这是用户填问卷选 visualTheme 的最直接路径——刚保存就立即看到视觉效果，
      // 而不是等下次手动切模板）
      applyTemplateSuggestedTheme(template.id);
    }
  });
}

/**
 * 39th 续³ Batch 10 · 切模板时自动应用模板推荐的排版主题（suggestedTheme）。
 *
 * 设计要点：
 *   - 只在用户主动 change template 时切 theme（不在 hydrate / restore 时切，
 *     避免每次进 workspace 都强制覆盖用户上次手选的主题）
 *   - 已经是同主题时直接 return（避免重复 toast）
 *   - 检查 themeSelect 里有这个 option 才切（防 suggestedTheme 是已废弃的 id）
 *   - 触发 themeSelect 'change' 事件让现有 applyTheme listener 自然处理
 *   - toast 包含旧主题名 + 新主题名，让用户知道发生了什么 + 怎么切回
 */
function applyTemplateSuggestedTheme(templateId) {
  if (!templateId) return;
  const tpl = _templates.find((t) => t.id === templateId);
  const suggestedThemeId = String(tpl?.suggestedTheme || "").trim();
  if (!suggestedThemeId) return;

  const themeSelectEl = document.querySelector("#themeSelect");
  if (!themeSelectEl) return;
  if (themeSelectEl.value === suggestedThemeId) return; // 已经是了

  const optionExists = Array.from(themeSelectEl.options).some(
    (o) => o.value === suggestedThemeId
  );
  if (!optionExists) return; // suggestedTheme 已废弃 / option 不在

  const oldOpt = themeSelectEl.options[themeSelectEl.selectedIndex];
  const oldLabel = oldOpt?.textContent?.trim() || themeSelectEl.value;

  themeSelectEl.value = suggestedThemeId;
  themeSelectEl.dispatchEvent(new Event("change", { bubbles: true }));

  const newOpt = themeSelectEl.options[themeSelectEl.selectedIndex];
  const newLabel = newOpt?.textContent?.trim() || suggestedThemeId;

  const setStatus = _ctx?.setStatus || (() => {});
  setStatus(
    `已切到模板「${tpl.name}」推荐的「${newLabel}」排版（原「${oldLabel}」）。如需切回，请用顶部「排版主题」下拉手动选。`,
    "info"
  );
}

async function hydrateTemplatePicker() {
  if (!_templateSelect) return;
  try {
    const [templates, activeId] = await Promise.all([
      getPromptTemplates(),
      getActiveTemplateId()
    ]);
    _templates = templates;
    _selectedTemplateId = templates.some((t) => t.id === activeId) ? activeId : "";
    renderTemplateOptions();
  } catch (error) {
    // 静默失败：模板选择器只是辅助 UI
  }
}

function renderTemplateOptions() {
  if (!_templateSelect) return;
  const options = [
    '<option value="">默认 prompt（不套用模板）</option>',
    `<option value="${AI_GEN_OPTION_VALUE}" data-ai-gen="true">✨ 用 AI 生成新模板（PRO）</option>`
  ];
  for (const t of _templates) {
    const label = `${t.icon || "📝"} ${escapeAttr(t.name || t.id)}`;
    options.push(`<option value="${escapeAttr(t.id)}">${label}</option>`);
  }
  _templateSelect.innerHTML = options.join("");
  _templateSelect.value = _selectedTemplateId || "";
}

/**
 * 暂存每个 task 的 sourceImages（task center 模式下，apply 时需要）。
 * 用 in-memory Map 即可：用户刷新页面会丢，但刷新页面 task 也丢了。
 */
const _sourceImagesByRequestId = new Map();

/**
 * 改写按钮防抖：1s 内重复点 #rewriteButton 直接 return。
 * **debounce 在 init() 里的 click handler 做，不在 rewriteArticle 函数体内**——
 * rewriteArticle 也被代码内部调用（错误条[重试]、task center retry、autoRewrite 引导），
 * 这些调用不该被按钮防抖误拦。33rd session 在 task-registry 里加过同类型 dedup
 * 误伤连点意图，34th 移除；本次（38th 续）把 debounce 也从函数体提到 click handler 修同类问题。
 */
const REWRITE_CLICK_DEBOUNCE_MS = 1000;
let _lastRewriteClickAt = 0;

export async function rewriteArticle() {
  const {
    state,
    setStatus,
    setErrorStatus,
    showLoading,
    hideLoading,
    getCurrentArticle,
    syncCurrentArticleFromControls,
    collectRewritePreferences,
    resetRetryCount
  } = _ctx;

  syncCurrentArticleFromControls();
  const current = getCurrentArticle();
  let sourceForRewrite = null;
  let fromEditor = false;
  if (isEditorBodySubstantiveForRewrite(current.bodyHtml)) {
    fromEditor = true;
    sourceForRewrite = buildRewriteSourceFromCurrentArticle(state, current);
  } else if (state.source) {
    // 38th 续 9：source 中被用户在「采集信息」面板剔除（_disabled=true）的 block
    // 不进改写——让用户能精确控制哪些段进 LLM
    const enabledBlocks = (state.source.blocks || []).filter((b) => !b?._disabled);
    if (enabledBlocks.length === 0) {
      setStatus("当前来源所有内容块都被剔除了，请在「采集信息」面板勾选至少一段再改写。", "warning");
      return;
    }
    sourceForRewrite = { ...state.source, blocks: enabledBlocks };
  } else {
    setStatus("请先在编辑区写满一段正文，或先抓取一个网页再改写。", "warning");
    return;
  }

  // 早拦截：未配 AI 接口时弹 modal 强提醒，不让流程跑到 SW 后再撞 ai.js 的 throw。
  // 同 publishBundle 的 needWechatProfileModal 模式 —— modal 优于 setStatus 底部红字。
  const settingsForAiCheck = await getSettings();
  if (!hasUsableAiConfig(settingsForAiCheck)) {
    _openNeedAiConfigModal();
    return;
  }

  const templateId = _selectedTemplateId || "";
  const templateLabel = _templates.find((t) => t.id === templateId)?.name;
  // requestId 用于：
  //  - 把 REWRITE_PROGRESS 事件路由到本 tab 的进度条（多 tab 互不影响）
  //  - SKIP_HUMANIZE_PASS 精确取消「这一篇」的 S2
  const requestId = `rw-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  _currentRewriteRequestId = requestId;
  _sourceImagesByRequestId.set(requestId, sourceForRewrite?.images || []);

  // task center 模式（默认）：rewrite 不再阻塞 UI，结果由 task center 监听 TASK_LIST_CHANGED
  // 触发 applyRewriteTaskResult 写回；老 modal 模式（settings.useTaskCenter=false）走全屏 loading。
  const useTaskCenter = state.settings.useTaskCenter !== false;

  if (useTaskCenter) {
    setStatus(
      fromEditor
        ? `已加入改写队列（按当前编辑区正文）。可继续抓取或编辑其他文章——进度看右下角任务中心。`
        : `已加入改写队列${templateLabel ? `（模板：${templateLabel}）` : ""}。可继续抓取或编辑其他文章——进度看右下角任务中心。`,
      "info"
    );
  } else {
    showLoading(
      "正在 AI 改写当前篇",
      fromEditor
        ? templateLabel
          ? `正按当前编辑区正文 · 模板：${templateLabel} · 通常 8–25 秒，结果会更新到下方编辑器与预览。`
          : "正按当前编辑区正文改写，结果会更新到下方编辑器与预览。通常 8–25 秒。"
        : templateLabel
          ? `模板：${templateLabel} · 通常 8–25 秒，结果会更新到下方编辑器与预览。`
          : "通常 8–25 秒，结果会更新到下方编辑器与预览。"
    );
  }

  try {
    const response = await chrome.runtime.sendMessage({
      type: "REWRITE_ARTICLE",
      payload: {
        source: sourceForRewrite,
        preferences: collectRewritePreferences(),
        templateId,
        requestId,
        // 新加：让 SW 端 task-registry 能记录 article 关联。
        // articleTitle 取最新 source 的 title 优先（用户刚抓新文章时 article.meta.title
        // 可能还是旧值——autoFillEditorFromSource 是 if-empty 逻辑），保证任务面板
        // chip 显示的是"当前正在改写的内容的标题"，而不是上一次的。
        articleId: getCurrentArticle().id || "",
        articleTitle:
          sourceForRewrite?.title?.trim() ||
          getCurrentArticle().meta?.title?.trim() ||
          "未命名"
      }
    });

    if (!response?.ok) {
      // 闸门错误：弹升级框，不当作普通失败
      const code = response?.errorCode;
      if (code === "LICENSE_QUOTA_EXCEEDED") {
        const meta = PAID_FEATURES["ai.unlimitedDaily"];
        showUpgradeModal({
          featureName: meta.name,
          hint: response.error || meta.hint,
          bullets: [
            "Pro 不限改写次数，专注做高频内容生产",
            "支持高级模板：深度行业观察 / 故事化叙述 / 教程拆解",
            "免费版每日 5 次，0 点重置"
          ]
        });
        setStatus("已达免费版每日改写上限，可升级 Pro 解除限制。", "warning");
        return;
      }
      if (code === "LICENSE_TEMPLATE_LOCKED") {
        const meta = PAID_FEATURES["ai.advancedTemplates"];
        showUpgradeModal({
          featureName: meta.name,
          hint: response.error || meta.hint,
          bullets: [
            "Pro 解锁深度行业观察 / 故事化叙述 / 教程拆解 三套高质量模板",
            "免费版仍可用清单整理 / 新闻速读 + 全部自定义模板"
          ]
        });
        setStatus("当前模板需要 Pro 套餐，请换一个模板或升级。", "warning");
        return;
      }
      setErrorStatus(response?.error, "改写失败。", () => rewriteArticle());
      _sourceImagesByRequestId.delete(requestId);
      return;
    }

    if (useTaskCenter) {
      // task center 模式：result 已挂到 SW 端 task.result，task-center 监听 TASK_LIST_CHANGED
      // 检测到 task done → 调 applyRewriteTaskResult。这样用户切到别的 article 时 apply
      // 也能找到正确目标。这里不再直接写当前 article。
      resetRetryCount();
      return;
    }

    // 老 modal 模式：直接 apply 到当前 article（向后兼容 useTaskCenter=false）
    await _applyRewriteResultToCurrentArticle(response, sourceForRewrite?.images || []);
    resetRetryCount();
  } finally {
    _currentRewriteRequestId = "";
    setSkipButtonVisible(false);
    if (state.settings.useTaskCenter === false) {
      hideLoading();
    }
  }
}

/**
 * task-center.onTaskDone 触发：把 SW 端任务的改写结果写回对应 article。
 * 按 task.articleId 找 articleBundle 里的目标，找不到（用户已删 article）静默跳过。
 *
 * 与老 modal 模式区别：老模式下 result 直接写"当前 article"；task center 模式下用户
 * 可能已切走，必须按 articleId 路由。
 */
export async function applyRewriteTaskResult(task) {
  const result = task?.result;
  if (!result?.article) return;
  const {
    state,
    applyCurrentArticleToControls,
    syncWorkspace,
    schedulePersist,
    saveCurrentDraftRecord,
    setStatus
  } = _ctx;

  const articleId = task.articleId || result.articleId || "";
  const idx = articleId
    ? state.articleBundle.findIndex((a) => a.id === articleId)
    : -1;
  if (idx < 0) {
    setStatus(
      `《${task.articleTitle || "未命名"}》改写完成，但目标稿件已删除，结果未写回。`,
      "warning"
    );
    _sourceImagesByRequestId.delete(task.requestId);
    return;
  }

  const sourceImages = _sourceImagesByRequestId.get(task.requestId) || [];
  const draftState = createArticleDraftState(result.article, sourceImages);
  const target = state.articleBundle[idx];

  target.meta = {
    ...target.meta,
    title: draftState.meta.title || target.meta.title,
    subtitle: draftState.meta.subtitle || "",
    lead: draftState.meta.lead || "",
    cta: draftState.meta.cta || target.meta.cta,
    digest: draftState.meta.digest || "",
    coverImageIndex: draftState.meta.coverImageIndex || target.meta.coverImageIndex || 0,
    titleOptions: draftState.meta.titleOptions || [],
    keywords: draftState.meta.keywords || []
  };
  target.bodyHtml = draftState.bodyHtml || "";

  // 当前在该 article → 同步 controls + 编辑器 + history record + 文案
  if (state.currentArticleIndex === idx) {
    applyCurrentArticleToControls();
    syncWorkspace();
  }
  schedulePersist();

  if (state.currentArticleIndex === idx) {
    try {
      await saveCurrentDraftRecord("AI 改写完成");
    } catch {
      // history snapshot 失败不阻塞 apply
    }
    const baseMessage = result.meta?.templateName
      ? `当前篇改写完成（模板：${result.meta.templateName}），已生成标题建议、摘要和可编辑正文。`
      : "当前篇改写完成，已生成标题建议、摘要和可编辑正文。";
    const lengthHint = formatLengthHint(result.meta?.lengthCheck);
    const successMessage = lengthHint ? `${baseMessage}${lengthHint}` : baseMessage;
    setStatus(
      successMessage,
      result.meta?.lengthCheck && result.meta.lengthCheck.status !== "ok" && result.meta.lengthCheck.status !== "unknown"
        ? "warning"
        : "success"
    );
    renderHumanizeBadge(result.meta?.lint, result.meta?.humanizePass);
  renderComplianceBadge(result.meta?.compliance);
  }

  _sourceImagesByRequestId.delete(task.requestId);
}

/**
 * 老 modal 模式专用：直接把改写结果写到"当前" article。
 */
async function _applyRewriteResultToCurrentArticle(response, sourceImages) {
  const {
    getCurrentArticle,
    applyCurrentArticleToControls,
    syncWorkspace,
    schedulePersist,
    saveCurrentDraftRecord,
    setStatus
  } = _ctx;

  const draftState = createArticleDraftState(response.data, sourceImages);
  const current = getCurrentArticle();
  current.meta = {
    ...current.meta,
    title: draftState.meta.title || current.meta.title,
    subtitle: draftState.meta.subtitle || "",
    lead: draftState.meta.lead || "",
    cta: draftState.meta.cta || current.meta.cta,
    digest: draftState.meta.digest || "",
    coverImageIndex: draftState.meta.coverImageIndex || current.meta.coverImageIndex || 0,
    titleOptions: draftState.meta.titleOptions || [],
    keywords: draftState.meta.keywords || []
  };
  current.bodyHtml = draftState.bodyHtml || "";

  applyCurrentArticleToControls();
  syncWorkspace();
  schedulePersist();
  await saveCurrentDraftRecord("AI 改写完成");
  const baseMessage = response.meta?.templateName
    ? `当前篇改写完成（模板：${response.meta.templateName}），已生成标题建议、摘要和可编辑正文。`
    : "当前篇改写完成，已生成标题建议、摘要和可编辑正文。";
  const lengthHint = formatLengthHint(response.meta?.lengthCheck);
  const successMessage = lengthHint ? `${baseMessage}${lengthHint}` : baseMessage;
  setStatus(
    successMessage,
    response.meta?.lengthCheck && response.meta.lengthCheck.status !== "ok" && response.meta.lengthCheck.status !== "unknown"
      ? "warning"
      : "success"
  );
  renderHumanizeBadge(response.meta?.lint, response.meta?.humanizePass);
  renderComplianceBadge(response.meta?.compliance);
}

/**
 * 处理 service-worker 推过来的 REWRITE_PROGRESS 事件。
 *
 * 进度条逻辑：
 *  - pass1:start  → "主改写进行中..."
 *  - pass1:done   → "主改写完成，正在分析 AI 痕迹..."
 *  - pass2:plan   → "lint 完成，正在准备润色..."
 *  - pass2:start  → "正在并行润色 0/N 段..."（同时显示「跳过润色」按钮）
 *  - pass2:tick   → "正在并行润色 K/N 段..."（K = current）
 *  - pass2:done   → "润色完成，重新评估..."
 *  - done         → 不显示文案，由主响应负责收尾
 *
 * 严格按 requestId 过滤（多 tab 时 service-worker 全局广播，得自己挑）。
 */
function handleRewriteProgress(payload) {
  if (!payload || payload.requestId !== _currentRewriteRequestId) return;
  const { setStatus } = _ctx || {};
  const { phase, current, total } = payload;
  switch (phase) {
    case "pass1:start":
      setStatus?.("正在主改写...", "info");
      break;
    case "pass1:streaming": {
      // 39th 续 · Phase 3b · 流式实时反馈（settings.platformStreaming=true 才会出现此 phase）
      // 顶部状态栏文案：「AI 正在流式生成…  1234 字 / 56 token」
      const chars = Number(payload.streamingChars) || 0;
      const tokens = Number(payload.streamingTokens) || 0;
      const segments = ["AI 正在流式生成…"];
      if (chars > 0) segments.push(`${chars} 字`);
      if (tokens > 0) segments.push(`${tokens} token`);
      setStatus?.(segments.join("  "), "info");
      break;
    }
    case "pass1:done":
      setStatus?.("主改写完成 ✓ 正在分析 AI 痕迹...", "info");
      break;
    case "pass2:plan":
      setStatus?.("正在准备二次润色...", "info");
      break;
    case "pass2:start":
      setSkipButtonVisible(true);
      setStatus?.(`正在并行润色 0/${total || "?"} 段...`, "info");
      break;
    case "pass2:tick":
      setStatus?.(`正在并行润色 ${current || 0}/${total || "?"} 段...`, "info");
      break;
    case "pass2:done":
      setSkipButtonVisible(false);
      setStatus?.("润色完成 ✓ 重新评估 AI 痕迹...", "info");
      break;
    case "done":
      setSkipButtonVisible(false);
      break;
    default:
      break;
  }
}

/**
 * 「跳过润色」按钮：用户等不及二次 pass 时一键放弃。
 * 点击 → 给 service-worker 发 SKIP_HUMANIZE_PASS，service-worker abort
 * 当前 controller，runHumanizePass 立刻 reject，主 pass 结果直接返回。
 */
function initSkipHumanizeButton() {
  const btn = document.querySelector("#skipHumanizeBtn");
  if (!btn) return;
  btn.addEventListener("click", async () => {
    if (!_currentRewriteRequestId) return;
    btn.disabled = true;
    try {
      await chrome.runtime.sendMessage({
        type: "SKIP_HUMANIZE_PASS",
        payload: { requestId: _currentRewriteRequestId }
      });
      _ctx?.setStatus?.("已请求跳过润色，等待主改写结果回收...", "warning");
    } catch (err) {
      console.warn("[humanize] 跳过润色失败：", err);
    } finally {
      btn.disabled = false;
      setSkipButtonVisible(false);
    }
  });
  setSkipButtonVisible(false);
}

function setSkipButtonVisible(visible) {
  const btn = document.querySelector("#skipHumanizeBtn");
  if (!btn) return;
  if (visible) btn.removeAttribute("hidden");
  else btn.setAttribute("hidden", "");
}

/**
 * 「去 AI 味」开关 chip 与 settings.humanizeEnabled 双向绑定：
 *  - 启动时读 settings 同步初始状态
 *  - 点击 chip：先做 license 闸门检查
 *      · 已 PRO → 直接 toggle settings.humanizeEnabled，写回 storage
 *      · 未 PRO → 弹升级弹窗，不改 settings（避免误以为已生效）
 *  - 监听 storage 变化（options 页里改了开关 / 强度）→ 调用 refreshHumanizeChip 同步
 *
 * 视觉只反映"是否启用"，强度（轻/中/重）放在 options 页选；
 * 在 chip 的 title 里附带当前强度，节省工具栏空间。
 */
function initHumanizeToggleChip() {
  const chip = document.querySelector("#humanizeToggleBtn");
  if (!chip) return;

  chip.addEventListener("click", async () => {
    const settings = await getSettings().catch(() => null);
    if (!settings) return;

    const access = await checkDeAiBoostAccess().catch(() => ({ ok: false }));
    if (!access?.ok) {
      const meta = PAID_FEATURES?.["ai.deAiBoost"] || {};
      showUpgradeModal({
        featureName: meta.name || "去 AI 味二次润色",
        hint:
          meta.hint ||
          "Pro 才能在主改写之外再跑一次专属「去 AI 味」模型润色，把 AI 痕迹压到检测线以下。",
        bullets: [
          "二次润色专项重写：句长、破折号、套话、协作语气全部重排",
          "可按章节计费，一篇 1500 字大约 +3k–5k token",
          "免费版：保留主 pass + 本地 lint 提示，不会触发额外调用"
        ]
      });
      return;
    }

    const next = !settings.humanizeEnabled;
    await saveSettings({ humanizeEnabled: next });
    applyHumanizeChipState(chip, next, settings.humanizeIntensity, true);
  });

  refreshHumanizeChip();
}

async function refreshHumanizeChip() {
  const chip = document.querySelector("#humanizeToggleBtn");
  if (!chip) return;
  const settings = await getSettings().catch(() => null);
  if (!settings) return;
  const access = await checkDeAiBoostAccess().catch(() => ({ ok: false }));
  applyHumanizeChipState(
    chip,
    Boolean(settings.humanizeEnabled),
    settings.humanizeIntensity,
    Boolean(access?.ok)
  );
}

function applyHumanizeChipState(chip, enabled, intensity, hasAccess) {
  if (!chip) return;
  const stateEl = chip.querySelector(".humanize-chip-state");
  const proEl = chip.querySelector(".humanize-chip-pro");

  // 没 PRO 资格：永远显示「关 · PRO」，避免用户误以为已开启
  const effectiveEnabled = hasAccess && enabled;

  chip.setAttribute("aria-pressed", String(effectiveEnabled));
  chip.removeAttribute("aria-disabled");

  const intensityLabel =
    intensity === "light" ? "轻" : intensity === "strong" ? "重" : "中";

  if (stateEl) {
    stateEl.textContent = effectiveEnabled ? `开 · ${intensityLabel}` : "关";
  }
  if (proEl) {
    proEl.hidden = hasAccess;
  }

  chip.title = effectiveEnabled
    ? `已开启去 AI 味二次润色（强度：${intensityLabel}）。每篇额外 N 次 LLM 调用，token 成本约 +60%–80%。`
    : hasAccess
    ? "点击开启去 AI 味二次润色（按章节数额外调用 LLM）。"
    : "Pro 专属：去 AI 味二次润色。点击查看升级方案。";
}

/**
 * 把 service-worker 回传的 lint 报告渲染到 toolbar 下方的 badge 里。
 * - 如果 lint 缺失（service worker 还没接 stage1-checker），整条 bar 隐藏；
 * - score ≥ 90 显示绿色，75–89 浅黄，60–74 橙，< 60 红
 * - 详情面板默认折叠，点击 badge 展开
 *
 * @param {object|null} lint           humanize-checker 输出
 * @param {object|null} humanizePass   { applied, sectionCount, intensity }，
 *                                     stage 2 接入后才有；用于在 summary 里说明二次润色是否生效
 */
function renderHumanizeBadge(lint, humanizePass) {
  const bar = document.querySelector("#humanizeStatusBar");
  const badge = document.querySelector("#humanizeBadge");
  const panel = document.querySelector("#humanizePanel");
  if (!bar || !badge || !panel) return;

  if (!lint || typeof lint !== "object") {
    bar.setAttribute("hidden", "");
    return;
  }

  const score = Math.max(0, Math.min(100, Number(lint.score) || 0));
  const issues = Array.isArray(lint.issues) ? lint.issues : [];
  const tier =
    score >= 90 ? "great" : score >= 75 ? "ok" : score >= 60 ? "warn" : "bad";

  const labelEl = badge.querySelector(".humanize-badge-label");
  const scoreEl = badge.querySelector(".humanize-badge-score");
  if (labelEl) {
    const passNote =
      humanizePass?.applied
        ? `（已二次润色 · ${humanizePass.sectionCount || 0} 段）`
        : "";
    labelEl.textContent = `AI 味检测 ${passNote}`;
  }
  if (scoreEl) scoreEl.textContent = `${score} 分 · ${issues.length} 处可优化`;
  badge.setAttribute("data-tier", tier);
  bar.removeAttribute("hidden");

  const summaryEl = panel.querySelector(".humanize-panel-summary");
  if (summaryEl) {
    const m = lint.metrics || {};
    summaryEl.textContent = [
      `句长均值 ${m.avgSentenceLen ?? 0} 字`,
      `突发性 ${m.burstiness ?? 0}`,
      `破折号每 500 字 ${m.dashesPer500 ?? 0}`,
      `感叹号每 500 字 ${m.exclamPer500 ?? 0}`
    ].join(" · ");
  }

  const list = panel.querySelector(".humanize-panel-issues");
  if (list) {
    list.innerHTML = "";
    if (!issues.length) {
      const li = document.createElement("li");
      li.dataset.severity = "hint";
      li.innerHTML =
        '<span class="humanize-issue-tag">PASS</span><span class="humanize-issue-text">没有命中已知 AI 痕迹模式</span>';
      list.appendChild(li);
    } else {
      // 默认只展示前 8 条；剩下的隐藏在「展开更多」里
      const top = issues.slice(0, 8);
      for (const it of top) {
        const li = document.createElement("li");
        li.dataset.severity = it.severity || "warn";
        const tag = document.createElement("span");
        tag.className = "humanize-issue-tag";
        tag.textContent = severityTag(it.severity);
        const text = document.createElement("span");
        text.className = "humanize-issue-text";
        text.textContent = it.text || it.kind || "";
        const hint = document.createElement("span");
        hint.className = "humanize-issue-hint";
        hint.textContent = it.hint || "";
        li.appendChild(tag);
        li.appendChild(text);
        li.appendChild(hint);
        list.appendChild(li);
      }
      if (issues.length > top.length) {
        const li = document.createElement("li");
        li.dataset.severity = "hint";
        li.innerHTML = `<span class="humanize-issue-tag">…</span><span class="humanize-issue-text">还有 ${
          issues.length - top.length
        } 条提示已折叠</span>`;
        list.appendChild(li);
      }
    }
  }

  // 默认收起，避免抢编辑器的注意力
  panel.setAttribute("hidden", "");
  badge.setAttribute("aria-expanded", "false");
}

function severityTag(severity) {
  if (severity === "error") return "ERROR";
  if (severity === "warn") return "WARN";
  return "HINT";
}

/**
 * 渲染「合规检查」badge + 详情面板（数据来自 service-worker meta.compliance）。
 * 与 renderHumanizeBadge 并列；clean 时隐藏整条 bar。
 */
function renderComplianceBadge(compliance) {
  const bar = document.querySelector("#complianceStatusBar");
  const badge = document.querySelector("#complianceBadge");
  const panel = document.querySelector("#compliancePanel");
  if (!bar || !badge || !panel) return;

  if (!compliance || typeof compliance !== "object" || compliance.level === "ok") {
    bar.setAttribute("hidden", "");
    return;
  }

  const counts = compliance.counts || { block: 0, warn: 0, hint: 0 };
  const tier = compliance.level === "block" ? "bad" : compliance.level === "warn" ? "warn" : "ok";

  const labelEl = badge.querySelector(".compliance-badge-label");
  const scoreEl = badge.querySelector(".compliance-badge-score");
  if (labelEl) labelEl.textContent = "合规检查";
  if (scoreEl) {
    const parts = [];
    if (counts.block) parts.push(`${counts.block} 处高危`);
    if (counts.warn) parts.push(`${counts.warn} 处违规`);
    if (counts.hint) parts.push(`${counts.hint} 处提示`);
    scoreEl.textContent = parts.join(" · ") || "通过";
  }
  badge.setAttribute("data-tier", tier);
  bar.removeAttribute("hidden");

  const list = panel.querySelector(".compliance-panel-issues");
  if (list) {
    list.innerHTML = "";
    const hits = Array.isArray(compliance.hits) ? compliance.hits : [];
    const top = hits.slice(0, 12);
    for (const h of top) {
      const li = document.createElement("li");
      li.dataset.severity = h.severity >= 3 ? "error" : h.severity >= 2 ? "warn" : "hint";
      const tag = document.createElement("span");
      tag.className = "humanize-issue-tag";
      tag.textContent = `${h.severityLabel || ""}·${h.categoryLabel || ""}`;
      const text = document.createElement("span");
      text.className = "humanize-issue-text";
      text.textContent = `「${h.term}」${h.reason ? " — " + h.reason : ""}`;
      const hint = document.createElement("span");
      hint.className = "humanize-issue-hint";
      hint.textContent = h.suggestion || "";
      li.appendChild(tag);
      li.appendChild(text);
      li.appendChild(hint);
      list.appendChild(li);
    }
    if (hits.length > top.length) {
      const li = document.createElement("li");
      li.dataset.severity = "hint";
      li.innerHTML = `<span class="humanize-issue-tag">…</span><span class="humanize-issue-text">还有 ${
        hits.length - top.length
      } 处已折叠</span>`;
      list.appendChild(li);
    }
  }

  panel.setAttribute("hidden", "");
  badge.setAttribute("aria-expanded", "false");
}

export async function copyManualPrompt() {
  const { state, setStatus, collectRewritePreferences, syncCurrentArticleFromControls, getCurrentArticle } =
    _ctx;

  syncCurrentArticleFromControls();
  const current = getCurrentArticle();
  let sourceForPrompt = null;
  if (isEditorBodySubstantiveForRewrite(current.bodyHtml)) {
    sourceForPrompt = buildRewriteSourceFromCurrentArticle(state, current);
  } else if (state.source) {
    sourceForPrompt = state.source;
  } else {
    setStatus("请先在编辑区写满一段正文，或先抓取一个网页。", "warning");
    return;
  }

  state.settings = await getSettings();
  const template = _templates.find((t) => t.id === _selectedTemplateId) || null;
  const prompt = buildManualPrompt(
    sourceForPrompt,
    collectRewritePreferences(),
    state.settings,
    template
  );
  await navigator.clipboard.writeText(prompt);
  setStatus(
    template
      ? `已复制手动提示词（模板：${template.name}）。`
      : "手动提示词已复制。",
    "success"
  );
}

function escapeAttr(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

/**
 * 把 background 算出来的 lengthCheck 格式化成附在状态栏后面的人话提示。
 *   ok      → "（约 1450 字，符合目标）"
 *   short   → "（约 540 字，比目标少 33%，可让 AI 扩写或换更长档位）"
 *   long    → "（约 2950 字，比目标多 14%，可让 AI 精简或换更短档位）"
 *   unknown → 不附加
 */
function formatLengthHint(lengthCheck) {
  if (!lengthCheck || typeof lengthCheck !== "object") return "";
  const { actual, expected, status, deltaPct } = lengthCheck;
  if (status === "unknown" || !expected) return "";
  if (!Number.isFinite(actual) || actual <= 0) return "";

  if (status === "ok") {
    return `（约 ${actual} 字，符合目标 ${expected.min}-${expected.max} 字）`;
  }
  if (status === "short") {
    return `（约 ${actual} 字，比目标少约 ${deltaPct}%，可让 AI 扩写或换更长档位）`;
  }
  return `（约 ${actual} 字，比目标多约 ${deltaPct}%，可让 AI 精简或换更短档位）`;
}
