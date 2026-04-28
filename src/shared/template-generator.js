/**
 * src/shared/template-generator.js
 * ====================================================================
 * AI 模板生成器（Pro 专享） · 问卷驱动版 v0.4
 *
 * ---- 它做什么 ----
 * 用户答 7 道选择题 + 2 个选填补充，调用用户已配置的 LLM，吐出一个
 * 完整可用的"改写模板对象"，并附带一个**杂志级排版主题建议**
 * （suggestedTheme），让生成的文章既有写作个性、又有视觉调性。
 *
 * ---- 为什么把"自由 textarea"换成"问卷" ----
 * 1. 大多数用户描述不出自己想要的风格 —— 选项卡比 textarea 高效得多。
 * 2. 结构化输入让 meta-prompt 大幅简化，AI 不再瞎扩展。
 * 3. 视觉主题由用户**直接从 6+1 套手工杂志母版里选**，AI 不写一行 CSS
 *    （AI 写 CSS 一定土），下限是杂志级，上限可由用户在 extraNotes
 *    里要求"再克制点 / 再大胆点"等微调建议（影响 styleInstruction 措辞）。
 *
 * ---- 防 AI slop ----
 * meta-prompt 里塞了一份"避免 AI 套话"的禁令清单，并要求 LLM 把这些
 * 禁令也写进 styleInstruction 里 —— 让生成出来的模板自己会拒绝 AI 味。
 */

import {
  COMMON_OUTPUT_RULES,
  COMMON_USER_PAYLOAD,
  MAGAZINE_THEMES
} from "./defaults.js";
import { getSettings } from "./storage.js";
import { ensureOptionalHostPermission } from "./host-permissions.js";

// ---------------------------------------------------------------------
// 问卷选项 schema（同时给 UI 和 meta-prompt 用，确保两端一致）
// ---------------------------------------------------------------------

export const QUIZ_OPTIONS = Object.freeze({
  contentPillar: [
    { id: "tech-review",  label: "科技测评 / AI / 数码", hint: "评测、行业评论、产品发布稿" },
    { id: "finance",      label: "财经商业 / 行业观察",   hint: "商业分析、宏观、品牌研究" },
    { id: "knowledge",    label: "知识科普 / 教程拆解",   hint: "硬知识、教程、深度科普" },
    { id: "lifestyle",    label: "情感生活 / 故事叙述",   hint: "故事、随笔、情绪、日常" },
    { id: "fashion",      label: "时尚美学 / 视觉艺术",   hint: "时尚、美学、设计、艺术评论" },
    { id: "culture",      label: "文化评论 / 深度专栏",   hint: "人物特稿、文化批评、深度长文" },
    { id: "other",        label: "其他（自己写）",        hint: "在备注里告诉我们" }
  ],
  tone: [
    { id: "restrained", label: "克制 · 有判断",   hint: "适合科技、财经、深度（推荐）" },
    { id: "warm",       label: "温暖 · 有人情味", hint: "适合生活、情感、品牌故事" },
    { id: "sharp",      label: "锋利 · 有态度",   hint: "适合评论、专栏、文化批评" },
    { id: "casual",     label: "轻松 · 有梗",     hint: "适合年轻向、潮流、亚文化" },
    { id: "academic",   label: "学术 · 严谨",     hint: "适合科普、研究综述、教程" }
  ],
  opening: [
    { id: "punchline", label: "punchline · 反常识结论", hint: "一句话先定调" },
    { id: "scene",     label: "场景 · 画面感开头",      hint: "一个细节带读者入场" },
    { id: "data",      label: "数据 · 现象切入",        hint: "一个事实把读者钉在屏幕前" },
    { id: "story",     label: "故事 · 个人代入",        hint: "用第一人称或人物事件破冰" },
    { id: "question",  label: "钩子 · 提问反问",        hint: "用一个真问题逼读者读下去" }
  ],
  rhythm: [
    { id: "short",    label: "短促 · 1–2 句一段",  hint: "节奏快、像 Twitter 串" },
    { id: "standard", label: "标准 · 2–4 句一段",  hint: "公众号最常用的节奏（推荐）" },
    { id: "long",     label: "从容 · 3–6 句一段",  hint: "深度长文 / 文学随笔" }
  ],
  cta: [
    { id: "action",  label: "明确的行动建议", hint: "「现在就去试试 / 文末领取」" },
    { id: "thought", label: "留一个思考问题", hint: "邀请读者评论区聊" },
    { id: "next",    label: "下期钩子",       hint: "「下篇我们聊 XXX」" },
    { id: "quote",   label: "金句 / 观点收尾", hint: "用一句话立住" }
  ]
  // visualTheme 选项直接复用 MAGAZINE_THEMES（避免两边漂移）
});

// ---------------------------------------------------------------------
// meta-prompt
// ---------------------------------------------------------------------

const META_SYSTEM_PROMPT = `你是一名给"公众号改写工具"设计 prompt 模板的资深内容编辑。

你的任务：根据用户问卷的结构化答案，生成一段可以直接喂给 GPT 类模型用来"把来源材料改写成公众号文章"的 prompt 模板（中文）。

【硬约束 · 必须遵守】
1. 只输出合法 JSON，且只输出 JSON。不要 Markdown 代码块、不要解释、不要前后缀文字。
2. 输出的 JSON 必须严格符合下面的 schema：
{
  "name": string,                  // 模板名，6–14 个汉字以内，要有辨识度，禁用"高级版/专业版"等空话
  "icon": string,                  // 一个 emoji，与风格契合
  "styleInstruction": string,      // 280–520 字，给 LLM 的"角色 + 写作风格 + 段落节奏 + 风格雷区"指令，不要包含输出格式约束（格式由系统自动追加）
  "userIntro": string,             // 30–80 字，userTemplate 的开头引导句
  "defaults": {
    "tone": string,                // 8–30 字，描述行文调性
    "angle": string,               // 10–40 字，描述切入角度
    "length": "short" | "medium" | "long",
    "cta": string,                 // 8–30 字，描述结尾行动建议
    "audience": string             // 10–40 字，描述目标读者
  },
  "temperature": number,           // 0.3 ~ 1.0 之间，与风格匹配（冷静分析偏低，故事/创意偏高）
  "humanizeProfile": {              // 必填，描述这个模板对"去 AI 味"的容忍度
    "burstinessMin": number,        // 0.30 – 0.85，句长标准差/均值的最低门槛；故事/随笔偏高（0.6+），清单/资讯偏低（0.35–0.45）
    "dashesPer500": number,         // 0 – 4，破折号"——"每 500 字上限；学术/分析最多 3，新闻最多 1
    "exclamPer500": number,         // 0 – 4，感叹号每 500 字上限；正式稿建议 0–1，故事 2–3
    "allowFirstPerson": boolean,    // 是否允许第一人称 / 主观判断（故事/随笔 true，新闻通稿 false）
    "intensity": "light" | "medium" | "strong" // 若开启二次去 AI 味 pass，使用的强度建议
  },
  "useVoiceSample": "auto" | "force-on" | "force-off" // 是否使用「我的文风」样本；学术/官方稿建议 force-off
}

【styleInstruction 写作要点】
- 第一句给"你是 XXX"的角色设定，要有身份感、有审美主张。
- 第二段开始给具体写作纪律：开头怎么写、段落节奏、可用与不可用的修辞。
- 必须包含"事实约束"段落：只能基于来源事实、不得编造数据/人物/数字、关键名词与来源一致。
- 必须包含"反 AI 味"段落：把下面的禁令清单完整复述给 LLM 听。
- 不要去定义 JSON 输出字段（系统会自动追加 OUTPUT_RULES）。

【避坑 · AI 套话黑名单】
styleInstruction 中**不允许使用**也**禁止生成出的文章使用**以下表达：
- 抽象壳词："格局 / 织锦 / 基石 / 里程碑 / 试金石 / 风向标"
- 宣传式动词："赋能 / 夯实 / 助推 / 引领 / 彰显 / 凸显"
- 套话短语："随着 …… 的不断发展 / 在当今时代 / 在数字化浪潮下 / 拥抱变革 / 至关重要 / 毋庸置疑 / 综上所述 / 归根结底 / 由此可见"
- 模糊归因："专家认为 / 业内人士指出 / 多个来源显示"（请要求模板写作时给出明确的人/机构/时间）
- 协作语气："希望对您有帮助 / 当然可以 / 让我为您 / 您说得对"（任何聊天残留必须删除）
- "首先…其次…最后" 这类机械三段式串场，"不仅…而且…"，连续 3 项及以上的并列
- 过度形容词堆砌（"无与伦比""突破性""颠覆性""划时代"）
- 滥用破折号（每 500 字 ≤ 2 个）、连续多次反问、收尾感叹号
- "**标签**：内容"式的内联标题列表，每篇 ≤ 1 处
- 句长高度均匀（每段都 18–25 字 4 句）：要求长短句交错，相邻三句必须有不同长度
- emoji 堆砌（除非用户明确说要走活泼路线，否则正文里禁用 emoji）

【humanizeProfile 推荐档位（按问卷的 rhythm + tone 大致选）】
- 长篇随笔 / 故事 / 文化评论：burstinessMin 0.65、dashesPer500 2、exclamPer500 2、allowFirstPerson true、intensity strong
- 行业观察 / 深度分析：burstinessMin 0.55、dashesPer500 3、exclamPer500 1、allowFirstPerson true、intensity medium
- 教程 / 测评：burstinessMin 0.50、dashesPer500 2、exclamPer500 1、allowFirstPerson true、intensity medium
- 资讯 / 清单 / 简报：burstinessMin 0.40、dashesPer500 1、exclamPer500 1、allowFirstPerson false、intensity light
- 学术 / 严肃专题：burstinessMin 0.50、dashesPer500 3、exclamPer500 0、allowFirstPerson false、intensity light（这种通常 useVoiceSample 设 force-off）

【杂志感 / 反"土" 要求】
用户已经在问卷里选定了一套杂志级视觉主题（你在【用户问卷】里能看到 visualTheme 的名字和气质）。
请让你写的 styleInstruction **匹配那套视觉主题的气质**。例如：
- 选了 The New Yorker / Monocle / Vogue → 文风要"有编辑判断、克制不卖弄、敢用长句、不堆 emoji"。
- 选了 Wired → 文风要"硬、快、有态度、用具体数字和产品名钉死论点"。
- 选了 Kinfolk → 文风要"慢、留白、用具体的小细节代替大词"。
- 选了 Zine → 文风要"有立场、敢锋利、不端着、可以口语化但不油腻"。
不要在 styleInstruction 里描述 CSS / 视觉样式 —— 视觉由系统自动套用，你只负责写作风格。

【其他】
- 输出整体语言：中文。
- defaults.length 默认参考用户问卷里的 rhythm（short→short, standard→medium, long→long），用户没特别说就跟随。
- 不要在任何字段里出现 "{{变量名}}"（系统会负责所有变量插值）。
- name 不要包含"模板""prompt""GPT""AI"这种字眼，要像一个真正的编辑栏目名（例如"深海观察日志""午后随感""硬核拆机"）。`;

const META_USER_TEMPLATE = `用户在问卷里给出了如下答案，请按 schema 生成模板：

【内容定位】{{contentPillar}}
【写作语气】{{tone}}
【开头方式】{{opening}}
【段落节奏】{{rhythm}}
【结尾方式】{{cta}}
【视觉主题】{{visualTheme}}（{{visualThemeInspiration}} 风格 · {{visualThemeSummary}}）

【目标读者补充】{{audience}}
【特别风格细节补充】{{extraNotes}}

请直接输出 JSON。`;

const ALLOWED_LENGTHS = new Set(["short", "medium", "long"]);
const RHYTHM_TO_LENGTH = { short: "short", standard: "medium", long: "long" };
const VALID_THEME_IDS = new Set(MAGAZINE_THEMES.map((t) => t.id));

// 「我的文风」样本的使用策略；模板 JSON 里写错值时回退成 auto
const ALLOWED_VOICE_POLICIES = new Set(["auto", "force-on", "force-off"]);
const ALLOWED_HUMANIZE_INTENSITIES = new Set(["light", "medium", "strong"]);

// humanizeProfile 兜底：当 LLM 漏写 / 写错时填入这套保守值
const DEFAULT_GENERATED_HUMANIZE_PROFILE = Object.freeze({
  burstinessMin: 0.55,
  dashesPer500: 2,
  exclamPer500: 2,
  allowFirstPerson: true,
  intensity: "medium"
});

function normalizeHumanizeProfile(raw) {
  const obj = raw && typeof raw === "object" ? raw : {};
  const burstinessMin = clampNumber(
    obj.burstinessMin,
    0.3,
    0.85,
    DEFAULT_GENERATED_HUMANIZE_PROFILE.burstinessMin
  );
  const dashesPer500 = clampNumber(
    obj.dashesPer500,
    0,
    6,
    DEFAULT_GENERATED_HUMANIZE_PROFILE.dashesPer500
  );
  const exclamPer500 = clampNumber(
    obj.exclamPer500,
    0,
    6,
    DEFAULT_GENERATED_HUMANIZE_PROFILE.exclamPer500
  );
  const allowFirstPerson =
    typeof obj.allowFirstPerson === "boolean"
      ? obj.allowFirstPerson
      : DEFAULT_GENERATED_HUMANIZE_PROFILE.allowFirstPerson;
  const intensity = ALLOWED_HUMANIZE_INTENSITIES.has(obj.intensity)
    ? obj.intensity
    : DEFAULT_GENERATED_HUMANIZE_PROFILE.intensity;
  return { burstinessMin, dashesPer500, exclamPer500, allowFirstPerson, intensity };
}

function clampNumber(value, min, max, fallback) {
  const num = Number(value);
  if (!Number.isFinite(num)) return fallback;
  if (num < min) return min;
  if (num > max) return max;
  return Math.round(num * 100) / 100;
}

// ---------------------------------------------------------------------
// 主入口
// ---------------------------------------------------------------------

/**
 * 调用 LLM 根据问卷答案生成模板。
 *
 * @param {object} input
 * @param {object} input.quiz                 必填，结构见下方
 * @param {string} input.quiz.contentPillar
 * @param {string} [input.quiz.contentPillarOther]
 * @param {string} input.quiz.tone
 * @param {string} input.quiz.opening
 * @param {string} input.quiz.rhythm
 * @param {string} input.quiz.cta
 * @param {string} input.quiz.visualTheme     必填，必须是 MAGAZINE_THEMES 之一
 * @param {string} [input.quiz.audience]
 * @param {string} [input.quiz.extraNotes]
 * @param {AbortSignal} [input.signal]
 * @returns {Promise<{template: object, raw: string}>}
 */
export async function generateTemplate(input) {
  const quiz = validateQuizInput(input?.quiz);

  const settings = await getSettings();
  if (!settings.apiKey?.trim()) {
    throw new Error("请先在「设置」里填好 API Key 再来生成模板。");
  }
  if (!settings.apiBaseUrl?.trim()) {
    throw new Error("请先在「设置」里填好 API Base URL 再来生成模板。");
  }
  if (!settings.model?.trim()) {
    throw new Error("请先在「设置」里填好 Model 名再来生成模板。");
  }

  const userPrompt = renderUserPrompt(quiz);

  const apiUrl = settings.apiBaseUrl.trim();
  await ensureOptionalHostPermission(apiUrl, "AI 模板生成接口");

  const response = await fetch(apiUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${settings.apiKey.trim()}`
    },
    body: JSON.stringify({
      model: settings.model.trim(),
      // 偏低温度 → meta-prompt 输出更稳定、不会瞎发挥
      temperature: 0.4,
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: META_SYSTEM_PROMPT },
        { role: "user", content: userPrompt }
      ]
    }),
    signal: input?.signal
  });

  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    const message =
      payload?.error?.message ||
      payload?.message ||
      `LLM 接口报错（HTTP ${response.status}）。`;
    throw new Error(message);
  }

  const content = extractContent(payload);
  if (!content) {
    throw new Error("LLM 没有返回内容，再试一次或换个模型试试。");
  }

  const parsed = parseJsonStrict(content);
  // 把问卷的 length 偏好作为兜底，AI 没填或填错时用问卷答案
  const validated = validateAndShape(parsed, {
    fallbackLength: RHYTHM_TO_LENGTH[quiz.rhythm] || "medium"
  });
  const template = composeTemplate(validated, { suggestedTheme: quiz.visualTheme });
  return { template, raw: content };
}

// ---------------------------------------------------------------------
// 输入校验 / 渲染
// ---------------------------------------------------------------------

export function validateQuizInput(rawQuiz) {
  if (!rawQuiz || typeof rawQuiz !== "object") {
    throw new Error("缺少问卷答案。");
  }

  const enums = QUIZ_OPTIONS;
  const must = (field, allowed) => {
    const v = String(rawQuiz[field] || "").trim();
    if (!v) throw new Error(`问卷未完成：缺少「${field}」。`);
    if (!allowed.some((opt) => opt.id === v)) {
      throw new Error(`问卷字段 ${field} 的取值不在允许列表内：${v}`);
    }
    return v;
  };

  const contentPillar = must("contentPillar", enums.contentPillar);
  const tone = must("tone", enums.tone);
  const opening = must("opening", enums.opening);
  const rhythm = must("rhythm", enums.rhythm);
  const cta = must("cta", enums.cta);

  const visualTheme = String(rawQuiz.visualTheme || "").trim();
  if (!VALID_THEME_IDS.has(visualTheme)) {
    throw new Error("问卷未完成：缺少视觉主题（visualTheme），或选了一个未知主题。");
  }

  const contentPillarOther = trimToLength(rawQuiz.contentPillarOther, 80);
  if (contentPillar === "other" && !contentPillarOther) {
    throw new Error("「内容定位」选了「其他」，请在备注里写一句你的方向。");
  }

  return {
    contentPillar,
    contentPillarOther,
    tone,
    opening,
    rhythm,
    cta,
    visualTheme,
    audience: trimToLength(rawQuiz.audience, 200),
    extraNotes: trimToLength(rawQuiz.extraNotes, 400)
  };
}

function renderUserPrompt(quiz) {
  const enums = QUIZ_OPTIONS;
  const labelOf = (list, id) => list.find((o) => o.id === id)?.label || id;
  const themeMeta = MAGAZINE_THEMES.find((t) => t.id === quiz.visualTheme);

  const contentPillarLabel =
    quiz.contentPillar === "other" && quiz.contentPillarOther
      ? `其他 · ${quiz.contentPillarOther}`
      : labelOf(enums.contentPillar, quiz.contentPillar);

  const vars = {
    contentPillar: contentPillarLabel,
    tone: labelOf(enums.tone, quiz.tone),
    opening: labelOf(enums.opening, quiz.opening),
    rhythm: labelOf(enums.rhythm, quiz.rhythm),
    cta: labelOf(enums.cta, quiz.cta),
    visualTheme: themeMeta?.label || quiz.visualTheme,
    visualThemeInspiration: themeMeta?.inspiration || "",
    visualThemeSummary: themeMeta?.summary || "",
    audience: quiz.audience || "（未填，按对应内容定位的典型读者来设想）",
    extraNotes: quiz.extraNotes || "（未填）"
  };

  return META_USER_TEMPLATE.replace(/\{\{(\w+)\}\}/g, (_, key) =>
    vars[key] != null ? String(vars[key]) : "（未填）"
  );
}

// ---------------------------------------------------------------------
// 解析 / 校验 LLM 输出
// ---------------------------------------------------------------------

function extractContent(payload) {
  return (
    payload?.choices?.[0]?.message?.content ||
    payload?.choices?.[0]?.text ||
    payload?.content?.[0]?.text ||
    ""
  );
}

function parseJsonStrict(text) {
  const trimmed = String(text || "").trim();
  try {
    return JSON.parse(trimmed);
  } catch {
    const fenceMatch = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
    if (fenceMatch?.[1]) {
      try {
        return JSON.parse(fenceMatch[1].trim());
      } catch {
        // fall through
      }
    }
    const firstBrace = trimmed.indexOf("{");
    const lastBrace = trimmed.lastIndexOf("}");
    if (firstBrace >= 0 && lastBrace > firstBrace) {
      try {
        return JSON.parse(trimmed.slice(firstBrace, lastBrace + 1));
      } catch {
        // fall through
      }
    }
    throw new Error("模型没有按 JSON 格式返回，再试一次或换个模型。");
  }
}

/**
 * 校验 + 规整 LLM 返回的对象。
 *
 * @param {*} raw
 * @param {object} [opts]
 * @param {"short"|"medium"|"long"} [opts.fallbackLength]
 */
export function validateAndShape(raw, opts = {}) {
  if (!raw || typeof raw !== "object") {
    throw new Error("LLM 返回的不是 JSON 对象。");
  }

  const name = trimToLength(raw.name, 24);
  if (!name) throw new Error("LLM 返回的模板缺少 name。");

  const styleInstruction = trimToLength(raw.styleInstruction, 1800);
  if (!styleInstruction || styleInstruction.length < 80) {
    throw new Error("LLM 返回的 styleInstruction 太短或缺失，请重试。");
  }

  const userIntro = trimToLength(raw.userIntro, 240);
  if (!userIntro) {
    throw new Error("LLM 返回的 userIntro 缺失，请重试。");
  }

  const defaults = raw.defaults && typeof raw.defaults === "object" ? raw.defaults : {};
  const fallbackLength = ALLOWED_LENGTHS.has(opts.fallbackLength)
    ? opts.fallbackLength
    : "medium";
  const shapedDefaults = {
    tone: trimToLength(defaults.tone, 60) || "",
    angle: trimToLength(defaults.angle, 80) || "",
    length: ALLOWED_LENGTHS.has(defaults.length) ? defaults.length : fallbackLength,
    cta: trimToLength(defaults.cta, 60) || "",
    audience: trimToLength(defaults.audience, 80) || ""
  };

  const tempRaw = Number(raw.temperature);
  const temperature =
    Number.isFinite(tempRaw) && tempRaw >= 0 && tempRaw <= 1.5
      ? Math.round(tempRaw * 100) / 100
      : 0.7;

  const icon = pickIcon(raw.icon);

  if (/\{\{[^}]+\}\}/.test(styleInstruction)) {
    throw new Error("LLM 在 styleInstruction 里塞了变量占位符，请重试。");
  }

  const humanizeProfile = normalizeHumanizeProfile(raw.humanizeProfile);
  const useVoiceSample = ALLOWED_VOICE_POLICIES.has(raw.useVoiceSample)
    ? raw.useVoiceSample
    : "auto";

  return {
    name,
    icon,
    styleInstruction,
    userIntro,
    defaults: shapedDefaults,
    temperature,
    humanizeProfile,
    useVoiceSample
  };
}

/**
 * 把 LLM 返回的"创意部分"拼回我们自己控制的 OUTPUT contract，
 * 组成一个完整的、立刻可用的模板对象。
 *
 * @param {object} shaped
 * @param {object} [opts]
 * @param {string} [opts.suggestedTheme]   推荐的视觉主题 id（来自问卷）
 */
export function composeTemplate(shaped, opts = {}) {
  const id = `custom-ai-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const systemTemplate = `${shaped.styleInstruction}\n\n${COMMON_OUTPUT_RULES}`;
  const userTemplate = `${shaped.userIntro}\n\n${COMMON_USER_PAYLOAD}`;

  const suggestedTheme = VALID_THEME_IDS.has(opts.suggestedTheme)
    ? opts.suggestedTheme
    : null;

  return {
    id,
    name: shaped.name,
    icon: shaped.icon,
    description: `AI 生成 · ${truncate(shaped.styleInstruction.split(/\n/)[0] || "", 40)}`,
    systemTemplate,
    userTemplate,
    defaults: shaped.defaults,
    temperature: shaped.temperature,
    humanizeProfile: shaped.humanizeProfile || { ...DEFAULT_GENERATED_HUMANIZE_PROFILE },
    useVoiceSample: shaped.useVoiceSample || "auto",
    model: "",
    aiGenerated: true,
    suggestedTheme,
    aiBriefHash: undefined
  };
}

// ---------------------------------------------------------------------
// 工具
// ---------------------------------------------------------------------

function pickIcon(raw) {
  const value = String(raw || "").trim();
  if (!value) return "✨";
  const codepoints = Array.from(value);
  if (codepoints.length > 2) return codepoints.slice(0, 2).join("");
  return value;
}

function trimToLength(value, max) {
  const str = String(value == null ? "" : value).trim();
  if (str.length <= max) return str;
  return str.slice(0, max).trim();
}

function truncate(value, max) {
  const str = String(value || "").trim();
  return str.length > max ? `${str.slice(0, max - 1)}…` : str;
}

// 暴露给 smoke 测试 / 调试用
export const __INTERNAL = Object.freeze({
  META_SYSTEM_PROMPT,
  META_USER_TEMPLATE,
  ALLOWED_LENGTHS,
  RHYTHM_TO_LENGTH,
  VALID_THEME_IDS
});
