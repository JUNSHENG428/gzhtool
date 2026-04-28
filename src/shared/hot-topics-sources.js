export const HOT_TOPICS_CACHE_STORAGE_KEY = "hotTopicsCache";
export const HOT_TOPICS_CACHE_TTL_MS = 15 * 60 * 1000;

const DEFAULT_RSSHUB_BASE_URL = "https://rsshub.app";

// AI & Tech RSS feeds —— 这里是「内置 RSS 源」清单（meta.rss === true 时进入）。
// 中文聚合热榜（zhihu/weibo/juejin/B站等）由 hot-topics.js 走 NewsNow 主链路，
// NewsNow 失败时同样会复用本文件 export 的 fetchEndpointPayload + parseRssFeed
// 去拉对应的 RSSHub 路径作为兜底（meta.rsshub 字段，2026-04-25 起）。
// 历史野鸡接口（freejk/iyuns/xxapi/guiguiya）已在 2026-04 清理。
const TECHCRUNCH_RSS = "https://techcrunch.com/feed/";
const THE_VERGE_RSS = "https://www.theverge.com/rss/index.xml";
const ARXIV_AI_RSS = "https://rss.arxiv.org/rss/cs.AI";
const ARXIV_ML_RSS = "https://rss.arxiv.org/rss/cs.LG";
const MACHINE_LEARNING_MASTERY_RSS = "https://machinelearningmastery.com/feed/";
const TOWARDS_DATA_SCIENCE_RSS = "https://towardsdatascience.com/feed";
const IMPORT_AI_RSS = "https://importai.substack.com/feed";
const LEIPHONE_RSS = "https://www.leiphone.com/feed";
const HACKER_NEWS_RSS = "https://hnrss.org/newest?points=100";

export const HOT_TOPIC_SOURCES = [
  {
    id: "techcrunch",
    name: "TechCrunch",
    endpoint: TECHCRUNCH_RSS,
    parser: parseRssFeed
  },
  {
    id: "theverge",
    name: "The Verge",
    endpoint: THE_VERGE_RSS,
    parser: parseRssFeed
  },
  {
    id: "arxiv-ai",
    name: "arXiv AI",
    endpoint: ARXIV_AI_RSS,
    parser: parseRssFeed
  },
  {
    id: "arxiv-ml",
    name: "arXiv ML",
    endpoint: ARXIV_ML_RSS,
    parser: parseRssFeed
  },
  {
    id: "hackernews-rss",
    name: "Hacker News RSS",
    endpoint: HACKER_NEWS_RSS,
    parser: parseRssFeed
  },
  {
    id: "ml-mastery",
    name: "ML Mastery",
    endpoint: MACHINE_LEARNING_MASTERY_RSS,
    parser: parseRssFeed
  },
  {
    id: "towards-ds",
    name: "Towards Data Science",
    endpoint: TOWARDS_DATA_SCIENCE_RSS,
    parser: parseRssFeed
  },
  {
    id: "import-ai",
    name: "Import AI",
    endpoint: IMPORT_AI_RSS,
    parser: parseRssFeed,
    // Substack 经常对 datacenter IP 返 403，回退走 RSSHub 中转
    fallbacks: [{ endpoint: "/substack/newsletter/importai", parser: parseRssFeed }]
  },
  {
    id: "leiphone",
    name: "雷锋网",
    endpoint: LEIPHONE_RSS,
    parser: parseRssFeed
  }
];

export const HOT_TOPIC_SOURCE_MAP = Object.freeze(
  Object.fromEntries(HOT_TOPIC_SOURCES.map((source) => [source.id, source]))
);

export const DEFAULT_HOT_TOPIC_SOURCE_IDS = HOT_TOPIC_SOURCES.map((source) => source.id);

export function normalizeHotTopicsLimit(limit, fallback = 12) {
  const parsed = Number(limit);
  if (!Number.isFinite(parsed)) {
    return fallback;
  }
  return Math.max(1, Math.min(Math.round(parsed), 30));
}

export function resolveRsshubBaseUrl(settings = {}) {
  const configured = String(settings?.rsshubBaseUrl || "").trim();
  if (!configured) {
    return DEFAULT_RSSHUB_BASE_URL;
  }
  return configured.replace(/\/+$/, "");
}

export function buildHotTopicsCacheKey(sourceId, now = new Date()) {
  const date = now instanceof Date ? now : new Date(now);
  return `${sourceId}:${date.getFullYear()}${pad2(date.getMonth() + 1)}${pad2(date.getDate())}${pad2(date.getHours())}`;
}

export function getFreshHotTopicsCacheEntry(cacheStore, sourceId, now = new Date()) {
  if (!cacheStore || typeof cacheStore !== "object") {
    return null;
  }

  const cacheKey = buildHotTopicsCacheKey(sourceId, now);
  const entry = cacheStore[cacheKey];
  if (!entry || entry.sourceId !== sourceId || !Array.isArray(entry.items)) {
    return null;
  }

  const fetchedAtMs = Date.parse(entry.fetchedAt || "");
  if (!Number.isFinite(fetchedAtMs)) {
    return null;
  }

  if (now.getTime() - fetchedAtMs > HOT_TOPICS_CACHE_TTL_MS) {
    return null;
  }

  return entry;
}

export function pruneHotTopicsCache(cacheStore, now = new Date()) {
  const entries = Object.entries(cacheStore || {});
  const cutoffMs = now.getTime() - 24 * 60 * 60 * 1000;

  return Object.fromEntries(
    entries.filter(([, entry]) => {
      const fetchedAtMs = Date.parse(entry?.fetchedAt || "");
      return Number.isFinite(fetchedAtMs) && fetchedAtMs >= cutoffMs;
    })
  );
}

export async function fetchHotTopicSourceItems(sourceId, settings = {}, limit = 12) {
  const source = HOT_TOPIC_SOURCE_MAP[sourceId];
  if (!source) {
    throw new Error("未知热点来源。");
  }

  const candidates = buildSourceCandidates(source, settings);
  let lastError = null;

  for (const candidate of candidates) {
    try {
      const payload = await fetchEndpointPayload(candidate.url);
      const parsedItems = await candidate.parser(payload, source);
      const normalizedItems = dedupeItems(parsedItems)
        .map((item) => normalizeHotTopicItem(item, source))
        .filter(Boolean)
        .slice(0, normalizeHotTopicsLimit(limit));

      if (normalizedItems.length === 0) {
        throw new Error("该源暂无可展示的热点。");
      }

      return {
        sourceId: source.id,
        sourceName: source.name,
        items: normalizedItems,
        fetchedAt: new Date().toISOString(),
        endpoint: candidate.url
      };
    } catch (error) {
      lastError = error;
    }
  }

  throw lastError || new Error("该源暂时不可用。");
}

function buildSourceCandidates(source, settings) {
  const rsshubBaseUrl = resolveRsshubBaseUrl(settings);
  const candidates = [];
  const register = (endpoint, parser) => {
    if (!endpoint || typeof parser !== "function") {
      return;
    }
    const url = endpoint.startsWith("/")
      ? `${rsshubBaseUrl}${endpoint}`
      : endpoint;
    candidates.push({ url, parser });
  };

  register(source.endpoint, source.parser);
  for (const fallback of source.fallbacks || []) {
    register(fallback.endpoint, fallback.parser);
  }
  return candidates;
}

export async function fetchEndpointPayload(url) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 12000);

  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers: {
        // 一些 RSS 站点（如 Substack）会基于缺失 UA / Accept 直接返 403
        Accept: "application/json, application/rss+xml, application/xml, text/xml;q=0.9, */*;q=0.8",
        "User-Agent":
          "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36"
      }
    });
    const bodyText = await response.text();
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }
    return {
      url,
      bodyText,
      contentType: response.headers.get("content-type") || ""
    };
  } catch (error) {
    if (error?.name === "AbortError") {
      throw new Error("timeout");
    }
    throw error;
  } finally {
    clearTimeout(timeoutId);
  }
}

export function parseRssFeed(payload, source) {
  const body = String(payload?.bodyText || "");
  const isRss = /<rss[\s>]/i.test(body);
  const isAtom = /<feed[\s>]/i.test(body);
  if (!isRss && !isAtom) {
    throw new Error(`${source.name} RSS 返回格式异常。`);
  }

  // RSS 2.0 用 <item>，Atom 用 <entry>
  const itemPattern = isAtom
    ? /<entry\b[\s\S]*?<\/entry>/gi
    : /<item\b[\s\S]*?<\/item>/gi;
  const itemMatches = body.match(itemPattern) || [];
  if (itemMatches.length === 0) {
    throw new Error(`${source.name} RSS 暂无条目。`);
  }

  return itemMatches.map((itemXml) => {
    const title = cleanFeedText(readXmlTag(itemXml, "title"));
    // Atom 里 <link href="..."/> 是属性形式；RSS 是 <link>...</link>
    const url =
      cleanFeedText(readXmlTag(itemXml, "link")) ||
      readAtomLinkHref(itemXml) ||
      cleanFeedText(readXmlTag(itemXml, "guid")) ||
      cleanFeedText(readXmlTag(itemXml, "id"));
    const summary =
      cleanFeedText(readXmlTag(itemXml, "description")) ||
      cleanFeedText(readXmlTag(itemXml, "summary")) ||
      cleanFeedText(readXmlTag(itemXml, "content:encoded")) ||
      cleanFeedText(readXmlTag(itemXml, "content"));
    const publishedAt =
      normalizeDateValue(cleanFeedText(readXmlTag(itemXml, "pubDate"))) ||
      normalizeDateValue(cleanFeedText(readXmlTag(itemXml, "published"))) ||
      normalizeDateValue(cleanFeedText(readXmlTag(itemXml, "updated"))) ||
      normalizeDateValue(cleanFeedText(readXmlTag(itemXml, "dc:date")));

    return {
      title,
      url,
      hotScore: "",
      summary,
      source: source.name,
      publishedAt
    };
  });
}

// Atom 的 link 标签是 <link rel="alternate" href="..."/>，没有闭标签
function readAtomLinkHref(xml) {
  const match = xml.match(/<link\b[^>]*\bhref=["']([^"']+)["'][^>]*\/?\s*>/i);
  return match?.[1] || "";
}

function normalizeHotTopicItem(item, source) {
  const title = trimText(item?.title || "", 120);
  const url = String(item?.url || "").trim();
  if (!title || !url) {
    return null;
  }

  return {
    title,
    url,
    hotScore: trimText(String(item?.hotScore || "").trim(), 40),
    summary: trimText(String(item?.summary || "").trim(), 180),
    source: item?.source || source.name,
    publishedAt: normalizeDateValue(item?.publishedAt) || ""
  };
}

function dedupeItems(items) {
  const seen = new Set();
  const result = [];

  for (const item of items || []) {
    const signature = `${String(item?.url || "").trim()}::${String(item?.title || "").trim()}`;
    if (!item || seen.has(signature)) {
      continue;
    }
    seen.add(signature);
    result.push(item);
  }

  return result;
}

function readXmlTag(xml, tagName) {
  const escapedTag = tagName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = xml.match(
    new RegExp(`<${escapedTag}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${escapedTag}>`, "i")
  );
  return match?.[1] || "";
}

function cleanFeedText(value) {
  return trimText(
    decodeHtmlEntities(stripHtml(String(value || "").replace(/<!\[CDATA\[|\]\]>/g, ""))).replace(/\s+/g, " ").trim(),
    240
  );
}

function stripHtml(value) {
  return String(value || "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/p>/gi, "\n")
    .replace(/<[^>]+>/g, " ");
}

function decodeHtmlEntities(value) {
  return String(value || "")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, " ");
}

function normalizeDateValue(value) {
  if (!value) {
    return "";
  }

  if (typeof value === "number" && Number.isFinite(value)) {
    const asMillis = value > 1e12 ? value : value * 1000;
    return new Date(asMillis).toISOString();
  }

  const text = String(value).trim();
  if (!text) {
    return "";
  }

  const millis = Date.parse(text);
  return Number.isFinite(millis) ? new Date(millis).toISOString() : "";
}

function trimText(value, maxLength) {
  const text = String(value || "").replace(/\s+/g, " ").trim();
  if (!text || text.length <= maxLength) {
    return text;
  }
  return `${text.slice(0, Math.max(0, maxLength - 1))}…`;
}

function pad2(value) {
  return String(value).padStart(2, "0");
}
