/**
 * X (Twitter) 搜索结果 DOM 提取。
 *
 * 注意：X 大量用 react 客户端渲染 + 无限滚动，需要等若干秒、滚动若干次让 tweet 出现。
 */
(function () {
  if (window.__gzhScrapePlatform) return;

  function sleep(ms) {
    return new Promise((r) => setTimeout(r, ms));
  }

  async function waitForTweets(maxMs = 10000, intervalMs = 500) {
    const started = Date.now();
    while (Date.now() - started < maxMs) {
      const nodes = document.querySelectorAll("article[data-testid='tweet']");
      if (nodes.length >= 3) return nodes;
      await sleep(intervalMs);
    }
    return document.querySelectorAll("article[data-testid='tweet']");
  }

  function pickText(el, sel) {
    const t = el?.querySelector?.(sel)?.textContent?.trim();
    return t || "";
  }

  function parseEngagementNumber(text) {
    if (!text) return 0;
    const s = String(text).replace(/,/g, "").trim();
    const m = s.match(/([\d.]+)\s*([KMB万千])?/i);
    if (!m) return 0;
    const v = Number(m[1]) || 0;
    const u = (m[2] || "").toUpperCase();
    if (u === "K" || u === "千") return Math.round(v * 1000);
    if (u === "M") return Math.round(v * 1_000_000);
    if (u === "B") return Math.round(v * 1_000_000_000);
    if (u === "万") return Math.round(v * 10_000);
    return Math.round(v);
  }

  function pickEngagement(article, testId) {
    const node = article.querySelector(`[data-testid='${testId}']`);
    if (!node) return 0;
    // 数值通常在 aria-label 里：例如 "12 Likes"
    const ariaLabel =
      node.getAttribute("aria-label") || node.parentElement?.getAttribute("aria-label") || "";
    const inText = node.textContent || "";
    return parseEngagementNumber(inText) || parseEngagementNumber(ariaLabel);
  }

  async function scrapeSearch(opts) {
    const limit = Math.max(1, Math.min(Number(opts?.limit || 8), 30));

    // 触发懒加载
    for (let i = 0; i < 3; i += 1) {
      window.scrollTo(0, document.body.scrollHeight);
      await sleep(700);
    }
    window.scrollTo(0, 0);

    const articles = await waitForTweets();
    const items = [];
    const seen = new Set();

    articles.forEach((article) => {
      if (items.length >= limit) return;

      const linkEl = article.querySelector("a[href*='/status/']");
      const href = linkEl?.getAttribute?.("href") || "";
      if (!href) return;

      const url = href.startsWith("http") ? href : `https://x.com${href}`;
      if (seen.has(url)) return;
      seen.add(url);

      const author =
        pickText(article, "[data-testid='User-Name'] a span") ||
        pickText(article, "[data-testid='User-Name']");
      const text =
        pickText(article, "[data-testid='tweetText']") ||
        article.textContent?.trim()?.slice(0, 200) ||
        "";

      const likes = pickEngagement(article, "like");
      const replies = pickEngagement(article, "reply");
      const reposts = pickEngagement(article, "retweet");

      const hotValue = likes + reposts * 2 + replies;
      const hotScore = `${likes} 赞 · ${reposts} 转推 · ${replies} 评论`;

      const time =
        article.querySelector("time")?.getAttribute("datetime") || "";
      const thumbnailUrl =
        article.querySelector("img[src*='media']")?.getAttribute("src") || "";

      items.push({
        title: text.slice(0, 80),
        url,
        author: author.replace(/^@?/, "@").trim(),
        hotScore,
        hotValue,
        summary: text,
        publishedAt: time,
        thumbnailUrl,
        tags: []
      });
    });

    return { items, scrapedAt: new Date().toISOString() };
  }

  async function scrapeDetail() {
    const tweetText =
      document.querySelector("[data-testid='tweetText']")?.textContent?.trim() ||
      document.title;
    return { title: tweetText.slice(0, 80), summary: tweetText };
  }

  window.__gzhScrapePlatform = async function ({ mode = "search", ...rest } = {}) {
    if (mode === "detail") return scrapeDetail();
    return scrapeSearch(rest);
  };
})();
