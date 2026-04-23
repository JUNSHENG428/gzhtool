/**
 * X (Twitter) 搜索适配器。
 * 使用 /search?q=...&f=live 抓取实时流；详情匹配 /<user>/status/<id>。
 */

export const adapter = Object.freeze({
  id: "x",
  name: "X",
  requireCookieDomains: ["x.com", "twitter.com"],
  contentScript: "src/content-scripts/scrape-x.js",

  buildSearchUrl(query) {
    const q = encodeURIComponent(String(query || "").trim());
    return `https://x.com/search?q=${q}&src=typed_query&f=live`;
  },

  parseSearchPayload(payload) {
    const items = Array.isArray(payload?.items) ? payload.items : [];
    return items
      .filter((item) => item?.url)
      .map((item) => ({
        platformId: "x",
        platformName: "X",
        title: String(item.title || item.summary || "").trim().slice(0, 140) || "(无标题推文)",
        url: normalizeXUrl(item.url),
        author: String(item.author || "").trim(),
        hotScore: String(item.hotScore || ""),
        hotValue: Number(item.hotValue) || 0,
        summary: String(item.summary || item.title || "").trim(),
        publishedAt: item.publishedAt || "",
        thumbnailUrl: item.thumbnailUrl || "",
        rawTags: Array.isArray(item.tags) ? item.tags.slice(0, 6) : []
      }));
  }
});

function normalizeXUrl(rawUrl) {
  try {
    const u = new URL(rawUrl, "https://x.com");
    return `https://x.com${u.pathname}`;
  } catch {
    return rawUrl;
  }
}
