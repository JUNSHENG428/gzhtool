/**
 * Agent 偏好与任务历史持久化（chrome.storage.local）
 * ----------------------------------------------------------------
 * 两块数据：
 *   1. agentRunConfig          - 跑批默认偏好（默认平台、抓取上限、并发等）
 *   2. agentTaskHistory[]      - 最近任务（最多 20 条 + 钉选不计数）
 *
 * 设计取舍：
 *   - 历史走滚动覆盖（FIFO 20 条），但 isPinned 的不进入"被挤出"队列
 *   - 单条体积不要太大：hits 只存命中元数据（title/url/platformId/hotValue/relevance），
 *     不存 brief.titles/takeaways 之外的大段文本，避免 storage.local 4MB 上限被吃掉
 */

import { ADAPTER_IDS } from "./platform-adapters/index.js";

const KEY_CONFIG = "agentRunConfig";
const KEY_HISTORY = "agentTaskHistory";

const DEFAULT_CONFIG = {
  defaultPlatforms: [...ADAPTER_IDS],
  perPlatformLimit: 8,
  finalLimit: 10,
  concurrency: 2,
  jitterMinMs: 800,
  jitterMaxMs: 1500,
  enableBrief: true,
  showAnglesAsideHits: true
};

export const DEFAULT_AGENT_CONFIG = DEFAULT_CONFIG;

export const AGENT_HISTORY_MAX = 20;

const ok = () => Boolean(globalThis.chrome?.storage?.local);

/* ============== 1. config ============== */

export async function getAgentConfig() {
  if (!ok()) return { ...DEFAULT_CONFIG };
  const obj = await chrome.storage.local.get(KEY_CONFIG);
  return mergeDefaults(obj?.[KEY_CONFIG] || {});
}

export async function setAgentConfig(partial) {
  if (!ok()) return DEFAULT_CONFIG;
  const current = await getAgentConfig();
  const next = mergeDefaults({ ...current, ...partial });
  await chrome.storage.local.set({ [KEY_CONFIG]: next });
  return next;
}

function mergeDefaults(input) {
  const out = { ...DEFAULT_CONFIG, ...(input || {}) };
  if (!Array.isArray(out.defaultPlatforms) || out.defaultPlatforms.length === 0) {
    out.defaultPlatforms = [...DEFAULT_CONFIG.defaultPlatforms];
  } else {
    out.defaultPlatforms = Array.from(
      new Set(out.defaultPlatforms.map((s) => String(s)).filter((id) => ADAPTER_IDS.includes(id)))
    );
    if (out.defaultPlatforms.length === 0) {
      out.defaultPlatforms = [...DEFAULT_CONFIG.defaultPlatforms];
    }
  }
  out.perPlatformLimit = clampInt(out.perPlatformLimit, 1, 30, DEFAULT_CONFIG.perPlatformLimit);
  out.finalLimit = clampInt(out.finalLimit, 1, 30, DEFAULT_CONFIG.finalLimit);
  out.concurrency = clampInt(out.concurrency, 1, 4, DEFAULT_CONFIG.concurrency);
  out.jitterMinMs = clampInt(out.jitterMinMs, 0, 8000, DEFAULT_CONFIG.jitterMinMs);
  out.jitterMaxMs = clampInt(out.jitterMaxMs, out.jitterMinMs, 12000, Math.max(out.jitterMinMs, DEFAULT_CONFIG.jitterMaxMs));
  out.enableBrief = Boolean(out.enableBrief);
  out.showAnglesAsideHits = Boolean(out.showAnglesAsideHits);
  return out;
}

function clampInt(value, min, max, fallback) {
  const n = Math.round(Number(value));
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, n));
}

/* ============== 2. task history ============== */

/**
 * 列出历史（钉选优先，其余按 createdAt 倒序）。
 */
export async function listAgentTasks() {
  if (!ok()) return [];
  const obj = await chrome.storage.local.get(KEY_HISTORY);
  const list = Array.isArray(obj?.[KEY_HISTORY]) ? obj[KEY_HISTORY] : [];
  return sortTasks(list);
}

export async function getAgentTask(id) {
  if (!ok() || !id) return null;
  const list = await listAgentTasks();
  return list.find((t) => t.id === id) || null;
}

/**
 * 写入一条新任务。会自动裁剪到 20 条（钉选的不计数）。
 *
 * @param {object} task
 * @param {string} task.query
 * @param {object} [task.options]   原始 options（用于 re-run 还原）
 * @param {Array} [task.hits]       命中数组（会被裁剪只存关键字段）
 * @param {object|null} [task.brief]
 * @param {object|null} [task.summary]
 * @param {Array} [task.errors]
 * @param {Array} [task.skipped]
 * @returns {Promise<object>} 完整任务对象
 */
export async function addAgentTask(task) {
  if (!ok()) return null;
  const id = task?.id || generateId();
  const slim = slimTask({ ...task, id });
  const list = await loadRawList();
  const next = [slim, ...list.filter((t) => t.id !== id)];
  await saveTrimmed(next);
  return slim;
}

export async function pinAgentTask(id, pinned) {
  if (!ok() || !id) return false;
  const list = await loadRawList();
  const next = list.map((t) =>
    t.id === id ? { ...t, isPinned: Boolean(pinned), pinnedAt: pinned ? Date.now() : null } : t
  );
  await chrome.storage.local.set({ [KEY_HISTORY]: next });
  return true;
}

export async function removeAgentTask(id) {
  if (!ok() || !id) return false;
  const list = await loadRawList();
  await chrome.storage.local.set({ [KEY_HISTORY]: list.filter((t) => t.id !== id) });
  return true;
}

export async function clearAgentTasks({ keepPinned = true } = {}) {
  if (!ok()) return;
  if (!keepPinned) {
    await chrome.storage.local.remove(KEY_HISTORY);
    return;
  }
  const list = await loadRawList();
  await chrome.storage.local.set({ [KEY_HISTORY]: list.filter((t) => t.isPinned) });
}

async function loadRawList() {
  const obj = await chrome.storage.local.get(KEY_HISTORY);
  return Array.isArray(obj?.[KEY_HISTORY]) ? obj[KEY_HISTORY] : [];
}

/**
 * 排序：钉选 → pinnedAt 倒序；其余 → createdAt 倒序
 */
function sortTasks(list) {
  return list.slice().sort((a, b) => {
    if (a.isPinned !== b.isPinned) return a.isPinned ? -1 : 1;
    if (a.isPinned && b.isPinned) {
      return (b.pinnedAt || 0) - (a.pinnedAt || 0);
    }
    return (b.createdAt || 0) - (a.createdAt || 0);
  });
}

/**
 * 滚动覆盖：钉选的全保留，其余只留前 AGENT_HISTORY_MAX 条。
 */
async function saveTrimmed(list) {
  const pinned = list.filter((t) => t.isPinned);
  const others = list
    .filter((t) => !t.isPinned)
    .sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0))
    .slice(0, AGENT_HISTORY_MAX);
  await chrome.storage.local.set({ [KEY_HISTORY]: [...pinned, ...others] });
}

/**
 * 把任务剪薄：hits 只留关键字段，brief 整体保留（一般 < 2KB），
 * 避免单条任务超过 ~50KB。
 */
function slimTask(task) {
  const hits = Array.isArray(task?.hits) ? task.hits : [];
  return {
    id: task.id,
    query: String(task.query || "").trim(),
    options: cloneOptions(task.options),
    createdAt: task.createdAt || Date.now(),
    isPinned: Boolean(task.isPinned),
    pinnedAt: task.pinnedAt || null,
    hits: hits.slice(0, 30).map((hit) => ({
      platformId: hit.platformId,
      platformName: hit.platformName,
      title: hit.title,
      url: hit.url,
      author: hit.author || "",
      hotScore: hit.hotScore || "",
      hotValue: Number(hit.hotValue) || 0,
      relevance: typeof hit.relevance === "number" ? hit.relevance : null,
      summary: cutString(hit.summary, 240),
      publishedAt: hit.publishedAt || ""
    })),
    brief: task.brief || null,
    summary: task.summary || null,
    errors: Array.isArray(task.errors) ? task.errors : [],
    skipped: Array.isArray(task.skipped) ? task.skipped : []
  };
}

function cloneOptions(options) {
  if (!options || typeof options !== "object") return {};
  return {
    platforms: Array.isArray(options.platforms) ? [...options.platforms] : [],
    perPlatformLimit: Number(options.perPlatformLimit) || undefined,
    finalLimit: Number(options.finalLimit) || undefined,
    concurrency: Number(options.concurrency) || undefined,
    extraKeywords: String(options.extraKeywords || ""),
    excludeKeywords: String(options.excludeKeywords || ""),
    enableBrief: Boolean(options.enableBrief)
  };
}

function cutString(text, max) {
  const s = String(text || "").replace(/\s+/g, " ").trim();
  return s.length > max ? `${s.slice(0, max)}…` : s;
}

function generateId() {
  if (typeof crypto?.randomUUID === "function") return crypto.randomUUID();
  return `t-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}
