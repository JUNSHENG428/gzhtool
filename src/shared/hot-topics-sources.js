export const HOT_TOPICS_CACHE_STORAGE_KEY = "hotTopicsCache";
export const HOT_TOPICS_CACHE_TTL_MS = 15 * 60 * 1000;

const DEFAULT_RSSHUB_BASE_URL = "https://rsshub.app";
const TOPHUB_HOT_ENDPOINT = "https://open.tophub.today/hot?limit=500";
const FREEJK_ZHIHU_ENDPOINT = "https://api.freejk.com/shuju/hotlist/zhihu";
const GUIGUI_WEIBO_ENDPOINT = "https://api.guiguiya.com/api/hotlist?type=weibo";
const GUIGUI_JUEJIN_ENDPOINT = "https://api.guiguiya.com/api/hotlist?type=juejin";
const IYUNS_WEIBO_ENDPOINT = "https://api.iyuns.com/api/weibohot";
const XXAPI_WEIBO_ENDPOINT = "https://v2.xxapi.cn/api/weibohot";
const KR36_ENDPOINT = "https://api.iyuns.com/api/hot36kr";
const KR36_BACKUP_ENDPOINT = "https://v2.xxapi.cn/api/hot36kr";

// AI & Tech RSS feeds
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
    id: "zhihu",
    name: "知乎热榜",
    endpoint: FREEJK_ZHIHU_ENDPOINT,
    parser: parseFreeJkZhihu,
    fallbacks: [{ endpoint: TOPHUB_HOT_ENDPOINT, parser: parseTophubZhihu }]
  },
  {
    id: "weibo",
    name: "微博热搜",
    endpoint: IYUNS_WEIBO_ENDPOINT,
    parser: parseIyunsWeibo,
    fallbacks: [
      { endpoint: XXAPI_WEIBO_ENDPOINT, parser: parseIyunsWeibo },
      { endpoint: GUIGUI_WEIBO_ENDPOINT, parser: parseGuiguiWeibo }
    ]
  },
  {
    id: "juejin",
    name: "掘金热榜",
    endpoint: GUIGUI_JUEJIN_ENDPOINT,
    parser: parseGuiguiJuejin
  },
  {
    id: "v2ex",
    name: "V2EX Hot",
    endpoint: "https://www.v2ex.com/api/topics/hot.json",
    parser: parseV2exTopics
  },
  {
    id: "hackernews",
    name: "Hacker News",
    endpoint: "https://hn.algolia.com/api/v1/search?tags=front_page",
    parser: parseHackerNews
  },
  {
    id: "36kr",
    name: "36 氪快讯",
    endpoint: KR36_ENDPOINT,
    parser: parse36KrHot,
    fallbacks: [{ endpoint: KR36_BACKUP_ENDPOINT, parser: parse36KrHot }]
  },
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

async function fetchEndpointPayload(url) {
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

function parseRssFeed(payload, source) {
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

function parseTophubZhihu(payload, source) {
  const json = safeJsonParse(payload?.bodyText);
  const rawItems = Array.isArray(json?.data?.items) ? json.data.items : [];
  const items = rawItems.filter(
    (item) =>
      (item?.sitename === "知乎" || item?.domain === "zhihu.com") &&
      String(item?.nodeids || "")
        .split(",")
        .includes("6")
  );

  if (items.length === 0) {
    throw new Error("知乎热榜聚合结果为空。");
  }

  return items.map((item) => ({
    title: item.title,
    url: item.url,
    hotScore: item.extra || item.views || "",
    summary: trimText(item.description || item.views || "", 140),
    source: source.name,
    publishedAt: normalizeDateValue(Number(item.time) ? Number(item.time) * 1000 : "")
  }));
}

function parseFreeJkZhihu(payload, source) {
  const json = safeJsonParse(payload?.bodyText);
  const rawItems = Array.isArray(json?.data) ? json.data : [];
  if (rawItems.length === 0) {
    throw new Error("知乎热榜暂时不可用。");
  }

  return rawItems.map((item) => ({
    title: item.title,
    url: item.mobileUrl || item.url,
    hotScore: formatLargeCount(item.hot),
    summary: trimText(item.desc || "", 140),
    source: source.name,
    publishedAt: normalizeDateValue(item.timestamp)
  }));
}

function parseIyunsWeibo(payload, source) {
  const json = safeJsonParse(payload?.bodyText);
  const rawItems = Array.isArray(json?.data) ? json.data : [];
  if (rawItems.length === 0) {
    throw new Error("微博热搜暂时不可用。");
  }

  const publishedAt = new Date().toISOString();
  return rawItems.map((item) => ({
    title: item.title,
    url: item.url,
    hotScore: item.hot || "",
    summary: `微博热搜第 ${item.index || "-"} 位`,
    source: source.name,
    publishedAt
  }));
}

function parseGuiguiWeibo(payload, source) {
  const json = safeJsonParse(payload?.bodyText);
  const rawItems = Array.isArray(json?.data) ? json.data : [];
  if (!json?.success || rawItems.length === 0) {
    throw new Error("微博热搜暂时不可用。");
  }

  const publishedAt = normalizeDateValue(json.update_time);
  return rawItems.map((item) => ({
    title: item.title,
    url: item.mobilUrl || item.url,
    hotScore: item.hot || "",
    summary: `微博热搜第 ${item.index || "-"} 位`,
    source: source.name,
    publishedAt
  }));
}

function parseGuiguiJuejin(payload, source) {
  const json = safeJsonParse(payload?.bodyText);
  const rawItems = Array.isArray(json?.data) ? json.data : [];
  if (!json?.success || rawItems.length === 0) {
    throw new Error("掘金热榜暂时不可用。");
  }

  const publishedAt = normalizeDateValue(json.update_time);
  return rawItems.map((item) => ({
    title: item.title,
    url: item.url,
    hotScore: item.hot_rank ? `${item.hot_rank}` : "",
    summary: [
      item.author && `作者 ${item.author}`,
      item.view && `${item.view} 阅读`,
      item["点赞"] && `${item["点赞"]} 赞`,
      item["收藏"] && `${item["收藏"]} 收藏`,
      item["评论"] && `${item["评论"]} 评论`
    ]
      .filter(Boolean)
      .join(" · "),
    source: source.name,
    publishedAt
  }));
}

function parse36KrHot(payload, source) {
  const json = safeJsonParse(payload?.bodyText);
  const rawItems = Array.isArray(json?.data) ? json.data : [];
  if (rawItems.length === 0) {
    throw new Error("36 氪快讯暂时不可用。");
  }

  return rawItems.map((item) => {
    const material = item?.templateMaterial || {};
    const itemId = material.itemId || item.itemId;
    return {
      title: material.widgetTitle || "",
      url: itemId ? `https://36kr.com/p/${itemId}` : "",
      hotScore: material.statFormat || "",
      summary: [
        material.authorName && `作者 ${material.authorName}`,
        material.statRead && `${material.statRead} 阅读`,
        material.statPraise && `${material.statPraise} 赞`,
        material.statComment && `${material.statComment} 评论`
      ]
        .filter(Boolean)
        .join(" · "),
      source: source.name,
      publishedAt: normalizeDateValue(material.publishTime || item.publishTime)
    };
  });
}

function parseV2exTopics(payload, source) {
  const rawItems = safeJsonParse(payload?.bodyText);
  if (!Array.isArray(rawItems) || rawItems.length === 0) {
    throw new Error("V2EX 暂时不可用。");
  }

  return rawItems.map((item) => ({
    title: item.title,
    url: item.url,
    hotScore: item.replies ? `${item.replies} 回复` : "",
    summary: [
      item.node?.title,
      item.member?.username && `作者 ${item.member.username}`,
      trimText(item.content || "", 90)
    ]
      .filter(Boolean)
      .join(" · "),
    source: source.name,
    publishedAt: normalizeDateValue(Number(item.created) ? Number(item.created) * 1000 : "")
  }));
}

function parseHackerNews(payload, source) {
  const json = safeJsonParse(payload?.bodyText);
  const rawItems = Array.isArray(json?.hits) ? json.hits : [];
  if (rawItems.length === 0) {
    throw new Error("Hacker News 暂时不可用。");
  }

  return rawItems.map((item) => ({
    title: item.title || item.story_title || "",
    url: item.url || `https://news.ycombinator.com/item?id=${item.objectID}`,
    hotScore: item.points ? `${item.points} points` : "",
    summary: [
      item.author && `作者 ${item.author}`,
      item.num_comments && `${item.num_comments} comments`,
      trimText(stripHtml(item.story_text || ""), 100)
    ]
      .filter(Boolean)
      .join(" · "),
    source: source.name,
    publishedAt: normalizeDateValue(item.created_at || item.created_at_i)
  }));
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

function safeJsonParse(rawText) {
  const text = String(rawText || "").trim();
  const objectStart = text.indexOf("{");
  const arrayStart = text.indexOf("[");
  const start =
    objectStart === -1
      ? arrayStart
      : arrayStart === -1
        ? objectStart
        : Math.min(objectStart, arrayStart);

  if (start === -1) {
    throw new Error("返回内容不是 JSON。");
  }

  return JSON.parse(text.slice(start));
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

function formatLargeCount(value) {
  const count = Number(value);
  if (!Number.isFinite(count) || count <= 0) {
    return "";
  }
  if (count >= 100000000) {
    return `${(count / 100000000).toFixed(1).replace(/\.0$/, "")} 亿`;
  }
  if (count >= 10000) {
    return `${(count / 10000).toFixed(1).replace(/\.0$/, "")} 万`;
  }
  return `${count}`;
}
