/**
 * 热点资讯抓取（在扩展后台调用，不受页面 CORS 限制）
 * 数据源：
 *  - 聚合 API: newsnow.busiyi.world (覆盖国内数十平台)
 *  - 国外 Reddit 直连
 *  - X / 小红书 无稳定公开 JSON，采用「门户引导」模式。
 */

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36";

export const HOT_SOURCE_META = {
  // 综合 / 社区
  zhihu: { id: "zhihu", label: "知乎热榜", detail: "知乎热门内容", category: "china", newsNow: "zhihu" },
  weibo: { id: "weibo", label: "微博热搜", detail: "新浪微博实时热点", category: "china", newsNow: "weibo" },
  tieba: { id: "tieba", label: "百度贴吧", detail: "贴吧热议话题", category: "china", newsNow: "tieba" },
  baidu: { id: "baidu", label: "百度热搜", detail: "百度搜索实时榜", category: "china", newsNow: "baidu" },
  toutiao: { id: "toutiao", label: "今日头条", detail: "头条热点资讯", category: "china", newsNow: "toutiao" },
  hupu: { id: "hupu", label: "虎扑步行街", detail: "主干道热门讨论", category: "china", newsNow: "hupu" },
  thepaper: { id: "thepaper", label: "澎湃新闻", detail: "热榜资讯", category: "china", newsNow: "thepaper" },
  tencent: { id: "tencent-hot", label: "腾讯新闻", detail: "综合早报与热点", category: "china", newsNow: "tencent-hot" },
  
  // 科技 / 数码 / 开发
  sspai: { id: "sspai", label: "少数派", detail: "高效工具与生活方式", category: "tech", newsNow: "sspai" },
  juejin: { id: "juejin", label: "稀土掘金", detail: "开发者技术热点", category: "tech", newsNow: "juejin" },
  coolapk: { id: "coolapk", label: "酷安", detail: "数码科技数码圈热议", category: "tech", newsNow: "coolapk" },
  ithome: { id: "ithome", label: "IT之家", detail: "每日科技要闻", category: "tech", newsNow: "ithome" },
  "36kr": { id: "36kr-quick", label: "36氪", detail: "科技创投最新快讯", category: "tech", newsNow: "36kr-quick" },
  v2ex: { id: "v2ex", label: "V2EX", detail: "极客社区最新分享", category: "tech", newsNow: "v2ex" },
  github: { id: "github-trending-today", label: "GitHub", detail: "Trending今日趋势", category: "tech", newsNow: "github-trending-today" },
  hackernews: { id: "hackernews", label: "Hacker News", detail: "前沿科技资讯 (英)", category: "tech", newsNow: "hackernews" },
  producthunt: { id: "producthunt", label: "Product Hunt", detail: "每日全球新产品", category: "tech", newsNow: "producthunt" },

  // 财经
  wallstreetcn: { id: "wallstreetcn-hot", label: "华尔街见闻", detail: "全球金融要闻", category: "finance", newsNow: "wallstreetcn-hot" },
  xueqiu: { id: "xueqiu-hotstock", label: "雪球", detail: "热门讨论与股票", category: "finance", newsNow: "xueqiu-hotstock" },
  cls: { id: "cls-telegraph", label: "财联社", detail: "财经电报实时动态", category: "finance", newsNow: "cls-telegraph" },

  // 视频 / 娱乐
  bilibili: { id: "bilibili-hot-search", label: "B站热搜", detail: "Bilibili 热搜词", category: "video", newsNow: "bilibili-hot-search" },
  bilibili_rank: { id: "bilibili-ranking", label: "B站排行榜", detail: "最受全站欢迎视频", category: "video", newsNow: "bilibili-ranking" },
  douyin: { id: "douyin", label: "抖音热点", detail: "抖音全网热榜", category: "video", newsNow: "douyin" },
  douban: { id: "douban", label: "豆瓣电影", detail: "近期热门影视", category: "video", newsNow: "douban" },

  // 国际视野 / 其他门户
  reddit: { id: "reddit", label: "Reddit", detail: "r/popular 全球热帖", category: "world" },
  zaobao: { id: "zaobao", label: "联合早报", detail: "早晨国际要闻", category: "world", newsNow: "zaobao" },
  x: { id: "x", label: "X (Twitter)", detail: "官方趋势引导", category: "world" },
  xiaohongshu: { id: "xiaohongshu", label: "小红书", detail: "发现页引导", category: "china" }
};

const CACHE_TTL_MS = 3 * 60 * 1000; // 3分钟
const _cache = new Map();

/**
 * 获取指定平台的热榜数据
 * @param {keyof typeof HOT_SOURCE_META} sourceId
 * @param {boolean} forceRefresh 是否强制刷新忽略缓存
 */
export async function fetchHotTopics(sourceId, forceRefresh = false) {
  const meta = HOT_SOURCE_META[sourceId];
  if (!meta) {
    return { ok: false, message: "未知的热点来源。" };
  }

  // 读取缓存
  if (!forceRefresh) {
    const cached = _cache.get(sourceId);
    if (cached && (Date.now() - cached.timestamp < CACHE_TTL_MS)) {
      return { ok: true, payload: cached.payload };
    }
  }

  const fetchedAt = new Date().toISOString();

  try {
    let payload = null;
    if (meta.newsNow) {
      payload = await fetchNewsNowHot(fetchedAt, meta);
    } else if (sourceId === "reddit") {
      payload = await fetchRedditHot(fetchedAt, meta);
    } else if (sourceId === "x") {
      payload = portalPayload(fetchedAt, meta, xPortal());
    } else if (sourceId === "xiaohongshu") {
      payload = portalPayload(fetchedAt, meta, xhsPortal());
    }

    if (payload) {
      _cache.set(sourceId, { timestamp: Date.now(), payload });
      return { ok: true, payload };
    }
  } catch (e) {
    return {
      ok: false,
      message: e?.message || "拉取热点失败，可能是网络问题或接口被拦截，请稍后重试。"
    };
  }

  return { ok: false, message: "未知的热点处理管线。" };
}

// ── 通用爬取 (NewsNow 聚合 API) ──

async function fetchNewsNowHot(fetchedAt, meta) {
  const url = `https://newsnow.busiyi.world/api/s?id=${meta.newsNow}&latest`;
  const res = await fetch(url, {
    headers: {
      "User-Agent": UA,
      Accept: "application/json, text/plain, */*"
    }
  });

  if (!res.ok) {
    throw new Error(`聚合数据接口返回 ${res.status}。`);
  }

  const json = await res.json();
  const rawItems = json?.data || [];
  const items = [];

  for (let i = 0; i < rawItems.length; i++) {
    const d = rawItems[i];
    const title = String(d.title || "").trim();
    if (!title || d.stickied) {
      continue;
    }
    
    let link = d.url || d.mobileUrl || "";
    // B站搜索URL补全
    if (link && link.startsWith("bilibili://")) {
       link = `https://search.bilibili.com/all?keyword=${encodeURIComponent(title)}`;
    }
    
    let subtitleComponents = [];
    if (d.hot) subtitleComponents.push(`热度 ${d.hot}`);
    if (d.desc) subtitleComponents.push(String(d.desc).slice(0, 40));

    items.push({
      id: `${meta.id}-${d.id || i}`,
      title: title,
      url: link,
      subtitle: subtitleComponents.length ? subtitleComponents.join(" · ") : `${meta.label}热榜`
    });
    
    // 我们限制取前 35 条就够了，减轻DOM渲染压力
    if (items.length >= 35) {
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
    notice: items.length === 0 ? "当前时段该平台可能无热点，或接口遭遇反爬。" : ""
  };
}

// ── 独立爬取 (Reddit) ──

async function fetchRedditHot(fetchedAt, meta) {
  const url = "https://www.reddit.com/r/popular/hot.json?limit=35&raw_json=1";
  const res = await fetch(url, { headers: { "User-Agent": UA, Accept: "application/json" } });

  if (!res.ok) {
    throw new Error(`Reddit 接口返回 ${res.status}，请稍后再试。`);
  }

  const json = await res.json();
  const children = json?.data?.children || [];
  const items = [];

  for (let i = 0; i < children.length; i++) {
    const d = children[i]?.data;
    if (!d || d.stickied) continue;
    
    const permalink = d.permalink || "";
    const link = permalink.startsWith("http") ? permalink : `https://www.reddit.com${permalink}`;

    items.push({
      id: `reddit-${d.id || i}`,
      title: String(d.title || "").trim() || "(无标题)",
      url: link,
      subtitle: `r/${d.subreddit || "?"} · ↑${d.ups ?? d.score ?? 0} · 💬${d.num_comments ?? 0}`
    });
    if (items.length >= 30) break;
  }

  return {
    mode: "list",
    source: meta.id, label: meta.label, detail: meta.detail,
    fetchedAt, items,
    notice: items.length === 0 ? "当前未解析到帖子，可能是接口限流或地区策略导致。" : ""
  };
}

// ── 引导平台 ──

function xPortal() {
  return {
    title: "在 X（Twitter）查看趋势",
    description: "X 没有完全匿名的公开 JSON。请在新标签页打开官方探索页，登录后查看「趋势」。",
    url: "https://x.com/explore/tabs/trending",
    buttonLabel: "打开 X 趋势页"
  };
}

function xhsPortal() {
  return {
    title: "在小红书发现热门内容",
    description: "小红书热点主要在 App 内；网页端可浏览发现页与搜索。",
    url: "https://www.xiaohongshu.com/explore",
    buttonLabel: "打开小红书网页端"
  };
}

function portalPayload(fetchedAt, meta, portal) {
  return {
    mode: "portal",
    source: meta.id, label: meta.label, detail: meta.detail,
    fetchedAt, items: [], portal,
    notice: "该平台无稳定极简 API，已为你链接到官方入口。"
  };
}
