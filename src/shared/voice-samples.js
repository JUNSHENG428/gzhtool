/**
 * voice-samples.js · 「我的文风」样本库
 * ────────────────────────────────────────────────────────────
 * 目标：让用户把自己历史写过的几篇代表作存起来，提取出「风格指纹」，
 * 然后在 AI 改写主 pass + 二次 humanize pass 里都注入这份指纹，让生成结果
 * 靠近用户本人的语气、节奏、用词偏好。
 *
 * 设计原则：
 *  1. 只存在 chrome.storage.local，不上传，避免泄露用户旧文。
 *     （样本会随每次改写发到用户配置的 LLM API，但这是 OpenAI 兼容协议
 *     里"提示词上下文"的一部分，不会被持久化到我们自己的服务器。）
 *  2. 单独走一个 storage key（STORAGE_KEYS.voiceSamples），不挤进 settings。
 *     原因：raw 字段可能存几千字原文，混进 settings 会让每次保存都全量 IO，
 *     还会影响 chrome.storage.onChanged 的监听者。
 *  3. fingerprint 提取分两步：
 *       - 本地 deterministic：句长均值、突发性、破折号/感叹号密度（humanize-rules 已实现）
 *       - LLM 主观判断：常用语气词、语气标签、作者从不使用的词、最有代表性的 2 段截选
 *     这样一份 fingerprint 即使 LLM 偶尔抽风，也保留得了基础数值。
 *  4. 对外只 export 异步函数，调用方不需要知道 storage key 长什么样。
 *
 * @typedef {Object} VoiceFingerprint
 * @property {number} avgSentenceLen      平均句长（字）
 * @property {number} burstiness          句长标准差/均值（越高越像人写）
 * @property {string[]} signaturePhrases  常用语气词/口头禅
 * @property {string[]} toneTags          语气标签（如「口语化」「略带反思」）
 * @property {{ dashesPer100: number, exclamPer100: number }} punctuationProfile
 * @property {string[]} forbidden         作者从不使用、需要 humanize pass 屏蔽的词
 * @property {string[]} excerpts          2 段最有代表性的原文截选（each ≤ 600 字）
 *
 * @typedef {Object} VoiceSample
 * @property {string} id                  vs_xxx
 * @property {string} title               用户自起的名字
 * @property {string} raw                 原始文本（去 HTML 后）
 * @property {VoiceFingerprint} fingerprint
 * @property {number} createdAt
 * @property {number} updatedAt
 */

import { STORAGE_KEYS } from "./defaults.js";
import {
  splitSentencesPlain,
  countCharsPlain,
  computeSentenceStats
} from "./humanize-rules.js";
import {
  extractChatContent,
  extractJson,
  postChatCompletionWithReasoningFallback
} from "./ai.js";
import { ensureOptionalHostPermission } from "./host-permissions.js";

const MAX_SAMPLES = 8;
const MAX_RAW_CHARS = 12000;
const FINGERPRINT_TIMEOUT_MS = 45000;

// ────────────────────────────────────────────────────────────
// 存储 CRUD
// ────────────────────────────────────────────────────────────

/**
 * 读取所有样本。从未保存过时返回空数组。
 * @returns {Promise<VoiceSample[]>}
 */
export async function listVoiceSamples() {
  const stored = await chrome.storage.local.get(STORAGE_KEYS.voiceSamples);
  const raw = stored[STORAGE_KEYS.voiceSamples];
  if (!Array.isArray(raw)) return [];
  // 兜底：丢弃非法记录
  return raw.filter(
    (s) =>
      s &&
      typeof s === "object" &&
      typeof s.id === "string" &&
      s.id &&
      typeof s.raw === "string"
  );
}

/**
 * 按 id 获取一份样本。
 */
export async function getVoiceSampleById(id) {
  if (!id) return null;
  const all = await listVoiceSamples();
  return all.find((s) => s.id === id) || null;
}

/**
 * upsert 一份样本：id 已存在就替换，否则追加。
 * 自动维护 createdAt / updatedAt。
 *
 * 不在这里调用 LLM —— fingerprint 由调用方决定是否提前算好；
 * 这样可以在 UI 上做"先保存 raw，异步算指纹"的体验。
 *
 * @param {VoiceSample} sample
 */
export async function saveVoiceSample(sample) {
  if (!sample || typeof sample !== "object") {
    throw new Error("voiceSample 必须是 object");
  }
  if (!sample.id || typeof sample.id !== "string") {
    throw new Error("voiceSample 缺少 id");
  }
  const now = Date.now();
  const all = await listVoiceSamples();
  const idx = all.findIndex((s) => s.id === sample.id);
  const next = {
    id: sample.id,
    title: String(sample.title || "未命名样本").slice(0, 60),
    raw: String(sample.raw || "").slice(0, MAX_RAW_CHARS),
    fingerprint: sample.fingerprint || null,
    createdAt: idx >= 0 ? all[idx].createdAt || now : now,
    updatedAt: now
  };
  if (idx >= 0) {
    all[idx] = next;
  } else {
    if (all.length >= MAX_SAMPLES) {
      throw new Error(
        `最多保存 ${MAX_SAMPLES} 份样本，请先删除一份再添加。`
      );
    }
    all.push(next);
  }
  await chrome.storage.local.set({ [STORAGE_KEYS.voiceSamples]: all });
  return next;
}

/**
 * 按 id 删除。如果删的是当前激活样本，会顺手把 settings.activeVoiceSampleId 清空，
 * 避免 ai.js 里 buildRewriteMessages 收到一个找不到目标的 id。
 */
export async function deleteVoiceSample(id) {
  if (!id) return;
  const all = await listVoiceSamples();
  const next = all.filter((s) => s.id !== id);
  await chrome.storage.local.set({ [STORAGE_KEYS.voiceSamples]: next });

  const settings = await chrome.storage.local.get(STORAGE_KEYS.settings);
  const cur = settings[STORAGE_KEYS.settings] || {};
  if (cur.activeVoiceSampleId === id) {
    await chrome.storage.local.set({
      [STORAGE_KEYS.settings]: { ...cur, activeVoiceSampleId: "" }
    });
  }
}

/**
 * 设置当前激活样本 id（写到 settings.activeVoiceSampleId，复用现有 settings 通道）。
 */
export async function setActiveVoiceSampleId(id) {
  const stored = await chrome.storage.local.get(STORAGE_KEYS.settings);
  const cur = stored[STORAGE_KEYS.settings] || {};
  await chrome.storage.local.set({
    [STORAGE_KEYS.settings]: { ...cur, activeVoiceSampleId: String(id || "") }
  });
}

/**
 * 拿到当前激活的样本（含 fingerprint）。
 * 没设置 / 找不到 / fingerprint 缺失都返回 null，调用方据此决定是否注入 prompt。
 */
export async function getActiveVoiceSample() {
  const settings = await chrome.storage.local.get(STORAGE_KEYS.settings);
  const id = String(settings[STORAGE_KEYS.settings]?.activeVoiceSampleId || "");
  if (!id) return null;
  const sample = await getVoiceSampleById(id);
  if (!sample) return null;
  // fingerprint 缺失 → 视为不可用，避免给 LLM 注入半成品
  if (!sample.fingerprint || typeof sample.fingerprint !== "object") {
    return null;
  }
  return sample;
}

/**
 * 生成新样本 id。前缀 vs_ 用来在调试时一眼识别。
 */
export function generateVoiceSampleId() {
  const ts = Date.now().toString(36);
  const rand = Math.random().toString(36).slice(2, 8);
  return `vs_${ts}_${rand}`;
}

// ────────────────────────────────────────────────────────────
// 风格指纹提取
// ────────────────────────────────────────────────────────────

/**
 * 从原始文本提取风格指纹。
 *
 * 两段式：
 *   1) 本地 deterministic：句长统计、标点密度（不依赖 LLM，永远可靠）
 *   2) LLM 主观判断：常用语气词、语气标签、忌讳词、代表性截选
 *      —— 失败时返回保留 1）的部分指纹，让样本仍然可用（语气词字段为空数组）
 *
 * @param {string} rawText
 * @param {object} settings   chrome.storage.local 里的 wechatWriterSettings，需要 apiKey + apiBaseUrl
 * @returns {Promise<VoiceFingerprint>}
 */
export async function extractFingerprintFromText(rawText, settings) {
  const text = String(rawText || "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, MAX_RAW_CHARS);
  if (!text) {
    throw new Error("样本内容为空，无法提取指纹。");
  }

  const stats = computeLocalStats(text);
  let llmPart = {
    signaturePhrases: [],
    toneTags: [],
    forbidden: [],
    excerpts: []
  };

  if (settings?.apiKey && settings?.apiBaseUrl) {
    try {
      llmPart = await requestFingerprintFromLLM(text, settings);
    } catch (err) {
      // 不抛出：让用户至少先拿到 deterministic 部分，UI 上给一个"重新生成"按钮即可。
      console.warn("[voice-samples] LLM 提取指纹失败，使用本地指纹兜底：", err);
    }
  }

  return {
    avgSentenceLen: round2(stats.avgSentenceLen),
    burstiness: round2(stats.burstiness),
    signaturePhrases: dedupStrings(llmPart.signaturePhrases, 8),
    toneTags: dedupStrings(llmPart.toneTags, 5),
    punctuationProfile: {
      dashesPer100: round2(stats.dashesPer100),
      exclamPer100: round2(stats.exclamPer100)
    },
    forbidden: dedupStrings(llmPart.forbidden, 8),
    excerpts: pickExcerpts(text, llmPart.excerpts)
  };
}

/**
 * 本地 deterministic 统计：句长、突发性、破折号/感叹号密度。
 */
function computeLocalStats(text) {
  const sentences = splitSentencesPlain(text);
  const stats = computeSentenceStats(sentences);
  const totalChars = countCharsPlain(text);
  const dashes = (text.match(/——|—/g) || []).length;
  const exclams = (text.match(/[！!]/g) || []).length;
  return {
    avgSentenceLen: stats.mean,
    burstiness: stats.burstiness,
    dashesPer100: totalChars > 0 ? (dashes / totalChars) * 100 : 0,
    exclamPer100: totalChars > 0 ? (exclams / totalChars) * 100 : 0
  };
}

/**
 * 让 LLM 输出主观风格判断。强制 JSON，错就回兜底空值。
 */
async function requestFingerprintFromLLM(text, settings) {
  const apiKey = String(settings.apiKey || "").trim();
  const baseUrl = String(settings.apiBaseUrl || "").trim();
  const model = String(settings.model || "gpt-4.1-mini").trim() || "gpt-4.1-mini";
  if (!apiKey || !baseUrl) {
    throw new Error("缺少 API Key 或 Base URL");
  }

  const systemPrompt = `你是中文公众号编辑顾问。下面会给你一段作者历史文章，请从中抽取该作者的"风格指纹"，输出为合法 JSON。

输出 schema：
{
  "signaturePhrases": string[],   // 6-8 个该作者的"口头禅 / 高频语气词 / 标志性短语"，例如「说实话」「回过头看」
  "toneTags": string[],           // 3-5 个语气标签，例如「口语化」「略带反思」「克制分析」
  "forbidden": string[],          // 6-8 个该作者从不使用的"AI 套话词"，例如「综上所述」「赋能」「一方面…另一方面…」
  "excerpts": string[]            // 从原文里挑 2 段最能代表作者语气的连续段落，每段不超过 600 字，原样保留
}

约束：
- 只输出 JSON，不要附加解释、markdown 代码块。
- signaturePhrases 必须从原文里能直接找到例子，不要捏造。
- excerpts 必须是原文的连续片段，不要改写。
- 如果某个字段判断不出，可以返回空数组。`;

  const userPrompt = `作者历史文章（已截断到 ${text.length} 字）：

${text}`;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FINGERPRINT_TIMEOUT_MS);

  try {
    await ensureOptionalHostPermission(baseUrl, "文风指纹提取接口");

    // 走统一的推理模型剥参 fallback helper：用户若配置了 o1/R1/Kimi 等推理模型，
    // temperature 等采样字段会被 400 拒绝，helper 命中后剥到最小字段集重试一次。
    const { response, payload } = await postChatCompletionWithReasoningFallback(
      baseUrl,
      apiKey,
      {
        model,
        // 风格判断是结构化任务，温度低一点，输出更稳。
        temperature: 0.3,
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: userPrompt }
        ]
      },
      { signal: controller.signal }
    );

    if (!response.ok) {
      const msg = payload?.error?.message || `指纹接口返回 ${response.status}`;
      throw new Error(msg);
    }
    const content = extractChatContent(payload);
    if (!content) throw new Error("指纹接口返回内容为空");
    const parsed = extractJson(content);
    return {
      signaturePhrases: Array.isArray(parsed.signaturePhrases)
        ? parsed.signaturePhrases.map(String)
        : [],
      toneTags: Array.isArray(parsed.toneTags) ? parsed.toneTags.map(String) : [],
      forbidden: Array.isArray(parsed.forbidden) ? parsed.forbidden.map(String) : [],
      excerpts: Array.isArray(parsed.excerpts) ? parsed.excerpts.map(String) : []
    };
  } finally {
    clearTimeout(timer);
  }
}

// ────────────────────────────────────────────────────────────
// 工具
// ────────────────────────────────────────────────────────────

function dedupStrings(arr, limit) {
  if (!Array.isArray(arr)) return [];
  const seen = new Set();
  const out = [];
  for (const item of arr) {
    const v = String(item || "").trim();
    if (!v) continue;
    if (seen.has(v)) continue;
    seen.add(v);
    out.push(v);
    if (out.length >= limit) break;
  }
  return out;
}

/**
 * 截选优先用 LLM 给的；如果 LLM 没给或太短，从原文里截两段段尾断点处的内容。
 * 保证最终至少有 1 段、最多 2 段。
 */
function pickExcerpts(text, fromLlm) {
  const llmPicks = Array.isArray(fromLlm)
    ? fromLlm
        .map((s) => String(s || "").trim().slice(0, 600))
        .filter((s) => s.length >= 80)
    : [];
  if (llmPicks.length >= 2) return llmPicks.slice(0, 2);

  const fallback = [];
  const len = text.length;
  if (len > 200) {
    fallback.push(text.slice(0, Math.min(600, Math.floor(len / 2))).trim());
  }
  if (len > 1200) {
    fallback.push(text.slice(Math.floor(len / 2), Math.floor(len / 2) + 600).trim());
  }
  return [...llmPicks, ...fallback].slice(0, 2).filter(Boolean);
}

function round2(num) {
  const n = Number(num);
  if (!Number.isFinite(n)) return 0;
  return Math.round(n * 100) / 100;
}
