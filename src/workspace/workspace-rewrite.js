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
  setActiveTemplateId
} from "../shared/storage.js";
import { PAID_FEATURES } from "../shared/license.js";
import { showUpgradeModal } from "../shared/upgrade-modal.js";

let _ctx;
let _templates = [];
let _selectedTemplateId = "";
let _templateSelect = null;

export function init(ctx) {
  _ctx = ctx;
  document.querySelector("#rewriteButton").addEventListener("click", rewriteArticle);
  document.querySelector("#copyPromptButton").addEventListener("click", copyManualPrompt);

  _templateSelect = document.querySelector("#rewriteTemplateSelect");
  hydrateTemplatePicker();

  if (chrome?.storage?.onChanged) {
    chrome.storage.onChanged.addListener((changes, areaName) => {
      if (areaName !== "local") return;
      if (
        changes.wechatWriterPromptTemplates ||
        changes.wechatWriterActiveTemplateId
      ) {
        hydrateTemplatePicker();
      }
    });
  }

  _templateSelect?.addEventListener("change", async () => {
    const value = _templateSelect.value || "";
    _selectedTemplateId = value;
    await setActiveTemplateId(value);
  });
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
  const options = ['<option value="">默认 prompt（不套用模板）</option>'];
  for (const t of _templates) {
    const label = `${t.icon || "📝"} ${escapeAttr(t.name || t.id)}`;
    options.push(`<option value="${escapeAttr(t.id)}">${label}</option>`);
  }
  _templateSelect.innerHTML = options.join("");
  _templateSelect.value = _selectedTemplateId || "";
}

export async function rewriteArticle() {
  const {
    state,
    setStatus,
    setErrorStatus,
    showLoading,
    hideLoading,
    getCurrentArticle,
    applyCurrentArticleToControls,
    syncWorkspace,
    schedulePersist,
    collectRewritePreferences,
    saveCurrentDraftRecord,
    resetRetryCount
  } = _ctx;

  if (!state.source) {
    setStatus("请先抓取一个网页。", "warning");
    return;
  }

  const templateId = _selectedTemplateId || "";
  const templateLabel = _templates.find((t) => t.id === templateId)?.name;
  showLoading(
    templateLabel
      ? `正在调用 AI 改写当前篇（模板：${templateLabel}）...`
      : "正在调用 AI 改写当前篇..."
  );
  try {
    const response = await chrome.runtime.sendMessage({
      type: "REWRITE_ARTICLE",
      payload: {
        source: state.source,
        preferences: collectRewritePreferences(),
        templateId
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
      return;
    }

    const draftState = createArticleDraftState(response.data, state.source.images || []);
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
    resetRetryCount();
  } finally {
    hideLoading();
  }
}

export async function copyManualPrompt() {
  const { state, setStatus, collectRewritePreferences } = _ctx;

  if (!state.source) {
    setStatus("请先抓取一个网页。", "warning");
    return;
  }

  const { buildManualPrompt } = await import("../shared/ai.js");
  state.settings = await getSettings();
  const template = _templates.find((t) => t.id === _selectedTemplateId) || null;
  const prompt = buildManualPrompt(
    state.source,
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
