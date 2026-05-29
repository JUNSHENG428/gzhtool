/**
 * src/shared/compliance-rules.js
 * ====================================================================
 * 公众号合规检测 · 词库与规则的唯一来源（SSOT）
 *
 * 设计（对标 humanize-rules.js）：
 *   - 检测器 compliance-checker.js / UI / 未来自动替换都从这里 import，
 *     不在多处散落副本（reflex「跨模块共享规则常量必须 SSOT」）。
 *   - 纯数据 + 纯函数，无 DOM / 无网络，service worker 友好。
 *
 * 严重度（severity）：
 *   3 = block 高危（可能直接封号/下架）—— 发布前强提醒 + 二次确认
 *   2 = warn  违规（可能限流 / 被投诉 / 罚款，如广告法极限词）
 *   1 = hint  提示（标题党 / 诱导点击，可能限流）
 *
 * ⚠️ political（时政敏感）分类**刻意留空**：自建时政词库维护风险极高且易过期，
 *    MVP 不堆词，仅保留分类位 + 引导用户人工复核；未来可接成熟开源词库 vendor 引入。
 *
 * 免责：本词库为辅助提示，命中不代表微信平台的最终判定结果。
 */

export const SEVERITY = Object.freeze({ BLOCK: 3, WARN: 2, HINT: 1 });

export const CATEGORY_META = Object.freeze({
  political: { label: "时政敏感", severity: 3, note: "涉政内容请人工复核（本工具不堆砌时政词库）" },
  porn_vulgar: { label: "色情低俗", severity: 3, note: "可能直接封号" },
  illegal: { label: "违法违规", severity: 3, note: "赌博 / 诈骗 / 违禁交易，可能封号" },
  divert: { label: "诱导导流", severity: 2, note: "诱导关注 / 加微信 / 外部导流，微信易限流" },
  ad_extreme: { label: "广告法极限词", severity: 2, note: "《广告法》绝对化用语，易被投诉 / 罚款" },
  medical: { label: "医疗健康违规", severity: 2, note: "疗效承诺 / 夸大功效，易被投诉 / 限流" },
  finance: { label: "金融违规", severity: 2, note: "保本保收益 / 荐股等表述，易被封 / 罚" },
  clickbait: { label: "标题党", severity: 1, note: "诱导点击 / 夸张表述，可能被限流" }
});

/**
 * 字面量规则：命中即报。
 * @typedef {{ id:string, category:string, severity:number, term:string,
 *   reason?:string, suggestion?:string, replace?:string, whitelist?:string[] }} LiteralRule
 */
export const LITERAL_RULES = Object.freeze([
  // ── 广告法极限词（severity 2）。replace 给常见可直接替换项 ──
  rule("ad.guojiaji", "ad_extreme", "国家级", "绝对化用语", "行业领先"),
  rule("ad.zuigaoji", "ad_extreme", "最高级", "绝对化用语"),
  rule("ad.diyi", "ad_extreme", "第一品牌", "绝对化用语", "知名品牌"),
  rule("ad.quanguodiyi", "ad_extreme", "全国第一", "绝对化用语", "广受认可"),
  rule("ad.shijiediyi", "ad_extreme", "世界第一", "绝对化用语"),
  rule("ad.xiaoliangdiyi", "ad_extreme", "销量第一", "绝对化用语", "销量领先"),
  rule("ad.dingji", "ad_extreme", "顶级", "绝对化用语", "高品质"),
  rule("ad.jizhi", "ad_extreme", "极致", "绝对化用语"),
  rule("ad.zuixianjin", "ad_extreme", "最先进", "绝对化用语", "先进"),
  rule("ad.zuiyou", "ad_extreme", "最优", "绝对化用语", "优质"),
  rule("ad.zuidi", "ad_extreme", "最低价", "绝对化用语", "优惠价"),
  rule("ad.zuibianyi", "ad_extreme", "最便宜", "绝对化用语", "实惠"),
  rule("ad.baifenbai", "ad_extreme", "100%", "绝对化用语", "高比例", ["100%棉", "100%纯棉"]),
  rule("ad.baifenzhibai", "ad_extreme", "百分百", "绝对化用语"),
  rule("ad.juedui", "ad_extreme", "绝对", "绝对化用语", "非常", ["绝对值"]),
  rule("ad.yongjiu", "ad_extreme", "永久", "绝对化用语", "长期", ["永久居留", "永久基本农田"]),
  rule("ad.wanneng", "ad_extreme", "万能", "绝对化用语"),
  rule("ad.dujiawei", "ad_extreme", "史无前例", "绝对化用语"),
  rule("ad.chimingshangbiao", "ad_extreme", "驰名商标", "广告禁用词"),

  // ── 医疗健康违规（severity 2）──
  rule("med.genzhi", "medical", "根治", "夸大疗效", "缓解"),
  rule("med.zhiyu", "medical", "治愈", "夸大疗效", "改善", ["治愈系"]),
  rule("med.baozhibaibing", "medical", "包治百病", "夸大疗效"),
  rule("med.yaodaobingchu", "medical", "药到病除", "夸大疗效"),
  rule("med.shenyao", "medical", "神药", "夸大疗效"),
  rule("med.texiao", "medical", "特效", "夸大疗效", ["特效电影"]),
  rule("med.wudufuzuoyong", "medical", "无毒副作用", "夸大宣传"),
  rule("med.kangai", "medical", "抗癌", "夸大疗效"),
  rule("med.fangai", "medical", "防癌", "夸大疗效"),

  // ── 金融违规（severity 2）──
  rule("fin.baoben", "finance", "保本", "违规承诺收益"),
  rule("fin.baoshouyi", "finance", "保收益", "违规承诺收益"),
  rule("fin.wenzhuanbupei", "finance", "稳赚不赔", "违规承诺收益"),
  rule("fin.wenzhuan", "finance", "稳赚", "违规承诺收益"),
  rule("fin.lingfengxian", "finance", "零风险", "违规承诺收益"),
  rule("fin.baozhuan", "finance", "包赚", "违规承诺收益"),
  rule("fin.jiangu", "finance", "荐股", "无资质荐股违规"),
  rule("fin.neimuxiaoxi", "finance", "内幕消息", "违规信息"),
  rule("fin.yiyebaofu", "finance", "一夜暴富", "夸大收益"),
  rule("fin.tangzhuan", "finance", "躺赚", "夸大收益"),

  // ── 诱导导流（severity 2）。字面词 + 见 REGEX_RULES 的号码/微信号 ──
  rule("div.jiaweixin", "divert", "加微信", "诱导导流"),
  rule("div.jiawo", "divert", "加我微信", "诱导导流"),
  rule("div.saomajinqun", "divert", "扫码进群", "诱导导流"),
  rule("div.changanerweima", "divert", "长按二维码", "诱导导流"),
  rule("div.saomiaoerweima", "divert", "扫描二维码", "诱导导流"),
  rule("div.guanzhulingqu", "divert", "关注领取", "诱导关注"),
  rule("div.zhuanfalingqu", "divert", "转发领取", "诱导转发"),
  rule("div.jizan", "divert", "集赞", "诱导分享"),
  rule("div.dianzanlingqu", "divert", "点赞领取", "诱导分享"),
  rule("div.sixinwo", "divert", "私信我", "诱导导流"),
  rule("div.jinqunlingqu", "divert", "进群领取", "诱导导流"),

  // ── 标题党（severity 1）──
  rule("cb.zhenjing", "clickbait", "震惊", "标题党"),
  rule("cb.buzhuan", "clickbait", "不转不是中国人", "道德绑架式诱导"),
  rule("cb.99budongd", "clickbait", "99%的人都不知道", "标题党"),
  rule("cb.shankan", "clickbait", "删前速看", "标题党"),
  rule("cb.huobao", "clickbait", "火爆全网", "夸张表述"),
  rule("cb.wanwanmeixiangdao", "clickbait", "万万没想到", "标题党"),
  rule("cb.jingdaile", "clickbait", "惊呆了", "标题党"),
  rule("cb.taikepa", "clickbait", "太可怕了", "标题党"),

  // ── 色情低俗（severity 3，极简集）──
  rule("porn.yuepao", "porn_vulgar", "约炮", "低俗内容"),
  rule("porn.luoliao", "porn_vulgar", "裸聊", "低俗内容"),
  rule("porn.yiyeqing", "porn_vulgar", "一夜情", "低俗内容"),

  // ── 违法违规（severity 3，极简集）──
  rule("ill.bocai", "illegal", "博彩", "涉赌"),
  rule("ill.duqiu", "illegal", "赌球", "涉赌"),
  rule("ill.daikaifapiao", "illegal", "代开发票", "违法交易"),
  rule("ill.banzheng", "illegal", "办证刻章", "违法交易"),
  rule("ill.jiazheng", "illegal", "假证", "违法交易"),
  rule("ill.xiqian", "illegal", "洗钱", "违法交易")
]);

/**
 * 正则规则：模式类（号码 / 微信号 / 外链等）。
 * @typedef {{ id:string, category:string, severity:number, source:string,
 *   flags?:string, reason:string, suggestion?:string }} RegexRule
 */
export const REGEX_RULES = Object.freeze([
  {
    id: "div.phone",
    category: "divert",
    severity: 2,
    source: "(?<![0-9])1[3-9]\\d{9}(?![0-9])",
    flags: "g",
    reason: "疑似手机号，公众号正文留个人联系方式易被判诱导导流",
    suggestion: "删除或改为引导到公众号菜单 / official 渠道"
  },
  {
    id: "div.wechatid",
    category: "divert",
    severity: 2,
    source: "(微信号?|薇信|威信|加\\s*[vV]|[vV][xX]|[wW][xX])\\s*[:：]?\\s*[a-zA-Z][a-zA-Z0-9_-]{4,19}",
    flags: "g",
    reason: "疑似引导加微信号，易被判诱导导流",
    suggestion: "删除外部微信号引流"
  },
  {
    id: "div.qq",
    category: "divert",
    severity: 2,
    source: "(QQ|qq|扣扣)\\s*[群号]?\\s*[:：]?\\s*\\d{5,11}",
    flags: "g",
    reason: "疑似 QQ / QQ 群引流",
    suggestion: "删除外部导流"
  }
]);

// 内部：字面规则工厂，severity 取分类默认
function rule(id, category, term, reason, replace, whitelist) {
  const severity = CATEGORY_META[category]?.severity ?? SEVERITY.WARN;
  const out = { id, category, severity, term, reason: reason || CATEGORY_META[category]?.note || "" };
  if (typeof replace === "string") {
    out.replace = replace;
    out.suggestion = `建议改为「${replace}」`;
  } else if (Array.isArray(replace)) {
    // 第 5 参直接传 whitelist 的情况（无 replace）
    out.whitelist = replace;
  }
  if (Array.isArray(whitelist)) out.whitelist = whitelist;
  return out;
}

export function severityLabel(severity) {
  if (severity >= SEVERITY.BLOCK) return "高危";
  if (severity >= SEVERITY.WARN) return "违规";
  return "提示";
}

export function severityLevel(severity) {
  if (severity >= SEVERITY.BLOCK) return "block";
  if (severity >= SEVERITY.WARN) return "warn";
  return "hint";
}
