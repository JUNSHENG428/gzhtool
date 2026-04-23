import { evaluateArticleLength, requestRewrite, testAiConnection } from "../shared/ai.js";
import {
  getActivePromptTemplate,
  getPromptTemplates,
  getSession,
  getSettings,
  saveSession
} from "../shared/storage.js";
import { WECHAT_WEB_EDITOR_URL } from "../shared/defaults.js";
import { classifyError } from "../shared/errors.js";
import { publishToWechat, queryPublishStatus, testWechatConnection } from "../shared/wechat.js";
import { normalizeCaptureMode, sleep } from "../shared/utils.js";
import { fetchHotTopics } from "../shared/hot-topics.js";
import {
  getPlatformCookieStatuses,
  openPlatformLoginTab
} from "../shared/agent/credentials.js";
import { runAgentTask } from "../shared/agent/agent-runner.js";
import { buildAngleOutlineMessages, normalizeOutline } from "../shared/agent/agent-prompts.js";
import {
  canUseDrissionCapture,
  requestDrissionCapture,
  testDrissionConnection
} from "../shared/drission.js";
import { bumpUsage } from "../shared/usage-stats.js";
import {
  PAID_FEATURES,
  PRO_TEMPLATE_IDS,
  checkDailyQuota,
  checkLicense,
  checkTemplateAccess,
  maybeRefreshLicense
} from "../shared/license.js";

const MAX_RETRIES = 2;

chrome.runtime.onInstalled.addListener(async (details) => {
  await getSettings();
  await getSession();
  // 一次性清理：旧版本"关键词雷达"功能已下线，移除其遗留的本地存储键。
  try {
    await chrome.storage.local.remove(["hotRadarConfig", "hotRadarSnapshot"]);
  } catch {}

  // 注册每日 license 静默复验 alarm（不阻塞，失败也不抛）
  try {
    if (chrome.alarms) {
      chrome.alarms.create("license-refresh", {
        delayInMinutes: 1,
        periodInMinutes: 60 * 12 // 每 12h 触发一次（实际是否请求由 maybeRefreshLicense 内部 24h 节流决定）
      });
    }
  } catch {
    // ignore
  }

  if (details.reason === "install") {
    await chrome.tabs.create({
      url: chrome.runtime.getURL("src/pages/welcome.html")
    });
  }
});

if (chrome.alarms?.onAlarm) {
  chrome.alarms.onAlarm.addListener((alarm) => {
    if (alarm?.name === "license-refresh") {
      void maybeRefreshLicense().catch(() => {});
    }
  });
}

if (chrome.commands?.onCommand) {
  chrome.commands.onCommand.addListener(async (command) => {
    try {
      switch (command) {
        case "capture_current_page": {
          const tab = await getCurrentActiveTab();
          if (tab?.id) {
            await rememberTab(tab.id);
          }
          await openWorkspace(true);
          break;
        }
        case "open_workspace": {
          await openWorkspace(false);
          break;
        }
        case "open_hot_topics": {
          await chrome.tabs.create({
            url: chrome.runtime.getURL("src/pages/hot-topics.html")
          });
          break;
        }
        case "open_options": {
          await chrome.runtime.openOptionsPage();
          break;
        }
        case "open_agent": {
          await chrome.tabs.create({
            url: chrome.runtime.getURL("src/pages/agent.html")
          });
          break;
        }
        default:
          break;
      }
    } catch (error) {
      console.warn("[gzh] command failed:", command, error);
    }
  });
}

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
        await openWorkspace(Boolean(message.autoCapture), message.captureMode || "");
        sendResponse({ ok: true });
        break;
      }
      case "PREPARE_SOURCE_AND_OPEN_WORKSPACE": {
        const tab = await getCurrentActiveTab();
        if (tab?.id) {
          await rememberTab(tab.id);
        }
        await openWorkspace(true, message.captureMode || "");
        void bumpUsage("capture");
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
        // 必须写到 session，否则 workspace.html?import=1 打开后读不到 lastCapture，
        // 编辑台会停留在空白状态（这是热点页"一键入库"无反馈的真正诱因之一）。
        await saveSession({ lastCapture: capture });
        void bumpUsage("capture");
        sendResponse({ ok: true, data: capture });
        break;
      }
      case "SCRAPE_LAST_SOURCE_TAB": {
        const capture = await scrapeLastSourceTab(message.payload?.captureMode || "readable");
        await saveSession({ lastCapture: capture });
        void bumpUsage("capture");
        sendResponse({ ok: true, data: capture });
        break;
      }
      case "REWRITE_ARTICLE": {
        // 闸门：免费版每日改写次数限制
        const quota = await checkDailyQuota("rewrite");
        if (!quota.ok) {
          sendResponse({
            ok: false,
            error: quota.hint,
            errorCode: "LICENSE_QUOTA_EXCEEDED",
            meta: {
              feature: "ai.unlimitedDaily",
              quota: { used: quota.used, limit: quota.limit }
            }
          });
          break;
        }

        const settings = await getSettings();
        const requestedTemplateId = String(message.payload?.templateId || "").trim();
        let template = null;
        if (requestedTemplateId) {
          const templates = await getPromptTemplates();
          template = templates.find((t) => t.id === requestedTemplateId) || null;
        }
        if (!template) {
          template = await getActivePromptTemplate();
        }

        // 闸门：高级模板（pro 限定）；免费用户尝试用时直接拦截，避免静默使用
        if (template && PRO_TEMPLATE_IDS.includes(template.id)) {
          const access = await checkTemplateAccess(template.id);
          if (!access.ok) {
            sendResponse({
              ok: false,
              error: access.hint || PAID_FEATURES["ai.advancedTemplates"].hint,
              errorCode: "LICENSE_TEMPLATE_LOCKED",
              meta: {
                feature: "ai.advancedTemplates",
                templateId: template.id,
                templateName: template.name
              }
            });
            break;
          }
        }

        const article = await withRetry(
          () =>
            requestRewrite(
              settings,
              message.payload.source,
              message.payload.preferences || {},
              template
            ),
          MAX_RETRIES,
          "AI 改写"
        );
        await saveSession({ lastDraft: article });
        void bumpUsage("rewrite");
        // 评估"实际字数 vs 期望区间"，结果通过 meta 透传给 workspace，
        // 让用户即时看到 AI 是否遵守了 prompt 中的字数硬约束。
        const lengthCheck = evaluateArticleLength(
          article,
          message.payload.preferences?.length
        );
        const baseMeta = template
          ? { templateId: template.id, templateName: template.name }
          : {};
        sendResponse({
          ok: true,
          data: article,
          meta: { ...baseMeta, lengthCheck }
        });
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
      case "TEST_DRISSION_CONNECTION": {
        // helper 是本地服务，不读 settings；允许 UI 直接传 url 来即时测试用户输入。
        const result = await testDrissionConnection({
          helperUrl: message.payload?.helperUrl,
          timeoutMs: message.payload?.timeoutMs
        });
        sendResponse(result);
        break;
      }
      case "PUBLISH_TO_WECHAT": {
        const baseSettings = await getSettings();
        // 优先使用前端传过来的 accountOverride（编辑台选中的发布账号）。
        // override 缺失时回落到 baseSettings 的默认凭证，保证向后兼容。
        const override = message.payload?.accountOverride;
        const effectiveSettings = override
          ? {
              ...baseSettings,
              wechatAppId: String(override.wechatAppId || "").trim() || baseSettings.wechatAppId,
              wechatAppSecret:
                String(override.wechatAppSecret || "").trim() || baseSettings.wechatAppSecret,
              wechatDefaultAuthor:
                String(override.wechatDefaultAuthor || "").trim() ||
                baseSettings.wechatDefaultAuthor
            }
          : baseSettings;
        const accountLabel = String(message.payload?.accountLabel || "默认账号");
        const result = await withRetry(
          () => publishToWechat(effectiveSettings, message.payload),
          MAX_RETRIES,
          `公众号发布（${accountLabel}）`
        );
        void bumpUsage("publish");
        sendResponse({ ok: true, data: { ...result, accountLabel } });
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
        const settings = await getSettings();
        const result = await fetchHotTopics(message.payload?.source || "zhihu", {
          forceRefresh: message.payload?.forceRefresh || false,
          dailyhotBase: settings.hotTopicsDailyHotBase,
          newsnowBase: settings.hotTopicsNewsnowBase,
          rsshubBaseUrl: settings.rsshubBaseUrl
        });
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
      case "GET_PLATFORM_CREDENTIAL_STATUS": {
        const platformIds = Array.isArray(message.payload?.platforms)
          ? message.payload.platforms
          : undefined;
        const statuses = await getPlatformCookieStatuses(platformIds);
        sendResponse({ ok: true, data: { statuses } });
        break;
      }
      case "OPEN_PLATFORM_LOGIN": {
        const platformId = String(message.payload?.platformId || "").trim();
        if (!platformId) {
          sendResponse({
            ok: false,
            error: { code: "AGENT", message: "缺少 platformId。", retryable: false }
          });
          break;
        }
        const result = await openPlatformLoginTab(platformId);
        sendResponse({ ok: true, data: result });
        break;
      }
      case "RUN_AGENT_TASK": {
        const senderTabId = sender?.tab?.id || null;
        const senderFrameId = sender?.frameId ?? 0;
        const broadcast = (progress) => {
          const payload = { type: "AGENT_PROGRESS", payload: progress };
          if (senderTabId) {
            chrome.tabs.sendMessage(senderTabId, payload, { frameId: senderFrameId }).catch(() => {});
          } else {
            chrome.runtime.sendMessage(payload).catch(() => {});
          }
        };
        const result = await runAgentTask(
          {
            query: message.payload?.query,
            options: message.payload?.options || {}
          },
          broadcast
        );
        sendResponse({ ok: true, data: result });
        break;
      }
      case "IMPORT_AGENT_HIT": {
        const url = String(message.payload?.url || "").trim();
        if (!url) {
          sendResponse({
            ok: false,
            error: { code: "AGENT", message: "缺少待入库的链接。", retryable: false }
          });
          break;
        }
        const capture = await scrapeBackgroundSilent(url);
        await saveSession({ lastCapture: capture });
        void bumpUsage("agentImport");
        sendResponse({ ok: true, data: capture });
        break;
      }
      case "GENERATE_ANGLE_OUTLINE": {
        const query = String(message.payload?.query || "").trim();
        const angle = String(message.payload?.angle || "").trim();
        const hits = Array.isArray(message.payload?.hits) ? message.payload.hits : [];
        if (!query || !angle) {
          sendResponse({
            ok: false,
            error: { code: "AGENT", message: "缺少 query 或 angle。", retryable: false }
          });
          break;
        }
        const outline = await generateAngleOutline({ query, angle, hits });
        sendResponse({ ok: true, data: outline });
        break;
      }
      case "IMPORT_AGENT_OUTLINE": {
        const payload = message.payload || {};
        const capture = buildOutlineCapture(payload);
        if (!capture) {
          sendResponse({
            ok: false,
            error: { code: "AGENT", message: "提纲为空，无法入库。", retryable: false }
          });
          break;
        }
        await saveSession({
          lastSourceTabId: null,
          lastSourceTitle: capture.title,
          lastSourceUrl: capture.url,
          lastCapture: capture
        });
        void bumpUsage("agentImport");
        sendResponse({ ok: true, data: capture });
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

async function openWorkspace(autoCapture, captureMode) {
  const url = new URL(chrome.runtime.getURL("src/workspace/workspace.html"));
  if (autoCapture) {
    url.searchParams.set("autocapture", "1");
  }
  const validModes = new Set(["selection", "raw", "readable"]);
  if (captureMode && validModes.has(captureMode)) {
    url.searchParams.set("mode", captureMode);
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

async function scrapeLastSourceTab(captureMode = "readable") {
  const sourceTab = await resolveSourceTab();
  if (!sourceTab?.id) {
    throw new Error("没有找到可抓取的普通网页标签页。");
  }

  const safeMode = normalizeCaptureMode(captureMode);

  // 如果开启了 DrissionPage 且不是 selection 模式，优先走本地 helper 抓取（更能绕过反爬）。
  // helper 不可达 / 抓不到内容时会回退到 content-script 抓取，不会让用户卡死。
  // 闸门：DrissionPage 是 Pro 限定，免费用户即使强行设置 drissionEnabled=true 也不会走 helper。
  const settings = await getSettings();
  const drissionAllowed = (await checkLicense("scrape.drission")).ok;
  if (drissionAllowed && canUseDrissionCapture(settings, safeMode) && sourceTab.url) {
    try {
      const capture = await requestDrissionCapture(settings, {
        url: sourceTab.url,
        captureMode: safeMode,
        sourceTitle: sourceTab.title || ""
      });
      await saveSession({
        lastSourceTabId: sourceTab.id,
        lastSourceTitle: sourceTab.title || capture.title || "",
        lastSourceUrl: sourceTab.url || ""
      });
      return capture;
    } catch (error) {
      console.warn("[gzh] DrissionPage 抓取失败，回退到内置抓取：", error?.message || error);
    }
  }

  await chrome.scripting.executeScript({
    target: { tabId: sourceTab.id },
    files: [SCRAPE_ARTICLE_SCRIPT]
  });

  const results = await chrome.scripting.executeScript({
    target: { tabId: sourceTab.id },
    func: async (mode) => {
      if (typeof window.__gzhRunFullCapture !== "function") {
        return null;
      }
      return window.__gzhRunFullCapture({ mode });
    },
    args: [safeMode]
  });

  const capture = results?.[0]?.result;
  if (!capture || !Array.isArray(capture.blocks) || capture.blocks.length === 0) {
    if (safeMode === "selection") {
      throw new Error("没有检测到选中文字，请在原网页里先选中一段文字再点击「只抓选中文字」。");
    }
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
  if (!/^https?:\/\//i.test(url)) {
    return false;
  }
  try {
    const u = new URL(url);
    const p = u.protocol.toLowerCase();
    if (
      p === "chrome:" ||
      p === "chrome-extension:" ||
      p === "edge:" ||
      p === "about:" ||
      p === "moz-extension:"
    ) {
      return false;
    }
    return true;
  } catch {
    return false;
  }
}

// 后台静默抓取的健全检查：抓到 1 个 block / 极少正文，
// 几乎可确定是登录墙、错误页、403 拦截页、或 SPA 还没 hydrate。
// 这种情况直接抛错让上层告知用户，不要静默落 session。
const CAPTURE_MIN_BLOCKS = 2;
const CAPTURE_MIN_TEXT_LEN = 300;
function assertCaptureHealth(capture, targetUrl) {
  if (!capture || !Array.isArray(capture.blocks) || capture.blocks.length === 0) {
    throw new Error("抓取失败或正文为空，请确认目标站点支持免登录公开访问。");
  }
  const textLen = capture.blocks
    .filter((b) => b && (b.type === "paragraph" || b.type === "heading" || b.type === "quote"))
    .map((b) => String(b.text || "").length)
    .reduce((a, b) => a + b, 0);
  if (capture.blocks.length < CAPTURE_MIN_BLOCKS || textLen < CAPTURE_MIN_TEXT_LEN) {
    const hint = `（抓到 ${capture.blocks.length} 块 / ${textLen} 字）`;
    throw new Error(
      `抓到的内容太少 ${hint}，可能命中了登录墙、错误页或反爬拦截页。请在浏览器里打开 ${targetUrl} 确认页面正常，或换一种抓取方式。`
    );
  }
}

async function scrapeBackgroundSilent(targetUrl) {
  if (!isScrapableUrl(targetUrl)) {
    throw new Error("不是一个合法的可抓取网址。");
  }

  // 后台静默抓取（热点页一键入库 / agent 命中）：
  // 优先尝试本地 DrissionPage helper（不开 tab、不打扰用户、对反爬更友好）。
  // 任何异常都会落到 catch，再走 chrome.tabs.create 的兜底路径。
  // 闸门：DrissionPage 是 Pro 限定，免费用户即使强行启用也不走 helper。
  const settings = await getSettings();
  const drissionAllowed = (await checkLicense("scrape.drission")).ok;
  if (drissionAllowed && canUseDrissionCapture(settings, "readable")) {
    try {
      const capture = await requestDrissionCapture(settings, {
        url: targetUrl,
        captureMode: "readable"
      });
      assertCaptureHealth(capture, targetUrl);
      await saveSession({
        lastSourceTabId: null,
        lastSourceTitle: capture.title || targetUrl,
        lastSourceUrl: targetUrl,
        lastCapture: capture
      });
      return capture;
    } catch (error) {
      console.warn("[gzh] DrissionPage 后台抓取失败，回退到内置 tab 抓取：", error?.message || error);
    }
  }

  const tab = await chrome.tabs.create({ url: targetUrl, active: false });
  let capture = null;

  try {
    await waitForTabComplete(tab.id, 15000);

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
    assertCaptureHealth(capture, targetUrl);

    const finalTab = await chrome.tabs.get(tab.id).catch(() => null);
    await saveSession({
      lastSourceTabId: null,
      lastSourceTitle: finalTab?.title || capture.title || "",
      lastSourceUrl: finalTab?.url || targetUrl,
      lastCapture: capture
    });

  } finally {
    if (tab.id) {
      await chrome.tabs.remove(tab.id).catch(() => {});
    }
  }

  return capture;
}

/**
 * Drill-Down：基于 query + angle + hits 调一次 chat completion，返回 normalized outline。
 * 失败直接抛错（由外层 classifyError 捕获）。复用主 brief 的 settings/chat 调用风格，避免 DRY。
 */
async function generateAngleOutline({ query, angle, hits }) {
  const settings = await getSettings();
  if (!settings?.apiKey?.trim() || !settings?.apiBaseUrl?.trim()) {
    throw new Error("AI 接口未配置，请到「AI 设置」补完 baseUrl / apiKey / model。");
  }
  const messages = buildAngleOutlineMessages({ query, angle, hits });
  const response = await fetch(settings.apiBaseUrl.trim(), {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${settings.apiKey.trim()}`
    },
    body: JSON.stringify({
      model: String(settings.model || "").trim(),
      temperature: Number(settings.temperature ?? 0.6),
      messages
    })
  });

  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    const msg = payload?.error?.message || payload?.message || `状态码 ${response.status}`;
    throw new Error(msg);
  }
  const content = extractChatContent(payload);
  if (!content) throw new Error("模型返回为空");
  const json = extractJson(content);
  return normalizeOutline(json);
}

function extractChatContent(payload) {
  const c = payload?.choices?.[0]?.message?.content;
  if (typeof c === "string") return c;
  if (Array.isArray(c)) {
    return c.map((item) => (typeof item === "string" ? item : item?.text || "")).join("");
  }
  return "";
}

function extractJson(text) {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const body = fenced ? fenced[1].trim() : text.trim();
  const first = body.indexOf("{");
  const last = body.lastIndexOf("}");
  if (first === -1 || last === -1) {
    throw new Error("AI 返回中没有可解析的 JSON");
  }
  return JSON.parse(body.slice(first, last + 1));
}

/**
 * 把 outline 包成一份「合成 capture」，复用 workspace `?import=1` 入口。
 * outline 整体作为 article 正文骨架填入：每段 heading 走 H2、summary 走段落。
 *
 * 入参约定：
 *   payload.outline   normalizeOutline 后的对象
 *   payload.query     主题词（兜底标题）
 *   payload.angle     当前角度（写到 description）
 */
function buildOutlineCapture(payload) {
  const outline = payload?.outline;
  if (!outline || (!outline.title && !(Array.isArray(outline.outline) && outline.outline.length > 0))) {
    return null;
  }
  const title = outline.title || `${payload.query || "AI 选题"} · ${payload.angle || "提纲"}`.trim();
  const blocks = [];
  if (outline.outline && outline.outline.length > 0) {
    outline.outline.forEach((seg) => {
      if (seg.heading) blocks.push({ type: "heading", level: 2, text: seg.heading });
      if (seg.summary) blocks.push({ type: "paragraph", text: seg.summary });
    });
  }
  if (Array.isArray(outline.keyPoints) && outline.keyPoints.length > 0) {
    blocks.push({ type: "heading", level: 2, text: "关键论点" });
    blocks.push({
      type: "list",
      ordered: false,
      items: outline.keyPoints.map((text) => ({ text }))
    });
  }
  if (blocks.length === 0) return null;

  const totalText = blocks
    .map((b) => (b.text || (Array.isArray(b.items) ? b.items.map((i) => i.text).join(" ") : "")) || "")
    .join("");
  return {
    url: "",
    title,
    description: payload?.angle || "",
    siteName: "AI 选题代笔",
    extractedAt: new Date().toISOString(),
    wordCount: totalText.length,
    blocks,
    images: [],
    captureMode: "agent-outline"
  };
}
