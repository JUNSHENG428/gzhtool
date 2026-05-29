/**
 * src/shared/compliance-checker.js
 * ====================================================================
 * 公众号合规检测器（本地，零联网，零 LLM）
 *
 * 做什么：扫描改写后的 article / HTML，命中 compliance-rules.js 词库 → 输出风险清单。
 * 不做什么：不自动改稿（只检测）、不依赖 DOMParser（要在 service worker 跑，用 regex 剥 HTML）、
 *           不上传正文（隐私）、不硬阻断主链路（safeScanCompliance 吞异常返回 ok）。
 *
 * 调用入口：
 *   - service-worker.js REWRITE_ARTICLE 改写后跑一次 → payload.meta.compliance
 *   - workspace 发布前对当前篇跑一次 → block 级弹二次确认
 *
 * 免责：命中不代表微信平台的最终判定结果，仅作辅助提示。
 */

import {
  LITERAL_RULES,
  REGEX_RULES,
  CATEGORY_META,
  SEVERITY,
  severityLabel,
  severityLevel
} from "./compliance-rules.js";

// 远程词库（GET /api/compliance/rules 下发，与内置库合并）。模块级单例，
// 每个 JS realm（SW / 页面）各自 setRemoteComplianceRules 一次。
let _remoteLiteral = [];
let _remoteRegex = [];

/** 注入远程下发的规则（compliance-remote.js 拉取/缓存后调用）。传 null 清空。 */
export function setRemoteComplianceRules(rules) {
  _remoteLiteral = Array.isArray(rules?.literal) ? rules.literal : [];
  _remoteRegex = Array.isArray(rules?.regex) ? rules.regex : [];
}

// ---------------------------------------------------------------------
// 入口
// ---------------------------------------------------------------------

/**
 * @param {string|object} input  HTML 字符串或 article 对象
 * @returns {{
 *   level: "ok"|"hint"|"warn"|"block",
 *   counts: { block:number, warn:number, hint:number },
 *   total: number,
 *   hits: Array<{ id, category, categoryLabel, severity, severityLabel, term, index, reason, suggestion?, replace? }>,
 *   byCategory: Record<string, Array>
 * }}
 */
export function scanCompliance(input, options = {}) {
  const text = extractPlainText(input);
  const hits = [];

  if (text) {
    collectLiteralHits(text, LITERAL_RULES, hits);
    if (_remoteLiteral.length) collectLiteralHits(text, _remoteLiteral, hits);
    collectRegexHits(text, REGEX_RULES, hits);
    if (_remoteRegex.length) collectRegexHits(text, _remoteRegex, hits);
    collectCustomHits(text, options.customTerms, hits);
  }

  // 去重：同 id + 同 index 只留一条
  const seen = new Set();
  const deduped = [];
  for (const h of hits) {
    const k = `${h.id}@${h.index}`;
    if (seen.has(k)) continue;
    seen.add(k);
    deduped.push(h);
  }

  // 严重度降序，其次按出现位置
  deduped.sort((a, b) => b.severity - a.severity || a.index - b.index);

  const counts = { block: 0, warn: 0, hint: 0 };
  const byCategory = {};
  for (const h of deduped) {
    const lvl = severityLevel(h.severity);
    counts[lvl] += 1;
    (byCategory[h.category] = byCategory[h.category] || []).push(h);
  }

  const level =
    counts.block > 0 ? "block" : counts.warn > 0 ? "warn" : counts.hint > 0 ? "hint" : "ok";

  return { level, counts, total: deduped.length, hits: deduped, byCategory };
}

/** 不抛错版本（对标 safeLintArticle）：任何异常都回 ok，绝不阻断主链路。 */
export function safeScanCompliance(input, options = {}) {
  try {
    return scanCompliance(input, options);
  } catch (err) {
    if (typeof console !== "undefined") {
      console.warn("[compliance] scan failed, treated as ok", err);
    }
    return { level: "ok", counts: { block: 0, warn: 0, hint: 0 }, total: 0, hits: [], byCategory: {} };
  }
}

// ---------------------------------------------------------------------
// 命中收集
// ---------------------------------------------------------------------

function collectLiteralHits(text, rules, hits) {
  for (const r of rules) {
    if (!r.term) continue;
    // 白名单：命中词若整体作为白名单短语出现，粗粒度跳过（减误报，MVP 取舍）
    if (Array.isArray(r.whitelist) && r.whitelist.some((w) => w && text.includes(w))) {
      // 仅当词只以白名单形式出现时才整体跳过；否则仍报（避免漏真违规）
      if (onlyInsideWhitelist(text, r.term, r.whitelist)) continue;
    }
    let from = 0;
    let idx;
    let guard = 0;
    while ((idx = text.indexOf(r.term, from)) !== -1 && guard < 200) {
      hits.push(makeHit(r, r.term, idx));
      from = idx + r.term.length;
      guard += 1;
    }
  }
}

// 用户自定义敏感词（来自设置，severity=2 warn，category=custom）
function collectCustomHits(text, customTerms, hits) {
  if (!Array.isArray(customTerms) || customTerms.length === 0) return;
  const seen = new Set();
  for (const raw of customTerms) {
    const term = String(raw || "").trim();
    if (!term || seen.has(term)) continue;
    seen.add(term);
    let from = 0;
    let idx;
    let guard = 0;
    while ((idx = text.indexOf(term, from)) !== -1 && guard < 200) {
      hits.push(
        makeHit(
          { id: `custom.${term}`, category: "custom", severity: SEVERITY.WARN, reason: "自定义敏感词" },
          term,
          idx
        )
      );
      from = idx + term.length;
      guard += 1;
    }
  }
}

function collectRegexHits(text, rules, hits) {
  for (const r of rules) {
    let re;
    try {
      re = new RegExp(r.source, r.flags || "g");
    } catch {
      continue;
    }
    let m;
    let guard = 0;
    while ((m = re.exec(text)) !== null && guard < 200) {
      const term = m[0];
      hits.push(makeHit(r, term, m.index));
      if (m.index === re.lastIndex) re.lastIndex += 1; // 防零宽死循环
      guard += 1;
    }
  }
}

function makeHit(rule, term, index) {
  const meta = CATEGORY_META[rule.category] || {};
  return {
    id: rule.id,
    category: rule.category,
    categoryLabel: meta.label || rule.category,
    severity: rule.severity,
    severityLabel: severityLabel(rule.severity),
    term,
    index,
    reason: rule.reason || meta.note || "",
    suggestion: rule.suggestion || "",
    replace: typeof rule.replace === "string" ? rule.replace : ""
  };
}

// 判断 term 是否只作为白名单短语的一部分出现（粗粒度：把所有白名单短语挖掉后还有没有 term）
function onlyInsideWhitelist(text, term, whitelist) {
  let stripped = text;
  for (const w of whitelist) {
    if (!w) continue;
    stripped = stripped.split(w).join("");
  }
  return !stripped.includes(term);
}

// ---------------------------------------------------------------------
// 纯文本提取（不依赖 DOMParser，SW 友好；自带精简版，避免耦合 humanize-checker 内部）
// ---------------------------------------------------------------------

function extractPlainText(input) {
  if (input == null) return "";
  if (typeof input === "string") return stripHtmlTags(input);
  if (typeof input === "object") {
    const parts = [];
    if (input.title) parts.push(String(input.title));
    if (input.subtitle) parts.push(String(input.subtitle));
    if (input.lead) parts.push(String(input.lead));
    if (Array.isArray(input.titleOptions)) parts.push(input.titleOptions.join("\n"));
    if (typeof input.bodyHtml === "string" && input.bodyHtml.trim()) {
      parts.push(stripHtmlTags(input.bodyHtml));
    }
    const meta = input.meta;
    if (meta && typeof meta === "object") {
      if (meta.title) parts.push(String(meta.title));
      if (meta.digest) parts.push(String(meta.digest));
      if (meta.lead) parts.push(String(meta.lead));
      if (Array.isArray(meta.titleOptions)) parts.push(meta.titleOptions.join("\n"));
    }
    return parts.join("\n");
  }
  return "";
}

function stripHtmlTags(html) {
  let s = String(html || "");
  s = s.replace(/<script[\s\S]*?<\/script>/gi, "");
  s = s.replace(/<style[\s\S]*?<\/style>/gi, "");
  s = s.replace(/<\s*br\s*\/?\s*>/gi, "\n");
  s = s.replace(/<\/(p|div|h[1-6]|li|tr|blockquote|section)\s*>/gi, "\n");
  s = s.replace(/<[^>]+>/g, "");
  s = s
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
  return s.trim();
}

/**
 * 把设置里的「自定义敏感词」字符串解析成数组。
 * 支持换行 / 中英文逗号 / 顿号 / 空格分隔；去空去重；每条 ≤ 40 字；最多 500 条。
 */
export function parseCustomComplianceTerms(value) {
  if (!value) return [];
  const parts = String(value)
    .split(/[\n,，、;；\s]+/)
    .map((s) => s.trim())
    .filter((s) => s && s.length <= 40);
  return Array.from(new Set(parts)).slice(0, 500);
}

export { SEVERITY };
