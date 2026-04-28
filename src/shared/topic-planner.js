/**
 * src/shared/topic-planner.js
 * ====================================================================
 * AI 选题规划机制 —— 纯函数模块（不依赖 chrome.* / DOM / 网络）。
 *
 * 推荐流水线：
 *   候选池标准化（normalizeCandidates）
 *      ↓
 *   硬过滤（hardFilterCandidates）—— 算法过滤掉 ≈ 70% 噪音，
 *                                   保证 AI 拿到的 12-20 条都是「能写、能发、不踩雷」的优质素材
 *      ↓
 *   8 维评分（scoreCandidates）
 *      ↓
 *   多样性筛选（applyDiversityFilter）—— 同事件最多 2 条 / 单平台不超 40% / 类型全覆盖
 *      ↓
 *   AI 选题总监（buildTopicDirectorMessages → 调 LLM → parseTopicDirectorOutput）
 *      ↓
 *   推荐卡片
 *
 * 设计纪律：
 *   - 所有函数纯净：相同输入 → 相同输出，无副作用，方便 smoke 单测。
 *   - 评分不依赖 LLM：硬过滤 + 评分 + 多样性都是确定性算法，AI 只做"把判断写成人话"。
 *   - 抗幻觉：LLM 输出必须经 parseTopicDirectorOutput 校验 itemId 是否在 candidatePool 里，
 *     不在的全部丢掉，保证 AI 不能凭空捏造一条不存在的热点。
 */

import {
  TOPIC_PROFILE_CATEGORIES,
  TOPIC_PROFILE_ARTICLE_TYPES,
  TOPIC_PROFILE_RISK_LEVELS,
  ARTICLE_TYPE_TO_TEMPLATE
} from "./defaults.js";

// =====================================================================
// 常量与小工具
// =====================================================================

/**
 * 各源的「质量底分」(0-1)。该分会进入评分公式 sourceQuality 维度。
 * 取值经验：
 *   - 高质量、低标题党：澎湃 / 36kr / 雪球 / 华尔街见闻 / 少数派 / arxiv ≈ 0.85+
 *   - 中等：知乎 / 微博 / 头条 / IT之家 / B站搜索 ≈ 0.55-0.7
 *   - 易标题党：抖音 / 贴吧 / 虎扑 / 酷安 ≈ 0.35-0.5
 * 没列在这里的源默认 0.6（中性）。
 */
export const SOURCE_QUALITY_SCORE = Object.freeze({
  // 高质
  thepaper: 0.9,
  "36kr": 0.88,
  wallstreetcn: 0.88,
  xueqiu: 0.85,
  sspai: 0.88,
  juejin: 0.78,
  ithome: 0.75,
  hackernews: 0.85,
  "hackernews-rss": 0.88,
  techcrunch: 0.85,
  theverge: 0.82,
  "arxiv-ai": 0.92,
  "arxiv-ml": 0.92,
  "import-ai": 0.85,
  leiphone: 0.78,
  zaobao: 0.82,
  github: 0.85,
  hellogithub: 0.8,
  csdn: 0.65,
  huxiu: 0.78,
  // 中
  zhihu: 0.65,
  weibo: 0.55,
  baidu: 0.55,
  toutiao: 0.55,
  v2ex: 0.7,
  producthunt: 0.78,
  bilibili: 0.6,
  bilibili_rank: 0.6,
  netease: 0.55,
  weread: 0.7,
  reddit: 0.65,
  cls: 0.78,
  nodeseek: 0.7,
  "ml-mastery": 0.72,
  "towards-ds": 0.72,
  // 易标题党
  douyin: 0.4,
  tieba: 0.4,
  hupu: 0.45,
  coolapk: 0.5,
  douban_movie: 0.55,
  douban_group: 0.45,
  acfun: 0.4,
  tencent: 0.55
});

/**
 * 内置「硬过滤」黑名单关键词（不区分大小写，匹配标题/副标题）。
 * 用户在画像里勾选 exclusions 类别后，会按映射关系再追加额外词。
 *
 * 这些词命中后 → 直接从候选池剔除，不进入评分阶段，AI 看不到。
 */
export const BUILTIN_BLACKLIST_KEYWORDS = Object.freeze([
  // 灰产 / 引流广告
  "兼职", "包赚", "日赚", "返利", "代购", "招代理", "薅羊毛", "薅毛",
  // 黄赌毒 / 性暗示
  "约炮", "性感", "诱惑", "情趣", "兼职模特", "色情", "成人",
  // 宿命论 / 玄学营销
  "命中注定", "运势", "塔罗", "本命年大忌",
  // 过度悲剧化
  "惨死", "猝死", "悲剧", "尸体", "现场惨烈",
  // 刷量内容
  "震惊", "速看", "马上删", "赶紧收藏", "国家最新通知"
]);

/**
 * 用户画像 exclusions 大类 → 额外关键词映射。
 * 命中即整条剔除。
 */
export const EXCLUSION_KEYWORDS = Object.freeze({
  celebrity: [
    "明星", "塌房", "出轨", "离婚", "绯闻", "撕逼", "粉丝大战",
    "顶流", "回怼", "炒 cp", "狗仔", "私生饭"
  ],
  politics: [
    "政治", "中央", "总书记", "国家主席", "外交部", "白宫", "议员",
    "战争", "军演", "导弹", "制裁", "选举", "示威"
  ],
  vulgar: [
    "三俗", "低俗", "辱华", "嘲讽", "互喷", "性别对立",
    "地图炮", "网暴"
  ],
  negative: [
    "自杀", "跳楼", "凶杀", "灭门", "虐待", "尸体", "惨案",
    "崩溃", "绝望"
  ],
  ad: [
    "限时优惠", "双 11", "双十一", "618", "黑五", "抢购",
    "新品上线", "首发", "种草", "团购"
  ]
});

/**
 * 通用「标题党」penalty 词。命中不剔除，但 readerValue / sourceQuality 各扣 0.15。
 */
export const CLICKBAIT_PENALTY_KEYWORDS = Object.freeze([
  "震惊", "万万没想到", "速看", "全网炸锅", "惊呆了",
  "看完哭了", "不敢相信", "竟然", "居然", "炸了",
  "你不知道", "千万别", "马上删除", "速删"
]);

/**
 * 简易词标准化：去 URL、emoji、多空格，转小写。仅用于关键词匹配 / 去重哈希。
 */
function normalizeText(text) {
  return String(text || "")
    .replace(/https?:\/\/\S+/g, "")
    .replace(/[\u{1F300}-\u{1FAFF}]/gu, "")
    .replace(/[【】\[\]「」#]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

function containsAny(text, keywords) {
  if (!text) return false;
  const lowered = text.toLowerCase();
  return keywords.some((kw) => kw && lowered.includes(String(kw).toLowerCase()));
}

/**
 * 简单的去重 group key：取标准化后前 12 个字符做哈希信号。
 * 同一事件经常多个平台标题略有差异，前 12 字差不多能命中 70% 同事件。
 * 真正强的 dedup 应该用 SimHash，但当前规模没必要。
 */
function makeDuplicateGroupKey(title) {
  const norm = normalizeText(title).slice(0, 12);
  return norm || "_empty_";
}

// =====================================================================
// 1) 候选池标准化
// =====================================================================

/**
 * 把多个源 fetchHotTopics 返回的 payload 摊平成统一字段的 candidate 数组。
 *
 * 入参：
 *   sourcePayloads: Array<{ sourceId, label, items }>  —— 每个元素来自一次 fetchHotTopics
 *   sourceMeta:     Object<sourceId, { id, label, category, ... }>   —— HOT_SOURCE_META
 *
 * 出参：CandidateItem[]，字段：
 *   id, source, sourceLabel, rank, title, url, subtitle, fetchedAt,
 *   hasUrl, sourceQuality, categoryGuess, duplicateGroupId, raw
 */
export function normalizeCandidates(sourcePayloads, sourceMeta) {
  const out = [];
  if (!Array.isArray(sourcePayloads)) return out;
  let cursor = 0;
  for (const payload of sourcePayloads) {
    if (!payload || !Array.isArray(payload.items)) continue;
    const sourceId = payload.sourceId || payload.source || "";
    const meta = sourceMeta?.[sourceId] || null;
    const sourceLabel = meta?.label || payload.label || sourceId;
    const categoryGuess = meta?.category || "unknown";
    const sourceQuality =
      typeof SOURCE_QUALITY_SCORE[sourceId] === "number"
        ? SOURCE_QUALITY_SCORE[sourceId]
        : 0.6;
    const fetchedAt = payload.fetchedAt || new Date().toISOString();
    payload.items.forEach((item, idx) => {
      const title = String(item?.title || "").trim();
      if (!title) return;
      const url = String(item?.url || "").trim();
      const subtitle = String(item?.subtitle || "").trim();
      const id = String(item?.id || `${sourceId}-${idx}-${cursor++}`);
      out.push({
        id,
        source: sourceId,
        sourceLabel,
        rank: idx + 1,
        title,
        url,
        subtitle,
        fetchedAt,
        hasUrl: Boolean(url) && /^https?:\/\//i.test(url),
        sourceQuality,
        categoryGuess,
        duplicateGroupId: makeDuplicateGroupKey(title),
        raw: item
      });
    });
  }
  return out;
}

// =====================================================================
// 2) 硬过滤
// =====================================================================

/**
 * 硬过滤：把以下条目从候选池中剔除（不进入评分）：
 *   - 标题为空 / 重复
 *   - 命中黑名单关键词（内置 + 用户排除大类）
 *   - 用户自定义 excludeKeywords 命中
 *   - hasUrl=false：保留但标记 needsManualSource=true（提示 AI 这条只能"提纲开稿"）
 *
 * 同时：同 duplicateGroupId 只保留最高排名（rank 最小）的那条，其余进入 rejected。
 */
export function hardFilterCandidates(items, profile) {
  const exclusionKeywords = collectExclusionKeywords(profile);
  const seenTitles = new Set();
  const groupBest = new Map();
  const kept = [];
  const rejected = [];

  for (const item of items) {
    if (!item || !item.title) continue;
    const titleKey = normalizeText(item.title);
    if (!titleKey) continue;
    if (seenTitles.has(titleKey)) {
      rejected.push({ item, reason: "exact_dedup" });
      continue;
    }
    seenTitles.add(titleKey);
    const haystack = `${item.title} ${item.subtitle || ""}`;
    if (containsAny(haystack, BUILTIN_BLACKLIST_KEYWORDS)) {
      rejected.push({ item, reason: "blacklist" });
      continue;
    }
    if (exclusionKeywords.length && containsAny(haystack, exclusionKeywords)) {
      rejected.push({ item, reason: "user_exclusion" });
      continue;
    }
    const groupId = item.duplicateGroupId;
    const prev = groupBest.get(groupId);
    if (!prev || item.rank < prev.rank) {
      if (prev) {
        rejected.push({ item: prev, reason: "group_dedup" });
      }
      groupBest.set(groupId, item);
    } else {
      rejected.push({ item, reason: "group_dedup" });
    }
  }
  for (const item of groupBest.values()) {
    kept.push({ ...item, needsManualSource: !item.hasUrl });
  }
  return { kept, rejected };
}

function collectExclusionKeywords(profile) {
  const list = new Set();
  for (const id of profile?.exclusions || []) {
    for (const kw of EXCLUSION_KEYWORDS[id] || []) {
      list.add(kw);
    }
  }
  for (const raw of profile?.excludeKeywords || []) {
    const trimmed = String(raw || "").trim();
    if (trimmed) list.add(trimmed);
  }
  return Array.from(list);
}

// =====================================================================
// 3) 8 维评分
// =====================================================================

/**
 * 评分公式（权重总和 = 1.0）：
 *   worthScore = 0.24 * topicFit       —— 与画像「内容领域 / 文章类型 / 受众」契合
 *              + 0.18 * writeability    —— 一句话能不能扩成一篇文章
 *              + 0.15 * readerValue     —— 读者读完是否有收获/有谈资
 *              + 0.12 * timeliness      —— 时效，越新越加分（fetchedAt 距今）
 *              + 0.10 * heat            —— 平台热度（rank 倒数）
 *              + 0.08 * novelty         —— 新鲜度（与历史规划重复程度）
 *              + 0.08 * sourceQuality   —— 源质量
 *              + 0.05 * riskControl     —— 与用户风险偏好一致度
 *
 * 每一维都返回 0-1 之间的分数。
 */
export function scoreCandidates(items, profile, options = {}) {
  const { now = Date.now(), historyTitles = [] } = options;
  const historySet = new Set((historyTitles || []).map(normalizeText));
  const allowedCategorySet = new Set(
    (profile?.contentPillars || []).flatMap((id) =>
      TOPIC_PROFILE_CATEGORIES[id]?.sourceCategories || []
    )
  );
  const articleTypeSet = new Set(profile?.articleTypes || []);
  const riskMeta =
    TOPIC_PROFILE_RISK_LEVELS.find((r) => r.id === profile?.risk) ||
    TOPIC_PROFILE_RISK_LEVELS[1];

  return items.map((item) => {
    const breakdown = {
      topicFit: scoreTopicFit(item, allowedCategorySet, articleTypeSet),
      writeability: scoreWriteability(item),
      readerValue: scoreReaderValue(item),
      timeliness: scoreTimeliness(item, now),
      heat: scoreHeat(item),
      novelty: scoreNovelty(item, historySet),
      sourceQuality: clamp01(item.sourceQuality),
      riskControl: scoreRiskControl(item, riskMeta)
    };

    // 标题党 penalty：命中即对 readerValue + sourceQuality 各扣 0.15
    if (containsAny(item.title, CLICKBAIT_PENALTY_KEYWORDS)) {
      breakdown.readerValue = clamp01(breakdown.readerValue - 0.15);
      breakdown.sourceQuality = clamp01(breakdown.sourceQuality - 0.15);
    }

    const worthScore =
      0.24 * breakdown.topicFit +
      0.18 * breakdown.writeability +
      0.15 * breakdown.readerValue +
      0.12 * breakdown.timeliness +
      0.10 * breakdown.heat +
      0.08 * breakdown.novelty +
      0.08 * breakdown.sourceQuality +
      0.05 * breakdown.riskControl;

    return {
      ...item,
      worthScore: Number(worthScore.toFixed(4)),
      breakdown
    };
  });
}

function clamp01(n) {
  const v = Number(n);
  if (!Number.isFinite(v)) return 0;
  if (v < 0) return 0;
  if (v > 1) return 1;
  return v;
}

function scoreTopicFit(item, allowedCategorySet, articleTypeSet) {
  let score = 0.5; // 基础分（用户没填画像或类别没命中时的中位）
  if (allowedCategorySet.size > 0 && allowedCategorySet.has(item.categoryGuess)) {
    score += 0.35;
  }
  // 文章类型契合：根据标题特征做粗粒度匹配（教程类含「教程/指南/上手」、深度类含「为何/真相/解读」等）
  if (articleTypeSet.size > 0) {
    const t = item.title;
    const matches = inferArticleTypes(t);
    if (matches.some((m) => articleTypeSet.has(m))) {
      score += 0.15;
    }
  }
  return clamp01(score);
}

function inferArticleTypes(title) {
  const t = title || "";
  const out = [];
  if (/教程|指南|上手|入门|怎么|如何|how to/i.test(t)) out.push("tutorial");
  if (/避坑|陷阱|警告|防骗|被坑|套路/i.test(t)) out.push("warning");
  if (/对比|测评|横评|实测|评测|review|vs /i.test(t)) out.push("review");
  if (/为何|真相|解读|背后|深度|分析|原因|底层/i.test(t)) out.push("deep_analysis");
  if (/故事|经历|讲述|回忆|手记|自述/i.test(t)) out.push("story");
  if (/最新|发布|宣布|今天|今日|快讯|首发/i.test(t)) out.push("news_brief");
  return out;
}

function scoreWriteability(item) {
  let score = 0.5;
  // 一篇文章的最低条件：标题足够具体（长度 > 8）
  const len = item.title.length;
  if (len < 6) score -= 0.25;
  else if (len > 14) score += 0.15;
  // 副标题/摘要存在：方便扩写
  if (item.subtitle && item.subtitle.length > 6) score += 0.1;
  // 含具体名词（人名、产品名、数字）：好写
  if (/\d|[A-Z][a-zA-Z]{2,}|公司|发布|宣布|推出/.test(item.title)) score += 0.1;
  // 含问句/感叹：通常情绪化、不易扩写为可信文章
  if (/[？?！!]/.test(item.title)) score -= 0.05;
  // 没 URL → 写不出有事实支撑的稿
  if (!item.hasUrl) score -= 0.2;
  return clamp01(score);
}

function scoreReaderValue(item) {
  let score = 0.55;
  const t = item.title;
  if (/教程|指南|上手|对比|测评|实测|为何|背后|解读/.test(t)) score += 0.15;
  if (/吃瓜|塌房|曝光|绯闻|撕|互撕/.test(t)) score -= 0.15;
  if (/榜单|排行|趋势/.test(t)) score += 0.05;
  return clamp01(score);
}

function scoreTimeliness(item, now) {
  const fetched = Date.parse(item.fetchedAt);
  if (!Number.isFinite(fetched)) return 0.5;
  const ageMs = Math.max(0, now - fetched);
  // 6h 内 1.0；12h 0.8；24h 0.5；48h 0.2；72h+ 0
  const ageH = ageMs / (60 * 60 * 1000);
  if (ageH <= 6) return 1;
  if (ageH <= 12) return 0.8;
  if (ageH <= 24) return 0.5;
  if (ageH <= 48) return 0.2;
  return 0;
}

function scoreHeat(item) {
  // rank=1 → 1.0；rank=10 → 0.5；rank=20+ → 0.2
  const r = Number(item.rank) || 1;
  if (r <= 1) return 1;
  if (r >= 30) return 0.15;
  return clamp01(1 - (r - 1) / 30);
}

function scoreNovelty(item, historySet) {
  if (historySet.size === 0) return 0.7;
  const norm = normalizeText(item.title);
  if (historySet.has(norm)) return 0.1;
  // 近似命中（前 8 个字相同）
  for (const h of historySet) {
    if (norm.length >= 8 && h.length >= 8 && norm.slice(0, 8) === h.slice(0, 8)) {
      return 0.3;
    }
  }
  return 0.85;
}

function scoreRiskControl(item, riskMeta) {
  // 以 risk weight 作为基线，稳健话题（含数据/榜单/教程）+0.1，争议话题（含撕/吵/对立）-0.2 / +0.1（按 risk）
  const t = item.title;
  let base = riskMeta?.weight ?? 0.5;
  if (/教程|指南|榜单|对比|实测|发布|宣布|数据/.test(t)) base += 0.08;
  if (/争议|互撕|对立|撕逼|开撕/.test(t)) {
    if (riskMeta?.id === "bold") base += 0.05;
    else base -= 0.2;
  }
  return clamp01(base);
}

// =====================================================================
// 4) 多样性筛选
// =====================================================================

/**
 * 在已经按 worthScore 排好序的候选里，挑出 topN 满足：
 *   - 同 duplicateGroupId 最多 2 条
 *   - 单平台占比 ≤ 40%（topN < 4 时退化为 ≤ 2）
 *   - 文章类型尽量多样（按 inferArticleTypes 推断）
 */
export function applyDiversityFilter(scoredItems, profile, opts = {}) {
  const desired = clampInt(opts.topN ?? profile?.outputCount ?? 5, 1, 30);
  const sorted = [...scoredItems].sort((a, b) => b.worthScore - a.worthScore);

  const platformCap =
    desired < 4
      ? Math.max(2, Math.floor(desired * 0.6))
      : Math.max(2, Math.ceil(desired * 0.4));

  const selected = [];
  const platformCount = new Map();
  const groupCount = new Map();
  const articleTypeCount = new Map();

  // 先做一遍贪心：跳过把单平台/单事件配额打满的条目
  for (const item of sorted) {
    if (selected.length >= desired) break;
    const platHits = platformCount.get(item.source) || 0;
    if (platHits >= platformCap) continue;
    const grpHits = groupCount.get(item.duplicateGroupId) || 0;
    if (grpHits >= 2) continue;
    selected.push(item);
    platformCount.set(item.source, platHits + 1);
    groupCount.set(item.duplicateGroupId, grpHits + 1);
    inferArticleTypes(item.title).forEach((t) =>
      articleTypeCount.set(t, (articleTypeCount.get(t) || 0) + 1)
    );
  }

  // 不够 topN：放宽平台 cap 兜底（防止候选太集中导致结果太少）
  if (selected.length < desired) {
    for (const item of sorted) {
      if (selected.length >= desired) break;
      if (selected.includes(item)) continue;
      const grpHits = groupCount.get(item.duplicateGroupId) || 0;
      if (grpHits >= 2) continue;
      selected.push(item);
      platformCount.set(item.source, (platformCount.get(item.source) || 0) + 1);
      groupCount.set(item.duplicateGroupId, grpHits + 1);
    }
  }

  return selected;
}

function clampInt(n, min, max) {
  const v = Math.round(Number(n));
  if (!Number.isFinite(v)) return min;
  if (v < min) return min;
  if (v > max) return max;
  return v;
}

// =====================================================================
// 5) 来源映射：根据画像自动选源
// =====================================================================

/**
 * 根据用户画像 contentPillars 推断该自动跑哪些热点源。
 *
 * 入参：
 *   profile.contentPillars: ["tech_ai","finance",...]
 *   sourceMeta            : HOT_SOURCE_META
 * 出参：sourceId 数组（去重，每个 category 最多取 limitPerCategory 个）
 */
export function resolveAutoSourceIds(profile, sourceMeta, opts = {}) {
  const limit = opts.maxSources ?? 8;
  const limitPerCategory = opts.maxPerCategory ?? 4;
  const categoryWanted = new Set();
  for (const pillarId of profile?.contentPillars || []) {
    for (const c of TOPIC_PROFILE_CATEGORIES[pillarId]?.sourceCategories || []) {
      categoryWanted.add(c);
    }
  }
  // 用户没填画像 → 给一个通用默认池
  if (categoryWanted.size === 0) {
    return ["zhihu", "weibo", "thepaper", "ithome", "36kr", "sspai"].filter(
      (id) => sourceMeta?.[id]
    );
  }
  const buckets = new Map();
  for (const [id, meta] of Object.entries(sourceMeta || {})) {
    if (!meta?.category || !categoryWanted.has(meta.category)) continue;
    const arr = buckets.get(meta.category) || [];
    arr.push(id);
    buckets.set(meta.category, arr);
  }
  // 每个 category 优先挑 SOURCE_QUALITY_SCORE 高的，截断 limitPerCategory
  const out = [];
  for (const cat of categoryWanted) {
    const sorted = (buckets.get(cat) || [])
      .sort(
        (a, b) =>
          (SOURCE_QUALITY_SCORE[b] || 0.6) - (SOURCE_QUALITY_SCORE[a] || 0.6)
      )
      .slice(0, limitPerCategory);
    out.push(...sorted);
  }
  // 与用户手动添加的 manualSourceIds 合并 + 去重 + 截断
  const merged = Array.from(
    new Set([...out, ...(profile?.manualSourceIds || [])])
  ).slice(0, limit);
  return merged;
}

// =====================================================================
// 6) AI 选题总监 prompt 构造
// =====================================================================

/**
 * 构造给 LLM 的「选题总监」系统/用户消息。
 * candidates 必须已经过算法层评分 + 多样性筛选（典型 12-20 条）。
 *
 * 关键策略：
 *   - system 给出强约束：只能从 candidates 里挑、必须输出固定 JSON、给出拒绝模式
 *   - user 把候选 + 画像打包成结构化 JSON，避免 LLM 误解
 */
export function buildTopicDirectorMessages(profile, candidates, opts = {}) {
  const reroll = opts.reroll || null;
  const desired = reroll ? 1 : clampInt(profile?.outputCount ?? 5, 1, 10);
  const aiSafePool = candidates.map((c) => ({
    itemId: c.id,
    title: c.title,
    source: c.sourceLabel,
    rank: c.rank,
    worthScore: c.worthScore,
    hasUrl: c.hasUrl,
    subtitle: c.subtitle || "",
    breakdown: c.breakdown || null
  }));

  const rerollLines = reroll
    ? [
        "",
        "⚠️ 本次任务为「换一个角度」模式：",
        `- 必须为 itemId="${reroll.itemId}" 这一条重新出 1 条推荐。`,
        `- 上一次给的角度是：「${reroll.previousAngle || "（无）"}」，本次必须给一个明显不同的切入角度。`,
        "- recommendedTopics 数组长度必须正好为 1，且 itemId 必须等于上面给定值。",
        "- 不要换条目、不要凑数。"
      ]
    : [];

  const systemPrompt = [
    "你是一名公众号主编 + 选题总监。你的任务是从给定候选热点里挑选并解释",
    `${desired} 条最值得这个公众号写的选题。`,
    "",
    "硬性纪律（违反将被判定为输出失败）：",
    "1. 只能从「candidatePool」里挑，不允许引入任何不在池中的话题。",
    "2. 不得编造事实、数字、人名、引语；提纲里出现的所有信息必须能回到候选标题/副标题。",
    "3. 不写「最近网上一个流行话题…」这种含混转述，必须指明 itemId。",
    "4. 优先「能写、能发、不踩雷」，不优先「最热」。",
    "5. recommendedTopics 必须严格按 worthScore 推荐价值排序，最值得写的放第一条。",
    "6. 每条都必须有 risk 提示，哪怕是「无明显风险」也要明写。",
    "7. 不要附加任何解释或 Markdown，输出必须是合法 JSON。",
    ...rerollLines,
    "",
    "JSON Schema：",
    JSON.stringify(
      {
        strategySummary: "string，<=120 字，告诉用户「我为什么挑这一组」",
        recommendedTopics: [
          {
            itemId: "string，必须来自 candidatePool",
            originalTitle: "string，照抄候选标题",
            scoreReason: "string，<=80 字，引用候选 breakdown 解释为什么值得写",
            recommendedAngle: "string，<=80 字，建议从哪个切口写",
            articleType: "string，one of: news_brief|deep_analysis|tutorial|warning|review|story",
            outline: ["string", "string", "string"],
            titleCandidates: ["string", "string", "string"],
            riskNotes: "string，<=60 字，写明合规/版权/争议点",
            confidence: "number，0~1，越高越值得写",
            templateHint: "string，可空。如果你强烈推荐某个改写模板 id，可在此说明"
          }
        ],
        rejectedPatterns: ["string"]
      },
      null,
      2
    )
  ].join("\n");

  const userPrompt = [
    "公众号选题画像：",
    JSON.stringify(serializeProfile(profile), null, 2),
    "",
    `请从下列候选池里挑选并解释 ${desired} 条值得写的选题。`,
    "candidatePool（已经过算法硬过滤、8 维评分与多样性筛选；breakdown 是 8 维子分数）：",
    JSON.stringify(aiSafePool, null, 2)
  ].join("\n");

  return [
    { role: "system", content: systemPrompt },
    { role: "user", content: userPrompt }
  ];
}

function serializeProfile(profile) {
  if (!profile) return {};
  return {
    contentPillars: profile.contentPillars || [],
    purpose: profile.purpose || "",
    articleTypes: profile.articleTypes || [],
    audiences: profile.audiences || [],
    tone: profile.tone || "",
    risk: profile.risk || "normal",
    exclusions: profile.exclusions || [],
    excludeKeywords: profile.excludeKeywords || [],
    outputCount: profile.outputCount || 5
  };
}

// =====================================================================
// 7) AI 输出解析 + 抗幻觉
// =====================================================================

/**
 * 解析 LLM 返回文本：
 *   1) 抽 JSON（容忍包在 ```json ... ``` 里的情况）
 *   2) 校验 itemId 必须在 candidatePool 里 —— 不在的整条丢弃（防幻觉）
 *   3) 校验 articleType 必须在白名单里，否则置空
 *   4) outline / titleCandidates 必须是数组且非空，否则该条 reject
 *   5) 用 ARTICLE_TYPE_TO_TEMPLATE 给每条补默认 templateId
 */
export function parseTopicDirectorOutput(rawText, candidates) {
  const candidateMap = new Map(candidates.map((c) => [c.id, c]));
  const articleTypeIds = new Set(TOPIC_PROFILE_ARTICLE_TYPES.map((t) => t.id));
  const json = extractJson(rawText);
  if (!json || typeof json !== "object") {
    return {
      ok: false,
      reason: "AI 返回不是合法 JSON",
      strategySummary: "",
      recommendedTopics: [],
      rejectedPatterns: []
    };
  }

  const recommended = [];
  const droppedReasons = [];
  for (const raw of Array.isArray(json.recommendedTopics) ? json.recommendedTopics : []) {
    if (!raw || typeof raw !== "object") {
      droppedReasons.push("non_object");
      continue;
    }
    const itemId = String(raw.itemId || "").trim();
    const matched = candidateMap.get(itemId);
    if (!matched) {
      droppedReasons.push(`hallucinated_itemId:${itemId.slice(0, 32)}`);
      continue;
    }
    const outline = sanitizeStringArray(raw.outline);
    const titleCandidates = sanitizeStringArray(raw.titleCandidates);
    if (outline.length === 0) {
      droppedReasons.push(`empty_outline:${itemId}`);
      continue;
    }
    const articleType = articleTypeIds.has(raw.articleType) ? raw.articleType : "";
    const templateId =
      ARTICLE_TYPE_TO_TEMPLATE[articleType] || raw.templateHint || "";
    const confidenceNum = Number(raw.confidence);
    recommended.push({
      itemId,
      candidate: matched,
      originalTitle: String(raw.originalTitle || matched.title || "").trim(),
      scoreReason: clipString(raw.scoreReason, 200),
      recommendedAngle: clipString(raw.recommendedAngle, 200),
      articleType,
      outline,
      titleCandidates,
      riskNotes: clipString(raw.riskNotes, 200) || "无明显风险",
      confidence: Number.isFinite(confidenceNum)
        ? Math.max(0, Math.min(1, confidenceNum))
        : 0.6,
      templateHint: String(raw.templateHint || "").trim(),
      suggestedTemplateId: templateId
    });
  }

  return {
    ok: recommended.length > 0,
    reason: recommended.length === 0 ? "AI 未给出任何能落地的推荐" : "",
    strategySummary: clipString(json.strategySummary, 400),
    recommendedTopics: recommended,
    rejectedPatterns: sanitizeStringArray(json.rejectedPatterns),
    diagnostics: {
      droppedReasons
    }
  };
}

function sanitizeStringArray(value) {
  if (!Array.isArray(value)) return [];
  const out = [];
  for (const v of value) {
    const s = String(v || "").trim();
    if (s) out.push(s.length > 200 ? s.slice(0, 200) : s);
  }
  return out;
}

function clipString(value, max) {
  const s = String(value || "").trim();
  if (!s) return "";
  return s.length > max ? `${s.slice(0, max)}…` : s;
}

function extractJson(text) {
  if (!text) return null;
  const trimmed = String(text).trim();
  if (!trimmed) return null;
  // 直接 JSON
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
    try {
      return JSON.parse(trimmed);
    } catch {
      // continue
    }
  }
  // ```json ... ```
  const fence = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) {
    try {
      return JSON.parse(fence[1].trim());
    } catch {
      // continue
    }
  }
  // 抓第一个 { ... } 或 [ ... ]
  const objMatch = trimmed.match(/(\{[\s\S]*\}|\[[\s\S]*\])/);
  if (objMatch) {
    try {
      return JSON.parse(objMatch[1]);
    } catch {
      return null;
    }
  }
  return null;
}

// =====================================================================
// 8) 给「提纲开稿」用的 capture 构造器
// =====================================================================

/**
 * 把 AI 选题总监输出的某一条推荐打包成一个「虚拟 capture」，
 * 写入 session.lastCapture 后，workspace.html?import=1 就能像处理真实抓取一样进入工作台，
 * 但里面的 source.kind = "outline"，让 workspace-rewrite.js 知道走「提纲开稿」流程。
 *
 * 用途：
 *   1) 用户主动选择「用提纲开稿」按钮
 *   2) SCRAPE_BACKGROUND_AND_IMPORT 抓取失败时的兜底
 */
export function buildOutlineCapture(recommendation, profile) {
  if (!recommendation) return null;
  const candidate = recommendation.candidate || {};
  const blocks = [];
  if (recommendation.recommendedAngle) {
    blocks.push({
      type: "paragraph",
      text: `【AI 建议切入角度】${recommendation.recommendedAngle}`
    });
  }
  blocks.push({
    type: "heading",
    level: 2,
    text: "AI 选题总监建议提纲"
  });
  for (const point of recommendation.outline || []) {
    blocks.push({ type: "paragraph", text: `- ${point}` });
  }
  if (recommendation.riskNotes) {
    blocks.push({
      type: "paragraph",
      text: `【风险提示】${recommendation.riskNotes}`
    });
  }
  if (recommendation.scoreReason) {
    blocks.push({
      type: "paragraph",
      text: `【为什么值得写】${recommendation.scoreReason}`
    });
  }
  const description =
    recommendation.scoreReason || recommendation.recommendedAngle || "";
  return {
    kind: "outline",
    title: recommendation.originalTitle || candidate.title || "AI 选题草案",
    url: candidate.url || "",
    description,
    siteName: candidate.sourceLabel || "AI 选题规划",
    wordCount: blocks.reduce((sum, b) => sum + String(b.text || "").length, 0),
    images: [],
    blocks,
    capturedAt: new Date().toISOString(),
    captureMode: "outline",
    plannerMeta: {
      itemId: recommendation.itemId,
      articleType: recommendation.articleType,
      suggestedTemplateId: recommendation.suggestedTemplateId,
      titleCandidates: recommendation.titleCandidates,
      profileSnapshot: serializeProfile(profile)
    }
  };
}
