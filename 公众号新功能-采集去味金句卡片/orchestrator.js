/**
 * orchestrator.js —— 功能编排（串起整条流水线）
 * 这是新功能对外的唯一入口，UI 层只需调 runCaptureToWechat()。
 *
 * 完整数据流：
 *   [content] 采集当前页面正文
 *      ↓ chrome.runtime.sendMessage
 *   [service_worker] DeepSeek 去 AI 味改写 → 金句抽取
 *      ↓ 返回
 *   [content/UI] 渲染金句卡片(PNG) + 用现有 renderArticleBody 生成正文HTML
 *      ↓
 *   一键写入微信编辑器（复用你现有的 injectIntoWechatEditor）
 *
 * 注意运行环境分工：
 *   - extractArticle / renderQuoteCards / 注入编辑器 → content 或 UI（有 DOM）
 *   - rewriteHumanize / extractPunchlines → service_worker（跨域调 API）
 */

// ===== content / UI 侧 =====
import { extractArticle } from "./extractor.js";
import { renderQuoteCards } from "./card-renderer.js";

/**
 * UI 入口：用户点击「一键采集并生成」时调用
 * @param {object} ui 回调集合，用于驱动界面进度
 */
export async function runCaptureToWechat(ui = {}) {
  // 1. 采集当前页面（content 环境直接执行；若在 UI 页，需经 content 转发）
  ui.onStep?.("采集页面正文…");
  const captured = extractArticle(document);
  if (!captured.rawText || captured.rawText.length < 100) {
    throw new Error("没能从当前页面提取到足够正文，请确认这是一篇文章页");
  }

  // 2. 交给后台做去味改写 + 金句抽取（service_worker）
  ui.onStep?.("AI 去味改写中…");
  const { article, punchlines } = await chrome.runtime.sendMessage({
    type: "HUMANIZE_AND_PUNCHLINE",
    payload: { title: captured.title, rawText: captured.rawText },
  });

  // 3. 渲染金句卡片（content/UI 有 DOM/Canvas）
  ui.onStep?.("生成金句卡片…");
  const cards = await renderQuoteCards(punchlines, {
    themeName: ui.themeName || "editorial-green",
    accountName: ui.accountName || "",
  });

  // 4. 返回结果交给 UI 预览：article 走你现有 renderArticleBody，cards 是 PNG Blob
  ui.onStep?.("完成");
  return { article, cards, sourceUrl: captured.sourceUrl, sourceImages: captured.images };
}

// ===== service_worker 侧（放进你的 service_worker.js 的消息监听里）=====
//
// import { rewriteHumanize, extractPunchlines } from "./rewriter.js";
//
// chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
//   if (msg.type === "HUMANIZE_AND_PUNCHLINE") {
//     (async () => {
//       try {
//         const { deepseekApiKey } = await chrome.storage.local.get("deepseekApiKey");
//         const article = await rewriteHumanize(msg.payload, deepseekApiKey);
//         const flatText = [article.lead, ...(article.sections || [])
//           .flatMap((s) => s.paragraphs || []), article.closing].filter(Boolean).join("\n");
//         const punchlines = await extractPunchlines(flatText, deepseekApiKey);
//         sendResponse({ article, punchlines });
//       } catch (e) {
//         sendResponse({ error: String(e.message || e) });
//       }
//     })();
//     return true; // 关键：保持消息通道开启以支持异步 sendResponse
//   }
// });
