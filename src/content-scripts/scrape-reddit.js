/**
 * Reddit 搜索结果 DOM 提取。
 * 同时兼容老/新 reddit 与「shreddit」组件。
 */
(function () {
  if (window.__gzhScrapePlatform) return;

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  async function waitForPosts(maxMs = 8000, intervalMs = 400) {
    const started = Date.now();
    while (Date.now() - started < maxMs) {
      const nodes = collectPostNodes();
      if (nodes.length >= 3) return nodes;
      await sleep(intervalMs);
    }
    return collectPostNodes();
  }

  function collectPostNodes() {
    const list = [];
    document
      .querySelectorAll("shreddit-post, [data-testid='post-container'], a[data-click-id='body']")
      .forEach((n) => list.push(n));
    return list;
  }

  function pickText(el, sel) {
    const t = el?.querySelector?.(sel)?.textContent?.trim();
    return t || "";
  }

  function parseScore(text) {
    if (!text) return 0;
    const s = String(text).trim();
    const m = s.match(/([\d.]+)\s*(K|M|k|m)?/);
    if (!m) return 0;
    const v = Number(m[1]) || 0;
    const u = (m[2] || "").toUpperCase();
    if (u === "K") return Math.round(v * 1000);
    if (u === "M") return Math.round(v * 1_000_000);
    return Math.round(v);
  }

  function extractFromShreddit(node) {
    const title =
      node.getAttribute("post-title") ||
      pickText(node, "[slot='title'] a, a[slot='title'], h2, h3");
    const permalink =
      node.getAttribute("permalink") ||
      node.querySelector("a[href*='/comments/']")?.getAttribute("href") ||
      "";
    const author =
      node.getAttribute("author") ||
      pickText(node, "a[href*='/user/']");
    const score =
      node.getAttribute("score") ||
      pickText(node, "[data-testid='vote-arrows'], [name='upvote-count']");
    const comments =
      node.getAttribute("comment-count") ||
      pickText(node, "[data-testid='comment-count']");
    const subreddit =
      node.getAttribute("subreddit-prefixed-name") ||
      pickText(node, "a[href*='/r/']");
    const time =
      node.getAttribute("created-timestamp") ||
      node.querySelector("time, faceplate-timeago")?.getAttribute("ts") ||
      "";
    const thumb =
      node.getAttribute("post-image") ||
      node.querySelector("img")?.getAttribute("src") ||
      "";

    return { title, permalink, author, score, comments, subreddit, time, thumb };
  }

  function extractFromCard(node) {
    const titleEl =
      node.querySelector?.("h3") ||
      node.querySelector?.("a[data-click-id='body']") ||
      node;
    const title = titleEl?.textContent?.trim() || "";
    const linkEl = node.querySelector?.("a[href*='/comments/']");
    const permalink = linkEl?.getAttribute?.("href") || "";
    const author = pickText(node, "a[href*='/user/']");
    const score = pickText(node, "[id^='vote-arrows']") || pickText(node, "[data-testid='vote-arrows']");
    const comments = pickText(node, "[data-click-id='comments']") || pickText(node, "a[data-click-id='comments']");
    const subreddit = pickText(node, "a[href*='/r/']");
    const time = node.querySelector?.("a[data-click-id='timestamp']")?.getAttribute?.("href") || "";
    const thumb = node.querySelector?.("img")?.getAttribute?.("src") || "";
    return { title, permalink, author, score, comments, subreddit, time, thumb };
  }

  async function scrapeSearch(opts) {
    const limit = Math.max(1, Math.min(Number(opts?.limit || 8), 30));

    window.scrollTo(0, document.body.scrollHeight / 3);
    await sleep(600);
    window.scrollTo(0, document.body.scrollHeight / 2);
    await sleep(400);
    window.scrollTo(0, 0);

    const nodes = await waitForPosts();
    const items = [];
    const seen = new Set();

    nodes.forEach((node) => {
      if (items.length >= limit) return;
      const data =
        node.tagName?.toLowerCase() === "shreddit-post"
          ? extractFromShreddit(node)
          : extractFromCard(node);
      if (!data.permalink || !data.title) return;

      const url = data.permalink.startsWith("http")
        ? data.permalink
        : `https://www.reddit.com${data.permalink}`;
      if (seen.has(url)) return;
      seen.add(url);

      const score = parseScore(data.score);
      const comments = parseScore(data.comments);

      items.push({
        title: data.title.trim(),
        url,
        author: data.author?.replace(/^\/?u\//, "u/") || "",
        hotScore: `${score} upvotes · ${comments} comments`,
        hotValue: score + comments * 2,
        summary: data.subreddit || "",
        publishedAt: data.time || "",
        thumbnailUrl: data.thumb || "",
        tags: data.subreddit ? [data.subreddit] : []
      });
    });

    return { items, scrapedAt: new Date().toISOString() };
  }

  async function scrapeDetail() {
    const title =
      document.querySelector("shreddit-post")?.getAttribute("post-title") ||
      document.querySelector("h1")?.textContent?.trim() ||
      document.title;
    return { title };
  }

  window.__gzhScrapePlatform = async function ({ mode = "search", ...rest } = {}) {
    if (mode === "detail") return scrapeDetail();
    return scrapeSearch(rest);
  };
})();
