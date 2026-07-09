/**
 * comic-prompt.js —— 逻辑链漫画信息图 Prompt 生成（纯函数层）
 *
 * 移植自 prompt-forge（话题 → 结构化逻辑链 → 文生图 prompt 文本）：
 *   - 4 种布局模板：circular 环形闭环 / horizontal 横向 Stage / matrix 矩阵分层 / columns 多列分组
 *   - 5 种画幅：9:16 / 16:9 / 4:5 / 1:1 / 3:4
 *   - LLM 拆解的 JSON → buildComicPrompt() 拼出完整中文生图 prompt
 *
 * 分层约定（与 quote-cards.js 一致）：本文件只有纯函数，无 DOM / fetch 依赖，
 * 可在 Node（smoke）里直接跑；LLM 调用在 ai.js 的 requestComicChain。
 */

/** 画幅元数据（生图 prompt 里的画框描述 + 布局提示） */
export const COMIC_ASPECT_RATIOS = Object.freeze({
  "9:16": {
    id: "9:16",
    label: "9:16 手机竖版",
    desc: "小红书 / 抖音 / 手机全屏",
    orientation: "portrait",
    promptDescriptor: "9:16 竖版长图（适合手机全屏观看，宽窄高长）",
    layoutHint: "所有元素必须完整出现在 9:16 竖版画框内，不要被裁切，布局自上而下展开"
  },
  "16:9": {
    id: "16:9",
    label: "16:9 横版",
    desc: "公众号 / PPT / 电脑屏",
    orientation: "landscape",
    promptDescriptor: "16:9 横版（适合电脑屏幕和公众号头图）",
    layoutHint: "所有元素完整呈现在 16:9 横版画框内，布局自左向右展开"
  },
  "4:5": {
    id: "4:5",
    label: "4:5 朋友圈竖版",
    desc: "IG / 朋友圈竖图",
    orientation: "portrait",
    promptDescriptor: "4:5 竖版（适合 Instagram 和朋友圈）",
    layoutHint: "所有元素完整呈现在 4:5 竖版画框内，布局自上而下展开，不要被裁切"
  },
  "1:1": {
    id: "1:1",
    label: "1:1 方形",
    desc: "微博 / Twitter 卡片",
    orientation: "square",
    promptDescriptor: "1:1 方形（适合微博、Twitter 卡片）",
    layoutHint: "所有元素完整呈现在 1:1 方形画框内，居中紧凑布局"
  },
  "3:4": {
    id: "3:4",
    label: "3:4 标准竖版",
    desc: "iPad / A4 打印",
    orientation: "portrait",
    promptDescriptor: "3:4 标准竖版（适合 iPad 和 A4 打印）",
    layoutHint: "所有元素完整呈现在 3:4 竖版画框内，布局自上而下展开，不要被裁切"
  }
});

/** 4 种布局模板元数据（auto 表示让 LLM 自选） */
export const COMIC_TEMPLATE_META = Object.freeze({
  circular: {
    id: "circular",
    name: "环形闭环",
    desc: "6-8 个节点围成圆，中心放吉祥物",
    suitableFor: "因果循环、闭环逻辑、恶性循环类话题"
  },
  horizontal: {
    id: "horizontal",
    name: "横向 Stage",
    desc: "Stage 1→2→3→4 横向流转",
    suitableFor: "传导链路、数据传导、从 A 到 B 的过程"
  },
  matrix: {
    id: "matrix",
    name: "矩阵分层",
    desc: "根因→传导→症状→恶性循环，每层多节点",
    suitableFor: "多维度深度分析、复杂系统问题"
  },
  columns: {
    id: "columns",
    name: "多列分组",
    desc: "多个 Stage 列，每列多张卡片纵向堆叠",
    suitableFor: "改革举措、方案对比、问题→举措→效果"
  }
});

const NUMBER_CIRCLE = ["①", "②", "③", "④", "⑤", "⑥", "⑦", "⑧", "⑨", "⑩"];

function getAspect(ratio) {
  return COMIC_ASPECT_RATIOS[ratio] || COMIC_ASPECT_RATIOS["16:9"];
}

function normalizeText(value, fallback) {
  return typeof value === "string" && value.trim() ? value.trim() : fallback;
}

// ===== 4 种模板的 prompt 文本生成 =====

function buildCircularPrompt(d, ratio) {
  const ar = getAspect(ratio);
  const nodeLines = (d.nodes || [])
    .map((n, i) => `  ${i + 1}. 「${n.text}」${n.scene ? `，画面提示：${n.scene}` : ""}`)
    .join("\n");
  const keywords = (d.centerKeywords || []).filter(Boolean).join("・");

  return `生成一张 ${ar.promptDescriptor} 的中文信息图，主题是「${d.title}」，用可爱卡通风格的逻辑链漫画表现。
背景是柔和米黄色纯色底，画面干净留白多。${ar.layoutHint}。

顶部中心放一个大标题圆角气泡，白底棕色描边，标题用大号圆角简体中文字体，深棕色文字：「${d.title}」。

主体部分画一圈顺时针的流程图，一共 ${(d.nodes || []).length} 个节点，围成一个近似圆形。每个节点是一个彩色圆角矩形卡片，采用不同的马卡龙色填充（橙、蓝、紫、红、绿、青等）。

每个节点内部画和文本对应的卡通小场景，线条圆润、表情夸张，下面或卡片中间用清晰的简体中文短标题：
${nodeLines}

用粗厚的弯曲箭头把这些节点按${d.loopDescription || "顺时针顺序"}连接起来，箭头颜色与卡片协调，形成清晰的因果逻辑链。

圆圈中央放一个代表「${d.centerRole}」的可爱吉祥物角色，姿态自信、略带搞笑。吉祥物周围画几颗星星和小图标，脚边用小号简体中文写上关键词：「${keywords}」。

整体色彩明亮温暖，风格像儿童绘本一样，线条圆滑，阴影简洁，所有文字必须是清晰的简体中文，字号清晰可读，不出现错别字或乱码。`;
}

function buildHorizontalPrompt(d, ratio) {
  const ar = getAspect(ratio);
  const isPortrait = ar.orientation === "portrait";
  const flowAxis = isPortrait ? "自上而下" : "从左到右";
  const stageLabelPos = isPortrait ? "左上角" : "上方";
  const stages = d.stages || [];
  const stageLines = stages
    .map((s, i) => `Stage ${i + 1}「${s.stageTitle}」：节点文字「${s.nodeText}」，画面提示：${s.scene}`)
    .join("\n");

  return `生成一张 ${ar.promptDescriptor} 的中文信息图，主题是「${d.title}」，用可爱卡通风格的传导链漫画表现。
背景是柔和米黄色纯色底，画面干净留白多。${ar.layoutHint}。

顶部中心放一个大标题圆角气泡，白底棕色描边，深棕色粗体简体中文字体：「${d.title}」。

主体部分${flowAxis}画 ${stages.length} 个 Stage 节点（用英文 "STAGE 1"、"STAGE 2"… 作为小标签放在每个节点${stageLabelPos}，颜色和卡片协调）。每个 Stage 是一张大号圆角矩形卡片，采用不同的马卡龙色填充（黄、蓝、绿、红等），卡片内部画一组对应主题的卡通插画（可包含多个小元素和表情夸张的角色），下方用简体中文写上节点名称。

各 Stage 详细内容：
${stageLines}

用粗厚的弯曲箭头（蓝色、绿色、红色等）将各个 Stage ${flowAxis}连接起来，体现传导关系。如果某个 Stage 有多条分支（例如同时影响多个对象），用多条不同颜色的弯曲箭头分散指向后续 Stage 内部的多个子卡片。

整体色彩明亮温暖，卡通线条圆润，表情可爱，风格像公众号财经科普条漫。所有文字必须是清晰的简体中文，字号清晰可读，不出现错别字或乱码。`;
}

function buildMatrixPrompt(d, ratio) {
  const ar = getAspect(ratio);
  const rows = d.rows || [];
  const rowLines = rows
    .map((row, ri) => {
      const nodes = (row.nodes || [])
        .map(
          (n, ni) =>
            `   ${NUMBER_CIRCLE[ni] || `(${ni + 1})`} 「${n.text}」${n.scene ? ` — 画面提示：${n.scene}` : ""}`
        )
        .join("\n");
      return `第 ${ri + 1} 行「${row.layerName}」（${row.layerHint || "层级提示"}），共 ${(row.nodes || []).length} 个节点，横向并列：\n${nodes}`;
    })
    .join("\n\n");

  const policy = (d.policyItems || []).filter(Boolean).map((p) => `「${p}」`).join("、");

  return `生成一张 ${ar.promptDescriptor} 的中文信息图，主题是「${d.title}」，用可爱卡通风格的多层矩阵逻辑链漫画表现。
背景是柔和米黄色纯色底，画面干净留白多。${ar.layoutHint}。

顶部中心放一个大标题圆角气泡，白底棕色描边，深棕色粗体简体中文字体：「${d.title}」。

主体部分采用横向多行矩阵布局，共 ${rows.length} 行，每行代表一个逻辑层级。左侧边缘用大号简体中文写出每行的层级名称，并用一个浅色的横向背景色条贯穿这一行，不同行用不同的浅色（浅紫、浅蓝、浅橙、浅红等马卡龙色）。

各行节点详细如下：

${rowLines}

每个节点是一张圆角矩形卡片，内部画一组对应主题的卡通小插画（角色表情夸张），下方用简体中文写节点名称。同一行的节点用同色系箭头水平相连，行与行之间用纵向粗箭头表示因果传导（可以从上一行的某个节点指向下一行对应节点），最后一行可以画一条弯曲的红色大箭头回到顶部某节点形成"恶性循环"。
${
  policy
    ? `\n画面右侧单独留一块绿色或浅绿色的提示框，顶部画一个戴眼镜、手持工具的可爱吉祥物（猫头鹰、机器人、打工人等），框内列出几条关键词：${policy}，标题为「${d.policyTitle || "关键应对"}」。`
    : ""
}

整体色彩明亮温暖，卡通线条圆润，表情可爱，层次分明。所有文字必须是清晰的简体中文，字号清晰可读，不出现错别字或乱码。`;
}

function buildColumnsPrompt(d, ratio) {
  const ar = getAspect(ratio);
  const isPortrait = ar.orientation === "portrait";
  const flowAxis = isPortrait ? "自上而下" : "从左到右";
  const stageAxis = isPortrait ? "纵向分为" : "横向分为";
  const columns = d.columns || [];
  const colLines = columns
    .map((c, ci) => {
      const nodes = (c.nodes || [])
        .map((n, ni) => `   - 卡片 ${ni + 1}：「${n.text}」${n.scene ? `，画面提示：${n.scene}` : ""}`)
        .join("\n");
      return `STAGE ${ci + 1} —— ${c.stageTitle}（${c.stageHint || "阶段说明"}），共 ${(c.nodes || []).length} 张卡片，纵向堆叠：\n${nodes}`;
    })
    .join("\n\n");

  return `生成一张 ${ar.promptDescriptor} 的中文信息图，主题是「${d.title}」，用可爱卡通风格的分段改革/方案对比漫画表现。
背景是柔和米黄色纯色底，画面干净留白多。${ar.layoutHint}。

顶部中心放一个大标题圆角气泡，白底棕色描边，深棕色粗体简体中文字体：「${d.title}」。

主体部分${stageAxis} ${columns.length} 个 Stage，每个 Stage 占满画框宽度或并列展示。每列顶部用红/蓝/绿/橙等不同颜色的英文小标签写出 "STAGE 1"、"STAGE 2"… 并配上对应中文副标题。

各列详细内容：

${colLines}

每张卡片是一个圆角矩形，使用与该列主色协调的填充色（STAGE 1 偏红/粉、STAGE 2 偏蓝、STAGE 3 偏绿、STAGE 4 偏黄等马卡龙色），卡片内部画一组对应描述的卡通小场景（角色表情夸张、可爱），下方用简体中文写卡片标题。

用粗厚的弯曲箭头${flowAxis}从前一个 Stage 指向后一个 Stage（可以一对多或多对一），箭头颜色和后续 Stage 的色系协调，体现因果链。

${d.footerNote ? `画面底部用棕色小字加一行注释：「${d.footerNote}」。` : ""}

整体色彩明亮温暖，卡通线条圆润，表情可爱，布局整齐。所有文字必须是清晰的简体中文，字号清晰可读，不出现错别字或乱码。`;
}

/**
 * 结构化数据 → 完整生图 prompt 文本。
 * @param {object} data LLM 拆解出的结构化数据（template 字段决定布局）
 * @param {string} [ratio] 画幅 id（默认 16:9）
 * @param {object} [opts] { grounded } —— grounded=true 时追加「文章依据」约束段
 *   （本项目里结构化数据是基于编辑台正文拆的，提醒生图模型不要自行编造）
 */
export function buildComicPrompt(data, ratio, { grounded = false } = {}) {
  let prompt;
  switch (data.template) {
    case "circular":
      prompt = buildCircularPrompt(data, ratio);
      break;
    case "horizontal":
      prompt = buildHorizontalPrompt(data, ratio);
      break;
    case "matrix":
      prompt = buildMatrixPrompt(data, ratio);
      break;
    case "columns":
      prompt = buildColumnsPrompt(data, ratio);
      break;
    default:
      throw new Error(`未知的漫画模板：${data.template}`);
  }

  if (!grounded) return prompt;

  return `${prompt}

事实依据要求：
这张图的节点文字与因果关系来自一篇已有文章的内容拆解，请严格按上面给出的节点文字、顺序和画面提示绘制，不要自行编造文章中没有的事实、数字、机构名称、时间或结论。`;
}

/**
 * 把 LLM 返回的疑似结构化数据修复成合法结构（模板字段缺失/错乱时按特征推断）。
 * 移植自 prompt-forge repairStructuredData，保证 buildComicPrompt 不会因缺字段崩溃。
 */
export function repairComicData(raw) {
  const src = raw && typeof raw === "object" ? raw : {};
  if (["circular", "horizontal", "matrix", "columns"].includes(src.template)) {
    return normalizeByTemplate(src);
  }

  const title = normalizeText(src.title, "主题传导链");

  if (Array.isArray(src.rows)) {
    return normalizeByTemplate({ ...src, template: "matrix", title });
  }
  if (Array.isArray(src.columns)) {
    return normalizeByTemplate({ ...src, template: "columns", title });
  }
  if (Array.isArray(src.nodes) && (src.nodes.length >= 5 || src.centerRole || src.loopDescription)) {
    return normalizeByTemplate({ ...src, template: "circular", title });
  }
  return normalizeByTemplate({ ...src, template: "horizontal", title });
}

function normalizeByTemplate(d) {
  const title = normalizeText(d.title, "主题传导链");
  switch (d.template) {
    case "circular":
      return {
        template: "circular",
        title,
        nodes: normalizeNodes(d.nodes),
        centerRole: normalizeText(d.centerRole, "中心吉祥物"),
        centerKeywords: Array.isArray(d.centerKeywords) && d.centerKeywords.length ? d.centerKeywords.map(String) : ["关键应对"],
        loopDescription: normalizeText(d.loopDescription, "顺时针闭环")
      };
    case "matrix":
      return {
        template: "matrix",
        title,
        rows: (Array.isArray(d.rows) ? d.rows : []).map((row, i) => ({
          layerName: normalizeText(row?.layerName, `层级${i + 1}`),
          layerHint: normalizeText(row?.layerHint, ""),
          nodes: normalizeNodes(row?.nodes)
        })),
        policyTitle: normalizeText(d.policyTitle, ""),
        policyItems: Array.isArray(d.policyItems) ? d.policyItems.map(String).filter(Boolean) : []
      };
    case "columns":
      return {
        template: "columns",
        title,
        columns: (Array.isArray(d.columns) ? d.columns : []).map((col, i) => ({
          stageTitle: normalizeText(col?.stageTitle, `阶段${i + 1}`),
          stageHint: normalizeText(col?.stageHint, ""),
          nodes: normalizeNodes(col?.nodes)
        })),
        footerNote: normalizeText(d.footerNote, "")
      };
    case "horizontal":
    default: {
      const stages = Array.isArray(d.stages)
        ? d.stages.map((stage, i) => ({
            stageTitle: normalizeText(stage?.stageTitle || stage?.title || stage?.name, `阶段${i + 1}`),
            nodeText: normalizeText(stage?.nodeText || stage?.text || stage?.label, `节点${i + 1}`),
            scene: normalizeText(stage?.scene, "卡通角色拿着道具说明变化")
          }))
        : normalizeNodes(d.nodes)
            .slice(0, 5)
            .map((node, i) => ({
              stageTitle: `阶段${i + 1}`,
              nodeText: node.text,
              scene: node.scene || "卡通角色拿着道具说明变化"
            }));
      return { template: "horizontal", title, stages: ensureMinimumStages(stages) };
    }
  }
}

function normalizeNodes(nodes) {
  if (!Array.isArray(nodes)) return [];
  return nodes.map((node, i) => ({
    text: normalizeText(node?.text || node?.label || node?.name, `节点${i + 1}`),
    scene: normalizeText(node?.scene, "卡通角色拿着道具说明变化")
  }));
}

function ensureMinimumStages(stages) {
  const safe = stages.length ? stages.slice() : [];
  while (safe.length < 3) {
    const next = safe.length + 1;
    safe.push({ stageTitle: `阶段${next}`, nodeText: `节点${next}`, scene: "卡通角色拿着道具说明变化" });
  }
  return safe.slice(0, 5);
}

/**
 * 结构化数据 → 多行结构概览文本（📐 结构概览展示 + 种草文案 prompt 的输入）。
 * 移植自 prompt-forge buildStructuredOutline。
 */
export function buildComicOutline(data) {
  const d = data && typeof data === "object" ? data : {};
  const name = COMIC_TEMPLATE_META[d.template]?.name || String(d.template || "");
  switch (d.template) {
    case "circular":
      return [
        `模板：${name}`,
        `标题：${d.title}`,
        `节点：${(d.nodes || []).map((n, i) => `${i + 1}.${n.text}`).join(" → ")}`,
        `中心：${d.centerRole}`,
        `关键词：${(d.centerKeywords || []).join("、")}`
      ].join("\n");
    case "horizontal":
      return [
        `模板：${name}`,
        `标题：${d.title}`,
        ...(d.stages || []).map((s, i) => `Stage ${i + 1}：${s.stageTitle} - ${s.nodeText}`)
      ].join("\n");
    case "matrix":
      return [
        `模板：${name}`,
        `标题：${d.title}`,
        ...(d.rows || []).map(
          (row, i) => `第 ${i + 1} 层 ${row.layerName}：${(row.nodes || []).map((n) => n.text).join("、")}`
        ),
        (d.policyItems || []).length ? `应对：${d.policyItems.join("、")}` : ""
      ]
        .filter(Boolean)
        .join("\n");
    case "columns":
      return [
        `模板：${name}`,
        `标题：${d.title}`,
        ...(d.columns || []).map(
          (col, i) => `Stage ${i + 1} ${col.stageTitle}：${(col.nodes || []).map((n) => n.text).join("、")}`
        ),
        d.footerNote ? `注释：${d.footerNote}` : ""
      ]
        .filter(Boolean)
        .join("\n");
    default:
      return "";
  }
}

/**
 * 话题 + 结构化数据 → 自动标签（🏷️ 去重、2-16 字、最多 10 个，不带 # 号）。
 * 移植自 prompt-forge generateTags。
 */
export function generateComicTags(topic, data) {
  const d = data && typeof data === "object" ? data : {};
  const candidates = [
    ...splitTagText(String(topic || "")),
    ...splitTagText(String(d.title || "")),
    ...getStructuredLabels(d),
    COMIC_TEMPLATE_META[d.template]?.name || "",
    "逻辑链",
    "信息图"
  ];

  const seen = new Set();
  return candidates
    .map(normalizeTag)
    .filter((tag) => {
      if (!tag || seen.has(tag)) return false;
      seen.add(tag);
      return true;
    })
    .slice(0, 10);
}

function getStructuredLabels(d) {
  switch (d.template) {
    case "circular":
      return [...(d.nodes || []).map((n) => n.text), ...(d.centerKeywords || [])];
    case "horizontal":
      return (d.stages || []).flatMap((s) => [s.stageTitle, s.nodeText]);
    case "matrix":
      return [
        ...(d.rows || []).flatMap((row) => [row.layerName, ...(row.nodes || []).map((n) => n.text)]),
        ...(d.policyItems || [])
      ];
    case "columns":
      return (d.columns || []).flatMap((col) => [col.stageTitle, ...(col.nodes || []).map((n) => n.text)]);
    default:
      return [];
  }
}

function splitTagText(text) {
  return text
    .split(/[\s,，、/｜|:：;；。.!！?？「」""''（）()【】\[\]-]+/)
    .map((part) => part.trim())
    .filter(Boolean);
}

function normalizeTag(tag) {
  const normalized = String(tag || "")
    .replace(/^#+/, "")
    .replace(/[^\u4e00-\u9fa5a-zA-Z0-9]+/g, "")
    .trim();
  if (normalized.length < 2 || normalized.length > 16) return "";
  return normalized;
}
