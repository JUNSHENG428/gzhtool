/**
 * 小红书搜索适配器。
 * 注意：小红书的搜索结果列表大量依赖客户端水合，需要等 1-2s 让卡片渲染出来。
 */

export const adapter = Object.freeze({
  id: "xhs",
  name: "小红书",
  requireCookieDomains: ["xiaohongshu.com"],
  contentScript: "src/content-scripts/scrape-xhs.js",

  buildSearchUrl(query) {
    const q = encodeURIComponent(String(query || "").trim());
    return `https://www.xiaohongshu.com/search_result/?keyword=${q}&source=web_explore_feed`;
  },

  parseSearchPayload(payload) {
    const items = Array.isArray(payload?.items) ? payload.items : [];
    return items
      .filter((item) => item?.url)
      .map((item) => ({
        platformId: "xhs",
        platformName: "小红书",
        title: String(item.title || "").trim() || "(未命名笔记)",
        url: normalizeXhsUrl(item.url),
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

function normalizeXhsUrl(rawUrl) {
  try {
    const u = new URL(rawUrl, "https://www.xiaohongshu.com");
    u.search = "";
    return u.toString();
  } catch {
    return rawUrl;
  }
}
