/**
 * workspace-capture.js
 * 负责：抓取网页（captureSource）。
 * 通过 init(ctx) 接收跨模块依赖，不直接 import 其他 workspace-* 模块。
 */

let _ctx;

export function init(ctx) {
  _ctx = ctx;
  document.querySelector("#captureButton").addEventListener("click", captureSource);
}

export async function captureSource() {
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
    resetRetryCount
  } = _ctx;

  showLoading("正在抓取页面内容...");
  try {
    const response = await chrome.runtime.sendMessage({ type: "SCRAPE_LAST_SOURCE_TAB" });
    if (!response?.ok) {
      setErrorStatus(response?.error, "抓取失败。", () => captureSource());
      return;
    }

    state.source = response.data;
    for (const article of state.articleBundle) {
      if (!article.meta.contentSourceUrl) {
        article.meta.contentSourceUrl = state.source.url || "";
      }
      if (!article.meta.coverImageIndex && state.source.images.length > 0) {
        article.meta.coverImageIndex = 1;
      }
    }

    if (!state.selectedImageIndex && state.source.images.length > 0) {
      state.selectedImageIndex = 1;
    }

    applyCurrentArticleToControls();
    syncWorkspace();
    schedulePersist();
    await saveCurrentDraftRecord("抓取网页");
    setStatus(`已抓取 ${state.source.blocks.length} 个内容块和 ${state.source.images.length} 张图片。`, "success");
    resetRetryCount();
    view.emptyPromptCard.hidden = true;
  } finally {
    hideLoading();
  }
}
