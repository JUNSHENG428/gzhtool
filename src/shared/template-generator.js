/**
 * src/shared/template-generator.js
 * ====================================================================
 * AI 模板生成器（Pro 专享）
 *
 * ---- 它做什么 ----
 * 用户用大白话描述自己的公众号需求（比如"我做的是科技测评号，开头喜欢一段
 * punchline 抓眼球，正文要密集小标题，结尾留下期钩子"），调用用户已配置的
 * LLM，让它吐出一个完整可用的改写模板对象，写入模板库。
 *
 * ---- 为什么要单独一个文件 ----
 * 1. meta-prompt（让 AI 生成另一段 prompt）逻辑跟普通改写完全不同，独立文件
 *    更好维护、更好测试。
 * 2. AI 永远不能破坏 改写 JSON 输出 contract（COMMON_OUTPUT_RULES）。所以
 *    AI 只负责生成"创意性的风格指令 + defaults"，contract 由我们的代码
 *    自动拼回去——AI 想改也改不了。
 * 3. 客户端做 strict schema 校验，不合规的回包直接报错（让用户重试或调
 *    模型），坚决不让坏数据落进模板库。
 *
 * ---- 防 AI slop ----
 * meta-prompt 里塞了一份"避免 AI 套话"的禁令清单（参考了写作圈反 AI 味
 * 的常见经验），免得生成出来的模板自己就是"AI 味浓郁"的样板文字。
 */

import {
  COMMON_OUTPUT_RULES,
  COMMON_USER_PAYLOAD
} from "./defaults.js";
import { getSettings } from "./storage.js";

const META_SYSTEM_PROMPT = `你是一名给"公众号改写工具"设计 prompt 模板的资深内容编辑。

你的任务：根据用户描述的公众号风格 / 受众 / 写作习惯，生成一段可以直接喂给 GPT 类模型用来"把来源材料改写成公众号文章"的 prompt 模板（中文）。

【硬约束 · 必须遵守】
1. 只输出合法 JSON，且只输出 JSON。不要 Markdown 代码块、不要解释、不要前后缀文字。
2. 输出的 JSON 必须严格符合下面的 schema：
{
  "name": string,                  // 模板名，6-14 个汉字以内，要有辨识度，禁用"高级版/专业版"等空话
  "icon": string,                  // 一个 emoji，与风格契合
  "styleInstruction": string,      // 200-450 字，给 LLM 的"角色 + 写作风格 + 段落节奏 + 风格雷区"指令，不要包含输出格式约束（格式由系统自动追加）
  "userIntro": string,             // 30-80 字，userTemplate 的开头引导句，告诉 LLM "请将下面的来源材料改写成 XXX 风格的公众号稿"
  "defaults": {
    "tone": string,                // 8-30 字，描述行文调性
    "angle": string,               // 10-40 字，描述切入角度
    "length": "short" | "medium" | "long",
    "cta": string,                 // 8-30 字，描述结尾行动建议
    "audience": string             // 10-40 字，描述目标读者
  },
  "temperature": number            // 0.3 ~ 1.0 之间，与风格匹配（冷静分析偏低，故事/创意偏高）
}

【styleInstruction 写作要点】
- 第一句给"你是 XXX"的角色设定，第二段开始给具体写作纪律。
- 必须包含：开头怎么写、段落节奏（句子长短 / 单段句数）、可用与不可用的修辞。
- 必须显式列出"事实约束"段落：只能基于来源事实、不得编造数据/人物/数字、关键名词与来源一致。
- 不要去定义 JSON 输出字段（系统会自动追加 OUTPUT_RULES）。

【避坑 · AI 套话黑名单】
styleInstruction 中**不允许使用**也**禁止让生成出的文章使用**以下表达，并要在 styleInstruction 里明确告诫 LLM 也不要用：
- "随着…的不断发展" / "在当今时代" / "在数字化浪潮下" / "拥抱变革" / "赋能"
- "首先…其次…最后" 这类机械三段式串场
- 大量排比（"不是…而是…"、"既要…也要…"等连续 3 句以上）
- 过度形容词堆砌（"无与伦比""突破性""颠覆性"）
- 滥用破折号、问号反问、收尾感叹号
- emoji 堆砌（除非用户明确说要走活泼路线，否则正文里禁用 emoji）

【其他要求】
- 输出整体语言：中文。
- defaults.length 默认建议 "medium"，除非用户明确说"短小快"或"长文深度"。
- 如果用户描述很简略，按"专业、可信、有判断力"的默认走，不要瞎扩展用户没说过的需求。
- 不要在任何字段里出现 "{{变量名}}" 这种占位符（系统会负责所有变量插值）。`;

const META_USER_TEMPLATE = `用户描述了他想要的公众号改写风格，请按 schema 生成模板：

【用户原话】
{{userBrief}}

【附加偏好】
- 期望长度：{{length}}
- 目标读者（用户填的）：{{audience}}
- 期望调性（用户填的）：{{tone}}
- 期望模板图标：{{iconHint}}

请直接输出 JSON。`;

const ALLOWED_LENGTHS = new Set(["short", "medium", "long"]);

/**
 * 调用 LLM 生成模板。返回标准化的模板对象（id 已生成，可直接 push 进 _templates）。
 *
 * @param {object} input
 * @param {string} input.userBrief        用户的需求描述（必填）
 * @param {string} [input.length]         "short" | "medium" | "long"
 * @param {string} [input.audience]
 * @param {string} [input.tone]
 * @param {string} [input.iconHint]
 * @param {AbortSignal} [input.signal]
 * @returns {Promise<{template: object, raw: string}>}
 */
export async function generateTemplate(input) {
  const userBrief = String(input?.userBrief || "").trim();
  if (!userBrief) {
    throw new Error("请先描述你的公众号风格 / 写作偏好。");
  }
  if (userBrief.length < 12) {
    throw new Error("描述太短了。多说几句你想要的开头方式、段落节奏、读者画像，效果会好很多。");
  }
  if (userBrief.length > 1500) {
    throw new Error("描述过长（>1500 字）。把核心需求精简一下再试。");
  }

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

  const userPrompt = renderUserPrompt({
    userBrief,
    length: normalizeLength(input?.length),
    audience: orDash(input?.audience),
    tone: orDash(input?.tone),
    iconHint: orDash(input?.iconHint)
  });

  const response = await fetch(settings.apiBaseUrl.trim(), {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${settings.apiKey.trim()}`
    },
    body: JSON.stringify({
      model: settings.model.trim(),
      // 偏低温度 → meta-prompt 输出更稳定、不会瞎发挥
      temperature: 0.4,
      // 部分 OpenAI 兼容服务支持 response_format，传上不影响其它服务（多余字段一般会被忽略）
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
  const validated = validateAndShape(parsed);
  const template = composeTemplate(validated);
  return { template, raw: content };
}

// ---------------------------------------------------------------------
// 内部工具
// ---------------------------------------------------------------------

function renderUserPrompt(vars) {
  return META_USER_TEMPLATE.replace(/\{\{(\w+)\}\}/g, (_, key) =>
    vars[key] != null ? String(vars[key]) : "（未填）"
  );
}

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
  // 先直接尝试
  try {
    return JSON.parse(trimmed);
  } catch {
    // 兜底：从 ```json``` 代码块或第一段 { ... } 中抠
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
 * 校验 + 规整 LLM 返回的对象。返回的 shape 是"半成品"——
 * styleInstruction / userIntro / defaults 已确认有效，
 * 但还没拼成最终的 systemTemplate / userTemplate。
 */
export function validateAndShape(raw) {
  if (!raw || typeof raw !== "object") {
    throw new Error("LLM 返回的不是 JSON 对象。");
  }

  const name = trimToLength(raw.name, 24);
  if (!name) throw new Error("LLM 返回的模板缺少 name。");

  const styleInstruction = trimToLength(raw.styleInstruction, 1600);
  if (!styleInstruction || styleInstruction.length < 80) {
    throw new Error("LLM 返回的 styleInstruction 太短或缺失，请重试。");
  }

  const userIntro = trimToLength(raw.userIntro, 240);
  if (!userIntro) {
    throw new Error("LLM 返回的 userIntro 缺失，请重试。");
  }

  const defaults = raw.defaults && typeof raw.defaults === "object" ? raw.defaults : {};
  const shapedDefaults = {
    tone: trimToLength(defaults.tone, 60) || "",
    angle: trimToLength(defaults.angle, 80) || "",
    length: ALLOWED_LENGTHS.has(defaults.length) ? defaults.length : "medium",
    cta: trimToLength(defaults.cta, 60) || "",
    audience: trimToLength(defaults.audience, 80) || ""
  };

  const tempRaw = Number(raw.temperature);
  const temperature =
    Number.isFinite(tempRaw) && tempRaw >= 0 && tempRaw <= 1.5
      ? Math.round(tempRaw * 100) / 100
      : 0.7;

  const icon = pickIcon(raw.icon);

  // 防御：禁止 styleInstruction 里出现 "{{变量}}"，否则 buildRewriteMessages 会把它当模板变量
  if (/\{\{[^}]+\}\}/.test(styleInstruction)) {
    throw new Error("LLM 在 styleInstruction 里塞了变量占位符，请重试。");
  }

  return { name, icon, styleInstruction, userIntro, defaults: shapedDefaults, temperature };
}

/**
 * 把 LLM 返回的"创意部分"拼回我们自己控制的 OUTPUT contract，
 * 组成一个完整的、立刻可用的模板对象。
 */
export function composeTemplate(shaped) {
  const id = `custom-ai-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const systemTemplate = `${shaped.styleInstruction}\n\n${COMMON_OUTPUT_RULES}`;
  const userTemplate = `${shaped.userIntro}\n\n${COMMON_USER_PAYLOAD}`;

  return {
    id,
    name: shaped.name,
    icon: shaped.icon,
    description: `AI 生成 · ${truncate(shaped.styleInstruction.split(/\n/)[0] || "", 40)}`,
    systemTemplate,
    userTemplate,
    defaults: shaped.defaults,
    temperature: shaped.temperature,
    model: "",
    aiGenerated: true,
    aiBriefHash: undefined  // 留给上层填，避免重复生成完全一致的模板
  };
}

function pickIcon(raw) {
  const value = String(raw || "").trim();
  if (!value) return "✨";
  // 限制 1-2 个 codepoint，防止用户拼了一句话
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

function normalizeLength(value) {
  return ALLOWED_LENGTHS.has(value) ? value : "medium";
}

function orDash(value) {
  const str = String(value || "").trim();
  return str || "（未填）";
}

// 暴露 meta-prompt 给 smoke 测试 / 调试用
export const __INTERNAL = Object.freeze({
  META_SYSTEM_PROMPT,
  META_USER_TEMPLATE,
  ALLOWED_LENGTHS
});
