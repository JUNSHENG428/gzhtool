/**
 * usage-stats.js
 * ----------------------------------------------------------------
 * Phase F：本地产能埋点（不联网、不收集任何身份信息）。
 *
 * 存储键：chrome.storage.local["usageStats"]
 * 结构：
 *   {
 *     byDay: {
 *       "2026-04-22": { capture: 3, rewrite: 5, publish: 1, agentImport: 2 },
 *       ...
 *     },
 *     total: { capture: 120, rewrite: 88, publish: 14, agentImport: 9 },
 *     updatedAt: "2026-04-22T08:11:00.000Z"
 *   }
 *
 * 仅保留最近 60 天 byDay，避免无限增长。
 *
 * 设计上不抛错（埋点失败不应影响主业务），所有方法静默失败。
 */

const STORAGE_KEY = "usageStats";
const DAY_RETAIN = 60;

/** 已知的埋点种类。新增请补到这里，并在 dashboard 上加显示。 */
export const USAGE_KINDS = Object.freeze([
  "capture",      // 抓取（不论 selection / readable / raw / 后台抓）
  "rewrite",      // AI 改写
  "publish",      // 推送公众号（草稿 / 发布）
  "agentImport"   // AI 选题代笔一键入库
]);

function todayKey(date = new Date()) {
  // 用本地时区的 YYYY-MM-DD，方便用户按"今天 / 本周"心智对照
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

function emptyStats() {
  return { byDay: {}, total: {}, updatedAt: null };
}

async function readRaw() {
  if (!globalThis.chrome?.storage?.local) return emptyStats();
  return new Promise((resolve) => {
    chrome.storage.local.get([STORAGE_KEY], (data) => {
      const raw = data?.[STORAGE_KEY];
      if (raw && typeof raw === "object") {
        resolve({
          byDay: raw.byDay && typeof raw.byDay === "object" ? raw.byDay : {},
          total: raw.total && typeof raw.total === "object" ? raw.total : {},
          updatedAt: raw.updatedAt || null
        });
      } else {
        resolve(emptyStats());
      }
    });
  });
}

async function writeRaw(value) {
  if (!globalThis.chrome?.storage?.local) return;
  return new Promise((resolve) => {
    chrome.storage.local.set({ [STORAGE_KEY]: value }, () => resolve());
  });
}

/** 自增一次某种埋点 */
export async function bumpUsage(kind, n = 1) {
  if (!USAGE_KINDS.includes(kind)) return;
  if (!Number.isFinite(n) || n <= 0) return;
  try {
    const stats = await readRaw();
    const day = todayKey();
    const today = (stats.byDay[day] = stats.byDay[day] || {});
    today[kind] = (Number(today[kind]) || 0) + n;
    stats.total[kind] = (Number(stats.total[kind]) || 0) + n;
    stats.updatedAt = new Date().toISOString();

    // 修剪：只保留最近 DAY_RETAIN 天
    const days = Object.keys(stats.byDay).sort();
    if (days.length > DAY_RETAIN) {
      const drop = days.slice(0, days.length - DAY_RETAIN);
      drop.forEach((d) => delete stats.byDay[d]);
    }
    await writeRaw(stats);
  } catch {
    // 静默失败：埋点不能影响主业务
  }
}

/**
 * 取一份"用于 dashboard 展示"的快照。
 * - today：今天各项次数
 * - last7days：最近 7 天合计（含今天）
 * - total：自启用以来的累计
 * - peakDay：byDay 中总和最高的一天 { date, total }
 */
export async function getUsageSnapshot() {
  const stats = await readRaw();
  const today = stats.byDay[todayKey()] || {};
  const today7 = collectRange(stats.byDay, 7);

  let peakDay = null;
  let peakSum = 0;
  Object.entries(stats.byDay).forEach(([date, counters]) => {
    const sum = USAGE_KINDS.reduce((s, k) => s + (Number(counters[k]) || 0), 0);
    if (sum > peakSum) {
      peakSum = sum;
      peakDay = { date, total: sum };
    }
  });

  return {
    today: fillKinds(today),
    last7days: fillKinds(today7),
    total: fillKinds(stats.total),
    peakDay,
    updatedAt: stats.updatedAt
  };
}

function collectRange(byDay, days) {
  const out = {};
  const now = new Date();
  for (let i = 0; i < days; i++) {
    const d = new Date(now);
    d.setDate(d.getDate() - i);
    const key = todayKey(d);
    const entry = byDay[key];
    if (!entry) continue;
    USAGE_KINDS.forEach((k) => {
      out[k] = (Number(out[k]) || 0) + (Number(entry[k]) || 0);
    });
  }
  return out;
}

function fillKinds(obj) {
  const out = {};
  USAGE_KINDS.forEach((k) => {
    out[k] = Number(obj?.[k]) || 0;
  });
  return out;
}

/** 主要给"重置"按钮 / 测试用 */
export async function resetUsage() {
  try {
    await writeRaw(emptyStats());
  } catch {
    // ignore
  }
}
