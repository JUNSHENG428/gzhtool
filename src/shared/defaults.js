export const STORAGE_KEYS = {
  settings: "wechatWriterSettings",
  session: "wechatWriterSession",
  draftHistory: "__draft_history",
  promptTemplates: "wechatWriterPromptTemplates",
  activeTemplateId: "wechatWriterActiveTemplateId"
};

export const DEFAULT_SETTINGS = {
  productName: "公众号改写排版台",
  operatorName: "",
  supportEmail: "",
  officialSiteUrl: "",
  apiBaseUrl: "https://api.openai.com/v1/chat/completions",
  apiKey: "",
  model: "gpt-4.1-mini",
  temperature: 0.8,
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
  hotTopicsDailyHotBase: "",
  hotTopicsNewsnowBase: "",
  // DrissionPage 增强抓取（可选）。需要本地启动一个 helper 服务，
  // 走 Chromium 真实环境抓取，可绕过部分前端反爬/懒加载页面。
  // 默认关闭；开启时也会保留"内置抓取兜底"，所以即使 helper 挂掉也不至于全链路失败。
  drissionEnabled: false,
  drissionHelperUrl: "",
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
  }
};

const COMMON_OUTPUT_RULES = [
  "输出必须是合法 JSON，且只输出 JSON，不要附加解释或 Markdown 代码块。",
  "JSON 字段必须包含 title、subtitle、lead、sections、closing、cta、wechatTitleOptions、keywords。",
  "每个 section 必须包含 heading、paragraphs、bulletPoints、quote、imageRefs。",
  "imageRefs 中每一项形如 {\"index\": 1, \"caption\": \"图注\"}，index 必须引用来源图片编号。",
  "若某个字段没有内容，请返回空字符串或空数组，不要省略字段。",
  "整篇正文（含标题、副标题、段落、列表、引用、CTA）总字符数请控制在 6000 字以内，避免发布时被截断。"
].join("\n");

const COMMON_USER_PAYLOAD = `改写目标：
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
    model: ""
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
    model: ""
  }
];
