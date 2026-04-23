/**
 * 知乎搜索结果 DOM 提取。
 *
 * 选择器以「.SearchResult-Card」为主，同时兼容内嵌的 ContentItem / FeedAnswer 结构。
 */
(function () {
  if (window.__gzhScrapePlatform) return;

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  async function waitForCards(maxMs = 8000, intervalMs = 400) {
    const started = Date.now();
    while (Date.now() - started < maxMs) {
      const nodes = document.querySelectorAll(
        ".SearchResult-Card, .Card.SearchResult-Card, .ContentItem"
      );
      if (nodes.length >= 3) return nodes;
      await sleep(intervalMs);
    }
    return document.querySelectorAll(
      ".SearchResult-Card, .Card.SearchResult-Card, .ContentItem"
    );
  }

  function pickText(el, sel) {
    const t = el?.querySelector?.(sel)?.textContent?.trim();
    return t || "";
  }

  function parseZhihuNumber(text) {
    if (!text) return 0;
    const s = String(text).replace(/\s/g, "");
    const m = s.match(/([\d,.]+)\s*(万|w|k)?/i);
    if (!m) return 0;
    const v = Number(String(m[1]).replace(/,/g, "")) || 0;
    const u = (m[2] || "").toLowerCase();
    if (u === "万" || u === "w") return Math.round(v * 10000);
    if (u === "k") return Math.round(v * 1000);
    return Math.round(v);
  }

  function extractCard(card) {
    const titleEl =
      card.querySelector("h2 a") ||
      card.querySelector(".ContentItem-title a") ||
      card.querySelector("h2") ||
      card.querySelector(".Highlight");
    const title = titleEl?.textContent?.trim() || "";

    const linkEl =
      card.querySelector("h2 a") ||
      card.querySelector("a[href*='/question/']") ||
      card.querySelector("a[href*='/p/']") ||
      card.querySelector("a[href*='/answer/']");
    const href = linkEl?.getAttribute?.("href") || "";

    const author =
      pickText(card, ".AuthorInfo-name") ||
      pickText(card, ".UserLink-link");

    const summary =
      pickText(card, ".RichText") ||
      pickText(card, ".SearchItem-excerpt") ||
      pickText(card, ".ContentItem-Title + div");

    const meta =
      pickText(card, ".ContentItem-actions") ||
      pickText(card, ".VoteButton") ||
      "";
    const upvotes = parseZhihuNumber(
      pickText(card, "[aria-label*='赞同']") || pickText(card, ".VoteButton--up")
    );
    const comments = parseZhihuNumber(
      pickText(card, ".Button.ContentItem-action") || meta
    );

    let url = href;
    if (href && !href.startsWith("http")) {
      url = `https://www.zhihu.com${href.startsWith("/") ? href : `/${href}`}`;
    }
    if (href && href.startsWith("//")) {
      url = `https:${href}`;
    }

    return {
      title,
      url,
      author,
      summary,
      hotValue: upvotes + comments,
      hotScore: upvotes ? `${upvotes} 赞同` : "",
      publishedAt: "",
      thumbnailUrl: card.querySelector("img")?.getAttribute("src") || "",
      tags: []
    };
  }

  async function scrapeSearch(opts) {
    const limit = Math.max(1, Math.min(Number(opts?.limit || 8), 30));
    window.scrollTo(0, document.body.scrollHeight / 3);
    await sleep(700);
    window.scrollTo(0, document.body.scrollHeight / 2);
    await sleep(500);
    window.scrollTo(0, 0);

    const cards = await waitForCards();
    const items = [];
    const seen = new Set();

    cards.forEach((card) => {
      if (items.length >= limit) return;
      const data = extractCard(card);
      if (!data.url || !data.title) return;
      if (seen.has(data.url)) return;
      seen.add(data.url);
      items.push(data);
    });

    return { items, scrapedAt: new Date().toISOString() };
  }

  async function scrapeDetail() {
    const title =
      document.querySelector(".QuestionHeader-title")?.textContent?.trim() ||
      document.querySelector("h1")?.textContent?.trim() ||
      document.title;
    return { title };
  }

  window.__gzhScrapePlatform = async function ({ mode = "search", ...rest } = {}) {
    if (mode === "detail") return scrapeDetail();
    return scrapeSearch(rest);
  };
})();
