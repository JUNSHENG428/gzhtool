/**
 * server/compliance/rules.js · 远程版本化合规词库
 *
 * 用途：让运营方**不发布扩展**也能补充/调整敏感词。扩展端 GET /api/compliance/rules
 * 拉取这份 JSON，按 version 缓存到 chrome.storage.local，与内置词库（src/shared/
 * compliance-rules.js）合并后本地扫描。
 *
 * 维护方式：直接改这个文件的 literal / regex，bump version，`wrangler deploy` 即生效。
 * 扫描全程在扩展本地，**不上传用户正文**。
 *
 * 字段与扩展端对齐：
 *   literal: [{ id, category, severity, term, reason?, suggestion?, replace? }]
 *   regex:   [{ id, category, severity, source, flags?, reason, suggestion? }]
 *   category 必须是扩展 CATEGORY_META 已知值（custom/ad_extreme/medical/finance/
 *            divert/clickbait/porn_vulgar/illegal/political），未知值扩展端按 custom 兜底。
 *   severity: 3 block / 2 warn / 1 hint
 *
 * version 单调递增整数；扩展端只在 remote.version > 本地缓存 version 时覆盖。
 */
export const COMPLIANCE_REMOTE_RULES = Object.freeze({
  version: 1,
  updatedAt: "2026-05-29",
  literal: [
    // 种子：几个内置库没覆盖、近期高频的词。后续补词只改这里 + bump version。
    { id: "r.ad.quanwangzuidi", category: "ad_extreme", severity: 2, term: "全网最低", reason: "绝对化用语", replace: "超值价" },
    { id: "r.ad.duijia", category: "ad_extreme", severity: 2, term: "全网首发", reason: "绝对化用语" },
    { id: "r.fin.baoshangche", category: "finance", severity: 2, term: "包上岸", reason: "违规承诺收益" },
    { id: "r.cb.kanwanlei", category: "clickbait", severity: 1, term: "看完泪崩", reason: "标题党" }
  ],
  regex: []
});
