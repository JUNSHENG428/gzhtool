/**
 * Agent 用到的所有 prompt 模板。
 *
 * 当前只有两个：
 *   1. buildBriefMessages    跑批后一次性总结（选题总监人设）
 *   2. buildAngleOutlineMessages  Drill-Down：针对某条 angle 出完整提纲（轻量版）
 *
 * 通用约定：模型只输出合法 JSON，附带 normalize* 兜底，避免 UI 空白。
 */

/* ============== 1. brief（选题总结） ============== */

export function buildBriefMessages({ query, hits }) {
  const compactHits = hits.slice(0, 10).map((hit, index) => ({
    index: index + 1,
    platform: hit.platformName,
    title: hit.title,
    author: hit.author,
    hot: hit.hotScore,
    summary: cutString(hit.summary, 200),
    url: hit.url
  }));

  const system = [
    "你是公众号编辑团队里的「选题总监」。",
    "用户会给你一个主题词，以及多个平台搜回来的热帖摘要。",
    "请基于这些信息总结当前讨论的核心走向，并给出可上手的写作角度。",
    "硬约束：",
    "1. 只输出合法 JSON，不要附加任何 Markdown、注释或解释文本。",
    "2. JSON 字段必须包含：themeSummary（string，120-180 字）、hotTakeaways（string[]，3-5 条）、recommendedAngles（string[]，3 条）、titleCandidates（string[]，5 条）、riskNotes（string）。",
    "3. 分析必须基于提供的 hits，不要编造数据；引用具体观点时尽量用中文转述。",
    "4. titleCandidates 控制在 16-30 字，避免标题党，但可以带钩子。",
    "5. riskNotes 提醒可能的事实核查 / 版权 / 平台合规风险（最多 2 句）。"
  ].join("\n");

  const user = [
    `主题关键词：${query}`,
    "",
    "已抓取的热帖（按筛选排名展示）：",
    JSON.stringify(compactHits, null, 2)
  ].join("\n");

  return [
    { role: "system", content: system },
    { role: "user", content: user }
  ];
}

export function normalizeBrief(raw) {
  const safe = raw && typeof raw === "object" ? raw : {};
  return {
    themeSummary: typeof safe.themeSummary === "string" ? safe.themeSummary.trim() : "",
    hotTakeaways: normalizeStringArray(safe.hotTakeaways).slice(0, 6),
    recommendedAngles: normalizeStringArray(safe.recommendedAngles).slice(0, 5),
    titleCandidates: normalizeStringArray(safe.titleCandidates).slice(0, 8),
    riskNotes: typeof safe.riskNotes === "string" ? safe.riskNotes.trim() : ""
  };
}

/* ============== 2. angle outline（Drill-Down 轻量版） ============== */

/**
 * 针对一条 recommendedAngle，调一次 AI 出完整提纲。
 * 轻量版字段：title / outline[5-7]（每段一个 heading + 1-2 句要点）/ keyPoints / referencedHits（命中下标）
 *
 * @param {object} params
 * @param {string} params.query        主题关键词（提供上下文）
 * @param {string} params.angle        当前选中的角度
 * @param {Array}  params.hits         已筛选的 hits（提示模型可引用其中哪些）
 */
export function buildAngleOutlineMessages({ query, angle, hits }) {
  const compactHits = (Array.isArray(hits) ? hits : []).slice(0, 10).map((hit, index) => ({
    index: index + 1,
    platform: hit.platformName,
    title: hit.title,
    summary: cutString(hit.summary, 160)
  }));

  const system = [
    "你是公众号资深主笔，擅长把一条选题角度展开成可写的提纲。",
    "硬约束：",
    "1. 只输出合法 JSON，不要附加任何 Markdown、注释或解释文本。",
    "2. JSON 字段必须包含：title（string，16-30 字，符合公众号语感）、outline（数组，5-7 段，每段含 heading 与 summary）、keyPoints（string[]，3-5 条核心论点）、referencedHits（int[]，引用的 hit 下标）。",
    "3. outline 顺序大致是「开场钩子 → 背景 / 现象 → 关键洞察 → 案例 / 论据 → 拆解 / 方法 → 反思 / 风险（可选）→ 结尾呼应（可选）」。",
    "4. 提纲必须紧扣「主题词 + 给定角度」，不要跑题。",
    "5. heading 8-16 字，summary 30-80 字。",
    "6. referencedHits 只填实际引用到的 hit 下标，没有就给空数组。"
  ].join("\n");

  const user = [
    `主题关键词：${query}`,
    `选中的角度：${angle}`,
    "",
    "可参考的热帖摘要（不必全部引用）：",
    JSON.stringify(compactHits, null, 2)
  ].join("\n");

  return [
    { role: "system", content: system },
    { role: "user", content: user }
  ];
}

export function normalizeOutline(raw) {
  const safe = raw && typeof raw === "object" ? raw : {};
  const outline = Array.isArray(safe.outline) ? safe.outline : [];
  return {
    title: typeof safe.title === "string" ? safe.title.trim() : "",
    outline: outline
      .map((item) => ({
        heading: typeof item?.heading === "string" ? item.heading.trim() : "",
        summary: typeof item?.summary === "string" ? item.summary.trim() : ""
      }))
      .filter((item) => item.heading || item.summary)
      .slice(0, 8),
    keyPoints: normalizeStringArray(safe.keyPoints).slice(0, 6),
    referencedHits: Array.isArray(safe.referencedHits)
      ? safe.referencedHits
          .map((n) => Math.round(Number(n)))
          .filter((n) => Number.isFinite(n) && n > 0)
          .slice(0, 8)
      : []
  };
}

/* ============== helpers ============== */

function cutString(text, max) {
  const s = String(text || "").replace(/\s+/g, " ").trim();
  return s.length > max ? `${s.slice(0, max)}…` : s;
}

function normalizeStringArray(value) {
  if (!Array.isArray(value)) return [];
  return value.map((item) => String(item || "").trim()).filter(Boolean);
}
