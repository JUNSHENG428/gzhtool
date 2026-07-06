/**
 * rewriter.js —— DeepSeek 去 AI 味改写 + 金句抽取模块
 * 运行环境：service_worker（后台，负责跨域请求 DeepSeek API）
 *
 * 两个能力共用一次/两次 LLM 调用：
 *   1. rewriteHumanize(): 把采集来的正文改写成"有人味"的公众号文章（去 AI 腔）
 *   2. extractPunchlines(): 抽取 3-5 条适合做金句卡片的句子
 *
 * 设计要点：
 *   - 模型可切换：DEEPSEEK_CONFIG 抽成配置，未来换 Claude 只改这里
 *   - 输出强约束 JSON：用 response_format + 提示词双保险，便于程序消费
 *   - 去 AI 味的关键在"系统提示词"——见 HUMANIZE_SYSTEM_PROMPT
 */

const DEEPSEEK_CONFIG = {
  endpoint: "https://api.deepseek.com/chat/completions",
  model: "deepseek-chat",
  // apiKey 不要硬编码：从 chrome.storage 读，或由用户在设置页填入
};

/** 去 AI 味的核心系统提示词——这是功能成败的关键，可持续打磨 */
const HUMANIZE_SYSTEM_PROMPT = `你是一位资深的中文公众号编辑。任务：把给定的原始网页正文改写成一篇自然、有"人味"的公众号文章。

【去 AI 味的硬性要求】
1. 删除一切 AI 腔套话：禁用"在当今时代""综上所述""总而言之""首先/其次/最后""值得注意的是""不仅...而且""随着...的发展""让我们一起"。
2. 句子长短交错，不要每句都工整对仗。允许出现短句、口语化停顿。
3. 用具体代替笼统：把"很多""非常""极大地"换成具体的事、数字或例子。
4. 加入第一人称视角或对读者的直接对话感（"你可能也遇到过…"），但不要肉麻。
5. 保留原文的事实、数据、观点，不得编造信息；不确定的地方宁可省略。
6. 段落不要过度均匀，允许一两句独立成段以制造节奏。
7. 不要使用 emoji 堆砌，不要每段都加小标题。

【输出格式】严格输出 JSON，不要任何解释：
{
  "title": "改写后的标题（更有点击欲但不标题党）",
  "lead": "开头导语，60字内，一句话钩住读者",
  "sections": [
    { "heading": "小标题（可选，没有就留空字符串）", "paragraphs": ["段落1", "段落2"] }
  ],
  "closing": "结尾段落"
}`;

const PUNCHLINE_SYSTEM_PROMPT = `你是公众号金句提炼专家。从给定文章中挑出 3-5 句最适合做成"金句卡片"在朋友圈传播的句子。
要求：每句 10-30 字，独立成立、有观点或情绪、读者愿意转发。可对原句做轻微凝练但不改变原意。
严格输出 JSON：{ "punchlines": ["金句1", "金句2", "金句3"] }`;

/**
 * 去 AI 味改写
 * @param {{title:string, rawText:string}} article 采集结果
 * @param {string} apiKey
 * @returns {Promise<object>} 结构化文章对象（与你现有 renderArticleBody 的 article 结构对齐）
 */
export async function rewriteHumanize(article, apiKey) {
  const userPrompt = `原始标题：${article.title}\n\n原始正文：\n${truncate(article.rawText, 6000)}`;
  const data = await callDeepSeek(
    [
      { role: "system", content: HUMANIZE_SYSTEM_PROMPT },
      { role: "user", content: userPrompt },
    ],
    apiKey
  );
  return safeParseJson(data, { title: article.title, lead: "", sections: [], closing: "" });
}

/**
 * 金句抽取
 * @param {string} articleText 改写后的正文（或原文）
 * @param {string} apiKey
 * @returns {Promise<string[]>}
 */
export async function extractPunchlines(articleText, apiKey) {
  const data = await callDeepSeek(
    [
      { role: "system", content: PUNCHLINE_SYSTEM_PROMPT },
      { role: "user", content: truncate(articleText, 6000) },
    ],
    apiKey
  );
  const parsed = safeParseJson(data, { punchlines: [] });
  return Array.isArray(parsed.punchlines) ? parsed.punchlines.slice(0, 5) : [];
}

/** 统一的 DeepSeek 调用，带 JSON 强约束与错误处理 */
async function callDeepSeek(messages, apiKey) {
  if (!apiKey) throw new Error("缺少 DeepSeek API Key，请在插件设置中填入");

  const res = await fetch(DEEPSEEK_CONFIG.endpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: DEEPSEEK_CONFIG.model,
      messages,
      temperature: 1.1,            // 略高温度让文字更"活"，去机械感
      response_format: { type: "json_object" },
    }),
  });

  if (!res.ok) {
    const errText = await res.text().catch(() => "");
    throw new Error(`DeepSeek 调用失败 ${res.status}: ${errText.slice(0, 200)}`);
  }
  const json = await res.json();
  return json.choices?.[0]?.message?.content || "";
}

function safeParseJson(text, fallback) {
  try {
    // 容错：模型偶尔会用 ```json 包裹
    const cleaned = text.replace(/^```json\s*/i, "").replace(/```$/, "").trim();
    return JSON.parse(cleaned);
  } catch {
    return fallback;
  }
}

function truncate(text, max) {
  const s = String(text || "");
  return s.length > max ? s.slice(0, max) : s;
}

export { DEEPSEEK_CONFIG, HUMANIZE_SYSTEM_PROMPT };
