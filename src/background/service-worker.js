import { requestRewrite, testAiConnection } from "../shared/ai.js";
import { getSession, getSettings, saveSession } from "../shared/storage.js";
import { WECHAT_WEB_EDITOR_URL } from "../shared/defaults.js";
import { classifyError } from "../shared/errors.js";
import { publishToWechat, queryPublishStatus, testWechatConnection } from "../shared/wechat.js";
import { sleep } from "../shared/utils.js";
import { fetchHotTopics } from "../shared/hot-topics.js";

const MAX_RETRIES = 2;

chrome.runtime.onInstalled.addListener(async (details) => {
  await getSettings();
  await getSession();
  if (details.reason === "install") {
    await chrome.tabs.create({
      url: chrome.runtime.getURL("src/pages/welcome.html")
    });
  }
});

chrome.tabs.onActivated.addListener(async ({ tabId }) => {
  await rememberTab(tabId);
});

chrome.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {
  if (changeInfo.status === "complete" && tab.active) {
    await rememberTab(tabId);
  }
});

chrome.tabs.onRemoved.addListener(async (tabId) => {
  const session = await getSession();
  if (session.lastSourceTabId === tabId) {
    await saveSession({
      lastSourceTabId: null,
      lastSourceTitle: "",
      lastSourceUrl: ""
    });
  }
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  (async () => {
    switch (message.type) {
      case "OPEN_WORKSPACE": {
        await openWorkspace(Boolean(message.autoCapture));
        sendResponse({ ok: true });
        break;
      }
      case "PREPARE_SOURCE_AND_OPEN_WORKSPACE": {
        const tab = await getCurrentActiveTab();
        if (tab?.id) {
          await rememberTab(tab.id);
        }
        await openWorkspace(true);
        sendResponse({ ok: true });
        break;
      }
      case "GET_CONTEXT": {
        const session = await getSession();
        sendResponse({ ok: true, data: session });
        break;
      }
      case "SCRAPE_BACKGROUND_AND_IMPORT": {
        const capture = await scrapeBackgroundSilent(message.payload.url);
        sendResponse({ ok: true, data: capture });
        break;
      }
      case "SCRAPE_LAST_SOURCE_TAB": {
        const capture = await scrapeLastSourceTab();
        await saveSession({ lastCapture: capture });
        sendResponse({ ok: true, data: capture });
        break;
      }
      case "REWRITE_ARTICLE": {
        const settings = await getSettings();
        const article = await withRetry(
          () =>
            requestRewrite(
              settings,
              message.payload.source,
              message.payload.preferences || {}
            ),
          MAX_RETRIES,
          "AI 改写"
        );
        await saveSession({ lastDraft: article });
        sendResponse({ ok: true, data: article });
        break;
      }
      case "TEST_AI_CONNECTION": {
        const result = await testAiConnection(message.payload || {});
        sendResponse(result);
        break;
      }
      case "TEST_WECHAT_CONNECTION": {
        const result = await testWechatConnection({
          appId: message.payload?.appId,
          appSecret: message.payload?.appSecret
        });
        sendResponse(result);
        break;
      }
      case "PUBLISH_TO_WECHAT": {
        const settings = await getSettings();
        const result = await withRetry(
          () => publishToWechat(settings, message.payload),
          MAX_RETRIES,
          "公众号发布"
        );
        sendResponse({ ok: true, data: result });
        break;
      }
      case "GET_WECHAT_PUBLISH_STATUS": {
        const settings = await getSettings();
        const result = await queryPublishStatus(settings, message.payload.publishId);
        sendResponse({ ok: true, data: result });
        break;
      }
      case "SYNC_TO_WECHAT_WEB_EDITOR": {
        const result = await withRetry(
          () => syncToWechatWebEditor(message.payload),
          MAX_RETRIES,
          "网页编辑器同步"
        );
        sendResponse({ ok: true, data: result });
        break;
      }
      case "FETCH_HOT_TOPICS": {
        const result = await fetchHotTopics(
          message.payload?.source || "zhihu",
          message.payload?.forceRefresh || false
        );
        if (result.ok) {
          sendResponse({ ok: true, data: result.payload });
        } else {
          sendResponse({
            ok: false,
            error: { code: "HOT_TOPICS", message: result.message, retryable: true }
          });
        }
        break;
      }
      default:
        sendResponse({ ok: false, error: { code: "UNKNOWN", message: "未知消息类型。", retryable: false } });
    }
  })().catch((error) => {
    const classified = classifyError(error);
    sendResponse({ ok: false, error: { code: classified.code, message: classified.message, retryable: classified.retryable } });
  });

  return true;
});

async function withRetry(fn, maxRetries, operationName) {
  let lastError = null;
  for (let attempt = 1; attempt <= maxRetries + 1; attempt++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;
      if (attempt <= maxRetries) {
        await sleep(1500);
      }
    }
  }
  throw lastError;
}

async function openWorkspace(autoCapture) {
  const url = new URL(chrome.runtime.getURL("src/workspace/workspace.html"));
  if (autoCapture) {
    url.searchParams.set("autocapture", "1");
  }
  await chrome.tabs.create({ url: url.toString() });
}

async function syncToWechatWebEditor(payload) {
  const tab = await openOrFocusWechatEditorTab();
  await waitForTabComplete(tab.id);

  const response = await chrome.tabs
    .sendMessage(tab.id, {
      type: "IMPORT_ARTICLE_TO_WECHAT_EDITOR",
      payload
    })
    .catch((error) => ({
      ok: false,
      error: error.message || "没有接收到网页编辑器响应。"
    }));

  if (!response?.ok) {
    throw new Error(response?.error || "同步网页编辑器失败。");
  }

  return {
    tabId: tab.id,
    ...response
  };
}

async function openOrFocusWechatEditorTab() {
  const existingTabs = await chrome.tabs.query({
    url: ["https://mp.weixin.qq.com/cgi-bin/appmsg*", "https://mp.weixin.qq.com/*"]
  });

  let tab =
    existingTabs.find((item) => /\/cgi-bin\/appmsg/i.test(item.url || "")) ||
    existingTabs[0] ||
    null;

  if (tab?.id) {
    await chrome.tabs.update(tab.id, {
      active: true,
      url: /\/cgi-bin\/appmsg/i.test(tab.url || "") ? tab.url : WECHAT_WEB_EDITOR_URL
    });
  } else {
    tab = await chrome.tabs.create({
      url: WECHAT_WEB_EDITOR_URL,
      active: true
    });
  }

  if (tab?.windowId) {
    await chrome.windows.update(tab.windowId, { focused: true }).catch(() => {});
  }

  return tab;
}

async function waitForTabComplete(tabId, timeoutMs = 25000) {
  const startedAt = Date.now();

  while (Date.now() - startedAt < timeoutMs) {
    const tab = await chrome.tabs.get(tabId).catch(() => null);
    if (tab?.status === "complete") {
      await sleep(400);
      return tab;
    }
    await sleep(300);
  }

  const tab = await chrome.tabs.get(tabId).catch(() => null);
  if (!tab) {
    throw new Error("公众号网页编辑器标签页不可用。");
  }
  return tab;
}

async function rememberTab(tabId) {
  const tab = await chrome.tabs.get(tabId).catch(() => null);
  if (!tab || !isScrapableUrl(tab.url)) {
    return;
  }

  await saveSession({
    lastSourceTabId: tab.id,
    lastSourceTitle: tab.title || "",
    lastSourceUrl: tab.url || ""
  });
}

async function getCurrentActiveTab() {
  const [tab] = await chrome.tabs.query({
    active: true,
    currentWindow: true
  });
  return tab || null;
}

const SCRAPE_ARTICLE_SCRIPT = "src/content-scripts/scrape-article.js";

async function scrapeLastSourceTab() {
  const sourceTab = await resolveSourceTab();
  if (!sourceTab?.id) {
    throw new Error("没有找到可抓取的普通网页标签页。");
  }

  await chrome.scripting.executeScript({
    target: { tabId: sourceTab.id },
    files: [SCRAPE_ARTICLE_SCRIPT]
  });

  const results = await chrome.scripting.executeScript({
    target: { tabId: sourceTab.id },
    func: async () => {
      if (typeof window.__gzhRunFullCapture !== "function") {
        return null;
      }
      return window.__gzhRunFullCapture();
    }
  });

  const capture = results?.[0]?.result;
  if (!capture || !Array.isArray(capture.blocks) || capture.blocks.length === 0) {
    throw new Error("抓取失败或正文为空，请确认页面已完全加载，或换一篇可公开访问的页面再试。");
  }

  await saveSession({
    lastSourceTabId: sourceTab.id,
    lastSourceTitle: sourceTab.title || "",
    lastSourceUrl: sourceTab.url || ""
  });

  return capture;
}

async function resolveSourceTab() {
  const session = await getSession();

  if (session.lastSourceTabId) {
    const tab = await chrome.tabs.get(session.lastSourceTabId).catch(() => null);
    if (tab && isScrapableUrl(tab.url)) {
      return tab;
    }
  }

  const tabs = await chrome.tabs.query({ currentWindow: true });
  const candidate = tabs.find((tab) => isScrapableUrl(tab.url));
  if (candidate) {
    return candidate;
  }

  return null;
}

function isScrapableUrl(url = "") {
  return /^https?:\/\//i.test(url);
}

async function scrapeBackgroundSilent(targetUrl) {
  if (!isScrapableUrl(targetUrl)) {
    throw new Error("不是一个合法的可抓取网址。");
  }

  // 1. 创建不可见标签页
  const tab = await chrome.tabs.create({ url: targetUrl, active: false });
  let capture = null;

  try {
    // 2. 等待最多一小段时间，让页面大致装载
    await waitForTabComplete(tab.id, 15000);

    // 3. 注入提取脚本
    await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      files: [SCRAPE_ARTICLE_SCRIPT]
    });

    const results = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: async () => {
        if (typeof window.__gzhRunFullCapture !== "function") {
          return null;
        }
        return window.__gzhRunFullCapture();
      }
    });

    capture = results?.[0]?.result;
    if (!capture || !Array.isArray(capture.blocks) || capture.blocks.length === 0) {
      throw new Error("抓取失败或正文为空，请确认目标站点支持免登录公开访问。");
    }

    // 4. 保存持久化草稿
    const finalTab = await chrome.tabs.get(tab.id).catch(() => null);
    await saveSession({
      lastSourceTabId: null, // 该临时标签页会被销毁
      lastSourceTitle: finalTab?.title || capture.title || "",
      lastSourceUrl: finalTab?.url || targetUrl,
      lastCapture: capture
    });

  } finally {
    // 无论成功失败，都销毁临时标签页
    if (tab.id) {
      await chrome.tabs.remove(tab.id).catch(() => {});
    }
  }

  return capture;
}
