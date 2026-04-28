/**
 * 热点接口的「持久缓存 + 后端健康度」
 *
 * 解决两个痛点：
 *   1) Chrome MV3 service worker 30s 不活动会被 evict，原本的内存 Map 缓存
 *      会一并丢失，导致每次打开热点页都要现拉，公共服务很容易把这个流量
 *      认成爬虫直接限流；
 *   2) 公共聚合（NewsNow demo / RSSHub demo）一旦挂掉，原本的代码会一直
 *      死命请求，每次都等到 8s 超时才报错，体验灾难。
 *
 * 缓存：写到 chrome.storage.local，按 sourceId 分键 ht:cache:<sourceId>，
 *      默认 TTL 12 分钟（与现有内存缓存的 3 分钟相比拉长，但配合后台
 *      预热足够新鲜）。
 *
 * 健康度：按 base URL（origin 级别）做失败计数与冷却。
 *      - 连续失败 ≥ FAIL_THRESHOLD 次后进入冷却 COOLDOWN_MS，期间直接跳过；
 *      - 任意一次成功立即清零。
 *      - 健康度也写到 chrome.storage.local，跨 SW 重启保留，所以不会因为
 *        SW 重启失忆又去打那个挂了的服务。
 *
 * Node / 测试环境没有 chrome.storage 时退化到进程内 Map（保证 unit test 能跑）。
 */

const CACHE_PREFIX = "ht:cache:";
const HEALTH_KEY = "ht:health";

export const HOT_CACHE_TTL_MS = 12 * 60 * 1000;
export const FAIL_THRESHOLD = 3;
export const COOLDOWN_MS = 10 * 60 * 1000;

const _memoryCache = new Map();
const _memoryHealth = new Map();

function hasChromeStorage() {
  return (
    typeof chrome !== "undefined" &&
    chrome?.storage?.local &&
    typeof chrome.storage.local.get === "function"
  );
}

async function storageGet(key) {
  if (!hasChromeStorage()) return undefined;
  return new Promise((resolve) => {
    try {
      chrome.storage.local.get(key, (result) => {
        if (chrome.runtime?.lastError) {
          resolve(undefined);
        } else {
          resolve(result?.[key]);
        }
      });
    } catch {
      resolve(undefined);
    }
  });
}

async function storageSet(key, value) {
  if (!hasChromeStorage()) return;
  return new Promise((resolve) => {
    try {
      chrome.storage.local.set({ [key]: value }, () => resolve());
    } catch {
      resolve();
    }
  });
}

async function storageRemove(keys) {
  if (!hasChromeStorage()) return;
  return new Promise((resolve) => {
    try {
      chrome.storage.local.remove(keys, () => resolve());
    } catch {
      resolve();
    }
  });
}

// ── Payload cache ──

export async function readCachedPayload(sourceId) {
  if (!sourceId) return null;
  const memHit = _memoryCache.get(sourceId);
  if (memHit && Date.now() - memHit.timestamp < HOT_CACHE_TTL_MS) {
    return memHit.payload;
  }

  const stored = await storageGet(CACHE_PREFIX + sourceId);
  if (stored && Date.now() - stored.timestamp < HOT_CACHE_TTL_MS) {
    _memoryCache.set(sourceId, stored);
    return stored.payload;
  }
  return null;
}

export async function writeCachedPayload(sourceId, payload) {
  if (!sourceId || !payload) return;
  const entry = { timestamp: Date.now(), payload };
  _memoryCache.set(sourceId, entry);
  await storageSet(CACHE_PREFIX + sourceId, entry);
}

export async function clearCachedPayload(sourceId) {
  if (sourceId) {
    _memoryCache.delete(sourceId);
    await storageRemove(CACHE_PREFIX + sourceId);
    return;
  }
  _memoryCache.clear();
  // 不清健康度，挂了的服务还是挂着；只清 payload
  if (hasChromeStorage()) {
    await new Promise((resolve) => {
      try {
        chrome.storage.local.get(null, (all) => {
          const keys = Object.keys(all || {}).filter((k) => k.startsWith(CACHE_PREFIX));
          if (keys.length === 0) {
            resolve();
            return;
          }
          chrome.storage.local.remove(keys, () => resolve());
        });
      } catch {
        resolve();
      }
    });
  }
}

// ── Backend health ──

function originOf(url) {
  if (!url) return "";
  try {
    const u = new URL(url, "https://placeholder.local");
    return `${u.protocol}//${u.host}`;
  } catch {
    return String(url).slice(0, 80);
  }
}

async function loadHealthMap() {
  // 先看内存。chrome.storage.local 异步访问代价高，每次都查会拖慢热路径。
  if (_memoryHealth.size > 0) return _memoryHealth;
  const stored = (await storageGet(HEALTH_KEY)) || {};
  for (const [origin, info] of Object.entries(stored)) {
    if (info && typeof info === "object") _memoryHealth.set(origin, info);
  }
  return _memoryHealth;
}

async function persistHealthMap() {
  if (!hasChromeStorage()) return;
  const obj = {};
  for (const [k, v] of _memoryHealth.entries()) obj[k] = v;
  await storageSet(HEALTH_KEY, obj);
}

/**
 * @returns {boolean} true 表示该后端正在冷却，调用方应跳过它
 */
export async function isBaseCoolingDown(url) {
  const origin = originOf(url);
  if (!origin) return false;
  const map = await loadHealthMap();
  const info = map.get(origin);
  if (!info) return false;
  if ((info.failures || 0) < FAIL_THRESHOLD) return false;
  const since = Number(info.coolingSince) || 0;
  if (!since) return false;
  return Date.now() - since < COOLDOWN_MS;
}

export async function recordBaseFailure(url, reason = "") {
  const origin = originOf(url);
  if (!origin) return;
  const map = await loadHealthMap();
  const info = map.get(origin) || { failures: 0, lastReason: "" };
  info.failures = (info.failures || 0) + 1;
  info.lastReason = String(reason || "").slice(0, 120);
  info.lastFailureAt = Date.now();
  if (info.failures >= FAIL_THRESHOLD && !info.coolingSince) {
    info.coolingSince = Date.now();
  }
  map.set(origin, info);
  await persistHealthMap();
}

export async function recordBaseSuccess(url) {
  const origin = originOf(url);
  if (!origin) return;
  const map = await loadHealthMap();
  if (!map.has(origin)) return;
  map.delete(origin);
  await persistHealthMap();
}

export async function getHealthSnapshot() {
  const map = await loadHealthMap();
  const out = {};
  for (const [k, v] of map.entries()) {
    out[k] = {
      failures: v.failures || 0,
      cooling: (v.failures || 0) >= FAIL_THRESHOLD && Number(v.coolingSince) > 0,
      coolingSecondsLeft: v.coolingSince
        ? Math.max(0, Math.round((COOLDOWN_MS - (Date.now() - v.coolingSince)) / 1000))
        : 0,
      lastReason: v.lastReason || "",
      lastFailureAt: v.lastFailureAt || 0
    };
  }
  return out;
}

// 测试用：完全清空内存与持久存储
export async function _resetForTest() {
  _memoryCache.clear();
  _memoryHealth.clear();
  if (!hasChromeStorage()) return;
  await new Promise((resolve) => {
    chrome.storage.local.get(null, (all) => {
      const keys = Object.keys(all || {}).filter(
        (k) => k.startsWith(CACHE_PREFIX) || k === HEALTH_KEY
      );
      if (keys.length === 0) {
        resolve();
        return;
      }
      chrome.storage.local.remove(keys, () => resolve());
    });
  });
}
