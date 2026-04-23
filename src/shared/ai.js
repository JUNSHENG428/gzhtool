import { LENGTH_LABELS, LENGTH_RANGES, LENGTH_TOLERANCE } from "./defaults.js";

const MAX_SOURCE_CHARS = 24000;

export function buildRewriteMessages(source, preferences, settings, template) {
  const snapshot = createSourceSnapshot(source);
  const requestedLength = LENGTH_LABELS[preferences.length] || LENGTH_LABELS.medium;

  const audience =
    preferences.audience ||
    template?.defaults?.audience ||
    settings.defaultAudience;
  const tone =
    preferences.tone || template?.defaults?.tone || settings.defaultTone;
  const angle =
    preferences.angle || template?.defaults?.angle || settings.defaultAngle;
  const cta =
    preferences.cta || template?.defaults?.cta || settings.defaultCta;

  if (template && (template.systemTemplate || template.userTemplate)) {
    const vars = {
      title: source.title || "",
      url: source.url || "",
      siteName: source.siteName || "",
      description: source.description || "",
      wordCount: source.wordCount || 0,
      imageCount: (source.images || []).length,
      audience,
      tone,
      angle,
      length: requestedLength,
      cta,
      content: JSON.stringify(snapshot, null, 2)
    };
    const systemPrompt = renderTemplateString(
      template.systemTemplate || DEFAULT_SYSTEM_PROMPT,
      vars
    );
    const userPrompt = renderTemplateString(
      template.userTemplate || DEFAULT_USER_TEMPLATE,
      vars
    );
    return [
      { role: "system", content: systemPrompt },
      { role: "system", content: buildHardConstraintMessage(requestedLength) },
      { role: "user", content: userPrompt }
    ];
  }

  const systemPrompt = DEFAULT_SYSTEM_PROMPT;

  const userPrompt = [
    "请将下面的来源材料改写成公众号文章。",
    "",
    "改写目标：",
    JSON.stringify(
      {
        audience,
        tone,
        angle,
        requestedLength,
        cta
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
    { role: "system", content: buildHardConstraintMessage(requestedLength) },
    { role: "user", content: userPrompt }
  ];
}

/**
 * 兜底"硬约束" system message：不论用户用什么 prompt 模板，
 * 这一条都会被附加到 system 队列里。包含两类强约束：
 *   1. 字数边界：把 requestedLength（如 "1200-1800 字"）显式提出来当门槛
 *   2. 反 AI 味：参考 AIWriteX 项目梳理的常见 AI 痕迹做集中清单（结构、句式、套话）
 *
 * 之所以独立成一条 system message 而不是合并进 systemPrompt：
 *   - 兼容老用户已经存到 chrome.storage 里的 prompt 模板（不会被覆盖）
 *   - 兼容用户后续自定义的模板，约束始终生效
 */
function buildHardConstraintMessage(requestedLength) {
  return [
    "硬性约束（不要忽略）：",
    "",
    "【字数】整篇正文（含 lead、所有 sections.paragraphs / bulletPoints / quote、closing；不含 title / subtitle / cta / wechatTitleOptions / keywords）总字数应严格落在「" +
      requestedLength +
      "」范围内。超出该范围 ±15% 视为不合格。请在产出前自检字数。",
    "",
    "【反 AI 痕迹】请把以下「AI 习惯」主动消除：",
    "- 不要全篇都是工整对仗的排比、三段式、清单。允许一篇用 1-2 个列表，避免每个 section 都用列表。",
    "- 长短句交错。每段不超过 4 句；至少要有一段是 1-2 句的短段，让节奏有呼吸。",
    "- 慎用机械连接词。减少「首先 / 其次 / 最后」、「一方面 / 另一方面」这种程式化过渡，改用更自然的承接。",
    "- 允许出现轻微主观色彩、反问句、设问句、半口语化的判断；不要全程「客观中立」。",
    "- 禁用套话黑名单：「随着 …… 的不断发展」「在当今时代」「毋庸置疑」「众所周知」「值得我们深思」「归根结底」「总而言之」「综上所述」「事实证明」「在 …… 的浪潮下」「科技的飞速发展」「不可忽视的力量」。",
    "",
    "【事实约束（再次强调）】数字、人名、产品名、引语、时间必须与来源一致；不要编造来源中没有的细节。",
    "",
    "【图片必保留】只要来源 images 数组里有图，并且图本身不是明显的头像 / logo / emoji / 图标 / 广告位 / 追踪像素，",
    "就必须在 sections.imageRefs 里至少引用一次。注意：每张图片只能引用一次（不要复用同一个 index）。",
    "imageRefs 的位置要尽量贴近它在原文中描述的语义段落，而不是统一塞在最后一节末尾。",
    "",
    "【结构必保留】来源 blocks 中如果有 type=\"code\" / \"table\" / \"math\" 的块，必须等量保留到对应 section 的",
    "codeBlocks / tables / mathBlocks 字段（不允许翻译成纯文字段落，也不允许丢弃）。",
    "代码块要保留原始缩进、原始 language 字段；表格要保留 headers/rows 维度。"
  ].join("\n");
}

const DEFAULT_SYSTEM_PROMPT = [
  "你是一名资深微信公众号编辑，负责把网页内容改写成适合公众号发布的原创风格文章。",
  "必须遵守这些规则：",
  "1. 只基于提供的来源事实写作，不要编造数据、案例、引语、公司动作或人物观点。",
  "2. 允许重组结构、加强开头钩子、提炼论点，但不要篡改原文结论。",
  "3. 语气要像成熟编辑，而不是模板化 AI 文案；避免「随着…的不断发展」「在当今时代」等套话。",
  "4. 输出必须是合法 JSON，且只输出 JSON，不要附加解释或 Markdown 代码块。",
  "5. JSON 字段必须包含 title、subtitle、lead、sections、closing、cta、wechatTitleOptions、keywords。",
  "6. 每个 section 必须包含 heading、paragraphs、bulletPoints、quote、imageRefs、codeBlocks、tables、mathBlocks。",
  "7. imageRefs 中每一项形如 {\"index\": 1, \"caption\": \"图注\"}，index 必须引用来源图片编号。",
  "8. codeBlocks 中每一项形如 {\"language\": \"python\", \"text\": \"...\"}；tables 形如 {\"headers\": [...], \"rows\": [[...], ...]}；mathBlocks 形如 {\"latex\": \"E=mc^2\", \"display\": true}。",
  "9. 若某个字段没有内容，请返回空字符串或空数组，不要省略字段。"
].join("\n");

const DEFAULT_USER_TEMPLATE = `请将下面的来源材料改写成公众号文章。

改写目标：
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

正文内容：
{{content}}`;

function renderTemplateString(text, vars) {
  return String(text || "").replace(/\{\{\s*(\w+)\s*\}\}/g, (_, key) => {
    if (Object.prototype.hasOwnProperty.call(vars, key)) {
      const value = vars[key];
      return value == null ? "" : String(value);
    }
    return `{{${key}}}`;
  });
}

export async function requestRewrite(settings, source, preferences, template) {
  if (!settings.apiKey?.trim()) {
    throw new Error("请先在设置页填写 API Key。");
  }

  if (!settings.apiBaseUrl?.trim()) {
    throw new Error("请先在设置页填写 API Base URL。");
  }

  const messages = buildRewriteMessages(source, preferences, settings, template);
  const model =
    String(template?.model || "").trim() || String(settings.model || "").trim();
  const temperatureSource =
    template && template.temperature != null && template.temperature !== ""
      ? template.temperature
      : settings.temperature;
  const temperature = Number(temperatureSource ?? 0.8);

  const response = await fetch(settings.apiBaseUrl.trim(), {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${settings.apiKey.trim()}`
    },
    body: JSON.stringify({
      model,
      temperature,
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
    throw new Error("AI 返回内容为空，无法生成改写稿。" + diagnoseEmptyChatPayload(payload));
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
        // 用一个明确的英文回令，比 ping 更不易被某些模型拒绝；
        // 中文系统消息提高 GLM/Kimi/Qwen 等中文模型的合规率。
        messages: [
          { role: "system", content: "你是一个连通性检测助手，请按用户要求简短回应。" },
          { role: "user", content: "请回复 pong" }
        ],
        // 64 token 对推理模型（DeepSeek R1 / o1 / Claude thinking）也够吐出
        // 至少几个字符的正文。原 5 token 会导致 reasoning 把 token 用完后
        // content 留空，被误报为「模型不支持 chat completion」。
        max_tokens: 64,
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
      const diag = diagnoseEmptyChatPayload(payload);
      return createAiTestFailure(
        "接口已连通但返回内容为空。常见原因：max_tokens 太小、模型仅支持 completions 旧接口、或代理把响应字段改名。" +
          diag,
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

export function buildManualPrompt(source, preferences, settings, template) {
  return buildRewriteMessages(source, preferences, settings, template)
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

/**
 * 从 chat completion 响应里抽出可用的正文文本，覆盖主流国内外 LLM 厂商：
 *   - OpenAI / 兼容代理：choices[0].message.content（string 或 array of {type,text}）
 *   - OpenAI o1 / DeepSeek R1 等推理模型：reasoning 在 reasoning_content，
 *     正文在 message.content；如果 content 为空但 reasoning 非空，回退到 reasoning
 *   - Anthropic 直连：content[0].text（旧 SDK）/ choices...（通过代理）
 *   - 智谱 GLM / Kimi / 文心：choices[0].message.content（标准）
 *   - 文心 ernie-bot v1：直接 result 字段
 *   - 通义千问 dashscope：output.text 或 output.choices[0].message.content
 *   - 流式（按理不会进这条路径，兜底）：choices[0].delta.content
 *
 * 最终返回 trim 后的字符串；什么都没解析到返回 ""。
 */
export function extractChatContent(payload) {
  if (!payload || typeof payload !== "object") return "";

  const fromChoice = (choice) => {
    if (!choice) return "";
    const msg = choice.message || choice.delta || {};
    const c = msg.content;
    if (typeof c === "string" && c.trim()) return c;
    if (Array.isArray(c)) {
      const joined = c
        .map((item) => {
          if (typeof item === "string") return item;
          if (item?.type === "text") return item.text || "";
          if (item?.text) return item.text;
          return "";
        })
        .join("");
      if (joined.trim()) return joined;
    }
    // 推理模型：content 为空时退到 reasoning_content
    if (typeof msg.reasoning_content === "string" && msg.reasoning_content.trim()) {
      return msg.reasoning_content;
    }
    if (typeof choice.text === "string" && choice.text.trim()) return choice.text;
    return "";
  };

  // 1) OpenAI 兼容（choices 数组）
  if (Array.isArray(payload.choices) && payload.choices.length > 0) {
    const text = fromChoice(payload.choices[0]);
    if (text) return text;
  }

  // 2) Anthropic 直连：content: [{type:"text", text:"..."}]
  if (Array.isArray(payload.content)) {
    const joined = payload.content
      .map((item) => (typeof item === "string" ? item : item?.text || ""))
      .join("");
    if (joined.trim()) return joined;
  }

  // 3) 文心 ernie-bot：result 字段
  if (typeof payload.result === "string" && payload.result.trim()) {
    return payload.result;
  }

  // 4) 通义千问 dashscope：output.text 或 output.choices
  if (payload.output) {
    if (typeof payload.output.text === "string" && payload.output.text.trim()) {
      return payload.output.text;
    }
    if (Array.isArray(payload.output.choices) && payload.output.choices.length > 0) {
      const text = fromChoice(payload.output.choices[0]);
      if (text) return text;
    }
  }

  return "";
}

/**
 * 给空响应抓取诊断线索，让错误提示更具体（finish_reason、token 用量等）。
 * 返回一段附带在错误文案后的「· 诊断: ...」字符串，没线索则返回 ""。
 */
function diagnoseEmptyChatPayload(payload) {
  if (!payload || typeof payload !== "object") return "";
  const hints = [];
  const choice = payload.choices?.[0];
  const finish = choice?.finish_reason || choice?.finishReason;
  if (finish) hints.push(`finish_reason=${finish}`);
  if (finish === "length") {
    hints.push("max_tokens 太小");
  }
  // 推理模型把 token 都用在思考上的特征：reasoning_tokens 非 0、completion_tokens 0
  const usage = payload.usage || {};
  const reasoning =
    usage.completion_tokens_details?.reasoning_tokens ?? usage.reasoning_tokens;
  const completion = usage.completion_tokens;
  if (reasoning && (!completion || completion === reasoning)) {
    hints.push(`推理模型消耗 ${reasoning} 思考 token 但未输出正文`);
  }
  // Anthropic 直连返回 stop_reason 而不是 finish_reason
  const stopReason = payload.stop_reason;
  if (stopReason && stopReason !== "end_turn") hints.push(`stop_reason=${stopReason}`);
  // 一些代理会把错误塞在 200 响应的 error 字段里
  const errMsg = payload.error?.message || payload.error;
  if (typeof errMsg === "string") hints.push(`内嵌 error=${errMsg.slice(0, 80)}`);

  return hints.length ? ` · 诊断: ${hints.join("; ")}` : "";
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
  const rawSections = Array.isArray(data.sections) ? data.sections : [];
  const sourceImages = Array.isArray(source.images) ? source.images : [];

  const sections = rawSections.map((section) => ({
    heading: section.heading || "",
    paragraphs: normalizeStringArray(section.paragraphs),
    bulletPoints: normalizeStringArray(section.bulletPoints),
    quote: section.quote || "",
    imageRefs: normalizeImageRefs(section.imageRefs, sourceImages),
    // 新增三类结构化内容，渲染层会据此画 <pre>/<table>/数学公式
    codeBlocks: normalizeCodeBlocks(section.codeBlocks),
    tables: normalizeTables(section.tables),
    mathBlocks: normalizeMathBlocks(section.mathBlocks)
  }));

  // —— 漏图兜底 ——
  // AI 经常会"忘掉"原文中的图片引用。我们扫描所有 section.imageRefs 已用到的 index，
  // 把"应该被引用却没被引用"的来源图片，按它们在原文 blocks 里出现的顺序，
  // 插回到最近的那个 section 的 imageRefs 末尾。
  // 排除规则：明显的 logo / avatar / emoji / icon / tracking pixel / 广告位
  injectMissingImages(sections, source);

  // 同理：来源里出现但 AI 输出里完全消失的 code / table 也补回最近的 section
  injectMissingStructuredBlocks(sections, source);

  return {
    title: data.title || source.title || "未命名改写稿",
    subtitle: data.subtitle || "",
    lead: data.lead || "",
    sections,
    closing: data.closing || "",
    cta: data.cta || preferences.cta || "",
    wechatTitleOptions: normalizeStringArray(data.wechatTitleOptions).slice(0, 3),
    keywords: normalizeStringArray(data.keywords).slice(0, 8)
  };
}

function normalizeCodeBlocks(value) {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => ({
      language: String(item?.language || "").trim(),
      text: String(item?.text || item?.code || "")
    }))
    .filter((b) => b.text.trim().length > 0);
}

function normalizeTables(value) {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => ({
      headers: Array.isArray(item?.headers) ? item.headers.map((s) => String(s || "")) : [],
      rows: Array.isArray(item?.rows)
        ? item.rows.map((row) =>
            Array.isArray(row) ? row.map((cell) => String(cell || "")) : []
          )
        : []
    }))
    .filter((t) => t.headers.length > 0 || t.rows.length > 0);
}

function normalizeMathBlocks(value) {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => ({
      // 支持 { latex } 或 { tex } 或 { text }
      latex: String(item?.latex || item?.tex || item?.text || "").trim(),
      display: item?.display !== false
    }))
    .filter((m) => m.latex.length > 0);
}

const NON_CONTENT_IMAGE_PATTERNS = [
  /\b(avatar|portrait|profile)\b/i,
  /\b(logo|brandmark|wordmark)\b/i,
  /\b(emoji|emoticon|sticker)\b/i,
  /\b(icon|favicon)\b/i,
  /\b(advert|banner|sponsor|promo|pixel|tracker|tracking)\b/i,
  /1x1|spacer/i
];

function looksLikeNonContentImage(image) {
  if (!image) return true;
  const haystack = `${image.src || ""} ${image.alt || ""} ${image.caption || ""}`;
  return NON_CONTENT_IMAGE_PATTERNS.some((re) => re.test(haystack));
}

function injectMissingImages(sections, source) {
  const sourceImages = Array.isArray(source.images) ? source.images : [];
  if (sourceImages.length === 0 || sections.length === 0) return;

  const used = new Set();
  for (const section of sections) {
    for (const ref of section.imageRefs) {
      used.add(ref.index);
    }
  }

  // 收集来源 blocks 里的 image 出现顺序（用 1-based index 对应 sourceImages）
  const blocks = Array.isArray(source.blocks) ? source.blocks : [];
  const orderedImageIndexes = [];
  for (const block of blocks) {
    if (block?.type === "image" && Number.isInteger(Number(block.index)) && Number(block.index) > 0) {
      orderedImageIndexes.push(Number(block.index));
    }
  }
  // 对没在 blocks 里出现过的 source.images，也按 sourceImages 的天然顺序补上
  for (let i = 1; i <= sourceImages.length; i += 1) {
    if (!orderedImageIndexes.includes(i)) orderedImageIndexes.push(i);
  }

  for (const idx of orderedImageIndexes) {
    if (used.has(idx)) continue;
    const image = sourceImages[idx - 1];
    if (!image || !image.src) continue;
    if (looksLikeNonContentImage(image)) continue;

    // 选最近的 section：均匀分布——idx 0..N 映射到 sections 0..S-1
    const sectionIdx = Math.min(
      sections.length - 1,
      Math.floor(((idx - 1) / Math.max(1, sourceImages.length)) * sections.length)
    );
    sections[sectionIdx].imageRefs.push({
      index: idx,
      caption: image.caption || image.alt || ""
    });
    used.add(idx);
  }
}

function injectMissingStructuredBlocks(sections, source) {
  const blocks = Array.isArray(source.blocks) ? source.blocks : [];
  if (blocks.length === 0 || sections.length === 0) return;

  const usedCode = new Set();
  const usedTable = new Set();
  for (const section of sections) {
    for (const cb of section.codeBlocks) usedCode.add(`${cb.language}::${cb.text.slice(0, 80)}`);
    for (const tb of section.tables)
      usedTable.add(`${tb.headers.join("|")}::${tb.rows.length}`);
  }

  let cursor = 0;
  blocks.forEach((block) => {
    if (block?.type === "code") {
      const text = String(block.text || "").trim();
      if (!text) return;
      const key = `${String(block.language || "").trim()}::${text.slice(0, 80)}`;
      if (usedCode.has(key)) return;
      const sectionIdx = Math.min(sections.length - 1, cursor % sections.length);
      sections[sectionIdx].codeBlocks.push({
        language: String(block.language || "").trim(),
        text
      });
      usedCode.add(key);
      cursor += 1;
    } else if (block?.type === "table") {
      const headers = Array.isArray(block.headers) ? block.headers : [];
      const rows = Array.isArray(block.rows) ? block.rows : [];
      if (headers.length === 0 && rows.length === 0) return;
      const key = `${headers.join("|")}::${rows.length}`;
      if (usedTable.has(key)) return;
      const sectionIdx = Math.min(sections.length - 1, cursor % sections.length);
      sections[sectionIdx].tables.push({
        headers: headers.map((s) => String(s || "")),
        rows: rows.map((row) => (Array.isArray(row) ? row.map((cell) => String(cell || "")) : []))
      });
      usedTable.add(key);
      cursor += 1;
    }
  });
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

/**
 * 估算改写稿"正文"字数：lead + 所有 sections（heading/paragraphs/bullets/quote）+ closing。
 * 对中英混排的文本，去掉空白后按字符长度计；不计 title/subtitle/cta/wechatTitleOptions/keywords。
 * 这与 buildHardConstraintMessage 中字数边界的统计口径保持一致。
 */
export function estimateArticleChars(article) {
  if (!article || typeof article !== "object") return 0;
  const parts = [];
  const push = (value) => {
    if (typeof value === "string" && value) parts.push(value);
  };
  push(article.lead);
  for (const section of Array.isArray(article.sections) ? article.sections : []) {
    push(section.heading);
    push(section.quote);
    for (const p of Array.isArray(section.paragraphs) ? section.paragraphs : []) push(p);
    for (const b of Array.isArray(section.bulletPoints) ? section.bulletPoints : []) push(b);
  }
  push(article.closing);
  return parts.reduce((sum, str) => sum + str.replace(/\s+/g, "").length, 0);
}

/**
 * 拿生成稿的实际字数和 preferences.length 对应的期望区间做对比。
 * 返回 { actual, expected: {min,max} | null, status: 'unknown'|'ok'|'short'|'long', deltaPct }
 *   - status='unknown'：preferences.length 不在 LENGTH_RANGES 里
 *   - status='ok'：实际字数 in [min*(1-tol), max*(1+tol)]
 *   - status='short'/'long'：超出容差的偏小 / 偏大
 *   - deltaPct：相对于离它最近的边界的百分比偏差（正数表示越界量）
 */
export function evaluateArticleLength(article, preferenceLength) {
  const actual = estimateArticleChars(article);
  const expected = LENGTH_RANGES[preferenceLength];
  if (!expected) return { actual, expected: null, status: "unknown", deltaPct: 0 };

  const tol = LENGTH_TOLERANCE;
  const lower = Math.floor(expected.min * (1 - tol));
  const upper = Math.ceil(expected.max * (1 + tol));
  if (actual >= lower && actual <= upper) {
    return { actual, expected, status: "ok", deltaPct: 0 };
  }
  if (actual < lower) {
    const deltaPct = Math.round(((expected.min - actual) / expected.min) * 100);
    return { actual, expected, status: "short", deltaPct };
  }
  const deltaPct = Math.round(((actual - expected.max) / expected.max) * 100);
  return { actual, expected, status: "long", deltaPct };
}
