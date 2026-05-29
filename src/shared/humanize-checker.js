/**
 * src/shared/humanize-checker.js
 * ====================================================================
 * 「去 AI 味」本地 lint 检测器
 *
 * 做什么：
 *   读取改写后的 article（或者纯 HTML），不调用任何 LLM，纯 JS 跑一组
 *   启发式规则，把"看起来还很 AI"的痕迹找出来；输出：
 *
 *     {
 *       score:   0–100，越高越像真人写的
 *       issues:  Array<{ kind, severity, text, hint, range? }>
 *       metrics: { sentenceStats, dashesPer500, exclamPer500, ... }
 *     }
 *
 * 不做什么：
 *   - 不自动改稿（自动改 = 又一层 AI 痕迹），只做检测
 *   - 不依赖 DOMParser（要在 service worker 里跑，所以用纯 regex 剥 HTML）
 *
 * 调用入口：
 *   - service-worker.js 在 REWRITE_ARTICLE / 二次 pass 后跑一次，
 *     把结果塞入回传 payload 让 workspace 渲染 badge
 *   - humanize-pass.js 在挑选"哪段需要返工"时也用，避免空跑
 *
 * 评分思路（不是绝对客观，只是"相对排序工具"）：
 *   - 起步 100，命中规则按 weight 扣分（每条 issue 都有 severity 1/2/3）
 *   - 严重项扣 6–10，警告扣 3–5，提示扣 1–2
 *   - 累积扣分上限 95（不让分数掉到 5 以下，避免"100%AI"夸张感）
 */

import {
  AI_VOCAB_BLACKLIST,
  AI_PHRASE_BLACKLIST,
  BURSTINESS_TARGET,
  PUNCTUATION_LIMITS,
  computeSentenceStats,
  countCharsPlain,
  splitSentencesPlain,
  getHumanizeProfile
} from "./humanize-rules.js";

// ---------------------------------------------------------------------
// 1) 入口
// ---------------------------------------------------------------------

/**
 * 对一篇 article（或 HTML 字符串）进行 lint。
 *
 * @param {string|object} input
 *   - string：直接当 bodyHtml 处理
 *   - object：从 article.bodyHtml / article.lead / article.sections 里抽取纯文本
 * @param {object} [options]
 * @param {object} [options.profile]    模板的 humanizeProfile（可放宽阈值）
 * @param {string} [options.templateId] 用来从 humanize-rules 里取 profile
 */
export function lintArticle(input, options = {}) {
  const text = extractPlainText(input);
  const profile = {
    ...getHumanizeProfile(options.templateId || ""),
    ...(options.profile || {})
  };

  const sentences = splitSentencesPlain(text);
  const stats = computeSentenceStats(sentences);
  const totalChars = countCharsPlain(text);
  const paragraphCount = countParagraphs(input);

  const issues = [];

  // 1. AI 词汇 / 短语黑名单
  collectBlacklistIssues(text, issues);

  // 2. 标点指纹（破折号 / 感叹号上限）
  collectPunctuationIssues(text, totalChars, profile, issues);

  // 3. 句长突发性
  collectBurstinessIssues(stats, profile, issues);

  // 4. 反三段式 / 反否定式排比 / 反并列
  collectStructuralIssues(text, issues);

  // 5. 内联标题列表（**XX**：YY）
  collectInlineTitleListIssues(input, issues);

  // 6. 协作语气（聊天残留）
  collectChatbotToneIssues(text, issues);

  // 7. 模糊归因
  collectVagueAttributionIssues(text, issues);

  // 8. 高重复短语（"伪去 AI 味"专项）：同一短语反复出现 → 暴露 AI 痕迹
  // 把 title / heading / subheading 视为"主题词"，跳过这些（不是 AI 痕迹）
  const topicalTerms = collectTopicalTerms(input);
  const repetitionMetrics = collectRepeatedPhraseIssues(text, paragraphCount, issues, topicalTerms);

  // 9. 三段对仗 / 否定式排比 / 不仅更…
  collectParallelStructureIssues(text, issues);

  // 10. 结尾段命令式收尾（仅 article 输入时有效）
  collectEndingCommandIssues(input, issues);

  // 11. 结尾段升华 / 诗意收尾（否定+肯定句式 / 量词叠词排比）
  collectPoeticEndingIssues(input, issues);

  // 算分
  let deduction = 0;
  for (const it of issues) deduction += it.weight || severityToWeight(it.severity);
  if (deduction > 95) deduction = 95;
  const score = Math.max(5, Math.round(100 - deduction));

  // 同 severity 排序：error > warn > hint，便于 UI 默认展示前 5 条
  issues.sort((a, b) => severityRank(b.severity) - severityRank(a.severity));

  return {
    score,
    issues,
    metrics: {
      totalChars,
      sentenceCount: stats.n,
      avgSentenceLen: round2(stats.mean),
      sentenceStdDev: round2(stats.std),
      burstiness: round2(stats.burstiness),
      dashesPer500: round2(densityPer(text, /[—–]{1,}|——/g, totalChars, 500)),
      exclamPer500: round2(densityPer(text, /[！!]/g, totalChars, 500)),
      questionPer500: round2(densityPer(text, /[？?]/g, totalChars, 500)),
      // 重复短语命中数 / 段落数。值越大说明文章里同一短语反复出现越严重，
      // 0.5 已经偏高，1.0 基本就是"AI 在伪装真人"模式。
      repetitionDensity: round2(repetitionMetrics.density)
    }
  };
}

// ---------------------------------------------------------------------
// 2) 文本抽取（剥 HTML、抽 article 字段）
// ---------------------------------------------------------------------

/**
 * 优先级：
 *   - article.bodyHtml 存在，就用它（最完整）
 *   - 否则把 article 里的可读字段拼起来
 *   - 字符串：直接当 HTML 处理
 */
function extractPlainText(input) {
  if (input == null) return "";
  if (typeof input === "string") return stripHtmlTags(input);

  if (typeof input === "object") {
    if (typeof input.bodyHtml === "string" && input.bodyHtml.trim()) {
      return stripHtmlTags(input.bodyHtml);
    }
    const parts = [];
    if (input.title) parts.push(String(input.title));
    if (input.subtitle) parts.push(String(input.subtitle));
    if (input.lead) parts.push(String(input.lead));
    const sections = Array.isArray(input.sections) ? input.sections : [];
    for (const sec of sections) {
      if (!sec || typeof sec !== "object") continue;
      if (sec.heading) parts.push(String(sec.heading));
      if (sec.subheading) parts.push(String(sec.subheading));
      if (Array.isArray(sec.paragraphs)) {
        for (const p of sec.paragraphs) parts.push(String(p || ""));
      }
      if (Array.isArray(sec.bulletPoints)) {
        for (const b of sec.bulletPoints) parts.push(String(b || ""));
      }
      if (sec.quote) parts.push(String(sec.quote));
    }
    if (input.closing) parts.push(String(input.closing));
    return parts.join("\n");
  }

  return "";
}

/**
 * 不依赖 DOMParser 的 HTML → 纯文本：
 *   - 去掉 script/style 内容（不是文章正文）
 *   - 把 <br> / </p> / </h1-6> / </li> 替换为换行
 *   - 移除其它标签
 *   - 解码常见 HTML entity
 */
function stripHtmlTags(html) {
  let s = String(html || "");
  s = s.replace(/<script[\s\S]*?<\/script>/gi, "");
  s = s.replace(/<style[\s\S]*?<\/style>/gi, "");
  s = s.replace(/<\s*br\s*\/?\s*>/gi, "\n");
  s = s.replace(/<\/(p|div|h[1-6]|li|tr|blockquote|section)\s*>/gi, "\n");
  s = s.replace(/<[^>]+>/g, "");
  s = s
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&hellip;/g, "…")
    .replace(/&mdash;/g, "—")
    .replace(/&ndash;/g, "–");
  return s.trim();
}

// ---------------------------------------------------------------------
// 3) 各类 issue 收集器
// ---------------------------------------------------------------------

// 按出现次数累扣：同一 AI 套话词反复出现是更强的 AI 信号，不能只扣一次
// （否则一篇满是「综上所述/值得注意的是」也只扣单条权重 → 分数虚高 → 跳过 S2）。
// 公式：base + (count-1)*ceil(base/2)，单词封顶 20，总扣分在 lintArticle 里再封 95。
function countAwareWeight(base, count) {
  const b = Math.min(10, base);
  return Math.min(20, b + Math.max(0, count - 1) * Math.ceil(b / 2));
}

function collectBlacklistIssues(text, issues) {
  const seen = new Map();
  for (const item of AI_VOCAB_BLACKLIST) {
    const matches = text.split(item.phrase).length - 1;
    if (matches > 0) {
      const key = `vocab:${item.phrase}`;
      seen.set(key, {
        kind: "ai-vocab",
        phrase: item.phrase,
        count: matches,
        severity: item.weight >= 8 ? "error" : item.weight >= 5 ? "warn" : "hint",
        weight: countAwareWeight(item.weight, matches),
        text: item.phrase,
        hint: `命中 AI 套话词「${item.phrase}」共 ${matches} 处。考虑替换为更具体、有动作感的表达。`
      });
    }
  }
  for (const item of AI_PHRASE_BLACKLIST) {
    const matches = text.split(item.phrase).length - 1;
    if (matches > 0) {
      const key = `phrase:${item.phrase}`;
      seen.set(key, {
        kind: "ai-phrase",
        phrase: item.phrase,
        count: matches,
        severity: item.weight >= 9 ? "error" : "warn",
        weight: countAwareWeight(item.weight, matches),
        text: item.phrase,
        hint: `命中 AI 套话短语「${item.phrase}」共 ${matches} 处。`
      });
    }
  }
  for (const issue of seen.values()) issues.push(issue);
}

function collectPunctuationIssues(text, totalChars, profile, issues) {
  const dashCount = countMatches(text, /——|—|–{2,}/g);
  const exclamCount = countMatches(text, /[！!]/g);
  const dashLimit = Number(profile.dashesPer500 || PUNCTUATION_LIMITS.dashesPer500);
  const exclamLimit = Number(profile.exclamPer500 || PUNCTUATION_LIMITS.exclamPer500);
  const dashesPer500 = densityPer(text, /——|—|–{2,}/g, totalChars, 500);
  const exclamPer500 = densityPer(text, /[！!]/g, totalChars, 500);

  if (dashesPer500 > dashLimit + 0.4) {
    issues.push({
      kind: "dash-overuse",
      severity: dashesPer500 > dashLimit + 1.5 ? "error" : "warn",
      weight: dashesPer500 > dashLimit + 1.5 ? 8 : 5,
      text: "破折号超量",
      hint: `全文破折号每 500 字 ${dashesPer500.toFixed(2)} 个，超过当前模板上限 ${dashLimit}/500 字（命中 ${dashCount} 个）。多用逗号或句号。`
    });
  }
  if (exclamPer500 > exclamLimit + 0.4) {
    issues.push({
      kind: "exclam-overuse",
      severity: "warn",
      weight: 4,
      text: "感叹号过多",
      hint: `感叹号每 500 字 ${exclamPer500.toFixed(2)} 个，超过 ${exclamLimit}/500 字（命中 ${exclamCount} 个）。`
    });
  }
}

function collectBurstinessIssues(stats, profile, issues) {
  if (!stats.n || stats.n < 3) return;
  const minStd = Number(profile.burstinessMin || BURSTINESS_TARGET.minStdOverMean);
  if (stats.burstiness < minStd) {
    const severity =
      stats.burstiness < minStd - 0.15
        ? "error"
        : stats.burstiness < minStd - 0.05
          ? "warn"
          : "hint";
    issues.push({
      kind: "burstiness-low",
      severity,
      weight: severity === "error" ? 9 : severity === "warn" ? 6 : 3,
      text: `句长突发性偏低（${stats.burstiness.toFixed(2)} < ${minStd.toFixed(2)}）`,
      hint: `平均句长 ${stats.mean.toFixed(1)} 字，标准差 ${stats.std.toFixed(1)} 字。建议混合短句（3–8 字）+ 长句（30–45 字），让节奏有呼吸。`
    });
  }
}

function collectStructuralIssues(text, issues) {
  // 「不仅 …… 而且 ……」/「既要…也要…」/「首先…其次…最后」三段式
  const tripletPatterns = [
    { re: /不仅[^。！？]{0,40}[，,]?\s*而且/g, label: "不仅……而且……" },
    { re: /既要[^。！？]{0,40}也要/g, label: "既要……也要……" },
    { re: /首先[^。！？]{0,80}其次[^。！？]{0,80}(最后|再次|最终)/g, label: "首先……其次……最后" },
    { re: /一方面[^。！？]{0,40}另一方面/g, label: "一方面……另一方面" }
  ];
  for (const { re, label } of tripletPatterns) {
    const m = countMatches(text, re);
    if (m > 0) {
      issues.push({
        kind: "anti-triplet",
        severity: "warn",
        weight: 5,
        text: `三段式串场「${label}」x${m}`,
        hint: `命中 ${m} 处。改成 2 项或 4 项；或干脆并到一句话里。`
      });
    }
  }

  // 否定式排比："不是 X 而是 Y" 出现 3 次以上
  const denialPara = countMatches(text, /不是[^。！？\n]{2,30}[，,]\s*而是/g);
  if (denialPara >= 3) {
    issues.push({
      kind: "negative-parallel",
      severity: "warn",
      weight: 5,
      text: `否定式排比 x${denialPara}`,
      hint: "「不是…而是…」连续出现 3 次以上，是 AI 的典型修辞。建议改成肯定句陈述。"
    });
  }
}

function collectInlineTitleListIssues(input, issues) {
  // 直接看 HTML / markdown 形态的「**标签**：内容」 / 「<strong>标签</strong>：内容」
  const html = typeof input === "string" ? input : input?.bodyHtml || "";
  const md = String(html || "");
  const inlineList = countMatches(
    md,
    /(\*\*[^*\n]{1,18}\*\*[：:]\s*\S)|(<(strong|b)>[^<\n]{1,18}<\/(strong|b)>\s*[：:]\s*\S)/g
  );
  if (inlineList > PUNCTUATION_LIMITS.inlineTitleListPerArticle + 1) {
    issues.push({
      kind: "inline-title-list",
      severity: inlineList >= 4 ? "error" : "warn",
      weight: inlineList >= 4 ? 8 : 5,
      text: `内联标题列表 x${inlineList}`,
      hint: `「**标签**：内容」式段落共 ${inlineList} 处，整篇上限建议 ${PUNCTUATION_LIMITS.inlineTitleListPerArticle}。改用 H2/H3 + 普通段落。`
    });
  }
}

function collectChatbotToneIssues(text, issues) {
  const phrases = [
    "希望对您有帮助",
    "希望对你有帮助",
    "当然可以",
    "让我为您",
    "您说得对",
    "您说得完全正确",
    "好问题",
    "首先，让我"
  ];
  let hits = 0;
  for (const p of phrases) {
    const c = text.split(p).length - 1;
    if (c > 0) {
      hits += c;
      issues.push({
        kind: "chatbot-tone",
        severity: "error",
        weight: 9,
        text: p,
        hint: `命中聊天残留「${p}」共 ${c} 处。这是 chatbot 模式漏出来的，必须删。`
      });
    }
  }
  return hits;
}

function collectVagueAttributionIssues(text, issues) {
  const phrases = [
    "专家认为",
    "业内人士指出",
    "业内人士认为",
    "多个来源显示",
    "据相关报道",
    "据业内人士",
    "知情人士透露"
  ];
  let total = 0;
  for (const p of phrases) {
    const c = text.split(p).length - 1;
    if (c > 0) total += c;
  }
  if (total > 0) {
    issues.push({
      kind: "vague-attribution",
      severity: total >= 3 ? "warn" : "hint",
      weight: total >= 3 ? 5 : 3,
      text: `模糊归因 x${total}`,
      hint: "出现「专家 / 业内人士 / 多个来源」式无名归因。改成具体的人名 / 机构 / 时间会更可信。"
    });
  }
}

// ---------------------------------------------------------------------
// 3.5) 新增：高重复短语 / 三段对仗 / 命令式收尾
// ---------------------------------------------------------------------

/**
 * 「伪去 AI 味」专项：检测高频重复的伪人话短语 + 高频通用短语。
 *   - "说实话 / 坦白说 / 老实讲" 类伪人话短语：≥2 次直接 weight 8（AI 在伪装真人）
 *   - 任意 ≥3 字短语（按 2-gram chunk 截）出现 ≥3 次：weight = 次数 × 2，上限 10
 *
 * 这类规则不在原 `collectBlacklistIssues` 里：黑名单只看是否出现，
 * 这里看的是"出现频率"——单次出现可以接受，反复出现就是 AI 套壳。
 */
function collectRepeatedPhraseIssues(text, paragraphCount, issues, topicalTerms = "") {
  const PSEUDO_HUMAN = ["说实话", "说实在", "坦白说", "坦白讲", "老实讲", "老实说", "客观地讲", "客观地说"];
  let totalRepeat = 0;

  for (const phrase of PSEUDO_HUMAN) {
    const count = text.split(phrase).length - 1;
    if (count >= 2) {
      totalRepeat += count;
      issues.push({
        kind: "fake-honesty-repeat",
        phrase,
        count,
        severity: "error",
        weight: 8,
        text: `「${phrase}」x${count}`,
        hint: `「${phrase}」出现 ${count} 次。整篇最多 1 处，多了反而像「AI 在装真人」。改成具体动作或场景。`
      });
    } else if (count === 1) {
      totalRepeat += 1;
    }
  }

  // 通用 N-gram 重复（3–6 字）：把段落里出现频次最高的几个短语挑出来
  // 仅看 3–6 字、且不含标点、不含数字与英文字符的中文短语，避免误伤名词
  const repeatBuckets = collectFrequentNgrams(text, 3, 6, /* minRepeat */ 3);
  // 排序后取扣分最重的前 5 个，避免 issues 列表过长
  repeatBuckets.sort((a, b) => b.count - a.count);
  for (const item of repeatBuckets.slice(0, 8)) {
    if (PSEUDO_HUMAN.includes(item.phrase)) continue;
    if (isLikelyProperNoun(item.phrase)) continue;
    // 主题词：标题 / 小标题里出现过的字串 → 不是"AI 重复"，跳过
    if (topicalTerms && topicalTerms.includes(item.phrase)) continue;
    totalRepeat += item.count;
    const weight = Math.min(10, item.count * 2);
    issues.push({
      kind: "phrase-repetition",
      phrase: item.phrase,
      count: item.count,
      severity: weight >= 8 ? "error" : "warn",
      weight,
      text: `「${item.phrase}」x${item.count}`,
      hint: `短语「${item.phrase}」出现 ${item.count} 次。建议改写其中至少 ${item.count - 1} 处，避免节奏相同。`
    });
  }

  const density =
    paragraphCount > 0 ? totalRepeat / paragraphCount : totalRepeat > 0 ? 1 : 0;
  return { density };
}

/**
 * "三段对仗 / 否定式排比 / 不仅更" 句式检测。
 * 这是 AI 收尾时最爱用的修辞——单句即扣，命中后把整句返给 humanize-pass 重写。
 */
function collectParallelStructureIssues(text, issues) {
  if (!text) return;
  const patterns = [
    {
      // X，而不是 Y。
      re: /[\u4e00-\u9fa5A-Za-z0-9“”"]{2,18}[，,]\s*而不是\s*[\u4e00-\u9fa5A-Za-z0-9“”"]{2,18}[。！!？?]/g,
      label: "X，而不是 Y"
    },
    {
      re: /不是\s*[\u4e00-\u9fa5A-Za-z0-9“”"]{2,20}[，,]\s*是\s*[\u4e00-\u9fa5A-Za-z0-9“”"]{2,20}[。！!？?]/g,
      label: "不是 X，是 Y"
    },
    {
      re: /不仅\s*[\u4e00-\u9fa5A-Za-z0-9“”"]{1,18}[，,]\s*更\s*[\u4e00-\u9fa5A-Za-z0-9“”"]{1,18}[。！!？?]/g,
      label: "不仅 X，更 Y"
    },
    {
      re: /[\u4e00-\u9fa5A-Za-z0-9“”"]{2,18}[，,]?\s*而非\s*[\u4e00-\u9fa5A-Za-z0-9“”"]{2,18}[。！!？?]/g,
      label: "X 而非 Y"
    }
  ];
  for (const { re, label } of patterns) {
    const matches = String(text).match(re) || [];
    for (const sentence of matches) {
      issues.push({
        kind: "parallel-structure",
        severity: "warn",
        weight: 6,
        text: sentence.trim(),
        label,
        hint: `命中对仗结构「${label}」。这是 AI 收尾常用修辞，建议拆成陈述句或换成具体场景。`
      });
    }
  }
}

/**
 * 结尾段命令式收尾：取 article.sections[最后].paragraphs[最后] 单独检测。
 * 因为 AI 的"号召式 + 对仗"收尾几乎都集中在最后一段最后一句。
 *
 * 输入若是字符串，则降级成"取整段文本最后 200 字"。
 */
function collectEndingCommandIssues(input, issues) {
  const lastParagraph = pickLastParagraph(input);
  if (!lastParagraph) return;
  const cmdPatterns = [
    { re: /别让\s*[^。！!？?]{0,40}就\s*[^。！!？?]{0,40}[。！!]/g, label: "别让……就……" },
    { re: /应当\s*[^。！!？?]{0,30}而非\s*[^。！!？?]{0,30}[。！!]/g, label: "应当……而非……" },
    { re: /需要\s*[^。！!？?]{0,30}而不是\s*[^。！!？?]{0,30}[。！!]/g, label: "需要……而不是……" },
    { re: /要的是\s*[^。！!？?]{0,30}而不是\s*[^。！!？?]{0,30}[。！!]/g, label: "要的是……而不是……" }
  ];
  for (const { re, label } of cmdPatterns) {
    const matches = String(lastParagraph).match(re) || [];
    for (const sentence of matches) {
      issues.push({
        kind: "ending-command",
        severity: "error",
        weight: 7,
        text: sentence.trim(),
        label,
        hint: `结尾命中命令式对仗「${label}」。AI 总结口吻最强信号，改成具体场景 / 反问 / 留白。`
      });
    }
  }
}

// 升华式 / 诗意收尾检测（LLM 最爱的"金句结尾"）：只看最后一段
//  ① 否定+肯定句式：「不会在 X……（而）在 Y……」
//  ② 量词叠词排比：「一公里一公里地 / 一步一步 / 一辆辆」
function collectPoeticEndingIssues(input, issues) {
  const lastParagraph = pickLastParagraph(input);
  if (!lastParagraph) return;
  const patterns = [
    {
      re: /不(?:会|是|在|靠)[^。！!？?]{2,40}(?:而是|而在|而要|，而|，在)[^。！!？?]{2,50}[。！!]/g,
      label: "不会在 X，而在 Y"
    },
    {
      // 叠词排比：一公里一公里 / 一步一步 / 一点一点（X X 重复）
      re: /(一[\u4e00-\u9fa5]{1,2})\1地?/g,
      label: "量词叠词排比"
    },
    {
      // 一辆辆 / 一点点（一 + 字 + 同字）
      re: /一[\u4e00-\u9fa5]?([\u4e00-\u9fa5])\1/g,
      label: "量词叠词排比"
    }
  ];
  const seen = new Set();
  for (const { re, label } of patterns) {
    const matches = String(lastParagraph).match(re) || [];
    for (const m of matches) {
      const key = m.trim();
      if (seen.has(key)) continue;
      seen.add(key);
      issues.push({
        kind: "poetic-ending",
        severity: "error",
        weight: 8,
        text: key,
        label,
        hint: `结尾命中升华/诗意套路「${label}」。这是 AI 金句结尾最强信号，改成落在具体事实或留个具体悬念。`
      });
    }
  }
}

// ---------------------------------------------------------------------
// 4) 工具
// ---------------------------------------------------------------------

/**
 * 把 title / sections[].heading / sections[].subheading 拼成一个"主题词海"，
 * 重复短语命中时若在这个词海里出现，就认定是文章固有主题词，不当作 AI 痕迹。
 * 字符串输入则没有结构信息，返回空串（全部走通用过滤）。
 */
function collectTopicalTerms(input) {
  if (!input || typeof input !== "object") return "";
  const parts = [];
  if (input.title) parts.push(String(input.title));
  if (input.subtitle) parts.push(String(input.subtitle));
  const sections = Array.isArray(input.sections) ? input.sections : [];
  for (const sec of sections) {
    if (!sec || typeof sec !== "object") continue;
    if (sec.heading) parts.push(String(sec.heading));
    if (sec.subheading) parts.push(String(sec.subheading));
  }
  return parts.join(" ");
}

function pickLastParagraph(input) {
  if (!input) return "";
  if (typeof input === "string") {
    const text = stripHtmlTags(input);
    const paras = text.split(/\n+/).map((s) => s.trim()).filter(Boolean);
    return paras.length ? paras[paras.length - 1] : text.slice(-200);
  }
  if (typeof input !== "object") return "";

  const sections = Array.isArray(input.sections) ? input.sections : [];
  for (let i = sections.length - 1; i >= 0; i -= 1) {
    const sec = sections[i];
    if (!sec || !Array.isArray(sec.paragraphs)) continue;
    for (let j = sec.paragraphs.length - 1; j >= 0; j -= 1) {
      const p = sec.paragraphs[j];
      const text = String(p || "").trim();
      if (text) return text;
    }
  }
  if (input.closing) return String(input.closing).trim();
  // bodyHtml 形态（workspace 实际改写产物）：剥标签后取最后一段
  if (typeof input.bodyHtml === "string" && input.bodyHtml.trim()) {
    return pickLastParagraph(input.bodyHtml);
  }
  return "";
}

function countParagraphs(input) {
  if (!input) return 0;
  if (typeof input === "string") {
    const text = stripHtmlTags(input);
    return text.split(/\n+/).filter((s) => s.trim()).length || 1;
  }
  if (typeof input !== "object") return 0;

  let n = 0;
  if (input.lead) n += 1;
  const sections = Array.isArray(input.sections) ? input.sections : [];
  for (const sec of sections) {
    if (!sec || !Array.isArray(sec.paragraphs)) continue;
    for (const p of sec.paragraphs) {
      if (String(p || "").trim()) n += 1;
    }
  }
  if (input.closing) n += 1;
  return Math.max(1, n);
}

/**
 * 极简 N-gram 频次统计（中文）：扫描所有 size 在 [minLen, maxLen] 的连续中文片段，
 * 统计出现次数 ≥ minRepeat 的短语；同时去掉被更长短语完全包含的短串（比如
 * "量子" 出现 12 次，"量子计算" 出现 4 次时，只留 "量子计算"）。
 *
 * 这样不需要分词器也能在 service worker 里跑。
 */
function collectFrequentNgrams(text, minLen, maxLen, minRepeat) {
  if (!text) return [];
  // 仅保留中文 / 英文 / 数字段落，按非中英数字字符切片，得到短语候选块
  const chunks = String(text).split(/[^\u4e00-\u9fa5A-Za-z0-9]+/).filter(Boolean);
  const counter = new Map();

  for (const chunk of chunks) {
    if (chunk.length < minLen) continue;
    const upper = Math.min(maxLen, chunk.length);
    for (let len = minLen; len <= upper; len += 1) {
      for (let i = 0; i + len <= chunk.length; i += 1) {
        const piece = chunk.slice(i, i + len);
        if (!isInterestingNgram(piece)) continue;
        counter.set(piece, (counter.get(piece) || 0) + 1);
      }
    }
  }

  const candidates = [];
  for (const [phrase, count] of counter.entries()) {
    if (count >= minRepeat) candidates.push({ phrase, count });
  }
  // 去包含：保留更长的短语
  candidates.sort((a, b) => b.phrase.length - a.phrase.length || b.count - a.count);
  const kept = [];
  for (const item of candidates) {
    const dominated = kept.some(
      (k) => k.phrase !== item.phrase && k.phrase.includes(item.phrase) && k.count >= item.count
    );
    if (!dominated) kept.push(item);
  }
  return kept;
}

function isInterestingNgram(s) {
  if (!s) return false;
  // 至少包含 1 个中文，避免英文/数字误命中
  if (!/[\u4e00-\u9fa5]/.test(s)) return false;
  // 以助词 / 介词 / 连接词开头：多半是跨词 n-gram 噪声（"的量子" / "了一个" / "也只是"），
  // 不是真正的"AI 套话"——直接排除
  if (/^[的了也就还又而或在和与并把被则即被对从如要]/.test(s)) return false;
  // 以助词结尾的 n-gram 也是跨词噪声（"量子的" / "结果了"）
  if (/[的了]$/.test(s)) return false;
  // 全是常见连接词不算
  const STOP = new Set([
    "的话", "因为", "所以", "但是", "我们", "他们", "自己", "然后", "可以",
    "其实", "这种", "那种", "这样", "那样", "一个", "一些", "一直",
    "只是", "也是", "就是", "还是", "才是"
  ]);
  if (STOP.has(s)) return false;
  return true;
}

function isLikelyProperNoun(s) {
  // 含连续大写字母 / 全是英文 / 含数字 → 多半是产品名 / 代号，不算"AI 重复"
  if (!s) return false;
  if (/^[A-Za-z]+$/.test(s)) return true;
  if (/[A-Z]{2,}/.test(s)) return true;
  if (/^\d/.test(s)) return true;
  return false;
}


function countMatches(str, re) {
  if (!str) return 0;
  // 防止全局 lastIndex 状态污染
  const safe = new RegExp(re.source, re.flags.includes("g") ? re.flags : `${re.flags}g`);
  return (String(str).match(safe) || []).length;
}

function densityPer(str, re, totalChars, base) {
  const count = countMatches(str, re);
  if (!totalChars || totalChars <= 0) return 0;
  return (count * base) / totalChars;
}

function severityToWeight(severity) {
  if (severity === "error") return 8;
  if (severity === "warn") return 4;
  return 2;
}

function severityRank(severity) {
  if (severity === "error") return 3;
  if (severity === "warn") return 2;
  return 1;
}

function round2(n) {
  if (!Number.isFinite(n)) return 0;
  return Math.round(n * 100) / 100;
}

// ---------------------------------------------------------------------
// 5) 测试导出
// ---------------------------------------------------------------------

export const __INTERNAL = Object.freeze({
  stripHtmlTags,
  extractPlainText
});
