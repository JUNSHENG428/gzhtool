import { LENGTH_LABELS } from "./defaults.js";

const MAX_SOURCE_CHARS = 24000;

export function buildRewriteMessages(source, preferences, settings) {
  const snapshot = createSourceSnapshot(source);
  const requestedLength = LENGTH_LABELS[preferences.length] || LENGTH_LABELS.medium;

  const systemPrompt = [
    "你是一名资深微信公众号编辑，负责把网页内容改写成适合公众号发布的原创风格文章。",
    "必须遵守这些规则：",
    "1. 只基于提供的来源事实写作，不要编造数据、案例、引语、公司动作或人物观点。",
    "2. 允许重组结构、加强开头钩子、提炼论点，但不要篡改原文结论。",
    "3. 语气要像成熟编辑，而不是模板化 AI 文案。",
    "4. 输出必须是合法 JSON，且只输出 JSON，不要附加解释或 Markdown 代码块。",
    "5. JSON 字段必须包含 title、subtitle、lead、sections、closing、cta、wechatTitleOptions、keywords。",
    "6. 每个 section 必须包含 heading、paragraphs、bulletPoints、quote、imageRefs。",
    "7. imageRefs 中每一项形如 {\"index\": 1, \"caption\": \"图注\"}，index 必须引用来源图片编号。",
    "8. 若某个字段没有内容，请返回空字符串或空数组，不要省略字段。"
  ].join("\n");

  const userPrompt = [
    "请将下面的来源材料改写成公众号文章。",
    "",
    "改写目标：",
    JSON.stringify(
      {
        audience: preferences.audience || settings.defaultAudience,
        tone: preferences.tone || settings.defaultTone,
        angle: preferences.angle || settings.defaultAngle,
        requestedLength,
        cta: preferences.cta || settings.defaultCta
      },
      null,
      2
    ),
    "",
    "来源快照：",
    JSON.stringify(snapshot, null, 2)
  ].join("\n");

  return [
    { role: "system", content: systemPrompt },
    { role: "user", content: userPrompt }
  ];
}

export async function requestRewrite(settings, source, preferences) {
  if (!settings.apiKey?.trim()) {
    throw new Error("请先在设置页填写 API Key。");
  }

  if (!settings.apiBaseUrl?.trim()) {
    throw new Error("请先在设置页填写 API Base URL。");
  }

  const messages = buildRewriteMessages(source, preferences, settings);
  const response = await fetch(settings.apiBaseUrl.trim(), {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${settings.apiKey.trim()}`
    },
    body: JSON.stringify({
      model: settings.model.trim(),
      temperature: Number(settings.temperature ?? 0.8),
      messages
    })
  });

  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    const errorMessage =
      payload?.error?.message ||
      payload?.message ||
      `AI 接口返回错误，状态码 ${response.status}`;
    throw new Error(errorMessage);
  }

  const content = extractChatContent(payload);
  if (!content) {
    throw new Error("AI 返回内容为空，无法生成改写稿。");
  }

  return normalizeArticle(extractJson(content), source, preferences);
}

export async function testAiConnection({ baseUrl, apiKey, model, timeoutMs = 12000 }) {
  const targetUrl = String(baseUrl || "").trim();
  const token = String(apiKey || "").trim();
  const targetModel = String(model || "").trim();

  if (!targetUrl) {
    return createAiTestFailure("请先填写 API Base URL。", targetModel);
  }
  if (!token) {
    return createAiTestFailure("请先填写 API Key。", targetModel);
  }
  if (!targetModel) {
    return createAiTestFailure("请先填写 Model。", targetModel);
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const startedAt = Date.now();

  try {
    const response = await fetch(targetUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`
      },
      body: JSON.stringify({
        model: targetModel,
        messages: [{ role: "user", content: "ping" }],
        max_tokens: 5,
        temperature: 0
      }),
      signal: controller.signal
    });

    const latencyMs = Date.now() - startedAt;
    const payload = await response.json().catch(() => ({}));

    if (!response.ok) {
      return createAiTestFailure(
        mapAiConnectionHttpError(response.status, payload),
        targetModel,
        latencyMs
      );
    }

    if (!extractChatContent(payload)) {
      return createAiTestFailure(
        "接口已连通，但返回内容为空，请检查模型是否支持 chat completion。",
        targetModel,
        latencyMs
      );
    }

    return {
      ok: true,
      latencyMs,
      model: payload.model || targetModel,
      error: ""
    };
  } catch (error) {
    return createAiTestFailure(
      mapAiConnectionRuntimeError(error),
      targetModel,
      Date.now() - startedAt
    );
  } finally {
    clearTimeout(timer);
  }
}

export function buildManualPrompt(source, preferences, settings) {
  return buildRewriteMessages(source, preferences, settings)
    .map((message) => `${message.role.toUpperCase()}:\n${message.content}`)
    .join("\n\n");
}

function createSourceSnapshot(source) {
  const blocks = [];
  let totalChars = 0;

  for (const block of source.blocks || []) {
    const serialized = JSON.stringify(block);
    if (totalChars + serialized.length > MAX_SOURCE_CHARS) {
      break;
    }
    blocks.push(block);
    totalChars += serialized.length;
  }

  return {
    title: source.title,
    url: source.url,
    description: source.description || "",
    siteName: source.siteName || "",
    wordCount: source.wordCount || 0,
    images: (source.images || []).slice(0, 20).map((image, index) => ({
      index: index + 1,
      src: image.src,
      alt: image.alt || "",
      caption: image.caption || ""
    })),
    blocks
  };
}

function extractChatContent(payload) {
  const content = payload?.choices?.[0]?.message?.content;

  if (typeof content === "string") {
    return content;
  }

  if (Array.isArray(content)) {
    return content
      .map((item) => {
        if (typeof item === "string") return item;
        if (item?.type === "text") return item.text || "";
        return "";
      })
      .join("");
  }

  return "";
}

function createAiTestFailure(error, model, latencyMs = 0) {
  return {
    ok: false,
    latencyMs,
    model: model || "",
    error
  };
}

function mapAiConnectionHttpError(status, payload) {
  if (status === 401 || status === 403) {
    return "密钥无效，请检查 API Key。";
  }

  if (status === 404) {
    return "接口地址不对，请检查 API Base URL 是否是完整的 chat completions 地址。";
  }

  if (status === 408 || status === 504) {
    return "请求超时，请检查网络或服务状态。";
  }

  const message = payload?.error?.message || payload?.message || "";
  if (/cors/i.test(message)) {
    return "接口地址不对，或目标服务未正确开放跨域。";
  }

  if (status === 429) {
    return message || "请求过于频繁，或当前账户额度不足。";
  }

  if (status >= 500) {
    return message || "AI 服务暂时不可用，请稍后再试。";
  }

  return message || `AI 接口返回错误，状态码 ${status}。`;
}

function mapAiConnectionRuntimeError(error) {
  if (error?.name === "AbortError") {
    return "请求超时，请检查网络或服务状态。";
  }

  const message = String(error?.message || "");
  if (/invalid url/i.test(message)) {
    return "接口地址格式不正确，请检查 API Base URL。";
  }

  if (/cors/i.test(message)) {
    return "接口地址不对，或目标服务未正确开放跨域。";
  }

  if (/failed to fetch|networkerror|load failed/i.test(message)) {
    return "接口地址不对，或目标服务不可达。";
  }

  return message || "连接失败，请检查接口地址和网络状态。";
}

function extractJson(rawText) {
  const fenced = rawText.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const text = fenced ? fenced[1].trim() : rawText.trim();

  const firstBrace = text.indexOf("{");
  const lastBrace = text.lastIndexOf("}");
  if (firstBrace === -1 || lastBrace === -1 || lastBrace <= firstBrace) {
    throw new Error("AI 返回中没有找到可解析的 JSON。");
  }

  const candidate = text.slice(firstBrace, lastBrace + 1);
  return JSON.parse(candidate);
}

function normalizeArticle(data, source, preferences) {
  const sections = Array.isArray(data.sections) ? data.sections : [];

  return {
    title: data.title || source.title || "未命名改写稿",
    subtitle: data.subtitle || "",
    lead: data.lead || "",
    sections: sections.map((section) => ({
      heading: section.heading || "",
      paragraphs: normalizeStringArray(section.paragraphs),
      bulletPoints: normalizeStringArray(section.bulletPoints),
      quote: section.quote || "",
      imageRefs: normalizeImageRefs(section.imageRefs, source.images || [])
    })),
    closing: data.closing || "",
    cta: data.cta || preferences.cta || "",
    wechatTitleOptions: normalizeStringArray(data.wechatTitleOptions).slice(0, 3),
    keywords: normalizeStringArray(data.keywords).slice(0, 8)
  };
}

function normalizeStringArray(value) {
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .map((item) => String(item || "").trim())
    .filter(Boolean);
}

function normalizeImageRefs(value, images) {
  if (!Array.isArray(value)) {
    return [];
  }

  return value
    .map((item) => ({
      index: Number(item?.index),
      caption: String(item?.caption || "").trim()
    }))
    .filter(
      (item) =>
        Number.isInteger(item.index) &&
        item.index > 0 &&
        item.index <= images.length
    );
}
