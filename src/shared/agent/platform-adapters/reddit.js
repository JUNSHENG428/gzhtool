/**
 * Reddit 搜索适配器。
 * 默认按 hot 排序，详情匹配 /r/<sub>/comments/<id>/...
 */

export const adapter = Object.freeze({
  id: "reddit",
  name: "Reddit",
  requireCookieDomains: ["reddit.com"],
  contentScript: "src/content-scripts/scrape-reddit.js",

  buildSearchUrl(query) {
    const q = encodeURIComponent(String(query || "").trim());
    return `https://www.reddit.com/search/?q=${q}&sort=hot&t=week`;
  },

  parseSearchPayload(payload) {
    const items = Array.isArray(payload?.items) ? payload.items : [];
    return items
      .filter((item) => item?.url)
      .map((item) => ({
        platformId: "reddit",
        platformName: "Reddit",
        title: String(item.title || "").trim() || "(untitled post)",
        url: normalizeRedditUrl(item.url),
        author: String(item.author || "").trim(),
        hotScore: String(item.hotScore || ""),
        hotValue: Number(item.hotValue) || 0,
        summary: String(item.summary || "").trim(),
        publishedAt: item.publishedAt || "",
        thumbnailUrl: item.thumbnailUrl || "",
        rawTags: Array.isArray(item.tags) ? item.tags.slice(0, 6) : []
      }));
  }
});

function normalizeRedditUrl(rawUrl) {
  try {
    const u = new URL(rawUrl, "https://www.reddit.com");
    return `https://www.reddit.com${u.pathname}`;
  } catch {
    return rawUrl;
  }
}
