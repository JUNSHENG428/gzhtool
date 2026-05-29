/**
 * src/shared/humanize-rules.js
 * ====================================================================
 * 「去 AI 味」单一真源（Single Source of Truth）
 *
 * 这个模块把「想让 AI 改写结果更像真人写的」所需的全部静态知识抽到一处，
 * 供以下三个消费方共用，避免规则散落在各个 prompt 字符串里漂移：
 *
 *   1. src/shared/ai.js 的 buildHardConstraintMessage：主 pass 的硬约束
 *      （注入 system message，把规则告诉 LLM）
 *   2. src/shared/humanize-pass.js 的二次 humanize pass：
 *      把规则更强地告诉 LLM，且按 lint 报告精准定位风险
 *   3. src/shared/humanize-checker.js 的本地 lint：
 *      不用调 LLM，纯 JS 扫描产物，输出 score / issues / metrics
 *
 * 知识来源：
 *   - humanizer-zh：21 类中文 AI 写作模式（套话、否定式排比、三段式、
 *     破折号、内联标题列表、谄媚语气、宣传语、模糊归因、-ing 肤浅分析…）
 *   - turnitin-humanizer：四维统计对抗（困惑度 / 突发性 / 文体计量 /
 *     概率曲率），含可量化阈值（句长标准差 / 均值 ≥ 0.6、破折号每 500 字 ≤ 2）
 *   - academic-paper-humanizer：18 类模式 + AI 词替换表
 *
 * 重要：本模块只导出**数据**和**纯函数**，不直接发起 LLM 调用，也不
 * 依赖 chrome.* 或 DOM API，方便在 service worker、editor page、
 * options page、smoke test 任意环境复用。
 */

// ---------------------------------------------------------------------
// 1) AI 套话黑名单（中文）
//    weight：估算的"AI 痕迹强度"。lint 评分按 weight 累加扣分。
// ---------------------------------------------------------------------

export const AI_VOCAB_BLACKLIST = Object.freeze([
  // 极高风险（看到一次就明显是 AI）
  { phrase: "深入探讨", weight: 8 },
  { phrase: "深入分析", weight: 6 },
  { phrase: "深刻洞察", weight: 6 },
  { phrase: "至关重要", weight: 8 },
  { phrase: "举足轻重", weight: 6 },
  { phrase: "不可或缺", weight: 7 },
  { phrase: "不可忽视", weight: 6 },
  { phrase: "毋庸置疑", weight: 8 },
  { phrase: "众所周知", weight: 7 },
  { phrase: "值得我们深思", weight: 9 },
  { phrase: "值得我们关注", weight: 7 },
  { phrase: "值得注意的是", weight: 6 },
  { phrase: "归根结底", weight: 7 },
  { phrase: "总而言之", weight: 7 },
  { phrase: "综上所述", weight: 9 },
  { phrase: "事实证明", weight: 6 },
  { phrase: "由此可见", weight: 5 },
  { phrase: "在某种程度上", weight: 5 },
  { phrase: "从某种意义上说", weight: 6 },
  // 抽象壳词
  { phrase: "格局", weight: 7 },
  { phrase: "织锦", weight: 9 },
  { phrase: "基石", weight: 6 },
  { phrase: "里程碑", weight: 5 },
  { phrase: "试金石", weight: 7 },
  { phrase: "风向标", weight: 5 },
  { phrase: "新篇章", weight: 6 },
  { phrase: "新征程", weight: 7 },
  { phrase: "新台阶", weight: 6 },
  { phrase: "新高度", weight: 5 },
  // 宣传式动词
  { phrase: "彰显", weight: 6 },
  { phrase: "凸显", weight: 5 },
  { phrase: "赋能", weight: 8 },
  { phrase: "夯实", weight: 7 },
  { phrase: "助推", weight: 5 },
  { phrase: "引领", weight: 5 },
  { phrase: "打造", weight: 4 },
  { phrase: "塑造", weight: 4 },
  // 程度副词堆砌
  { phrase: "极其重要", weight: 6 },
  { phrase: "尤为重要", weight: 5 },
  { phrase: "显著", weight: 3 },
  // 协作语气（聊天残留）
  { phrase: "希望对您有帮助", weight: 10 },
  { phrase: "希望对你有帮助", weight: 10 },
  { phrase: "当然可以", weight: 8 },
  { phrase: "让我为您", weight: 9 },
  { phrase: "您说得对", weight: 8 },
  { phrase: "您说得完全正确", weight: 9 },
  { phrase: "好问题", weight: 6 },

  // -------------------------------------------------------------------
  // 「伪去 AI 味」套话：单次出现允许（看起来像真人开口的口语词），
  // 但 AI 倾向反复使用以"伪装真人"。lint 的 repeatedPhraseIssues 会
  // 对这类词做"≥ 2 次直接判 AI"的高权重补充检测；这里只给 weight 3–4，
  // 避免单次出现就被误判。
  { phrase: "说实话", weight: 4 },
  { phrase: "说实在", weight: 4 },
  { phrase: "坦白说", weight: 4 },
  { phrase: "老实讲", weight: 4 },
  { phrase: "客观地讲", weight: 4 },
  { phrase: "客观地说", weight: 4 },
  // AI 的转折套话（看起来不像 AI，但其实极典型）
  { phrase: "也就是说", weight: 6 },
  { phrase: "换言之", weight: 6 },
  { phrase: "换个角度", weight: 6 },
  { phrase: "换句话说", weight: 6 },
  { phrase: "不可否认", weight: 6 },
  { phrase: "可问题在于", weight: 3 },
  { phrase: "问题在于", weight: 3 },
  // 去 AI 味"替换字典反噬"——机械替换产生的新套话，一旦固定出现同样是 AI 痕迹
  { phrase: "差不多同期", weight: 5 },
  { phrase: "顺带一提", weight: 3 }
]);

// ---------------------------------------------------------------------
// 2) AI 套话短语（多字节，必须整段匹配，不在词单里）
//    主 pass system prompt 引用一部分；lint 用全量做命中检测。
// ---------------------------------------------------------------------

export const AI_PHRASE_BLACKLIST = Object.freeze([
  { phrase: "随着……的不断发展", weight: 9 },
  { phrase: "随着 …… 的不断发展", weight: 9 },
  { phrase: "在当今时代", weight: 8 },
  { phrase: "在当今社会", weight: 8 },
  { phrase: "在数字化浪潮下", weight: 9 },
  { phrase: "在科技飞速发展的今天", weight: 9 },
  { phrase: "在……的背景下", weight: 8 },
  { phrase: "在 …… 的背景下", weight: 8 },
  { phrase: "面对……的挑战", weight: 7 },
  { phrase: "为……提供了有力支撑", weight: 9 },
  { phrase: "为……提供了有力保障", weight: 9 },
  { phrase: "对……产生深远影响", weight: 8 },
  { phrase: "具有重要的理论意义和实践价值", weight: 10 },
  { phrase: "具有重要的现实意义", weight: 8 },
  { phrase: "拥抱变革", weight: 8 },
  { phrase: "拥抱未来", weight: 7 },
  { phrase: "科技的飞速发展", weight: 8 },
  { phrase: "不可忽视的力量", weight: 8 },
  { phrase: "无与伦比", weight: 7 },
  { phrase: "颠覆性", weight: 5 },
  { phrase: "突破性", weight: 5 },
  { phrase: "里程碑式", weight: 6 },
  { phrase: "划时代", weight: 6 },
  // 否定式排比（结构化匹配在 humanize-checker 里做正则；这里只是参考）
  { phrase: "不仅是……更是", weight: 6 },
  { phrase: "不仅仅是", weight: 4 },
  // 升华式 / 诗意收尾套路（LLM 最爱的"金句结尾"，一眼可辨）
  { phrase: "见分晓", weight: 7 },
  { phrase: "拭目以待", weight: 8 },
  { phrase: "时间会给出答案", weight: 9 },
  { phrase: "时间会证明", weight: 8 },
  { phrase: "答案藏在", weight: 7 },
  { phrase: "未来可期", weight: 8 },
  { phrase: "值得期待", weight: 5 },
  { phrase: "唯一不变的是变化", weight: 9 }
]);

// ---------------------------------------------------------------------
// 3) 突发性 / 节奏目标
//    句长标准差 / 均值 = burstiness。AI 文本通常 0.15–0.30，
//    人类写作 0.65–0.85。我们把 0.55 作为合格线。
// ---------------------------------------------------------------------

export const BURSTINESS_TARGET = Object.freeze({
  // 长短句配比建议（写在 prompt 里的引导，不强制 lint 校验）
  ratioGuide: "中等句（15–25 字）3 份、短句（3–8 字）2 份、长句（30–45 字）1 份",
  minStdOverMean: 0.55,
  // lint 容差：低于此分扣分递增
  warnStdOverMean: 0.45,
  // 段落长度：避免每段都 4–6 句，至少有一段 1–2 句
  shortParagraphMaxSentences: 2,
  longParagraphMinSentences: 6,
  // 同段相邻 3 句不得长度方差 < 此值（强制至少有一句不一样）
  adjacentSentenceMinSpread: 8
});

// ---------------------------------------------------------------------
// 4) 标点指纹上限（每 500 字）
//    研究：人类平均破折号密度 0.3–0.5/100 字；AI（GPT-4 0.5–0.8、
//    Claude 1.0–1.3、某些 SaaS humanizer 高达 2.17）显著超标。
// ---------------------------------------------------------------------

export const PUNCTUATION_LIMITS = Object.freeze({
  dashesPer500: 2, // —— 或 — 总和
  exclamPer500: 3,
  questionPer500: 5,
  // 「**标签**：内容」式的内联标题列表，每篇 ≤ 1 段
  inlineTitleListPerArticle: 1
});

// ---------------------------------------------------------------------
// 5) 21 类模式的精简卡片（供 prompt 注入用）
//    每张卡 ≤ 30 字，避免堆出新的"约束类套话"。
//    写在 prompt 里时只挑 6–8 张高优先级，避免 token 过载。
// ---------------------------------------------------------------------

export const RULE_CARDS = Object.freeze([
  {
    id: "burstiness",
    priority: 10,
    label: "句长突发性",
    do: "相邻三句长度必须明显不同；至少出现 1 个 1–2 句的短段。",
    dont: "全篇句子都 18–25 字，每段都 4 句。"
  },
  {
    id: "blacklist",
    priority: 10,
    label: "AI 套话黑名单",
    do: "用具体动作 / 数字 / 场景代替抽象壳词。",
    dont: "「赋能 / 至关重要 / 综上所述 / 织锦 / 格局」等。"
  },
  {
    id: "info-noise",
    priority: 9,
    label: "信息噪声",
    do: "数据点用具体数字、时间、场景。",
    dont: "「大量 / 显著 / 明显 / 重要」这类模糊定性词。"
  },
  {
    id: "anti-triplet",
    priority: 9,
    label: "反三段式",
    do: "列举优先 2 项或 4 项，或干脆用一句话承载。",
    dont: "「不仅……而且……」、连续 3 项并列、「首先……其次……最后」。"
  },
  {
    id: "anti-parallel-structure",
    priority: 9,
    label: "反对仗 / 否定式排比",
    do: "用陈述句直接说结论，或用一个具体场景代替对仗。",
    dont: "「X，而不是 Y」「不是 X，是 Y」「不仅 X，更 Y」「X 而非 Y」"
  },
  {
    id: "anti-ending-command",
    priority: 8,
    label: "反命令式收尾",
    do: "结尾用具体场景 / 反问 / 一句叙述收笔。",
    dont: "「别让……就……」「应当……而非……」「需要……而不是……」"
  },
  {
    id: "anti-fake-honesty",
    priority: 8,
    label: "反伪去 AI 味",
    do: "整篇最多保留 1 处「说实话 / 坦白说」类口语词；其它位置改用具体动作。",
    dont: "通过反复说「说实话」「换个角度」「也就是说」来伪装真人。"
  },
  {
    id: "anti-dash",
    priority: 8,
    label: "反破折号",
    do: "破折号每 500 字 ≤ 2 个，多用逗号或句号。",
    dont: "「这——其实——是」式的破折号串联。"
  },
  {
    id: "anti-inline-list",
    priority: 8,
    label: "反内联标题列表",
    do: "正文用 H2/H3 + 普通段落；列表 1 篇 ≤ 1 处。",
    dont: "「**关键洞察：** 内容」式的粗体标签段。"
  },
  {
    id: "anti-chatbot",
    priority: 9,
    label: "反协作语气",
    do: "直接交付内容。",
    dont: "「希望对您有帮助 / 当然可以 / 让我为您 / 您说得对」。"
  },
  {
    id: "first-person",
    priority: 7,
    label: "允许第一视角",
    do: "正文里有 1–2 处带主观判断的句子，如「说实话…」「让我意外的是…」。",
    dont: "全程客观播报、零情绪。"
  },
  {
    id: "anti-superficial-ing",
    priority: 7,
    label: "反 -ing 肤浅分析",
    do: "用具体事实结句。",
    dont: "「彰显着 X / 反映了 Y / 凸显着 Z」式的现在分词尾巴。"
  },
  {
    id: "anti-vague-attr",
    priority: 7,
    label: "反模糊归因",
    do: "明确来源（公司 / 报告 / 时间）。",
    dont: "「专家认为 / 业内人士指出 / 多个来源显示」。"
  },
  {
    id: "anti-promo",
    priority: 6,
    label: "反宣传语",
    do: "用克制描述。",
    dont: "「无与伦比 / 颠覆性 / 划时代 / 里程碑式」。"
  },
  {
    id: "synonym-cycle",
    priority: 5,
    label: "反同义词循环",
    do: "同一概念可重复用同一个词。",
    dont: "「主人公 → 主要角色 → 中心人物 → 英雄」机械轮换。"
  },
  {
    id: "anti-poetic-ending",
    priority: 9,
    label: "反升华结尾",
    do: "结尾落在一个具体事实、动作或具体悬念上，平实收住。",
    dont: "「不会在 X 见分晓，而在 Y 里…」否定+肯定句式、「一辆辆/一步步」量词排比、「时间会给出答案/拭目以待」等金句升华。"
  },
  {
    id: "anti-over-fragment",
    priority: 6,
    label: "反过度碎句",
    do: "短句是调味，长短交错才像人。",
    dont: "连续 3 句以上都是 5 字以内的残句（如「实操层面。出事故，兜底。」），那是另一种用力过猛的风格指纹。"
  },
  {
    id: "anti-template-heading",
    priority: 6,
    label: "反模板小标题",
    do: "小标题用具体名词或观点短句。",
    dont: "「N 个必须正视的 X」「X 的真实含金量/真相」「不得不说的 N 件事」这类填空模板。"
  },
  {
    id: "natural-cohesion",
    priority: 8,
    label: "句间自然衔接",
    do: "相邻句子靠语义、指代和逻辑推进自然承接（前句抛出、后句接住或反驳）；衔接用口语化的「这就…/所以…/可…」少量点缀。",
    dont: "句子互相孤立、话题硬跳；也不要每句都用「然而/因此/与此同时/值得注意的是」书面过渡词起头。短句是调味，不能把一个完整意思切成互不相关的碎片。"
  }
]);

/**
 * 取出在 prompt 里直接展示的高优先级卡片（默认 8 张）。
 * 顺序按 priority desc，控制 token。
 */
export function getTopRuleCards(limit = 8) {
  return [...RULE_CARDS]
    .sort((a, b) => b.priority - a.priority)
    .slice(0, Math.max(1, limit));
}

// ---------------------------------------------------------------------
// 6) AI 词 -> 人类替代词建议（写到 prompt 里给 LLM 当字典）
//    只列「真的会被检测到」的高频替换；过细的会让 LLM 产生新的"反 AI 套话"。
// ---------------------------------------------------------------------

export const AI_VOCAB_REPLACEMENTS = Object.freeze([
  ["此外", "还有 / 另外 / 补一句"],
  ["与此同时", "同期 / 那阵子 / 几乎同时"],
  ["然而", "话说回来 / 不过 / 但"],
  ["因此", "所以 / 这就导致 / 于是"],
  ["重要的", "要紧的 / 绕不开的 / 实打实"],
  ["显著的", "肉眼可见的 / 一目了然"],
  ["促进", "带动 / 推 / 催生"],
  ["利用", "用 / 拿"],
  ["进行", "做 / 跑 / 跑一遍"],
  ["实施", "做 / 落地"],
  ["实现", "做出 / 跑通"],
  ["具有", "带 / 有 / 自带"],
  ["展示", "拿出来看 / 给出"],
  ["体现", "看得出 / 能看到"]
]);

// ---------------------------------------------------------------------
// 7) 模板风格配置（每个预设模板对应的 humanize 强度建议）
//    在 service-worker 决定是否跑二次 pass / lint 严格度时参考。
// ---------------------------------------------------------------------

export const TEMPLATE_HUMANIZE_PROFILES = Object.freeze({
  // 学术 / 行业观察类：保留专业语气，破折号上限放宽
  "preset-deep-analysis": {
    burstinessMin: 0.5,
    dashesPer500: 3,
    allowFirstPerson: true,
    intensity: "medium"
  },
  // 故事化：天然就要长短句、第一人称
  "preset-storytelling": {
    burstinessMin: 0.65,
    dashesPer500: 2,
    allowFirstPerson: true,
    intensity: "strong"
  },
  // 清单：句子短，节奏会让 burstiness 偏低，单独放宽
  "preset-listicle": {
    burstinessMin: 0.35,
    dashesPer500: 1,
    allowFirstPerson: false,
    intensity: "light"
  },
  "preset-news-brief": {
    burstinessMin: 0.4,
    dashesPer500: 1,
    allowFirstPerson: false,
    intensity: "light"
  },
  "preset-tutorial": {
    burstinessMin: 0.4,
    dashesPer500: 2,
    allowFirstPerson: true,
    intensity: "medium"
  }
});

/**
 * 给定模板 id，返回对应的 humanize profile。
 * 自定义模板（custom-* / AI 生成）一律走 default。
 */
export function getHumanizeProfile(templateId) {
  if (templateId && TEMPLATE_HUMANIZE_PROFILES[templateId]) {
    return TEMPLATE_HUMANIZE_PROFILES[templateId];
  }
  return DEFAULT_HUMANIZE_PROFILE;
}

export const DEFAULT_HUMANIZE_PROFILE = Object.freeze({
  burstinessMin: 0.55,
  dashesPer500: 2,
  allowFirstPerson: true,
  intensity: "medium"
});

// ---------------------------------------------------------------------
// 8) 文本工具：句子切分 / 字数统计（给 lint 和 prompt 都用）
//    DOMParser 在 service worker 里没有（chrome MV3 sw 限制），
//    所以这里只接受**纯文本**。HTML → 纯文本由调用方处理。
// ---------------------------------------------------------------------

/**
 * 把一段中文 + 英文混排文本切成句子。
 *
 * 规则：以中文标点 [。！？；…] 或英文 [.!?;] + 空白 为切分点；
 * 引号 / 括号闭合后再切；保留原标点结尾。
 *
 * 不追求"语言学完美"，只要：相对稳定、能给 burstiness 评估提供输入。
 */
export function splitSentencesPlain(text) {
  const str = String(text || "").trim();
  if (!str) return [];
  const out = [];
  let buf = "";
  for (let i = 0; i < str.length; i += 1) {
    const ch = str[i];
    buf += ch;
    if ("。！？；…".includes(ch) || (".!?;".includes(ch) && /\s|$/.test(str[i + 1] || ""))) {
      const trimmed = buf.trim();
      if (trimmed) out.push(trimmed);
      buf = "";
    }
  }
  const tail = buf.trim();
  if (tail) out.push(tail);
  return out;
}

/**
 * 字数统计（去空白后字符数，与 ai.js 的 estimateArticleChars 口径一致）。
 */
export function countCharsPlain(text) {
  return String(text || "").replace(/\s+/g, "").length;
}

/**
 * 计算一组句子的句长统计：
 *  { mean, std, burstiness, n }
 *  burstiness = std / mean，越高越像人写的。
 */
export function computeSentenceStats(sentences) {
  const lens = sentences.map((s) => countCharsPlain(s)).filter((n) => n > 0);
  if (lens.length === 0) {
    return { mean: 0, std: 0, burstiness: 0, n: 0 };
  }
  const sum = lens.reduce((a, b) => a + b, 0);
  const mean = sum / lens.length;
  const variance =
    lens.reduce((acc, n) => acc + (n - mean) * (n - mean), 0) / lens.length;
  const std = Math.sqrt(variance);
  const burstiness = mean > 0 ? std / mean : 0;
  return { mean, std, burstiness, n: lens.length };
}
