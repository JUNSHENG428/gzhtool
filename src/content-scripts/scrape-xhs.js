/**
 * 小红书搜索结果 / 详情页 DOM 抽取。
 * 注入到 https://www.xiaohongshu.com/search_result/ 或 https://www.xiaohongshu.com/explore/...
 *
 * 注册全局函数 window.__gzhScrapePlatform({ mode })：
 *   - mode = "search"：从搜索页提取笔记列表
 *   - mode = "detail"：从笔记页提取标题/正文（暂时只占位）
 */
(function () {
  if (window.__gzhScrapePlatform) return;

  async function waitForCards(maxMs = 8000, intervalMs = 400) {
    const started = Date.now();
    while (Date.now() - started < maxMs) {
      const cards = document.querySelectorAll(
        "section.note-item, a.cover, div.note-item, .feeds-page section, .search-page .feed-card"
      );
      if (cards.length >= 3) return cards;
      await sleep(intervalMs);
    }
    return document.querySelectorAll(
      "section.note-item, a.cover, div.note-item, .feeds-page section, .search-page .feed-card"
    );
  }

  function sleep(ms) {
    return new Promise((r) => setTimeout(r, ms));
  }

  function pickText(node, selectors) {
    for (const sel of selectors) {
      const el = node?.querySelector?.(sel);
      const text = el?.textContent?.trim();
      if (text) return text;
    }
    return "";
  }

  function pickAttr(node, selector, attr) {
    const el = node?.querySelector?.(selector);
    return el?.getAttribute?.(attr) || "";
  }

  function parseNumber(text) {
    if (!text) return 0;
    const s = String(text).replace(/\s/g, "");
    const m = s.match(/([\d.]+)\s*(万|w|k)?/i);
    if (!m) return 0;
    const v = Number(m[1]) || 0;
    const u = (m[2] || "").toLowerCase();
    if (u === "万" || u === "w") return Math.round(v * 10000);
    if (u === "k") return Math.round(v * 1000);
    return Math.round(v);
  }

  async function scrapeSearch(opts) {
    const limit = Math.max(1, Math.min(Number(opts?.limit || 8), 30));
    // 让懒加载先过一轮
    window.scrollTo(0, document.body.scrollHeight / 3);
    await sleep(800);
    window.scrollTo(0, document.body.scrollHeight / 2);
    await sleep(500);
    window.scrollTo(0, 0);

    const cards = await waitForCards();
    const items = [];

    cards.forEach((card) => {
      if (items.length >= limit) return;

      const linkEl =
        card.querySelector?.("a.cover") ||
        card.querySelector?.("a[href*='/explore/']") ||
        card.querySelector?.("a[href*='/discovery/']");
      const href = linkEl?.getAttribute?.("href") || "";
      if (!href || !/\/explore\/|\/discovery\//.test(href)) return;

      const url = href.startsWith("http")
        ? href
        : `https://www.xiaohongshu.com${href}`;

      const title =
        pickText(card, [".title span", ".title", "a.title", "[class*='title']"]) ||
        linkEl?.getAttribute?.("title") ||
        "";
      const author = pickText(card, [".author .name", ".user-name", ".name"]);
      const likes = pickText(card, [
        ".like-wrapper .count",
        ".like .count",
        ".count",
        "span[class*='like']"
      ]);
      const summary = pickText(card, [".desc", ".note-desc", "[class*='desc']"]);
      const thumbnailUrl =
        pickAttr(card, "img", "data-src") ||
        pickAttr(card, "img", "src") ||
        "";

      items.push({
        title,
        url,
        author,
        hotScore: likes ? `${likes} 赞` : "",
        hotValue: parseNumber(likes),
        summary,
        publishedAt: "",
        thumbnailUrl,
        tags: []
      });
    });

    return { items, scrapedAt: new Date().toISOString() };
  }

  async function scrapeDetail() {
    const title =
      document.querySelector("#detail-title")?.textContent?.trim() ||
      document.querySelector("h1")?.textContent?.trim() ||
      document.title;
    const desc =
      document.querySelector("#detail-desc")?.textContent?.trim() ||
      document.querySelector(".desc")?.textContent?.trim() ||
      "";
    return { title, summary: desc };
  }

  window.__gzhScrapePlatform = async function ({ mode = "search", ...rest } = {}) {
    if (mode === "detail") return scrapeDetail();
    return scrapeSearch(rest);
  };
})();
