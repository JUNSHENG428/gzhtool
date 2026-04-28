/**
 * workspace-capture.js
 * 负责：抓取网页（captureSource）。
 * 通过 init(ctx) 接收跨模块依赖，不直接 import 其他 workspace-* 模块。
 *
 * 抓取成功后，会把 source.blocks（含图片、表格、代码、列表）按当前选中的主题
 * 自动填入编辑器正文，并补齐标题/副标题/导语；用户可以直接编辑或再点 AI 改写。
 */

import { composeSourceBodyHtml, buildSourceMetaDraft } from "../shared/source-to-html.js";

let _ctx;

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

  showLoading(
    CAPTURE_MODE_LABELS[mode] || CAPTURE_MODE_LABELS.readable,
    "通常 1–3 秒，结果会出现在「采集信息」面板。"
  );
  try {
    const response = await chrome.runtime.sendMessage({
      type: "SCRAPE_LAST_SOURCE_TAB",
      payload: { captureMode: mode }
    });
    if (!response?.ok) {
      setErrorStatus(response?.error, "抓取失败。", () => captureSource(mode));
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

    // ── 当前正在编辑的这一篇：抓取动作必然代表"换页面 = 换正文"，
    // 所以原文链接和结尾语都按"新一轮抓取"对齐：
    //   • contentSourceUrl 必然被覆盖成新页面的 URL
    //   • cta 清空 → applyCurrentArticleToControls 会回退到 settings.defaultCta，
    //     避免上次手动改过的 CTA 锁住新内容（用户每次抓页面会重新决定 CTA 文案）
    // 其他 bundle 文章保持原值，避免误伤多图文里另外几篇的署名 / 链接。
    const currentForCapture = getCurrentArticle();
    if (currentForCapture) {
      currentForCapture.meta.contentSourceUrl = state.source.url || "";
      currentForCapture.meta.cta = "";
    }

    if (!state.selectedImageIndex && state.source.images.length > 0) {
      state.selectedImageIndex = 1;
    }

    // ── 抓取后自动套排版填正文 ──
    const autoFilled = autoFillEditorFromSource(currentForCapture);

    applyCurrentArticleToControls();
    syncWorkspace();
    schedulePersist();
    await saveCurrentDraftRecord("抓取网页");

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

    resetRetryCount();
    view.emptyPromptCard.hidden = true;
  } finally {
    hideLoading();
  }
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
