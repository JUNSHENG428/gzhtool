/**
 * 思想密度规则单一真源（insight-rules）。
 *
 * 与 humanize-rules.js 的分工：humanize 管「形式层」（句长/套话/标点——写得像不像人），
 * 本模块管「内容层」（观点/论证/具体度——写得有没有思想）。两者都遵循
 * 「规则沉单一真源，prompt 与本地 lint 共用」的既有模式，避免多处漂移。
 *
 * 三块内容：
 *   1. INSIGHT_PRESSURE_RULES —— 正向思想压力 prompt 块，注入立论/成稿 system prompt
 *   2. PLATITUDE_PATTERNS     —— 「正确的废话」句式黑名单（本地 lint 用，零成本）
 *   3. lintInsight()          —— 内容层本地检查：平庸句式命中 + 具体度信号统计
 */

/**
 * 正向思想压力：不同于反 AI 味的「禁止 XX」，这组规则强制模型输出判断而不是描述。
 * 注入位置：requestThesisBrief 的 system prompt + 主改写的立论骨架 message。
 */
export const INSIGHT_PRESSURE_RULES = [
  "【思想密度要求（强制，比文采优先）】",
  "- 全文必须有一个明确的、可以被反驳的核心判断（thesis）。「要辩证看待」「机遇与挑战并存」这类不可能被反驳的话不算判断，算废话。",
  "- 至少指出一个「大多数人默认为对、但来源事实并不支持」的看法，并用来源事实反驳它。",
  "- 任何判断都要写清代价和输家：谁会因此受损、放弃了什么。没有代价分析的观点是口号。",
  "- 给出一个 12–18 个月内可验证的具体推断（谁、会发生什么、凭什么这么判断）。素材不足以支撑推断时宁可收窄范围，也不要写「未来值得期待」。",
  "- 结论具体到有人能不同意的程度：如果一个从业者读完不可能产生「我不同意」的冲动，说明判断还不够锋利。"
].join("\n");

/**
 * 「正确的废话」句式黑名单：读起来四平八稳、删掉后文章毫无损失的句式。
 * 每项 { pattern, label, weight }，weight 越高越致命。
 * 与 humanize 黑名单的区别：那边抓「AI 腔调」，这边抓「没有信息量的骑墙表述」——
 * 一个真人作者也完全可能写出这些，所以不进 humanize 词表，单独成层。
 */
export const PLATITUDE_PATTERNS = [
  { pattern: /值得(?:我们)?(?:关注|注意|警惕|深思|思考)/g, label: "值得关注式收尾", weight: 3 },
  { pattern: /(?:还)?有待(?:时间)?(?:观察|检验|验证)/g, label: "有待观察式骑墙", weight: 3 },
  { pattern: /(?:是|犹如)?(?:一把)?双刃剑/g, label: "双刃剑比喻", weight: 3 },
  { pattern: /仁者见仁|智者见智|见仁见智/g, label: "见仁见智式骑墙", weight: 3 },
  { pattern: /时间(?:会|将)(?:给出|证明|告诉我们)(?:答案|一切)?/g, label: "时间会证明式收尾", weight: 3 },
  { pattern: /让我们拭目以待|拭目以待/g, label: "拭目以待式收尾", weight: 3 },
  { pattern: /机遇与挑战并存|既是机遇也是挑战/g, label: "机遇挑战并存", weight: 3 },
  { pattern: /辩证(?:地|的)?(?:看待|看|分析)/g, label: "辩证看待式骑墙", weight: 2 },
  { pattern: /(?:具体)?(?:情况|问题)(?:具体|还要具体)分析/g, label: "具体问题具体分析", weight: 2 },
  { pattern: /没有(?:绝对的|标准)答案/g, label: "没有标准答案", weight: 2 },
  { pattern: /(?:关键|重点|核心)(?:还是)?(?:在于|是)(?:如何)?平衡/g, label: "关键在于平衡", weight: 2 },
  { pattern: /因人而异|因情况而异/g, label: "因人而异式骑墙", weight: 2 },
  { pattern: /(?:未来|前景)(?:依然|仍然|还是)?(?:可期|值得期待|充满(?:想象|可能))/g, label: "未来可期式收尾", weight: 3 },
  { pattern: /(?:这|它)(?:或许|也许|可能)?(?:才)?(?:是|正是)(?:最|真正)(?:值得|需要)(?:我们)?(?:思考|反思)的/g, label: "才是最值得思考的", weight: 2 }
];

/**
 * 内容层本地 lint：扫平庸句式 + 统计具体度信号。
 * 纯正则零成本，可在改写完成后与 humanize badge 并行展示，
 * 也给「思想批评 pass」的 LLM 评审当靶子补充（本地命中直接列给模型）。
 *
 * @param {string} text 纯文本（调用方自行 strip HTML）
 * @returns {{
 *   hits: Array<{ label: string, excerpt: string, weight: number }>,
 *   platitudeScore: number,   // 平庸扣分总和（0 = 干净）
 *   specificity: { numbers: number, quotes: number }  // 具体度信号：数字/引号密度参考
 * }}
 */
export function lintInsight(text) {
  const s = String(text || "");
  const hits = [];
  for (const { pattern, label, weight } of PLATITUDE_PATTERNS) {
    pattern.lastIndex = 0;
    let m;
    while ((m = pattern.exec(s)) !== null) {
      const start = Math.max(0, m.index - 10);
      hits.push({
        label,
        excerpt: s.slice(start, m.index + m[0].length + 10).trim(),
        weight
      });
      if (hits.length >= 20) break;
    }
    if (hits.length >= 20) break;
  }
  const numbers = (s.match(/\d+(?:\.\d+)?[%万亿元年月日人次倍]?/g) || []).length;
  const quotes = (s.match(/[「“][^」”]{4,40}[」”]/g) || []).length;
  return {
    hits,
    platitudeScore: hits.reduce((sum, h) => sum + h.weight, 0),
    specificity: { numbers, quotes }
  };
}
