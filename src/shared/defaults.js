export const STORAGE_KEYS = {
  settings: "wechatWriterSettings",
  session: "wechatWriterSession",
  draftHistory: "__draft_history",
  promptTemplates: "wechatWriterPromptTemplates",
  activeTemplateId: "wechatWriterActiveTemplateId",
  // AI 选题规划：用户画像问卷答案（每次打开「AI 智能选题」回填）+ 上次规划缓存
  topicProfile: "wechatWriterTopicProfile",
  topicPlanCache: "wechatWriterTopicPlanCache",
  // 「我的文风」样本库。单独走一个 key 而不挤进 settings，
  // 因为 raw 字段可能存几千字原文，混在 settings 里每次保存都要全量重写整个 settings，
  // 不必要地放大 chrome.storage.local 的 IO；选中态（activeVoiceSampleId）仍然在 settings 里。
  voiceSamples: "wechatWriterVoiceSamples"
};

// =====================================================================
// AI 选题规划（topic-planner）相关常量
// =====================================================================

/**
 * 选题画像问卷的「内容领域」选项 → HOT_SOURCE_META.category 的映射。
 * 用户在画像里勾选「科技 AI」时，自动从 hot-topics-sources.js 的 category="tech"+"ai" 源里
 * 抽 6-8 个默认源进入候选池；用户也可以手动覆盖。
 *
 * 没列在这里的领域（如「情感故事」）退化为「china」综合社区源 + 用户手动添加。
 */
export const TOPIC_PROFILE_CATEGORIES = Object.freeze({
  tech_ai: { label: "科技 AI", sourceCategories: ["tech", "ai"] },
  finance: { label: "财经商业", sourceCategories: ["finance", "tech"] },
  knowledge: { label: "知识科普", sourceCategories: ["tech", "ai", "china"] },
  lifestyle: { label: "生活方式", sourceCategories: ["china", "video"] },
  emotional: { label: "情感故事", sourceCategories: ["china"] },
  culture: { label: "文化评论", sourceCategories: ["china", "world"] },
  local: { label: "本地资讯", sourceCategories: ["china", "world"] }
});

export const TOPIC_PROFILE_PURPOSES = Object.freeze([
  { id: "growth", label: "涨粉" },
  { id: "conversion", label: "转化" },
  { id: "expertise", label: "建立专业感" },
  { id: "discussion", label: "引发讨论" },
  { id: "search", label: "长期搜索流量" }
]);

export const TOPIC_PROFILE_ARTICLE_TYPES = Object.freeze([
  { id: "news_brief", label: "热点评论" },
  { id: "deep_analysis", label: "深度解读" },
  { id: "tutorial", label: "教程拆解" },
  { id: "warning", label: "避坑指南" },
  { id: "review", label: "测评对比" },
  { id: "story", label: "故事化表达" }
]);

export const TOPIC_PROFILE_AUDIENCES = Object.freeze([
  { id: "beginner", label: "小白" },
  { id: "practitioner", label: "从业者" },
  { id: "manager", label: "管理者" },
  { id: "creator", label: "创作者" },
  { id: "student", label: "学生" },
  { id: "family", label: "家庭用户" }
]);

export const TOPIC_PROFILE_TONES = Object.freeze([
  { id: "restrained", label: "克制分析" },
  { id: "sharp", label: "犀利评论" },
  { id: "warm", label: "温暖故事" },
  { id: "casual", label: "轻松口语" },
  { id: "professional", label: "专业科普" }
]);

export const TOPIC_PROFILE_RISK_LEVELS = Object.freeze([
  { id: "conservative", label: "保守", weight: 0.2 },
  { id: "normal", label: "正常", weight: 0.5 },
  { id: "bold", label: "敢写争议", weight: 0.85 }
]);

export const TOPIC_PROFILE_EXCLUSIONS = Object.freeze([
  { id: "celebrity", label: "娱乐八卦" },
  { id: "politics", label: "政治敏感" },
  { id: "vulgar", label: "低俗争议" },
  { id: "negative", label: "纯负面" },
  { id: "ad", label: "广告软文" }
]);

export const TOPIC_PROFILE_OUTPUT_COUNTS = Object.freeze([3, 5, 10]);

/**
 * 推荐文章类型 → 默认 prompt template id 的映射。
 * 用户没主动选择改写模板时，按 AI 选题总监建议的 articleType 自动绑定。
 * 用户在热点页 chip 已经选了模板 → 优先用用户选的，AI 建议仅提示不强改。
 */
export const ARTICLE_TYPE_TO_TEMPLATE = Object.freeze({
  news_brief: "preset-news-brief",
  deep_analysis: "preset-deep-analysis",
  tutorial: "preset-tutorial",
  warning: "preset-news-brief",      // 避坑指南没有专门预设，新闻速读最近
  review: "preset-deep-analysis",     // 测评对比退到深度解读
  story: "preset-storytelling"
});

/**
 * 选题画像默认值。所有字段在用户首次打开「AI 智能选题」时为空，
 * 用户保存后落到 chrome.storage.local 的 wechatWriterTopicProfile。
 *
 * 字段说明：
 *  - contentPillars / articleTypes / audiences / exclusions：多选，存 id 数组
 *  - purpose / tone：单选，存 id 字符串
 *  - risk：单选 conservative / normal / bold（默认 normal）
 *  - outputCount：3 / 5 / 10（默认 5）
 *  - manualSourceIds：用户在「自动选源」基础上手动加入的源 id 数组（覆盖默认）
 *  - excludeKeywords：自定义排除词（除上面 5 个预设大类外的关键词，逗号分隔的字符串数组）
 *  - updatedAt：最近一次保存时间（ms），用于 UI 显示「上次规划：YYYY-MM-DD HH:mm」
 */
export const DEFAULT_TOPIC_PROFILE = Object.freeze({
  contentPillars: [],
  purpose: "",
  articleTypes: [],
  audiences: [],
  tone: "",
  risk: "normal",
  exclusions: [],
  excludeKeywords: [],
  manualSourceIds: [],
  outputCount: 5,
  updatedAt: 0
});

export const DEFAULT_SETTINGS = {
  productName: "润笔",
  operatorName: "",
  supportEmail: "",
  officialSiteUrl: "",
  apiBaseUrl: "https://api.openai.com/v1/chat/completions",
  apiKey: "",
  model: "gpt-4.1-mini",
  temperature: 0.8,
  // OpenAI 兼容的高级生成参数。空字符串 = 不下发该字段，让服务端用默认值。
  // 经验值（推荐去 AI 味档位）：top_p 0.92 / frequency_penalty 0.5 / presence_penalty 0.3。
  // 在 OpenAI / OpenRouter / DeepSeek / Kimi / Qwen / MiniMax / 智谱 GLM 等
  // 主流 OpenAI 兼容服务上都可下发；留空也能兼容只认 temperature 的旧服务
  // （如某些自部署 Ollama / vLLM 网关）。
  topP: "",
  frequencyPenalty: "",
  presencePenalty: "",
  // 「去 AI 味」二次润色 pass。默认开启，PRO 用户实际生效；
  // 免费版即使 humanizeEnabled=true 也会被 license 闸门拒绝，回退主 pass 结果。
  humanizeEnabled: true,
  // 强度档位：
  //  - light：只重写 lint 命中权重最高的 1 段，省时省 token
  //  - medium：重写所有 lint 命中段 + lead；零命中时退化成全段（默认）
  //  - strong：全段 + lead，且强制注入 voice sample
  humanizeIntensity: "medium",
  // 主 pass lint 分数 ≥ 此阈值时整篇跳过二次润色 pass，避免给"已经够干净"的稿子白花钱。
  // 阈值 85 = 主 pass 命中 ≤ 1 条 error 或 ≤ 3 条 warn。设 100 则始终跑 S2，0 则永不跳过。
  humanizeSkipScore: 85,
  // humanize-pass 段级并发上限。默认 6 在 OpenAI / Anthropic / DeepSeek / 阿里 DashScope 等
  // 主流服务上安全；自部署 vLLM/Ollama 限流时调到 1–2 即可回退顺序执行。
  humanizeMaxConcurrency: 6,
  // 当前激活的「我的文风」样本 id；空字符串 = 不注入。
  activeVoiceSampleId: "",
  defaultAudience: "关注商业、效率和 AI 工具的公众号读者",
  defaultTone: "专业、可信、像有判断的编辑在写",
  defaultLength: "medium",
  defaultAngle: "提炼观点，重组结构，保留事实",
  defaultCta: "在结尾给出一个可执行的行动建议",
  wechatAppId: "",
  wechatAppSecret: "",
  wechatDefaultAuthor: "",
  wechatDefaultSourceUrl: "",
  wechatDefaultPublishMode: "draft",
  wechatDefaultOpenComment: false,
  wechatDefaultOnlyFansCanComment: false,
  wechatProfiles: [],
  activeWechatProfileIndex: -1,
  // 微信 API base（P1.3 · IP 白名单代理）。空字符串 = 走官方 https://api.weixin.qq.com，
  // 适合公网 IP 已加白名单的场景。如果用户家用动态 IP 进不了白名单，
  // 推荐走「阿里云函数计算 FC 代理」，把 FC 域名填到这里，FC 出口 IP 段是阿里云固定段，
  // 一次性加进公众号后台白名单后所有 cgi-bin/* 接口就都通了。
  // 完整部署文档：aliyun-fc/wechat-api-proxy/README.md
  wechatApiBase: "",
  // 公众号群发策略（P1.2 · 让认证账号文章显示到公众号列表）。
  //   "none" → 仅走 freepublish/submit，不调群发。文章不显示在列表，关注者无通知。
  //   "all"  → add_draft → mass/sendall(is_to_all=true)。群发全员、进列表，但**每月最多 4 次**。
  //   "tag"  → add_draft → mass/sendall(is_to_all=false, tag_id)。群发指定标签，进列表，不计入月配额。
  //
  // 注：mass/sendall 仅认证服务号可用；订阅号 / 未认证账号会报 48001/53400。
  // 默认 "none" 是安全行为，不会让旧用户在 2026-04 后突然吃配额。
  wechatSendStrategy: "none",
  wechatSendTagId: 0,
  wechatSendIgnoreReprint: false,
  // 公众号「本月已用 mass/sendall(is_to_all=true) 群发次数」的本地计数器（P1.2 配额可视化）。
  // 微信侧没有提供查询当月已用次数的接口，所以只能在扩展端自维护一个估算计数：
  // 每次成功调用 sendall(is_to_all=true) +1，进入新自然月时由 UI 自动 reset 到 0。
  wechatSendAllUsageMonth: "",
  wechatSendAllUsageCount: 0,
  hotTopicsNewsnowBase: "",
  // DrissionPage 增强抓取（可选）。需要本地启动一个 helper 服务，
  // 走 Chromium 真实环境抓取，可绕过部分前端反爬/懒加载页面。
  // 默认关闭；开启时也会保留"内置抓取兜底"，所以即使 helper 挂掉也不至于全链路失败。
  drissionEnabled: false,
  drissionHelperUrl: "",
  // 配置健康度摘要：复用最近一次「测试连接」的结果，让用户在设置页顶部一眼看到
  // 三条关键链路（AI / 公众号 / 桌面助手）的状态。各字段在用户主动点测试连接前
  // 都是 null（UI 显示「未测试」）。schema：
  //   ai:       { ok: bool, ts: number, model: string, latencyMs: number, error: string }
  //   wechat:   { ok: bool, ts: number, errcode: number|null, error: string }
  //   drission: { ok: bool, ts: number, error: string }
  lastTestResult: { ai: null, wechat: null, drission: null },
  // 本地 helper 的鉴权 token。粘贴含 ?token=… 的完整地址时，
  // src/shared/drission.js 的 normalizeDrissionHelperUrl 会自动拆出 token
  // 并由 options.js 在 saveSettings 之前同步到这个字段。
  // 留空 = helper 也未开启鉴权（兼容老用户），扩展不会附带 X-Runbi-Helper-Token。
  drissionHelperToken: "",
  drissionTimeoutMs: 30000
};

export const DEFAULT_ARTICLE_META = {
  title: "",
  subtitle: "",
  lead: "",
  cta: "",
  author: "",
  digest: "",
  contentSourceUrl: "",
  coverImageIndex: 0,
  titleOptions: [],
  keywords: [],
  needOpenComment: false,
  onlyFansCanComment: false,
  publishMode: "draft"
};

export const MAX_WECHAT_ARTICLES = 8;
export const WECHAT_WEB_EDITOR_URL = "https://mp.weixin.qq.com/cgi-bin/appmsg";

// 公众号发布通道（profile.mode）：
//   "api"     → 走官方 cgi-bin/draft/add，需要 appId+AppSecret，要求出口 IP 加白名单
//   "browser" → 浏览器登录模式：复用用户已登录的 mp 后台，DOM 注入编辑器；不调 cgi-bin，
//               不需要 IP 白名单。最后一步「保存草稿」由用户在 mp 后台手动点（合规底线）。
// 缺失字段视为 "api"（向后兼容历史 profile）。
export const WECHAT_PROFILE_MODES = Object.freeze(["api", "browser"]);
export const DEFAULT_WECHAT_PROFILE_MODE_NEW = "browser";

/**
 * 把任意来源的 profile 标准化成 { name, appId, appSecret, author, mode } 形态。
 * 关键约束：缺失 mode 默认 "api"（保护历史 profile），未知 mode 也回落 "api"。
 *
 * @param {object|null|undefined} profile
 * @returns {{ name: string, appId: string, appSecret: string, author: string, mode: "api"|"browser" }}
 */
export function normalizeWechatProfile(profile) {
  const raw = profile && typeof profile === "object" ? profile : {};
  const mode = WECHAT_PROFILE_MODES.includes(raw.mode) ? raw.mode : "api";
  return {
    name: typeof raw.name === "string" ? raw.name : "",
    appId: typeof raw.appId === "string" ? raw.appId : "",
    appSecret: typeof raw.appSecret === "string" ? raw.appSecret : "",
    author: typeof raw.author === "string" ? raw.author : "",
    mode
  };
}

export const DEFAULT_SESSION = {
  lastSourceTabId: null,
  lastSourceTitle: "",
  lastSourceUrl: "",
  lastCapture: null,
  lastDraft: null,
  articleBundle: [],
  currentArticleIndex: 0,
  lastBodyHtml: "",
  lastArticleMeta: DEFAULT_ARTICLE_META,
  lastTheme: "editorial-green",
  lastPublishResult: null,
  lastWebSyncResult: null,
  selectedImageIndex: 0
};

export const LENGTH_LABELS = {
  short: "800-1200 字",
  medium: "1200-1800 字",
  long: "1800-2600 字"
};

// 与 LENGTH_LABELS 对齐的数字区间，用于 AI 改写完成后做"实际字数 vs 期望区间"校验。
// 容差比 prompt 里写的 ±15% 更宽（±20%）：当实际偏差超过 20% 才标 warn，避免误报。
export const LENGTH_RANGES = {
  short: { min: 800, max: 1200 },
  medium: { min: 1200, max: 1800 },
  long: { min: 1800, max: 2600 }
};
export const LENGTH_TOLERANCE = 0.2;

export const THEME_PRESETS = {
  "editorial-green": {
    label: "新叶专栏",
    root:
      "font-family:'IBM Plex Sans','PingFang SC','Hiragino Sans GB',sans-serif;color:#203127;line-height:1.9;font-size:16px;background:#fffdf7;padding:32px 24px;border:1px solid #d7dbc8;border-radius:24px;",
    h1:
      "font-family:'Source Han Serif SC','Noto Serif SC',serif;font-size:34px;line-height:1.25;color:#18351f;margin:0 0 14px;font-weight:700;letter-spacing:0.02em;",
    subtitle:
      "font-size:15px;line-height:1.8;color:#5f6e61;margin:0 0 20px;padding-bottom:18px;border-bottom:1px solid #d7dbc8;",
    lead:
      "font-size:18px;line-height:1.95;color:#233528;background:#f3f5ea;border-left:4px solid #6b8f71;padding:16px 18px;border-radius:14px;margin:0 0 22px;",
    h2:
      "font-family:'Source Han Serif SC','Noto Serif SC',serif;font-size:25px;line-height:1.45;color:#173722;margin:34px 0 14px;padding-left:14px;border-left:5px solid #6b8f71;",
    h3:
      "font-size:19px;line-height:1.6;color:#284136;margin:24px 0 12px;font-weight:700;",
    p: "margin:0 0 16px;color:#243328;",
    blockquote:
      "margin:22px 0;padding:18px 22px;background:#f3f5ea;border-radius:16px;color:#2d4535;border:1px solid #d7dbc8;",
    list: "margin:0 0 18px 0;padding-left:1.35em;color:#243328;",
    li: "margin:0 0 10px;",
    figure:
      "margin:28px 0;padding:14px;background:#f8f6ef;border:1px solid #e5dfcf;border-radius:18px;",
    image:
      "display:block;width:100%;border-radius:12px;object-fit:cover;max-height:460px;background:#edf1e4;",
    figcaption:
      "margin-top:10px;font-size:13px;color:#7a745f;text-align:center;line-height:1.7;",
    hr: "border:none;border-top:1px solid #d7dbc8;margin:26px 0;",
    strong: "color:#173722;font-weight:700;",
    cta:
      "margin-top:30px;padding:18px 20px;background:#18351f;color:#f6f5ef;border-radius:18px;"
  },
  "modern-amber": {
    label: "琥珀简报",
    root:
      "font-family:'IBM Plex Sans','PingFang SC','Hiragino Sans GB',sans-serif;color:#28211b;line-height:1.85;font-size:16px;background:#fffaf2;padding:32px 24px;border:1px solid #eadcc7;border-radius:24px;",
    h1:
      "font-family:'Source Han Serif SC','Noto Serif SC',serif;font-size:34px;line-height:1.24;color:#2f2214;margin:0 0 14px;font-weight:700;",
    subtitle:
      "font-size:15px;line-height:1.8;color:#7d6a58;margin:0 0 20px;padding-bottom:18px;border-bottom:1px solid #eadcc7;",
    lead:
      "font-size:18px;line-height:1.95;color:#38281c;background:#fff1dd;border-left:4px solid #cf8c43;padding:16px 18px;border-radius:14px;margin:0 0 22px;",
    h2:
      "font-family:'Source Han Serif SC','Noto Serif SC',serif;font-size:25px;line-height:1.45;color:#2c2118;margin:34px 0 14px;padding-bottom:8px;border-bottom:2px solid #cf8c43;",
    h3:
      "font-size:19px;line-height:1.6;color:#5b3f23;margin:24px 0 12px;font-weight:700;",
    p: "margin:0 0 16px;color:#2b231d;",
    blockquote:
      "margin:22px 0;padding:18px 22px;background:#fff1dd;border-radius:16px;color:#563d29;border:1px solid #eadcc7;",
    list: "margin:0 0 18px 0;padding-left:1.35em;color:#2b231d;",
    li: "margin:0 0 10px;",
    figure:
      "margin:28px 0;padding:14px;background:#fff7eb;border:1px solid #eadcc7;border-radius:18px;",
    image:
      "display:block;width:100%;border-radius:12px;object-fit:cover;max-height:460px;background:#f5ecde;",
    figcaption:
      "margin-top:10px;font-size:13px;color:#90745c;text-align:center;line-height:1.7;",
    hr: "border:none;border-top:1px solid #eadcc7;margin:26px 0;",
    strong: "color:#5b3f23;font-weight:700;",
    cta:
      "margin-top:30px;padding:18px 20px;background:#4b3119;color:#fff9f0;border-radius:18px;"
  },
  "minimal-mono": {
    label: "极简灰白",
    root:
      "font-family:'IBM Plex Sans','PingFang SC','Hiragino Sans GB',sans-serif;color:#1a1a1a;line-height:1.9;font-size:16px;background:#ffffff;padding:32px 24px;border:1px solid #e6e6e6;border-radius:18px;",
    h1:
      "font-family:'Source Han Serif SC','Noto Serif SC',serif;font-size:32px;line-height:1.25;color:#0a0a0a;margin:0 0 12px;font-weight:700;letter-spacing:0.01em;",
    subtitle:
      "font-size:15px;line-height:1.8;color:#7b7b7b;margin:0 0 22px;padding-bottom:18px;border-bottom:1px solid #ededed;",
    lead:
      "font-size:17px;line-height:1.95;color:#1a1a1a;background:#f7f7f7;border-left:3px solid #1a1a1a;padding:14px 18px;border-radius:6px;margin:0 0 22px;",
    h2:
      "font-family:'Source Han Serif SC','Noto Serif SC',serif;font-size:24px;line-height:1.4;color:#0a0a0a;margin:32px 0 12px;font-weight:700;",
    h3:
      "font-size:18px;line-height:1.6;color:#1a1a1a;margin:22px 0 10px;font-weight:700;",
    p: "margin:0 0 16px;color:#1a1a1a;",
    blockquote:
      "margin:22px 0;padding:14px 18px;background:#f7f7f7;border-left:3px solid #999;border-radius:6px;color:#3a3a3a;",
    list: "margin:0 0 18px 0;padding-left:1.35em;color:#1a1a1a;",
    li: "margin:0 0 8px;",
    figure:
      "margin:26px 0;padding:0;background:transparent;border:none;border-radius:0;",
    image:
      "display:block;width:100%;border-radius:8px;object-fit:cover;max-height:460px;background:#f0f0f0;",
    figcaption:
      "margin-top:8px;font-size:13px;color:#888;text-align:center;line-height:1.7;",
    hr: "border:none;border-top:1px solid #e6e6e6;margin:24px 0;",
    strong: "color:#0a0a0a;font-weight:700;",
    cta:
      "margin-top:30px;padding:18px 20px;background:#0a0a0a;color:#fff;border-radius:10px;"
  },
  "warm-rose": {
    label: "暖玫瑰",
    root:
      "font-family:'IBM Plex Sans','PingFang SC','Hiragino Sans GB',sans-serif;color:#3d1f24;line-height:1.85;font-size:16px;background:#fff8f6;padding:32px 24px;border:1px solid #f0d8d3;border-radius:24px;",
    h1:
      "font-family:'Source Han Serif SC','Noto Serif SC',serif;font-size:34px;line-height:1.24;color:#4a1a26;margin:0 0 14px;font-weight:700;",
    subtitle:
      "font-size:15px;line-height:1.8;color:#946f72;margin:0 0 20px;padding-bottom:18px;border-bottom:1px solid #f0d8d3;",
    lead:
      "font-size:18px;line-height:1.95;color:#3d1f24;background:#fff0ec;border-left:4px solid #c4566c;padding:16px 18px;border-radius:14px;margin:0 0 22px;",
    h2:
      "font-family:'Source Han Serif SC','Noto Serif SC',serif;font-size:25px;line-height:1.45;color:#4a1a26;margin:34px 0 14px;padding-left:14px;border-left:5px solid #c4566c;",
    h3:
      "font-size:19px;line-height:1.6;color:#723244;margin:24px 0 12px;font-weight:700;",
    p: "margin:0 0 16px;color:#3d1f24;",
    blockquote:
      "margin:22px 0;padding:18px 22px;background:#fff0ec;border-radius:16px;color:#5e2434;border:1px solid #f0d8d3;",
    list: "margin:0 0 18px 0;padding-left:1.35em;color:#3d1f24;",
    li: "margin:0 0 10px;",
    figure:
      "margin:28px 0;padding:14px;background:#fff5f1;border:1px solid #f0d8d3;border-radius:18px;",
    image:
      "display:block;width:100%;border-radius:12px;object-fit:cover;max-height:460px;background:#f5e0db;",
    figcaption:
      "margin-top:10px;font-size:13px;color:#a6707b;text-align:center;line-height:1.7;",
    hr: "border:none;border-top:1px solid #f0d8d3;margin:26px 0;",
    strong: "color:#4a1a26;font-weight:700;",
    cta:
      "margin-top:30px;padding:18px 20px;background:#4a1a26;color:#fff5f1;border-radius:18px;"
  },
  "tech-blue": {
    label: "深海观察",
    root:
      "font-family:'IBM Plex Sans','PingFang SC','Hiragino Sans GB',sans-serif;color:#12253d;line-height:1.85;font-size:16px;background:#f8fbff;padding:32px 24px;border:1px solid #d7e4f2;border-radius:24px;",
    h1:
      "font-family:'Source Han Serif SC','Noto Serif SC',serif;font-size:34px;line-height:1.24;color:#10253f;margin:0 0 14px;font-weight:700;",
    subtitle:
      "font-size:15px;line-height:1.8;color:#5f7892;margin:0 0 20px;padding-bottom:18px;border-bottom:1px solid #d7e4f2;",
    lead:
      "font-size:18px;line-height:1.95;color:#16314d;background:#eef6ff;border-left:4px solid #4f83c2;padding:16px 18px;border-radius:14px;margin:0 0 22px;",
    h2:
      "font-family:'Source Han Serif SC','Noto Serif SC',serif;font-size:25px;line-height:1.45;color:#0f2944;margin:34px 0 14px;padding-left:14px;border-left:5px solid #4f83c2;",
    h3:
      "font-size:19px;line-height:1.6;color:#274b74;margin:24px 0 12px;font-weight:700;",
    p: "margin:0 0 16px;color:#12253d;",
    blockquote:
      "margin:22px 0;padding:18px 22px;background:#eef6ff;border-radius:16px;color:#1c3b5d;border:1px solid #d7e4f2;",
    list: "margin:0 0 18px 0;padding-left:1.35em;color:#12253d;",
    li: "margin:0 0 10px;",
    figure:
      "margin:28px 0;padding:14px;background:#f3f8fe;border:1px solid #d7e4f2;border-radius:18px;",
    image:
      "display:block;width:100%;border-radius:12px;object-fit:cover;max-height:460px;background:#dbe7f2;",
    figcaption:
      "margin-top:10px;font-size:13px;color:#6482a4;text-align:center;line-height:1.7;",
    hr: "border:none;border-top:1px solid #d7e4f2;margin:26px 0;",
    strong: "color:#0f2944;font-weight:700;",
    cta:
      "margin-top:30px;padding:18px 20px;background:#10253f;color:#f5fbff;border-radius:18px;"
  },

  // ===================================================================
  // 杂志级排版母版（v0.4 新增）
  // 设计原则：禁圆角色块、禁 border-left 装饰条、禁渐变；多用 hairline、
  // 字号节奏对比、留白、衬线/无衬线混排、全大写小标。
  // 公众号 inline-style 限制：不能引外部 web font，伪类失效，所有装饰
  // 必须是真实 inline 属性。所以"段首下沉"等效果交给 prompt 端引导
  // LLM 在第一段开头插 <span style=...> 实现。
  // ===================================================================

  // 1) The New Yorker · 纯白衬线经典
  "editorial-newyorker": {
    label: "新刊衬线 · The New Yorker",
    root:
      "font-family:'Source Han Serif SC','Noto Serif SC','Songti SC',serif;color:#1a1a1a;line-height:1.95;font-size:17px;background:#ffffff;padding:36px 28px;border:none;border-radius:0;",
    h1:
      "font-family:'Source Han Serif SC','Noto Serif SC','Songti SC',serif;font-size:38px;line-height:1.18;color:#000;margin:0 0 18px;font-weight:700;letter-spacing:-0.01em;",
    subtitle:
      "font-family:'Helvetica Neue','Arial',sans-serif;font-size:12px;line-height:1.7;color:#666;margin:0 0 28px;padding-bottom:0;border-bottom:none;letter-spacing:0.18em;text-transform:uppercase;",
    lead:
      "font-family:'Source Han Serif SC','Noto Serif SC',serif;font-size:19px;line-height:2;color:#1a1a1a;background:transparent;border:none;border-radius:0;border-top:1px solid #000;border-bottom:1px solid #000;padding:18px 0;margin:0 0 28px;font-style:italic;",
    h2:
      "font-family:'Source Han Serif SC','Noto Serif SC',serif;font-size:24px;line-height:1.35;color:#000;margin:40px 0 14px;padding:0;border:none;font-weight:700;",
    h3:
      "font-family:'Helvetica Neue','Arial',sans-serif;font-size:13px;line-height:1.6;color:#000;margin:28px 0 12px;font-weight:700;letter-spacing:0.18em;text-transform:uppercase;",
    p: "margin:0 0 18px;color:#1a1a1a;text-align:justify;",
    blockquote:
      "margin:32px 12% 32px 0;padding:0 0 0 24px;background:transparent;border:none;border-left:2px solid #000;border-radius:0;color:#000;font-family:'Source Han Serif SC','Noto Serif SC',serif;font-size:22px;line-height:1.55;font-style:italic;",
    list: "margin:0 0 20px 0;padding-left:1.35em;color:#1a1a1a;",
    li: "margin:0 0 8px;",
    figure:
      "margin:32px 0;padding:0;background:transparent;border:none;border-radius:0;",
    image:
      "display:block;width:100%;border-radius:0;object-fit:cover;max-height:520px;background:#f4f4f4;",
    figcaption:
      "margin-top:10px;font-family:'Source Han Serif SC','Noto Serif SC',serif;font-size:13px;color:#666;text-align:left;line-height:1.65;font-style:italic;",
    hr: "border:none;border-top:1px solid #000;margin:36px 25% 36px 25%;",
    strong: "color:#000;font-weight:700;",
    cta:
      "margin-top:40px;padding:20px 0;background:transparent;color:#000;border-top:2px solid #000;border-bottom:2px solid #000;border-radius:0;text-align:center;font-family:'Helvetica Neue','Arial',sans-serif;font-size:13px;letter-spacing:0.2em;text-transform:uppercase;font-weight:700;"
  },

  // 2) Kinfolk · 奶白极简静语
  "kinfolk-quiet": {
    label: "静语生活 · Kinfolk",
    root:
      "font-family:'Helvetica Neue','PingFang SC','Hiragino Sans GB',sans-serif;color:#3a342d;line-height:2.05;font-size:16px;background:#faf8f3;padding:48px 32px;border:none;border-radius:0;",
    h1:
      "font-family:'Helvetica Neue','Arial',sans-serif;font-size:30px;line-height:1.35;color:#2a241d;margin:0 0 28px;font-weight:300;letter-spacing:0.02em;text-align:center;",
    subtitle:
      "font-size:11px;line-height:1.8;color:#a8a094;margin:0 auto 36px;text-align:center;padding-bottom:0;border-bottom:none;letter-spacing:0.32em;text-transform:uppercase;font-weight:400;",
    lead:
      "font-size:17px;line-height:2.1;color:#5a5147;background:transparent;border:none;border-radius:0;padding:0;margin:0 auto 36px;text-align:center;max-width:520px;font-weight:300;",
    h2:
      "font-family:'Helvetica Neue','Arial',sans-serif;font-size:13px;line-height:1.6;color:#2a241d;margin:48px 0 18px;padding:0;border:none;font-weight:600;letter-spacing:0.28em;text-transform:uppercase;text-align:center;",
    h3:
      "font-family:'Helvetica Neue','Arial',sans-serif;font-size:16px;line-height:1.6;color:#3a342d;margin:30px 0 12px;font-weight:500;letter-spacing:0.04em;",
    p: "margin:0 0 22px;color:#3a342d;font-weight:300;",
    blockquote:
      "margin:36px auto;padding:0;background:transparent;border:none;border-radius:0;color:#5a5147;font-size:20px;line-height:1.7;font-weight:300;font-style:normal;text-align:center;max-width:540px;",
    list: "margin:0 0 22px 0;padding-left:1.4em;color:#3a342d;font-weight:300;",
    li: "margin:0 0 10px;",
    figure:
      "margin:40px 0;padding:0;background:transparent;border:none;border-radius:0;",
    image:
      "display:block;width:100%;border-radius:0;object-fit:cover;max-height:560px;background:#efe9dc;",
    figcaption:
      "margin-top:14px;font-size:11px;color:#a8a094;text-align:center;line-height:1.8;letter-spacing:0.24em;text-transform:uppercase;font-weight:400;",
    hr: "border:none;border-top:1px solid #e0d8c8;margin:40px 30% 40px 30%;",
    strong: "color:#2a241d;font-weight:500;",
    cta:
      "margin-top:48px;padding:24px 0;background:transparent;color:#5a5147;border:none;border-top:1px solid #d4c9b3;border-bottom:1px solid #d4c9b3;border-radius:0;text-align:center;font-size:12px;letter-spacing:0.32em;text-transform:uppercase;font-weight:500;"
  },

  // 3) Wired · 黑底荧光科技
  "wired-neon": {
    label: "霓虹科技 · Wired",
    root:
      "font-family:'Helvetica Neue','PingFang SC','Hiragino Sans GB',sans-serif;color:#f0f0f0;line-height:1.78;font-size:16px;background:#0b0b0b;padding:36px 28px;border:none;border-radius:0;",
    h1:
      "font-family:'Helvetica Neue','Arial Black','Impact',sans-serif;font-size:42px;line-height:1.05;color:#ffffff;margin:0 0 16px;font-weight:900;letter-spacing:-0.02em;text-transform:uppercase;",
    subtitle:
      "font-family:'SFMono-Regular','Menlo','Consolas',monospace;font-size:12px;line-height:1.7;color:#d6ff44;margin:0 0 26px;padding-bottom:0;border-bottom:none;letter-spacing:0.14em;text-transform:uppercase;",
    lead:
      "font-size:18px;line-height:1.85;color:#e8e8e8;background:transparent;border:none;border-left:4px solid #d6ff44;border-radius:0;padding:6px 0 6px 18px;margin:0 0 28px;font-weight:400;",
    h2:
      "font-family:'Helvetica Neue','Arial Black',sans-serif;font-size:26px;line-height:1.25;color:#ffffff;margin:40px 0 14px;padding:0;border:none;font-weight:900;letter-spacing:-0.01em;text-transform:uppercase;",
    h3:
      "font-family:'SFMono-Regular','Menlo','Consolas',monospace;font-size:13px;line-height:1.6;color:#d6ff44;margin:30px 0 10px;font-weight:600;letter-spacing:0.12em;text-transform:uppercase;",
    p: "margin:0 0 18px;color:#e0e0e0;",
    blockquote:
      "margin:30px 0;padding:0 0 0 22px;background:transparent;border:none;border-left:4px solid #d6ff44;border-radius:0;color:#ffffff;font-family:'Helvetica Neue','Arial',sans-serif;font-size:22px;line-height:1.45;font-weight:700;letter-spacing:-0.01em;",
    list: "margin:0 0 20px 0;padding-left:1.35em;color:#e0e0e0;",
    li: "margin:0 0 8px;",
    figure:
      "margin:30px 0;padding:0;background:transparent;border:1px solid #2a2a2a;border-radius:0;",
    image:
      "display:block;width:100%;border-radius:0;object-fit:cover;max-height:520px;background:#1a1a1a;",
    figcaption:
      "margin:0;padding:10px 12px;font-family:'SFMono-Regular','Menlo',monospace;font-size:11px;color:#888;text-align:left;line-height:1.7;letter-spacing:0.08em;text-transform:uppercase;background:#1a1a1a;",
    hr: "border:none;border-top:1px solid #2a2a2a;margin:32px 0;",
    strong: "color:#d6ff44;font-weight:700;",
    cta:
      "margin-top:36px;padding:20px;background:#d6ff44;color:#0b0b0b;border:none;border-radius:0;font-family:'Helvetica Neue','Arial Black',sans-serif;font-weight:900;letter-spacing:0.04em;text-transform:uppercase;"
  },

  // 4) Monocle · 杏色商业编辑感
  "monocle-soft": {
    label: "杏色商业 · Monocle",
    root:
      "font-family:'Source Han Serif SC','Noto Serif SC',serif;color:#1c2740;line-height:1.92;font-size:16px;background:#f5ede0;padding:38px 28px;border:none;border-radius:0;",
    h1:
      "font-family:'Source Han Serif SC','Noto Serif SC',serif;font-size:34px;line-height:1.22;color:#0f1d33;margin:0 0 16px;font-weight:700;letter-spacing:-0.005em;",
    subtitle:
      "font-family:'Helvetica Neue','Arial',sans-serif;font-size:11px;line-height:1.75;color:#a18a5e;margin:0 0 30px;padding-bottom:14px;border-bottom:1px solid #cdb78b;letter-spacing:0.24em;text-transform:uppercase;font-weight:600;",
    lead:
      "font-family:'Source Han Serif SC','Noto Serif SC',serif;font-size:19px;line-height:1.95;color:#1c2740;background:transparent;border:none;border-radius:0;padding:0;margin:0 0 30px;font-style:italic;",
    h2:
      "font-family:'Source Han Serif SC','Noto Serif SC',serif;font-size:24px;line-height:1.35;color:#0f1d33;margin:40px 0 14px;padding:0;border:none;font-weight:700;",
    h3:
      "font-family:'Helvetica Neue','Arial',sans-serif;font-size:12px;line-height:1.65;color:#7d6534;margin:28px 0 10px;font-weight:700;letter-spacing:0.22em;text-transform:uppercase;",
    p: "margin:0 0 18px;color:#1c2740;",
    blockquote:
      "margin:32px 0;padding:20px 24px;background:#ebe0cb;border:none;border-radius:0;color:#0f1d33;font-family:'Source Han Serif SC','Noto Serif SC',serif;font-size:19px;line-height:1.7;font-style:italic;",
    list: "margin:0 0 20px 0;padding-left:1.35em;color:#1c2740;",
    li: "margin:0 0 9px;",
    figure:
      "margin:32px 0;padding:0;background:transparent;border:none;border-radius:0;",
    image:
      "display:block;width:100%;border-radius:0;object-fit:cover;max-height:520px;background:#e0d4ba;",
    figcaption:
      "margin-top:8px;font-family:'Helvetica Neue','Arial',sans-serif;font-size:11px;color:#7d6534;text-align:left;line-height:1.7;letter-spacing:0.16em;text-transform:uppercase;font-weight:600;",
    hr: "border:none;border-top:1px solid #cdb78b;margin:32px 0;",
    strong: "color:#0f1d33;font-weight:700;",
    cta:
      "margin-top:38px;padding:22px 24px;background:#0f1d33;color:#f5ede0;border:none;border-radius:0;font-family:'Helvetica Neue','Arial',sans-serif;letter-spacing:0.04em;"
  },

  // 5) Vogue · Didone 时装大刊
  "vogue-didone": {
    label: "时装大刊 · Vogue",
    root:
      "font-family:'Helvetica Neue','PingFang SC','Hiragino Sans GB',sans-serif;color:#1a1a1a;line-height:1.85;font-size:16px;background:#ffffff;padding:40px 28px;border:none;border-radius:0;",
    h1:
      "font-family:'Source Han Serif SC','Noto Serif SC','Bodoni 72',serif;font-size:54px;line-height:1.0;color:#000;margin:0 0 24px;font-weight:700;letter-spacing:-0.04em;text-align:center;",
    subtitle:
      "font-family:'Helvetica Neue','Arial',sans-serif;font-size:10px;line-height:1.7;color:#1a1a1a;margin:0 0 36px;padding-bottom:0;border-bottom:none;letter-spacing:0.42em;text-transform:uppercase;font-weight:700;text-align:center;",
    lead:
      "font-family:'Source Han Serif SC','Noto Serif SC',serif;font-size:21px;line-height:1.7;color:#000;background:transparent;border:none;border-radius:0;padding:0;margin:0 auto 36px;text-align:center;max-width:560px;font-weight:400;letter-spacing:-0.005em;",
    h2:
      "font-family:'Source Han Serif SC','Noto Serif SC',serif;font-size:32px;line-height:1.2;color:#000;margin:48px 0 16px;padding:0;border:none;font-weight:700;letter-spacing:-0.02em;text-align:center;",
    h3:
      "font-family:'Helvetica Neue','Arial',sans-serif;font-size:11px;line-height:1.7;color:#000;margin:32px 0 12px;font-weight:700;letter-spacing:0.36em;text-transform:uppercase;text-align:center;",
    p: "margin:0 0 20px;color:#1a1a1a;",
    blockquote:
      "margin:40px auto;padding:0;background:transparent;border:none;border-radius:0;color:#000;font-family:'Source Han Serif SC','Noto Serif SC',serif;font-size:32px;line-height:1.3;font-weight:700;letter-spacing:-0.02em;text-align:center;max-width:600px;",
    list: "margin:0 0 22px 0;padding-left:1.35em;color:#1a1a1a;",
    li: "margin:0 0 9px;",
    figure:
      "margin:36px 0;padding:0;background:transparent;border:none;border-radius:0;",
    image:
      "display:block;width:100%;border-radius:0;object-fit:cover;max-height:600px;background:#f0f0f0;",
    figcaption:
      "margin-top:12px;font-family:'Helvetica Neue','Arial',sans-serif;font-size:10px;color:#444;text-align:center;line-height:1.8;letter-spacing:0.32em;text-transform:uppercase;font-weight:600;",
    hr: "border:none;border-top:1px solid #000;margin:44px 35% 44px 35%;",
    strong: "color:#000;font-weight:700;",
    cta:
      "margin-top:48px;padding:24px 0;background:#000;color:#fff;border:none;border-radius:0;text-align:center;font-family:'Helvetica Neue','Arial',sans-serif;letter-spacing:0.42em;text-transform:uppercase;font-size:11px;font-weight:700;"
  },

  // 6) 独立刊物 · 朱红 zine
  "paper-zine": {
    label: "独立刊物 · Zine",
    root:
      "font-family:'Source Han Serif SC','Noto Serif SC','Songti SC',serif;color:#1c1815;line-height:1.92;font-size:16px;background:#f6efe2;padding:36px 26px;border:none;border-radius:0;",
    h1:
      "font-family:'Source Han Serif SC','Noto Serif SC',serif;font-size:36px;line-height:1.18;color:#1c1815;margin:0 0 16px;font-weight:700;letter-spacing:-0.01em;",
    subtitle:
      "font-family:'Helvetica Neue','Arial',sans-serif;font-size:12px;line-height:1.75;color:#c33d2e;margin:0 0 28px;padding-bottom:14px;border-bottom:2px solid #c33d2e;letter-spacing:0.18em;text-transform:uppercase;font-weight:700;",
    lead:
      "font-family:'Source Han Serif SC','Noto Serif SC',serif;font-size:19px;line-height:1.95;color:#1c1815;background:transparent;border:none;border-radius:0;padding:0;margin:0 0 28px;",
    h2:
      "font-family:'Source Han Serif SC','Noto Serif SC',serif;font-size:24px;line-height:1.35;color:#c33d2e;margin:38px 0 12px;padding:0;border:none;font-weight:700;",
    h3:
      "font-family:'Helvetica Neue','Arial',sans-serif;font-size:13px;line-height:1.6;color:#1c1815;margin:28px 0 10px;font-weight:700;letter-spacing:0.16em;text-transform:uppercase;",
    p: "margin:0 0 18px;color:#1c1815;",
    blockquote:
      "margin:30px 0;padding:0 0 0 24px;background:transparent;border:none;border-left:3px solid #c33d2e;border-radius:0;color:#1c1815;font-family:'Source Han Serif SC','Noto Serif SC',serif;font-size:21px;line-height:1.6;font-style:italic;",
    list: "margin:0 0 20px 0;padding-left:1.35em;color:#1c1815;",
    li: "margin:0 0 9px;",
    figure:
      "margin:30px 0;padding:0;background:transparent;border:1px solid #c33d2e;border-radius:0;",
    image:
      "display:block;width:100%;border-radius:0;object-fit:cover;max-height:520px;background:#ebe2d0;",
    figcaption:
      "margin:0;padding:10px 14px;font-family:'Helvetica Neue','Arial',sans-serif;font-size:12px;color:#1c1815;text-align:left;line-height:1.7;letter-spacing:0.08em;background:#f6efe2;border-top:1px solid #c33d2e;",
    hr: "border:none;border-top:2px solid #c33d2e;margin:32px 30% 32px 0;",
    strong: "color:#c33d2e;font-weight:700;",
    cta:
      "margin-top:36px;padding:22px 24px;background:#c33d2e;color:#f6efe2;border:none;border-radius:0;font-family:'Source Han Serif SC','Noto Serif SC',serif;font-weight:700;letter-spacing:0.04em;"
  }
};

// 杂志级母版的元数据（给 AI 模板生成器问卷用 + UI 选择卡片用）
export const MAGAZINE_THEMES = [
  {
    id: "editorial-newyorker",
    label: "新刊衬线",
    inspiration: "The New Yorker",
    summary: "纯白衬线 + 全大写小标 + hairline 极细分隔线，最适合人物特稿、深度评论、文化随笔。",
    pairsWith: ["文化评论", "深度专栏", "人物特稿", "财经观察"]
  },
  {
    id: "kinfolk-quiet",
    label: "静语生活",
    inspiration: "Kinfolk",
    summary: "奶白底极简留白 + 全部 sans-serif + 居中编排，适合慢生活、美食、旅行、家居。",
    pairsWith: ["情感生活", "时尚美学", "美食旅行", "极简日常"]
  },
  {
    id: "wired-neon",
    label: "霓虹科技",
    inspiration: "Wired",
    summary: "黑底白字 + 一抹荧光黄 + Mono 节号，适合科技测评、AI 评论、产品发布稿。",
    pairsWith: ["科技测评", "AI 行业", "产品发布", "硬核数码"]
  },
  {
    id: "monocle-soft",
    label: "杏色商业",
    inspiration: "Monocle",
    summary: "杏色底 + 深 navy 衬线 + 全大写小标，适合商业、财经、行业研究、城市观察。",
    pairsWith: ["财经商业", "行业观察", "城市文化", "品牌评论"]
  },
  {
    id: "vogue-didone",
    label: "时装大刊",
    inspiration: "Vogue",
    summary: "纯白底 + 超大衬线 + 中轴对称 + 巨字间距小标，适合时尚、美妆、视觉、艺术。",
    pairsWith: ["时尚美学", "视觉艺术", "潮流评论", "设计观察"]
  },
  {
    id: "paper-zine",
    label: "独立刊物",
    inspiration: "Independent Zine",
    summary: "奶纸感 + 朱红 accent + 衬线粗体，适合文化评论、独立观察、亚文化、年轻向。",
    pairsWith: ["文化评论", "亚文化", "独立观察", "年轻向叙述"]
  },
  {
    id: "editorial-green",
    label: "润笔新叶（润笔默认）",
    inspiration: "DocuEarn House",
    summary: "墨绿 + 一抹金的润笔自带主题，最稳妥、最不出错，适合任意题材的兜底选择。",
    pairsWith: ["任意题材", "新手起步"]
  }
];

export const COMMON_OUTPUT_RULES = [
  "输出必须是合法 JSON，且只输出 JSON，不要附加解释或 Markdown 代码块。",
  "JSON 字段必须包含 title、subtitle、lead、sections、closing、cta、wechatTitleOptions、keywords。",
  "每个 section 必须包含 heading、paragraphs、bulletPoints、quote、imageRefs。",
  "imageRefs 中每一项形如 {\"index\": 1, \"caption\": \"图注\"}，index 必须引用来源图片编号。",
  "若某个字段没有内容，请返回空字符串或空数组，不要省略字段。",
  "整篇正文（含标题、副标题、段落、列表、引用、CTA）总字符数请控制在 6000 字以内，避免发布时被截断。"
].join("\n");

export const COMMON_USER_PAYLOAD = `改写目标：
{
  "audience": "{{audience}}",
  "tone": "{{tone}}",
  "angle": "{{angle}}",
  "requestedLength": "{{length}}",
  "cta": "{{cta}}"
}

来源信息：
- 标题：{{title}}
- URL：{{url}}
- 站点：{{siteName}}
- 字数：{{wordCount}}
- 图片数：{{imageCount}}

正文内容（已结构化）：
{{content}}`;

export const DEFAULT_PROMPT_TEMPLATES = [
  {
    id: "preset-deep-analysis",
    name: "深度行业观察",
    icon: "🔍",
    description: "适合科技、商业、AI 等需要冷静分析与判断的话题。",
    systemTemplate: `你是一名资深行业观察者，擅长在公众号上写出有判断力的深度分析文章。

写作风格：
- 像有立场的编辑：先抛事实，再给判断；不要堆排比、空话、口号。
- 段落短、节奏明，避免使用过多形容词。
- 在文中至少给出 1 个明确观点和 1 个反驳/质疑的视角。
- 不要使用 "随着…的不断发展"、"在当今时代" 这类 AI 常见套话。

事实约束：
- 只基于提供的来源事实写作，不要编造数据、人物或案例。
- 数字、产品名、人名必须与来源一致。

${COMMON_OUTPUT_RULES}`,
    userTemplate: `请将下面的来源材料改写成一篇有判断力的行业观察稿。

${COMMON_USER_PAYLOAD}`,
    defaults: {
      tone: "冷静、有判断、像资深行业观察",
      angle: "提炼核心事实，给出独立判断与反方视角",
      length: "medium",
      cta: "结尾给出一个明确的判断或可执行建议",
      audience: "关注行业趋势与底层逻辑的从业者"
    },
    temperature: 0.7,
    model: ""
  },
  {
    id: "preset-storytelling",
    name: "故事化叙述",
    icon: "📖",
    description: "用故事和场景把信息讲出来，适合人物、事件、案例类内容。",
    systemTemplate: `你是一名擅长非虚构故事写作的公众号编辑。

写作风格：
- 用具体场景、动作、对话感强的句子开头，而不是结论或定义。
- 把数据和事实嵌进故事里，而不是干巴巴罗列。
- 适度使用比喻，但不要堆砌；避免华丽辞藻。
- 注意呼吸节奏：每 2-3 个短句后接一个长句。

事实约束：
- 只能使用来源中明确出现的人物、对话、地点、时间。
- 不允许编造心理活动或未提及的细节。
- 引用来源中的原话时，放进 quote 字段。

${COMMON_OUTPUT_RULES}`,
    userTemplate: `请将下面的来源材料改写成一篇带故事感的公众号叙述稿。

${COMMON_USER_PAYLOAD}`,
    defaults: {
      tone: "有画面、有节奏、像在讲一个真实的故事",
      angle: "用场景与人物切入，把核心信息融进叙述",
      length: "medium",
      cta: "结尾抛出一个值得读者继续思考的问题",
      audience: "喜欢看故事和人物的公众号读者"
    },
    temperature: 0.85,
    model: ""
  },
  {
    id: "preset-listicle",
    name: "清单整理",
    icon: "📋",
    description: "把信息打包成「3-5 条要点 + 简短解释」的格式，适合工具盘点、技巧合集。",
    systemTemplate: `你是一名擅长信息整理的公众号编辑，专注把杂乱信息打包成清晰可读的清单。

写作风格：
- 每个要点必须有：一句结论性 heading + 1-3 句简短解释。
- 每条要点之间彼此独立、不重复。
- 不要写「以下是…」「让我们来看看…」这类废话过渡。
- 整篇文章节奏要快，单段不超过 3 句。

结构约束：
- sections 数量控制在 3-5 个之间。
- 每个 section 的 heading 必须是清晰的结论，不要疑问句。
- bulletPoints 用来承载具体要点，paragraphs 只放过渡或补充说明。

${COMMON_OUTPUT_RULES}`,
    userTemplate: `请将下面的来源材料整理成一篇清单式公众号文章。

${COMMON_USER_PAYLOAD}`,
    defaults: {
      tone: "清晰、利落、像在给读者打包重点",
      angle: "提炼 3-5 个独立要点，每个要点配简短解释",
      length: "short",
      cta: "结尾用一句话总结清单核心",
      audience: "希望快速获取信息要点的公众号读者"
    },
    temperature: 0.6,
    model: ""
  },
  {
    id: "preset-news-brief",
    name: "新闻速读",
    icon: "📰",
    description: "适合时事、产品发布、行业动态等需要快速看完的硬资讯。",
    systemTemplate: `你是一名公众号资讯编辑，写的是「打开 30 秒就能看完」的新闻速读稿。

写作风格：
- 开头用一句话讲清「什么人/公司、做了什么、什么时候、为什么重要」。
- 段落短、信息密度高，单段不超过 2-3 句。
- 不抒情、不渲染，事实优先。
- 关键数字、时间、产品名要原样保留，必要时加粗（在 paragraphs 内用 **粗体** 语法）。

事实约束：
- 不允许使用未在来源中出现的数据或引语。
- 不要给出未在来源中出现的判断或猜测。

${COMMON_OUTPUT_RULES}`,
    userTemplate: `请将下面的来源材料压缩成一篇公众号资讯速读稿。

${COMMON_USER_PAYLOAD}`,
    defaults: {
      tone: "克制、客观、像 5 分钟速读",
      angle: "突出「发生了什么」与「为什么重要」",
      length: "short",
      cta: "结尾给出一个明确的下一步关注点",
      audience: "关注行业动态、希望快速获取资讯的读者"
    },
    temperature: 0.55,
    model: "",
    useVoiceSample: "force-off",
    humanizePassAllowed: true
  },
  {
    id: "preset-tutorial",
    name: "教程拆解",
    icon: "🛠️",
    description: "适合工具上手、操作流程、功能讲解类内容，强调步骤清晰、可复现。",
    systemTemplate: `你是一名公众号技术编辑，专门写「读完就能跟着做」的教程拆解文章。

写作风格：
- 每个 section 对应一个清晰可复现的步骤；heading 用动词开头，例如「打开 …」、「配置 …」。
- bulletPoints 内放具体动作或参数，paragraphs 内放原理与注意事项。
- 涉及代码、命令行、配置时，原样保留在 quote 字段或 paragraphs 中（用 \`code\` 反引号包裹）。
- 避免「相信很多人都遇到过」这种 AI 套话。

结构约束：
- 第一个 section 必须说明「适用场景与前置条件」。
- 最后一个 section 必须说明「常见坑或可优化的下一步」。

${COMMON_OUTPUT_RULES}`,
    userTemplate: `请将下面的来源材料整理成一篇步骤化的教程拆解。

${COMMON_USER_PAYLOAD}`,
    defaults: {
      tone: "清晰、可复现、像同事在手把手讲",
      angle: "拆成可操作的步骤，强调前置条件与坑点",
      length: "medium",
      cta: "结尾告诉读者下一步可以扩展什么",
      audience: "希望按步骤动手实践的开发者或工具用户"
    },
    temperature: 0.5,
    model: "",
    useVoiceSample: "force-off",
    humanizePassAllowed: false
  }
];
