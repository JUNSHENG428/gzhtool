/**
 * onboarding.js
 * ----------------------------------------------------------------
 * 跨页面共享的「上手任务清单」状态评估。
 *
 * 4 个步骤（与产品文案一致）：
 *   1. configureAi   配置 AI 改写接口
 *   2. captureOne    抓一篇网页（任意来源）
 *   3. rewriteOne    用 AI 改写一次
 *   4. publishOrCopy 推草稿 / 复制 HTML （任一即视为完成）
 *
 * 设计取舍：
 *   - 公众号发布配置不进 4 步主流程，因为它是"可选 / 高门槛"的，
 *     绑不绑定都不影响"试一次抓取改写"，避免新用户被吓退。
 *     公众号绑定状态会作为 optionalChecks.wechatBound 单独返回，
 *     供「设置」页或会员中心的进阶清单使用。
 *
 *   - 状态 source of truth 是 chrome.storage.local，所以同一份评估在
 *     popup / welcome / workspace / options 四处展示完全一致，不需要
 *     再各自维护 storage key。
 *
 *   - "已跳过"由用户主动点击「稍后配置」触发，记录在 STORAGE_KEY_SKIPS，
 *     刷新或重启浏览器后仍生效；点「重新开始」或完成对应任务可清除。
 *
 *   - usage-stats 是真实埋点；如果 storage 没初始化 usageStats（比如
 *     全新设备），所有计数视为 0，不至于把状态卡在"未抓取"。
 */

import { STORAGE_KEYS } from "./defaults.js";

const STORAGE_KEY_SKIPS = "wechatWriterOnboardingSkips";
const STORAGE_KEY_USAGE = "usageStats";

// 顺序就是 UI 显示顺序，welcome / workspace 直接 map() 渲染，不要乱动
export const STEP_IDS = ["configureAi", "captureOne", "rewriteOne", "publishOrCopy"];

const STEP_META = {
  configureAi: {
    id: "configureAi",
    order: 1,
    title: "配置 AI 改写接口",
    desc: "填一个 OpenAI 兼容的 API Key（DeepSeek / 通义 / Kimi / OpenAI 都行），改写才会工作。",
    primaryCta: { label: "去设置 API Key", action: "open-options" },
    skippable: false,
    requiredFor: ["rewriteOne"]
  },
  captureOne: {
    id: "captureOne",
    order: 2,
    title: "抓一篇网页",
    desc: "从知乎 / 36 氪 / 公众号文章随便挑一条试试，1 秒就能把正文 + 配图拉进编辑台。",
    primaryCta: { label: "抓当前页", action: "popup-capture" },
    skippable: false
  },
  rewriteOne: {
    id: "rewriteOne",
    order: 3,
    title: "AI 改写一次",
    desc: "进入编辑台后点「AI 改写当前篇」，看一次 AI 怎么把原文改成你的口吻。",
    primaryCta: { label: "去编辑台", action: "open-workspace" },
    skippable: false
  },
  publishOrCopy: {
    id: "publishOrCopy",
    order: 4,
    title: "推草稿 / 复制 HTML",
    desc: "二选一：① 在「发布」面板把改好的稿件推到公众号草稿箱；或 ② 直接复制 HTML 粘贴到公众号后台。",
    primaryCta: { label: "去发布面板", action: "open-publish" },
    skippable: true,
    optional: true
  }
};

const OPTIONAL_CHECK_META = {
  wechatBound: {
    id: "wechatBound",
    title: "（可选）绑定公众号",
    desc: "想直接推到公众号草稿，需要在设置页填 AppID/AppSecret；只想复制 HTML 的话可以跳过。",
    primaryCta: { label: "去设置公众号", action: "open-options-wechat" }
  }
};

// =====================================================================
// storage helpers
// =====================================================================

async function readStorage(keys) {
  if (!globalThis.chrome?.storage?.local) return {};
  return new Promise((resolve) => {
    chrome.storage.local.get(keys, (data) => resolve(data || {}));
  });
}

async function writeStorage(value) {
  if (!globalThis.chrome?.storage?.local) return;
  return new Promise((resolve) => {
    chrome.storage.local.set(value, () => resolve());
  });
}

// =====================================================================
// 公开 API
// =====================================================================

/**
 * 拉一份"上手清单"快照。
 *
 * 返回结构：
 *   {
 *     steps: Array<{
 *       id, order, title, desc, primaryCta, skippable,
 *       status: "completed" | "skipped" | "pending"
 *     }>,
 *     completedCount: number,    // status === "completed" 的数量
 *     pendingCount: number,      // status === "pending" 的数量
 *     skippedCount: number,
 *     allDone: boolean,          // completed + skipped >= 4
 *     nextStep: stepObj | null,  // 第一个 pending 的步骤；用于"推荐下一步"
 *     optionalChecks: {
 *       wechatBound: { ...meta, status: "completed" | "pending" }
 *     }
 *   }
 *
 * 该函数只读 storage，不会触发任何网络请求；适合 hot path。
 */
export async function getOnboardingSnapshot() {
  const data = await readStorage([
    STORAGE_KEYS.settings,
    STORAGE_KEYS.session,
    STORAGE_KEYS.draftHistory,
    STORAGE_KEY_USAGE,
    STORAGE_KEY_SKIPS,
    "historyDrafts",
    "drafts"
  ]);

  const settings = data[STORAGE_KEYS.settings] || {};
  const session = data[STORAGE_KEYS.session] || {};
  const skips = (data[STORAGE_KEY_SKIPS] && typeof data[STORAGE_KEY_SKIPS] === "object")
    ? data[STORAGE_KEY_SKIPS]
    : {};

  const usage = data[STORAGE_KEY_USAGE] || {};
  const usageTotal = sumUsage(usage);

  // ---- step 1: AI 配置 ----
  const aiConfigured = Boolean(String(settings.apiKey || "").trim());

  // ---- step 2: 抓过一篇 ----
  // 任一信号都算"抓过一篇"：
  //   - usageStats 累计 capture > 0
  //   - session.lastSourceUrl 非空（最近一次抓取的 URL 还在）
  //   - 历史草稿存在
  const drafts =
    (Array.isArray(data.historyDrafts) && data.historyDrafts) ||
    (Array.isArray(data.drafts) && data.drafts) ||
    (Array.isArray(data[STORAGE_KEYS.draftHistory]) && data[STORAGE_KEYS.draftHistory]) ||
    [];
  const capturedAtLeastOnce =
    usageTotal.capture > 0 ||
    Boolean(session.lastSourceUrl) ||
    Boolean(session.lastCapture?.url) ||
    drafts.length > 0;

  // ---- step 3: 改过一次 ----
  const rewrittenAtLeastOnce = usageTotal.rewrite > 0;

  // ---- step 4: 推过 / 复制过 ----
  // publish 计数包含「推草稿 + 复制 HTML」（usage-stats 在 service-worker 侧已合并）
  const publishedAtLeastOnce = usageTotal.publish > 0;

  const stepStatuses = {
    configureAi: aiConfigured ? "completed" : (skips.configureAi ? "skipped" : "pending"),
    captureOne: capturedAtLeastOnce ? "completed" : (skips.captureOne ? "skipped" : "pending"),
    rewriteOne: rewrittenAtLeastOnce ? "completed" : (skips.rewriteOne ? "skipped" : "pending"),
    publishOrCopy: publishedAtLeastOnce ? "completed" : (skips.publishOrCopy ? "skipped" : "pending")
  };

  const steps = STEP_IDS.map((id) => ({
    ...STEP_META[id],
    status: stepStatuses[id]
  }));

  const completedCount = steps.filter((s) => s.status === "completed").length;
  const skippedCount = steps.filter((s) => s.status === "skipped").length;
  const pendingCount = steps.filter((s) => s.status === "pending").length;
  const nextStep = steps.find((s) => s.status === "pending") || null;

  // ---- 可选清单 ----
  const wechatBound = Boolean(
    (settings.wechatAppId && settings.wechatAppSecret) ||
    (Array.isArray(settings.wechatProfiles) && settings.wechatProfiles.length > 0)
  );

  return {
    steps,
    completedCount,
    pendingCount,
    skippedCount,
    allDone: completedCount + skippedCount >= STEP_IDS.length,
    nextStep,
    optionalChecks: {
      wechatBound: {
        ...OPTIONAL_CHECK_META.wechatBound,
        status: wechatBound ? "completed" : "pending"
      }
    }
  };
}

/**
 * 标记某个步骤为「稍后配置 / 跳过」。仅 skippable=true 的步骤可调；
 * 其它步骤静默忽略，避免外部错把"配置 AI"也跳过去。
 */
export async function markStepSkipped(stepId) {
  const meta = STEP_META[stepId];
  if (!meta) return;
  if (!meta.skippable) {
    // 不允许跳过的步骤（比如 configureAi）静默 noop
    return;
  }
  const data = await readStorage([STORAGE_KEY_SKIPS]);
  const skips =
    data[STORAGE_KEY_SKIPS] && typeof data[STORAGE_KEY_SKIPS] === "object"
      ? { ...data[STORAGE_KEY_SKIPS] }
      : {};
  skips[stepId] = Date.now();
  await writeStorage({ [STORAGE_KEY_SKIPS]: skips });
}

/**
 * 重置所有"跳过"标记，让用户回到完整的 4 步清单。
 */
export async function resetSkips() {
  await writeStorage({ [STORAGE_KEY_SKIPS]: {} });
}

/**
 * 给 UI 直接订阅 onboarding 相关 storage 变更（settings / usageStats / session / skips）。
 * 任意一个变化都触发回调；callback 自己负责重新拉 snapshot。
 *
 * @returns {() => void} unsubscribe
 */
export function subscribeOnboarding(callback) {
  if (typeof callback !== "function") return () => {};
  if (!globalThis.chrome?.storage?.onChanged) return () => {};

  const listener = (changes, area) => {
    if (area !== "local") return;
    const relevant =
      changes[STORAGE_KEYS.settings] ||
      changes[STORAGE_KEYS.session] ||
      changes[STORAGE_KEYS.draftHistory] ||
      changes[STORAGE_KEY_USAGE] ||
      changes[STORAGE_KEY_SKIPS] ||
      changes.historyDrafts ||
      changes.drafts;
    if (!relevant) return;
    try {
      callback();
    } catch (err) {
      console.warn("[onboarding] subscriber failed", err);
    }
  };
  chrome.storage.onChanged.addListener(listener);
  return () => {
    try {
      chrome.storage.onChanged.removeListener(listener);
    } catch {
      /* ignore */
    }
  };
}

// =====================================================================
// 内部
// =====================================================================

function sumUsage(usage) {
  // usage 形态见 src/shared/usage-stats.js：
  //   { byDay: { "2026-04-24": { capture, rewrite, publish, topicPlanner }, ... },
  //     total: { capture, rewrite, publish, topicPlanner }, updatedAt }
  // 这里只关心累计是否 > 0，所以优先看 total，没有就遍历 byDay 兜底。
  const total = usage?.total;
  if (total && typeof total === "object") {
    return {
      capture: Number(total.capture) || 0,
      rewrite: Number(total.rewrite) || 0,
      publish: Number(total.publish) || 0
    };
  }
  const byDay = usage?.byDay || {};
  let capture = 0;
  let rewrite = 0;
  let publish = 0;
  for (const day of Object.values(byDay)) {
    if (!day || typeof day !== "object") continue;
    capture += Number(day.capture) || 0;
    rewrite += Number(day.rewrite) || 0;
    publish += Number(day.publish) || 0;
  }
  return { capture, rewrite, publish };
}

// =====================================================================
// 暴露 meta（给单测用）
// =====================================================================

export const __ONBOARDING_INTERNAL__ = Object.freeze({
  STEP_IDS,
  STEP_META,
  STORAGE_KEY_SKIPS
});
