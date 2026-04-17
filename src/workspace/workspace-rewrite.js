/**
 * workspace-rewrite.js
 * 负责：AI 改写（rewriteArticle）和复制手动 Prompt（copyManualPrompt）。
 * 通过 init(ctx) 接收跨模块依赖，不直接 import 其他 workspace-* 模块。
 */

import { createArticleDraftState } from "../shared/article.js";
import { getSettings } from "../shared/storage.js";

let _ctx;

export function init(ctx) {
  _ctx = ctx;
  document.querySelector("#rewriteButton").addEventListener("click", rewriteArticle);
  document.querySelector("#copyPromptButton").addEventListener("click", copyManualPrompt);
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

  showLoading("正在调用 AI 改写当前篇...");
  try {
    const response = await chrome.runtime.sendMessage({
      type: "REWRITE_ARTICLE",
      payload: {
        source: state.source,
        preferences: collectRewritePreferences()
      }
    });

    if (!response?.ok) {
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
    setStatus("当前篇改写完成，已生成标题建议、摘要和可编辑正文。", "success");
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
  const prompt = buildManualPrompt(state.source, collectRewritePreferences(), state.settings);
  await navigator.clipboard.writeText(prompt);
  setStatus("手动提示词已复制。", "success");
}
