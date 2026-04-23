/**
 * 热点资讯抓取（在扩展后台调用，不受页面 CORS 限制）
 *
 * 数据源策略（按顺序尝试，**任一返回空都自动 fallback**）：
 *  1. NewsNow 聚合 API（默认 https://hot.inkgold.info/，自部署到 Cloudflare Pages）
 *     仓库：https://github.com/ourongxing/newsnow
 *     选它的理由：作者每周更新；自带 SQLite 缓存；多平台覆盖；CF Pages 边缘节点
 *  2. 官方直连（如 Bilibili 排行榜公共接口）
 *  3. DailyHotApi（兜底，默认 https://api-hot.imsyy.top/，仅当 NewsNow 都挂时启用）
 *     仓库：https://github.com/imsyy/DailyHotApi
 *  4. Reddit 直连（独立通道）
 *  5. RSS / RSSHub 直连（AI / 技术博客类）
 *  6. 门户引导（X / 小红书）
 *
 * 用户可在「设置 → 热点接口」里把 NewsNow 改成自托地址，
 * 或填写 DailyHotApi 自托地址，避免公共服务被限流。
 */

import { fetchHotTopicSourceItems } from "./hot-topics-sources.js";
import {
  readCachedPayload,
  writeCachedPayload,
  clearCachedPayload,
  isBaseCoolingDown,
  recordBaseFailure,
  recordBaseSuccess,
  getHealthSnapshot,
  COOLDOWN_MS
} from "./hot-topics-cache.js";

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36";

// 默认走我们自部署的 NewsNow（Cloudflare Pages，国内国外都稳）
// 想自部一份的用户可在「设置 → 热点接口」覆盖此地址
export const DEFAULT_NEWSNOW_BASE = "https://hot.inkgold.info/";
// DailyHotApi 仅作兜底，公共 demo 经常 530，不再作为首选
export const DEFAULT_DAILYHOT_BASE = "https://api-hot.imsyy.top/";

const FETCH_TIMEOUT_MS = 8000;
// 仅当 items 少于这个数量才认为「实际为空」并触发 fallback
const MIN_VALID_ITEMS = 1;

export const HOT_SOURCE_META = {
  // 综合 / 社区
  zhihu: { id: "zhihu", label: "知乎热榜", detail: "知乎热门内容", category: "china", dailyhot: "zhihu", newsNow: "zhihu" },
  weibo: { id: "weibo", label: "微博热搜", detail: "新浪微博实时热点", category: "china", dailyhot: "weibo", newsNow: "weibo" },
  tieba: { id: "tieba", label: "百度贴吧", detail: "贴吧热议话题", category: "china", dailyhot: "tieba", newsNow: "tieba" },
  baidu: { id: "baidu", label: "百度热搜", detail: "百度搜索实时榜", category: "china", dailyhot: "baidu", newsNow: "baidu" },
  toutiao: { id: "toutiao", label: "今日头条", detail: "头条热点资讯", category: "china", dailyhot: "toutiao", newsNow: "toutiao" },
  hupu: { id: "hupu", label: "虎扑步行街", detail: "主干道热门讨论", category: "china", dailyhot: "hupu", newsNow: "hupu" },
  thepaper: { id: "thepaper", label: "澎湃新闻", detail: "热榜资讯", category: "china", dailyhot: "thepaper", newsNow: "thepaper" },
  tencent: { id: "tencent-hot", label: "腾讯新闻", detail: "综合早报与热点", category: "china", dailyhot: "qq-news", newsNow: "tencent-hot" },
  netease: { id: "netease-news", label: "网易新闻", detail: "热点头条", category: "china", dailyhot: "netease-news" },
  weread: { id: "weread", label: "微信读书", detail: "飙升榜", category: "china", dailyhot: "weread" },

  // 科技 / 数码 / 开发
  sspai: { id: "sspai", label: "少数派", detail: "高效工具与生活方式", category: "tech", dailyhot: "sspai", newsNow: "sspai" },
  juejin: { id: "juejin", label: "稀土掘金", detail: "开发者技术热点", category: "tech", dailyhot: "juejin", newsNow: "juejin" },
  coolapk: { id: "coolapk", label: "酷安", detail: "数码科技数码圈热议", category: "tech", dailyhot: "coolapk", newsNow: "coolapk" },
  ithome: { id: "ithome", label: "IT之家", detail: "每日科技要闻", category: "tech", dailyhot: "ithome", newsNow: "ithome" },
  "36kr": { id: "36kr-quick", label: "36氪", detail: "科技创投最新快讯", category: "tech", dailyhot: "36kr", newsNow: "36kr-quick" },
  v2ex: { id: "v2ex", label: "V2EX", detail: "极客社区最新分享", category: "tech", dailyhot: "v2ex", newsNow: "v2ex" },
  github: { id: "github-trending-today", label: "GitHub", detail: "Trending今日趋势", category: "tech", dailyhot: "github", newsNow: "github-trending-today" },
  hackernews: { id: "hackernews", label: "Hacker News", detail: "前沿科技资讯 (英)", category: "tech", dailyhot: "hackernews", newsNow: "hackernews" },
  producthunt: { id: "producthunt", label: "Product Hunt", detail: "每日全球新产品", category: "tech", dailyhot: "producthunt", newsNow: "producthunt" },
  hellogithub: { id: "hellogithub", label: "HelloGitHub", detail: "高质量开源项目", category: "tech", dailyhot: "hellogithub" },
  nodeseek: { id: "nodeseek", label: "NodeSeek", detail: "服务器圈热议", category: "tech", dailyhot: "nodeseek" },
  csdn: { id: "csdn", label: "CSDN", detail: "技术博客排行", category: "tech", dailyhot: "csdn" },
  huxiu: { id: "huxiu", label: "虎嗅", detail: "商业科技深度", category: "tech", dailyhot: "huxiu" },

  // 财经
  wallstreetcn: { id: "wallstreetcn-hot", label: "华尔街见闻", detail: "全球金融要闻", category: "finance", dailyhot: "wallstreetcn", newsNow: "wallstreetcn-hot" },
  xueqiu: { id: "xueqiu-hotstock", label: "雪球", detail: "热门讨论与股票", category: "finance", dailyhot: "xueqiu", newsNow: "xueqiu-hotstock" },
  cls: { id: "cls-telegraph", label: "财联社", detail: "财经电报实时动态", category: "finance", newsNow: "cls-telegraph" },

  // 视频 / 娱乐
  bilibili: { id: "bilibili-hot-search", label: "B站热搜", detail: "Bilibili 热搜词", category: "video", dailyhot: "bilibili", newsNow: "bilibili-hot-search" },
  bilibili_rank: { id: "bilibili-ranking", label: "B站排行榜", detail: "最受全站欢迎视频", category: "video", direct: "bilibili-ranking", newsNow: "bilibili-ranking" },
  douyin: { id: "douyin", label: "抖音热点", detail: "抖音全网热榜", category: "video", dailyhot: "douyin", newsNow: "douyin" },
  douban_movie: { id: "douban-movie", label: "豆瓣电影", detail: "近期热门影视", category: "video", dailyhot: "douban-movie", newsNow: "douban" },
  douban_group: { id: "douban-group", label: "豆瓣小组", detail: "热门小组讨论", category: "video", dailyhot: "douban-group" },
  acfun: { id: "acfun", label: "AcFun", detail: "弹幕视频热门", category: "video", dailyhot: "acfun" },

  // 国际视野 / 其他门户
  reddit: { id: "reddit", label: "Reddit", detail: "r/popular 全球热帖", category: "world" },
  zaobao: { id: "zaobao", label: "联合早报", detail: "早晨国际要闻", category: "world", dailyhot: "zaobao", newsNow: "zaobao" },
  x: { id: "x", label: "X (Twitter)", detail: "官方趋势引导", category: "world" },
  xiaohongshu: { id: "xiaohongshu", label: "小红书", detail: "发现页引导", category: "china" },

  // AI / 技术 RSS（直连 RSS / 自托 RSSHub，实现见 hot-topics-sources.js）
  techcrunch: { id: "techcrunch", label: "TechCrunch", detail: "硅谷创投与产品快讯", category: "ai", rss: true, rssSourceId: "techcrunch" },
  theverge: { id: "theverge", label: "The Verge", detail: "科技产品与文化", category: "ai", rss: true, rssSourceId: "theverge" },
  "arxiv-ai": { id: "arxiv-ai", label: "arXiv AI", detail: "cs.AI 最新论文", category: "ai", rss: true, rssSourceId: "arxiv-ai" },
  "arxiv-ml": { id: "arxiv-ml", label: "arXiv ML", detail: "cs.LG 最新论文", category: "ai", rss: true, rssSourceId: "arxiv-ml" },
  "ml-mastery": { id: "ml-mastery", label: "ML Mastery", detail: "机器学习教程", category: "ai", rss: true, rssSourceId: "ml-mastery" },
  "towards-ds": { id: "towards-ds", label: "Towards Data Science", detail: "数据科学专栏", category: "ai", rss: true, rssSourceId: "towards-ds" },
  "import-ai": { id: "import-ai", label: "Import AI", detail: "Jack Clark 的 AI 周报", category: "ai", rss: true, rssSourceId: "import-ai" },
  leiphone: { id: "leiphone", label: "雷锋网", detail: "中文 AI 与硬科技", category: "ai", rss: true, rssSourceId: "leiphone" },
  "hackernews-rss": { id: "hackernews-rss", label: "HN 100+ 高分", detail: "Hacker News 100 分以上", category: "ai", rss: true, rssSourceId: "hackernews-rss" }
};

const BACKEND_LABEL = {
  dailyhot: "DailyHotApi",
  newsnow: "NewsNow",
  direct: "官方接口",
  reddit: "Reddit",
  portal: "门户",
  rss: "RSS 直连"
};

/**
 * 获取指定平台的热榜数据
 * @param {keyof typeof HOT_SOURCE_META} sourceId
 * @param {Object} [opts]
 * @param {boolean} [opts.forceRefresh] 强制忽略缓存
 * @param {string} [opts.dailyhotBase] DailyHotApi 自定义地址
 * @param {string} [opts.newsnowBase] NewsNow 自定义地址
 */
export async function fetchHotTopics(sourceId, opts = {}) {
  const { forceRefresh = false, dailyhotBase, newsnowBase, rsshubBaseUrl } = opts;

  const meta = HOT_SOURCE_META[sourceId];
  if (!meta) {
    return { ok: false, message: "未知的热点来源。" };
  }

  // 1) 命中持久缓存
  if (!forceRefresh) {
    const cached = await readCachedPayload(sourceId);
    if (cached) return { ok: true, payload: cached };
  }

  const fetchedAt = new Date().toISOString();
  const errors = [];

  // 2) 门户类（X / 小红书）：没有 API，仅做引导卡片
  if (sourceId === "x") {
    const payload = portalPayload(fetchedAt, meta, xPortal());
    await writeCachedPayload(sourceId, payload);
    return { ok: true, payload };
  }
  if (sourceId === "xiaohongshu") {
    const payload = portalPayload(fetchedAt, meta, xhsPortal());
    await writeCachedPayload(sourceId, payload);
    return { ok: true, payload };
  }

  // 3) RSS / RSSHub 直连
  if (meta.rss) {
    try {
      const result = await fetchHotTopicSourceItems(
        meta.rssSourceId || sourceId,
        { rsshubBaseUrl },
        30
      );
      const items = (result.items || []).map((item, i) => ({
        id: `${meta.id}-${i}`,
        title: item.title,
        url: item.url,
        subtitle: [item.hotScore, item.summary].filter(Boolean).join(" · ") || meta.label
      }));
      if (items.length === 0) {
        return { ok: false, message: friendlyEmpty(meta.label, meta) };
      }
      const payload = {
        mode: "list",
        source: meta.id,
        label: meta.label,
        detail: meta.detail,
        fetchedAt: result.fetchedAt || fetchedAt,
        items,
        backend: "rss",
        notice: ""
      };
      await writeCachedPayload(sourceId, payload);
      return { ok: true, payload };
    } catch (e) {
      return { ok: false, message: friendlyMessage(meta.label, e) };
    }
  }

  // 4) Reddit 直连通道
  if (sourceId === "reddit") {
    const redditUrl = "https://www.reddit.com";
    if (await isBaseCoolingDown(redditUrl)) {
      return { ok: false, message: coolingMessage("Reddit") };
    }
    try {
      const payload = await fetchRedditHot(fetchedAt, meta);
      if (payload.items.length >= MIN_VALID_ITEMS) {
        await recordBaseSuccess(redditUrl);
        await writeCachedPayload(sourceId, payload);
        return { ok: true, payload };
      }
      await recordBaseFailure(redditUrl, "返回空列表");
      return { ok: false, message: friendlyEmpty("Reddit", meta) };
    } catch (e) {
      await recordBaseFailure(redditUrl, shortMessage(e));
      return { ok: false, message: friendlyMessage("Reddit", e) };
    }
  }

  // 5) 主链路：NewsNow（首选）→ 官方直连 → DailyHotApi（兜底），带后端健康度
  let payload = null;

  if (meta.newsNow) {
    const base = normalizeBase(newsnowBase, DEFAULT_NEWSNOW_BASE);
    if (await isBaseCoolingDown(base)) {
      errors.push(`NewsNow: 上次失败后冷却中（${COOLDOWN_MS / 60000} 分钟）`);
    } else {
      try {
        const candidate = await fetchNewsNowHot(fetchedAt, meta, base);
        if (candidate.items.length >= MIN_VALID_ITEMS) {
          payload = candidate;
          await recordBaseSuccess(base);
        } else {
          errors.push("NewsNow: 返回空列表");
          await recordBaseFailure(base, "空列表");
        }
      } catch (e) {
        errors.push(`NewsNow: ${shortMessage(e)}`);
        await recordBaseFailure(base, shortMessage(e));
      }
    }
  }

  if (!payload && meta.direct === "bilibili-ranking") {
    const biliBase = "https://api.bilibili.com";
    if (await isBaseCoolingDown(biliBase)) {
      errors.push("Bilibili 官方接口: 冷却中");
    } else {
      try {
        const candidate = await fetchBilibiliRanking(fetchedAt, meta);
        if (candidate.items.length >= MIN_VALID_ITEMS) {
          payload = candidate;
          await recordBaseSuccess(biliBase);
        } else {
          errors.push("Bilibili 官方接口: 返回空列表");
          await recordBaseFailure(biliBase, "空列表");
        }
      } catch (e) {
        errors.push(`Bilibili 官方接口: ${shortMessage(e)}`);
        await recordBaseFailure(biliBase, shortMessage(e));
      }
    }
  }

  if (!payload && meta.dailyhot) {
    const base = normalizeBase(dailyhotBase, DEFAULT_DAILYHOT_BASE);
    if (await isBaseCoolingDown(base)) {
      errors.push(`DailyHotApi: 兜底链路也在冷却（${COOLDOWN_MS / 60000} 分钟）`);
    } else {
      try {
        const candidate = await fetchDailyHotApi(fetchedAt, meta, base);
        if (candidate.items.length >= MIN_VALID_ITEMS) {
          payload = candidate;
          await recordBaseSuccess(base);
        } else {
          errors.push("DailyHotApi: 返回空列表");
          await recordBaseFailure(base, "空列表");
        }
      } catch (e) {
        errors.push(`DailyHotApi: ${shortMessage(e)}`);
        await recordBaseFailure(base, shortMessage(e));
      }
    }
  }

  if (payload) {
    await writeCachedPayload(sourceId, payload);
    return { ok: true, payload };
  }

  if (errors.length === 0) {
    return {
      ok: false,
      message: `「${meta.label}」暂未配置可用的数据接口，建议改用其他源（推荐：知乎热榜 / 微博热搜 / GitHub Trending），或在「设置 → 热点接口」填写自托 NewsNow / DailyHotApi 地址。`
    };
  }

  const allEmpty = errors.every((line) => line.includes("返回空列表"));
  const allCooling = errors.every((line) => line.includes("冷却"));
  let advice;
  if (allCooling) {
    advice = `所有候选后端都在冷却。建议在「设置 → 热点接口 → 测试连接」检查你的自托地址，或先换个源。`;
  } else if (allEmpty) {
    advice = `当前时段「${meta.label}」榜单可能没有新数据，可以稍后再试或换个源（推荐：知乎热榜 / GitHub Trending / 36氪）。`;
  } else {
    advice = `首选 NewsNow 与兜底 DailyHotApi 均不可达。建议在「设置 → 热点接口」点测试连接定位问题，或自部署一份 NewsNow（部署指南见 docs/SELFHOST_HOTTOPICS.md）。`;
  }

  return {
    ok: false,
    message: `「${meta.label}」拉取失败：${errors.join("；")}。${advice}`
  };
}

// ── DailyHotApi ──

async function fetchDailyHotApi(fetchedAt, meta, base) {
  const url = `${base}${meta.dailyhot}?cache=true`;
  const res = await fetchWithTimeout(url, {
    headers: { "User-Agent": UA, Accept: "application/json" }
  });

  if (!res.ok) throw new Error(`HTTP ${res.status}`);

  const json = await res.json().catch(() => null);
  if (!json) throw new Error("响应不是合法 JSON");
  if (json.code != null && Number(json.code) !== 200) {
    throw new Error(json.message || `code ${json.code}`);
  }

  const rawItems = Array.isArray(json.data) ? json.data : [];
  const items = [];
  for (let i = 0; i < rawItems.length && items.length < 35; i++) {
    const d = rawItems[i] || {};
    const title = String(d.title || "").trim();
    if (!title) continue;

    let link = d.url || d.mobileUrl || "";
    if (link && link.startsWith("bilibili://")) {
      link = `https://search.bilibili.com/all?keyword=${encodeURIComponent(title)}`;
    }

    const subtitleParts = [];
    if (d.hot != null) subtitleParts.push(`热度 ${formatHotValue(d.hot)}`);
    if (d.author) subtitleParts.push(String(d.author).slice(0, 24));
    if (d.desc) subtitleParts.push(String(d.desc).replace(/\s+/g, " ").slice(0, 50));

    items.push({
      id: `${meta.id}-${d.id || i}`,
      title,
      url: link,
      subtitle: subtitleParts.length ? subtitleParts.join(" · ") : `${meta.label}热榜`
    });
  }

  return {
    mode: "list",
    source: meta.id,
    label: meta.label,
    detail: meta.detail,
    fetchedAt,
    items,
    backend: "dailyhot",
    notice: ""
  };
}

// ── NewsNow ──
// NewsNow 实际返回结构（与 DailyHotApi 完全不同）：
//   { status: "success", id: "weibo", updatedTime: 1776..., items: [
//     { id, title, url, mobileUrl?, extra: { info?: "434 万热度", hover?: "描述", date? } }
//   ]}
// 失败时返回 { error: true, statusCode, statusMessage, message } 或 status:"error"

async function fetchNewsNowHot(fetchedAt, meta, base) {
  const url = `${base}api/s?id=${meta.newsNow}&latest`;
  const res = await fetchWithTimeout(url, {
    headers: { "User-Agent": UA, Accept: "application/json, text/plain, */*" }
  });

  if (!res.ok) throw new Error(`HTTP ${res.status}`);

  const json = await res.json().catch(() => null);
  if (!json) throw new Error("响应不是合法 JSON");

  // NewsNow 上游失败：上游网站反爬 / 限流时返回的标准错误
  if (json.error === true || (json.statusCode && json.statusCode >= 400)) {
    const upstreamMsg = String(json.message || json.statusMessage || `HTTP ${json.statusCode}`);
    throw new Error(`NewsNow 上游失败：${upstreamMsg.slice(0, 80)}`);
  }
  if (json.status && json.status !== "success") {
    throw new Error(`NewsNow 状态异常：${json.status}`);
  }

  const rawItems = Array.isArray(json.items) ? json.items : [];
  const items = [];

  for (let i = 0; i < rawItems.length && items.length < 35; i++) {
    const d = rawItems[i] || {};
    const title = String(d.title || "").trim();
    if (!title) continue;

    let link = d.url || d.mobileUrl || "";
    if (link && link.startsWith("bilibili://")) {
      link = `https://search.bilibili.com/all?keyword=${encodeURIComponent(title)}`;
    }

    // extra.info 是已格式化字符串："434 万热度" / "351 points" / "✰ 8,001"
    // extra.hover 是描述（如知乎的「问题简介」）
    const subtitleComponents = [];
    const info = d?.extra?.info;
    const hover = d?.extra?.hover;
    if (info) subtitleComponents.push(String(info).slice(0, 32));
    if (hover) subtitleComponents.push(String(hover).replace(/\s+/g, " ").slice(0, 50));

    items.push({
      id: `${meta.id}-${String(d.id || i).slice(0, 64)}`,
      title,
      url: link,
      subtitle: subtitleComponents.length ? subtitleComponents.join(" · ") : `${meta.label}热榜`
    });
  }

  return {
    mode: "list",
    source: meta.id,
    label: meta.label,
    detail: meta.detail,
    fetchedAt,
    items,
    backend: "newsnow",
    notice: ""
  };
}

// ── Bilibili 排行榜直连 ──

async function fetchBilibiliRanking(fetchedAt, meta) {
  const url = "https://api.bilibili.com/x/web-interface/ranking/v2?rid=0&type=all";
  const res = await fetchWithTimeout(url, {
    headers: {
      "User-Agent": UA,
      Accept: "application/json, text/plain, */*",
      Referer: "https://www.bilibili.com/v/popular/rank/all"
    }
  });

  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const json = await res.json().catch(() => null);
  if (!json) throw new Error("响应不是合法 JSON");
  if (json.code !== 0) throw new Error(json.message || `code ${json.code}`);

  const list = Array.isArray(json?.data?.list) ? json.data.list : [];
  const items = [];
  for (let i = 0; i < list.length && items.length < 35; i++) {
    const d = list[i] || {};
    const title = String(d.title || "").trim();
    if (!title) continue;

    const link = d.short_link_v2 || (d.bvid ? `https://www.bilibili.com/video/${d.bvid}` : "");
    const subtitleParts = [];
    if (d.owner?.name) subtitleParts.push(String(d.owner.name).slice(0, 20));
    if (d.stat?.view) subtitleParts.push(`播放 ${formatHotValue(d.stat.view)}`);
    if (d.stat?.like) subtitleParts.push(`点赞 ${formatHotValue(d.stat.like)}`);

    items.push({
      id: `bilibili-rank-${d.bvid || d.aid || i}`,
      title,
      url: link,
      subtitle: subtitleParts.length ? subtitleParts.join(" · ") : "B站排行榜"
    });
  }

  return {
    mode: "list",
    source: meta.id,
    label: meta.label,
    detail: meta.detail,
    fetchedAt,
    items,
    backend: "direct",
    notice: ""
  };
}

// ── Reddit ──

async function fetchRedditHot(fetchedAt, meta) {
  const url = "https://www.reddit.com/r/popular/hot.json?limit=35&raw_json=1";
  const res = await fetchWithTimeout(url, {
    headers: { "User-Agent": UA, Accept: "application/json" }
  });

  if (!res.ok) throw new Error(`HTTP ${res.status}`);

  const json = await res.json().catch(() => null);
  const children = json?.data?.children || [];
  const items = [];

  for (let i = 0; i < children.length && items.length < 30; i++) {
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
  }

  return {
    mode: "list",
    source: meta.id,
    label: meta.label,
    detail: meta.detail,
    fetchedAt,
    items,
    backend: "reddit",
    notice: ""
  };
}

// ── 门户引导 ──

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
    source: meta.id,
    label: meta.label,
    detail: meta.detail,
    fetchedAt,
    items: [],
    portal,
    backend: "portal",
    notice: "该平台无稳定极简 API，已为你链接到官方入口。"
  };
}

// ── 工具函数 ──

function normalizeBase(value, fallback) {
  const text = String(value || "").trim() || fallback;
  return text.endsWith("/") ? text : `${text}/`;
}

function shortMessage(error) {
  const text = String(error?.message || error || "未知错误");
  return text.length > 80 ? `${text.slice(0, 80)}…` : text;
}

function friendlyMessage(label, error) {
  const message = shortMessage(error);
  if (/abort/i.test(message)) {
    return `${label} 拉取超时（>${Math.round(FETCH_TIMEOUT_MS / 1000)}s），请检查网络或在设置里换个接口地址。`;
  }
  if (/failed to fetch|networkerror|load failed/i.test(message)) {
    return `${label} 无法连接，可能是网络受限或接口不可达。`;
  }
  return `${label} 拉取失败：${message}`;
}

function friendlyEmpty(label, meta) {
  return `${label} 当前没有返回任何榜单数据。可换个源（推荐：${meta?.id === "reddit" ? "Hacker News / GitHub Trending" : "知乎热榜 / 微博热搜"}）。`;
}

function formatHotValue(value) {
  const num = Number(value);
  if (!Number.isFinite(num) || num <= 0) return String(value);
  if (num >= 100000000) return `${(num / 100000000).toFixed(1)}亿`;
  if (num >= 10000) return `${(num / 10000).toFixed(1)}万`;
  return String(num);
}

async function fetchWithTimeout(url, init = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

export async function clearHotTopicsCache() {
  await clearCachedPayload();
}

export function backendLabel(id) {
  return BACKEND_LABEL[id] || id || "";
}

export async function getHotTopicsHealth() {
  return getHealthSnapshot();
}

/**
 * 测试一个热点接口 base URL 是否可用。
 * - kind: "dailyhot" | "newsnow"
 * - 用一个一定存在的轻量端点（DailyHot: zhihu，NewsNow: zhihu）
 * - 成功会清掉该 base 的失败计数；失败不计入冷却（避免用户测试本身把它点进冷却）
 */
export async function testHotTopicsBackend(kind, baseUrl) {
  const targetBase = normalizeBase(
    baseUrl,
    kind === "newsnow" ? DEFAULT_NEWSNOW_BASE : DEFAULT_DAILYHOT_BASE
  );
  const startedAt = Date.now();

  let url;
  if (kind === "newsnow") {
    url = `${targetBase}api/s?id=zhihu&latest`;
  } else {
    url = `${targetBase}zhihu?cache=true`;
  }

  try {
    const res = await fetchWithTimeout(url, {
      headers: { "User-Agent": UA, Accept: "application/json" }
    });
    const latencyMs = Date.now() - startedAt;
    if (!res.ok) {
      return { ok: false, latencyMs, base: targetBase, message: `HTTP ${res.status}` };
    }
    const json = await res.json().catch(() => null);
    if (!json) {
      return { ok: false, latencyMs, base: targetBase, message: "响应不是合法 JSON" };
    }
    // NewsNow 失败结构：{ error: true, statusCode, message }
    if (json.error === true || (json.statusCode && json.statusCode >= 400)) {
      const upstreamMsg = String(json.message || json.statusMessage || `HTTP ${json.statusCode}`);
      return {
        ok: false,
        latencyMs,
        base: targetBase,
        message: `上游失败：${upstreamMsg.slice(0, 80)}`
      };
    }
    // NewsNow 返回 items[]，DailyHotApi 返回 data[]，都覆盖
    const items = kind === "newsnow" ? json?.items : json?.data;
    const count = Array.isArray(items) ? items.length : 0;
    if (count === 0) {
      return {
        ok: false,
        latencyMs,
        base: targetBase,
        message: "接口连通但返回空列表，可能是上游被限流或路径不对"
      };
    }
    await recordBaseSuccess(targetBase);
    return {
      ok: true,
      latencyMs,
      base: targetBase,
      message: `OK · 共 ${count} 条数据`
    };
  } catch (e) {
    return {
      ok: false,
      latencyMs: Date.now() - startedAt,
      base: targetBase,
      message: shortMessage(e)
    };
  }
}

function coolingMessage(label) {
  return `${label} 上次拉取连续失败，已临时冷却 ${COOLDOWN_MS / 60000} 分钟避免请求轰炸。可以先换个源，或到「设置 → 热点接口」点测试连接。`;
}
