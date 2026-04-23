/**
 * 知乎搜索适配器。
 * 使用 /search?q=...&type=content 抓内容；详情匹配 /question/<id> 或 /p/<id>。
 */

export const adapter = Object.freeze({
  id: "zhihu",
  name: "知乎",
  requireCookieDomains: ["zhihu.com"],
  contentScript: "src/content-scripts/scrape-zhihu.js",

  buildSearchUrl(query) {
    const q = encodeURIComponent(String(query || "").trim());
    return `https://www.zhihu.com/search?q=${q}&type=content&utm_content=search_history`;
  },

  parseSearchPayload(payload) {
    const items = Array.isArray(payload?.items) ? payload.items : [];
    return items
      .filter((item) => item?.url)
      .map((item) => ({
        platformId: "zhihu",
        platformName: "知乎",
        title: String(item.title || "").trim() || "(未命名内容)",
        url: normalizeZhihuUrl(item.url),
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

function normalizeZhihuUrl(rawUrl) {
  try {
    const u = new URL(rawUrl, "https://www.zhihu.com");
    if (u.hostname.endsWith("zhihu.com")) {
      return `https://www.zhihu.com${u.pathname}${u.search}`;
    }
    return rawUrl;
  } catch {
    return rawUrl;
  }
}
