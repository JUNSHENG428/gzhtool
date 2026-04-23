/**
 * Agent 跑批主循环（运行在 service worker 上下文中）。
 *
 * 流程：
 *   1. 读凭据状态：缺登录的平台过滤掉，并通过 onProgress 回调出去
 *   2. 控制并发跑各 adapter，request 之间随机抖动
 *   3. 合并 hits → 关键词二次过滤 + 去重 + 热度排序
 *   4. 取 finalLimit
 *   5. 调用一次 chat completion 生成 brief（可关闭）
 *   6. 返回 { hits, brief, errors }
 */

import { getSettings } from "../storage.js";
import { getPlatformCookieStatuses } from "./credentials.js";
import {
  PLATFORM_ADAPTERS,
  ADAPTER_IDS,
  runAdapterSearch
} from "./platform-adapters/index.js";
import { buildBriefMessages, normalizeBrief } from "./agent-prompts.js";
import { extractChatContent } from "../ai.js";

export const DEFAULT_AGENT_RUN_OPTIONS = Object.freeze({
  platforms: [...ADAPTER_IDS],
  perPlatformLimit: 8,
  finalLimit: 10,
  concurrency: 2,
  jitterMinMs: 800,
  jitterMaxMs: 1500,
  enableBrief: true,
  extraKeywords: "",
  excludeKeywords: ""
});

/**
 * 主入口。由 service worker 在收到 RUN_AGENT_TASK 时调用。
 *
 * @param {object} params
 * @param {string} params.query
 * @param {Partial<typeof DEFAULT_AGENT_RUN_OPTIONS>} params.options
 * @param {(progress: object) => void} onProgress
 */
export async function runAgentTask(params, onProgress = () => {}) {
  const query = String(params?.query || "").trim();
  if (!query) {
    return {
      ok: false,
      message: "请输入主题关键词",
      hits: [],
      brief: null,
      errors: []
    };
  }

  const options = { ...DEFAULT_AGENT_RUN_OPTIONS, ...(params?.options || {}) };
  const platforms = (options.platforms || ADAPTER_IDS).filter((id) => PLATFORM_ADAPTERS[id]);
  if (platforms.length === 0) {
    return {
      ok: false,
      message: "未选择任何有效平台",
      hits: [],
      brief: null,
      errors: []
    };
  }

  const errors = [];
  const skipped = [];

  emit(onProgress, {
    phase: "credentials",
    message: "检查平台登录状态…"
  });

  const statuses = await getPlatformCookieStatuses(platforms);
  const statusByPlatform = Object.fromEntries(statuses.map((s) => [s.platformId, s]));
  const usablePlatforms = platforms.filter((id) => statusByPlatform[id]?.loggedIn);
  const blockedPlatforms = platforms.filter((id) => !statusByPlatform[id]?.loggedIn);

  blockedPlatforms.forEach((id) => {
    const status = statusByPlatform[id];
    skipped.push({
      platformId: id,
      name: status?.name || id,
      reason: "未登录",
      loginUrl: status?.loginUrl || ""
    });
  });

  emit(onProgress, {
    phase: "credentials-done",
    message:
      blockedPlatforms.length > 0
        ? `跳过未登录平台 ${blockedPlatforms.length} 个`
        : "所有目标平台已登录",
    skipped,
    statuses
  });

  if (usablePlatforms.length === 0) {
    return {
      ok: false,
      message: "选中的平台都未登录，请先在浏览器登录后再试",
      hits: [],
      brief: null,
      errors,
      skipped
    };
  }

  emit(onProgress, {
    phase: "search-start",
    message: `开始抓取 ${usablePlatforms.length} 个平台…`,
    platforms: usablePlatforms
  });

  const allHits = [];
  await runWithConcurrency(usablePlatforms, options.concurrency, async (platformId) => {
    const adapter = PLATFORM_ADAPTERS[platformId];
    emit(onProgress, {
      phase: "platform-start",
      platformId,
      message: `${adapter.name}：搜索中…`
    });

    const result = await runAdapterSearch(adapter, query, {
      perPlatformLimit: options.perPlatformLimit,
      jitterMinMs: options.jitterMinMs,
      jitterMaxMs: options.jitterMaxMs
    });

    if (!result.ok) {
      errors.push({ platformId, message: result.message || "未知错误" });
      emit(onProgress, {
        phase: "platform-error",
        platformId,
        message: result.message
      });
      return;
    }

    allHits.push(...result.items);
    emit(onProgress, {
      phase: "platform-done",
      platformId,
      message: `${adapter.name}：拿到 ${result.items.length} 条`,
      count: result.items.length
    });
  });

  const filteredHits = applyRulesFilter(allHits, {
    extraKeywords: options.extraKeywords,
    excludeKeywords: options.excludeKeywords
  });

  const dedupedHits = dedupeHits(filteredHits);
  // 综合评分排序：0.5 × relevance + 0.4 × hot + 0.1 × recency
  // - relevance：query / 包含关键词在 title+summary 上的命中度（标题命中权重更高）
  // - hot：min-max 归一化的 hotValue（粗暴但与平台无关）
  // - recency：距今 30 天内线性衰减
  // 这样能解决「hot 但不切题」硬伤，同时让有时新性的热帖更靠前。
  const includeKeywords = parseKeywords(options.extraKeywords);
  const scoredHits = scoreHits(dedupedHits, query, includeKeywords);
  const topHits = scoredHits.slice(0, Math.max(1, Math.min(options.finalLimit, 30)));

  emit(onProgress, {
    phase: "filter-done",
    message: `规则筛选后保留 ${topHits.length} 条`,
    total: dedupedHits.length
  });

  let brief = null;
  if (options.enableBrief && topHits.length > 0) {
    emit(onProgress, { phase: "brief-start", message: "AI 生成选题总结…" });
    try {
      brief = await generateBrief({ query, hits: topHits });
      emit(onProgress, { phase: "brief-done", message: "选题总结生成完成" });
    } catch (error) {
      errors.push({
        platformId: "ai",
        message: `AI 总结失败：${error?.message || "未知错误"}`
      });
      emit(onProgress, {
        phase: "brief-error",
        message: error?.message || "AI 总结失败"
      });
    }
  }

  return {
    ok: true,
    hits: topHits,
    brief,
    errors,
    skipped,
    summary: {
      requested: platforms.length,
      attempted: usablePlatforms.length,
      raw: allHits.length,
      kept: topHits.length
    }
  };
}

async function generateBrief({ query, hits }) {
  const settings = await getSettings();
  if (!settings?.apiKey?.trim() || !settings?.apiBaseUrl?.trim()) {
    throw new Error("AI 接口未配置");
  }
  const messages = buildBriefMessages({ query, hits });
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
    const msg =
      payload?.error?.message || payload?.message || `状态码 ${response.status}`;
    throw new Error(msg);
  }
  const content = extractChatContent(payload);
  if (!content) throw new Error("模型返回为空");
  const json = extractJson(content);
  return normalizeBrief(json);
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

function applyRulesFilter(hits, { extraKeywords, excludeKeywords }) {
  const includes = parseKeywords(extraKeywords);
  const excludes = parseKeywords(excludeKeywords);
  if (includes.length === 0 && excludes.length === 0) return hits.slice();

  return hits.filter((hit) => {
    const haystack = `${hit.title}\n${hit.summary}`.toLowerCase();
    if (excludes.some((kw) => haystack.includes(kw))) return false;
    if (includes.length > 0 && !includes.some((kw) => haystack.includes(kw))) return false;
    return true;
  });
}

function parseKeywords(input) {
  return String(input || "")
    .split(/[,;，；\n\s]+/)
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
}

function dedupeHits(hits) {
  const map = new Map();
  for (const hit of hits) {
    const key = normalizeTitle(hit.title);
    if (!key) continue;
    const existing = map.get(key);
    if (!existing || hit.hotValue > existing.hotValue) {
      map.set(key, hit);
    }
  }
  return Array.from(map.values());
}

function normalizeTitle(text) {
  return String(text || "")
    .toLowerCase()
    .replace(/\s+/g, "")
    .replace(/[^\p{L}\p{N}]+/gu, "")
    .slice(0, 64);
}

/**
 * 综合评分。会给每条 hit 写入 `relevance` 字段（0-1），方便 UI 显示徽章。
 *
 * 权重：0.5 × relevance + 0.4 × hot + 0.1 × recency
 *
 * @param {Array} hits
 * @param {string} query
 * @param {string[]} includeKeywords  用户填的「包含关键词」，作为 relevance 的次要信号
 */
export function scoreHits(hits, query, includeKeywords = []) {
  const queryTerms = extractQueryTerms(query);
  const allTerms = Array.from(new Set([...queryTerms, ...includeKeywords].filter(Boolean)));

  // hot 归一化：用本批次最大值做 max-min（避免不同平台的 hot 数量级不可比）
  const maxHot = hits.reduce((acc, h) => Math.max(acc, Number(h.hotValue) || 0), 0);
  const now = Date.now();

  const enriched = hits.map((hit) => {
    const relevance = computeRelevance(hit, queryTerms, allTerms);
    const hot = maxHot > 0 ? Math.min(1, (Number(hit.hotValue) || 0) / maxHot) : 0;
    const recency = computeRecency(hit.publishedAt, now);
    const score = 0.5 * relevance + 0.4 * hot + 0.1 * recency;
    return { ...hit, relevance, _score: score };
  });

  return enriched.sort((a, b) => {
    if (b._score !== a._score) return b._score - a._score;
    if ((b.hotValue || 0) !== (a.hotValue || 0)) return (b.hotValue || 0) - (a.hotValue || 0);
    return (b.title || "").length - (a.title || "").length;
  });
}

/**
 * 把 query 拆成若干"词项"。中文走简单的字符 n-gram + 直接拆词（按空格 / 标点）；
 * 英文走小写空格拆词。返回值已去重、过滤短噪声词。
 */
function extractQueryTerms(query) {
  const raw = String(query || "")
    .toLowerCase()
    .trim();
  if (!raw) return [];
  const parts = raw
    .split(/[\s,;，；、|/\\.\-_+]+/u)
    .map((s) => s.trim())
    .filter(Boolean);

  const terms = new Set();
  for (const part of parts) {
    // 英文 / 数字短词：长度 >= 2 才有意义
    if (/^[a-z0-9]+$/i.test(part)) {
      if (part.length >= 2) terms.add(part);
      continue;
    }
    // 中文/混合：直接加整词，再补 2-gram（更宽松的部分命中）
    if (part.length >= 2) terms.add(part);
    if (part.length >= 3) {
      for (let i = 0; i < part.length - 1; i++) {
        terms.add(part.slice(i, i + 2));
      }
    }
  }
  return Array.from(terms);
}

/**
 * relevance ∈ [0, 1]
 *   - 主词项在 title 命中：每个 +0.35（最多累加到 0.7）
 *   - 主词项在 summary 命中：每个 +0.10（最多累加到 0.2）
 *   - 包含关键词命中：每个 +0.05（最多累加到 0.1）
 *   - 全无命中：兜底 0
 */
function computeRelevance(hit, queryTerms, allTerms) {
  if (queryTerms.length === 0) return 0;
  const title = String(hit.title || "").toLowerCase();
  const summary = String(hit.summary || "").toLowerCase();

  let titleHits = 0;
  let summaryHits = 0;
  for (const term of queryTerms) {
    if (term && title.includes(term)) titleHits += 1;
    else if (term && summary.includes(term)) summaryHits += 1;
  }

  let score = Math.min(0.7, titleHits * 0.35) + Math.min(0.2, summaryHits * 0.1);

  const extraTerms = allTerms.filter((t) => !queryTerms.includes(t));
  if (extraTerms.length > 0) {
    let extra = 0;
    for (const term of extraTerms) {
      if (title.includes(term) || summary.includes(term)) extra += 0.05;
    }
    score += Math.min(0.1, extra);
  }

  return Math.max(0, Math.min(1, score));
}

/**
 * recency ∈ [0, 1]：30 天内线性，超过 30 天给 0；缺时间戳一律 0.3（中性）。
 */
function computeRecency(publishedAt, nowMs) {
  if (!publishedAt) return 0.3;
  const t = Date.parse(publishedAt);
  if (!Number.isFinite(t)) return 0.3;
  const ageDays = (nowMs - t) / 86400000;
  if (ageDays <= 0) return 1;
  if (ageDays >= 30) return 0;
  return 1 - ageDays / 30;
}

async function runWithConcurrency(items, concurrency, worker) {
  const limit = Math.max(1, Math.min(Number(concurrency) || 1, 5));
  const queue = items.slice();
  const runners = Array.from({ length: Math.min(limit, queue.length) }, async () => {
    while (queue.length > 0) {
      const item = queue.shift();
      try {
        await worker(item);
      } catch (error) {
        console.warn("[agent] worker failed:", item, error);
      }
    }
  });
  await Promise.all(runners);
}

function emit(onProgress, payload) {
  try {
    onProgress?.({ ...payload, ts: Date.now() });
  } catch {
    /* ignore */
  }
}
