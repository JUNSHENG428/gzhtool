import { evaluateArticleLength, requestRewrite, testAiConnection, extractChatContent } from "../shared/ai.js";
import {
  getActivePromptTemplate,
  getPromptTemplates,
  getSession,
  getSettings,
  saveSession,
  saveSettings
} from "../shared/storage.js";
import { WECHAT_WEB_EDITOR_URL } from "../shared/defaults.js";
import { classifyError } from "../shared/errors.js";
import {
  listUserTags,
  publishToWechat,
  queryPublishStatus,
  testWechatConnection
} from "../shared/wechat.js";
import { normalizeCaptureMode, sleep } from "../shared/utils.js";
import { fetchHotTopics, testHotTopicsBackend, HOT_SOURCE_META } from "../shared/hot-topics.js";
import {
  normalizeCandidates,
  hardFilterCandidates,
  scoreCandidates,
  applyDiversityFilter,
  resolveAutoSourceIds,
  buildTopicDirectorMessages,
  parseTopicDirectorOutput
} from "../shared/topic-planner.js";
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
  checkDeAiBoostAccess,
  maybeRefreshLicense
} from "../shared/license.js";
import { lintArticle } from "../shared/humanize-checker.js";
import { runHumanizePass } from "../shared/humanize-pass.js";
import { getActiveVoiceSample } from "../shared/voice-samples.js";
import { ensureOptionalHostPermission } from "../shared/host-permissions.js";

const MAX_RETRIES = 2;
const TOPIC_PLANNER_AI_TIMEOUT_MS = 65_000;

/**
 * 当前 in-flight 的 humanize-pass AbortController 集合，按 requestId 索引。
 *
 * 为什么要用 requestId 而不是直接保存"当前唯一 controller"：
 *  - 用户可能同时有多篇文章在重写（多个 workspace tab）；
 *  - 我们想精确取消"第 N 篇"，不是误伤其它 in-flight。
 *
 * 生命周期：
 *  - REWRITE_ARTICLE handler 进入二次 pass 前 set；
 *  - finally 里 delete；
 *  - SKIP_HUMANIZE_PASS handler 收到 { requestId } 时调 controller.abort()
 *    并 delete，service-worker 后续会以 aborted=true 收尾。
 */
const inflightHumanizeControllers = new Map();

function collectPublishRemoteUrls(payload) {
  const urls = [];
  const articles = Array.isArray(payload?.articles) ? payload.articles : [];
  for (const article of articles) {
    if (article?.cover?.src) urls.push(article.cover.src);
    if (Array.isArray(article?.inlineImages)) {
      article.inlineImages.forEach((image) => {
        if (image?.src) urls.push(image.src);
      });
    }
  }
  return urls;
}

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

        // requestId 由 workspace-rewrite.js 生成，用于和后续 SKIP_HUMANIZE_PASS / REWRITE_PROGRESS 配对。
        // 兜底：UI 没传时自动生成一个，至少保证内部 Map 不混淆。
        const requestId = String(message.payload?.requestId || "").trim() || `rewrite-${Date.now()}`;

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

        // 「我的文风」样本：从 storage 读已激活的 + 已提取过指纹的样本。
        // 没设置 / fingerprint 缺失时返回 null，下游 ai.js / humanize-pass.js 各自有兜底。
        // try/catch 是为了避免 voice-samples 模块的任何异常阻塞主改写。
        let voiceSample = null;
        try {
          voiceSample = await getActiveVoiceSample();
        } catch (err) {
          console.warn("[voice-samples] 读取激活样本失败，跳过文风注入：", err);
        }

        broadcastRewriteProgress(requestId, { phase: "pass1:start", current: 0, total: 1 });

        // 主 pass —— 一次正常的 AI 改写
        let article = await withRetry(
          () =>
            requestRewrite(
              settings,
              message.payload.source,
              message.payload.preferences || {},
              template,
              voiceSample
            ),
          MAX_RETRIES,
          "AI 改写"
        );

        broadcastRewriteProgress(requestId, { phase: "pass1:done", current: 1, total: 1 });

        // 主 pass 结果先跑一次 lint，给用户在 UI 上展示"基线分数"
        let lint = safeLintArticle(article, template);

        // 二次「去 AI 味」润色 pass：受四道闸控制
        //   1) settings.humanizeEnabled（用户开关，默认 true）
        //   2) license.checkDeAiBoostAccess()（PRO 闸门）
        //   3) template.humanizePassAllowed !== false（模板可禁）
        //   4) lint.score < settings.humanizeSkipScore（高分稿子直接跳过，省 token / 省时间）
        // 任何一个条件不满足时静默跳过，主 pass 结果照常返回，避免阻塞用户。
        let humanizePass = { applied: false, sectionCount: 0, intensity: "off", errors: [] };
        const humanizeAllowedByTemplate = template?.humanizePassAllowed !== false;
        const skipScore = Number(settings.humanizeSkipScore ?? 85);
        const lintScore = Number(lint?.score ?? 0);
        const skipForHighScore =
          Number.isFinite(skipScore) && skipScore > 0 && lintScore >= skipScore;

        if (skipForHighScore) {
          humanizePass = {
            applied: false,
            sectionCount: 0,
            intensity: "off",
            errors: [],
            skippedReason: "high-score",
            skippedScore: lintScore,
            skippedThreshold: skipScore
          };
        } else if (settings.humanizeEnabled && humanizeAllowedByTemplate) {
          const access = await checkDeAiBoostAccess();
          if (access.ok) {
            const controller = new AbortController();
            inflightHumanizeControllers.set(requestId, controller);
            broadcastRewriteProgress(requestId, { phase: "pass2:plan", current: 0, total: 0 });
            try {
              const result = await runHumanizePass({
                article,
                settings,
                template,
                lintReport: lint,
                voiceSample,
                intensity: settings.humanizeIntensity || template?.humanizeProfile?.intensity || "medium",
                abortSignal: controller.signal,
                onProgress: (info) => broadcastRewriteProgress(requestId, info)
              });
              if (result?.applied) {
                article = result.article;
                lint = safeLintArticle(article, template);
                humanizePass = {
                  applied: true,
                  sectionCount: result.sectionCount || 0,
                  intensity: result.intensity || "medium",
                  aborted: Boolean(result.aborted),
                  errors: result.errors || []
                };
              } else {
                humanizePass = {
                  applied: false,
                  sectionCount: 0,
                  intensity: result?.intensity || "off",
                  aborted: Boolean(result?.aborted),
                  errors: result?.errors || []
                };
              }
            } catch (err) {
              // 不阻塞整篇改写：记录错误，让 UI 在控制台或 humanizePass.errors 看到
              humanizePass = {
                applied: false,
                sectionCount: 0,
                intensity: "off",
                aborted: controller.signal.aborted,
                errors: [String(err?.message || err)]
              };
            } finally {
              inflightHumanizeControllers.delete(requestId);
            }
          } else {
            humanizePass = {
              applied: false,
              sectionCount: 0,
              intensity: "off",
              errors: [],
              skippedReason: "license-required"
            };
          }
        } else if (!settings.humanizeEnabled) {
          humanizePass = {
            applied: false,
            sectionCount: 0,
            intensity: "off",
            errors: [],
            skippedReason: "user-disabled"
          };
        } else if (!humanizeAllowedByTemplate) {
          humanizePass = {
            applied: false,
            sectionCount: 0,
            intensity: "off",
            errors: [],
            skippedReason: "template-disallowed"
          };
        }

        broadcastRewriteProgress(requestId, { phase: "done", current: 1, total: 1 });

        await saveSession({ lastDraft: article });
        void bumpUsage("rewrite");
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
          meta: { ...baseMeta, requestId, lengthCheck, lint, humanizePass }
        });
        break;
      }
      case "SKIP_HUMANIZE_PASS": {
        // workspace-rewrite.js 的「跳过润色」按钮专用：
        // 拿 requestId 找到对应的 AbortController，调 abort() 让 in-flight fetch 立刻 reject，
        // 主流程 catch 后把 humanizePass.aborted 标 true，sendResponse 时仍会下发主 pass 结果。
        const reqId = String(message.payload?.requestId || "").trim();
        const controller = reqId ? inflightHumanizeControllers.get(reqId) : null;
        if (controller) {
          try {
            controller.abort();
          } catch (err) {
            console.warn("[humanize] abort 失败：", err);
          }
          inflightHumanizeControllers.delete(reqId);
          sendResponse({ ok: true, data: { aborted: true } });
        } else {
          sendResponse({ ok: true, data: { aborted: false, reason: "no-inflight" } });
        }
        break;
      }
      case "TEST_AI_CONNECTION": {
        const result = await testAiConnection(message.payload || {});
        sendResponse(result);
        break;
      }
      case "TEST_WECHAT_CONNECTION": {
        await ensureOptionalHostPermission(
          message.payload?.wechatApiBase || "",
          "微信公众号接口测试"
        );
        const result = await testWechatConnection({
          appId: message.payload?.appId,
          appSecret: message.payload?.appSecret,
          // P1.3 · 把 UI 输入的代理地址透到 wechat.js，让用户能"配代理 → 一键测通"
          wechatApiBase: message.payload?.wechatApiBase || ""
        });
        sendResponse(result);
        break;
      }
      case "LIST_WECHAT_TAGS": {
        // P1.2 · options 页「拉取标签」按钮专用。
        // 不复用 settings.wechatAppId / Secret，让 UI 能用当前 form 里未保存的凭证测试。
        const baseSettings = await getSettings();
        const appId = String(message.payload?.appId || baseSettings.wechatAppId || "").trim();
        const appSecret = String(
          message.payload?.appSecret || baseSettings.wechatAppSecret || ""
        ).trim();
        const wechatApiBase =
          message.payload?.wechatApiBase !== undefined
            ? String(message.payload.wechatApiBase || "").trim()
            : baseSettings.wechatApiBase || "";
        await ensureOptionalHostPermission(wechatApiBase, "拉取公众号标签");
        if (!appId || !appSecret) {
          sendResponse({
            ok: false,
            error: {
              code: "WECHAT_INVALID_SECRET",
              message: "请先填好 AppID / AppSecret 再拉取标签。",
              retryable: false
            }
          });
          break;
        }
        const tags = await listUserTags({
          ...baseSettings,
          wechatAppId: appId,
          wechatAppSecret: appSecret,
          wechatApiBase
        });
        sendResponse({ ok: true, data: { tags } });
        break;
      }
      case "TEST_HOT_TOPICS_BACKEND": {
        // kind 仅支持 newsnow / rsshub；任何未知值都按 newsnow 处理（向后兼容旧调用方）
        const rawKind = String(message.payload?.kind || "");
        const kind = rawKind === "rsshub" ? "rsshub" : "newsnow";
        await ensureOptionalHostPermission(message.payload?.baseUrl || "", "热点接口测试");
        const result = await testHotTopicsBackend(kind, message.payload?.baseUrl || "");
        sendResponse(result);
        break;
      }
      case "TEST_DRISSION_CONNECTION": {
        // helper 是本地服务，不读 settings；允许 UI 直接传 url + token 来即时测试用户输入，
        // 这样测连接按钮可以在 saveSettings 之前就反馈 token 是否能通。
        const result = await testDrissionConnection({
          helperUrl: message.payload?.helperUrl,
          helperToken: message.payload?.helperToken,
          timeoutMs: message.payload?.timeoutMs
        });
        sendResponse(result);
        break;
      }
      case "PUBLISH_TO_WECHAT": {
        const baseSettings = await getSettings();
        const accountLabel = String(message.payload?.accountLabel || "默认账号");

        // 浏览器登录模式（mode === "browser"）短路：复用用户已登录的 mp 后台 cookie，
        // 走 wechat-browser-bridge.js 把第一篇文章 DOM 注入编辑页，不调任何 cgi-bin。
        // 通过 payload.publishMode（workspace-publish.js 根据所选 profile.mode 注入）
        // 进入这条分支；旧版 payload（不带 publishMode）天然走下面的 API 链路，向后兼容。
        if (message.payload?.publishMode === "browser") {
          const { publishViaBrowser } = await import("./wechat-browser-bridge.js");
          const result = await publishViaBrowser(message.payload, {
            profileLabel: accountLabel
          });
          void bumpUsage("publish");
          sendResponse({
            ok: true,
            data: { ...result, accountLabel }
          });
          break;
        }

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
        await ensureOptionalHostPermission(
          [effectiveSettings.wechatApiBase, ...collectPublishRemoteUrls(message.payload)],
          `公众号发布（${accountLabel}）`
        );
        const result = await withRetry(
          () => publishToWechat(effectiveSettings, message.payload),
          MAX_RETRIES,
          `公众号发布（${accountLabel}）`
        );
        void bumpUsage("publish");
        // P1.2 · 群发全员（is_to_all=true）有「每月最多 4 次」硬上限。
        // 微信侧没有"查询本月已用次数"的接口，只能在扩展端自维护一个估算计数器。
        // 这里仅在 sendStrategy === "all" 且成功的路径上 +1，"tag" 不计配额。
        if (result?.sendStrategy === "all" && result?.massSendMsgId) {
          void bumpWechatSendAllQuota().catch((err) => {
            console.warn("[gzh] bumpWechatSendAllQuota failed:", err);
          });
        }
        sendResponse({ ok: true, data: { ...result, accountLabel } });
        break;
      }
      case "GET_WECHAT_PUBLISH_STATUS": {
        const settings = await getSettings();
        await ensureOptionalHostPermission(settings.wechatApiBase, "查询公众号发布状态");
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
        await ensureOptionalHostPermission(
          [settings.hotTopicsNewsnowBase, settings.rsshubBaseUrl],
          "热点数据源"
        );
        const result = await fetchHotTopics(message.payload?.source || "zhihu", {
          forceRefresh: message.payload?.forceRefresh || false,
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
      case "PLAN_TOPICS": {
        // AI 选题规划：聚合多源 → 算法过滤评分 → 让 LLM 当选题总监输出推荐
        const result = await runTopicPlanning(message.payload || {});
        sendResponse(result);
        break;
      }
      case "IMPORT_OUTLINE_DRAFT": {
        // 用提纲开稿：把 AI 选题总监给的某条推荐写成 lastCapture（kind=outline）
        // workspace.html?import=1&fromOutline=1 打开后会识别并走"提纲开稿"模式。
        const capture = message.payload?.capture;
        if (!capture || capture.kind !== "outline") {
          sendResponse({
            ok: false,
            error: "缺少 outline capture 数据。"
          });
          break;
        }
        await saveSession({ lastCapture: capture });
        sendResponse({ ok: true });
        break;
      }
      default:
        sendResponse({ ok: false, error: { code: "UNKNOWN", message: "未知消息类型。", retryable: false } });
    }
  })().catch((error) => {
    const classified = classifyError(error);
    const errorPayload = {
      code: classified.code,
      message: classified.message,
      retryable: classified.retryable
    };
    if (classified.requiresVerifiedAccount || error?.requiresVerifiedAccount) {
      errorPayload.requiresVerifiedAccount = true;
      if (error?.errcode) errorPayload.errcode = error.errcode;
    }
    // 40164 IP 白名单：把当前出口 IP 透到前端，让 UI（toast / future「一键复制 IP」按钮）可以直接读，
    // 不必再从 message 字符串里 regex 二次解析。
    const detectedIp = classified.detectedIp || error?.detectedIp;
    if (detectedIp) errorPayload.detectedIp = detectedIp;
    // 40007 invalid media_id：把微信侧 hint 诊断码透到前端，让 UI / 客服工单都能直接 surface，
    // 不必再从 message 字符串里 regex 二次解析。
    const detectedMediaIdHint = classified.detectedMediaIdHint || error?.detectedMediaIdHint;
    if (detectedMediaIdHint) errorPayload.detectedMediaIdHint = detectedMediaIdHint;
    sendResponse({ ok: false, error: errorPayload });
  });

  return true;
});

/**
 * P1.2 · 「群发全员」配额自维护。
 * 微信侧没有"查询本月已用次数"的接口，只能在扩展端自己估算：
 *   - key 形如 "2026-04"，每月一段
 *   - 进入新自然月时自动重置 count 为 0
 *   - 每次成功调用 mass/sendall(is_to_all=true) +1
 * 注意：这只是估算，多设备同步、API 端调失败但实际送达等极端 case 都会让计数和官方实际配额脱钩。
 */
async function bumpWechatSendAllQuota() {
  const now = new Date();
  const monthKey = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
  const settings = await getSettings();
  const sameMonth = settings.wechatSendAllUsageMonth === monthKey;
  const nextCount = (sameMonth ? Number(settings.wechatSendAllUsageCount) || 0 : 0) + 1;
  await saveSettings({
    wechatSendAllUsageMonth: monthKey,
    wechatSendAllUsageCount: nextCount
  });
  return nextCount;
}

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

/**
 * 跑 humanize-checker.lintArticle，吞掉所有异常返回 null。
 * 之所以做 try/catch：lint 是"锦上添花"，规则数据出错或文本极端值导致除零
 * 都不应该让整篇改写失败。
 */
function safeLintArticle(article, template) {
  try {
    return lintArticle(article, {
      templateId: template?.id || "",
      profile: template?.humanizeProfile || null
    });
  } catch (err) {
    console.warn("[humanize] lint 失败，已跳过：", err);
    return null;
  }
}

/**
 * 把 humanize-pass 的实时进度推给所有 workspace tab。
 *
 * 事件 phase 命名（workspace-rewrite.js 的 onMessage 监听对照）：
 *  - pass1:start   主 pass 开始
 *  - pass1:done    主 pass 完成
 *  - pass2:plan    二次 pass 准备（lint 完成、决定要重写多少段）
 *  - pass2:start   二次 pass 第一段开跑
 *  - pass2:tick    某段完成（current/total 自增）
 *  - pass2:done    二次 pass 全部 settled
 *  - done          整体改写完成（sendResponse 之前最后一帧）
 *
 * sendMessage 在没有 workspace tab 监听时会 reject "no receiver"，吞掉即可，
 * 不影响主流程。
 */
function broadcastRewriteProgress(requestId, info) {
  try {
    chrome.runtime
      .sendMessage({ type: "REWRITE_PROGRESS", payload: { requestId, ...info } })
      .catch(() => {});
  } catch {
    // 老版本 chrome 在没有监听者时 sendMessage 直接 throw
  }
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
      const code = error?.helperErrorCode ? ` [${error.helperErrorCode}]` : "";
      console.warn(`[gzh] DrissionPage 抓取失败，回退到内置抓取${code}：`, error?.message || error);
    }
  }

  await ensureOptionalHostPermission(sourceTab.url, "抓取当前网页");

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
    throw new Error("不是一个合法的可抓取网址，请换一条原文链接（不能是 chrome://、扩展页或 file:// 等本地协议）。");
  }

  // 后台静默抓取（热点页一键入库 / topic-planner 推荐）：
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
      const code = error?.helperErrorCode ? ` [${error.helperErrorCode}]` : "";
      console.warn(`[gzh] DrissionPage 后台抓取失败，回退到内置 tab 抓取${code}：`, error?.message || error);
    }
  }

  // ──────── 兜底路径：开后台 tab → 注入脚本 → 抓取 ────────
  // 每一步 chrome.* 调用都套局部 try，把英文系统错包成可读中文，
  // 避免 service worker 抛出原始英文异常被 classifyError fallback 吞掉。
  await ensureOptionalHostPermission(targetUrl, "后台抓取原文网页");

  let tab;
  try {
    tab = await chrome.tabs.create({ url: targetUrl, active: false });
  } catch (error) {
    throw new Error(`无法打开后台抓取标签页：${error?.message || error}`);
  }
  if (!tab?.id) {
    throw new Error("无法打开后台抓取标签页（chrome.tabs.create 没返回 tabId）。");
  }

  let capture = null;

  try {
    try {
      await waitForTabComplete(tab.id, 15000);
    } catch (error) {
      throw new Error(`目标页面在 15 秒内未加载完成：${error?.message || "可能跳转或被反爬拦截"}`);
    }

    try {
      await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        files: [SCRAPE_ARTICLE_SCRIPT]
      });
    } catch (error) {
      // 典型："Cannot access contents of url 'xxx'. Extension manifest must request..."
      // 已在 classifyError 里有专门匹配 → 走 SCRAPE_HOST_BLOCKED；这里仍把原始信息抛出去，
      // classifyError 能精准识别并给"该页面拒绝扩展访问"的友好提示。
      throw error;
    }

    let results;
    try {
      results = await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        func: async () => {
          if (typeof window.__gzhRunFullCapture !== "function") {
            return null;
          }
          return window.__gzhRunFullCapture();
        }
      });
    } catch (error) {
      throw new Error(`页面脚本执行失败：${error?.message || "脚本注入被站点 CSP 拦截"}`);
    }

    capture = results?.[0]?.result;
    if (!capture) {
      throw new Error(
        "页面正文抓取脚本未返回结果，可能是站点用 SPA 框架且未在 15 秒内完成首屏渲染，请打开原文确认或换一条试试。"
      );
    }
    assertCaptureHealth(capture, targetUrl);

    const finalTab = await chrome.tabs.get(tab.id).catch(() => null);
    await saveSession({
      lastSourceTabId: null,
      lastSourceTitle: finalTab?.title || capture.title || "",
      lastSourceUrl: finalTab?.url || targetUrl,
      lastCapture: capture
    });

  } finally {
    if (tab?.id) {
      await chrome.tabs.remove(tab.id).catch(() => {});
    }
  }

  return capture;
}

/**
 * AI 选题规划主流程（service-worker 端）。
 *
 * 流程：
 *   闸门（pro 或 free 1次/天试用）
 *     → 解析候选源（用户手动 / 自动按画像映射）
 *     → 并行 fetchHotTopics 拉每个源
 *     → normalize + hardFilter + score + diversity（topic-planner.js 纯函数）
 *     → 调用户配置的 AI 走 chat completion
 *     → parseTopicDirectorOutput 抗幻觉过滤
 *     → bumpUsage("topicPlanner")
 *     → 返回 { strategySummary, recommendedTopics, ... }
 *
 * 失败策略：任何一步失败都返回 { ok:false, error, errorCode }，
 * 不抛错，让前端用 toast 展示。
 */
async function runTopicPlanning(payload = {}) {
  const profile = payload.profile || {};
  const requestedSources = Array.isArray(payload.sourceIds) ? payload.sourceIds : [];
  // reroll 模式：单条「换一个角度」，会复用上次的 candidatePool（避免重新拉源 + 重算分），
  // 仍计 1 次配额（因为还要花 LLM）。
  const reroll = payload.reroll && payload.reroll.itemId ? payload.reroll : null;
  const cachedPool = Array.isArray(payload.cachedPool) ? payload.cachedPool : null;

  // 1) 闸门：免费版每天 1 次试用，Pro 不限
  const featureCheck = await checkLicense("ai.topicPlanner");
  const isFreeTrial = !featureCheck.ok;
  const trialQuota = await checkDailyQuota("topicPlanner", {
    limit: 1,
    featureKey: "ai.topicPlanner"
  });
  if (isFreeTrial && !trialQuota.ok) {
    return {
      ok: false,
      error: trialQuota.hint,
      errorCode: "LICENSE_QUOTA_EXCEEDED",
      meta: {
        feature: "ai.topicPlanner",
        quota: { used: trialQuota.used, limit: trialQuota.limit }
      }
    };
  }

  // 免费试用只展示 1 条推荐，因此也只让 AI 生成 1 条。之前即使最终只截取
  // 1 条，仍会按用户选择的 5/10 条生成完整结果，容易把前端 60s 等待窗口耗尽。
  const effectiveProfile =
    isFreeTrial && !reroll
      ? { ...profile, outputCount: 1 }
      : profile;

  // 2) AI 设置必须存在
  const settings = await getSettings();
  if (!settings?.apiKey?.trim() || !settings?.apiBaseUrl?.trim()) {
    return {
      ok: false,
      error: "AI 接口未配置，请到「AI 设置」补完 API Base URL / API Key / Model 后再试。",
      errorCode: "AI_NOT_CONFIGURED"
    };
  }
  await ensureOptionalHostPermission(settings.apiBaseUrl, "AI 选题规划接口");

  // 3 + 4 + 5：reroll 走快路径（直接复用上次 candidatePool）；常规路径要重新拉源 → 评分 → 筛选
  let aiPool = [];
  let normalized = [];
  let rejected = [];
  let sourcePayloads = [];
  let fetchResults = [];

  if (reroll && cachedPool && cachedPool.length > 0) {
    const found = cachedPool.find((c) => c && c.id === reroll.itemId);
    if (!found) {
      return {
        ok: false,
        error: "上次推荐的候选已失效（缓存丢失）。请回到「AI 智能选题」重新生成完整推荐。",
        errorCode: "REROLL_ITEM_MISSING"
      };
    }
    aiPool = [
      {
        ...found,
        breakdown: found.breakdown || null
      }
    ];
  } else {
    const sourceIds = requestedSources.length
      ? requestedSources.filter((id) => HOT_SOURCE_META[id])
      : resolveAutoSourceIds(profile, HOT_SOURCE_META, { maxSources: 8 });
    if (sourceIds.length === 0) {
      return {
        ok: false,
        error:
          "没有可用的热点源。请在画像里至少勾选一个内容领域，或手动选几个源后重试。",
        errorCode: "NO_SOURCES"
      };
    }
    await ensureOptionalHostPermission(
      [settings.hotTopicsNewsnowBase, settings.rsshubBaseUrl],
      "AI 选题规划热点源"
    );

    fetchResults = await Promise.all(
      sourceIds.map((sourceId) =>
        fetchHotTopics(sourceId, {
          forceRefresh: false,
          newsnowBase: settings.hotTopicsNewsnowBase,
          rsshubBaseUrl: settings.rsshubBaseUrl
        })
          .then((r) => ({ sourceId, ok: r.ok, payload: r.payload || null, message: r.message }))
          .catch((e) => ({ sourceId, ok: false, payload: null, message: e?.message }))
      )
    );

    sourcePayloads = fetchResults
      .filter((r) => r.ok && r.payload && Array.isArray(r.payload.items))
      .map((r) => ({ sourceId: r.sourceId, label: r.payload.label, items: r.payload.items, fetchedAt: r.payload.fetchedAt }));

    if (sourcePayloads.length === 0) {
      const reasons = fetchResults.map((r) => `${r.sourceId}: ${r.message || "未知"}`).join("；");
      return {
        ok: false,
        error: `所有候选源都拉取失败。${reasons}`,
        errorCode: "ALL_SOURCES_FAILED"
      };
    }

    normalized = normalizeCandidates(sourcePayloads, HOT_SOURCE_META);
    const filtered = hardFilterCandidates(normalized, profile);
    rejected = filtered.rejected;
    if (filtered.kept.length === 0) {
      return {
        ok: false,
        error:
          "硬过滤后无可用候选。可能是画像勾选了太多排除项，或这些源今天的内容都不符合你的领域。试试在画像里多选几个领域。",
        errorCode: "EMPTY_AFTER_FILTER",
        meta: { rejectedCount: rejected.length }
      };
    }
    const scored = scoreCandidates(filtered.kept, profile, { now: Date.now() });
    const aiPoolSize = Math.min(
      20,
      Math.max(8, (effectiveProfile.outputCount || 5) * 3)
    );
    aiPool = applyDiversityFilter(scored, effectiveProfile, { topN: aiPoolSize });
    if (aiPool.length === 0) {
      return {
        ok: false,
        error: "多样性筛选后没有可推荐的候选。",
        errorCode: "EMPTY_AFTER_DIVERSITY"
      };
    }
  }

  // 6) 调 AI 选题总监
  const messages = buildTopicDirectorMessages(effectiveProfile, aiPool, {
    reroll: reroll
      ? { itemId: reroll.itemId, previousAngle: reroll.previousAngle || "" }
      : null
  });
  let aiText = "";
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), TOPIC_PLANNER_AI_TIMEOUT_MS);
  try {
    const aiResp = await fetch(settings.apiBaseUrl.trim(), {
      method: "POST",
      signal: controller.signal,
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${settings.apiKey.trim()}`
      },
      body: JSON.stringify({
        model: String(settings.model || "").trim(),
        // 选题总监需要稳定输出 JSON，温度调低一些（比 rewrite 默认 0.8 低）
        temperature: 0.4,
        messages
      })
    });
    const respJson = await aiResp.json().catch(() => ({}));
    if (!aiResp.ok) {
      const m = respJson?.error?.message || respJson?.message || `状态码 ${aiResp.status}`;
      return {
        ok: false,
        error: `AI 调用失败：${m}`,
        errorCode: "AI_CALL_FAILED"
      };
    }
    aiText = extractChatContent(respJson) || "";
    if (!aiText) {
      return {
        ok: false,
        error: "AI 返回内容为空，无法生成选题。可能是模型仅支持旧版接口或被代理截断。",
        errorCode: "AI_EMPTY_RESPONSE"
      };
    }
  } catch (e) {
    if (e?.name === "AbortError") {
      return {
        ok: false,
        error:
          "AI 接口响应超过 65 秒，已主动中断。建议换更快的模型、降低推荐数量，或检查 API 网关是否拥塞。",
        errorCode: "AI_TIMEOUT"
      };
    }
    return {
      ok: false,
      error: `AI 调用异常：${e?.message || e}`,
      errorCode: "AI_CALL_FAILED"
    };
  } finally {
    clearTimeout(timeoutId);
  }

  // 7) 解析 + 抗幻觉
  const parsed = parseTopicDirectorOutput(aiText, aiPool);
  if (!parsed.ok) {
    return {
      ok: false,
      error: `AI 输出无法落地：${parsed.reason || "未知原因"}`,
      errorCode: "AI_PARSE_FAILED",
      meta: { rawLen: aiText.length, diagnostics: parsed.diagnostics }
    };
  }

  // 8) 免费版试用：只展示 1 条 + 计数。reroll 模式不在免费版可触发（前端拦截）。
  const limitedRecommendations =
    isFreeTrial && !reroll ? parsed.recommendedTopics.slice(0, 1) : parsed.recommendedTopics;

  void bumpUsage("topicPlanner");

  return {
    ok: true,
    data: {
      strategySummary: parsed.strategySummary,
      recommendedTopics: limitedRecommendations,
      rejectedPatterns: parsed.rejectedPatterns,
      // candidatePool 透出给前端做 reroll：reroll 时只回当前条
      candidatePool: aiPool.map((c) => ({
        id: c.id,
        title: c.title,
        source: c.source,
        sourceLabel: c.sourceLabel,
        url: c.url,
        rank: c.rank,
        subtitle: c.subtitle || "",
        fetchedAt: c.fetchedAt,
        sourceQuality: c.sourceQuality,
        categoryGuess: c.categoryGuess,
        duplicateGroupId: c.duplicateGroupId,
        worthScore: c.worthScore,
        hasUrl: c.hasUrl,
        breakdown: c.breakdown || null
      })),
      meta: {
        plan: featureCheck.ok ? "pro" : "free",
        isFreeTrial,
        isReroll: Boolean(reroll),
        trial: isFreeTrial
          ? { used: trialQuota.used + 1, limit: trialQuota.limit }
          : null,
        sourcesUsed: reroll ? [] : sourcePayloads.map((p) => p.sourceId),
        sourcesFailed: reroll ? [] : fetchResults.filter((r) => !r.ok).map((r) => r.sourceId),
        candidateCount: reroll ? aiPool.length : normalized.length,
        rejectedCount: reroll ? 0 : rejected.length,
        aiPoolSize: aiPool.length,
        droppedByAI: parsed.diagnostics?.droppedReasons || []
      }
    }
  };
}
