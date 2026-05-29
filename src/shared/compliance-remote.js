/**
 * src/shared/compliance-remote.js · 远程合规词库拉取 + 缓存
 *
 * GET {apiBase}/api/compliance/rules 下发版本化词库 → 缓存到 chrome.storage.local
 * → setRemoteComplianceRules 注入检测器，与内置库合并。
 *
 * 设计：
 *   - 扫描全程本地，这里只拉「词库」不上传任何正文（隐私）。
 *   - 24h 节流，避免每次启动都打网络。
 *   - 失败静默：拉不到就用缓存 / 内置库，绝不阻断主链路。
 *   - SW 与页面各自调一次 applyCachedComplianceRules（模块单例分 realm）。
 */

import { STORAGE_KEYS } from "./defaults.js";
import { storageGet, storageSet } from "./storage.js";
import { getApiBase } from "./license.js";
import { setRemoteComplianceRules } from "./compliance-checker.js";

const REFRESH_THROTTLE_MS = 24 * 60 * 60 * 1000; // 24h

/** 读缓存的远程词库并注入检测器（无网络）。返回缓存对象或 null。 */
export async function applyCachedComplianceRules() {
  try {
    const data = await storageGet([STORAGE_KEYS.complianceRules]);
    const cached = data[STORAGE_KEYS.complianceRules];
    if (cached && (Array.isArray(cached.literal) || Array.isArray(cached.regex))) {
      setRemoteComplianceRules(cached);
      return cached;
    }
  } catch (_) {
    // ignore
  }
  return null;
}

/**
 * 从远程拉取词库（带 24h 节流）。version 更新时覆盖缓存并注入检测器。
 * @param {object} [opts]
 * @param {boolean} [opts.force] 跳过节流强制拉取
 */
export async function refreshRemoteComplianceRules({ force = false } = {}) {
  let cached = null;
  try {
    const data = await storageGet([STORAGE_KEYS.complianceRules]);
    cached = data[STORAGE_KEYS.complianceRules] || null;
  } catch (_) {
    cached = null;
  }

  const now = Date.now();
  if (!force && cached && now - Number(cached.fetchedAt || 0) < REFRESH_THROTTLE_MS) {
    // 节流期内：直接用缓存
    if (cached) setRemoteComplianceRules(cached);
    return cached;
  }

  try {
    const base = await getApiBase();
    const resp = await fetch(`${base}/api/compliance/rules`, { method: "GET" });
    if (!resp.ok) throw new Error(`status ${resp.status}`);
    const remote = await resp.json();
    if (!remote || typeof remote.version !== "number") throw new Error("bad payload");

    // 只在 version 更新时覆盖（避免回滚 / 脏写）
    const cachedVersion = Number(cached?.version || 0);
    if (remote.version >= cachedVersion) {
      const next = {
        version: remote.version,
        updatedAt: remote.updatedAt || "",
        literal: Array.isArray(remote.literal) ? remote.literal : [],
        regex: Array.isArray(remote.regex) ? remote.regex : [],
        fetchedAt: now
      };
      await storageSet({ [STORAGE_KEYS.complianceRules]: next });
      setRemoteComplianceRules(next);
      return next;
    }
    // 远程版本更旧（异常）：保留缓存
    if (cached) setRemoteComplianceRules(cached);
    return cached;
  } catch (_) {
    // 网络失败：退回缓存（若有）
    if (cached) setRemoteComplianceRules(cached);
    return cached;
  }
}
