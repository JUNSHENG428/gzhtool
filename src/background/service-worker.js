import {
  evaluateArticleLength,
  requestRewrite,
  testAiConnection,
  extractChatContent,
  postChatCompletionWithReasoningFallback
} from "../shared/ai.js";
import {
  getActivePromptTemplate,
  getPromptTemplates,
  getSession,
  getSettings,
  saveSession,
  saveSettings
} from "../shared/storage.js";
import { WECHAT_WEB_EDITOR_URL, STORAGE_KEYS } from "../shared/defaults.js";
import { classifyError } from "../shared/errors.js";
import { getAuthRecord, saveAuthRecord, getApiBase } from "../shared/license.js";
import {
  collectPublishRemoteUrls,
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
import { safeScanCompliance, parseCustomComplianceTerms } from "../shared/compliance-checker.js";
import { applyCachedComplianceRules, refreshRemoteComplianceRules } from "../shared/compliance-remote.js";
import { runHumanizePass } from "../shared/humanize-pass.js";
import { getActiveVoiceSample } from "../shared/voice-samples.js";
import { ensureOptionalHostPermission } from "../shared/host-permissions.js";
// 浏览器登录模式发布通道 —— 必须**静态** import，**不能**用 `await import()`：
// MV3 service worker 按 HTML 规范禁用动态 import（运行时抛
// "import() is disallowed on ServiceWorkerGlobalScope by the HTML specification"），
// 见 https://github.com/w3c/ServiceWorker/issues/1356。
// 哪怕是为了"按需懒加载"也不行——SW 里只能用顶部静态 import。
import { publishViaBrowser } from "./wechat-browser-bridge.js";
import {
  addTask as registerTask,
  updateTask as updateRegistryTask,
  completeTask as completeRegistryTask,
  cancelTask as cancelRegistryTask,
  cancelByRequestId as cancelRegistryByRequestId,
  cancelRunningTasksForArticle as cancelRegistryTasksForArticle,
  attachAbortController as attachTaskAbortController,
  findTaskByRequestId as findTaskByReqId,
  getTaskListSnapshot as snapshotTaskList,
  getTaskResult as getRegistryTaskResult,
  restoreAndCleanStale as restoreTaskRegistry
} from "./task-registry.js";

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

/**
 * 浮球 PULL 流程里"等待后台静默 workspace tab init 就绪"的 resolver 表。
 * key = tabId（chrome.tabs.create 后的 tab.id）；value = Promise resolver。
 * workspace.js 在 invisible_for_pull tab init 完成后发 WORKSPACE_READY_FOR_PULL，
 * SW handler 读这个 Map 把对应 promise resolve 掉，让 runFloatingBallPull 能继续。
 * 防泄漏：用 5s 超时兜底，超时后从 Map 删除并抛错。
 */
const pendingFloatingBallReady = new Map();

// `collectPublishRemoteUrls` 已抽到 src/shared/wechat.js（前后端共用），从那里 import。

// SW 冷启动 / 重装时立即恢复任务中心状态并清理 stale running task。
// 不放在 onInstalled 里，因为冷启动（chrome 已开但 SW 被回收后被消息唤起）
// 不会触发 onInstalled，但会执行顶层代码。
void restoreTaskRegistry();

// 合规检测远程词库：先注入缓存（同步快），再异步刷新（24h 节流，失败静默）。
void applyCachedComplianceRules().then(() => refreshRemoteComplianceRules());

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

const DOCUEARN_ORIGIN_RE = /^https:\/\/([a-z0-9-]+\.)*docuearn\.com$/i;

/**
 * 处理官网 content script 桥接来的登录态同步。
 * 安全：① 只接受本扩展自己的 content script（sender.id 匹配）；
 *       ② sender.url 的 origin 必须是 docuearn.com；
 *       ③ token 先调 /api/me 验真，确认有效才落库（不存垃圾 token）。
 * 只「同步进来」，从不因网站登出而清掉插件登录态。
 */
async function handleDocuearnAuthHandoff(message, sender) {
  try {
    if (sender?.id && sender.id !== chrome.runtime.id) {
      return { ok: false, error: "sender mismatch" };
    }
    let origin = "";
    try {
      origin = new URL(sender?.url || "").origin;
    } catch {
      /* ignore */
    }
    if (!DOCUEARN_ORIGIN_RE.test(origin)) {
      return { ok: false, error: "origin not allowed" };
    }
    const token = String(message?.token || "").trim();
    if (!token) return { ok: false, error: "empty token" };

    // 去重：与现有登录态相同则跳过（避免每次打开官网都复验）
    const existing = await getAuthRecord();
    if (existing?.token === token) {
      return { ok: true, skipped: "same" };
    }

    // 验真：用该 token 调 /api/me，确认有效再落库
    const base = await getApiBase();
    let resp;
    try {
      resp = await fetch(`${base}/api/me`, {
        headers: { Authorization: `Bearer ${token}` }
      });
    } catch (netErr) {
      return { ok: false, error: `network: ${netErr?.message || "unknown"}` };
    }
    if (!resp.ok) {
      return { ok: false, error: `verify failed (HTTP ${resp.status})` };
    }
    const data = await resp.json().catch(() => null);
    const user = data?.user || data?.account || null;

    await saveAuthRecord({ token, user, issuedAt: Date.now() });
    console.log("[auth-bridge] 已从 docuearn.com 同步登录态", user?.email || "");
    return { ok: true, synced: true, email: user?.email || "" };
  } catch (err) {
    return { ok: false, error: String(err?.message || err) };
  }
}

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
      case "DOCUEARN_AUTH_HANDOFF": {
        // 官网 content script 桥接来的登录态同步（详见 content-scripts/docuearn-auth-bridge.js）
        const result = await handleDocuearnAuthHandoff(message, sender);
        sendResponse(result);
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
        // 注册到 task-registry：让任务中心能看到抓取进度。capture 没有 phase 进度推送，
        // 状态停在 'capture:fetching' 直到完成；用户切走后回来通过 task-center.[查看]按钮
        // 拿到 source（task.result.source）落到 article。
        const captureArticleId = String(message.payload?.articleId || "").trim();
        const captureArticleTitle = String(message.payload?.articleTitle || "").trim() || "抓取页面";
        const captureRequestId = String(message.payload?.requestId || "").trim() || `cap-${Date.now()}`;
        // 抓新内容 = 该 article 的老 rewrite 任务必然产出废弃数据（rewrite 用的是抓前的
        // source 副本，跑完会覆盖用户刚抓的新内容）。先把同 article 的 in-flight rewrite
        // 取消掉，避免"抓了新文章但任务列表里还在改写老文章"的诡异表现。
        if (captureArticleId) {
          const cancelled = cancelRegistryTasksForArticle(
            captureArticleId,
            "rewrite",
            "因抓取新内容自动取消（避免老改写覆盖新源）"
          );
          if (cancelled > 0) {
            console.log(`[task-registry] 抓取触发取消同 article ${cancelled} 个 in-flight rewrite`);
          }
        }
        const captureTaskHandle = registerTask({
          type: "capture",
          articleId: captureArticleId,
          articleTitle: captureArticleTitle,
          requestId: captureRequestId
        });
        const captureTaskId = captureTaskHandle.taskId;
        updateRegistryTask(captureTaskId, { phase: "capture:fetching" });

        try {
          const capture = await scrapeLastSourceTab(message.payload?.captureMode || "readable");
          await saveSession({ lastCapture: capture });
          void bumpUsage("capture");
          sendResponse({ ok: true, data: capture });
          completeRegistryTask(captureTaskId, {
            status: "done",
            result: {
              source: capture,
              articleId: captureArticleId,
              articleTitle: captureArticleTitle
            }
          });
        } catch (captureErr) {
          completeRegistryTask(captureTaskId, {
            status: "failed",
            error: String(captureErr?.message || captureErr || "抓取失败")
          });
          throw captureErr;
        }
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

        // 注册到 task-registry，让任务中心面板能看到本次改写。articleId / articleTitle 由
        // workspace-rewrite.js 从 getCurrentArticle() 取，没传时降级用 requestId。
        const articleId = String(message.payload?.articleId || "").trim();
        const articleTitle = String(message.payload?.articleTitle || "").trim() || "未命名";
        const taskHandle = registerTask({
          type: "rewrite",
          articleId,
          articleTitle,
          requestId
        });
        const taskId = taskHandle.taskId;

        try {

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
            // 这个 break 在 try 内退出 switch，不会触发下面的 catch / finally；
            // 必须先把已注册的 task 标 failed，否则任务中心会留一条永远 running 的卡死任务（内存泄漏）。
            completeRegistryTask(taskId, {
              status: "failed",
              error: access.hint || PAID_FEATURES["ai.advancedTemplates"].hint
            });
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
        // 43rd session · 文风模拟年费闸门（ai.voiceMimic）：非年费静默跳过注入，
        // 主改写流程不阻断不报错（与 deAiBoost「加强功能不挡主流程」同一设计）。
        // 此处是 voiceSample 唯一注入点，主 pass 与二次润色 pass 同时被闸住。
        let voiceSample = null;
        try {
          const voiceAccess = await checkLicense("ai.voiceMimic");
          if (voiceAccess.ok) {
            voiceSample = await getActiveVoiceSample();
          }
        } catch (err) {
          console.warn("[voice-samples] 读取激活样本失败，跳过文风注入：", err);
        }

        broadcastRewriteProgress(requestId, { phase: "pass1:start", current: 0, total: 1 });

        // 44th session · 主 pass 可取消：AbortController 挂到 task-registry，
        // CANCEL_TASK / 抓取联动 cancelTask 内部会 abort 它 → in-flight LLM fetch 立刻
        // reject（code=CANCELLED，不重试不扣后续额度）。此前取消只 abort pass2，
        // pass1 的 LLM 照跑照计费、saveSession 照写，「取消」对用户是假的。
        const pass1Controller = new AbortController();
        attachTaskAbortController(taskId, pass1Controller);

        // 主 pass —— 一次正常的 AI 改写
        // 39th 续 · Phase 3b · 流式响应进度回调（settings.platformStreaming + aiSourceMode=platform 才触发）
        // ai.js requestRewriteViaPlatformStreaming 每收到一个 SSE delta 调一次 onProgress({chars, tokens})；
        // 非流式路径不调 onProgress，UI 自然回退到 pass1:start 的 "AI 改写中..." 静态文案
        let article = await withRetry(
          () =>
            requestRewrite(
              settings,
              message.payload.source,
              message.payload.preferences || {},
              template,
              voiceSample,
              {
                abortSignal: pass1Controller.signal,
                onProgress: (info) => {
                  broadcastRewriteProgress(requestId, {
                    phase: "pass1:streaming",
                    streamingChars: Number(info?.chars) || 0,
                    streamingTokens: Number(info?.tokens) || 0
                  });
                }
              }
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
        const skipScore = Number(settings.humanizeSkipScore ?? 80);
        const lintScore = Number(lint?.score ?? 0);
        // 即便总分达标，只要还有 error 级 AI 痕迹（如「综上所述」整段套话）也不跳过 S2——
        // 总分四舍五入会把"单条严重痕迹"洗白，专项返工才能真正除味。
        const hasErrorIssue =
          Array.isArray(lint?.issues) && lint.issues.some((it) => it.severity === "error");
        const skipForHighScore =
          Number.isFinite(skipScore) && skipScore > 0 && lintScore >= skipScore && !hasErrorIssue;

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

        // 44th · 取消与完成赛跑的兜底：pass1/pass2 已跑完但用户刚点了取消
        // （task 已标 cancelled）→ 不写 session、不下发结果，尊重用户取消语义。
        // completeRegistryTask 本身有终态保护（cancelled 不会被 done 覆盖）。
        const taskAfterRun = findTaskByReqId(requestId);
        if (taskAfterRun?.status === "cancelled") {
          sendResponse({ ok: false, errorCode: "CANCELLED", error: "已取消改写。" });
          break;
        }

        await saveSession({ lastDraft: article });
        void bumpUsage("rewrite");
        const lengthCheck = evaluateArticleLength(
          article,
          message.payload.preferences?.length
        );
        // 合规检测（本地，不阻断）：扫描最终稿，结果随 meta 下发给 UI 渲染 badge
        const compliance = safeScanCompliance(article, {
          customTerms: parseCustomComplianceTerms(settings.complianceCustomWords)
        });
        const baseMeta = template
          ? { templateId: template.id, templateName: template.name }
          : {};
        const responsePayload = {
          ok: true,
          data: article,
          meta: { ...baseMeta, requestId, lengthCheck, lint, humanizePass, compliance }
        };
        sendResponse(responsePayload);
        // task 标 done，把完整结果挂到 task.result，前端通过 GET_TASK_RESULT 拉
        // （前端切到别的 article 时，sendResponse 已发但前端没接住，从 task.result 兜底）
        // 注：humanizePass.aborted（用户跳过润色）仍属成功——主 pass 结果照常下发，故 status 恒为 done
        completeRegistryTask(taskId, {
          status: "done",
          result: {
            article,
            meta: { ...baseMeta, requestId, lengthCheck, lint, humanizePass, compliance },
            articleId,
            articleTitle,
            // 44th · 持久化原文图片列表：article.imageRefs 只存 index，真实 src 在
            // source.images 里。此前只存在 workspace 页面内存 Map（_sourceImagesByRequestId），
            // 改写期间刷新 / 从任务中心晚 apply 时 Map 已空 → 正文配图全部渲染成空。
            sourceImages: Array.isArray(message.payload?.source?.images)
              ? message.payload.source.images
              : []
          }
        });
        } catch (rewriteErr) {
          // 44th · 用户取消（CANCELLED）：task 已被 cancelTask 标 cancelled（终态保护，
          // 下面的 failed 是 no-op），直接安静回复，不进 outer catch 的错误分类链路。
          if (rewriteErr?.code === "CANCELLED") {
            sendResponse({ ok: false, errorCode: "CANCELLED", error: "已取消改写。" });
            break;
          }
          // 改写失败：标记 task failed，再让 outer catch 走 sendResponse({ok:false}) 链路
          completeRegistryTask(taskId, {
            status: "failed",
            error: String(rewriteErr?.message || rewriteErr || "未知错误")
          });
          throw rewriteErr;
        }
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
      case "LIST_TASKS": {
        // 任务中心面板首次挂载或路由切回时拉一次全量。运行时主要靠 TASK_LIST_CHANGED 推。
        sendResponse({ ok: true, data: snapshotTaskList() });
        break;
      }
      case "CANCEL_TASK": {
        // 用户点 chip 上[取消]：cancelRegistryTask 内部 abort 挂在 task 上的 controller
        // （44th 起 rewrite 主 pass 也挂了，in-flight LLM fetch 立刻断、不再扣额度），
        // 这里再补 abort humanize pass2 的 controller（按 requestId 存的旧路径）。
        const taskId = String(message.payload?.taskId || "").trim();
        const requestId = String(message.payload?.requestId || "").trim();
        const target = taskId
          ? null /* 直接传 taskId 时下面 cancelRegistryTask 处理 */
          : requestId
            ? findTaskByReqId(requestId)
            : null;
        const finalTaskId = taskId || target?.id || "";
        if (!finalTaskId) {
          sendResponse({ ok: false, error: { code: "TASK_NOT_FOUND", message: "找不到对应任务。" } });
          break;
        }
        // 同步触发 humanize-pass 的 AbortController（兼容旧 inflightHumanizeControllers 路径）
        const reqIdForAbort = requestId || target?.requestId || "";
        if (reqIdForAbort) {
          const ctl = inflightHumanizeControllers.get(reqIdForAbort);
          if (ctl) {
            try { ctl.abort(); } catch {}
            inflightHumanizeControllers.delete(reqIdForAbort);
          }
        }
        cancelRegistryTask(finalTaskId);
        sendResponse({ ok: true, data: { cancelled: true } });
        break;
      }
      case "GET_TASK_RESULT": {
        // 前端从任务中心点[查看]按钮跳到对应 article 时，需要把改写结果应用到 article。
        // sendResponse 已经把结果直接发给请求方了，但请求方如果当时不在该 article（用户切走了）
        // 拿不到结果，从 registry 兜底取。
        const taskId = String(message.payload?.taskId || "").trim();
        if (!taskId) {
          sendResponse({ ok: false, error: { code: "TASK_NOT_FOUND", message: "缺少 taskId。" } });
          break;
        }
        const result = getRegistryTaskResult(taskId);
        sendResponse({ ok: true, data: result });
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
          // publishViaBrowser 已在文件顶部静态 import（MV3 SW 禁用动态 import）。
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
      // ────────── 公众号编辑页悬浮助手（v0.1，twenty-ninth session）──────────
      // 注入仅 mp.weixin.qq.com，从润笔 workspace 反向 pull 当前激活草稿到 mp 编辑器。
      // 与 PUBLISH_TO_WECHAT browser 模式互补 —— 那条是 push（workspace 主动发），
      // 这条是 pull（用户在 mp 后台主动拉）。共用 IMPORT_ARTICLE_TO_WECHAT_EDITOR 协议
      // 与 wechat-editor-helper.js 的 importArticle 写入逻辑（含 DOM safety net）。
      case "OPEN_EXTENSION_PAGE": {
        // 浮球 5 球侧边栏的 4 个跳转球（工作台 / 热点 / 设置 / 帮助）调用入口。
        // 必须由 SW 调 chrome.tabs.create —— content script 没有 chrome.tabs API
        // （也不能用 window.open(chrome-extension://...)，会被 Chrome 拒
        // ERR_BLOCKED_BY_CLIENT）。这里只接受**自家扩展页**的相对路径，防止滥用。
        const allowedPaths = new Set([
          "src/workspace/workspace.html",
          "src/options/options.html",
          "src/pages/hot-topics.html",
          "src/pages/help.html",
          "src/popup/popup.html"
        ]);
        const path = String(message.payload?.path || "").replace(/^\/+/, "");
        if (!allowedPaths.has(path)) {
          sendResponse({ ok: false, error: `非法目标 path: ${path}` });
          break;
        }
        // 38th 续 14：支持 hash + articleId query 参数透传（mp 编辑器同步 banner
        // 的 [查看在润笔] 按钮跳到 workspace#layout 切到对应 article）
        const url = new URL(chrome.runtime.getURL(path));
        const hash = String(message.payload?.hash || "").replace(/^#+/, "");
        if (hash) url.hash = hash;
        const articleId = String(message.payload?.articleId || "").trim();
        if (articleId) url.searchParams.set("focus_article", articleId);
        await chrome.tabs.create({
          url: url.toString(),
          active: true
        });
        sendResponse({ ok: true });
        break;
      }
      case "GET_FLOATING_BALL_STATE": {
        const settings = await getSettings();
        sendResponse({
          ok: true,
          data: {
            enabled: Boolean(settings.floatingBallEnabled),
            position: settings.floatingBallPosition || null
          }
        });
        break;
      }
      case "DISABLE_FLOATING_BALL": {
        // 用户在浮球右键「永久隐藏」。saveSettings 写入后 chrome.storage.onChanged
        // 会自动通知所有打开的 mp tab，content script 监听变化后移除浮球 DOM。
        await saveSettings({ floatingBallEnabled: false });
        sendResponse({ ok: true });
        break;
      }
      case "SAVE_FLOATING_BALL_POSITION": {
        // 用户拖拽松手时调。x/y 已由 content script clamp 到视口范围。
        const x = Number(message.payload?.x);
        const y = Number(message.payload?.y);
        if (Number.isFinite(x) && Number.isFinite(y)) {
          await saveSettings({ floatingBallPosition: { x, y } });
        }
        sendResponse({ ok: true });
        break;
      }
      case "PULL_DRAFT_TO_MP_EDITOR": {
        // 浮球点「📥 从润笔取最新草稿」按钮触发。需要找一个打开的润笔工作台 tab
        // 让它构造 IMPORT_ARTICLE_TO_WECHAT_EDITOR payload（复用 _buildWechatPublishPayload
        // 的 themed HTML + sanitize 链路）—— SW 端不能直接调那条链路因为它依赖
        // DOMParser（MV3 SW 无 DOM API，已是 systemPatterns 反例约定）。
        const senderTabId = sender?.tab?.id;
        if (!senderTabId) {
          sendResponse({ ok: false, error: "无法识别当前 mp 编辑页 tab。" });
          break;
        }
        try {
          const result = await runFloatingBallPull(senderTabId, message.payload || {});
          sendResponse(result);
        } catch (error) {
          sendResponse({
            ok: false,
            error: error?.message || "拉草稿失败",
            errorCode: error?.code || "FLOATING_BALL_UNKNOWN"
          });
        }
        break;
      }
      case "WORKSPACE_READY_FOR_PULL": {
        // 后台静默打开的 workspace tab init 完成后会发这条消息。我们用一个 module-level
        // 的 Map 把 tabId → resolver 映射起来，runFloatingBallPull 那边在等这个 promise。
        const tabId = sender?.tab?.id;
        if (tabId && pendingFloatingBallReady.has(tabId)) {
          pendingFloatingBallReady.get(tabId)();
          pendingFloatingBallReady.delete(tabId);
        }
        sendResponse({ ok: true });
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

// 这些 error.code 重试没有意义（鉴权/配额/未配置/套餐闸门），重试只会：
// ① 让用户多等几秒才看到「请登录 / 配额用尽」；② 平台模式下若 worker 已计费，重试会二次扣额度。
const NON_RETRYABLE_ERROR_CODES = new Set([
  "AUTH_REQUIRED",
  "AUTH_EXPIRED",
  "PLATFORM_QUOTA_EXCEEDED",
  "PLATFORM_RATE_LIMITED", // 44th · 429 后 1.5s 重试大概率还是 429，且 worker 侧每次尝试都计费
  "PLATFORM_UNCONFIGURED",
  "LICENSE_BYOK_LOCKED",
  "LICENSE_TEMPLATE_LOCKED",
  "RATE_LIMITED",
  "CANCELLED" // 44th · 用户主动取消，重试=违背用户意图 + 继续扣额度
]);

async function withRetry(fn, maxRetries, operationName) {
  let lastError = null;
  for (let attempt = 1; attempt <= maxRetries + 1; attempt++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;
      // 不可重试错误立即抛出，不浪费 sleep + 不二次扣平台配额
      if (error && NON_RETRYABLE_ERROR_CODES.has(error.code)) {
        throw error;
      }
      // 44th · JSON 解析失败最多重试 1 次：模型偶发格式错误重试有救，
      // 但连坏两次基本是模型/prompt 问题，继续跑只是反复全额扣平台额度。
      if (error?.code === "AI_PARSE_FAILED" && attempt >= 2) {
        throw error;
      }
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
  // 同时把进度同步到 task-registry：让任务中心面板看到 chip 上的实时 phase / N/M 计数。
  // task-registry 内部 schedulePersistAndNotify 会触发 TASK_LIST_CHANGED 广播。
  const task = findTaskByReqId(requestId);
  if (task) {
    updateRegistryTask(task.id, {
      phase: info?.phase || task.phase,
      current: typeof info?.current === "number" ? info.current : task.current,
      total: typeof info?.total === "number" ? info.total : task.total,
      // 39th 续 · Phase 3b · 流式累计字数 / token（仅 phase="pass1:streaming" 时填充）
      // 任务卡 chip 用此值显示「AI 流式生成中… 1234 字 / 56 token」实时反馈
      streamingChars:
        typeof info?.streamingChars === "number" ? info.streamingChars : task.streamingChars,
      streamingTokens:
        typeof info?.streamingTokens === "number" ? info.streamingTokens : task.streamingTokens
    });
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

  let capture = results?.[0]?.result;

  // 抓取 fallback（38th 续 6）：readable 模式抓到空 blocks 时（SPA / 不规范站点
  // 命中 ROOT_SELECTORS 但内部 BOILERPLATE_RE 把所有段过滤光，或者 pickBestRoot
  // 选错根），自动回退一次 raw mode 重新提取。raw 不走 BOILERPLATE_RE 过滤，
  // 拿到所有可见块——虽然有杂质，但**总比让用户看到"抓取为空"无所适从强**。
  // capture.captureMode 标记 "readable-fallback-raw"，前端 UI 可以借此提示
  // "已自动回退原样抓取，建议在编辑前剔除噪声段"。
  if (
    safeMode === "readable" &&
    (!capture || !Array.isArray(capture.blocks) || capture.blocks.length === 0)
  ) {
    const rawResults = await chrome.scripting.executeScript({
      target: { tabId: sourceTab.id },
      func: async () => {
        if (typeof window.__gzhRunFullCapture !== "function") return null;
        return window.__gzhRunFullCapture({ mode: "raw" });
      }
    });
    const rawCapture = rawResults?.[0]?.result;
    if (rawCapture && Array.isArray(rawCapture.blocks) && rawCapture.blocks.length > 0) {
      capture = { ...rawCapture, captureMode: "readable-fallback-raw" };
    }
  }

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
// 汇集"历史选题标题"用于 novelty 去重：① 已写过的草稿标题（__draft_history）
// ② 上次 AI 选题推荐过的标题（topicPlanCache）。读 storage 失败时静默返空（不阻断选题）。
async function gatherTopicHistoryTitles() {
  const titles = [];
  try {
    const data = await new Promise((resolve) => {
      if (!globalThis.chrome?.storage?.local) return resolve({});
      chrome.storage.local.get(
        [STORAGE_KEYS.draftHistory, STORAGE_KEYS.topicPlanCache],
        (d) => resolve(d || {})
      );
    });
    // 草稿历史：每条 record 的 articleBundle[].meta.title
    const history = data[STORAGE_KEYS.draftHistory];
    const records = Array.isArray(history) ? history : history?.records || [];
    for (const rec of records.slice(0, 50)) {
      const bundle = rec?.articleBundle || rec?.bundle || [];
      for (const art of bundle) {
        const t = art?.meta?.title?.trim();
        if (t) titles.push(t);
      }
      const single = rec?.sourcePreview?.title?.trim();
      if (single) titles.push(single);
    }
    // 上次选题缓存：recommendedTopics[].originalTitle
    const cache = data[STORAGE_KEYS.topicPlanCache];
    const recs = cache?.result?.recommendedTopics || cache?.recommendedTopics || [];
    for (const r of recs) {
      const t = (r?.originalTitle || r?.title || "").trim();
      if (t) titles.push(t);
    }
  } catch (_) {
    // 静默
  }
  return Array.from(new Set(titles)).slice(0, 120);
}

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
    // 接通 novelty：把"已写过的草稿标题 + 上次选题推荐过的标题"作为历史，
    // 让 scoreNovelty 给重复选题降权，避免反复推荐同一批热点。
    const historyTitles = await gatherTopicHistoryTitles();
    const scored = scoreCandidates(filtered.kept, profile, { now: Date.now(), historyTitles });
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
    // 推理模型（Kimi k2.x / o1 / R1）拒绝 temperature —— helper 命中 400 关键词时
    // 自动剥参重试，避免选题总监因为温度被服务端拒掉。
    const { response: aiResp, payload: respJson } =
      await postChatCompletionWithReasoningFallback(
        settings.apiBaseUrl.trim(),
        settings.apiKey,
        {
          model: String(settings.model || "").trim(),
          // 选题总监需要稳定输出 JSON，温度调低一些（比 rewrite 默认 0.8 低）
          temperature: 0.4,
          messages
        },
        { signal: controller.signal }
      );
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

/**
 * 公众号编辑页悬浮助手 PULL 主流程：
 *   ① 找/开 workspace tab → ② BUILD_PULL_READY_PAYLOAD → ③ IMPORT_ARTICLE_TO_WECHAT_EDITOR
 *
 * SW 不能直接拼装 HTML（DOMParser 限制），所以这里把"拼"委托给 workspace tab。
 * workspace tab 找不到时**后台静默打开**一个（active=false 不夺焦），让 BUILD listener
 * 跑完，跑完后**关掉这个临时 tab**避免污染用户工作环境。
 *
 * @param {number} mpTabId   - 浮球所在的 mp 编辑页 tab id
 * @param {object} extraPayload - 透传给 BUILD（articleId / 目标 profileIndex 等，v0.2 多草稿选择器用）
 */
async function runFloatingBallPull(mpTabId, extraPayload = {}) {
  const workspaceUrl = chrome.runtime.getURL("src/workspace/workspace.html");
  const existing = await chrome.tabs.query({ url: `${workspaceUrl}*` }).catch(() => []);

  let workspaceTabId;
  let isTransientTab = false;

  if (existing.length > 0) {
    // 多开 workspace tab 时不能盲取 existing[0]（那永远是最老的 tab，导致"同步的是上一篇"）。
    // 取「最近聚焦/访问」的那个 tab —— 用户刚看/刚抓的那篇就在这个 tab 的内存 state 里。
    const sorted = [...existing].sort(
      (a, b) => (Number(b.lastAccessed) || 0) - (Number(a.lastAccessed) || 0)
    );
    workspaceTabId = sorted[0].id;
  } else {
    // 后台静默开 workspace tab：active=false 不夺焦，url 加 invisible_for_pull=1 让
    // workspace.js bootstrap 跳过 first-run / autocapture / import 等用户感知副作用。
    const transient = await chrome.tabs.create({
      url: `${workspaceUrl}?invisible_for_pull=1`,
      active: false
    });
    workspaceTabId = transient.id;
    isTransientTab = true;

    // 等 WORKSPACE_READY_FOR_PULL signal（workspace.js bootstrap 末尾发）。
    // 5s 超时：bootstrap 慢于此说明初始化卡住，关 tab 报错让用户重试。
    try {
      await new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          pendingFloatingBallReady.delete(workspaceTabId);
          const err = new Error("工作台启动超时，请手动打开润笔工作台后重试。");
          err.code = "FLOATING_BALL_WORKSPACE_BOOT_TIMEOUT";
          reject(err);
        }, 5000);
        pendingFloatingBallReady.set(workspaceTabId, () => {
          clearTimeout(timer);
          resolve();
        });
      });
    } catch (err) {
      // 启动失败，关掉临时 tab 不留痕
      chrome.tabs.remove(workspaceTabId).catch(() => {});
      throw err;
    }
  }

  // 让 workspace 端构造 payload
  let buildResp;
  try {
    buildResp = await chrome.tabs.sendMessage(workspaceTabId, {
      type: "BUILD_PULL_READY_PAYLOAD",
      payload: extraPayload
    });
  } catch (error) {
    if (isTransientTab) chrome.tabs.remove(workspaceTabId).catch(() => {});
    const err = new Error(`工作台未响应，请刷新润笔工作台后重试。`);
    err.code = "FLOATING_BALL_WORKSPACE_TIMEOUT";
    throw err;
  }

  // 临时 tab 完成使命就关掉，不污染用户 tab 列表
  if (isTransientTab) {
    chrome.tabs.remove(workspaceTabId).catch(() => {});
  }

  if (!buildResp?.ok) {
    const err = new Error(buildResp?.error || "没有找到可同步的文章，请回到工作台重新选择草稿后再试。");
    err.code = buildResp?.errorCode || "FLOATING_BALL_BUILD_FAILED";
    throw err;
  }

  // 转发给 mp tab，复用现有 importArticle。
  // 把 drafts 列表（多草稿选择器用）merge 进 payload，让 content script 端 STATE.payload.drafts
  // 直接拿到，避免再起一条单独的消息通道。
  const enrichedPayload = {
    ...buildResp.payload,
    drafts: buildResp.drafts || []
  };
  let importResp;
  try {
    importResp = await chrome.tabs.sendMessage(mpTabId, {
      type: "IMPORT_ARTICLE_TO_WECHAT_EDITOR",
      payload: enrichedPayload
    });
  } catch (error) {
    const err = new Error(`公众号编辑器页面没有响应，请刷新公众号编辑页后重试。`);
    err.code = "FLOATING_BALL_MP_TIMEOUT";
    throw err;
  }

  return {
    ok: importResp?.ok !== false,
    data: importResp,
    payloadMeta: buildResp.payload?.meta || null,
    drafts: buildResp.drafts || null
  };
}
