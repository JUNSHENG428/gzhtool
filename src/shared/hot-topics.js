/**
 * 热点资讯抓取（在扩展后台调用，不受页面 CORS 限制）
 * 说明：各平台接口可能变更；X / 小红书无稳定公开 JSON，采用「门户引导」模式。
 */

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36";

export const HOT_SOURCE_META = {
  reddit: {
    id: "reddit",
    label: "Reddit",
    detail: "r/popular 热门帖（英文）"
  },
  weibo: {
    id: "weibo",
    label: "微博",
    detail: "移动端热搜榜（中文）"
  },
  x: {
    id: "x",
    label: "X（Twitter）",
    detail: "需登录网页端查看实时趋势"
  },
  xiaohongshu: {
    id: "xiaohongshu",
    label: "小红书",
    detail: "网页端发现页（完整热点多在 App）"
  }
};

/**
 * @param {keyof typeof HOT_SOURCE_META} sourceId
 */
export async function fetchHotTopics(sourceId) {
  const meta = HOT_SOURCE_META[sourceId];
  if (!meta) {
    return { ok: false, message: "未知的热点来源。" };
  }

  const fetchedAt = new Date().toISOString();

  try {
    if (sourceId === "reddit") {
      return { ok: true, payload: await fetchRedditHot(fetchedAt, meta) };
    }
    if (sourceId === "weibo") {
      return { ok: true, payload: await fetchWeiboHot(fetchedAt, meta) };
    }
    if (sourceId === "x") {
      return { ok: true, payload: portalPayload(fetchedAt, meta, xPortal()) };
    }
    if (sourceId === "xiaohongshu") {
      return { ok: true, payload: portalPayload(fetchedAt, meta, xhsPortal()) };
    }
  } catch (e) {
    return {
      ok: false,
      message: e?.message || "拉取热点失败，请稍后重试。"
    };
  }

  return { ok: false, message: "未知的热点来源。" };
}

async function fetchRedditHot(fetchedAt, meta) {
  const url =
    "https://www.reddit.com/r/popular/hot.json?limit=35&raw_json=1";
  const res = await fetch(url, {
    headers: {
      "User-Agent": UA,
      Accept: "application/json"
    }
  });

  if (!res.ok) {
    throw new Error(`Reddit 接口返回 ${res.status}，请稍后再试。`);
  }

  const json = await res.json();
  const children = json?.data?.children || [];
  const items = [];

  for (let i = 0; i < children.length; i++) {
    const d = children[i]?.data;
    if (!d || d.stickied) {
      continue;
    }
    const permalink = d.permalink || "";
    const link =
      permalink.startsWith("http") ?
        permalink
      : `https://www.reddit.com${permalink}`;

    items.push({
      id: `reddit-${d.id || i}`,
      title: String(d.title || "").trim() || "(无标题)",
      url: link,
      subtitle: `r/${d.subreddit || "?"} · ↑${d.ups ?? d.score ?? 0} · 💬${d.num_comments ?? 0}`
    });
    if (items.length >= 30) {
      break;
    }
  }

  return {
    mode: "list",
    source: meta.id,
    label: meta.label,
    detail: meta.detail,
    fetchedAt,
    items,
    notice:
      items.length === 0 ?
        "当前未解析到帖子，可能是接口限流或地区策略导致。"
      : ""
  };
}

async function fetchWeiboHot(fetchedAt, meta) {
  const endpoints = [
    "https://m.weibo.cn/api/container/getIndex?containerid=106003type25",
    "https://m.weibo.cn/api/container/getIndex?containerid=106003%26filter_type%3Drealtimehot"
  ];

  let lastErr = null;
  for (const apiUrl of endpoints) {
    try {
      const res = await fetch(apiUrl, {
        headers: {
          "User-Agent": UA,
          Accept: "application/json",
          Referer: "https://m.weibo.cn/",
          "X-Requested-With": "XMLHttpRequest"
        }
      });
      if (!res.ok) {
        lastErr = new Error(`微博接口 ${res.status}`);
        continue;
      }
      const json = await res.json();
      const items = parseWeiboCards(json);
      if (items.length > 0) {
        return {
          mode: "list",
          source: meta.id,
          label: meta.label,
          detail: meta.detail,
          fetchedAt,
          items,
          notice: ""
        };
      }
    } catch (e) {
      lastErr = e;
    }
  }

  throw new Error(
    lastErr?.message ||
      "微博热搜接口暂不可用，请稍后重试，或在微博客户端查看。"
  );
}

function parseWeiboCards(json) {
  const items = [];
  const seen = new Set();
  const cards = json?.data?.cards || [];

  for (const card of cards) {
    const groups = card.card_group || [];
    for (const g of groups) {
      const title =
        g.desc ||
        g.title ||
        g?.item?.name ||
        g?.item?.title ||
        g?.item?.desc ||
        "";
      let link = g.scheme || g.url || g?.item?.scheme || g?.item?.url || "";
      if (!title) {
        continue;
      }

      link = normalizeWeiboLink(link, String(title).trim());
      if (!link || seen.has(link + title)) {
        continue;
      }
      seen.add(link + title);

      const extra = [];
      if (g?.item?.desc_sub || g?.item?.desc_extr) {
        extra.push(String(g.item.desc_sub || g.item.desc_extr));
      }

      items.push({
        id: `weibo-${items.length}-${hashStr(title)}`,
        title: String(title).trim(),
        url: link,
        subtitle: extra.filter(Boolean).join(" · ") || "微博热搜"
      });

      if (items.length >= 35) {
        return items;
      }
    }
  }

  return items;
}

function normalizeWeiboLink(link, title) {
  const s = String(link || "").trim();
  const q = encodeURIComponent(title || "");
  if (!s) {
    return `https://m.weibo.cn/search?containerid=100103type61&q=${q}`;
  }
  if (s.startsWith("http://") || s.startsWith("https://")) {
    return s;
  }
  if (s.startsWith("//")) {
    return `https:${s}`;
  }
  if (s.startsWith("sinaweibo://")) {
    return `https://m.weibo.cn/search?containerid=100103type61&q=${q}`;
  }
  return s;
}

function hashStr(s) {
  let h = 0;
  const str = String(s).slice(0, 80);
  for (let i = 0; i < str.length; i++) {
    h = (Math.imul(31, h) + str.charCodeAt(i)) | 0;
  }
  return String(h);
}

function xPortal() {
  return {
    title: "在 X（Twitter）查看趋势",
    description:
      "X 未提供无需授权的公开热搜 JSON。请在新标签页打开官方探索页，登录后即可浏览「趋势」；再在目标推文或文章页使用本扩展抓取。",
    url: "https://x.com/explore/tabs/trending",
    buttonLabel: "打开 X 趋势页"
  };
}

function xhsPortal() {
  return {
    title: "在小红书发现热门笔记",
    description:
      "小红书热点与推荐主要在 App 内；网页端可浏览发现页。打开后搜索或点进笔记，再回编辑台抓取该页。",
    url: "https://www.xiaohongshu.com/explore",
    buttonLabel: "打开小红书发现页"
  };
}

function portalPayload(fetchedAt, meta, portal) {
  return {
    mode: "portal",
    source: meta.id,
    label: meta.label,
    detail: meta.detail,
    fetchedAt,
    items: [],
    portal,
    notice:
      "该平台无稳定公开接口，已为你链接到官方网页入口；若页面要求登录，请先登录后再抓取。"
  };
}
