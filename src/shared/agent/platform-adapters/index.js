/**
 * 平台适配器注册表 + 通用搜索调度。
 * 每个 adapter 暴露统一接口（buildSearchUrl / contentScript / parseSearchPayload），
 * 由 service worker 在隐藏 tab 上注入对应 content script 并收集 hits。
 *
 * AgentHit 结构（适配器返回的数据形态）：
 *   {
 *     platformId,         // "xhs" | "x" | "reddit" | "zhihu"
 *     platformName,
 *     title,              // 显示标题
 *     url,                // 详情页 URL，必须是 https
 *     author,             // 作者名（可空）
 *     hotScore,           // 字符串，如 "1.2万 赞" / "532 comments"
 *     hotValue,           // 数值，用于排序（点赞/评论数等）
 *     summary,            // 摘要，可空
 *     publishedAt,        // ISO8601 字符串，可空
 *     thumbnailUrl,       // 封面图，可空
 *     rawTags             // string[]，平台标签
 *   }
 */

import { adapter as xhsAdapter } from "./xhs.js";
import { adapter as xAdapter } from "./x.js";
import { adapter as redditAdapter } from "./reddit.js";
import { adapter as zhihuAdapter } from "./zhihu.js";

export const PLATFORM_ADAPTERS = Object.freeze({
  xhs: xhsAdapter,
  x: xAdapter,
  reddit: redditAdapter,
  zhihu: zhihuAdapter
});

export const ADAPTER_IDS = Object.freeze(Object.keys(PLATFORM_ADAPTERS));

export function getAdapter(platformId) {
  return PLATFORM_ADAPTERS[platformId] || null;
}

/**
 * 把单个平台的「搜索结果 DOM 抓取 → 解析」打包成一个可调度的任务。
 * 注意：本函数运行在 service worker 上下文，需要 chrome.tabs / chrome.scripting 权限。
 *
 * @param {object} adapter
 * @param {string} query
 * @param {{ perPlatformLimit: number, jitterMinMs: number, jitterMaxMs: number, signal?: AbortSignal }} opts
 * @returns {Promise<{ ok: boolean, items: AgentHit[], message?: string }>}
 */
export async function runAdapterSearch(adapter, query, opts) {
  const limit = Math.max(1, Math.min(Number(opts?.perPlatformLimit || 8), 30));
  const jitterMin = Math.max(0, Number(opts?.jitterMinMs || 800));
  const jitterMax = Math.max(jitterMin, Number(opts?.jitterMaxMs || 1500));

  const url = adapter.buildSearchUrl(query, { limit });
  if (!url) {
    return { ok: false, items: [], message: `${adapter.name}：未生成搜索 URL` };
  }

  let tab = null;
  try {
    tab = await chrome.tabs.create({ url, active: false });
    if (!tab?.id) {
      return { ok: false, items: [], message: `${adapter.name}：无法打开后台标签页` };
    }
    await waitForTabComplete(tab.id, 15000);

    // 简单抖动，避免连续请求触发风控
    const jitter = jitterMin + Math.random() * (jitterMax - jitterMin);
    await sleep(jitter);

    await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      files: [adapter.contentScript]
    });

    const results = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: async (mode, runtimeOptions) => {
        if (typeof window.__gzhScrapePlatform !== "function") {
          return { ok: false, message: "未注册 __gzhScrapePlatform" };
        }
        try {
          const payload = await window.__gzhScrapePlatform({ mode, ...runtimeOptions });
          return { ok: true, payload };
        } catch (error) {
          return { ok: false, message: String(error?.message || error || "抓取失败") };
        }
      },
      args: ["search", { limit }]
    });

    const result = results?.[0]?.result;
    if (!result?.ok) {
      return {
        ok: false,
        items: [],
        message: `${adapter.name}：${result?.message || "页面解析失败"}`
      };
    }

    const items = adapter.parseSearchPayload(result.payload || {});
    return { ok: true, items: Array.isArray(items) ? items.slice(0, limit) : [] };
  } catch (error) {
    return {
      ok: false,
      items: [],
      message: `${adapter.name}：${error?.message || "抓取异常"}`
    };
  } finally {
    if (tab?.id) {
      try {
        await chrome.tabs.remove(tab.id);
      } catch {
        /* ignore */
      }
    }
  }
}

/**
 * 等待 tab 加载完成。超时直接返回（不抛错）。
 */
function waitForTabComplete(tabId, timeoutMs = 15000) {
  return new Promise((resolve) => {
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      try {
        chrome.tabs.onUpdated.removeListener(listener);
      } catch {
        /* ignore */
      }
      resolve();
    };

    const listener = (id, changeInfo) => {
      if (id === tabId && changeInfo.status === "complete") finish();
    };
    chrome.tabs.onUpdated.addListener(listener);

    chrome.tabs
      .get(tabId)
      .then((tab) => {
        if (tab?.status === "complete") finish();
      })
      .catch(() => finish());

    setTimeout(finish, timeoutMs);
  });
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
