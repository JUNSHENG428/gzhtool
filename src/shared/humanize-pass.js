/**
 * src/shared/humanize-pass.js
 * ====================================================================
 * 「去 AI 味」二次润色 pass
 *
 * 在主 pass 已经产出结构化 article 后，再过一次 LLM。本 pass 只做
 * "去 AI 味"，绝不改结构、绝不改事实，让结果在 lint 报告上把分数推到 90+。
 *
 * 调用入口：service-worker.js REWRITE_ARTICLE 完成主 pass 后，依据
 *   - settings.humanizeEnabled
 *   - license.canDeAiBoost()（PRO 闸门）
 *   - template.useVoiceSample / template.humanizeProfile
 * 来决定是否调用本模块。
 *
 * 输入：
 *   {
 *     article,        // 主 pass 产出的 normalize 后 article（含 sections）
 *     settings,       // 全局 settings（含 API、humanizeIntensity 等）
 *     template,       // 当前模板（用于读取 humanizeProfile）
 *     lintReport,     // humanize-checker 的输出（可空）
 *     voiceSample,    // 「我的文风」样本（可空）
 *     intensity       // 'light' | 'medium' | 'strong'，覆盖 settings
 *     onProgress?,    // (info: { phase, current, total }) => void
 *     abortSignal?    // AbortSignal，触发后 in-flight fetch 立即中断
 *   }
 *
 * 输出：
 *   {
 *     article,        // 重写后的 article（结构与输入完全相同）
 *     applied,        // boolean，是否真的至少改了一段
 *     sectionCount,   // 实际重写的 section 数量
 *     intensity,      // 实际生效的强度
 *     aborted,        // boolean，是否因为 abortSignal 被打断
 *     errors          // string[]，逐段失败时记录的错误（不抛异常）
 *   }
 *
 * 设计取舍：
 *   - 逐 section 调用：单段 prompt 短，质量更稳；任一段失败时该段回退
 *     原文，整篇仍可用。token 成本 ≈ 主 pass 的 1.3–1.8 倍。
 *   - 默认 6 并发：用一个极简的 concurrency 闸（不引外部依赖），
 *     既显著缩短等待（5–8 段从串行 200s+ 压到 max(单段) ≈ 30–40s），
 *     又给小型自托管 OpenAI 兼容服务留出限流空间。AbortError / 429
 *     / 5xx 触发后该段回退原文，整体不阻塞。
 *   - 不输出 JSON Schema，只让 LLM 输出"段落用空行分隔的纯文本"，对齐
 *     paragraphs 数组；这样最不容易被 LLM 因为 JSON 错乱而整段崩溃。
 *   - 不重写 quote / bulletPoints / imageRefs / codeBlocks / tables，
 *     避免 LLM 顺手"改进"列表语气、生造金句；事实层完全保留。
 *   - lead 单独走一次（短文本，单独 prompt 更稳）。
 */

import {
  AI_VOCAB_BLACKLIST,
  AI_PHRASE_BLACKLIST,
  PUNCTUATION_LIMITS,
  BURSTINESS_TARGET,
  getHumanizeProfile,
  getTopRuleCards,
  AI_VOCAB_REPLACEMENTS
} from "./humanize-rules.js";
import { extractChatContent } from "./ai.js";
import { ensureOptionalHostPermission } from "./host-permissions.js";

// ---------------------------------------------------------------------
// 入口
// ---------------------------------------------------------------------

// 并发上限：默认 6。多数 OpenAI 兼容服务（OpenAI / Anthropic / DeepSeek /
// 阿里 DashScope / 火山方舟 / 智谱）的 RPM 配额都在 60+，6 路并发安全。
// 自部署 vLLM / Ollama / 某些 SaaS humanizer 限制更严时，单段 fetch 失败
// 会回退原文，不影响其它段。要彻底关并发可在 settings 里把 humanizeMaxConcurrency 设为 1。
const DEFAULT_MAX_CONCURRENCY = 6;

/**
 * @param {object} params
 * @param {object} params.article
 * @param {object} params.settings
 * @param {object} [params.template]
 * @param {object} [params.lintReport]
 * @param {object} [params.voiceSample]
 * @param {"light"|"medium"|"strong"} [params.intensity]
 * @param {(info: { phase: string, current: number, total: number, label?: string }) => void} [params.onProgress]
 * @param {AbortSignal} [params.abortSignal]
 * @returns {Promise<{ article: object, applied: boolean, sectionCount: number, intensity: string, aborted: boolean, errors: string[] }>}
 */
export async function runHumanizePass({
  article,
  settings,
  template = null,
  lintReport = null,
  voiceSample = null,
  intensity,
  onProgress,
  abortSignal
}) {
  const errors = [];
  if (!article || typeof article !== "object") {
    return { article, applied: false, sectionCount: 0, intensity: "off", aborted: false, errors };
  }
  if (!settings?.apiKey || !settings?.apiBaseUrl) {
    errors.push("API 未配置，跳过二次润色。");
    return { article, applied: false, sectionCount: 0, intensity: "off", aborted: false, errors };
  }

  const effIntensity = normalizeIntensity(
    intensity || settings.humanizeIntensity || template?.humanizeProfile?.intensity || "medium"
  );

  const profile = {
    ...getHumanizeProfile(template?.id || ""),
    ...(template?.humanizeProfile || {})
  };

  // 决定哪些 section 需要重写：
  //  - light：只对 lint 命中（issues 关联到段落）的 section 跑
  //  - medium：只跑被 lint issues 命中关键词的段 + lead（不再"全段跑"）
  //  - strong：全部 section + lead，且每段都注入 voice sample
  const sections = Array.isArray(article.sections) ? article.sections : [];
  const needRewrite = pickSectionsToRewrite(sections, lintReport, effIntensity);
  const passLead = effIntensity !== "light" && typeof article.lead === "string" && article.lead.trim();

  const cloned = cloneShallowArticle(article);

  // 把所有要重写的任务收集到 tasks，再通过 concurrency gate 并发执行：
  //   - lead（如需要）
  //   - 每个命中 needRewrite 的 section
  // 任务对象都带 apply(rewrittenText) 回调，回调里再做对齐 / 校验，
  // 并发段全部 settled 后顺序触发，避免对 cloned 的写入竞态。
  const tasks = [];

  if (passLead) {
    tasks.push({
      label: "lead",
      run: () =>
        rewriteSnippet({
          text: cloned.lead,
          kind: "lead",
          settings,
          template,
          profile,
          intensity: effIntensity,
          voiceSample,
          issues: filterIssuesForKind(lintReport, "lead"),
          abortSignal
        }),
      apply: (newLead) => {
        if (newLead && newLead.trim() && newLead !== cloned.lead) {
          cloned.lead = newLead.trim();
          return true;
        }
        return false;
      }
    });
  }

  for (let i = 0; i < cloned.sections.length; i += 1) {
    const sec = cloned.sections[i];
    if (!sec || !Array.isArray(sec.paragraphs) || sec.paragraphs.length === 0) continue;
    if (!needRewrite.has(i)) continue;
    const original = sec.paragraphs.map((p) => String(p || "")).join("\n\n");
    if (!original.trim()) continue;

    tasks.push({
      label: `section[${i}]`,
      sectionIndex: i,
      originalParagraphCount: sec.paragraphs.length,
      run: () =>
        rewriteSnippet({
          text: original,
          kind: "section",
          heading: sec.heading || "",
          settings,
          template,
          profile,
          intensity: effIntensity,
          voiceSample,
          issues: filterIssuesForKind(lintReport, "section"),
          abortSignal
        }),
      apply: (rewritten) => {
        if (!rewritten || !rewritten.trim()) return false;
        const newParas = splitParagraphs(rewritten);
        const ratio = newParas.length / Math.max(1, sec.paragraphs.length);
        if (ratio < 0.5 || ratio > 1.8) {
          errors.push(
            `section[${i}] 段数偏差过大（${sec.paragraphs.length} → ${newParas.length}），回退原文。`
          );
          return false;
        }
        sec.paragraphs = newParas;
        return true;
      }
    });
  }

  const total = tasks.length;
  if (total === 0) {
    return { article: cloned, applied: false, sectionCount: 0, intensity: effIntensity, aborted: false, errors };
  }

  reportProgress(onProgress, { phase: "pass2:start", current: 0, total });

  const maxConcurrency = clamp(
    Number(settings.humanizeMaxConcurrency) || DEFAULT_MAX_CONCURRENCY,
    1,
    12
  );

  let applied = 0;
  let completed = 0;
  let aborted = false;

  // 并发执行：runWithConcurrency 内部按 maxConcurrency 维护 in-flight，
  // 每个 task 的 promise 既会推进 progress，也会把 apply 回调推进 cloned。
  const results = await runWithConcurrency(tasks, maxConcurrency, async (task) => {
    if (abortSignal?.aborted) {
      aborted = true;
      throw new Error("aborted");
    }
    try {
      const out = await task.run();
      const ok = task.apply(out);
      if (ok) applied += 1;
      return { ok, label: task.label };
    } catch (err) {
      const msg = String(err?.message || err);
      if (msg.includes("aborted") || abortSignal?.aborted) {
        aborted = true;
      } else {
        errors.push(`${task.label} 二次润色失败：${msg}`);
      }
      return { ok: false, label: task.label };
    } finally {
      completed += 1;
      reportProgress(onProgress, {
        phase: "pass2:tick",
        current: completed,
        total,
        label: task.label
      });
    }
  });
  void results;

  reportProgress(onProgress, { phase: "pass2:done", current: completed, total });

  return {
    article: cloned,
    applied: applied > 0,
    sectionCount: applied,
    intensity: effIntensity,
    aborted,
    errors
  };
}

/**
 * 极简并发闸：用 limit 把任务数限制成 in-flight ≤ limit 的并发。
 * 不引外部依赖（p-limit / async / bottleneck 都太重），手写 12 行就够。
 *
 * 注意：worker 内部异常已经被 task wrapper 吞了，这里只关心执行节奏。
 */
async function runWithConcurrency(tasks, limit, worker) {
  const out = new Array(tasks.length);
  let cursor = 0;
  const runners = new Array(Math.min(limit, tasks.length)).fill(0).map(async () => {
    while (true) {
      const i = cursor;
      cursor += 1;
      if (i >= tasks.length) return;
      out[i] = await worker(tasks[i]);
    }
  });
  await Promise.all(runners);
  return out;
}

function reportProgress(onProgress, info) {
  if (typeof onProgress !== "function") return;
  try {
    onProgress(info);
  } catch (err) {
    // progress callback 不应该影响主流程
    void err;
  }
}

// ---------------------------------------------------------------------
// Section 选择策略
// ---------------------------------------------------------------------

/**
 * 决定哪些 section 需要重写。
 *
 *  - strong：全部 section（用户主动选了"最强"，不省 token）
 *  - medium：lint 命中段 + 标点超量段；如果一段都没命中（lint 已经很干净），
 *            退化成"重写最长段做安全网"，避免空跑
 *  - light：与 medium 同样的命中筛选，但只跑权重最高的 1 段
 *
 * 之前的 medium 是直接 `sections.forEach((_, i) => idx.add(i))` 全段跑，
 * 等于"重写全文"，token 成本高、等待长。新版本让 medium 紧贴 lint 报告，
 * 把"和 AI 痕迹无关"的段直接放过去，期望耗时与 token 同步压缩 30–60%。
 */
function pickSectionsToRewrite(sections, lintReport, intensity) {
  const idx = new Set();
  if (!Array.isArray(sections) || sections.length === 0) return idx;

  // strong：保持全段重写（最大化 voice sample 注入面 + 全篇统一节奏）
  if (intensity === "strong") {
    sections.forEach((_, i) => idx.add(i));
    return idx;
  }

  // medium / light：只跑 lint 命中段
  const issues = lintReport?.issues || [];
  const phrases = new Set();
  for (const it of issues) {
    if (it?.text) phrases.add(it.text);
    if (it?.phrase) phrases.add(it.phrase);
  }

  const sectionScores = sections.map((sec, i) => {
    if (!sec || !Array.isArray(sec.paragraphs)) return { i, score: 0 };
    const joined = sec.paragraphs.join("\n");
    let score = 0;
    for (const p of phrases) {
      if (p && joined.includes(p)) score += 1;
    }
    const dashHits = (joined.match(/——|—/g) || []).length;
    const charCount = joined.replace(/\s+/g, "").length;
    if (charCount > 0 && (dashHits * 500) / charCount > PUNCTUATION_LIMITS.dashesPer500 + 0.5) {
      score += 1;
    }
    return { i, score };
  });

  if (intensity === "light") {
    // light：取得分最高的 1 段；全无命中时退到最长段
    let best = sectionScores
      .filter((s) => s.score > 0)
      .sort((a, b) => b.score - a.score)[0];
    if (!best) {
      let longest = -1;
      let longestIdx = -1;
      sections.forEach((sec, i) => {
        const len = (sec?.paragraphs || []).join("").length;
        if (len > longest) {
          longest = len;
          longestIdx = i;
        }
      });
      if (longestIdx >= 0) idx.add(longestIdx);
    } else {
      idx.add(best.i);
    }
    return idx;
  }

  // medium：所有 score > 0 的段；零命中时退到"重写全部 section"做兜底
  for (const s of sectionScores) {
    if (s.score > 0) idx.add(s.i);
  }
  if (idx.size === 0) {
    sections.forEach((_, i) => idx.add(i));
  }
  return idx;
}

function filterIssuesForKind(lintReport, kind) {
  // checker 目前是按全文给 issues，没有按段落定位。这里直接返回 top N 条让 prompt 用，
  // 不强制对应到具体 section（让 LLM 自己识别）。
  //
  // 新增：高优先级"精准 issue"（fake-honesty-repeat / phrase-repetition /
  // parallel-structure / ending-command）必须全部带进 prompt，否则下面的
  // 三块「反伪去 AI 味 / 反三段对仗 / 反命令式收尾」拿不到任何条目，
  // 也就无法做精准重写。先把它们捞出来，剩下额度再放给通用 issues。
  const issues = lintReport?.issues || [];
  const PRIORITY_KINDS = new Set([
    "fake-honesty-repeat",
    "phrase-repetition",
    "parallel-structure",
    "ending-command"
  ]);
  const priority = issues.filter((it) => it && PRIORITY_KINDS.has(it.kind));
  const rest = issues.filter((it) => it && !PRIORITY_KINDS.has(it.kind));
  // 优先 issue 全收（一般也就 5–10 条），通用最多再补 6 条
  return [...priority.slice(0, 12), ...rest.slice(0, 6)];
}

// ---------------------------------------------------------------------
// 单段重写（核心 LLM 调用）
// ---------------------------------------------------------------------

async function rewriteSnippet({
  text,
  kind,
  heading,
  settings,
  template,
  profile,
  intensity,
  voiceSample,
  issues,
  abortSignal
}) {
  const system = buildHumanizeSystemPrompt({
    profile,
    intensity,
    issues,
    voiceSample,
    template
  });
  const user = buildHumanizeUserPrompt({ text, kind, heading });

  const model =
    String(template?.model || "").trim() || String(settings.model || "").trim();

  // 用更高的 temperature 推动多样性；frequency_penalty 比主 pass 更狠，
  // 防止"换皮还是同一套套话"。
  const body = {
    model,
    temperature: clamp(Number(settings.temperature ?? 0.85) + 0.05, 0.5, 1.2),
    top_p: numberOrSkip(settings.topP) ?? 0.92,
    frequency_penalty: numberOrSkip(settings.frequencyPenalty) ?? 0.6,
    presence_penalty: numberOrSkip(settings.presencePenalty) ?? 0.4,
    messages: [
      { role: "system", content: system },
      { role: "user", content: user }
    ]
  };

  const fetchInit = {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${settings.apiKey.trim()}`
    },
    body: JSON.stringify(body)
  };
  if (abortSignal) fetchInit.signal = abortSignal;

  const apiUrl = settings.apiBaseUrl.trim();
  await ensureOptionalHostPermission(apiUrl, "去 AI 味二次润色接口");

  const response = await fetch(apiUrl, fetchInit);

  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    const message =
      payload?.error?.message ||
      payload?.message ||
      `HTTP ${response.status}`;
    throw new Error(message);
  }
  const out = String(extractChatContent(payload) || "").trim();
  if (!out) throw new Error("LLM 返回空内容");
  return stripCodeFences(out);
}

// ---------------------------------------------------------------------
// Prompt 拼装
// ---------------------------------------------------------------------

function buildHumanizeSystemPrompt({ profile, intensity, issues, voiceSample, template }) {
  const cards = getTopRuleCards(intensity === "strong" ? 10 : 8);
  const cardLines = cards.map((c) => `- 【${c.label}】${c.do}（避免：${c.dont}）`);
  const blacklistTop = AI_VOCAB_BLACKLIST.filter((x) => x.weight >= 7)
    .slice(0, 10)
    .map((x) => x.phrase);
  const phraseTop = AI_PHRASE_BLACKLIST.filter((x) => x.weight >= 8)
    .slice(0, 6)
    .map((x) => x.phrase);
  const dictLines = AI_VOCAB_REPLACEMENTS.slice(0, 8).map(
    ([from, to]) => `「${from}」→ ${to}`
  );

  const stdMin = Number(profile.burstinessMin || BURSTINESS_TARGET.minStdOverMean).toFixed(2);
  const dashLimit = Number(profile.dashesPer500 || PUNCTUATION_LIMITS.dashesPer500);
  const allowFp = profile.allowFirstPerson !== false;

  // 把 issues 拆成三类，分别给 LLM 更精确的指令：
  //  - repeated：用户在样本里"过度模仿真人"导致的同一短语反复（如"说实话×4"）
  //    → 必须把多余的删掉，最多保留 1 处
  //  - parallel：三段对仗结构（X 而不是 Y / 不是 X 是 Y / 不仅 X 更 Y）
  //    → 整句改写，避免 AI 总结口吻
  //  - ending：结尾段命令式收尾（别让...就... / 应当...而非...）
  //    → 改成具体场景或反问，不许保留对仗对偶
  //  - others：其它 lint issue 走通用的"必修 / 建议"列表
  const repeatedIssues = [];
  const parallelIssues = [];
  const endingIssues = [];
  const otherIssues = [];
  for (const it of issues || []) {
    if (!it || (!it.hint && !it.text)) continue;
    // checker 实际产出的 kind 见 humanize-checker.js：
    //   - fake-honesty-repeat：「说实话 / 坦白说」类伪人话短语反复
    //   - phrase-repetition：普通短语 ≥3 次
    //   - parallel-structure：X 而不是 Y / 不是 X 是 Y / 不仅 X 更 Y / X 而非 Y
    //   - ending-command：结尾段命令式收尾（别让...就... / 应当...而非...）
    if (it.kind === "fake-honesty-repeat" || it.kind === "phrase-repetition") {
      repeatedIssues.push(it);
    } else if (it.kind === "parallel-structure") {
      parallelIssues.push(it);
    } else if (it.kind === "ending-command") {
      endingIssues.push(it);
    } else {
      otherIssues.push(it);
    }
  }
  const issueLines = otherIssues
    .map((i) => `- ${i.severity === "error" ? "[必修]" : "[建议]"} ${i.text || ""}：${i.hint || ""}`)
    .slice(0, 6);

  const usePolicy = String(template?.useVoiceSample || "auto");
  const includeVoice = voiceSample && usePolicy !== "force-off";

  const lines = [
    "你是一位资深公众号编辑，正在为一篇已经写好的稿件做「去 AI 味」专项润色。",
    "",
    "你只做一件事：把段落重写成更像真人写的版本。事实、数据、人名、产品名、引号内文字、列表项、代码块、表格行均不得新增或删减；只改写措辞、节奏、句式与情绪。",
    "",
    "【输出要求】",
    "- 直接输出重写后的段落正文，段落之间用一个空行分隔。",
    "- 不要输出 markdown 代码块、不要输出解释、不要输出 JSON。",
    "- 段落数量与原文偏差应控制在 50% 以内（可合并或拆分相邻段，但不要从 5 段变 1 段）。",
    "",
    "【硬约束 · 句长突发性】",
    `- 句长策略：${BURSTINESS_TARGET.ratioGuide}。整段标准差/均值 ≥ ${stdMin}。`,
    "- 相邻三句不得长度相同；至少出现 1 处 1–2 句的短段当节奏呼吸。",
    "",
    "【硬约束 · 高优先级规则卡】",
    ...cardLines,
    "",
    "【硬约束 · 黑名单（绝不出现）】",
    "- 抽象壳词与套话动词：" + blacklistTop.join(" / "),
    "- 套话短语：" + phraseTop.join(" ／ "),
    `- 破折号「——」每 500 字不超过 ${dashLimit} 个；感叹号每 500 字不超过 ${PUNCTUATION_LIMITS.exclamPer500} 个。`,
    "- 「**标签**：内容」式的内联标题列表禁止出现在新文里。",
    "- 「希望对您有帮助 / 当然可以 / 让我为您 / 您说得对 / 好问题」等聊天残留必须删除。",
    "",
    "【硬约束 · 信息噪声】",
    "- 数字 / 时间 / 场景必须保留原文具体值；不要把具体值替换成「大量 / 显著 / 明显 / 重要」。",
    "- 「专家认为 / 业内人士指出 / 多个来源显示」等模糊归因必须改成具体名字或删除。",
    "",
    "【硬约束 · 反三段式】",
    "- 「不仅…而且…」「既要…也要…」「首先…其次…最后」必须改写。",
    "- 连续 3 项及以上并列必须收成 2 项或拆成不同句子。",
    "",
    allowFp
      ? "【允许】可在段落里加 1–2 处带主观判断的句子（说实话…/讲真…/回过头看…），让稿子有真人观察。"
      : "【约束】保持客观，不要出现第一人称或情绪表达。",
    "",
    "【AI 词替换字典（参考）】",
    ...dictLines.map((s) => "- " + s)
  ];

  // 反「伪去 AI 味」：当用户有重复使用的口语词（说实话×4 这种），
  // 不要再让 LLM 加更多口语词；提醒它「该简单的简单、该犀利的犀利」。
  if (repeatedIssues.length > 0) {
    lines.push("");
    lines.push("【反伪去 AI 味 · 必修】上一稿有些短语用得太多，反而像 AI 在「伪装真人」。请把它们的出现次数压到不超过 1 次：");
    for (const it of repeatedIssues.slice(0, 6)) {
      const phrase = it.phrase || it.text || "";
      const count = it.count || "若干";
      lines.push(`- 「${phrase}」当前出现 ${count} 次 → 全文最多保留 1 处；其它位置改用具体动作 / 数字 / 场景代替。`);
    }
    lines.push("- 不是堆口语词就像真人。该简单的简单、该犀利的犀利，比『频繁说说实话』更接近真人写作。");
  }

  if (parallelIssues.length > 0) {
    lines.push("");
    lines.push("【反三段对仗 · 必修】上一稿有典型 AI 对仗 / 否定式排比，必须整句改写：");
    for (const it of parallelIssues.slice(0, 6)) {
      const example = it.text || it.hint || "";
      lines.push(`- 命中：${example}`);
    }
    lines.push("- 把 X，而不是 Y / 不是 X，是 Y / 不仅 X，更 Y / X 而非 Y 整句拆开；用一句陈述或一个场景描写替换。");
  }

  if (endingIssues.length > 0) {
    lines.push("");
    lines.push("【反命令式收尾 · 必修】文章最后一段是 AI 总结口吻，必须改写成具体场景或自问自答，不许保留对仗对偶：");
    for (const it of endingIssues.slice(0, 3)) {
      lines.push(`- 命中：${it.text || it.hint || ""}`);
    }
    lines.push("- 不要写『行业需要清醒，而不是恐慌』这种平衡式总结；不要写『别让 X 就 Y』这种命令式劝诫。");
  }

  if (issueLines.length > 0) {
    lines.push("");
    lines.push("【lint 报告 · 其它具体风险点，必须在新稿里清除】");
    lines.push(...issueLines);
  }

  if (includeVoice) {
    lines.push("");
    lines.push("【可选 · 个人文风学习】下一稿请尽量靠近以下作者写作习惯：");
    const fp = voiceSample.fingerprint || {};
    if (fp.avgSentenceLen) lines.push(`- 平均句长约 ${Number(fp.avgSentenceLen).toFixed(1)} 字`);
    if (Array.isArray(fp.signaturePhrases) && fp.signaturePhrases.length) {
      lines.push("- 常用语气词：" + fp.signaturePhrases.slice(0, 6).map((s) => `「${s}」`).join("、"));
    }
    if (Array.isArray(fp.toneTags) && fp.toneTags.length) {
      lines.push("- 语气标签：" + fp.toneTags.slice(0, 5).join(" / "));
    }
    if (Array.isArray(fp.forbidden) && fp.forbidden.length) {
      lines.push("- 这位作者从不使用：" + fp.forbidden.slice(0, 6).join(" / "));
    }
  }

  return lines.join("\n");
}

function buildHumanizeUserPrompt({ text, kind, heading }) {
  const head =
    kind === "lead"
      ? "下面是文章导语段。请重写："
      : heading
        ? `下面是 H2 「${heading}」之下的段落。请重写：`
        : "下面是一段正文。请重写：";
  return [
    head,
    "",
    text
  ].join("\n");
}

// ---------------------------------------------------------------------
// 工具
// ---------------------------------------------------------------------

function normalizeIntensity(value) {
  const v = String(value || "").toLowerCase();
  if (v === "light" || v === "strong") return v;
  return "medium";
}

function numberOrSkip(value) {
  if (value == null || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function clamp(n, min, max) {
  if (!Number.isFinite(n)) return min;
  return Math.max(min, Math.min(max, n));
}

function splitParagraphs(text) {
  return String(text || "")
    .split(/\n\s*\n/)
    .map((p) => p.trim())
    .filter(Boolean);
}

function stripCodeFences(text) {
  const m = String(text).match(/^```(?:\w+)?\s*([\s\S]*?)\s*```$/);
  return m?.[1] ? m[1].trim() : String(text).trim();
}

/**
 * 浅克隆 article 并深克隆 sections / paragraphs，避免在原对象上写。
 * 不深克隆 codeBlocks / tables / mathBlocks（不打算改）。
 */
function cloneShallowArticle(article) {
  const out = { ...article };
  out.sections = (Array.isArray(article.sections) ? article.sections : []).map((s) => ({
    ...s,
    paragraphs: Array.isArray(s.paragraphs) ? [...s.paragraphs] : [],
    bulletPoints: Array.isArray(s.bulletPoints) ? [...s.bulletPoints] : []
  }));
  return out;
}

