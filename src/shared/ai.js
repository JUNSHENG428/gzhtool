import { LENGTH_LABELS, LENGTH_RANGES, LENGTH_TOLERANCE } from "./defaults.js";
import { getHumanizeProfile } from "./humanize-rules.js";
import { EDITORIAL_RULES } from "./editorial-rules.js";
import { INSIGHT_PRESSURE_RULES, lintInsight } from "./insight-rules.js";
import { repairComicData } from "./comic-prompt.js";
import { ensureOptionalHostPermission } from "./host-permissions.js";
import { normalizeText } from "./utils.js";
// 39th session · 平台 LLM 代理（reverse gating）
import { getAuthRecord, getApiBase, checkLicense } from "./license.js";

const MAX_SOURCE_CHARS = 24000;

/**
 * 当前篇正文是否足够让「按编辑区改写」走正文而非仅 lastCapture（至少若干字，或含图）。
 */
export function isEditorBodySubstantiveForRewrite(bodyHtml) {
  const raw = String(bodyHtml || "").trim();
  if (!raw) return false;
  if (/<\s*img\b/i.test(raw) || /<\s*figure\b/i.test(raw)) return true;
  const text = normalizeText(
    new DOMParser().parseFromString(raw, "text/html").body.textContent || ""
  );
  return text.length >= 8;
}

/**
 * 用当前篇 meta + 正文 HTML 合成与抓取结构兼容的 source，供 buildRewriteMessages / requestRewrite 使用。
 * 会合并 state.source 里的图片，并把正文里出现、但尚未在图库中的 img 追加入 images 数组。
 */
export function buildRewriteSourceFromCurrentArticle(state, article) {
  const base = state.source
    ? {
        title: String(state.source.title || ""),
        url: String(state.source.url || ""),
        description: String(state.source.description || ""),
        siteName: String(state.source.siteName || ""),
        author: String(state.source.author || ""),
        wordCount: Number(state.source.wordCount || 0),
        images: (state.source.images || []).map((im) => ({ ...im }))
      }
    : {
        title: "",
        url: "",
        description: "",
        siteName: "",
        author: "",
        wordCount: 0,
        images: []
      };

  const title = (article?.meta?.title && String(article.meta.title).trim()) || base.title;
  const url = (article?.meta?.contentSourceUrl && String(article.meta.contentSourceUrl).trim()) || base.url;

  const images = base.images;
  const { blocks, textChars } = buildBlocksFromBodyHtml(article?.bodyHtml || "", images);
  return {
    ...base,
    title: title || base.title,
    url,
    blocks,
    wordCount: textChars > 0 ? textChars : base.wordCount
  };
}

/**
 * 将 #editor 内 bodyHtml 转为与抓取一致的 blocks 数组；`images` 为可变数组，可追加新图并更新索引。
 */
function buildBlocksFromBodyHtml(bodyHtml, images) {
  const blocks = [];
  let textChars = 0;
  const wrap = String(bodyHtml || "").trim();
  if (!wrap) {
    return { blocks, textChars: 0 };
  }
  const doc = new DOMParser().parseFromString(
    `<div class="gzh-rewrite-body">${wrap}</div>`,
    "text/html"
  );
  const root = doc.body.querySelector(".gzh-rewrite-body");
  if (!root) {
    return { blocks, textChars: 0 };
  }

  const ensureImageIndex = (imgEl) => {
    if (!imgEl) return 0;
    const src = String(imgEl.getAttribute("src") || imgEl.src || "").trim();
    if (!src) return 0;
    let idx = images.findIndex((im) => im && String(im.src || "").trim() === src) + 1;
    if (idx > 0) return idx;
    const parent = imgEl.closest("figure");
    const cap =
      parent && parent.querySelector
        ? normalizeText(parent.querySelector("figcaption")?.textContent || "")
        : "";
    images.push({
      src,
      alt: String(imgEl.getAttribute("alt") || "").trim(),
      caption: cap || "正文插图"
    });
    return images.length;
  };

  const pushText = (t) => {
    const s = normalizeText(t);
    if (!s) return;
    textChars += s.length;
    blocks.push({ type: "paragraph", text: s });
  };

  const walk = (el) => {
    if (!el) return;
    for (const node of el.childNodes) {
      if (node.nodeType === Node.ELEMENT_NODE) {
        const tag = (node).tagName;
        if (tag === "P") {
          pushText(node.textContent);
        } else if (/^H[1-6]$/i.test(tag)) {
          const level = Math.min(6, Math.max(1, parseInt(tag.charAt(1), 10) || 2));
          const hashes = "#".repeat(level) + " ";
          pushText(hashes + normalizeText(node.textContent));
        } else if (tag === "BLOCKQUOTE") {
          const inner = normalizeText(node.textContent);
          if (inner) pushText("> " + inner);
        } else if (tag === "FIGURE") {
          const img = node.querySelector("img");
          const ix = ensureImageIndex(img);
          if (ix) {
            blocks.push({
              type: "image",
              index: ix,
              src: String(img.getAttribute("src") || img.src),
              alt: String(img.getAttribute("alt") || "").trim(),
              caption: String(node.querySelector("figcaption")?.textContent || "").trim()
            });
          }
        } else if (tag === "UL" || tag === "OL") {
          for (const li of node.querySelectorAll(":scope > li")) {
            const t = normalizeText(li.textContent);
            if (t) {
              const prefix = tag === "UL" ? "• " : "1) ";
              pushText(prefix + t);
            }
          }
        } else if (tag === "PRE") {
          const text = (node.textContent || "").replace(/\n+$/, "");
          if (text.trim()) {
            blocks.push({ type: "code", language: "", text: text });
            textChars += text.length;
          }
        } else if (tag === "DIV" || tag === "SECTION" || tag === "ARTICLE") {
          walk(node);
        } else if (tag === "IMG") {
          const ix = ensureImageIndex(node);
          if (ix) {
            blocks.push({
              type: "image",
              index: ix,
              src: String(node.getAttribute("src") || node.src),
              alt: String(node.getAttribute("alt") || "").trim()
            });
          }
        } else {
          const onlyText = normalizeText(node.textContent);
          if (onlyText) pushText(onlyText);
        }
      } else if (node.nodeType === Node.TEXT_NODE) {
        const t = normalizeText(node.textContent);
        if (t) pushText(t);
      }
    }
  };

  walk(root);

  if (blocks.length === 0) {
    const all = normalizeText(root.textContent || "");
    if (all) {
      return { blocks: [{ type: "paragraph", text: all }], textChars: all.length };
    }
  }
  return { blocks, textChars };
}

/**
 * 构建发给 LLM 的消息序列。
 *
 * @param {object} source            标准化后的来源 capture
 * @param {object} preferences       用户在工作区设置的临时偏好
 * @param {object} settings          全局 settings（含 humanize / voice 等）
 * @param {object} [template]        当前激活的 prompt 模板
 * @param {object} [voiceSample]     可选的「我的文风」样本（已抽取过 fingerprint）
 *                                   stage 3 注入；为 null 时不影响任何已有行为。
 * @param {object} [thesisBrief]     可选的「立论骨架」（requestThesisBrief 产出）。
 *                                   非空时以独立 system message 注入，要求成稿围绕骨架展开；
 *                                   为 null 时不影响任何已有行为（立论失败降级为普通改写）。
 */
export function buildRewriteMessages(source, preferences, settings, template, voiceSample = null, thesisBrief = null) {
  const snapshot = createSourceSnapshot(source);
  const requestedLength = LENGTH_LABELS[preferences.length] || LENGTH_LABELS.medium;
  // 45th 续 · 自拟主题创作模式：source 不是网页采集物，而是用户填的「主题 + 想法要点」。
  const isBrief = String(source?.origin || "") === "brief";

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

  // 模板可以声明自己是否使用 voice sample（"force-off" 时强制忽略，例如学术稿）
  const usePolicy = String(template?.useVoiceSample || "auto");
  const effectiveVoiceSample =
    usePolicy === "force-off" ? null : voiceSample;

  const messages = [];
  // brief 模式不走自定义模板分支：所有自定义模板都是「忠实改写来源」语义，
  // 强行套在"几条想法要点"上会让 LLM 把要点当成全文做缩写式改写。
  // template 仍然生效的部分：defaults（audience/tone/angle/cta）+ humanizeProfile（硬约束阈值）。
  if (!isBrief && template && (template.systemTemplate || template.userTemplate)) {
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
    messages.push({ role: "system", content: systemPrompt });
    messages.push({
      role: "system",
      content: buildHardConstraintMessage(requestedLength, template)
    });
    if (thesisBrief) {
      messages.push({ role: "system", content: buildThesisBriefMessage(thesisBrief) });
    }
    if (effectiveVoiceSample) {
      messages.push({
        role: "system",
        content: buildVoiceSampleMessage(effectiveVoiceSample)
      });
    }
    messages.push({ role: "user", content: userPrompt });
    return messages;
  }

  const systemPrompt = isBrief ? CREATION_SYSTEM_PROMPT : DEFAULT_SYSTEM_PROMPT;

  const userPrompt = [
    isBrief
      ? "请根据下面的主题与作者想法要点，撰写一篇公众号原创文章。"
      : "请将下面的来源材料改写成公众号文章。",
    "",
    isBrief ? "创作目标：" : "改写目标：",
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
    isBrief ? "主题与想法要点（作者提供）：" : "来源快照：",
    JSON.stringify(snapshot, null, 2)
  ].join("\n");

  messages.push({ role: "system", content: systemPrompt });
  messages.push({
    role: "system",
    content: buildHardConstraintMessage(requestedLength, template)
  });
  if (thesisBrief) {
    messages.push({ role: "system", content: buildThesisBriefMessage(thesisBrief) });
  }
  if (effectiveVoiceSample) {
    messages.push({
      role: "system",
      content: buildVoiceSampleMessage(effectiveVoiceSample)
    });
  }
  messages.push({ role: "user", content: userPrompt });
  return messages;
}

/**
 * 把立论骨架翻译成 system message。骨架来自 requestThesisBrief 的前置分析调用——
 * 文章有没有思想在立论这一步就决定了，成稿只是把骨架长肉，所以这条 message
 * 用「必须围绕」的强约束语气，并附思想密度正向压力规则。
 */
function buildThesisBriefMessage(brief) {
  const lines = ["【立论骨架（先前分析产出，成稿必须围绕它展开，不得偏题另立）】", ""];
  if (brief.thesis) lines.push(`- 核心判断（thesis，全文主轴）：${brief.thesis}`);
  if (brief.angle) lines.push(`- 切入角度：${brief.angle}`);
  if (Array.isArray(brief.argumentChain) && brief.argumentChain.length) {
    lines.push("- 论证链（按此顺序推进）：");
    brief.argumentChain.forEach((step, i) => lines.push(`  ${i + 1}. ${step}`));
  }
  if (brief.counterView) lines.push(`- 必须正面回应的反方观点：${brief.counterView}`);
  if (brief.stakes) lines.push(`- 代价与输家分析：${brief.stakes}`);
  if (brief.forecast) lines.push(`- 可验证推断（写进结尾附近）：${brief.forecast}`);
  lines.push("");
  lines.push(INSIGHT_PRESSURE_RULES);
  return lines.join("\n");
}

/** 统一编辑底线；旧模板也会收到，不覆盖用户保存的模板。 */
function buildHardConstraintMessage(requestedLength, template = null) {
  const profile = {
    ...getHumanizeProfile(template?.id || ""),
    ...(template?.humanizeProfile || {})
  };
  return [
    "硬性约束（不要忽略）：",
    EDITORIAL_RULES,
    "",
    "【字数】整篇正文（含 lead、所有 sections.paragraphs / bulletPoints / quote、closing；不含 title / subtitle / cta / wechatTitleOptions / keywords）目标为「" + requestedLength + "」。素材不足时优先保留事实与完整意思，不为凑字数重复结论或编造内容。",
    profile.allowFirstPerson === false ? "【个人视角】保持客观，不出现第一人称。" : "【个人视角】仅保留来源已有的个人经历或有事实依据的判断，不另加口头禅。",
    "",
    "【主体识别 · 噪声过滤】",
    "- 来源 source 由抓取脚本基于通用规则提取，可能仍混入页面噪声（评论 / 推荐文章 / 相关阅读 / 作者简介 / 订阅引导 / 广告位 / 导航栏残余 / 上下篇链接 / 站点 footer / 二维码说明 / 「点击下载 App」等 CTA 文字）。",
    "- 你必须先识别 source 主体（围绕标题展开的核心论述/叙述/观点），再对主体改写。**不要**把噪声与主体糅合在一起改写出来。",
    "- 判定信号：① 与 title 主题强相关 = 主体；② 段落短促零散 + 多 URL/「点击/订阅/相关」字样 = 噪声；③ 多个不连贯的标题列表 = 推荐位噪声；④ 评论/UGC 风格（如「我觉得」「楼主」「沙发」）= 噪声。",
    "- 命中噪声段：忽略不写入产出，但保留主体段对它的合理引用（如「作者在文中引用了某条用户评论」这种主体内嵌叙述要保留）。",
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

/**
 * 把用户的「文风样本」翻译成 system message。
 * 分两段：fingerprint 摘要（结构化数据，让 LLM 知道目标）+ 2 段截选（few-shot）。
 *
 * 总 token 控制目标：fingerprint ~300 token，截选 ~600 token，整体 < 1000 token，
 * 避免严重撑大 prompt。
 */
function buildVoiceSampleMessage(sample) {
  if (!sample || typeof sample !== "object") return "";
  const fp = sample.fingerprint || {};
  const title = String(sample.title || "未命名样本").slice(0, 40);
  const lines = [
    "【个人文风学习】请尽量靠近以下作者的写作习惯（来源：用户保存的样本「" + title + "」）：",
    ""
  ];
  if (fp.avgSentenceLen) lines.push(`- 平均句长约 ${Number(fp.avgSentenceLen).toFixed(1)} 字`);
  if (fp.burstiness) lines.push(`- 突发性 ${Number(fp.burstiness).toFixed(2)}`);
  if (Array.isArray(fp.signaturePhrases) && fp.signaturePhrases.length) {
    lines.push(
      "- 常用语气词：" +
        fp.signaturePhrases.slice(0, 6).map((s) => `「${s}」`).join("、")
    );
  }
  if (Array.isArray(fp.toneTags) && fp.toneTags.length) {
    lines.push("- 语气标签：" + fp.toneTags.slice(0, 5).join(" / "));
  }
  if (fp.punctuationProfile) {
    const pp = fp.punctuationProfile;
    if (pp.dashesPer100 != null) lines.push(`- 破折号密度 ${Number(pp.dashesPer100).toFixed(2)}/100 字`);
    if (pp.exclamPer100 != null) lines.push(`- 感叹号密度 ${Number(pp.exclamPer100).toFixed(2)}/100 字`);
  }
  if (Array.isArray(fp.forbidden) && fp.forbidden.length) {
    lines.push(
      "- 这位作者从不使用：" + fp.forbidden.slice(0, 6).map((s) => `「${s}」`).join("、")
    );
  }
  if (Array.isArray(fp.excerpts) && fp.excerpts.length) {
    lines.push("");
    lines.push("【作者截选 · 仅用于风格参考，不要把内容搬到改写稿里】");
    fp.excerpts.slice(0, 2).forEach((e, i) => {
      const text = String(e || "").slice(0, 600).trim();
      if (text) {
        lines.push("");
        lines.push(`截选 ${i + 1}：`);
        lines.push(text);
      }
    });
  }
  lines.push("");
  lines.push("注意：以上只是用于学习这位作者的语气与节奏，绝对不要把作者文章里出现过但和本次来源无关的事实、人名、数据搬过来。");
  return lines.join("\n");
}

// 各字段的「编辑手艺」要求。改写 / 创作两个 system prompt 共用，
// 单独抽出来避免两边漂移。只谈质量标准，不谈 JSON schema（schema 在各自 prompt 里）。
const CRAFT_QUALITY_RULES = [
  "各字段的质量标准（公众号编辑手艺）：",
  "- title / wechatTitleOptions：给 5 个表意清楚的备选标题，每个 ≤ 28 字；不必凑齐反常识、悬念等套路。title 取其中最准确的一个，不扩大事实范围。",
  "- subtitle：一句话补足 title 没说完的语境或立场，不复述 title 的字面。",
  "- lead：前两行决定读者是否读下去。先交代关键事实及其对象、时间和口径，禁止「今天我们来聊聊」「最近，XX 火了」这类热身式开场。",
  "- sections[].heading：用具体名词或有依据的判断，让只扫标题的读者也能拼出文章骨架；禁止「引言」「背景介绍」「总结」这类空壳标题。",
  "- sections[].quote：只放来源中有价值的原话；没有适合的引语时留空，不生造金句或引语。",
  "- closing：收在有依据的结论或明确的问题边界上；禁止「总之」「综上所述」「未来可期」「让我们拭目以待」。",
  "- keywords：3-6 个读者真的会搜的词（具体名词优先），不放「科技」「分析」这类大而空的词。"
].join("\n");

const DEFAULT_SYSTEM_PROMPT = [
  "你是一名资深微信公众号编辑，负责把网页内容改写成适合公众号发布的原创风格文章。",
  "必须遵守这些规则：",
  "1. 只基于提供的来源事实写作，不要编造数据、案例、引语、公司动作或人物观点。",
  "2. 允许重组结构、说明事实关系、提炼论点，但不要篡改原文结论。",
  "3. 语气要像成熟编辑，而不是模板化 AI 文案；避免「随着…的不断发展」「在当今时代」等套话。",
  "4. 输出必须是合法 JSON，且只输出 JSON，不要附加解释或 Markdown 代码块。",
  "5. JSON 字段必须包含 title、subtitle、lead、sections、closing、cta、wechatTitleOptions、keywords。",
  "6. 每个 section 必须包含 heading、paragraphs、bulletPoints、quote、imageRefs、codeBlocks、tables、mathBlocks。",
  "7. imageRefs 中每一项形如 {\"index\": 1, \"caption\": \"图注\"}，index 必须引用来源图片编号。",
  "8. codeBlocks 中每一项形如 {\"language\": \"python\", \"text\": \"...\"}；tables 形如 {\"headers\": [...], \"rows\": [[...], ...]}；mathBlocks 形如 {\"latex\": \"E=mc^2\", \"display\": true}。",
  "9. 若某个字段没有内容，请返回空字符串或空数组，不要省略字段。",
  "",
  CRAFT_QUALITY_RULES
].join("\n");

// 45th 续 · 「自拟主题创作」模式（source.origin === "brief"）专用 system prompt。
// 与改写模式的关键差异在第 1-2 条：改写要求"只基于来源事实、不得展开"，
// 创作则要求"以作者要点为骨架自由展开成文"——但防幻觉红线不放松：
// 具体数据 / 引语 / 公司动作必须来自作者素材，素材没有就不写。
// JSON schema 条目（4-9）与改写模式保持逐字一致，normalizeArticle 共用一套解析。
const CREATION_SYSTEM_PROMPT = [
  "你是一名资深微信公众号主笔，负责根据作者提供的主题与想法要点，撰写一篇适合公众号发布的原创文章。",
  "必须遵守这些规则：",
  "1. 以作者的主题和要点为骨架展开成文：可以补充论证、过渡、场景化描写，让要点立得住；但所有具体数据、统计数字、引语、公司动作、人物言论都必须来自作者提供的素材——素材里没有的不要编造，需要数据支撑时改用定性表述或自然带过。",
  "2. 作者要点之间允许重新排序、合并、取舍，但不得曲解或反转作者的观点立场。",
  "3. 语气要像成熟编辑，而不是模板化 AI 文案；避免「随着…的不断发展」「在当今时代」等套话。",
  "4. 输出必须是合法 JSON，且只输出 JSON，不要附加解释或 Markdown 代码块。",
  "5. JSON 字段必须包含 title、subtitle、lead、sections、closing、cta、wechatTitleOptions、keywords。",
  "6. 每个 section 必须包含 heading、paragraphs、bulletPoints、quote、imageRefs、codeBlocks、tables、mathBlocks。",
  "7. imageRefs 中每一项形如 {\"index\": 1, \"caption\": \"图注\"}，index 必须引用来源图片编号；没有可用图片素材时一律返回空数组。",
  "8. codeBlocks 中每一项形如 {\"language\": \"python\", \"text\": \"...\"}；tables 形如 {\"headers\": [...], \"rows\": [[...], ...]}；mathBlocks 形如 {\"latex\": \"E=mc^2\", \"display\": true}。",
  "9. 若某个字段没有内容，请返回空字符串或空数组，不要省略字段。",
  "",
  CRAFT_QUALITY_RULES
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

/**
 * 严格把"可能是字符串/可能是数值/可能是空"的值转成 number。
 * 用于 top_p / frequency_penalty / presence_penalty 等可选参数：
 *  - null / undefined / "" / "auto"      -> 返回 null，调用方应当跳过这个字段
 *  - 非数字字符串                          -> 返回 null
 *  - 合法数值                              -> 返回 Number 实例
 *
 * 不在这里做边界 clamp，由 LLM 服务端自己拒绝越界值；UI 已经在 options 页做范围校验。
 */
function numberOrNull(value) {
  if (value == null) return null;
  if (typeof value === "string" && value.trim() === "") return null;
  const num = Number(value);
  return Number.isFinite(num) ? num : null;
}

// 推理模型（OpenAI o1/o3/o4 系列、DeepSeek R1、Kimi k2.x、Claude thinking）会拒绝
// temperature / top_p / penalty / max_tokens 等"采样"类字段：
// 典型错误如 "Unsupported value: 'temperature'"、"only 1 is allowed for this model"、
// "max_tokens is not supported, use max_completion_tokens"。
// 命中这些关键词时去掉相关字段重试一次，让用户挑了推理模型也能跑通。
export const REASONING_PARAM_REJECTS =
  /temperature|top_p|max_tokens|max_completion_tokens|presence_penalty|frequency_penalty|response_format|only 1 is allowed/i;

/**
 * 把 OpenAI Chat Completions 请求体里推理模型不接受的字段剥掉。
 *
 * 推理模型通用规则：拒绝 temperature / top_p / penalty / response_format；
 * `max_tokens` 在 OpenAI o1 系列要换成 `max_completion_tokens`，但部分服务端
 * 同时认两者，所以保险起见两个字段都不下发，让模型用默认上限。
 */
export function stripReasoningRejectedFields(body) {
  const cleaned = { model: body.model, messages: body.messages };
  // 只保留确实安全的字段
  if (body.tools) cleaned.tools = body.tools;
  if (body.tool_choice) cleaned.tool_choice = body.tool_choice;
  if (body.stream != null) cleaned.stream = body.stream;
  return cleaned;
}

/**
 * 共享的 chat completions 调用：先按完整 body 发，命中推理模型 400 拒绝时
 * 自动剥掉采样参数重试一次。所有 AI 路径（改写 / 模板生成 / 去 AI 味 / 选题）共用。
 *
 * 调用方拿到 { response, payload }：response 是最终用于 ok 判断的那个，payload
 * 是已 parse 的 JSON。如果两次都失败，response 是第二次的；如果第一次就成功，
 * 就直接返回第一次的。
 */
export async function postChatCompletionWithReasoningFallback(
  apiUrl,
  apiKey,
  body,
  { signal } = {}
) {
  const headers = {
    "Content-Type": "application/json",
    Authorization: `Bearer ${String(apiKey || "").trim()}`
  };

  let response = await fetch(apiUrl, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
    signal
  });
  let payload = await response.json().catch(() => ({}));

  if (!response.ok && response.status === 400) {
    const errMsg = String(
      payload?.error?.message || payload?.error || payload?.message || ""
    );
    if (REASONING_PARAM_REJECTS.test(errMsg)) {
      const fallbackBody = stripReasoningRejectedFields(body);
      response = await fetch(apiUrl, {
        method: "POST",
        headers,
        body: JSON.stringify(fallbackBody),
        signal
      });
      payload = await response.json().catch(() => ({}));
    }
  }

  return { response, payload };
}

// 39th session · 平台 LLM 代理 · 是否走 worker 转发路径
// 2026-06-10 起 defaults.js 默认 aiSourceMode = "platform"（未上架无老用户包袱），
// 未显式选 byok 的用户走平台路径；显式选 byok 的走 BYOK（年费闸门见 requestRewrite）
function isPlatformMode(settings) {
  return settings?.aiSourceMode === "platform";
}

// 39th session · 平台 LLM 代理 · 通过润笔 worker 转发改写请求
// 与 BYOK 路径同样返回 normalizeArticle(extractJson(...))，调用方无感知差异
//
// 错误码契约（throw err with err.code）：
//   AUTH_REQUIRED                  · 没登录 / 没 JWT
//   AUTH_EXPIRED                   · 401 worker 返回（JWT 过期）
//   PLATFORM_QUOTA_EXCEEDED        · 402（本月额度用完，附 err.data.resets_at / limit / used）
//   PLATFORM_RATE_LIMITED          · 429（附 err.retryAfterMs）
//   PLATFORM_UNCONFIGURED          · 503（worker 缺 *_API_KEY secret 或上游不可用）
//   NETWORK / 普通 Error           · fetch 抛错或 4xx/5xx 通用情况
async function requestRewriteViaPlatform(settings, source, preferences, template, voiceSample, options = {}) {
  // 1. 取 JWT
  const authRecord = await getAuthRecord();
  const jwt = authRecord?.token;
  if (!jwt) {
    const err = new Error("请先登录润笔账户才能使用平台 AI（设置页 → 我的会员 → 登录）");
    err.code = "AUTH_REQUIRED";
    throw err;
  }

  // 2. 解析 tier · 优先 settings.platformTier，否则从 model id 后缀拆（"platform-economy" → "economy"），兜底 economy
  let tier = String(settings.platformTier || "").trim();
  if (!tier) {
    const m = String(settings.model || "").match(/^platform-([a-z]+)$/i);
    if (m) tier = m[1].toLowerCase();
  }
  if (!tier) tier = "economy";

  // 3. 拼 OpenAI-compatible body（messages + 采样参数完全复用 BYOK 同源逻辑）
  const messages = buildRewriteMessages(source, preferences, settings, template, voiceSample, options.thesisBrief || null);
  const temperatureSource =
    template && template.temperature != null && template.temperature !== ""
      ? template.temperature
      : settings.temperature;
  // 44th · 空串/NaN 保全：Number("")→0 会把「没填」变成显式 temperature=0（反例 #37 同族）
  const temperature =
    temperatureSource === "" || temperatureSource == null || Number.isNaN(Number(temperatureSource))
      ? 0.8
      : Number(temperatureSource);

  const body = { tier, temperature, messages };

  const topPSource =
    template && template.topP != null && template.topP !== ""
      ? template.topP
      : settings.topP;
  const topP = numberOrNull(topPSource);
  if (topP != null) body.top_p = topP;

  const freqSource =
    template && template.frequencyPenalty != null && template.frequencyPenalty !== ""
      ? template.frequencyPenalty
      : settings.frequencyPenalty;
  const freqPenalty = numberOrNull(freqSource);
  if (freqPenalty != null) body.frequency_penalty = freqPenalty;

  const presSource =
    template && template.presencePenalty != null && template.presencePenalty !== ""
      ? template.presencePenalty
      : settings.presencePenalty;
  const presPenalty = numberOrNull(presSource);
  if (presPenalty != null) body.presence_penalty = presPenalty;

  // 4. POST /api/llm/chat
  const apiBase = String(await getApiBase()).replace(/\/+$/, "");
  const url = `${apiBase}/api/llm/chat`;
  await ensureOptionalHostPermission(apiBase, "润笔平台 AI 接口");

  let response;
  try {
    response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${jwt}`
      },
      body: JSON.stringify(body),
      signal: options.abortSignal || undefined
    });
  } catch (netErr) {
    // 44th · 用户主动取消（CANCEL_TASK abort）不能伪装成网络错误——
    // 否则 withRetry 会重试 2 次，额度照扣
    if (netErr?.name === "AbortError") {
      const err = new Error("已取消改写");
      err.code = "CANCELLED";
      throw err;
    }
    const err = new Error(`平台 AI 网络错误：${netErr?.message || "未知"}`);
    err.code = "NETWORK";
    throw err;
  }

  // 5. 处理 worker 自有的特殊错误码（OpenAI-compatible 之外）
  if (response.status === 401) {
    const err = new Error("润笔账户登录已过期，请重新登录");
    err.code = "AUTH_EXPIRED";
    throw err;
  }
  if (response.status === 402) {
    const data = await response.json().catch(() => ({}));
    const err = new Error(data?.error || "本月平台 LLM 额度已用完，可升级会员获取更多额度");
    err.code = "PLATFORM_QUOTA_EXCEEDED";
    err.data = data;
    throw err;
  }
  if (response.status === 429) {
    const data = await response.json().catch(() => ({}));
    const err = new Error(data?.error || "请求过于频繁，请稍后再试");
    err.code = "PLATFORM_RATE_LIMITED";
    err.retryAfterMs = data?.retry_after_ms;
    throw err;
  }
  if (response.status === 503) {
    const data = await response.json().catch(() => ({}));
    const err = new Error(`平台 AI 暂不可用：${data?.error_code || data?.error || "服务商未配置"}`);
    err.code = "PLATFORM_UNCONFIGURED";
    throw err;
  }

  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    const errorMessage =
      payload?.error?.message ||
      payload?.error ||
      payload?.message ||
      `平台 AI 返回错误，状态码 ${response.status}`;
    throw new Error(errorMessage);
  }

  // 6. 解析 OpenAI-compatible 响应（与 BYOK 路径同 helper）
  const content = extractChatContent(payload);
  if (!content) {
    throw new Error("平台 AI 返回内容为空。" + diagnoseEmptyChatPayload(payload));
  }

  return normalizeArticle(extractJson(content), source, preferences);
}

/**
 * 39th 续 · Phase 3 · 平台 LLM 流式响应消费者。
 *
 * 与 requestRewriteViaPlatform 相同的 body / auth / tier 解析路径，但 POST 到 /api/llm/stream
 * 端点。客户端读 ReadableStream，按 SSE 协议解析每个 "data: {json}\n\n" event，
 * 累加 delta.content 到 finalText；末尾 [DONE] 时返回 normalizeArticle 结果（与非流式同 shape）。
 *
 * 进度回调 onProgress({ chars, tokens? })：每收到一个 delta event 触发，
 * 让 workspace 任务卡显示「已生成 1234 字 / 56 token」。
 *
 * 错误码契约与非流式一致：401/402/429/503 + AUTH_REQUIRED/...；流中途上游 error 透传。
 */
async function requestRewriteViaPlatformStreaming(settings, source, preferences, template, voiceSample, options = {}) {
  const onProgress = typeof options.onProgress === "function" ? options.onProgress : () => {};

  const authRecord = await getAuthRecord();
  const jwt = authRecord?.token;
  if (!jwt) {
    const err = new Error("请先登录润笔账户才能使用平台 AI（设置页 → 我的会员 → 登录）");
    err.code = "AUTH_REQUIRED";
    throw err;
  }

  let tier = String(settings.platformTier || "").trim();
  if (!tier) {
    const m = String(settings.model || "").match(/^platform-([a-z]+)$/i);
    if (m) tier = m[1].toLowerCase();
  }
  if (!tier) tier = "economy";

  const messages = buildRewriteMessages(source, preferences, settings, template, voiceSample, options.thesisBrief || null);
  const temperatureSource =
    template && template.temperature != null && template.temperature !== ""
      ? template.temperature
      : settings.temperature;
  // 44th · 空串/NaN 保全：Number("")→0 会把「没填」变成显式 temperature=0（反例 #37 同族）
  const temperature =
    temperatureSource === "" || temperatureSource == null || Number.isNaN(Number(temperatureSource))
      ? 0.8
      : Number(temperatureSource);
  const body = { tier, temperature, messages };
  const topPSource =
    template && template.topP != null && template.topP !== ""
      ? template.topP
      : settings.topP;
  const topP = numberOrNull(topPSource);
  if (topP != null) body.top_p = topP;
  const freqSource =
    template && template.frequencyPenalty != null && template.frequencyPenalty !== ""
      ? template.frequencyPenalty
      : settings.frequencyPenalty;
  const freqPenalty = numberOrNull(freqSource);
  if (freqPenalty != null) body.frequency_penalty = freqPenalty;
  const presSource =
    template && template.presencePenalty != null && template.presencePenalty !== ""
      ? template.presencePenalty
      : settings.presencePenalty;
  const presPenalty = numberOrNull(presSource);
  if (presPenalty != null) body.presence_penalty = presPenalty;

  const apiBase = String(await getApiBase()).replace(/\/+$/, "");
  const url = `${apiBase}/api/llm/stream`;
  await ensureOptionalHostPermission(apiBase, "润笔平台 AI 接口");

  let response;
  try {
    response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${jwt}`
      },
      body: JSON.stringify(body),
      signal: options.abortSignal || undefined
    });
  } catch (netErr) {
    if (netErr?.name === "AbortError") {
      const err = new Error("已取消改写");
      err.code = "CANCELLED";
      throw err;
    }
    const err = new Error(`平台 AI 网络错误：${netErr?.message || "未知"}`);
    err.code = "NETWORK";
    throw err;
  }

  // 错误响应（worker 的 401/402/429/503 + 上游透传错误）走 JSON body，不是 SSE
  if (!response.ok) {
    const data = await response.json().catch(() => ({}));
    if (response.status === 401) {
      const err = new Error("润笔账户登录已过期，请重新登录");
      err.code = "AUTH_EXPIRED";
      throw err;
    }
    if (response.status === 402) {
      const err = new Error(data?.error || "本月平台 LLM 额度已用完");
      err.code = "PLATFORM_QUOTA_EXCEEDED";
      err.data = data;
      throw err;
    }
    if (response.status === 429) {
      const err = new Error(data?.error || "请求过于频繁，请稍后再试");
      err.code = "PLATFORM_RATE_LIMITED";
      err.retryAfterMs = data?.retry_after_ms;
      throw err;
    }
    if (response.status === 503) {
      const err = new Error(`平台 AI 暂不可用：${data?.error_code || data?.error || "服务商未配置"}`);
      err.code = "PLATFORM_UNCONFIGURED";
      throw err;
    }
    throw new Error(data?.error || `平台 AI 流式响应错误 ${response.status}`);
  }

  // 读 SSE 流，累加 delta.content 直到 [DONE]
  const reader = response.body?.getReader?.();
  if (!reader) {
    throw new Error("平台 AI 不支持流式响应（fetch API 缺 ReadableStream）");
  }
  const decoder = new TextDecoder();
  let buffer = "";
  let finalContent = "";
  let lastTokens = 0;

  // 解析单个 SSE 事件块，累加 content / usage。同一帧里 delta 与 usage 合并成一次
  // onProgress（避免同帧连发两次导致 UI 字数/token 抖动）。
  const handleEvent = (ev) => {
    let changed = false;
    for (const line of ev.split("\n")) {
      if (!line.startsWith("data:")) continue;
      const data = line.slice(5).trim();
      if (!data || data === "[DONE]") continue;
      try {
        const json = JSON.parse(data);
        const delta = json?.choices?.[0]?.delta?.content || "";
        if (delta) {
          finalContent += delta;
          changed = true;
        }
        if (json?.usage?.completion_tokens) {
          lastTokens = Number(json.usage.completion_tokens) || 0;
          changed = true;
        }
      } catch {
        // 忽略单条 parse 失败，继续读
      }
    }
    if (changed) onProgress({ chars: finalContent.length, tokens: lastTokens });
  };

  while (true) {
    let chunk;
    try {
      chunk = await reader.read();
    } catch (readErr) {
      // 44th · CANCEL_TASK abort：fetch signal 触发后 read() 以 AbortError reject，
      // 转成 CANCELLED 防 withRetry 重跑（流式半途重试还会撞反例 #21）
      if (readErr?.name === "AbortError") {
        const err = new Error("已取消改写");
        err.code = "CANCELLED";
        throw err;
      }
      throw readErr;
    }
    const { value, done } = chunk;
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const events = buffer.split("\n\n");
    buffer = events.pop() || "";
    for (const ev of events) handleEvent(ev);
  }
  // flush：流结束后处理 buffer 残片（末尾事件可能无 \n\n 收尾）
  if (buffer.trim()) handleEvent(buffer);

  if (!finalContent) {
    throw new Error("平台 AI 流式返回内容为空");
  }
  return normalizeArticle(extractJson(finalContent), source, preferences);
}

export async function requestRewrite(settings, source, preferences, template, voiceSample = null, options = {}) {
  // 立论 pass（preferences.deepThesis 触发，多一次 AI 调用）：先想清楚再动笔。
  // 尽力而为——立论失败（解析/超时/额度）静默降级为普通改写，绝不阻塞主链路；
  // 取消信号（options.signal）原样透传，用户取消时立论也一起中断。
  let thesisBrief = null;
  if (preferences?.deepThesis) {
    options.onProgress?.({ phase: "thesis", current: 0, total: 1 });
    try {
      thesisBrief = await requestThesisBrief(settings, source, preferences, {
        signal: options.signal
      });
    } catch (err) {
      if (err?.name === "AbortError" || err?.code === "CANCELLED") throw err;
      thesisBrief = null;
    }
  }
  const optionsWithThesis = thesisBrief ? { ...options, thesisBrief } : options;

  // 39th session · 平台 LLM 代理分支（aiSourceMode === "platform"）
  if (isPlatformMode(settings)) {
    // 39th 续 · Phase 3 · 流式开关（settings.platformStreaming 默认 false）
    if (settings?.platformStreaming) {
      return requestRewriteViaPlatformStreaming(settings, source, preferences, template, voiceSample, optionsWithThesis);
    }
    return requestRewriteViaPlatform(settings, source, preferences, template, voiceSample, optionsWithThesis);
  }

  // 39th session · BYOK 闸门：年费独享
  // 仅当用户**主动**选 byok（aiSourceMode === "byok"）才闸；
  // 默认已是 platform（见 defaults.js），能走到这里的 byok 都是显式选择
  if (settings?.aiSourceMode === "byok") {
    const access = await checkLicense("ai.bringYourOwnKey");
    if (!access.ok) {
      const err = new Error(access.hint || "使用自定义 AI 接口需要年费会员，请前往会员中心升级");
      err.code = "LICENSE_BYOK_LOCKED";
      err.feature = access.feature;
      throw err;
    }
  }

  if (!settings.apiKey?.trim()) {
    throw new Error("请先在设置页填写 API Key，或在「AI 服务来源」选择免费的润笔平台 AI（无需 API Key）。");
  }

  if (!settings.apiBaseUrl?.trim()) {
    throw new Error("请先在设置页填写 API Base URL。");
  }

  const messages = buildRewriteMessages(
    source,
    preferences,
    settings,
    template,
    voiceSample,
    optionsWithThesis.thesisBrief || null
  );
  const model =
    String(template?.model || "").trim() || String(settings.model || "").trim();
  const temperatureSource =
    template && template.temperature != null && template.temperature !== ""
      ? template.temperature
      : settings.temperature;
  // 44th · 空串/NaN 保全：Number("")→0 会把「没填」变成显式 temperature=0（反例 #37 同族）
  const temperature =
    temperatureSource === "" || temperatureSource == null || Number.isNaN(Number(temperatureSource))
      ? 0.8
      : Number(temperatureSource);

  const body = {
    model,
    temperature,
    messages
  };

  // 透传 OpenAI 兼容的高级生成参数。
  // 优先级：模板覆盖值 > 用户全局设置；任意值非数值时跳过（保持 API 默认）。
  // 推荐去 AI 味档位：top_p 0.92 / frequency_penalty 0.5 / presence_penalty 0.3。
  const topPSource =
    template && template.topP != null && template.topP !== ""
      ? template.topP
      : settings.topP;
  const topP = numberOrNull(topPSource);
  if (topP != null) body.top_p = topP;

  const freqSource =
    template && template.frequencyPenalty != null && template.frequencyPenalty !== ""
      ? template.frequencyPenalty
      : settings.frequencyPenalty;
  const freqPenalty = numberOrNull(freqSource);
  if (freqPenalty != null) body.frequency_penalty = freqPenalty;

  const presSource =
    template && template.presencePenalty != null && template.presencePenalty !== ""
      ? template.presencePenalty
      : settings.presencePenalty;
  const presPenalty = numberOrNull(presSource);
  if (presPenalty != null) body.presence_penalty = presPenalty;

  const apiUrl = settings.apiBaseUrl.trim();
  await ensureOptionalHostPermission(apiUrl, "AI 改写接口");

  let response, payload;
  try {
    ({ response, payload } = await postChatCompletionWithReasoningFallback(
      apiUrl,
      settings.apiKey,
      body,
      options.abortSignal ? { signal: options.abortSignal } : {}
    ));
  } catch (fetchErr) {
    if (fetchErr?.name === "AbortError") {
      const err = new Error("已取消改写");
      err.code = "CANCELLED";
      throw err;
    }
    throw fetchErr;
  }

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

/**
 * 40th 续 · AI 合规改写（付费）：把正文里命中的违规/限流表达改写成合规说法。
 * 与 requestRewrite 复用同一套平台 / BYOK 路由，但只改正文、返回纯 HTML（不重写标题/摘要）。
 *
 * @param {object} settings
 * @param {string} bodyHtml   当前文章正文 HTML
 * @param {string[]} terms    命中的违规词（用于提示模型重点处理）
 * @returns {Promise<string>} 改写后的正文 HTML（调用方需再 sanitize 后写回编辑器）
 */
export async function requestComplianceRewrite(settings, bodyHtml, terms = []) {
  const html = String(bodyHtml || "").trim();
  if (!html) throw new Error("正文为空，无需合规改写。");

  const termList = Array.isArray(terms) ? terms.filter(Boolean).slice(0, 60) : [];
  const sys =
    "你是公众号合规编辑。请把下面这篇文章正文里**可能违规或被平台限流**的表达改写成合规说法，" +
    "包括但不限于：广告法绝对化用语（最/第一/国家级/100% 等）、诱导关注/加微信/导流、" +
    "夸大医疗或金融承诺、低俗或违法表述。" +
    "严格要求：① 保持原意、风格、段落结构和篇幅基本不变；② 不要新增事实或观点；" +
    "③ 不要删除正文图片、标题层级等结构；④ 直接输出改写后的**正文 HTML**，" +
    "不要输出 JSON、markdown 代码块或任何解释说明。" +
    (termList.length ? `\n\n本地已标出的可疑词（重点处理，但不限于这些）：${termList.join("、")}` : "");
  const messages = [
    { role: "system", content: sys },
    { role: "user", content: html }
  ];
  const content = await requestPlainChat(settings, messages, {
    temperature: 0.4,
    context: "AI 合规改写接口"
  });
  return stripCodeFence(content);
}

// 去掉模型偶尔包裹的 ```html ... ``` 代码块围栏
function stripCodeFence(text) {
  let s = String(text || "").trim();
  s = s.replace(/^```[a-zA-Z]*\s*/, "").replace(/\s*```$/, "");
  return s.trim();
}

/**
 * 通用单轮 chat（复用平台 /api/llm/chat 与 BYOK 两条路由 + 统一错误码），返回 content 字符串。
 * 给「AI 合规改写 / 第二模型评审 / 深度去 AI 味重写 / AI 选题总监」等一次性任务复用，
 * 避免各处重复路由代码（反例 #36：任何 AI 入口都必须按 aiSourceMode 分流，不能只认 apiKey）。
 *
 * options.signal：AbortSignal，调用方可用它做超时中断；中断时抛 AbortError 原样透传。
 * 空响应统一抛 err.code = "AI_EMPTY_RESPONSE"，并附 diagnoseEmptyChatPayload 诊断线索，
 * 让调用方能区分「值得重试的空响应」与鉴权/配额类硬错误。
 */
export async function requestPlainChat(settings, messages, { temperature = 0.5, context = "AI 接口", signal } = {}) {
  if (isPlatformMode(settings)) {
    const authRecord = await getAuthRecord();
    const jwt = authRecord?.token;
    if (!jwt) {
      const err = new Error("请先登录润笔账户才能使用平台 AI（设置页 → 我的会员 → 登录）");
      err.code = "AUTH_REQUIRED";
      throw err;
    }
    let tier = String(settings.platformTier || "").trim();
    if (!tier) {
      const m = String(settings.model || "").match(/^platform-([a-z]+)$/i);
      if (m) tier = m[1].toLowerCase();
    }
    if (!tier) tier = "economy";

    const apiBase = String(await getApiBase()).replace(/\/+$/, "");
    await ensureOptionalHostPermission(apiBase, "润笔平台 AI 接口");
    let response;
    try {
      response = await fetch(`${apiBase}/api/llm/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${jwt}` },
        body: JSON.stringify({ tier, temperature, messages }),
        signal
      });
    } catch (netErr) {
      if (netErr?.name === "AbortError") throw netErr;
      const err = new Error(`平台 AI 网络错误：${netErr?.message || "未知"}`);
      err.code = "NETWORK";
      throw err;
    }
    if (response.status === 401) {
      const err = new Error("润笔账户登录已过期，请重新登录");
      err.code = "AUTH_EXPIRED";
      throw err;
    }
    if (response.status === 402) {
      const data = await response.json().catch(() => ({}));
      const err = new Error(data?.error || "本月平台 LLM 额度已用完");
      err.code = "PLATFORM_QUOTA_EXCEEDED";
      err.data = data;
      throw err;
    }
    if (response.status === 429) {
      const data = await response.json().catch(() => ({}));
      const err = new Error(data?.error || "请求过于频繁，请稍后再试");
      err.code = "PLATFORM_RATE_LIMITED";
      throw err;
    }
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      throw new Error(payload?.error?.message || payload?.error || `平台 AI 返回错误 ${response.status}`);
    }
    const content = extractChatContent(payload);
    if (!content) {
      const err = new Error("平台 AI 返回内容为空。" + diagnoseEmptyChatPayload(payload));
      err.code = "AI_EMPTY_RESPONSE";
      throw err;
    }
    return content;
  }

  // BYOK 模式
  if (!settings.apiKey?.trim() || !settings.apiBaseUrl?.trim()) {
    throw new Error("请先在设置页填写 API Key 和接口地址。");
  }
  const apiUrl = settings.apiBaseUrl.trim();
  await ensureOptionalHostPermission(apiUrl, context);
  const model = String(settings.model || "").trim();
  const { response, payload } = await postChatCompletionWithReasoningFallback(apiUrl, settings.apiKey, {
    model,
    temperature,
    messages
  }, { signal });
  if (!response.ok) {
    throw new Error(payload?.error?.message || payload?.message || `AI 接口返回错误 ${response.status}`);
  }
  const content = extractChatContent(payload);
  if (!content) {
    const err = new Error("AI 返回内容为空。" + diagnoseEmptyChatPayload(payload));
    err.code = "AI_EMPTY_RESPONSE";
    throw err;
  }
  return content;
}

/**
 * 第二模型评审（LLM-as-judge）：让模型扮演「AI 检测审稿员」，从语义/论证/句式层
 * 找出本地正则 lint 抓不到的 AI 味，返回结构化评分 + 具体问题点。
 *
 * @returns {Promise<{score:number, verdict:string, findings:Array<{excerpt:string, reason:string}>}>}
 *   score：0-100，编辑对清晰度及论证的主观评价，不代表作者身份或事实核验
 */
export async function requestHumanizeJudge(settings, bodyHtml) {
  const text = stripHtmlToPlain(bodyHtml);
  if (!text) throw new Error("正文为空，无法评审。");
  const sys = [
    "你是一位中文编辑，检查文章是否容易理解、论证是否成立。不要推断作者是不是 AI，也不按检测器套路给分。",
    "优先检查：",
    "- 主语或指代不清、残句、比喻无法还原具体意思、术语未解释。",
    "- 数据遗漏对象/年份/分母，跨人群跨年份直接比较，把相关性写成因果。",
    "- 结论超出文中证据；强行反转、虚构反方、由少量数据推出长期建议。",
    "- 反复口头禅、空泛金句、重复结论、标题与正文不一致。",
    "客观语气、正常列举、长短句均匀本身不是问题；合理的不确定性不扣分。你没有外部核验材料，只能指出证据不足，不能宣称事实已经核实。",
    "每条问题必须引用原文并解释具体理解障碍；不得仅以“像AI”或“缺少情绪”为理由。",
    "只输出合法 JSON，不要解释、不要 markdown 代码块：",
    '{ "score": 0到100整数(越高越清晰且论证充分，不是作者身份概率), "verdict": "一句话总评<=40字", "findings": [ { "excerpt": "有问题的原文片段<=40字", "reason": "具体问题及修改方向<=60字" } ] }',
    "findings 最多 8 条，优先语义和论证问题；没有具体问题可为空。"
  ].join("\n");
  const content = await requestPlainChat(
    settings,
    [
      { role: "system", content: sys },
      { role: "user", content: text.slice(0, 8000) }
    ],
    { temperature: 0.2, context: "AI 味评审接口" }
  );
  const parsed = extractJson(content) || {};
  const score = Math.max(0, Math.min(100, Math.round(Number(parsed.score) || 0)));
  const findings = Array.isArray(parsed.findings)
    ? parsed.findings
        .map((f) => ({
          excerpt: String(f?.excerpt || "").slice(0, 60),
          reason: String(f?.reason || "").slice(0, 50)
        }))
        .filter((f) => f.excerpt)
        .slice(0, 8)
    : [];
  return { score, verdict: String(parsed.verdict || "").slice(0, 60), findings };
}

/**
 * 金句提炼：从正文里挑出 3-5 句最适合做成「金句卡片」在朋友圈 / 小红书传播的句子。
 * 走 requestPlainChat —— 自动复用平台 LLM（按 plan 走配额）或用户自配 Key（BYOK），
 * 与主改写 / 去 AI 味同一套接口体系，无需另接 DeepSeek key。
 *
 * @param {object} settings 用户设置（同 requestRewrite）
 * @param {string} bodyHtmlOrText 正文 HTML 或纯文本
 * @param {object} [opts] { max = 5 }
 * @returns {Promise<string[]>} 金句数组（已去重、按长度裁剪）
 */
export async function requestPunchlines(settings, bodyHtmlOrText, { max = 5 } = {}) {
  const text = stripHtmlToPlain(bodyHtmlOrText);
  if (!text) throw new Error("正文为空，无法提炼金句。");
  const sys = [
    "你是公众号 / 小红书金句提炼专家。从给定文章里挑出最适合做成「金句卡片」传播的句子。",
    "要求：",
    "1. 每句 10-30 字，独立成立、有观点或情绪、读者愿意转发收藏。",
    "2. 可对原句做轻微凝练、去掉指代词让它能脱离上下文独立成立，但不得改变原意、不得编造文中没有的信息。",
    "3. 优先挑「金句感」强的：有反差、有判断、有画面感、能戳中痛点的句子，避免选平铺直叙的过渡句。",
    "4. 不要选含有具体人名 / 链接 / 第几段「上文」之类离开文章就读不懂的句子。",
    `5. 最多 ${Math.max(1, Math.min(8, max))} 句，宁缺毋滥，按金句感从强到弱排序。`,
    "只输出合法 JSON，不要解释、不要 markdown 代码块：",
    '{ "punchlines": ["金句1", "金句2", "金句3"] }'
  ].join("\n");
  const content = await requestPlainChat(
    settings,
    [
      { role: "system", content: sys },
      { role: "user", content: text.slice(0, 8000) }
    ],
    { temperature: 0.8, context: "金句提炼接口" }
  );
  const parsed = extractJson(content) || {};
  const raw = Array.isArray(parsed.punchlines) ? parsed.punchlines : [];
  const seen = new Set();
  const out = [];
  for (const item of raw) {
    const s = String(item || "").trim().replace(/^[「"'']+|[」"'']+$/g, "").trim();
    if (!s || s.length < 4) continue;
    if (seen.has(s)) continue;
    seen.add(s);
    out.push(s.slice(0, 40));
    if (out.length >= Math.max(1, Math.min(8, max))) break;
  }
  return out;
}

/**
 * 吸睛封面标题：从正文里生成 5-6 个适合做成「封面卡片」的抓眼球标题。
 * 每个标题附带钩子类型标签（痛点型 / 反直觉 / 数字型等），供封面卡片顶部徽章展示。
 * 走 requestPlainChat 复用平台/BYOK 双路由（反例 #36）。
 *
 * @param {object} settings 用户设置
 * @param {string} bodyHtmlOrText 正文 HTML 或纯文本
 * @param {object} [opts] { max = 6 }
 * @returns {Promise<Array<{title:string, hook:string}>>}
 */
export async function requestCoverTitles(settings, bodyHtmlOrText, { max = 6 } = {}) {
  const text = stripHtmlToPlain(bodyHtmlOrText);
  if (!text) throw new Error("正文为空，无法生成封面标题。");
  const cap = Math.max(3, Math.min(8, max));
  const sys = [
    "你是公众号 / 小红书爆款标题专家。从给定文章里生成最适合做成「封面卡片」的吸睛标题。",
    "要求：",
    "1. 每个标题 12-24 字，独立成立、有点击欲，适合印在封面图上。",
    "2. 标题必须忠于文章核心观点，不得编造文中没有的事实、数据或结论。",
    "3. 钩子类型 hook 从以下选：痛点型、反直觉、数字型、故事型、悬念型、对比型、共鸣型。",
    "4. 5-6 个标题风格要多样，避免句式雷同；按吸睛程度从强到弱排序。",
    "5. 不要写「震惊」「必看」等廉价词，用信息密度和角度取胜。",
    `6. 最多 ${cap} 个，宁缺毋滥。`,
    "只输出合法 JSON，不要解释、不要 markdown 代码块：",
    '{ "titles": [{ "title": "吸睛标题", "hook": "反直觉" }, ...] }'
  ].join("\n");
  const content = await requestPlainChat(
    settings,
    [
      { role: "system", content: sys },
      { role: "user", content: text.slice(0, 8000) }
    ],
    { temperature: 0.85, context: "封面标题接口" }
  );
  const parsed = extractJson(content) || {};
  const raw = Array.isArray(parsed.titles) ? parsed.titles : [];
  const seen = new Set();
  const out = [];
  for (const item of raw) {
    const title = String(item?.title || item || "")
      .trim()
      .replace(/^[「"'']+|[」"'']+$/g, "")
      .trim();
    if (!title || title.length < 6) continue;
    if (seen.has(title)) continue;
    seen.add(title);
    const hook = String(item?.hook || "").trim().replace(/型$/, "").slice(0, 8);
    out.push({ title: title.slice(0, 36), hook });
    if (out.length >= cap) break;
  }
  return out;
}

/**
 * 逻辑链漫画拆解：把正文（或话题）拆成一张「逻辑链漫画信息图」的结构化数据，
 * 供 comic-prompt.js buildComicPrompt() 拼出可直接投喂文生图模型的中文 prompt。
 * 移植自 prompt-forge，走 requestPlainChat 复用平台/BYOK 双路由（反例 #36）。
 *
 * @param {object} settings 用户设置（同 requestRewrite）
 * @param {string} bodyHtmlOrText 正文 HTML / 纯文本 / 话题短句
 * @param {object} [opts] { template = "auto", signal }
 * @returns {Promise<object>} 结构化数据（已过 repairComicData 归一化）
 */
export async function requestComicChain(settings, bodyHtmlOrText, { template = "auto", signal } = {}) {
  const text = stripHtmlToPlain(bodyHtmlOrText);
  if (!text) throw new Error("正文为空，无法拆解逻辑链。");
  const sys = [
    "你是一位「逻辑链漫画信息图」结构化设计助手。",
    "你的任务是把用户给出的【文章内容】提炼成一张可视化逻辑链漫画的结构化数据，并选择最合适的布局模板。",
    "",
    "# 可选模板（4 种）",
    "1. circular（环形闭环）：6-8 个节点围成圆，中心放代表\"应对力量\"的吉祥物。适用于因果循环、闭环逻辑、恶性循环类话题。",
    "2. horizontal（横向 Stage）：Stage 1→2→3→4 横向流转，每个 Stage 一张大卡片。适用于传导链路、数据传导、A→B→C 的过程。",
    "3. matrix（矩阵分层）：多行多列，每行是一个逻辑层级（如根因→传导→症状→恶性循环）。适用于多维度深度分析、复杂系统问题。",
    "4. columns（多列分组）：多个 Stage 列，每列纵向堆叠多张卡片。适用于改革举措、方案对比、问题→举措→效果→目标。",
    "",
    "# 选择规则",
    template === "auto"
      ? "- 请根据文章的逻辑特征自选最合适的模板。"
      : `- 用户已指定模板：${template}，请直接使用它。`,
    "- 节点数量建议：circular 6-8 个；horizontal 3-5 个 Stage；matrix 3-4 行每行 2-4 节点；columns 3-4 列每列 2-4 卡片。",
    "",
    "# 必须遵守",
    "- 节点文字必须简洁（2-12 字），像信息图标签，不是句子。",
    "- 每个节点要提供 scene 画面提示（8-30 字，描述卡通插画该画什么：角色、表情、道具、动作）。",
    "- 所有节点内容必须来自文章本身，不得编造文章没有的事实、数字或结论。",
    "- 中心吉祥物 / 应对块要呼应文章主题（经济类用猫头鹰撑伞、科技类用 AI 机器人、健康类用医生熊猫等）。",
    "- 标题要朗朗上口，带\"逻辑链 / 闭环 / 传导链\"等词汇。",
    "- 所有文本必须是简体中文。",
    "- 严格按 JSON Schema 输出，不要任何额外解释、不要 markdown 代码块包裹。",
    "",
    "# 输出 JSON Schema（按所选 template 输出对应结构）",
    '// circular: { "template": "circular", "title": "string", "nodes": [{ "text": "string", "scene": "string" }], "centerRole": "string", "centerKeywords": ["string"], "loopDescription": "string" }',
    '// horizontal: { "template": "horizontal", "title": "string", "stages": [{ "stageTitle": "string", "nodeText": "string", "scene": "string" }] }',
    '// matrix: { "template": "matrix", "title": "string", "rows": [{ "layerName": "string", "layerHint": "string", "nodes": [{ "text": "string", "scene": "string" }] }], "policyTitle": "string", "policyItems": ["string"] }',
    '// columns: { "template": "columns", "title": "string", "columns": [{ "stageTitle": "string", "stageHint": "string", "nodes": [{ "text": "string", "scene": "string" }] }], "footerNote": "string" }'
  ].join("\n");
  const content = await requestPlainChat(
    settings,
    [
      { role: "system", content: sys },
      { role: "user", content: `文章内容：\n${text.slice(0, 8000)}\n\n请严格按 JSON Schema 输出对应模板的结构化数据。` }
    ],
    { temperature: 0.7, context: "逻辑链漫画拆解接口", signal }
  );
  return repairComicData(extractJson(content));
}

/**
 * 贴图种草文案：根据编辑台正文（+ 可选的逻辑链结构概览 / 自动标签）直接生成
 * 小红书标题 / 正文 / 公众号导语 / 话题标签 / 封面文字，配合金句卡片或逻辑链漫画贴图发布。
 *
 * 与 prompt-forge 的差异：原仓库只拼「社媒 agent prompt」让用户复制去别处跑；
 * 本扩展自带 AI 双路由（requestPlainChat，反例 #36），直接出成品文案。
 *
 * @param {object} settings 用户设置（同 requestRewrite）
 * @param {string} bodyHtmlOrText 正文 HTML 或纯文本
 * @param {object} [opts] { outline = "", tags = [], signal }
 * @returns {Promise<{titles:string[], post:string, gzhIntro:string, hashtags:string[], covers:string[]}>}
 */
export async function requestSocialPost(settings, bodyHtmlOrText, { outline = "", tags = [], signal } = {}) {
  const text = stripHtmlToPlain(bodyHtmlOrText);
  if (!text) throw new Error("正文为空，无法生成种草文案。");
  const sys = [
    "你是一名小红书 / 公众号种草文案专家。请基于给定的文章内容（和可选的逻辑链信息图结构），生成配合贴图发布的中文种草/科普文案。",
    "要求：",
    "1. 所有内容必须来自文章本身，不得编造文章没有的事实、数据、机构或结论；需要事实支撑时用「可能」「值得关注」等表达。",
    "2. titles：5 个小红书标题，每个 12-24 字，有点击欲但不夸张（数字型、反直觉型、痛点型、故事型混搭）。",
    "3. post：1 篇小红书正文，结构为开头钩子 + 逻辑拆解 + 读者启发 + 互动提问，总字数 300-600 字，语气自然、有信息密度，适合配合贴图发布。",
    "4. gzhIntro：1 个更适合公众号长文开头的导语版本，100-180 字。",
    "5. hashtags：12-18 个话题标签，混合垂类词、情绪词、场景词，不带 # 号。",
    "6. covers：3 组封面文字建议，每组不超过 16 字。",
    "只输出合法 JSON，不要解释、不要 markdown 代码块：",
    '{ "titles": ["…"], "post": "…", "gzhIntro": "…", "hashtags": ["…"], "covers": ["…"] }'
  ].join("\n");
  const user = [
    outline ? `逻辑链信息图结构（文案要与贴图内容呼应）：\n${outline}` : "",
    tags.length ? `已有自动标签（可参考补充）：${tags.map((t) => `#${t}`).join(" ")}` : "",
    `文章内容：\n${text.slice(0, 8000)}`
  ]
    .filter(Boolean)
    .join("\n\n");
  const content = await requestPlainChat(
    settings,
    [
      { role: "system", content: sys },
      { role: "user", content: user }
    ],
    { temperature: 0.8, context: "种草文案接口", signal }
  );
  const parsed = extractJson(content) || {};
  const strList = (v, max, itemMax) =>
    (Array.isArray(v) ? v : [])
      .map((s) => String(s || "").trim().replace(/^#+/, ""))
      .filter(Boolean)
      .slice(0, max)
      .map((s) => s.slice(0, itemMax));
  const result = {
    titles: strList(parsed.titles, 5, 40),
    post: String(parsed.post || "").trim(),
    gzhIntro: String(parsed.gzhIntro || "").trim(),
    hashtags: strList(parsed.hashtags, 18, 20),
    covers: strList(parsed.covers, 3, 20)
  };
  if (!result.post && !result.titles.length) {
    const err = new Error("AI 没有返回可用的种草文案，请重试。");
    err.code = "AI_EMPTY_RESPONSE";
    throw err;
  }
  return result;
}

/**
 * 立论 pass（成稿前的前置分析调用）：从来源素材里提炼「核心判断 + 论证链 + 反方观点 +
 * 代价分析 + 可验证推断」骨架，供 buildRewriteMessages 注入成稿 prompt。
 *
 * 设计约束：
 *   - 这是**尽力而为**的增强：任何失败（解析/超时/额度）都应由调用方降级为普通改写，
 *     绝不阻塞主链路（requestRewrite 内部已 try-catch）。
 *   - 走 requestPlainChat 复用平台/BYOK 双路由（反例 #36）。
 *   - 温度偏低（0.4）：立论要的是想清楚，不是文采。
 *
 * @returns {Promise<{thesis:string, angle:string, argumentChain:string[], counterView:string, stakes:string, forecast:string}|null>}
 *   所有字段都可能为空串；thesis 为空时返回 null（骨架没立起来不如不注入）。
 */
export async function requestThesisBrief(settings, source, preferences = {}, { signal } = {}) {
  const snapshot = createSourceSnapshot(source);
  const sys = [
    "你是一位以判断力著称的中文主编。在动笔写公众号文章之前，先完成立论——想清楚这篇文章到底要说什么。",
    "",
    INSIGHT_PRESSURE_RULES,
    "",
    "事实约束：立论只能基于给定素材，不得编造数据、引语或事件；素材撑不起的判断宁可收窄。",
    "只输出合法 JSON，不要解释、不要 markdown 代码块：",
    '{ "thesis": "一句话核心判断，<=60字，必须可被反驳", "angle": "切入角度<=30字", "argumentChain": ["论证步骤1", "论证步骤2", "论证步骤3"], "counterView": "最强反方观点及文章如何回应<=80字", "stakes": "这个判断的代价与输家<=60字", "forecast": "12-18个月可验证推断<=60字" }',
    "argumentChain 3-5 步；某字段素材不足时给空字符串，不要硬编。"
  ].join("\n");
  const user = [
    preferences.angle ? `作者期望的切入方向（优先尊重）：${preferences.angle}` : "",
    "素材（已结构化）：",
    JSON.stringify(snapshot, null, 2).slice(0, 9000)
  ]
    .filter(Boolean)
    .join("\n");
  const content = await requestPlainChat(
    settings,
    [
      { role: "system", content: sys },
      { role: "user", content: user }
    ],
    { temperature: 0.4, context: "立论分析接口", signal }
  );
  const parsed = extractJson(content) || {};
  const thesis = String(parsed.thesis || "").trim().slice(0, 80);
  if (!thesis) return null;
  return {
    thesis,
    angle: String(parsed.angle || "").trim().slice(0, 50),
    argumentChain: (Array.isArray(parsed.argumentChain) ? parsed.argumentChain : [])
      .map((s) => String(s || "").trim().slice(0, 80))
      .filter(Boolean)
      .slice(0, 5),
    counterView: String(parsed.counterView || "").trim().slice(0, 120),
    stakes: String(parsed.stakes || "").trim().slice(0, 90),
    forecast: String(parsed.forecast || "").trim().slice(0, 90)
  };
}

/**
 * 思想密度评审（LLM-as-judge，内容层）：与 requestHumanizeJudge（形式层）平行——
 * 那边找「像 AI 写的」，这边找「平庸/骑墙/正确的废话」。本地 lintInsight 的命中
 * 直接列给模型当已知靶子，让它把额度花在语义层的平庸上。
 *
 * @returns {Promise<{score:number, verdict:string, findings:Array<{excerpt:string, kind:string, reason:string, fix:string}>}>}
 *   score 0-100 越高思想密度越高。
 */
export async function requestInsightJudge(settings, bodyHtml) {
  const text = stripHtmlToPlain(bodyHtml);
  if (!text) throw new Error("正文为空，无法评审。");
  const localHits = lintInsight(text).hits.slice(0, 6);
  const localLines = localHits.length
    ? "本地规则已命中的平庸句式（无需重复报告，找它们之外的问题）：\n" +
      localHits.map((h) => `- ${h.label}：「${h.excerpt}」`).join("\n")
    : "";
  const sys = [
    "你是一位以挑剔著称的中文主编，专门枪毙「四平八稳但毫无观点」的稿子。",
    "评审下面这篇公众号文章的**思想密度**——不看文笔，只看有没有真判断。重点找：",
    "- 正确的废话：删掉后文章毫无损失的句子（「值得关注」「有待观察」「双刃剑」）",
    "- 骑墙：摆完两边观点不下判断，或用「辩证看待」「见仁见智」逃避表态",
    "- 无代价判断：只说好处不说代价和输家的观点（那是口号不是判断）",
    "- 伪具体：看似有细节实际不可验证（「不少专家」「大量案例」「显著提升」）",
    "- 缺主轴：全文没有一个可被反驳的核心判断，只是信息罗列",
    localLines,
    "只输出合法 JSON，不要解释、不要 markdown 代码块：",
    '{ "score": 0到100整数(越高思想密度越高), "verdict": "一句话总评<=40字", "findings": [ { "excerpt": "有问题的原文片段<=40字", "kind": "废话|骑墙|无代价|伪具体|缺主轴", "reason": "为什么平庸<=30字", "fix": "改成什么样的判断<=50字" } ] }',
    "findings 最多 6 条挑最致命的；fix 必须是具体的改法而不是「加强观点」这类空话。"
  ]
    .filter(Boolean)
    .join("\n");
  const content = await requestPlainChat(
    settings,
    [
      { role: "system", content: sys },
      { role: "user", content: text.slice(0, 8000) }
    ],
    { temperature: 0.3, context: "思想密度评审接口" }
  );
  const parsed = extractJson(content) || {};
  const score = Math.max(0, Math.min(100, Math.round(Number(parsed.score) || 0)));
  const findings = Array.isArray(parsed.findings)
    ? parsed.findings
        .map((f) => ({
          excerpt: String(f?.excerpt || "").slice(0, 60),
          kind: String(f?.kind || "").slice(0, 10),
          reason: String(f?.reason || "").slice(0, 50),
          fix: String(f?.fix || "").slice(0, 80)
        }))
        .filter((f) => f.excerpt)
        .slice(0, 6)
    : [];
  return { score, verdict: String(parsed.verdict || "").slice(0, 60), findings };
}

/**
 * 思想密度重写：拿评审 findings（含 fix 建议）当靶子，定向把平庸段落改成有判断的段落。
 * 与 requestDeepHumanizeRewrite 的关键差异：那边不许动事实和结论，这边**允许把骑墙改成
 * 表态**（这正是目的），但新表态必须由文中已有事实支撑，不得引入新事实。
 */
export async function requestInsightRewrite(settings, bodyHtml, findings = []) {
  const html = String(bodyHtml || "").trim();
  if (!html) throw new Error("正文为空，无需改写。");
  const findingLines = (Array.isArray(findings) ? findings : [])
    .slice(0, 6)
    .map((f, i) => `${i + 1}. [${f.kind || "平庸"}]「${f.excerpt}」—— ${f.reason}${f.fix ? `；改法：${f.fix}` : ""}`)
    .join("\n");
  const sys = [
    "你是一位以判断力著称的中文主编，任务是把一篇「四平八稳」的稿子改得有思想。",
    "整体重写下面这篇公众号正文，重点消灭主编指出的平庸段落：把骑墙改成明确表态、",
    "把正确的废话删掉或换成具体判断、给只讲好处的观点补上代价和输家。",
    "",
    INSIGHT_PRESSURE_RULES,
    "",
    "严格边界：① 新的表态和判断必须由文中已有事实支撑——不得新增数据、引语、人名、案例；",
    "② 图片、代码、表格、小标题层级一律保留原样；③ 篇幅 ±15% 以内；",
    "④ 保持原有语言风格与节奏（这次改的是思想不是文风）；",
    "⑤ 直接输出重写后的正文 HTML，不要 JSON / markdown 代码块 / 任何解释。",
    findingLines ? `\n主编指出的平庸点（务必逐条处理）：\n${findingLines}` : ""
  ].join("\n");
  const content = await requestPlainChat(
    settings,
    [
      { role: "system", content: sys },
      { role: "user", content: html }
    ],
    { temperature: 0.6, context: "思想密度重写接口" }
  );
  return stripCodeFence(content);
}

/**
 * 深度去 AI 味重写：拿评审 findings 当「靶子」，让模型整体重写正文去掉这些 AI 痕迹，
 * 保留事实/结构/篇幅。返回正文 HTML（调用方 sanitize 后写回）。
 */
export async function requestDeepHumanizeRewrite(settings, bodyHtml, findings = []) {
  const html = String(bodyHtml || "").trim();
  if (!html) throw new Error("正文为空，无需改写。");
  const findingLines = (Array.isArray(findings) ? findings : [])
    .slice(0, 8)
    .map((f, i) => `${i + 1}. 「${f.excerpt}」—— ${f.reason}`)
    .join("\n");
  const sys = [
    "你是一名中文编辑。请针对下面的问题修改正文，让意思清楚、论证连贯；通顺的句子保留，不为追求变化整体换词。",
    EDITORIAL_RULES,
    "你只有当前稿件，不能重新核实来源。对无法补证的推断收窄措辞或明确其不确定性；不编造新证据。",
    "严格要求：① 事实、数据、人名、产品名、引号内文字、列表项、代码、表格、图片一律不得新增或删减；",
    "② 保持原文的小标题层级与篇幅（±15% 以内）；③ 直接输出重写后的正文 HTML，不要 JSON / markdown 代码块 / 任何解释。",
    findingLines ? `\n审稿员指出的重点 AI 痕迹（务必改掉）：\n${findingLines}` : ""
  ].join("\n");
  const content = await requestPlainChat(
    settings,
    [
      { role: "system", content: sys },
      { role: "user", content: html }
    ],
    { temperature: 0.4, context: "深度去 AI 味接口" }
  );
  return stripCodeFence(content);
}

// 纯文本提取（去标签），给评审用；不依赖 DOMParser（页面侧调用，但保持纯函数）
function stripHtmlToPlain(html) {
  return String(html || "")
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<\/(p|div|h[1-6]|li|tr|blockquote|section)\s*>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/**
 * 平台 AI 连通性测试（aiSourceMode === "platform"）。
 *
 * 平台模式不需要用户填 API Key——鉴权靠润笔账户 JWT。这里打 GET /api/llm/usage：
 *   - 校验登录态（没 JWT / 401 → 引导登录）
 *   - 验证 worker 可达
 *   - 顺带回报当月剩余额度，让用户一眼知道"免费版也能用、还剩多少次"
 *
 * 反例修正：测试连接按钮平台/BYOK 共用，旧逻辑一律走 BYOK 校验，导致平台模式
 * 也提示"请先填写 API Key"，让免费用户误以为不充 Key 就用不了平台 AI。
 */
export async function testPlatformAiConnection() {
  const startedAt = Date.now();
  const authRecord = await getAuthRecord();
  const jwt = authRecord?.token;
  if (!jwt) {
    return createAiTestFailure(
      "请先登录润笔账户才能使用平台 AI（设置页 → 我的会员 → 登录）。免费版即可使用经济档，无需填写 API Key。",
      "平台 AI"
    );
  }

  const apiBase = String(await getApiBase()).replace(/\/+$/, "");
  try {
    await ensureOptionalHostPermission(apiBase, "润笔平台 AI 接口");
    const response = await fetch(`${apiBase}/api/llm/usage`, {
      headers: { Authorization: `Bearer ${jwt}` }
    });
    const latencyMs = Date.now() - startedAt;

    if (response.status === 401) {
      return createAiTestFailure(
        "润笔账户登录已过期，请到「我的会员」重新登录。",
        "平台 AI",
        latencyMs
      );
    }

    const data = await response.json().catch(() => ({}));
    if (!response.ok || !data?.ok) {
      return createAiTestFailure(
        data?.error || `平台 AI 暂不可用（状态码 ${response.status}）。`,
        "平台 AI",
        latencyMs
      );
    }

    const plan = data.plan || "free";
    const planLabel = plan === "yearly" ? "年费版" : plan === "monthly" ? "月费版" : "免费版";
    const remaining = data.remaining || {};
    let quotaText = "";
    if (remaining.call_count != null) {
      quotaText = `，本月还剩 ${remaining.call_count} 次`;
    } else if (remaining.total_tokens != null) {
      quotaText = `，本月还剩约 ${(Number(remaining.total_tokens) / 10000).toFixed(0)} 万 token`;
    }

    return {
      ok: true,
      latencyMs,
      model: `平台 AI · ${planLabel}${quotaText}`,
      error: ""
    };
  } catch (error) {
    return createAiTestFailure(
      mapAiConnectionRuntimeError(error),
      "平台 AI",
      Date.now() - startedAt
    );
  }
}

export async function testAiConnection({ baseUrl, apiKey, model, mode, timeoutMs = 12000 }) {
  // 平台模式：走 JWT 鉴权的平台端点，不要求 API Key（免费版也能测通）
  if (mode === "platform") {
    return testPlatformAiConnection();
  }

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

  // 用一个明确的英文回令，比 ping 更不易被某些模型拒绝；
  // 中文系统消息提高 GLM/Kimi/Qwen 等中文模型的合规率。
  const probeMessages = [
    { role: "system", content: "你是一个连通性检测助手，请按用户要求简短回应。" },
    { role: "user", content: "请回复 pong" }
  ];

  async function probe(includeStrictParams) {
    const body = {
      model: targetModel,
      messages: probeMessages
    };
    if (includeStrictParams) {
      body.max_tokens = 64;
      body.temperature = 0;
    } else {
      // 推理模型用 max_completion_tokens；不认这个字段的服务端会忽略，对后续连通性判断无害
      body.max_completion_tokens = 64;
    }
    return fetch(targetUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`
      },
      body: JSON.stringify(body),
      signal: controller.signal
    });
  }

  try {
    await ensureOptionalHostPermission(targetUrl, "AI 连通性测试接口");

    let response = await probe(true);
    let payload = await response.json().catch(() => ({}));

    // 推理模型 fallback：400 + 报错关键词命中 → 去掉 temperature/max_tokens 再试
    if (!response.ok && response.status === 400) {
      const errMsg = String(payload?.error?.message || payload?.error || payload?.message || "");
      if (REASONING_PARAM_REJECTS.test(errMsg)) {
        response = await probe(false);
        payload = await response.json().catch(() => ({}));
      }
    }

    const latencyMs = Date.now() - startedAt;

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

export function extractJson(rawText) {
  const fenced = rawText.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const text = fenced ? fenced[1].trim() : rawText.trim();

  const firstBrace = text.indexOf("{");
  const lastBrace = text.lastIndexOf("}");
  if (firstBrace === -1 || lastBrace === -1 || lastBrace <= firstBrace) {
    const err = new Error("AI 返回中没有找到可解析的 JSON。");
    err.code = "AI_PARSE_FAILED";
    throw err;
  }

  const candidate = text.slice(firstBrace, lastBrace + 1);
  try {
    return JSON.parse(candidate);
  } catch (parseErr) {
    // 44th session · 打 code 防 withRetry 整链重跑：模型格式坏掉时重试大概率
    // 还是坏的，平台模式下每次重试都是一次全额计费。
    const err = new Error(`AI 返回的 JSON 无法解析：${parseErr?.message || "格式错误"}`);
    err.code = "AI_PARSE_FAILED";
    throw err;
  }
}

export function normalizeArticle(data, source = {}, preferences = {}) {
  const root = data && typeof data === "object" ? data : {};
  const safeSource = source && typeof source === "object" ? source : {};
  const rawSections = Array.isArray(root.sections) ? root.sections : [];
  const sourceImages = Array.isArray(safeSource.images) ? safeSource.images : [];

  const sections = rawSections.map((rawSection) => {
    const section =
      rawSection && typeof rawSection === "object"
        ? rawSection
        : { paragraphs: [rawSection] };
    return {
      heading: normalizeGeneratedText(section.heading),
      paragraphs: normalizeStringArray(section.paragraphs),
      bulletPoints: normalizeStringArray(section.bulletPoints),
      quote: normalizeGeneratedText(section.quote),
      imageRefs: normalizeImageRefs(section.imageRefs, sourceImages),
      // 新增三类结构化内容，渲染层会据此画 <pre>/<table>/数学公式
      codeBlocks: normalizeCodeBlocks(section.codeBlocks),
      tables: normalizeTables(section.tables),
      mathBlocks: normalizeMathBlocks(section.mathBlocks)
    };
  });

  // —— 漏图兜底 ——
  // AI 经常会"忘掉"原文中的图片引用。我们扫描所有 section.imageRefs 已用到的 index，
  // 把"应该被引用却没被引用"的来源图片，按它们在原文 blocks 里出现的顺序，
  // 插回到最近的那个 section 的 imageRefs 末尾。
  // 排除规则：明显的 logo / avatar / emoji / icon / tracking pixel / 广告位
  injectMissingImages(sections, safeSource);

  // 同理：来源里出现但 AI 输出里完全消失的 code / table 也补回最近的 section
  injectMissingStructuredBlocks(sections, safeSource);

  return {
    title:
      normalizeGeneratedText(root.title) ||
      normalizeGeneratedText(safeSource.title) ||
      "未命名改写稿",
    subtitle: normalizeGeneratedText(root.subtitle),
    lead: normalizeGeneratedText(root.lead),
    sections,
    closing: normalizeGeneratedText(root.closing),
    cta: root.cta == null ? normalizeGeneratedText(preferences.cta) : normalizeGeneratedText(root.cta),
    wechatTitleOptions: normalizeStringArray(root.wechatTitleOptions).slice(0, 3),
    keywords: normalizeStringArray(root.keywords).slice(0, 8)
  };
}

function normalizeCodeBlocks(value) {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => ({
      language: normalizeGeneratedText(item?.language),
      text: normalizeGeneratedText(item?.text) || normalizeGeneratedText(item?.code)
    }))
    .filter((b) => b.text.trim().length > 0);
}

function normalizeTables(value) {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => ({
      headers: Array.isArray(item?.headers)
        ? item.headers.map((s) => normalizeGeneratedText(s))
        : [],
      rows: Array.isArray(item?.rows)
        ? item.rows.map((row) =>
            Array.isArray(row) ? row.map((cell) => normalizeGeneratedText(cell)) : []
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
      latex:
        normalizeGeneratedText(item?.latex) ||
        normalizeGeneratedText(item?.tex) ||
        normalizeGeneratedText(item?.text),
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
      caption: normalizeGeneratedText(image.caption) || normalizeGeneratedText(image.alt)
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
      const text = normalizeGeneratedText(block.text);
      if (!text) return;
      const language = normalizeGeneratedText(block.language);
      const key = `${language}::${text.slice(0, 80)}`;
      if (usedCode.has(key)) return;
      const sectionIdx = Math.min(sections.length - 1, cursor % sections.length);
      sections[sectionIdx].codeBlocks.push({
        language,
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
        headers: headers.map((s) => normalizeGeneratedText(s)),
        rows: rows.map((row) =>
          Array.isArray(row) ? row.map((cell) => normalizeGeneratedText(cell)) : []
        )
      });
      usedTable.add(key);
      cursor += 1;
    }
  });
}

function normalizeStringArray(value) {
  const values = Array.isArray(value) ? value : value == null ? [] : [value];
  return values
    .map((item) => normalizeGeneratedText(item))
    .filter(Boolean);
}

function normalizeGeneratedText(value) {
  if (value == null) return "";
  if (typeof value === "string") return value.trim();
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value).trim();
  }
  if (Array.isArray(value)) {
    return value
      .map((item) => normalizeGeneratedText(item))
      .filter(Boolean)
      .join("\n")
      .trim();
  }
  if (typeof value === "object") {
    for (const key of [
      "text",
      "content",
      "value",
      "title",
      "heading",
      "quote",
      "label",
      "name"
    ]) {
      const text = normalizeGeneratedText(value[key]);
      if (text) return text;
    }
  }
  return "";
}

function normalizeImageRefs(value, images) {
  if (!Array.isArray(value)) {
    return [];
  }

  return value
    .map((item) => ({
      index: Number(typeof item === "number" ? item : item?.index),
      caption:
        typeof item === "number"
          ? ""
          : normalizeGeneratedText(item?.caption) || normalizeGeneratedText(item?.alt)
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
