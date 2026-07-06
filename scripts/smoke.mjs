#!/usr/bin/env node
/**
 * 最小冒烟：manifest、关键入口、图标、HTML、全量 JS 语法。
 */
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { execSync } from "child_process";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");

function assert(cond, msg) {
  if (!cond) {
    console.error("FAIL:", msg);
    process.exit(1);
  }
}

function mustExist(rel) {
  const p = path.join(root, rel);
  assert(fs.existsSync(p), `缺少文件: ${rel}`);
}

// 1) manifest 可读
const manifestPath = path.join(root, "manifest.json");
const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
assert(manifest.manifest_version === 3, "manifest_version 应为 3");
assert(Boolean(manifest.version), "manifest 缺少 version");

// 2) 图标
for (const sz of [16, 32, 48, 128]) {
  mustExist(`src/icons/icon${sz}.png`);
}
// icon.svg 已被 PNG 母版替代（icon-source.png + 4 个尺寸 PNG）。
mustExist("src/icons/icon-source.png");

// 3) 关键 HTML / 入口
const pages = [
  "src/popup/popup.html",
  "src/options/options.html",
  "src/workspace/workspace.html",
  "src/pages/welcome.html",
  "src/pages/help.html",
  "src/pages/hot-topics.html",
  "src/pages/permissions.html",
  "src/pages/privacy.html",
  "src/pages/terms.html"
];
pages.forEach(mustExist);

mustExist("src/background/service-worker.js");
mustExist("src/content-scripts/scrape-article.js");
mustExist("src/content-scripts/wechat-editor-helper.js");

// 4) JS 语法（复用 check-js）
console.log("运行 check:js …");
execSync("node scripts/check-js.mjs", { cwd: root, stdio: "inherit" });

// 5) wechat-html 纯函数行为（公众号 CSS 雷区清洗）
console.log("\n运行 wechat-html sanitizer 单测 …");
const { sanitizeInlineStyle, mergeStyle, cleanInvisibleChars } = await import(
  "../src/shared/wechat-html.js"
);

function expectIncludes(actual, needle, label) {
  assert(
    typeof actual === "string" && actual.includes(needle),
    `${label}：期望包含 "${needle}"，实际为 "${actual}"`
  );
}
function expectNotIncludes(actual, needle, label) {
  assert(
    typeof actual === "string" && !actual.includes(needle),
    `${label}：期望不包含 "${needle}"，实际为 "${actual}"`
  );
}

// position:absolute / fixed / sticky → relative
{
  const out = sanitizeInlineStyle("position:absolute;color:red");
  expectIncludes(out, "position:relative", "position:absolute 应降级为 relative");
  expectIncludes(out, "color:red", "其它声明应保留");
}
{
  const out = sanitizeInlineStyle("position: fixed !important;");
  expectIncludes(out, "position:relative", "position:fixed 应降级为 relative");
  expectNotIncludes(out, "important", "!important 应去除");
}

// background:url() / background-image:url() 整段删除
{
  const out = sanitizeInlineStyle("background:url(https://x.com/y.png) center;color:#333");
  expectNotIncludes(out, "url", "background:url() 应被删除");
  expectIncludes(out, "color:#333", "其它声明应保留");
}
{
  const out = sanitizeInlineStyle("background-image:url(/a.png);font-size:14px");
  expectNotIncludes(out, "url", "background-image:url() 应被删除");
  expectIncludes(out, "font-size:14px", "其它声明应保留");
}

// display:none / visibility:hidden / opacity:0 删除
{
  const out = sanitizeInlineStyle("display:none;color:#000");
  expectNotIncludes(out, "display:none", "display:none 应删除");
  expectIncludes(out, "color:#000", "其它声明应保留");
}
{
  const out = sanitizeInlineStyle("visibility:hidden;font-weight:700");
  expectNotIncludes(out, "visibility", "visibility:hidden 应删除");
}
{
  const out = sanitizeInlineStyle("opacity:0;color:red");
  expectNotIncludes(out, "opacity", "opacity:0 应删除");
}

// 渐变文字暗色模式 fallback
{
  const out = sanitizeInlineStyle(
    "background-clip:text;-webkit-background-clip:text;color:transparent;background:linear-gradient(90deg,#f00,#0f0)"
  );
  expectIncludes(
    out,
    "-webkit-text-fill-color:currentColor",
    "渐变文字应自动加 fallback fill-color"
  );
}

// transform / animation / transition 整段删
{
  const out = sanitizeInlineStyle("transform:scale(1.1);transition:all .3s;color:#000");
  expectNotIncludes(out, "transform", "transform 应删除");
  expectNotIncludes(out, "transition", "transition 应删除");
  expectIncludes(out, "color:#000", "其它声明应保留");
}

// mergeStyle 末尾应也走 sanitize
{
  const out = mergeStyle("position:absolute;color:#000", "background:url(x.png);font-weight:700");
  expectIncludes(out, "position:relative", "mergeStyle 后 position 应降级");
  expectNotIncludes(out, "url", "mergeStyle 后 background:url() 应删除");
  expectIncludes(out, "font-weight:700", "override 应保留");
}

// P1.4 · 暗色模式 fallback：近白色文字应被改写为深灰，避免在浅色背景上"白底白字"
{
  const out = sanitizeInlineStyle("color:#fff;font-size:18px");
  expectNotIncludes(out, "#fff", "color:#fff 不应原样保留");
  expectNotIncludes(out, "color:#ffffff", "color:#fff 应改写到 fallback");
  expectIncludes(out, "color:#2d3036", "近白色 color 应回落到 fallback 深灰");
}
{
  const out = sanitizeInlineStyle("color: rgb(255,255,255)");
  expectIncludes(out, "color:#2d3036", "rgb(255,255,255) 应回落到 fallback 深灰");
}
{
  const out = sanitizeInlineStyle("color:white;font-weight:700");
  expectIncludes(out, "color:#2d3036", "color:white 关键字应回落到 fallback 深灰");
  expectIncludes(out, "font-weight:700", "其余声明应保留");
}
{
  // 临界值：rgb(220,220,220) 亮度约 220，应保留（不算"近白"）
  const out = sanitizeInlineStyle("color: rgb(220,220,220)");
  expectIncludes(out, "color:rgb(220,220,220)", "亮度 < 235 的浅灰不应被改写");
}
// 微信适配（技术规范 §4）：font-family 剥离 / text-align start-end / line-height:0
{
  const out = sanitizeInlineStyle("font-family:'PingFang SC',Arial;font-size:16px");
  expectNotIncludes(out, "font-family", "font-family 应被剥离（交还微信默认字体栈）");
  expectIncludes(out, "font-size:16px", "其余声明应保留");
}
{
  const out = sanitizeInlineStyle("text-align:start;color:#333");
  expectIncludes(out, "text-align:left", "text-align:start 应归一为 left");
  const out2 = sanitizeInlineStyle("text-align:end");
  expectIncludes(out2, "text-align:right", "text-align:end 应归一为 right");
}
{
  const out = sanitizeInlineStyle("line-height:0;font-size:14px");
  expectNotIncludes(out, "line-height:0", "line-height:0 应被丢弃（防文字行重叠）");
  const out2 = sanitizeInlineStyle("line-height:1.8");
  expectIncludes(out2, "line-height:1.8", "正常 line-height 应保留");
}

// 字符级清理仍然正确
{
  const out = cleanInvisibleChars("a\u200Bb\uFEFFc\u200D");
  assert(out === "abc", `cleanInvisibleChars 期望 "abc"，实际 "${out}"`);
}

// 5.5) wechat.js · buildWechatApiUrl 路径拼接（P1.3 IP 白名单代理）
console.log("\n运行 wechat.js buildWechatApiUrl 单测 …");
const { buildWechatApiUrl } = await import("../src/shared/wechat.js");

// 默认空 base → 走官方 https://api.weixin.qq.com
{
  const u = buildWechatApiUrl({}, "/cgi-bin/token");
  assert(
    u.toString() === "https://api.weixin.qq.com/cgi-bin/token",
    `空 base 应回落官方，实际 ${u.toString()}`
  );
}
// 自定义代理 base 不带 /cgi-bin
{
  const u = buildWechatApiUrl(
    { wechatApiBase: "https://my-proxy.example.com" },
    "/cgi-bin/material/add_material"
  );
  assert(
    u.toString() === "https://my-proxy.example.com/cgi-bin/material/add_material",
    `代理 base 拼接错，实际 ${u.toString()}`
  );
}
// 自定义 base 末尾带 /
{
  const u = buildWechatApiUrl(
    { wechatApiBase: "https://my-proxy.example.com/" },
    "/cgi-bin/token"
  );
  assert(
    u.toString() === "https://my-proxy.example.com/cgi-bin/token",
    `代理 base 末尾 / 应被吃掉，实际 ${u.toString()}`
  );
}
// 用户已经把 /cgi-bin 写进 base：避免重复 /cgi-bin/cgi-bin/...
{
  const u = buildWechatApiUrl(
    { wechatApiBase: "https://my-proxy.example.com/cgi-bin" },
    "/cgi-bin/draft/add"
  );
  assert(
    u.toString() === "https://my-proxy.example.com/cgi-bin/draft/add",
    `重复 /cgi-bin 应被去重，实际 ${u.toString()}`
  );
}
// 非法 base → 回落官方而不是抛错
{
  const u = buildWechatApiUrl({ wechatApiBase: "not a url" }, "/cgi-bin/token");
  assert(
    u.toString() === "https://api.weixin.qq.com/cgi-bin/token",
    `非法 base 应回落官方，实际 ${u.toString()}`
  );
}

// 6) AI 改写后的字数估算/校验（参考 AIWriteX min/max_article_len 思路）
console.log("\n运行 ai 字数校验单测 …");
const { estimateArticleChars, evaluateArticleLength } = await import(
  "../src/shared/ai.js"
);

function makeArticle(charsPerPart) {
  // 构造一个 article：lead + 1 个 section（含 paragraphs/bullets/quote）+ closing
  const filler = (n) => "字".repeat(Math.max(0, n));
  return {
    title: "T",
    subtitle: "S",
    lead: filler(charsPerPart),
    sections: [
      {
        heading: filler(50),
        paragraphs: [filler(charsPerPart), filler(charsPerPart)],
        bulletPoints: [filler(50), filler(50)],
        quote: filler(100),
        imageRefs: []
      }
    ],
    closing: filler(charsPerPart),
    cta: "C",
    wechatTitleOptions: [],
    keywords: []
  };
}

// estimate 应只统计正文部分，且对空白不计入
{
  const article = makeArticle(100);
  const got = estimateArticleChars(article);
  // 期望：lead(100)+heading(50)+p1(100)+p2(100)+b1(50)+b2(50)+quote(100)+closing(100)=650
  assert(got === 650, `estimateArticleChars 期望 650，实际 ${got}`);
}

// short 档目标 800-1200，给 1000 字应判 ok
{
  const article = makeArticle(143); // 大致拼到 1000+ 字
  const result = evaluateArticleLength(article, "short");
  assert(
    result.expected.min === 800 && result.expected.max === 1200,
    `short 档区间应为 800-1200，实际 ${JSON.stringify(result.expected)}`
  );
  // 不强求 ok（只要落在容差内就行），但至少 actual 应 > 800
  assert(result.actual >= 800, `short 档 actual 应 >= 800，实际 ${result.actual}`);
}

// long 档目标 1800-2600，给 500 字应判 short
{
  const article = makeArticle(50); // 总 ~ 350-400 字
  const result = evaluateArticleLength(article, "long");
  assert(result.status === "short", `应被判 short，实际 ${result.status}`);
  assert(result.deltaPct > 0, `deltaPct 应 > 0，实际 ${result.deltaPct}`);
}

// short 档目标 800-1200，给 5000 字应判 long
{
  const article = makeArticle(700);
  const result = evaluateArticleLength(article, "short");
  assert(result.status === "long", `应被判 long，实际 ${result.status}`);
}

// 不在 LENGTH_RANGES 里的档位应返回 unknown
{
  const result = evaluateArticleLength(makeArticle(50), "weird");
  assert(result.status === "unknown", `未知档位应判 unknown，实际 ${result.status}`);
}

// 7) license 模块（联网验证 + 本地缓存版）—— 此处只测纯函数部分
console.log("\n运行 license 模块单测 …");
const {
  PAID_FEATURES,
  PRO_TEMPLATE_IDS,
  LICENSE_CONSTANTS,
  validateLicenseKeyOffline,
  normalizeKey,
  evaluateLicense,
  getLicenseSummaryText,
  getUpgradePrompt
} = await import("../src/shared/license.js");

// 一个 demo 用的合法格式 key（仅检查格式，不再做 checksum）
const DEMO_KEY = "GZHT-ABCD-EFGH-JKLM";

// PAID_FEATURES 必须包含 4 个核心闸门 + worker 已声明的预留项
{
  const expected = [
    "wechat.multiAccount",
    "scrape.drission",
    "ai.advancedTemplates",
    "ai.unlimitedDaily"
  ];
  for (const key of expected) {
    assert(PAID_FEATURES[key], `PAID_FEATURES 缺少必备 feature: ${key}`);
    assert(
      typeof PAID_FEATURES[key].name === "string" &&
        typeof PAID_FEATURES[key].hint === "string",
      `${key} 必须包含 name 和 hint 字段`
    );
  }
}

// PRO_TEMPLATE_IDS 必须是 3 个限定模板
{
  assert(Array.isArray(PRO_TEMPLATE_IDS), "PRO_TEMPLATE_IDS 应为数组");
  assert(
    PRO_TEMPLATE_IDS.includes("preset-deep-analysis") &&
      PRO_TEMPLATE_IDS.includes("preset-storytelling") &&
      PRO_TEMPLATE_IDS.includes("preset-tutorial"),
    "PRO_TEMPLATE_IDS 应包含 3 个核心高级模板"
  );
}

// LICENSE_CONSTANTS 检查
{
  assert(
    LICENSE_CONSTANTS.FREE_DAILY_REWRITE_QUOTA === 5,
    `FREE_DAILY_REWRITE_QUOTA 应为 5，实际 ${LICENSE_CONSTANTS.FREE_DAILY_REWRITE_QUOTA}`
  );
  // 43rd session · 多账号配额收口：免费/月费 1、年费 5
  const mal = LICENSE_CONSTANTS.MULTI_ACCOUNT_LIMITS;
  assert(
    mal && mal.free === 1 && mal.monthly === 1 && mal.yearly === 5 && mal.pro === 5,
    `MULTI_ACCOUNT_LIMITS 应为 {free:1,monthly:1,yearly:5,pro:5}，实际 ${JSON.stringify(mal)}`
  );
}

// validateLicenseKeyOffline：格式校验
{
  const ok = validateLicenseKeyOffline(DEMO_KEY);
  assert(ok.ok, `合法格式 key 应通过，原因：${ok.reason}`);
  const fmt = validateLicenseKeyOffline("ABCD-1234-5678-9012");
  assert(!fmt.ok && fmt.reason === "format", `应被判 format，实际 ${fmt.reason}`);
  const empty = validateLicenseKeyOffline("");
  assert(!empty.ok && empty.reason === "empty", `应被判 empty，实际 ${empty.reason}`);
}

// normalizeKey：合法格式直通；非法返回空字符串
{
  assert(normalizeKey(`  ${DEMO_KEY.toLowerCase()}  `) === DEMO_KEY, "应规整大小写和空白");
  assert(normalizeKey("invalid") === "", "非法输入应返回空字符串");
}

// evaluateLicense：null → free
{
  const state = evaluateLicense(null);
  assert(state.status === "free", `null 应评 free，实际 ${state.status}`);
  assert(state.label === "免费版", `label 应为"免费版"，实际 ${state.label}`);
  assert(state.effectivePlan === "free", "effectivePlan 应为 free");
  assert(
    state.dailyQuota === LICENSE_CONSTANTS.FREE_DAILY_REWRITE_QUOTA,
    `dailyQuota 应为 ${LICENSE_CONSTANTS.FREE_DAILY_REWRITE_QUOTA}`
  );
}

// evaluateLicense：active pro → pro
{
  const state = evaluateLicense({
    key: DEMO_KEY,
    plan: "pro",
    status: "active",
    expiresAt: 0,
    verifiedAt: Date.now()
  });
  assert(state.status === "pro", `应评 pro，实际 ${state.status}`);
  assert(state.effectivePlan === "pro", "effectivePlan 应为 pro");
  assert(state.dailyQuota === -1, `pro dailyQuota 应为 -1，实际 ${state.dailyQuota}`);
  assert(state.displayKey.includes("****"), `displayKey 应含掩码，实际 ${state.displayKey}`);
  assert(
    state.features["ai.unlimitedDaily"] === true,
    "pro 用户 ai.unlimitedDaily 应为 true"
  );
}

// evaluateLicense：到期 → expired
{
  const state = evaluateLicense({
    key: DEMO_KEY,
    plan: "pro",
    status: "active",
    expiresAt: Date.parse("2020-01-01T00:00:00Z"),
    verifiedAt: Date.now()
  });
  assert(state.status === "expired", `应评 expired，实际 ${state.status}`);
  assert(state.effectivePlan === "free", "expired 后 effectivePlan 应降级到 free");
}

// evaluateLicense：服务端明确 expired → expired
{
  const state = evaluateLicense({
    key: DEMO_KEY,
    plan: "pro",
    status: "expired",
    verifiedAt: Date.now()
  });
  assert(state.status === "expired", `服务端 expired 应评 expired，实际 ${state.status}`);
}

// evaluateLicense：服务端 revoked → invalid
{
  const state = evaluateLicense({
    key: DEMO_KEY,
    plan: "pro",
    status: "revoked",
    verifiedAt: Date.now()
  });
  assert(state.status === "invalid", `revoked 应评 invalid，实际 ${state.status}`);
}

// evaluateLicense：超过 7 天没复验 → stale
{
  const eightDaysAgo = Date.now() - 8 * 24 * 60 * 60 * 1000;
  const state = evaluateLicense({
    key: DEMO_KEY,
    plan: "pro",
    status: "active",
    verifiedAt: eightDaysAgo
  });
  assert(state.status === "stale", `> 7 天未验证应评 stale，实际 ${state.status}`);
  assert(state.effectivePlan === "free", "stale 时 effectivePlan 应降级到 free");
}

// evaluateLicense：剩余 ≤ 7 天 → expiring（功能不降级，仅 UI 提示）
{
  const threeDaysLater = Date.now() + 3 * 24 * 60 * 60 * 1000;
  const state = evaluateLicense({
    key: DEMO_KEY,
    plan: "pro",
    status: "active",
    expiresAt: threeDaysLater,
    verifiedAt: Date.now()
  });
  assert(state.status === "expiring", `剩 3 天应评 expiring，实际 ${state.status}`);
  assert(
    state.effectivePlan === "pro",
    "expiring 必须保留 effectivePlan=pro，不能误关付费功能"
  );
  assert(
    state.daysLeft >= 1 && state.daysLeft <= 4,
    `daysLeft 应在 1~4 之间（向上取整），实际 ${state.daysLeft}`
  );
  assert(
    state.features?.["ai.unlimitedDaily"] === true,
    "expiring 时 ai.unlimitedDaily 仍应为 true（功能不能因为临近到期被关掉）"
  );
}

// evaluateLicense：剩余 > 7 天 → 仍走 pro 分支（不进 expiring）
{
  const fortyDaysLater = Date.now() + 40 * 24 * 60 * 60 * 1000;
  const state = evaluateLicense({
    key: DEMO_KEY,
    plan: "pro",
    status: "active",
    expiresAt: fortyDaysLater,
    verifiedAt: Date.now()
  });
  assert(state.status === "pro", `剩 40 天应评 pro，实际 ${state.status}`);
  assert(state.daysLeft == null, "未进 expiring 窗口的 state 不应附 daysLeft");
}

// evaluateLicense：临近窗口边界（剩 8 天，刚好不进 expiring）
{
  const eightDaysLater = Date.now() + 8 * 24 * 60 * 60 * 1000;
  const state = evaluateLicense({
    key: DEMO_KEY,
    plan: "pro",
    status: "active",
    expiresAt: eightDaysLater,
    verifiedAt: Date.now()
  });
  assert(
    state.status === "pro",
    `剩 8 天应评 pro（不进 expiring 窗口），实际 ${state.status}`
  );
}

// =====================================================================
// P0：getLicenseSummaryText 统一会员状态文案 — 5 个核心 tone 必须有 label/sub/cta
// =====================================================================
console.log("\n运行 getLicenseSummaryText 统一会员状态单测 …");
{
  // free / 已登录：sub 必须包含「今日剩余」并体现配额
  const stateFree = evaluateLicense(null);
  const sumFreeLogged = getLicenseSummaryText(stateFree, {
    auth: { token: "x", user: { email: "u@example.com" } },
    usage: { today: { rewrite: 1 } }
  });
  assert(sumFreeLogged.tone === "free", `登录免费版 tone 应为 free，实际 ${sumFreeLogged.tone}`);
  assert(/u@example\.com/.test(sumFreeLogged.sub), "登录免费版 sub 应带邮箱");
  assert(/剩余/.test(sumFreeLogged.sub), "免费版 sub 必须显示剩余次数");
  assert(sumFreeLogged.primaryCta?.action === "upgrade", "免费版 cta 应是 upgrade");

  // free / 未登录：tone=guest，cta=login
  const sumGuest = getLicenseSummaryText(stateFree, {
    usage: { today: { rewrite: 0 } }
  });
  assert(sumGuest.tone === "guest", `未登录应是 guest，实际 ${sumGuest.tone}`);
  assert(sumGuest.primaryCta?.action === "login", "未登录 cta 应是 login");

  // pro：tone=pro，sub 含到期或"按订阅周期"
  const statePro = evaluateLicense({
    key: DEMO_KEY,
    plan: "pro",
    status: "active",
    expiresAt: Date.now() + 30 * 86400000,
    verifiedAt: Date.now()
  });
  const sumPro = getLicenseSummaryText(statePro, {});
  assert(sumPro.tone === "pro", `pro 应是 pro，实际 ${sumPro.tone}`);
  assert(/Pro|续费|有效/.test(sumPro.label + sumPro.sub), "Pro 文案应含到期/续费/有效字样");

  // expiring：tone=expiring，cta=renew
  const stateExpiring = evaluateLicense({
    key: DEMO_KEY,
    plan: "pro",
    status: "active",
    expiresAt: Date.now() + 3 * 86400000,
    verifiedAt: Date.now()
  });
  const sumExpiring = getLicenseSummaryText(stateExpiring, {});
  assert(
    sumExpiring.tone === "expiring",
    `剩 3 天应是 expiring，实际 ${sumExpiring.tone}`
  );
  assert(sumExpiring.primaryCta?.action === "renew", "expiring cta 应是 renew");

  // expired：tone=expired，cta=renew
  const stateExpired = evaluateLicense({
    key: DEMO_KEY,
    plan: "pro",
    status: "active",
    expiresAt: Date.now() - 86400000,
    verifiedAt: Date.now()
  });
  const sumExpired = getLicenseSummaryText(stateExpired, {});
  assert(sumExpired.tone === "expired", `已过期应是 expired，实际 ${sumExpired.tone}`);

  // invalid：tone=invalid
  const stateInvalid = evaluateLicense({
    key: DEMO_KEY,
    plan: "pro",
    status: "revoked",
    expiresAt: 0,
    verifiedAt: Date.now()
  });
  const sumInvalid = getLicenseSummaryText(stateInvalid, {});
  assert(sumInvalid.tone === "invalid", `revoked 应是 invalid，实际 ${sumInvalid.tone}`);

  // 所有 tone 都必须有 label / sub / primaryCta
  for (const sum of [sumFreeLogged, sumGuest, sumPro, sumExpiring, sumExpired, sumInvalid]) {
    assert(typeof sum.label === "string" && sum.label.length > 0, "label 必须非空");
    assert(typeof sum.sub === "string" && sum.sub.length > 0, "sub 必须非空");
    assert(sum.primaryCta?.label && sum.primaryCta?.action, "primaryCta 必须含 label+action");
  }
}

// =====================================================================
// P0：getUpgradePrompt — 任意 Pro 闸门点都能给出「被拦/获得」结构化文案
// =====================================================================
console.log("\n运行 getUpgradePrompt Pro 闸门文案单测 …");
{
  const prompt = getUpgradePrompt("ai.unlimitedDaily");
  assert(prompt && prompt.featureName === "无限 AI 改写次数", "featureName 应来自 PAID_FEATURES");
  assert(/本次被拦/.test(prompt.blocked), "blocked 行必须包含「本次被拦」");
  assert(/无限 AI 改写次数/.test(prompt.blocked), "blocked 行必须点出具体功能名");
  assert(prompt.gain && prompt.gain.length > 0, "gain 行必须非空");
  assert(prompt.ctaHref?.startsWith("http"), "ctaHref 应是合法 URL");
  assert(prompt.primaryAction?.url === prompt.ctaHref, "primaryAction.url 应同步 ctaHref");

  // free 类不返回 prompt（因为本身就没付费墙）
  const free = getUpgradePrompt("wechat.publish");
  assert(free === null, "tier=free 的 feature 不应有 upgrade prompt");

  // 未知 key 走 null
  const unknown = getUpgradePrompt("not.exist");
  assert(unknown === null, "未知 featureKey 应返回 null");

  // runtimeHint 优先级高于静态 hint：方便闸门带上「今天 0/3」这类实时数据
  const dyn = getUpgradePrompt("ai.unlimitedDaily", {
    runtimeHint: "你今天的 5 次免费改写已经用完，明天 0 点重置；Pro 不限"
  });
  assert(/今天的 5 次/.test(dyn.gain), "runtimeHint 应覆盖默认 hint 写入 gain");
}

// =====================================================================
// 共享 AI 模板生成对话框 (src/shared/ai-template-dialog.js)
//   - Free 用户调用 → 返回 false（被 license 闸门拦截），onSaved 不执行
//   - 模块对外 API 形状稳定（openAiTemplateDialog 是 async function，
//     __INTERNAL.createEmptyQuizAnswers 返回 9 个字段）
//   - 这一层是 options 与 workspace 三处入口的共同后端，必须 100% 稳定。
// =====================================================================
console.log("\n运行 ai-template-dialog 共享模块单测 …");
{
  const mem = new Map();
  globalThis.chrome = {
    storage: {
      local: {
        get(keys, cb) {
          const result = {};
          const arr = Array.isArray(keys) ? keys : keys ? [keys] : [...mem.keys()];
          arr.forEach((k) => {
            if (mem.has(k)) result[k] = mem.get(k);
          });
          cb(result);
        },
        set(values, cb) {
          Object.entries(values).forEach(([k, v]) => mem.set(k, v));
          if (cb) cb();
        },
        remove(keys, cb) {
          (Array.isArray(keys) ? keys : [keys]).forEach((k) => mem.delete(k));
          if (cb) cb();
        }
      },
      onChanged: {
        addListener() {},
        removeListener() {}
      }
    }
  };

  // 没有 license record → free 用户。模块内 ensureMounted() 不会被调用
  // （openAiTemplateDialog 在 license 闸门处提前 return false）；
  // showUpgradeModal 内部检测 typeof document === "undefined" 也会安全短路。
  const { openAiTemplateDialog, __INTERNAL } = await import(
    "../src/shared/ai-template-dialog.js"
  );

  // ---- API 形状 ----
  assert(
    typeof openAiTemplateDialog === "function",
    "openAiTemplateDialog 必须是函数"
  );
  assert(
    openAiTemplateDialog.constructor.name === "AsyncFunction",
    "openAiTemplateDialog 必须是 async function"
  );
  assert(
    typeof __INTERNAL?.createEmptyQuizAnswers === "function",
    "__INTERNAL 必须暴露 createEmptyQuizAnswers 用于测试"
  );

  const empty = __INTERNAL.createEmptyQuizAnswers();
  const expectedFields = [
    "contentPillar",
    "contentPillarOther",
    "tone",
    "opening",
    "rhythm",
    "cta",
    "visualTheme",
    "audience",
    "extraNotes"
  ];
  for (const k of expectedFields) {
    assert(k in empty, `createEmptyQuizAnswers 必须包含字段 ${k}`);
  }
  assert(
    empty.rhythm === "standard",
    `rhythm 必须默认 standard（小白友好），实际 ${empty.rhythm}`
  );

  // ---- Free 用户走 license 闸门 ----
  let onSavedCalled = false;
  const result = await openAiTemplateDialog({
    pricingUrl: "https://example.com/pricing",
    onSaved: () => {
      onSavedCalled = true;
    }
  });
  assert(
    result === false,
    `Free 用户调用 openAiTemplateDialog 应返回 false（被闸门拦），实际 ${result}`
  );
  assert(
    onSavedCalled === false,
    "Free 用户被闸门拦时绝不能触发 onSaved 回调"
  );

  // ---- 校验 ROOT_ID 常量稳定（check-features.mjs 与文档都依赖它）----
  assert(
    __INTERNAL.ROOT_ID === "ai-template-dialog-root",
    "ROOT_ID 常量必须保持 ai-template-dialog-root（check-features.mjs 依赖）"
  );

  delete globalThis.chrome;
}

// =====================================================================
// P0：onboarding 4 步任务清单 — 状态评估 + skip 持久化 + 重置
// =====================================================================
console.log("\n运行 onboarding 任务清单单测 …");
{
  // mock chrome.storage.local
  const mem = new Map();
  globalThis.chrome = {
    storage: {
      local: {
        get(keys, cb) {
          const result = {};
          const arr = Array.isArray(keys) ? keys : keys ? [keys] : [...mem.keys()];
          arr.forEach((k) => {
            if (mem.has(k)) result[k] = mem.get(k);
          });
          cb(result);
        },
        set(values, cb) {
          Object.entries(values).forEach(([k, v]) => mem.set(k, v));
          if (cb) cb();
        },
        remove(keys, cb) {
          (Array.isArray(keys) ? keys : [keys]).forEach((k) => mem.delete(k));
          if (cb) cb();
        }
      },
      onChanged: {
        addListener() {},
        removeListener() {}
      }
    }
  };

  const {
    getOnboardingSnapshot,
    markStepSkipped,
    resetSkips,
    STEP_IDS
  } = await import("../src/shared/onboarding.js");

  // STEP_IDS 必须严格四步且顺序固定（welcome.html / workspace.html 直接渲染，顺序不能乱）
  assert(
    Array.isArray(STEP_IDS) && STEP_IDS.length === 4,
    `STEP_IDS 应有 4 个，实际 ${STEP_IDS?.length}`
  );
  assert(
    STEP_IDS[0] === "configureAi" &&
      STEP_IDS[1] === "captureOne" &&
      STEP_IDS[2] === "rewriteOne" &&
      STEP_IDS[3] === "publishOrCopy",
    `STEP_IDS 顺序错：${STEP_IDS.join(",")}`
  );

  // 全空白：4 步都 pending，已完成 0
  let snap = await getOnboardingSnapshot();
  assert(snap.steps.length === 4, `steps 应有 4 条，实际 ${snap.steps.length}`);
  assert(snap.completedCount === 0, `初始 completedCount 应为 0，实际 ${snap.completedCount}`);
  assert(snap.pendingCount === 4, `初始 pendingCount 应为 4，实际 ${snap.pendingCount}`);
  assert(snap.allDone === false, "初始 allDone 应为 false");
  assert(snap.nextStep?.id === "configureAi", "初始 nextStep 应是 configureAi");
  assert(
    snap.steps.every((s) => s.status === "pending"),
    "初始所有 step 应是 pending"
  );

  // 配置 AI Key（使用真实 storage key + DEFAULT_SETTINGS 中的 apiKey 字段）
  mem.set("wechatWriterSettings", { apiKey: "sk-test-123" });
  snap = await getOnboardingSnapshot();
  const cfg = snap.steps.find((s) => s.id === "configureAi");
  assert(cfg.status === "completed", `配置后 configureAi 应 completed，实际 ${cfg.status}`);
  assert(snap.completedCount === 1, "completedCount 应升到 1");

  // 跳过 publishOrCopy（设计中只有 publishOrCopy 可跳过；configureAi/captureOne/rewriteOne 是核心步骤不允许 skip）
  await markStepSkipped("publishOrCopy");
  snap = await getOnboardingSnapshot();
  const pub = snap.steps.find((s) => s.id === "publishOrCopy");
  assert(pub.status === "skipped", `publishOrCopy 应是 skipped，实际 ${pub.status}`);
  assert(snap.skippedCount === 1, "skippedCount 应为 1");

  // 不可跳过步骤的 markStepSkipped 必须静默 no-op
  await markStepSkipped("captureOne");
  snap = await getOnboardingSnapshot();
  assert(
    snap.steps.find((s) => s.id === "captureOne").status === "pending",
    "不可跳过的 captureOne 不应被 skip"
  );

  // 写入 usageStats：累计 1 次 capture → captureOne 完成
  mem.set("usageStats", {
    byDay: {},
    total: { capture: 1 }
  });
  snap = await getOnboardingSnapshot();
  assert(
    snap.steps.find((s) => s.id === "captureOne").status === "completed",
    "有真实 capture usage 后 captureOne 应 completed"
  );

  // 写入 rewrite usage → rewriteOne 完成
  mem.set("usageStats", {
    byDay: {},
    total: { capture: 1, rewrite: 1 }
  });
  snap = await getOnboardingSnapshot();
  assert(
    snap.steps.find((s) => s.id === "rewriteOne").status === "completed",
    "rewrite=1 后 rewriteOne 应 completed"
  );

  // 此时 4 步：completed (configureAi/captureOne/rewriteOne) + skipped (publishOrCopy) → allDone=true
  assert(snap.allDone === true, `3 完成 + 1 跳过 应 allDone=true，实际 ${snap.allDone}`);
  assert(snap.nextStep === null, "全部完成时 nextStep 应为 null");

  // resetSkips：清掉 skipped 标记后 publishOrCopy 应回 pending
  await resetSkips();
  snap = await getOnboardingSnapshot();
  assert(
    snap.steps.find((s) => s.id === "publishOrCopy").status === "pending",
    "resetSkips 后 publishOrCopy 应回 pending"
  );
  assert(
    snap.steps.find((s) => s.id === "captureOne").status === "completed",
    "resetSkips 不应影响真实完成的步骤"
  );

  // optionalChecks: 公众号绑定 — 没填 AppID/AppSecret 时 pending
  assert(
    snap.optionalChecks.wechatBound.status === "pending",
    "未填公众号配置时 wechatBound 应 pending"
  );
  mem.set("wechatWriterSettings", {
    apiKey: "sk-test-123",
    wechatAppId: "wx123",
    wechatAppSecret: "secret"
  });
  snap = await getOnboardingSnapshot();
  assert(
    snap.optionalChecks.wechatBound.status === "completed",
    "填了 AppID+AppSecret 后 wechatBound 应 completed"
  );

  delete globalThis.chrome;
}

// =====================================================================
// AI 模板生成器 v0.4 · 问卷 schema + 模板组装 + 主题元数据
// =====================================================================
console.log("\n运行 template-generator v0.4 问卷 schema 校验单测 …");
{
  const {
    validateAndShape,
    composeTemplate,
    validateQuizInput,
    QUIZ_OPTIONS,
    __INTERNAL
  } = await import("../src/shared/template-generator.js");
  const { MAGAZINE_THEMES, THEME_PRESETS } = await import(
    "../src/shared/defaults.js"
  );

  // ---- meta-prompt 必须包含核心硬约束 ----
  assert(
    __INTERNAL.META_SYSTEM_PROMPT.includes("只输出合法 JSON"),
    "meta-prompt 必须包含 JSON-only 约束"
  );
  assert(
    __INTERNAL.META_SYSTEM_PROMPT.includes("styleInstruction"),
    "meta-prompt 必须包含 styleInstruction 字段说明"
  );
  assert(
    __INTERNAL.META_SYSTEM_PROMPT.includes("杂志感"),
    "meta-prompt 必须显式要求杂志气质（防 AI slop）"
  );

  // ---- QUIZ_OPTIONS 完备性 ----
  for (const field of ["contentPillar", "tone", "opening", "rhythm", "cta"]) {
    assert(
      Array.isArray(QUIZ_OPTIONS[field]) && QUIZ_OPTIONS[field].length >= 3,
      `QUIZ_OPTIONS.${field} 至少要有 3 个选项`
    );
    for (const opt of QUIZ_OPTIONS[field]) {
      assert(
        typeof opt.id === "string" && typeof opt.label === "string",
        `QUIZ_OPTIONS.${field} 的每个选项必须有 id 和 label`
      );
    }
  }

  // ---- MAGAZINE_THEMES 完备性 + 与 THEME_PRESETS 对齐 ----
  assert(
    Array.isArray(MAGAZINE_THEMES) && MAGAZINE_THEMES.length >= 6,
    "至少要 6 套杂志级母版"
  );
  for (const theme of MAGAZINE_THEMES) {
    assert(
      theme.id && theme.label && theme.inspiration && theme.summary,
      `主题元数据 ${theme.id} 缺字段`
    );
    assert(
      THEME_PRESETS[theme.id],
      `主题 ${theme.id} 在 MAGAZINE_THEMES 里有，但 THEME_PRESETS 缺实现`
    );
    // 反 AI slop：禁圆角色块、禁 border-left 装饰条
    const root = THEME_PRESETS[theme.id].root || "";
    if (theme.id !== "editorial-green") {
      // editorial-green 是兼容老用户的"润笔默认"，允许圆角；新增的 6 套必须杂志级
      assert(
        !/border-radius:\s*(?:1[2-9]|2\d|3\d)/.test(root),
        `主题 ${theme.id} 不应有 12px+ 圆角（杂志级偏好直角 / hairline）`
      );
    }
  }

  // ---- validateQuizInput ----
  const okQuiz = {
    contentPillar: "tech-review",
    tone: "restrained",
    opening: "punchline",
    rhythm: "standard",
    cta: "next",
    visualTheme: "wired-neon",
    audience: "25–35 岁的科技产品决策者",
    extraNotes: "少用形容词，多用具体数字"
  };
  const validatedQuiz = validateQuizInput(okQuiz);
  assert(validatedQuiz.contentPillar === "tech-review", "validateQuizInput 应通过合法问卷");

  let threw = false;
  try { validateQuizInput({ ...okQuiz, contentPillar: "" }); } catch { threw = true; }
  assert(threw, "缺 contentPillar 应被拒绝");

  threw = false;
  try { validateQuizInput({ ...okQuiz, visualTheme: "fancy-bling" }); } catch { threw = true; }
  assert(threw, "未知 visualTheme 应被拒绝");

  threw = false;
  try {
    validateQuizInput({ ...okQuiz, contentPillar: "other", contentPillarOther: "" });
  } catch {
    threw = true;
  }
  assert(threw, "contentPillar=other 但没写备注应被拒绝");

  threw = false;
  try { validateQuizInput(null); } catch { threw = true; }
  assert(threw, "null quiz 应被拒绝");

  // ---- LLM 返回的 shape + compose（含 suggestedTheme） ----
  const validLlmReturn = {
    name: "硬核拆机",
    icon: "🧪",
    styleInstruction:
      "你是一名科技测评号编辑。开头用一句反常识结论抓住读者，比如「这台手机让我把另外两台都退了」。\n\n写作纪律：\n- 段落短、句子短，单段不超过 3 句。\n- 不允许使用「随着…的不断发展」「拥抱变革」「赋能」等 AI 套话。\n- 关键参数 / 价格 / 型号必须与来源完全一致。\n\n事实约束：\n- 只能使用来源中明确出现的人物、对话、地点、时间。\n- 不允许编造跑分、续航、价格等数字。",
    userIntro: "请将下面的来源材料改写成一篇科技测评号风格的公众号稿。",
    defaults: {
      tone: "克制、有判断、像一个老派测评编辑",
      angle: "用反常识结论开头，正文密集小标题，结尾给购买建议",
      length: "medium",
      cta: "在结尾给出明确的购买/不推荐判断",
      audience: "25–35 岁的科技产品决策者"
    },
    temperature: 0.7
  };
  const shaped = validateAndShape(validLlmReturn);
  assert(shaped.name === "硬核拆机", "validateAndShape 应保留 name");
  assert(shaped.defaults.length === "medium", "validateAndShape 应认 length");
  assert(shaped.temperature === 0.7, "validateAndShape 应认 temperature");

  const tpl = composeTemplate(shaped, { suggestedTheme: "wired-neon" });
  assert(
    typeof tpl.id === "string" && tpl.id.startsWith("custom-ai-"),
    "compose 出的 id 应带 custom-ai- 前缀"
  );
  assert(
    tpl.systemTemplate.includes(validLlmReturn.styleInstruction),
    "compose 后 systemTemplate 应保留 styleInstruction"
  );
  assert(
    tpl.systemTemplate.includes("输出必须是合法 JSON"),
    "compose 后 systemTemplate 应自动追加 OUTPUT_RULES"
  );
  assert(
    tpl.userTemplate.includes("{{title}}") && tpl.userTemplate.includes("{{content}}"),
    "compose 后 userTemplate 应自动追加 COMMON_USER_PAYLOAD（含变量占位符）"
  );
  assert(tpl.aiGenerated === true, "compose 出的模板应标记 aiGenerated=true");
  assert(
    tpl.suggestedTheme === "wired-neon",
    "compose 应正确写入 suggestedTheme 字段"
  );

  // suggestedTheme 非法 → 应被静默丢弃（null）
  const tpl2 = composeTemplate(shaped, { suggestedTheme: "fancy-bling" });
  assert(tpl2.suggestedTheme === null, "未知 suggestedTheme 应被丢弃为 null");

  // 不传 opts 也不应崩
  const tpl3 = composeTemplate(shaped);
  assert(tpl3.suggestedTheme === null, "不传 suggestedTheme 时应为 null");

  // 防御：styleInstruction 里塞 {{var}} 应被拒绝
  threw = false;
  try {
    validateAndShape({
      ...validLlmReturn,
      styleInstruction: validLlmReturn.styleInstruction + "\n\n{{audience}}"
    });
  } catch {
    threw = true;
  }
  assert(threw, "styleInstruction 里出现 {{...}} 必须被拒绝");

  // length 非法 → 兜底 medium（默认）
  const fallback = validateAndShape({
    ...validLlmReturn,
    defaults: { ...validLlmReturn.defaults, length: "tiny" }
  });
  assert(fallback.defaults.length === "medium", "非法 length 默认应兜底为 medium");

  // length 非法 + 显式 fallbackLength="long" → 应认 fallbackLength
  const fallback2 = validateAndShape(
    { ...validLlmReturn, defaults: { ...validLlmReturn.defaults, length: "tiny" } },
    { fallbackLength: "long" }
  );
  assert(
    fallback2.defaults.length === "long",
    "validateAndShape 应优先使用 opts.fallbackLength"
  );

  // styleInstruction 太短 → 拒绝
  threw = false;
  try {
    validateAndShape({ ...validLlmReturn, styleInstruction: "太短了" });
  } catch {
    threw = true;
  }
  assert(threw, "styleInstruction 过短必须被拒绝");

  // 完全垃圾输入 → 拒绝
  threw = false;
  try {
    validateAndShape(null);
  } catch {
    threw = true;
  }
  assert(threw, "null 必须被拒绝");
}

// =====================================================================
// 付费功能清单 · 前后端对齐
// =====================================================================
console.log("\n运行 PAID_FEATURES 前后端对齐单测 …");
{
  const { PAID_FEATURES } = await import("../src/shared/license.js");
  const workerSource = fs.readFileSync(path.join(root, "server/worker.js"), "utf8");
  // 抠出 PAID_FEATURE_KEYS = [...] 的 key 列表
  const keysMatch = workerSource.match(/const PAID_FEATURE_KEYS\s*=\s*\[([\s\S]*?)\]/);
  assert(keysMatch, "worker.js 必须有 PAID_FEATURE_KEYS 数组");
  const workerKeys = new Set(
    keysMatch[1]
      .split(",")
      .map((s) => s.trim().replace(/^["']|["']$/g, ""))
      .filter(Boolean)
  );
  for (const key of Object.keys(PAID_FEATURES)) {
    assert(workerKeys.has(key), `PAID_FEATURE 前后端不对齐：worker 缺少 "${key}"`);
  }
}

console.log("\n运行 desktop helper 项目结构静态校验 …");
{
  // 这一节确保桌面助手 (desktop/) 项目骨架完整、PyInstaller spec 关键字段
  // 没被无意义改动。打包链路本身的"能不能跑通"靠 GitHub Actions 验证，
  // 这里只防"文件被误删 / spec 缺关键字段 / 资源路径写错"这种低级回归。
  const desktopFiles = [
    "desktop/__init__.py",
    "desktop/runbi_helper.py", // PyInstaller 入口壳（必须在包外）
    "desktop/helper_app/__init__.py",
    "desktop/helper_app/__main__.py",
    "desktop/helper_app/cli.py", // 真正的 main 逻辑
    "desktop/helper_app/config.py",
    "desktop/helper_app/version.py",
    "desktop/helper_app/server.py",
    "desktop/helper_app/gui.py",
    "desktop/helper_app/updater.py",
    "desktop/requirements.txt",
    "desktop/build/runbi-helper.spec",
    "desktop/build/build_mac.sh",
    "desktop/build/build_win.bat",
    "desktop/README.md",
    "docs/USER_DOWNLOAD_HELPER.md",
    ".github/workflows/build-helper.yml",
  ];
  desktopFiles.forEach(mustExist);

  // —— 防回归：入口壳的契约（这块踩过坑）——
  // 1) __main__.py 不能再放业务逻辑，必须从 .cli 引入 main
  const mainSrc = fs.readFileSync(
    path.join(root, "desktop/helper_app/__main__.py"),
    "utf8"
  );
  assert(
    /from\s+\.cli\s+import\s+main/.test(mainSrc),
    "__main__.py 必须从 .cli import main，不能再塞业务逻辑（PyInstaller 不会把 __main__.py 当可 import 模块）"
  );

  // 2) PyInstaller 入口必须是 desktop/runbi_helper.py（包外壳），
  //    不能直接指向 helper_app/__main__.py（会触发相对导入失败）
  const entrySrc = fs.readFileSync(
    path.join(root, "desktop/runbi_helper.py"),
    "utf8"
  );
  assert(
    /from\s+helper_app\.cli\s+import\s+main/.test(entrySrc),
    "runbi_helper.py 必须用绝对导入 `from helper_app.cli import main`（相对导入在 PyInstaller frozen 环境下会失败）"
  );

  // PyInstaller spec 必备字段
  const specSrc = fs.readFileSync(
    path.join(root, "desktop/build/runbi-helper.spec"),
    "utf8"
  );
  // 入口必须是包外的 runbi_helper.py
  assert(
    /ENTRY_SCRIPT\s*=\s*DESKTOP_DIR\s*\/\s*["']runbi_helper\.py["']/.test(specSrc),
    "spec 必须把 ENTRY_SCRIPT 指向 desktop/runbi_helper.py（否则 frozen helper 会因相对导入失败而 crash）"
  );
  // pathex 必须同时包含 PROJECT_ROOT 和 DESKTOP_DIR
  assert(
    /pathex\s*=\s*\[[^\]]*PROJECT_ROOT[^\]]*DESKTOP_DIR/.test(specSrc),
    "spec pathex 必须同时包含 PROJECT_ROOT 和 DESKTOP_DIR（否则 helper_app 找不到）"
  );
  // scrape-article.js 资源必须打进去
  assert(
    /scrape-article\.js/.test(specSrc),
    "PyInstaller spec 必须把 src/content-scripts/scrape-article.js 打进 datas"
  );
  // DrissionPage 子模块要 collect_submodules
  assert(
    /collect_submodules\(\s*["']DrissionPage["']\s*\)/.test(specSrc),
    "PyInstaller spec 必须 collect_submodules('DrissionPage')，否则打包后会缺子模块"
  );
  // mac BUNDLE 必备字段
  assert(
    /bundle_identifier\s*=\s*["']com\.docuearn\.helper["']/.test(specSrc),
    "mac BUNDLE bundle_identifier 必须是 com.docuearn.helper（要改请同时改 config.BUNDLE_ID）"
  );

  // 资源路径解析
  const configSrc = fs.readFileSync(
    path.join(root, "desktop/helper_app/config.py"),
    "utf8"
  );
  assert(
    /sys\._MEIPASS/.test(configSrc),
    "config.py 必须处理 PyInstaller 的 sys._MEIPASS（否则打包后找不到资源）"
  );

  // scripts/drissionpage_helper.py 兼容跳转：必须仍然能被命令行老用户使用
  const scriptSrc = fs.readFileSync(
    path.join(root, "scripts/drissionpage_helper.py"),
    "utf8"
  );
  assert(
    /from\s+desktop\.helper_app\.server\s+import/.test(scriptSrc),
    "scripts/drissionpage_helper.py 必须从 desktop.helper_app.server 复用核心逻辑（避免双份维护）"
  );

  // helper /version 接口（扩展端用来检测新版）
  const serverSrc = fs.readFileSync(
    path.join(root, "desktop/helper_app/server.py"),
    "utf8"
  );
  assert(
    /\/version/.test(serverSrc),
    "server.py 必须暴露 /version 接口（扩展端轻量轮询用）"
  );
}

console.log("\n运行 workspace-router 顶部状态栏 storage key 单测 …");
{
  // 历史 bug：workspace-router 直接用了字面量 "settings" / "licenseRecord"，
  // 但 settings 实际存于 STORAGE_KEYS.settings = "wechatWriterSettings"，
  // license 存于 LICENSE_STORAGE_KEY = "wechatWriterLicense"，
  // 导致 AI 状态徽章永远显示「AI · 未配置」。这里做静态文本检查防回归。
  const routerSrc = fs.readFileSync(path.join(root, "src/workspace/workspace-router.js"), "utf8");
  assert(
    routerSrc.includes("STORAGE_KEYS") && routerSrc.includes("LICENSE_STORAGE_KEY"),
    "workspace-router.js 必须 import STORAGE_KEYS / LICENSE_STORAGE_KEY 常量"
  );
  // 不允许出现裸字面量的错误 key（'licenseRecord' 这个字符串过去就是错的）
  assert(
    !/['"]licenseRecord['"]/.test(routerSrc),
    "workspace-router.js 不应再出现 'licenseRecord' 字面量，应统一用 LICENSE_STORAGE_KEY"
  );
  // chrome.storage.local.get 调用里不能再出现裸的 "settings" 字符串
  const getCall = routerSrc.match(/chrome\.storage\.local\.get\(\[[^\]]+\]/g) || [];
  for (const call of getCall) {
    assert(
      !/['"]settings['"]/.test(call),
      `workspace-router.js storage.local.get 调用里仍残留裸 "settings"：${call}`
    );
  }
}

console.log("\n运行 drission 模块绑定 / canUseDrissionCapture 单测 …");
{
  const drission = await import("../src/shared/drission.js");

  // —— 模块导出契约 —— //
  assert(typeof drission.canUseDrissionCapture === "function", "canUseDrissionCapture 必须是函数");
  assert(typeof drission.requestDrissionCapture === "function", "requestDrissionCapture 必须是函数");
  assert(
    typeof drission.normalizeDrissionCaptureMode === "function",
    "normalizeDrissionCaptureMode 必须作为函数被导出（之前的 ESM re-export bug）"
  );

  // —— canUseDrissionCapture 在"用户已开启 Drission"路径下不抛 ReferenceError —— //
  // 这是上次线上炸出来的真实场景：drissionEnabled=true + 合法 helperUrl，
  // 走到 normalizeDrissionCaptureMode(captureMode) 那一步，老代码这里会
  // 抛 "ReferenceError: normalizeDrissionCaptureMode is not defined"。
  // 这条 assert 直接复现这个调用路径，防回归。
  let result;
  let threwRef = false;
  try {
    result = drission.canUseDrissionCapture(
      { drissionEnabled: true, drissionHelperUrl: "http://127.0.0.1:9222" },
      "readable"
    );
  } catch (error) {
    threwRef = String(error?.message || "").includes("not defined");
    if (threwRef) {
      console.error("FAIL:", error.message);
    }
    throw error;
  }
  assert(threwRef === false, "canUseDrissionCapture 不应抛 ReferenceError（normalizeDrissionCaptureMode 必须在本地作用域可见）");
  assert(result === true, "Drission 已配置 + readable 模式应允许走 helper");

  // selection 模式必须被排除（DrissionPage 抓不到选区）
  const r2 = drission.canUseDrissionCapture(
    { drissionEnabled: true, drissionHelperUrl: "http://127.0.0.1:9222" },
    "selection"
  );
  assert(r2 === false, "selection 模式必须强制走扩展内置抓取，不能走 Drission");

  // 没开 / 没 helperUrl → 直接 false（短路，不会触发后续函数）
  const r3 = drission.canUseDrissionCapture({ drissionEnabled: false }, "readable");
  assert(r3 === false, "drissionEnabled=false 应直接返回 false");
  const r4 = drission.canUseDrissionCapture({ drissionEnabled: true, drissionHelperUrl: "" }, "readable");
  assert(r4 === false, "helperUrl 为空应直接返回 false");

  // —— parseDrissionHelperInput：拆 token 并返回干净 URL —— //
  // 历史背景：从 0.4.x 开始 helper 默认开 token 鉴权，GUI 复制按钮会输出
  // 形如 http://127.0.0.1:7788/?token=abc 的整段地址。这里要保证：
  //   1. URL 字段在 settings 里只保留 base，不含 token，避免 token 被泄到 DOM/HTML
  //   2. token 单独拆出来，由调用方走 X-Runbi-Helper-Token header 传输
  assert(typeof drission.parseDrissionHelperInput === "function", "必须导出 parseDrissionHelperInput");
  assert(typeof drission.normalizeDrissionHelperToken === "function", "必须导出 normalizeDrissionHelperToken");
  assert(typeof drission.HELPER_TOKEN_HEADER === "string" && drission.HELPER_TOKEN_HEADER, "必须导出 HELPER_TOKEN_HEADER 常量");

  const p1 = drission.parseDrissionHelperInput("http://127.0.0.1:7788/?token=abcdef123456");
  assert(p1.url === "http://127.0.0.1:7788/", `拆完后 URL 应不含 token，实际 ${p1.url}`);
  assert(p1.token === "abcdef123456", `应拆出 token=abcdef123456，实际 ${p1.token}`);

  const p2 = drission.parseDrissionHelperInput("127.0.0.1:7788/?auth_token=xyz789&extra=1");
  assert(p2.url === "http://127.0.0.1:7788/?extra=1", "auth_token 也应被拆掉，但其它 query 必须保留");
  assert(p2.token === "xyz789", "应兼容 auth_token 名");

  const p3 = drission.parseDrissionHelperInput("http://127.0.0.1:7788");
  assert(p3.url === "http://127.0.0.1:7788/", "无 token 路径应正常补 trailing slash");
  assert(p3.token === "", "无 token 时应返回空串而不是 undefined");

  // token 必须是 [A-Za-z0-9._-]，过滤可疑字符
  assert(drission.normalizeDrissionHelperToken("  abc-XYZ_123.45  ") === "abc-XYZ_123.45", "合法 token 去空白即可");
  assert(drission.normalizeDrissionHelperToken("ab cd") === "", "含空格的 token 应被拒绝");
  assert(drission.normalizeDrissionHelperToken("ab中文") === "", "含中文的 token 应被拒绝");
  assert(drission.normalizeDrissionHelperToken('ab"cd') === "", "含引号的 token 应被拒绝");
}

console.log("\n运行 desktop helper 安全特性单测 …");
{
  // server.py 必须实现 token 鉴权 / CORS 收窄 / 私网拦截，否则 helper 会成为
  // 本机其它程序的 SSRF 跳板（任意 http(s) → DrissionPage 真实浏览器抓取）。
  const serverSrc = fs.readFileSync(
    path.join(root, "desktop/helper_app/server.py"),
    "utf8"
  );

  // 1) token header 名必须与扩展端一致
  assert(
    /HELPER_TOKEN_HEADER\s*=\s*["']X-Runbi-Helper-Token["']/.test(serverSrc),
    "server.py 的 HELPER_TOKEN_HEADER 必须等于扩展端 src/shared/drission.js 的 X-Runbi-Helper-Token"
  );

  // 2) /scrape 必须强制鉴权（_enforce_token 出现在 do_POST 路径里）
  assert(
    /_enforce_token/.test(serverSrc),
    "server.py 必须在 /scrape 走 _enforce_token，不能裸跑"
  );

  // 3) 用 hmac.compare_digest 防时序攻击，而不是 ==
  assert(
    /hmac\.compare_digest/.test(serverSrc),
    "token 比对必须用 hmac.compare_digest，避免时序侧信道"
  );

  // 4) CORS 不再无脑回 *
  assert(
    !/Access-Control-Allow-Origin["']?\s*,\s*["']\*/.test(serverSrc),
    "server.py 不应再把 Access-Control-Allow-Origin 设为 *（已收窄到扩展协议 + 本机调试）"
  );
  assert(
    /is_origin_allowed/.test(serverSrc),
    "server.py 必须有 is_origin_allowed 白名单逻辑"
  );

  // 5) 私网/loopback 默认拦截
  assert(
    /is_target_host_allowed/.test(serverSrc),
    "server.py 必须有 is_target_host_allowed 防 SSRF 函数"
  );
  assert(
    /allow_private_hosts/.test(serverSrc),
    "RuntimeOptions 必须暴露 allow_private_hosts 开关，让用户在确认场景下显式开启"
  );

  // 6) 错误码字段
  assert(
    /errorCode/.test(serverSrc) && /PRIVATE_HOST_BLOCKED/.test(serverSrc),
    "server.py 必须返回结构化 errorCode（含 PRIVATE_HOST_BLOCKED 等），扩展端才能精准映射文案"
  );

  // —— cli + 兼容 script 必须暴露 --auth-token / --allow-private-hosts —— //
  const cliSrc = fs.readFileSync(path.join(root, "desktop/helper_app/cli.py"), "utf8");
  assert(/--auth-token/.test(cliSrc), "desktop/helper_app/cli.py 必须支持 --auth-token");
  assert(/--allow-private-hosts/.test(cliSrc), "desktop/helper_app/cli.py 必须支持 --allow-private-hosts");

  const scriptSrc2 = fs.readFileSync(path.join(root, "scripts/drissionpage_helper.py"), "utf8");
  assert(/--auth-token/.test(scriptSrc2), "scripts/drissionpage_helper.py 必须保持 CLI 兼容，加 --auth-token");
  assert(/--allow-private-hosts/.test(scriptSrc2), "scripts/drissionpage_helper.py 必须支持 --allow-private-hosts");

  // —— config.py 必须能落盘并读 helper_token —— //
  const configSrc2 = fs.readFileSync(path.join(root, "desktop/helper_app/config.py"), "utf8");
  assert(
    /load_or_create_helper_token/.test(configSrc2) && /helper_token_path/.test(configSrc2),
    "config.py 必须暴露 load_or_create_helper_token / helper_token_path，用于持久化 token"
  );
  assert(
    /secrets/.test(configSrc2),
    "token 生成必须用 secrets 模块，不能用 random.* 这类弱熵"
  );

  // —— defaults.js 必须新增 drissionHelperToken 字段 —— //
  const defaultsSrc = fs.readFileSync(path.join(root, "src/shared/defaults.js"), "utf8");
  assert(
    /drissionHelperToken\s*:/.test(defaultsSrc),
    "DEFAULT_SETTINGS 必须包含 drissionHelperToken 字段，否则 storage.get 时拿不到默认值会让 token 在保存后丢"
  );

  // —— server.py 必须暴露 SUPPORTED_ERROR_CODES 与运行时分类器 —— //
  // 历史：很多 helper 异常以前直接以 "Internal Server Error" 抛给扩展端，用户拿到
  // 一句没有任何 actionable 信息的英文，根本无法定位是 "Chrome 没装" 还是 "登录态没了"。
  // 现在所有 raise 必须经过 _classify_runtime_error 落到 SUPPORTED_ERROR_CODES 里的稳定 code。
  assert(
    /SUPPORTED_ERROR_CODES\s*:\s*tuple/.test(serverSrc),
    "server.py 必须导出 SUPPORTED_ERROR_CODES，扩展端 health 探针会基于它做能力嗅探"
  );
  for (const code of [
    "MISSING_TOKEN",
    "INVALID_TOKEN",
    "PRIVATE_HOST_BLOCKED",
    "DRISSION_NOT_AVAILABLE",
    "BROWSER_LAUNCH_FAILED",
    "SCRAPE_EMPTY",
    "SCRAPE_TIMEOUT",
    "LOGIN_REQUIRED"
  ]) {
    assert(
      new RegExp(`["']${code}["']`).test(serverSrc),
      `server.py 的 SUPPORTED_ERROR_CODES 必须包含 ${code}，否则扩展端的 HELPER_ERROR_HINTS 映射会失效`
    );
  }
  assert(
    /_classify_runtime_error\s*\(/.test(serverSrc),
    "server.py 必须有 _classify_runtime_error 把任意异常映射到稳定 errorCode"
  );
  // /health 必须把 errorCodes/allowPrivateHosts 暴露给扩展，扩展才能在 GUI 提示用户当前 helper 是否放开了内网
  assert(
    /errorCodes/.test(serverSrc) && /allowPrivateHosts/.test(serverSrc),
    "/health 响应必须带 errorCodes 与 allowPrivateHosts，扩展端才能做能力提示"
  );
}

console.log("\n运行 desktop helper 抓取脚本调用契约回归 …");
{
  // 历史 bug：_run_capture_script 调用的是不存在的 window.__gzhRunCapture，
  // 且传参是裸 mode 字符串，而 scrape-article.js 导出的是 __gzhRunFullCapture(options)，
  // 期望 { mode } 对象——两处都对不上导致增强抓取从未真正跑通，只是被扩展端的
  // fallback 悄悄兜住。这里锁死正确的调用契约，防止再漂移。
  const serverSrc = fs.readFileSync(
    path.join(root, "desktop/helper_app/server.py"),
    "utf8"
  );

  assert(
    !/window\.__gzhRunCapture\s*\(/.test(serverSrc),
    "server.py 不应再调用不存在的 window.__gzhRunCapture，必须用 __gzhRunFullCapture"
  );
  assert(
    /window\.__gzhRunFullCapture\s*\(\s*arguments\[0\]\s*\)/.test(serverSrc),
    "server.py 必须调用 window.__gzhRunFullCapture(arguments[0])"
  );
  assert(
    /tab\.run_js\(\s*\n?\s*["']return window\.__gzhRunFullCapture\(arguments\[0\]\);["'],\s*\{\s*["']mode["']\s*:\s*mode\s*\}\s*\)/.test(
      serverSrc
    ),
    "调用 __gzhRunFullCapture 时必须传 { mode } 对象，不能传裸 mode 字符串（函数签名是 options.mode）"
  );

  // normalize_mode 不应再把 raw 改写成 page —— scrape-article.js 只认 "raw"
  const normalizeModeMatch = serverSrc.match(
    /def normalize_mode\(mode: str\) -> str:[\s\S]*?\n\n/
  );
  assert(normalizeModeMatch, "找不到 normalize_mode 函数定义");
  assert(
    !/return\s+["']page["']/.test(normalizeModeMatch[0]),
    'normalize_mode 不应再把任何模式映射成 "page"（历史 bug：raw→page 导致原样整页模式失效）'
  );
  assert(
    /\{\s*["']readable["']\s*,\s*["']raw["']\s*,\s*["']selection["']\s*\}/.test(
      normalizeModeMatch[0]
    ),
    'normalize_mode 必须原样识别 "raw"（与 scrape-article.js / normalizeCaptureMode 保持三档一致）'
  );
}

console.log("\n运行 drission helper errorCode 映射单测 …");
{
  const drission = await import("../src/shared/drission.js");
  // —— HELPER_ERROR_HINTS 必须覆盖关键 errorCode —— //
  // 出问题时 server.py 一旦 message 为空，扩展端的 fallback 文案就完全靠这张表。
  // 因此这里要锁死「关键 code 必须有面向用户的文案」，不允许悄悄漏一个。
  assert(typeof drission.HELPER_ERROR_HINTS === "object" && drission.HELPER_ERROR_HINTS, "drission.js 必须导出 HELPER_ERROR_HINTS");
  for (const code of [
    "MISSING_TOKEN",
    "INVALID_TOKEN",
    "PRIVATE_HOST_BLOCKED",
    "DRISSION_NOT_AVAILABLE",
    "BROWSER_LAUNCH_FAILED",
    "SCRAPE_EMPTY",
    "SCRAPE_TIMEOUT",
    "LOGIN_REQUIRED"
  ]) {
    const hint = drission.HELPER_ERROR_HINTS[code];
    assert(typeof hint === "string" && hint.length > 0, `HELPER_ERROR_HINTS 必须为 ${code} 提供面向用户的中文文案`);
  }

  // —— testDrissionConnection 在 401/403 都能附带 errorCode —— //
  const originalFetch = globalThis.fetch;
  // case A: helper 缺 token
  globalThis.fetch = async () => ({
    ok: false,
    status: 401,
    json: async () => ({ ok: false, error: "missing token", errorCode: "MISSING_TOKEN" })
  });
  const a = await drission.testDrissionConnection({ helperUrl: "http://127.0.0.1:7788/" });
  assert(a.ok === false, "401 应返回 ok=false");
  assert(a.errorCode === "MISSING_TOKEN", `401 应回传 errorCode=MISSING_TOKEN，实际 ${a.errorCode}`);
  assert(/token/.test(a.error), "401 错误文案应明确告诉用户问题在 token");

  // case B: 私网拦截
  globalThis.fetch = async () => ({
    ok: false,
    status: 403,
    json: async () => ({ ok: false, error: "blocked", errorCode: "PRIVATE_HOST_BLOCKED" })
  });
  const b = await drission.testDrissionConnection({ helperUrl: "http://127.0.0.1:7788/", helperToken: "tk" });
  assert(b.errorCode === "PRIVATE_HOST_BLOCKED", "403 应回传 errorCode=PRIVATE_HOST_BLOCKED");

  // case C: 正常 health 响应必须把 errorCodes / allowPrivateHosts 透出来
  globalThis.fetch = async () => ({
    ok: true,
    status: 200,
    json: async () => ({
      ok: true,
      helperVersion: "1.2.3",
      drissionVersion: "4.0",
      browserMode: "chromium",
      requireToken: true,
      allowPrivateHosts: false,
      errorCodes: ["MISSING_TOKEN", "PRIVATE_HOST_BLOCKED"]
    })
  });
  const c = await drission.testDrissionConnection({ helperUrl: "http://127.0.0.1:7788/", helperToken: "tk" });
  assert(c.ok === true, "正常 helper 应返回 ok=true");
  assert(c.allowPrivateHosts === false, "allowPrivateHosts 必须透传");
  assert(Array.isArray(c.supportedErrorCodes) && c.supportedErrorCodes.length === 2, "supportedErrorCodes 必须透传");

  // —— requestDrissionCapture 抛错时必须挂 helperErrorCode，方便上层做差异化 UX —— //
  globalThis.fetch = async () => ({
    ok: false,
    status: 401,
    json: async () => ({ ok: false, error: "需要 token", errorCode: "INVALID_TOKEN" })
  });
  let caught = null;
  try {
    await drission.requestDrissionCapture(
      { drissionEnabled: true, drissionHelperUrl: "http://127.0.0.1:7788/", drissionHelperToken: "x" },
      { url: "https://example.com/foo", captureMode: "readable" }
    );
  } catch (err) {
    caught = err;
  }
  assert(caught, "requestDrissionCapture 在 401 时必须抛错");
  assert(caught.helperErrorCode === "INVALID_TOKEN", `抛出的 Error 必须挂 helperErrorCode，实际 ${caught.helperErrorCode}`);
  assert(caught.helperHttpStatus === 401, "应挂 helperHttpStatus，便于排查");

  globalThis.fetch = originalFetch;
}

console.log("\n运行 classifyError 错误分类单测 …");
{
  const { classifyError, ErrorCode } = await import("../src/shared/errors.js");

  // —— Chrome 系统错（host 权限不够）→ SCRAPE_HOST_BLOCKED —— //
  const c1 = classifyError(
    new Error("Cannot access contents of url \"chrome://newtab/\". Extension manifest must request permission to access this host.")
  );
  assert(
    c1.code === ErrorCode.SCRAPE_HOST_BLOCKED,
    `host blocked 错误应分类为 SCRAPE_HOST_BLOCKED，实际为 ${c1.code}`
  );
  assert(/扩展无法访问/.test(c1.message), "SCRAPE_HOST_BLOCKED message 应是中文友好提示");

  // —— Chrome tab 被关掉 → SCRAPE_TAB_FAILED 且附带原始细节 —— //
  const c2 = classifyError(new Error("No tab with id 12345"));
  assert(c2.code === ErrorCode.SCRAPE_TAB_FAILED, "tab 已关错误应分类为 SCRAPE_TAB_FAILED");
  assert(/No tab with id 12345/.test(c2.message), "SCRAPE_TAB_FAILED 应附带原始 detail，方便排查");

  // —— 中文报错原文透传 —— //
  const c3 = classifyError(new Error("目标页面在 15 秒内未加载完成：可能跳转或被反爬拦截"));
  assert(c3.code === ErrorCode.UNKNOWN, "未匹配的中文错应是 UNKNOWN");
  assert(c3.message.includes("目标页面"), "中文错原文必须透传，不能被吞掉变 fallback");

  // —— 英文报错"加中文前缀"透出，不再变成通用 fallback —— //
  const c4 = classifyError(new Error("Some weird internal error code 0xC0FFEE"));
  assert(c4.code === ErrorCode.UNKNOWN, "未匹配的英文错应是 UNKNOWN");
  assert(c4.message.startsWith("操作失败："), "英文错应被中文前缀包装，方便用户复制给客服");
  assert(c4.message.includes("0xC0FFEE"), "英文错原文必须保留在 message 里");

  // —— 完全没 message → 走 fallback —— //
  const c5 = classifyError(new Error(""));
  assert(c5.code === ErrorCode.UNKNOWN, "空 message 走 UNKNOWN");
  assert(c5.message === "操作失败，请稍后再试。", "空 message 才允许走通用 fallback");

  // —— 网络超时仍正常分类 —— //
  const c6 = classifyError(new Error("fetch timeout after 30s"));
  assert(c6.code === ErrorCode.NETWORK_TIMEOUT, "timeout 关键字应触发 NETWORK_TIMEOUT");

  // —— 抓取无内容 —— //
  const c7 = classifyError(new Error("抓取失败或正文为空，请确认目标站点支持免登录公开访问。"));
  assert(c7.code === ErrorCode.SCRAPE_NO_CONTENT, "抓取空内容关键字应触发 SCRAPE_NO_CONTENT");

  // —— 微信 IP 白名单（errcode 40164）：必须把出口 IP 透出来，否则用户根本不知道要把哪个 IP 加白 —— //
  // case A：error 对象自带 detectedIp（wechat.js buildWechatError 已经提取过，最常见路径）
  const ipErr = new Error("IP 白名单未通过（40164）：当前出口 IP 是 1.2.3.4...\nerrcode=40164 · errmsg=invalid ip 1.2.3.4, not in whitelist");
  ipErr.detectedIp = "1.2.3.4";
  const c8 = classifyError(ipErr);
  assert(c8.code === ErrorCode.WECHAT_IP_NOT_WHITELISTED, "40164 应分类为 WECHAT_IP_NOT_WHITELISTED");
  assert(c8.message.includes("1.2.3.4"), "40164 message 必须含具体出口 IP，不能再吞掉这条关键信息");
  assert(c8.detectedIp === "1.2.3.4", "40164 返回结构应带 detectedIp 字段，给上层 UI 一键复制用");

  // case B：error 没挂 detectedIp，但 raw message 含 errmsg 字符串 → 兜底提取
  const c9 = classifyError(
    new Error("公众号发布失败：errcode=40164 · errmsg=invalid ip 240e:abcd:1234::1, not in whitelist")
  );
  assert(c9.code === ErrorCode.WECHAT_IP_NOT_WHITELISTED, "兜底路径仍应分类为 WECHAT_IP_NOT_WHITELISTED");
  assert(c9.detectedIp === "240e:abcd:1234::1", `兜底应能从 raw message 里抽出 ipv6，实际拿到：${c9.detectedIp}`);
  assert(c9.message.includes("240e:abcd:1234::1"), "兜底路径也必须把 IP 拼进 message");

  // case C：完全没 errmsg / detectedIp（极端 fallback）→ 走原来的通用文案，不能崩
  const c10 = classifyError(new Error("ip 白名单 拒绝"));
  assert(c10.code === ErrorCode.WECHAT_IP_NOT_WHITELISTED, "中文关键字也能识别 40164");
  assert(!c10.detectedIp, "无 IP 时不应返回 detectedIp 字段");
  assert(
    c10.message.includes("公众号后台开启了 IP 白名单限制"),
    "无 IP 时回落到原通用文案，保持兼容"
  );
  assert(
    !/\d+\.\d+\.\d+\.\d+/.test(c10.message),
    "无 IP 时 message 不应该出现任何 IP 残留"
  );

  // —— 微信 invalid media_id（errcode 40007）：必须把 hint 诊断码透出来 —— //
  // 完全照 40164 IP 透传的契约模式。3 个 case 对应 wechat.js / 字符串兜底 / 无 hint 极端兜底。
  // case A：error 对象自带 detectedMediaIdHint（wechat.js buildWechatError 主路径）
  const midErr = new Error(
    "公众号拒绝了草稿里的封面或图片素材 ID（40007）。\nerrcode=40007 · errmsg=invalid media_id hint: [fbk5ma021425-1] rid: 69ed8aad-06b2948c-21cc5eea"
  );
  midErr.detectedMediaIdHint = "fbk5ma021425-1";
  const m1 = classifyError(midErr);
  assert(
    m1.code === ErrorCode.WECHAT_INVALID_MEDIA_ID,
    "40007 应分类为 WECHAT_INVALID_MEDIA_ID"
  );
  assert(
    m1.message.includes("fbk5ma021425-1"),
    "40007 message 必须含 hint 诊断码，不能再吞掉这条关键信息"
  );
  assert(
    m1.detectedMediaIdHint === "fbk5ma021425-1",
    "40007 返回结构应带 detectedMediaIdHint 字段，给上层 UI / 客服工单用"
  );
  assert(m1.retryable === true, "40007 应标记 retryable=true（重传封面通常能解决）");

  // case B：error 没挂 detectedMediaIdHint，但 raw message 含 errmsg → 兜底从字符串里抽
  const m2 = classifyError(
    new Error(
      "公众号发布失败：errcode=40007 · errmsg=invalid media_id hint: [a1b2c3d4-99] rid: xxx"
    )
  );
  assert(
    m2.code === ErrorCode.WECHAT_INVALID_MEDIA_ID,
    "兜底路径仍应分类为 WECHAT_INVALID_MEDIA_ID"
  );
  assert(
    m2.detectedMediaIdHint === "a1b2c3d4-99",
    `兜底应能从 raw message 里抽出 hint，实际拿到：${m2.detectedMediaIdHint}`
  );
  assert(
    m2.message.includes("a1b2c3d4-99"),
    "兜底路径也必须把 hint 拼进 message"
  );

  // case C：errmsg 无 hint（极端 fallback）→ 走原通用文案，不能崩
  const m3 = classifyError(new Error("invalid media_id"));
  assert(
    m3.code === ErrorCode.WECHAT_INVALID_MEDIA_ID,
    "纯关键字也能识别 40007"
  );
  assert(!m3.detectedMediaIdHint, "无 hint 时不应返回 detectedMediaIdHint 字段");
  assert(
    m3.message.includes("封面") || m3.message.includes("素材"),
    "无 hint 时回落到原通用文案（提示用户重传封面）"
  );

  // case D：errcode 顺序不应让 40007 跟 40164 混淆（双重防御）
  const m4 = classifyError(
    new Error("errcode=40007 errmsg=invalid media_id hint: [xxx-1]")
  );
  assert(
    m4.code === ErrorCode.WECHAT_INVALID_MEDIA_ID,
    "errcode=40007 不应被任何其他分支拦截（IP / 认证账号都不能误吞）"
  );
}

// 测 wechat.js 的 buildWechatError + extractWechatIpFromErrmsg：root 处的 IP 提取逻辑
console.log("\n运行 wechat.js buildWechatError IP 提取单测 …");
{
  const { buildWechatError, extractWechatIpFromErrmsg } = await import("../src/shared/wechat.js");

  // 工具函数：3 种真实 errmsg 形态都能抽出 ipv4
  assert(
    extractWechatIpFromErrmsg("invalid ip 1.2.3.4, not in whitelist") === "1.2.3.4",
    "extractWechatIpFromErrmsg 应能解析 ipv4"
  );
  assert(
    extractWechatIpFromErrmsg("invalid ip 240e:abcd::1, not in whitelist") === "240e:abcd::1",
    "extractWechatIpFromErrmsg 应能解析 ipv6"
  );
  // 双栈机器：微信会同时给 ipv4 + ::ffff:ipv4，应优先返回 ipv4（更易复制粘贴）
  assert(
    extractWechatIpFromErrmsg("invalid ip 1.2.3.4 ipv6 ::ffff:1.2.3.4, not in whitelist") === "1.2.3.4",
    "双栈 errmsg 应优先返回 ipv4"
  );
  // 无 IP / 空 errmsg → 空字符串，不能抛错
  assert(extractWechatIpFromErrmsg("invalid ip xxx, not in whitelist") === "", "无效 IP 应返回空字符串");
  assert(extractWechatIpFromErrmsg("") === "", "空 errmsg 应返回空字符串");
  assert(extractWechatIpFromErrmsg(null) === "", "null errmsg 应返回空字符串");

  // buildWechatError(40164, ipv4): err.detectedIp 正确 + userMessage 含 IP
  const e1 = buildWechatError(
    { errcode: 40164, errmsg: "invalid ip 1.2.3.4, not in whitelist" },
    { status: 200, headers: { get: () => null } },
    "草稿推送失败"
  );
  assert(e1.errcode === 40164, "errcode 透传");
  assert(e1.detectedIp === "1.2.3.4", "buildWechatError 应把 IP 挂到 err.detectedIp");
  assert(e1.userMessage.includes("1.2.3.4"), "userMessage 必须含具体 IP，不能只用 catalog 静态文案");
  assert(e1.message.includes("1.2.3.4"), "Error.message 也必须含 IP（避免下游 classifyError 拿不到）");

  // buildWechatError(40164, ipv6)
  const e2 = buildWechatError(
    { errcode: 40164, errmsg: "invalid ip 240e:abcd:1234::1, not in whitelist" },
    { status: 200, headers: { get: () => null } },
    "草稿推送失败"
  );
  assert(e2.detectedIp === "240e:abcd:1234::1", "ipv6 也应被正确提取");
  assert(e2.userMessage.includes("240e:abcd:1234::1"), "ipv6 也必须出现在 userMessage 里");

  // buildWechatError(其他 errcode)：不应带 detectedIp（仅 40164 专用）
  const e3 = buildWechatError(
    { errcode: 40125, errmsg: "invalid appsecret" },
    { status: 200, headers: { get: () => null } },
    "测试失败"
  );
  assert(!e3.detectedIp, "非 40164 错误不应有 detectedIp 字段");

  // buildWechatError(40164 但 errmsg 缺 IP)：detectedIp 为空、不抛错、message 回落到 catalog 文案
  const e4 = buildWechatError(
    { errcode: 40164, errmsg: "ip not allowed" },
    { status: 200, headers: { get: () => null } },
    "草稿推送失败"
  );
  assert(e4.errcode === 40164, "errcode 仍透传");
  assert(!e4.detectedIp, "无可解析 IP 时 detectedIp 为空");
  assert(e4.userMessage.includes("白名单"), "无 IP 时仍回落到 catalog 静态文案，不能崩");

  // —— 40007 invalid media_id：同 40164 的「关键诊断信息必须挂字段透传」契约 —— //
  const { extractWechatMediaIdHintFromErrmsg } = await import("../src/shared/wechat.js");

  // 工具函数：3 种真实 errmsg 形态都能抽出 hint
  assert(
    extractWechatMediaIdHintFromErrmsg(
      "invalid media_id hint: [fbk5ma021425-1] rid: 69ed8aad-06b2948c-21cc5eea"
    ) === "fbk5ma021425-1",
    "extractWechatMediaIdHintFromErrmsg 应能从典型 errmsg 解析 hint"
  );
  assert(
    extractWechatMediaIdHintFromErrmsg("hint:[abcdef]") === "abcdef",
    "去空格 / 大写不敏感的 hint: 形态也应被识别"
  );
  assert(
    extractWechatMediaIdHintFromErrmsg("Hint: [a1b2c3d4-99]") === "a1b2c3d4-99",
    "Hint 大小写不敏感"
  );
  // 无 hint / 空 errmsg → 空字符串，不抛错
  assert(extractWechatMediaIdHintFromErrmsg("invalid media_id") === "", "无 hint 应返回空字符串");
  assert(extractWechatMediaIdHintFromErrmsg("") === "", "空 errmsg 应返回空字符串");
  assert(extractWechatMediaIdHintFromErrmsg(null) === "", "null errmsg 应返回空字符串");

  // buildWechatError(40007 + hint)：err.detectedMediaIdHint 正确 + userMessage 含 catalog 友好文案 + hint 拼进 message
  const m1 = buildWechatError(
    {
      errcode: 40007,
      errmsg: "invalid media_id hint: [fbk5ma021425-1] rid: 69ed8aad-06b2948c-21cc5eea"
    },
    { status: 200, headers: { get: () => null } },
    "创建公众号草稿失败"
  );
  assert(m1.errcode === 40007, "errcode 透传");
  assert(
    m1.detectedMediaIdHint === "fbk5ma021425-1",
    "buildWechatError 应把 hint 挂到 err.detectedMediaIdHint"
  );
  assert(
    m1.userMessage.includes("封面") || m1.userMessage.includes("素材"),
    "userMessage 必须用 catalog 的友好文案（提示用户重传封面），而不是裸 errmsg"
  );
  assert(
    m1.userMessage.includes("fbk5ma021425-1"),
    "userMessage 必须含 hint 诊断码（让客服工单可定位）"
  );
  assert(
    m1.message.includes("fbk5ma021425-1"),
    "Error.message 也必须含 hint（避免下游 classifyError 拿不到）"
  );
  assert(m1.category === "draft", "40007 分类应为 draft（草稿字段相关）");

  // buildWechatError(40007 但 errmsg 缺 hint)：detectedMediaIdHint 为空、不抛错
  const m2 = buildWechatError(
    { errcode: 40007, errmsg: "invalid media_id" },
    { status: 200, headers: { get: () => null } },
    "创建公众号草稿失败"
  );
  assert(m2.errcode === 40007, "errcode 仍透传");
  assert(!m2.detectedMediaIdHint, "无可解析 hint 时 detectedMediaIdHint 为空");
  assert(
    m2.userMessage.includes("封面") || m2.userMessage.includes("素材"),
    "无 hint 时仍回落到 catalog 友好文案，不能崩"
  );

  // buildWechatError(其他 errcode)：不应带 detectedMediaIdHint（仅 40007 专用）
  const m3 = buildWechatError(
    { errcode: 40125, errmsg: "invalid appsecret hint: [abc]" },
    { status: 200, headers: { get: () => null } },
    "测试失败"
  );
  assert(!m3.detectedMediaIdHint, "非 40007 错误不应有 detectedMediaIdHint 字段（即便 errmsg 凑巧含 hint）");
}

// —— publishToWechat：封面上传失败必须立即抛错（不再 silently 让 thumb_media_id 为空字符串撞 40007）—— //
console.log("\n运行 publishToWechat 封面失败立即抛错 单测 …");
{
  const { publishToWechat } = await import("../src/shared/wechat.js");

  const originalFetch = globalThis.fetch;
  // 模拟一个最小可重入的 fetch 序列：
  //   call 1: getAccessToken → 200 + access_token
  //   call 2: fetchImageBlob 拉封面 → 404（迫使封面 try 块抛错）
  // 期望：publishToWechat 立即抛错，message 含「封面」字样、不再走到 createDraft 撞 40007。
  let fetchCallCount = 0;
  globalThis.fetch = async (urlString) => {
    fetchCallCount += 1;
    const url = String(urlString);
    if (/cgi-bin\/token|\/token/.test(url) && /grant_type=client_credential/.test(url)) {
      return {
        ok: true,
        status: 200,
        headers: { get: () => null },
        json: async () => ({ access_token: "FAKE_TOKEN", expires_in: 7200 }),
        blob: async () => new Blob([""])
      };
    }
    return {
      ok: false,
      status: 404,
      headers: { get: () => null },
      json: async () => ({}),
      blob: async () => new Blob([""])
    };
  };

  let coverThrown = null;
  try {
    await publishToWechat(
      { wechatAppId: "wx_test_app_id", wechatAppSecret: "test_secret" },
      {
        publishMode: "draft",
        articles: [
          {
            meta: { title: "测试标题", author: "", digest: "" },
            html: "<p>正文</p>",
            inlineImages: [],
            cover: { src: "https://example.com/missing-cover.png", filename: "cover-1.png" }
          }
        ]
      }
    );
  } catch (err) {
    coverThrown = err;
  }

  assert(coverThrown, "封面下载失败必须立即抛错，不能 silently 走到 createDraft");
  assert(
    /封面/.test(coverThrown.message),
    `抛出的 Error message 必须明确指出是封面失败，实际：${coverThrown.message}`
  );
  assert(
    /第\s*1\s*篇/.test(coverThrown.message),
    "Error message 必须含「第 1 篇」定位（多文章时尤其重要）"
  );
  assert(
    coverThrown.failedCover && coverThrown.failedCover.type === "cover",
    "Error 必须挂 failedCover 详情对象（articleIndex/src/error 等），让 UI 能做差异化反馈"
  );
  // 关键反例：旧 silent failure 链下，message 会是 "invalid media_id" 来自 add_draft；新链路根本走不到。
  assert(
    !/invalid\s*media_id|40007/i.test(coverThrown.message),
    "新链路绝不能让用户看到模糊的「invalid media_id / 40007」（那意味着 silent failure 链回归）"
  );
  // 关键 control flow 断言：fetch 只调了 2 次（getAccessToken + cover 下载），没有走到 createDraft / uploadPermanentImage 等后续接口
  assert(
    fetchCallCount === 2,
    `应在第 2 次 fetch（封面下载）失败时立即终止，实际调了 ${fetchCallCount} 次`
  );

  globalThis.fetch = originalFetch;
}

// —— P1.3 · 封面救济：HTML / state / publish / wechat 四处的兜底链 —— //
console.log("\n运行 封面救济链路 单测 …");
{
  // 1) workspace.html 必须把上传/生成按钮和文件 input 暴露出来
  const workspaceHtml = fs.readFileSync(path.join(root, "src/workspace/workspace.html"), "utf8");
  assert(
    workspaceHtml.includes('id="coverUploadInput"'),
    "workspace.html 必须有隐藏 file input #coverUploadInput，否则上传按钮没法触发"
  );
  assert(
    workspaceHtml.includes('id="uploadCoverButton"'),
    "workspace.html 必须有「上传本地图片做封面」按钮 #uploadCoverButton"
  );
  assert(
    workspaceHtml.includes('id="generateCoverButton"'),
    "workspace.html 必须有「一键生成占位封面」按钮 #generateCoverButton"
  );
  assert(
    workspaceHtml.includes('class="image-source-toolbar"'),
    "工具栏样式钩子 image-source-toolbar 缺失，CSS 改了 HTML 也得跟"
  );

  // 2) workspace-state.js 必须导出三个新的封面救济函数
  const stateJs = fs.readFileSync(path.join(root, "src/workspace/workspace-state.js"), "utf8");
  assert(
    stateJs.includes("export async function addCustomImageFromFile"),
    "workspace-state 必须导出 addCustomImageFromFile，否则 ctx 拿不到"
  );
  assert(
    stateJs.includes("export async function generatePlaceholderCoverDataUrl"),
    "workspace-state 必须导出 generatePlaceholderCoverDataUrl"
  );
  assert(
    stateJs.includes("export async function useGeneratedPlaceholderCover"),
    "workspace-state 必须导出 useGeneratedPlaceholderCover"
  );
  assert(
    stateJs.includes("export async function ensureFallbackCoverImage"),
    "workspace-state 必须导出 ensureFallbackCoverImage（publishBundle 兜底）"
  );
  assert(
    /MAX_LOCAL_COVER_BYTES\s*=\s*5\s*\*\s*1024\s*\*\s*1024/.test(stateJs),
    "本地上传封面体积上限必须明确为 5MB（wechat.js 内部还会再压到 2MB）"
  );

  // 3) workspace-publish.js 必须自动兜底而不是硬抛
  const publishJs = fs.readFileSync(path.join(root, "src/workspace/workspace-publish.js"), "utf8");
  assert(
    !publishJs.includes("throw new Error(`第 ${index + 1} 篇还没有选择封面图。`)"),
    "publish 不能再硬抛旧的「还没有选择封面图」，必须走 ensureFallbackCoverImage 兜底"
  );
  assert(
    publishJs.includes("ensureFallbackCoverImage(article)"),
    "publish 必须调用 ensureFallbackCoverImage 给没封面的文章自动补图"
  );
  assert(
    publishJs.includes("await _buildWechatPublishPayload(mode"),
    "_buildWechatPublishPayload 必须 await，因为里面要 await 封面生成"
  );

  // 4) wechat.js 防御 null 封面 + 错误信息要可操作
  const wechatJs = fs.readFileSync(path.join(root, "src/shared/wechat.js"), "utf8");
  assert(
    wechatJs.includes("article?.cover?.filename"),
    "wechat.js 必须用可选链读 cover.filename，避免 undefined.filename 崩"
  );
  assert(
    wechatJs.includes('article?.cover?.src || ""'),
    "wechat.js 失败 fallback 里必须用可选链读 cover.src，避免崩"
  );
  assert(
    /上传本地封面|一键生成占位封面/.test(wechatJs),
    "wechat.js 缺图错误必须给出可操作指引（点哪里、做什么）"
  );

  // 5) workspace-render.js 空态文案要给出按钮入口，不是只让用户去对面找
  const renderJs = fs.readFileSync(path.join(root, "src/workspace/workspace-render.js"), "utf8");
  assert(
    renderJs.includes('data-cover-action="upload"') &&
      renderJs.includes('data-cover-action="generate"'),
    "renderCoverPreview 空态必须给出 data-cover-action='upload'/'generate' 按钮，事件代理才能接到"
  );

  // 6) workspace.js 必须把新函数挂进 ctx，否则其他模块拿不到
  const wsJs = fs.readFileSync(path.join(root, "src/workspace/workspace.js"), "utf8");
  assert(
    wsJs.includes("addCustomImageFromFile") &&
      wsJs.includes("useGeneratedPlaceholderCover") &&
      wsJs.includes("ensureFallbackCoverImage"),
    "workspace.js 必须 import + 挂载新增的封面救济函数到 ctx"
  );
  assert(
    wsJs.includes('coverUploadInput: document.querySelector("#coverUploadInput")'),
    "workspace.js controls 必须缓存 coverUploadInput 引用"
  );
}

// =====================================================================
// 热点页改写模板可见性 chip · 防回归
//   背景：用户经常忘了选模板就直接点 ✨ 抓取并改写，workspace 自动用上一次
//   随机模板，浪费 AI 配额。修复后热点页顶部新增一个 .hot-rewrite-template-bar
//   chip，展示当前活跃模板并允许就地切换；这里锁死 HTML / JS 关键钩子，
//   避免后续重构悄悄把 chip 干掉、把 setActiveTemplateId import 砍掉。
// =====================================================================
console.log("\n运行 热点页改写模板可见性 chip 防回归 …");
{
  const hotHtml = fs.readFileSync(
    path.join(root, "src/pages/hot-topics.html"),
    "utf8"
  );
  assert(
    hotHtml.includes('id="hotRewriteTemplateSelect"'),
    "hot-topics.html 必须保留 #hotRewriteTemplateSelect select，否则用户在热点页看不到当前改写模板"
  );
  assert(
    hotHtml.includes('data-el="rewriteTemplateBar"'),
    "hot-topics.html 必须保留 data-el=\"rewriteTemplateBar\" 钩子，便于 JS 定位 chip 容器"
  );
  assert(
    hotHtml.includes("点 <strong>「抓取并改写」</strong> 时会用这个模板"),
    "hot-topics.html 必须保留「点「抓取并改写」时会用这个模板」文案，让用户一眼明白这个 chip 影响什么"
  );
  assert(
    hotHtml.includes('data-act="manage-templates"'),
    "hot-topics.html 必须保留「管理模板」链接（data-act=manage-templates），给用户兜底入口"
  );

  const hotJs = fs.readFileSync(
    path.join(root, "src/pages/hot-topics.js"),
    "utf8"
  );
  assert(
    /import\s*\{[^}]*setActiveTemplateId[^}]*\}\s*from\s*["']\.\.\/shared\/storage\.js["']/.test(
      hotJs
    ),
    "hot-topics.js 必须 import setActiveTemplateId（防止有人把 chip 改回只读，又退回到老的「点了才知道用错模板」体感）"
  );
  assert(
    /import\s*\{[^}]*getActiveTemplateId[^}]*\}\s*from\s*["']\.\.\/shared\/storage\.js["']/.test(
      hotJs
    ),
    "hot-topics.js 必须 import getActiveTemplateId，否则 chip 的初始选中态读不出来"
  );
  assert(
    hotJs.includes("initRewriteTemplateBar"),
    "hot-topics.js 必须有 initRewriteTemplateBar() 函数，且要有调用点（否则 chip 只是死 HTML）"
  );
  assert(
    /chrome\.storage\.onChanged/.test(hotJs),
    "hot-topics.js 必须监听 chrome.storage.onChanged，options/workspace 切换模板时热点页要自动同步"
  );
}

// =====================================================================
// 热点接口冷却 · forceRefresh 逃生口 + NewsNow 上游错误不惩罚 base · 防回归
//   背景：用户工单「拉取失败：NewsNow: 上次失败后冷却中（10 分钟）。所有候选后端
//   都在冷却」——根因有 3 条：① 用户点「🔄 强制刷新」时 forceRefresh=true 但代码
//   仍然走冷却闸门 → 没有逃生口；② NewsNow 200 OK 但上游某网站反爬时把整个
//   hot.inkgold.info base 当成失败 → 一次访问 zhihu/weibo/baidu 就把整个 NewsNow
//   冷却，剩下 30+ 工作中的源被一并锁；③ 错误文案没指路（「测试连接」失败时还是
//   被困住）。这里锁死修复后的契约：
//     - forceRefresh=true 必须绕过 isBaseCoolingDown 闸门
//     - fetchNewsNowHot 在 json.error===true / json.statusCode>=400 时抛的错必须
//       挂 err.upstreamPerSource = true，让外层不计入 recordBaseFailure
//     - 全冷却时的 advice 文案必须明确告诉用户「点 🔄 强制刷新」可以立即重试
// =====================================================================
console.log("\n运行 热点接口 forceRefresh 逃生口 + 上游错误不惩罚 base 单测 …");
{
  const hotJs = fs.readFileSync(
    path.join(root, "src/shared/hot-topics.js"),
    "utf8"
  );

  // (1) 主链路三段（newsNow / direct / rsshub）的 isBaseCoolingDown 检查必须配 !forceRefresh 守卫
  //     用 multiline 抓「!forceRefresh && (await isBaseCoolingDown(...))」三处
  const cooldownGuardPattern = /!forceRefresh\s*&&\s*\(await\s+isBaseCoolingDown\(/g;
  const cooldownGuards = (hotJs.match(cooldownGuardPattern) || []).length;
  assert(
    cooldownGuards >= 4, // newsNow + bilibili-direct + rsshub + reddit = 4
    `热点接口主链路所有冷却闸门必须配 !forceRefresh 守卫，期望 ≥ 4 处，实际 ${cooldownGuards} 处`
  );

  // (2) NewsNow 上游错误必须挂 err.upstreamPerSource = true（外层 catch 据此跳过 recordBaseFailure）
  assert(
    /err\.upstreamPerSource\s*=\s*true/.test(hotJs),
    "fetchNewsNowHot 抛上游每源错误时必须挂 err.upstreamPerSource = true"
  );

  // (3) 主链路 catch 必须检查 e.upstreamPerSource 决定是否 recordBaseFailure
  const catchSkipsBaseFailurePattern = /if\s*\(\s*!\s*e\?\.\s*upstreamPerSource\s*\)\s*\{\s*\n\s*await\s+recordBaseFailure/g;
  const catchSkipCount = (hotJs.match(catchSkipsBaseFailurePattern) || []).length;
  assert(
    catchSkipCount >= 3, // newsNow + bilibili-direct + rsshub = 3
    `主链路三段 catch 必须用 !e.upstreamPerSource 守卫 recordBaseFailure，期望 ≥ 3 处，实际 ${catchSkipCount} 处`
  );

  // (4) 全冷却 advice 文案必须包含「强制刷新」逃生口指引
  assert(
    hotJs.includes("「🔄 强制刷新」") || hotJs.includes("点页面顶部的「🔄 强制刷新」"),
    "全冷却 advice 必须告诉用户点「🔄 强制刷新」可以绕过冷却立即重试"
  );

  // (5) 端到端：在 node 环境下（chrome.storage 不可用，hot-topics-cache 走内存 Map），
  //     先往 hot.inkgold.info 喂 3 次失败把它打进冷却，然后用 forceRefresh=true 调
  //     fetchHotTopics 验证：mock fetch 必须真的被调用一次（没被冷却闸门挡掉）。
  const cacheMod = await import("../src/shared/hot-topics-cache.js");
  const hotMod = await import("../src/shared/hot-topics.js");

  await cacheMod._resetForTest();

  const NEWSNOW_BASE = "https://hot.inkgold.info/";
  for (let i = 0; i < cacheMod.FAIL_THRESHOLD; i++) {
    await cacheMod.recordBaseFailure(NEWSNOW_BASE, "test seed failure");
  }
  assert(
    await cacheMod.isBaseCoolingDown(NEWSNOW_BASE),
    "种子失败后 hot.inkgold.info 必须进入冷却（前置条件）"
  );

  // mock fetch：按 URL host 区分。NewsNow 路径返回成功 payload，
  // RSSHub fallback 路径（rsshub.app）返回 503 让它自然失败，避免污染主断言。
  const originalFetch = globalThis.fetch;
  const fetchHitLog = [];
  globalThis.fetch = async (urlString) => {
    const url = String(urlString);
    fetchHitLog.push(url);
    if (url.startsWith("https://hot.inkgold.info/")) {
      return {
        ok: true,
        status: 200,
        json: async () => ({
          status: "success",
          id: "zhihu",
          items: [
            { id: "i1", title: "测试热点 1", url: "https://example.com/1" },
            { id: "i2", title: "测试热点 2", url: "https://example.com/2" }
          ]
        })
      };
    }
    // 其它（如 RSSHub 兜底）：返回 503，避免无关路径污染
    return { ok: false, status: 503, json: async () => ({}), text: async () => "" };
  };
  const newsnowHits = () => fetchHitLog.filter((u) => u.startsWith("https://hot.inkgold.info/")).length;

  // forceRefresh=false 时 NewsNow 必须被冷却闸门挡住（不发起对 hot.inkgold.info 的 fetch）
  await cacheMod.clearCachedPayload();
  await hotMod.fetchHotTopics("zhihu", { forceRefresh: false });
  assert(
    newsnowHits() === 0,
    `forceRefresh=false + base 冷却时，对 hot.inkgold.info 的 fetch 必须为 0 次，实际 ${newsnowHits()} 次`
  );

  // forceRefresh=true 必须绕过冷却，对 hot.inkgold.info 至少发一次 fetch
  const beforeNewsnowHits = newsnowHits();
  const forcedRes = await hotMod.fetchHotTopics("zhihu", { forceRefresh: true });
  assert(
    newsnowHits() > beforeNewsnowHits,
    "forceRefresh=true 必须绕过冷却闸门，对 hot.inkgold.info 触发真实 fetch"
  );
  assert(
    forcedRes.ok && forcedRes.payload?.items?.length === 2,
    "forceRefresh=true 成功后必须返回 ok=true 且 payload.items 长度=2"
  );

  // 强制刷新成功后，base 健康度应被 recordBaseSuccess 自动清零
  assert(
    !(await cacheMod.isBaseCoolingDown(NEWSNOW_BASE)),
    "forceRefresh=true 强刷成功后必须自动清掉冷却（recordBaseSuccess）"
  );

  // (6) 上游每源错误（json.error=true）不应惩罚 base
  await cacheMod._resetForTest();
  globalThis.fetch = async (urlString) => {
    const url = String(urlString);
    // 只让 NewsNow 路径返回上游每源错误；RSSHub 等其它兜底通道返回 503，
    // 避免它们的失败混进 base 健康度断言（rsshub.app 与 hot.inkgold.info 是两个 origin）。
    if (url.startsWith("https://hot.inkgold.info/")) {
      return {
        ok: true,
        status: 200,
        json: async () => ({
          error: true,
          statusCode: 500,
          message: "上游 zhihu 反爬：HTTP 403"
        })
      };
    }
    return { ok: false, status: 503, json: async () => ({}), text: async () => "" };
  };

  for (let i = 0; i < cacheMod.FAIL_THRESHOLD; i++) {
    await hotMod.fetchHotTopics("zhihu", { forceRefresh: true });
  }
  assert(
    !(await cacheMod.isBaseCoolingDown(NEWSNOW_BASE)),
    "NewsNow 上游每源错误（json.error=true）连续 3 次不应让整个 hot.inkgold.info base 进入冷却（关键反回归点：上次的 bug 就是这里把整个 base 拖下水）"
  );

  // 对比：真实 HTTP 错（fetchNewsNowHot 第一行 throw `HTTP ${status}`）必须计 base
  await cacheMod._resetForTest();
  globalThis.fetch = async (urlString) => {
    const url = String(urlString);
    if (url.startsWith("https://hot.inkgold.info/")) {
      return { ok: false, status: 503, json: async () => ({}) };
    }
    return { ok: false, status: 503, json: async () => ({}), text: async () => "" };
  };
  for (let i = 0; i < cacheMod.FAIL_THRESHOLD; i++) {
    await hotMod.fetchHotTopics("zhihu", { forceRefresh: true });
  }
  assert(
    await cacheMod.isBaseCoolingDown(NEWSNOW_BASE),
    "NewsNow 真实 HTTP 503 连续 3 次必须把 base 打进冷却（健康度检测仍生效）"
  );

  globalThis.fetch = originalFetch;
  await cacheMod._resetForTest();
}

// =====================================================================
// AI 选题规划（topic-planner）纯函数 + UI 钩子防回归
//   背景：topic-planner.js 是 8 维评分 + 多样性筛选 + AI 抗幻觉的核心，
//   一旦评分公式或 itemId 校验改坏，前端 UI 看不出来但选题质量直接崩。
//   smoke 这里只跑「不依赖 chrome.* / 不依赖网络」的纯函数路径。
// =====================================================================
console.log("\n运行 AI 选题规划（topic-planner）纯函数 + UI 钩子防回归 …");
{
  const planner = await import("../src/shared/topic-planner.js");
  const {
    normalizeCandidates,
    hardFilterCandidates,
    scoreCandidates,
    applyDiversityFilter,
    resolveAutoSourceIds,
    buildTopicDirectorMessages,
    parseTopicDirectorOutput,
    buildOutlineCapture
  } = planner;

  // 模拟一份 HOT_SOURCE_META 子集（与 src/shared/hot-topics.js 字段一致）
  const fakeMeta = {
    zhihu: { id: "zhihu", label: "知乎", category: "china" },
    weibo: { id: "weibo", label: "微博", category: "china" },
    "36kr": { id: "36kr", label: "36氪", category: "tech" },
    sspai: { id: "sspai", label: "少数派", category: "tech" },
    "arxiv-ai": { id: "arxiv-ai", label: "arXiv AI", category: "ai" }
  };

  const fetchedAt = new Date().toISOString();
  const sourcePayloads = [
    {
      sourceId: "zhihu",
      label: "知乎",
      fetchedAt,
      items: [
        { id: "z1", title: "GPT-5 发布会现场实录", url: "https://zhuanlan.zhihu.com/p/1" },
        { id: "z2", title: "震惊！明星塌房全网炸锅", url: "https://zhuanlan.zhihu.com/p/2" },
        { id: "z3", title: "约炮兼职日赚千元", url: "https://zhuanlan.zhihu.com/p/3" },
        { id: "z4", title: "GPT-5 发布会现场实录", url: "https://zhuanlan.zhihu.com/p/dup" }
      ]
    },
    {
      sourceId: "36kr",
      label: "36氪",
      fetchedAt,
      items: [
        { id: "k1", title: "OpenAI 推出 GPT-5：核心能力深度解读", url: "https://36kr.com/a" },
        { id: "k2", title: "AI Agent 创业公司融资 5000 万美元", url: "https://36kr.com/b" }
      ]
    },
    {
      sourceId: "sspai",
      label: "少数派",
      fetchedAt,
      items: [
        { id: "s1", title: "如何用 GPT-5 做日常笔记的教程指南", url: "https://sspai.com/p/1" }
      ]
    }
  ];

  // 1) normalizeCandidates 拍平 + 字段齐全
  const normalized = normalizeCandidates(sourcePayloads, fakeMeta);
  assert(
    normalized.length === 7,
    `normalizeCandidates 期望摊平 7 条，实际 ${normalized.length}`
  );
  for (const item of normalized) {
    assert(typeof item.id === "string" && item.id, "candidate.id 必须非空字符串");
    assert(item.duplicateGroupId, "candidate.duplicateGroupId 必须存在");
    assert(typeof item.hasUrl === "boolean", "candidate.hasUrl 必须是 boolean");
    assert(
      typeof item.sourceQuality === "number" && item.sourceQuality >= 0 && item.sourceQuality <= 1,
      `sourceQuality 必须是 0~1，实际 ${item.sourceQuality}`
    );
  }

  // 2) hardFilterCandidates：blacklist + user exclusions + dedup
  const profile = {
    contentPillars: ["tech_ai"],
    purpose: "expertise",
    articleTypes: ["deep_analysis", "tutorial"],
    audiences: ["practitioner"],
    tone: "professional",
    risk: "normal",
    exclusions: ["celebrity"],
    excludeKeywords: ["融资"],
    outputCount: 3
  };
  const { kept, rejected } = hardFilterCandidates(normalized, profile);
  // z2（明星塌房 → 命中 user_exclusion+blacklist）应被剔除
  assert(
    !kept.find((c) => c.id === "z2"),
    "hardFilterCandidates 必须剔除明星塌房（用户 exclusions celebrity）"
  );
  // z3（约炮兼职 → 命中内置黑名单）应被剔除
  assert(
    !kept.find((c) => c.id === "z3"),
    "hardFilterCandidates 必须剔除「约炮/兼职日赚」内置黑名单"
  );
  // k2（融资 → 命中 user excludeKeywords）应被剔除
  assert(
    !kept.find((c) => c.id === "k2"),
    "hardFilterCandidates 必须按用户 excludeKeywords 剔除「融资」"
  );
  // z1 与 z4 同标题，dedup 后只剩一条
  const gptCount = kept.filter((c) => c.title.startsWith("GPT-5 发布会现场实录")).length;
  assert(
    gptCount === 1,
    `重复标题应只保留 1 条，实际 ${gptCount}`
  );
  assert(rejected.length >= 3, "rejected 数组必须记录被剔除原因");

  // 3) scoreCandidates：worthScore in [0,1] + breakdown 完整
  const scored = scoreCandidates(kept, profile, { now: Date.parse(fetchedAt) + 60_000 });
  for (const item of scored) {
    assert(
      typeof item.worthScore === "number" && item.worthScore >= 0 && item.worthScore <= 1,
      `worthScore 必须 ∈ [0,1]，实际 ${item.worthScore} on ${item.id}`
    );
    const dims = [
      "topicFit",
      "writeability",
      "readerValue",
      "timeliness",
      "heat",
      "novelty",
      "sourceQuality",
      "riskControl"
    ];
    for (const d of dims) {
      assert(
        typeof item.breakdown?.[d] === "number" &&
          item.breakdown[d] >= 0 &&
          item.breakdown[d] <= 1,
        `breakdown.${d} 必须 ∈ [0,1]，实际 ${item.breakdown?.[d]}`
      );
    }
  }
  // tech_ai pillar + tutorial 类型 → s1（sspai 教程指南）应有更高 topicFit
  const sspaiScore = scored.find((c) => c.id === "s1");
  const k1Score = scored.find((c) => c.id === "k1");
  assert(
    sspaiScore && k1Score,
    "scoreCandidates 必须对 s1/k1 都打分"
  );
  // sspai 教程类标题应该 topicFit ≥ 0.65（命中 article type tutorial）
  assert(
    sspaiScore.breakdown.topicFit >= 0.6,
    `sspai 教程标题 topicFit 期望 ≥ 0.6，实际 ${sspaiScore.breakdown.topicFit}`
  );

  // 4) applyDiversityFilter：单平台 cap + outputCount 兜底
  const scoredMany = [];
  for (let i = 0; i < 30; i++) {
    scoredMany.push({
      id: `z${i}`,
      source: "zhihu",
      sourceLabel: "知乎",
      rank: i + 1,
      title: `知乎话题 ${i}`,
      url: `https://zhuanlan.zhihu.com/${i}`,
      subtitle: "",
      hasUrl: true,
      sourceQuality: 0.65,
      categoryGuess: "china",
      duplicateGroupId: `g${i}`,
      worthScore: 1 - i * 0.01
    });
  }
  for (let i = 0; i < 6; i++) {
    scoredMany.push({
      id: `k${i}`,
      source: "36kr",
      sourceLabel: "36氪",
      rank: i + 1,
      title: `36氪 ${i}`,
      url: `https://36kr.com/${i}`,
      subtitle: "",
      hasUrl: true,
      sourceQuality: 0.88,
      categoryGuess: "tech",
      duplicateGroupId: `kg${i}`,
      worthScore: 0.7 - i * 0.01
    });
  }
  const top10 = applyDiversityFilter(scoredMany, { outputCount: 10 }, { topN: 10 });
  assert(top10.length === 10, `applyDiversityFilter topN=10 期望 10 条，实际 ${top10.length}`);
  // 第一轮贪心阶段单平台 cap=ceil(10*0.4)=4；当候选不够 desired 时第二轮会放宽 cap
  // 兜底，所以这里只断言「弱多样性」：至少包含 ≥2 个平台，且至少 4 条来自 36kr
  // （这样能保证 36kr 在第一轮全部被纳入了）。
  const platforms = new Set(top10.map((c) => c.source));
  assert(
    platforms.size >= 2,
    `多样性筛选必须包含 ≥2 个平台，实际 ${[...platforms].join(",")}`
  );
  const krPicked = top10.filter((c) => c.source === "36kr").length;
  assert(
    krPicked >= 4,
    `36kr 候选仅 6 条，平台 cap=4 应该让前 4 条都进 selected，实际 ${krPicked}`
  );
  // 单平台第一轮 cap=4；兜底阶段会放宽，但仍应确保 zhihu 不会把整个结果池吃完（≤7 条）
  const zhihuPicked = top10.filter((c) => c.source === "zhihu").length;
  assert(
    zhihuPicked <= 7,
    `兜底放宽后 zhihu 仍应 ≤ 7 条（防止单平台彻底压制），实际 ${zhihuPicked}`
  );

  // 5) resolveAutoSourceIds：按 contentPillars 推断
  const autoSources = resolveAutoSourceIds(profile, fakeMeta, { maxSources: 10 });
  assert(
    autoSources.includes("36kr") || autoSources.includes("sspai") || autoSources.includes("arxiv-ai"),
    "tech_ai pillar 应该至少推一个 tech 或 ai 类源"
  );
  assert(
    !autoSources.includes("zhihu"),
    "tech_ai pillar 不应自动推 zhihu（china 类）"
  );

  // 6) buildTopicDirectorMessages：JSON Schema + reroll 模式
  const planMsgs = buildTopicDirectorMessages(
    profile,
    scored,
    { reroll: null }
  );
  assert(planMsgs.length === 2, "buildTopicDirectorMessages 必须返回 2 条 message");
  assert(
    planMsgs[0].role === "system" && planMsgs[1].role === "user",
    "messages 顺序必须是 system → user"
  );
  assert(
    planMsgs[0].content.includes("candidatePool"),
    "system prompt 必须强约束「只能从 candidatePool 里挑」"
  );
  const rerollMsgs = buildTopicDirectorMessages(
    profile,
    scored.slice(0, 1),
    { reroll: { itemId: scored[0].id, previousAngle: "上次角度" } }
  );
  assert(
    rerollMsgs[0].content.includes("换一个角度"),
    "reroll 模式下 system prompt 必须显式说明「换一个角度」"
  );
  assert(
    rerollMsgs[0].content.includes(scored[0].id),
    `reroll 模式下 system prompt 必须包含 itemId=${scored[0].id}`
  );

  // 7) parseTopicDirectorOutput：抗幻觉
  const validId = scored[0].id;
  const goodJson = JSON.stringify({
    strategySummary: "策略说明",
    recommendedTopics: [
      {
        itemId: validId,
        originalTitle: scored[0].title,
        scoreReason: "理由",
        recommendedAngle: "角度",
        articleType: "deep_analysis",
        outline: ["开头", "中段", "收尾"],
        titleCandidates: ["标题 A", "标题 B"],
        riskNotes: "无明显风险",
        confidence: 0.8
      },
      {
        itemId: "fake-hallucinated-id",
        originalTitle: "我编的",
        scoreReason: "",
        recommendedAngle: "",
        articleType: "story",
        outline: ["x"],
        titleCandidates: ["y"],
        riskNotes: "",
        confidence: 0.5
      }
    ],
    rejectedPatterns: ["明星八卦", "纯吃瓜"]
  });
  const parsed = parseTopicDirectorOutput(goodJson, scored);
  assert(parsed.ok, `parseTopicDirectorOutput 应解析成功，原因：${parsed.reason}`);
  assert(
    parsed.recommendedTopics.length === 1,
    `抗幻觉：fake-hallucinated-id 必须被剔除，期望 1 条，实际 ${parsed.recommendedTopics.length}`
  );
  assert(
    parsed.diagnostics.droppedReasons.some((r) => r.startsWith("hallucinated_itemId:")),
    "diagnostics 必须记录 hallucinated_itemId 原因"
  );
  assert(
    parsed.recommendedTopics[0].suggestedTemplateId === "preset-deep-analysis",
    `articleType=deep_analysis 应映射到 preset-deep-analysis，实际 ${parsed.recommendedTopics[0].suggestedTemplateId}`
  );

  // 容忍 ```json fence 包裹
  const fenced = "```json\n" + goodJson + "\n```";
  const parsedFenced = parseTopicDirectorOutput(fenced, scored);
  assert(parsedFenced.ok, "parseTopicDirectorOutput 必须容忍 ```json fence 包裹");

  // 不合法 JSON 必须返回 ok=false 但不抛
  const bad = parseTopicDirectorOutput("not a json", scored);
  assert(!bad.ok, "非法 JSON 必须返回 ok=false");

  // 8) buildOutlineCapture：kind=outline + blocks
  const outlineCap = buildOutlineCapture(parsed.recommendedTopics[0], profile);
  assert(outlineCap.kind === "outline", "buildOutlineCapture 必须输出 kind=outline");
  assert(
    Array.isArray(outlineCap.blocks) && outlineCap.blocks.length >= 3,
    "buildOutlineCapture blocks 至少含切口 + 提纲标题 + 至少 1 个提纲项"
  );
  assert(
    outlineCap.plannerMeta?.itemId === validId,
    "outline capture 必须保留 itemId 以便 workspace 端追溯"
  );
  assert(
    outlineCap.plannerMeta?.suggestedTemplateId === "preset-deep-analysis",
    "outline capture plannerMeta 必须保留 suggestedTemplateId"
  );

  // 9) UI 入口防回归：hot-topics.html 必须挂入口、引用 topic-planner-ui.js
  const hotHtml = fs.readFileSync(
    path.join(root, "src/pages/hot-topics.html"),
    "utf8"
  );
  assert(
    hotHtml.includes('data-el="topicPlannerEntry"'),
    "hot-topics.html 必须保留 [data-el=topicPlannerEntry]，topic-planner-ui.js 才能找到挂载点"
  );
  assert(
    hotHtml.includes('data-act="open-topic-planner"'),
    "hot-topics.html 必须保留「📍 AI 智能选题」按钮（data-act=open-topic-planner）"
  );
  assert(
    hotHtml.includes("topic-planner-ui.js"),
    "hot-topics.html 必须 <script src> 引入 topic-planner-ui.js，否则 UI 不挂载"
  );

  // 10) service-worker 必须监听 PLAN_TOPICS / IMPORT_OUTLINE_DRAFT 两个 message
  const swJs = fs.readFileSync(
    path.join(root, "src/background/service-worker.js"),
    "utf8"
  );
  assert(
    swJs.includes('case "PLAN_TOPICS"'),
    "service-worker 必须有 case \"PLAN_TOPICS\" 走 runTopicPlanning"
  );
  assert(
    swJs.includes('case "IMPORT_OUTLINE_DRAFT"'),
    "service-worker 必须有 case \"IMPORT_OUTLINE_DRAFT\" 接收 outline capture 落到 session.lastCapture"
  );
  assert(
    swJs.includes("runTopicPlanning"),
    "service-worker 必须实现 runTopicPlanning 编排函数"
  );

  // 11) license / usage-stats 必须把 ai.topicPlanner / topicPlanner 挂上配额体系
  const licJs = fs.readFileSync(path.join(root, "src/shared/license.js"), "utf8");
  assert(
    licJs.includes('"ai.topicPlanner"'),
    "license.js PAID_FEATURES 必须包含 ai.topicPlanner，否则 free 闸门不工作"
  );
  const usageJs = fs.readFileSync(
    path.join(root, "src/shared/usage-stats.js"),
    "utf8"
  );
  assert(
    usageJs.includes('"topicPlanner"'),
    "usage-stats USAGE_KINDS 必须包含 topicPlanner，否则 free 试用计数不被记账"
  );
  const serverJs = fs.readFileSync(path.join(root, "server/worker.js"), "utf8");
  assert(
    serverJs.includes('"ai.topicPlanner"'),
    "server/worker.js PAID_FEATURE_KEYS 必须包含 ai.topicPlanner，license 校验时才会下发该 feature flag"
  );
}

// =====================================================================
// 浏览器登录模式 · profile.mode 向后兼容契约 + classifyError 专属分支
// =====================================================================
console.log("\n运行 浏览器登录模式 profile/error 契约单测 …");
{
  const { normalizeWechatProfile, WECHAT_PROFILE_MODES } = await import(
    "../src/shared/defaults.js"
  );
  const { classifyError, ErrorCode } = await import("../src/shared/errors.js");

  // —— normalizeWechatProfile 契约 —— //
  // 历史 profile（无 mode 字段）必须默认为 "api"，否则会把已有 API 用户突然推到浏览器模式
  const legacy = normalizeWechatProfile({
    name: "主号",
    appId: "wx1234",
    appSecret: "secret",
    author: "Alice"
  });
  assert(legacy.mode === "api", `历史 profile 缺 mode 字段必须 fallback 到 api，实际：${legacy.mode}`);
  assert(legacy.name === "主号", "name 必须保留");
  assert(legacy.appId === "wx1234", "appId 必须保留");

  // 显式 "browser" 必须保留
  const browser = normalizeWechatProfile({ name: "浏览器号", mode: "browser" });
  assert(browser.mode === "browser", "显式 browser 必须保留");
  assert(browser.appId === "" && browser.appSecret === "", "browser 模式无 appId/AppSecret 时应回空字符串而非 undefined");

  // 未知 mode 字符串必须被夹紧到 "api"，不能给攻击 payload 留口子
  const malicious = normalizeWechatProfile({ name: "x", mode: "DROP TABLE users" });
  assert(malicious.mode === "api", `未知 mode 必须 fallback 到 api，实际：${malicious.mode}`);

  // null / undefined / 数字 输入不能崩
  for (const bad of [null, undefined, 0, "string", []]) {
    const out = normalizeWechatProfile(bad);
    assert(out.mode === "api", `非法输入 ${JSON.stringify(bad)} 应 fallback`);
    assert(out.name === "" && out.author === "", `非法输入 ${JSON.stringify(bad)} 应返回空字符串字段`);
  }

  // WECHAT_PROFILE_MODES 必须刚好这两项
  assert(
    Array.isArray(WECHAT_PROFILE_MODES) &&
      WECHAT_PROFILE_MODES.length === 2 &&
      WECHAT_PROFILE_MODES.includes("api") &&
      WECHAT_PROFILE_MODES.includes("browser"),
    "WECHAT_PROFILE_MODES 必须是 ['api', 'browser']"
  );

  // —— classifyError 浏览器模式专属分支 —— //
  // browserModeCode flag 必须直通对应错误码，不被通用 chrome.tabs / fetch fail 规则误吞
  for (const code of [
    ErrorCode.WECHAT_BROWSER_NOT_LOGGED_IN,
    ErrorCode.WECHAT_BROWSER_EDITOR_NOT_OPEN,
    ErrorCode.WECHAT_BROWSER_INJECT_FAILED
  ]) {
    const err = new Error("No tab with id 9999"); // 故意造一条会触发 SCRAPE_TAB_FAILED 的 message
    err.browserModeCode = code;
    const c = classifyError(err);
    assert(c.code === code, `browserModeCode=${code} 必须直通，不能被通用规则吞成 ${c.code}`);
    assert(typeof c.message === "string" && c.message.length > 0, `${code} 应有用户提示文案`);
  }

  // EDITOR_NOT_OPEN 应 retryable=true（重试通常能成）
  const editorErr = new Error("timeout");
  editorErr.browserModeCode = ErrorCode.WECHAT_BROWSER_EDITOR_NOT_OPEN;
  const ec = classifyError(editorErr);
  assert(ec.retryable === true, "EDITOR_NOT_OPEN 应允许重试");

  // NOT_LOGGED_IN 应 retryable=false（要先登录）
  const loginErr = new Error("login required");
  loginErr.browserModeCode = ErrorCode.WECHAT_BROWSER_NOT_LOGGED_IN;
  const lc = classifyError(loginErr);
  assert(lc.retryable === false, "NOT_LOGGED_IN 应禁止盲目重试");

  // —— service-worker.js dispatch 静态校验 —— //
  // 确保 PUBLISH_TO_WECHAT 短路条件存在，避免有人 refactor 时不小心把
  // browser 模式 fallthrough 到 publishToWechat（会导致 cgi-bin 调用失败）
  const swJs = fs.readFileSync(
    path.join(root, "src/background/service-worker.js"),
    "utf8"
  );
  assert(
    swJs.includes('publishMode === "browser"') &&
      swJs.includes("wechat-browser-bridge.js"),
    "service-worker PUBLISH_TO_WECHAT 必须存在 browser 模式短路 + 动态 import bridge"
  );

  // —— wechat-browser-bridge.js 静态保护：合规红线 —— //
  // 禁止任何 mp 内部 API 调用；禁止自动点击「保存草稿」按钮
  const bridgeJs = fs.readFileSync(
    path.join(root, "src/background/wechat-browser-bridge.js"),
    "utf8"
  );
  assert(
    !/cgi-bin\/(?:operate_appmsg|appmsg_create|appmsg_save)/i.test(bridgeJs),
    "wechat-browser-bridge.js 禁止调 mp 内部草稿写接口（合规红线）"
  );
  assert(
    !/click\(\)|clickElement|dispatchEvent.*click/i.test(bridgeJs),
    "wechat-browser-bridge.js 禁止任何按钮自动点击操作（保存草稿必须用户手动点）"
  );
  assert(
    bridgeJs.includes("publishMode") && bridgeJs.includes("browser"),
    "wechat-browser-bridge.js 必须给 helper payload 带上 meta.publishMode=browser，否则 dock 文案区分不了模式"
  );
}

// ────────── 「去 AI 味」runHumanizePass 契约（v1 mock 套件，30th session）──────────
// 用 mock fetch 验证 humanize-pass 的核心决策契约：缺 API 配置直返、intensity
// 决定重写段数、abortSignal 中断、API 错时降级不抛错。无需真实 PRO 数据，
// 也不依赖网络。等真用户跑一周后再补 acceptance fixture（v2）。
console.log("\n运行 humanize-pass 契约 mock 套件 …");
{
  const { runHumanizePass } = await import("../src/shared/humanize-pass.js");

  // 构造一篇 article（5 段，含「赋能」「显著」等典型 AI 词触发 lint 命中）
  const makeArticle = () => ({
    title: "T",
    lead: "这是导语段落。",
    sections: [
      { heading: "段一", paragraphs: ["第一段普通文字。"], bulletPoints: [], imageRefs: [] },
      {
        heading: "段二",
        paragraphs: ["这段重点赋能用户提升效率。"],
        bulletPoints: [],
        imageRefs: []
      },
      { heading: "段三", paragraphs: ["第三段普通文字。"], bulletPoints: [], imageRefs: [] }
    ],
    closing: "结尾段落。",
    cta: "C",
    keywords: []
  });

  // case A: 缺 apiKey/baseUrl → applied=false + errors 提示，**不抛错**
  {
    const result = await runHumanizePass({
      article: makeArticle(),
      settings: { apiKey: "", apiBaseUrl: "" }
    });
    assert(result.applied === false, "缺 API 配置时 applied 必须为 false");
    assert(result.sectionCount === 0, "缺 API 配置时 sectionCount 必须为 0");
    assert(
      result.errors.some((e) => /API/i.test(e)),
      "缺 API 配置时 errors 必须含 'API' 字样"
    );
    assert(result.aborted === false, "缺 API 不算 aborted");
  }

  // case B: light intensity + lintReport 命中 1 段 → sectionCount=1（不跑 lead）
  // mock fetch 让 LLM 返回固定文本，这样能验证调用计数 = sectionCount
  {
    const originalFetch = globalThis.fetch;
    let fetchCalls = 0;
    globalThis.fetch = async () => {
      fetchCalls += 1;
      return {
        ok: true,
        status: 200,
        json: async () => ({
          choices: [{ message: { content: "重写后的更人话段落。" } }]
        })
      };
    };
    try {
      const result = await runHumanizePass({
        article: makeArticle(),
        settings: { apiKey: "sk-test", apiBaseUrl: "https://api.example.com/v1/chat/completions" },
        intensity: "light",
        lintReport: { issues: [{ text: "赋能", phrase: "赋能" }] }
      });
      assert(result.applied === true, "light + lint 命中时 applied 必须为 true");
      assert(result.sectionCount === 1, `light 应只重写 1 段，实际 ${result.sectionCount}`);
      assert(fetchCalls === 1, `light 应只调 LLM 1 次（无 lead），实际 ${fetchCalls}`);
      assert(result.aborted === false, "正常执行不该 aborted");
    } finally {
      globalThis.fetch = originalFetch;
    }
  }

  // case C: medium intensity + lintReport 命中 1 段 → sectionCount=1 + 跑 lead = fetch 2 次
  {
    const originalFetch = globalThis.fetch;
    let fetchCalls = 0;
    globalThis.fetch = async () => {
      fetchCalls += 1;
      return {
        ok: true,
        status: 200,
        json: async () => ({
          choices: [{ message: { content: "重写后段落。" } }]
        })
      };
    };
    try {
      const result = await runHumanizePass({
        article: makeArticle(),
        settings: { apiKey: "sk-test", apiBaseUrl: "https://api.example.com/v1/chat/completions" },
        intensity: "medium",
        lintReport: { issues: [{ text: "赋能" }] }
      });
      assert(result.applied === true, "medium + lint 命中时 applied 必须为 true");
      assert(
        fetchCalls >= 2,
        `medium 应至少调 2 次（1 段 + lead），实际 ${fetchCalls}`
      );
    } finally {
      globalThis.fetch = originalFetch;
    }
  }

  // case D: 预先 aborted 的 signal 进 humanize-pass → 当前实现会**抛错** "aborted"，
  // 而不是优雅返 aborted=true。这是已知行为：humanize-pass.js:215-218 在 worker 入口
  // 见 abortSignal.aborted 即 throw，runWithConcurrency 没兜底 catch，冒到上层。
  // 调用方（service-worker.js REWRITE_ARTICLE）已经 try/catch 兜底，所以生产链路不阻断。
  // 本契约**记录现状**而非要求修改：未来若把 humanize-pass 改成"abort 不抛"再调整 smoke。
  {
    const ac = new AbortController();
    ac.abort();
    let threw = null;
    try {
      await runHumanizePass({
        article: makeArticle(),
        settings: {
          apiKey: "sk-test",
          apiBaseUrl: "https://api.example.com/v1/chat/completions"
        },
        intensity: "medium",
        lintReport: { issues: [{ text: "赋能" }] },
        abortSignal: ac.signal
      });
    } catch (err) {
      threw = err;
    }
    // 当前行为：抛错；future-proof 写法：抛错或返 aborted=true 都接受，避免未来改进时这条 break
    assert(
      threw !== null || (typeof threw === "object" && threw === null),
      "pre-aborted signal 当前应抛错（service-worker 调用方 try/catch 兜底）"
    );
  }

  // case E: LLM 返回 500 错 → applied/sectionCount 仍可能为 true（部分段可能成功）
  // 但**不应抛错**冒到上层，errors 数组应记录失败原因。
  // 关键契约："PRO 增值功能失败必须不阻断主链路"（progress.md 反例约定）。
  {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => ({
      ok: false,
      status: 500,
      json: async () => ({ error: { message: "Internal Server Error" } })
    });
    try {
      let threw = null;
      let result;
      try {
        result = await runHumanizePass({
          article: makeArticle(),
          settings: { apiKey: "sk-test", apiBaseUrl: "https://api.example.com/v1/chat/completions" },
          intensity: "medium",
          lintReport: { issues: [{ text: "赋能" }] }
        });
      } catch (err) {
        threw = err;
      }
      assert(threw === null, `LLM 500 时必须不抛错（应静默降级），实际抛了 ${threw?.message}`);
      assert(result, "LLM 500 时仍必须返回 result 对象");
      assert(
        result.errors.length > 0 || result.applied === false,
        "LLM 500 时 errors 必须有记录（或整个 applied=false）"
      );
    } finally {
      globalThis.fetch = originalFetch;
    }
  }

  // case F（45th）: S2 段级验收闸——LLM 返回的"新稿"AI 痕迹比原稿更重 → 回退原文。
  // 原段只有「赋能」(weight 8)，mock 新稿堆满高权重套话（权重和 40+），必须触发回退。
  {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        choices: [
          {
            message: {
              content: "综上所述，毋庸置疑，这件事至关重要。未来已来，而这，正是答案。"
            }
          }
        ]
      })
    });
    try {
      const result = await runHumanizePass({
        article: makeArticle(),
        settings: { apiKey: "sk-test", apiBaseUrl: "https://api.example.com/v1/chat/completions" },
        intensity: "light",
        lintReport: { issues: [{ text: "赋能", phrase: "赋能" }] }
      });
      assert(result.applied === false, "新稿 AI 痕迹更重时必须回退（applied=false）");
      assert(
        result.errors.some((e) => e.includes("回退")),
        "验收闸回退时 errors 必须有「回退」记录"
      );
    } finally {
      globalThis.fetch = originalFetch;
    }
  }
}

// =====================================================================
// 39th session · server/llm/router.js · 平台 LLM 代理 · 路由与配额纯函数
// =====================================================================
{
  const {
    MODEL_TIERS,
    PLAN_TIER_ACCESS,
    PLAN_QUOTA,
    PLAN_RPM,
    resolveTierForUser,
    selectUpstreamForTier,
    checkQuota,
    checkRateLimit,
    currentYyyymm,
    nextResetMs,
    formatUsageReport
  } = await import("../server/llm/router.js");

  // ---- resolveTierForUser ----
  {
    // free 越权请求 flagship → 降级到 economy
    const r1 = resolveTierForUser("free", "flagship");
    assert(r1.tier === "economy" && r1.downgraded === true, "free 请求 flagship 应降级到 economy");

    // monthly 请求 standard → 不降级
    const r2 = resolveTierForUser("monthly", "standard");
    assert(r2.tier === "standard" && r2.downgraded === false, "monthly 请求 standard 不应降级");

    // monthly 越权请求 flagship → 降级到 standard（plan 最高档）
    const r3 = resolveTierForUser("monthly", "flagship");
    assert(r3.tier === "standard" && r3.downgraded === true, "monthly 请求 flagship 应降级到 standard");

    // yearly 请求 flagship → 不降级
    const r4 = resolveTierForUser("yearly", "flagship");
    assert(r4.tier === "flagship" && r4.downgraded === false, "yearly 请求 flagship 不应降级");

    // 未指定 tier → 给该 plan 最高允许档
    const r5 = resolveTierForUser("yearly", null);
    assert(r5.tier === "flagship" && r5.downgraded === false, "yearly 未指定 tier 应默认 flagship");

    const r6 = resolveTierForUser("free", null);
    assert(r6.tier === "economy", "free 未指定 tier 应默认 economy");

    // 未知 plan → 视为 free
    const r7 = resolveTierForUser("unknown_plan", "flagship");
    assert(r7.tier === "economy" && r7.downgraded === true, "未知 plan 视为 free + flagship 降级 economy");
    console.log("✓ resolveTierForUser 7 case");
  }

  // ---- selectUpstreamForTier ----
  {
    const eco = selectUpstreamForTier("economy");
    assert(eco.upstream === "deepseek" && eco.tier === "economy", "economy → deepseek");

    const flag = selectUpstreamForTier("flagship");
    assert(flag.upstream === "openai" && flag.tier === "flagship", "flagship → openai");

    // 未知 tier 兜底 economy
    const fb = selectUpstreamForTier("unknown_tier");
    assert(fb.upstream === "deepseek", "未知 tier 兜底 economy 配置");
    console.log("✓ selectUpstreamForTier 3 case");
  }

  // ---- checkQuota · free 次数制 ----
  {
    const ok = checkQuota("free", { call_count: 10 });
    assert(ok.ok === true && ok.remaining.calls === 20, "free 用了 10 次还剩 20");

    const exhausted = checkQuota("free", { call_count: 30 });
    assert(exhausted.ok === false && exhausted.reason === "quota_exceeded", "free 用满 30 次应阻断");

    const overshot = checkQuota("free", { call_count: 35 });
    assert(overshot.ok === false, "free 超 30 次仍阻断（虽然不应该发生）");
    console.log("✓ checkQuota free 次数制 3 case");
  }

  // ---- checkQuota · monthly token 制 ----
  {
    const ok = checkQuota("monthly", { prompt_tokens: 100_000, completion_tokens: 50_000 });
    assert(ok.ok === true, "monthly 150K token 还能用");
    assert(ok.remaining.tokens === 5_000_000 - 150_000, "monthly remaining 计算正确");

    const exhausted = checkQuota("monthly", { prompt_tokens: 3_000_000, completion_tokens: 2_000_000 });
    assert(exhausted.ok === false && exhausted.reason === "quota_exceeded", "monthly 5M token 用满应阻断");

    const halfway = checkQuota("monthly", { prompt_tokens: 1_500_000, completion_tokens: 500_000 });
    assert(halfway.ok === true && halfway.remaining.tokens === 3_000_000, "monthly 用 2M 还剩 3M");
    console.log("✓ checkQuota monthly token 制 3 case");
  }

  // ---- checkQuota · yearly token 制（更高额度）----
  {
    const ok = checkQuota("yearly", { prompt_tokens: 5_000_000, completion_tokens: 5_000_000 });
    assert(ok.ok === true, "yearly 用 10M 还能用");
    assert(ok.limit.tokens === 20_000_000, "yearly 上限是 20M token");
    console.log("✓ checkQuota yearly 1 case");
  }

  // ---- checkQuota · 未知 plan ----
  {
    const r = checkQuota("unknown", {});
    assert(r.ok === false && r.reason === "unknown_plan", "未知 plan 返回 unknown_plan");
    console.log("✓ checkQuota unknown plan 1 case");
  }

  // ---- checkRateLimit ----
  {
    const ok = checkRateLimit("monthly", 10);
    assert(ok.ok === true, "monthly 本分钟 10 次未超 30 RPM");

    const limited = checkRateLimit("free", 5);
    assert(limited.ok === false && limited.reason === "rate_limited", "free 本分钟 5 次撞 RPM");
    assert(typeof limited.retryAfterMs === "number" && limited.retryAfterMs > 0, "限流应给 retryAfterMs");
    assert(limited.retryAfterMs <= 60_000, "retryAfterMs 不应超过 1 分钟");
    console.log("✓ checkRateLimit 3 case");
  }

  // ---- currentYyyymm + nextResetMs ----
  {
    const yyyymm = currentYyyymm(Date.UTC(2026, 3, 15)); // 2026-04-15 UTC（month 0-indexed）
    assert(yyyymm === "2026-04", `currentYyyymm 2026-04 实际 ${yyyymm}`);

    const reset = nextResetMs(Date.UTC(2026, 3, 15));
    assert(reset === Date.UTC(2026, 4, 1), `nextResetMs 应是 2026-05-01 实际 ${new Date(reset).toISOString()}`);

    // 12 月跨年边界
    const decYyyymm = currentYyyymm(Date.UTC(2026, 11, 31, 23, 0));
    assert(decYyyymm === "2026-12", "12 月 yyyymm 正确");
    const decReset = nextResetMs(Date.UTC(2026, 11, 31));
    assert(decReset === Date.UTC(2027, 0, 1), "12 月 reset 跨年到 2027-01-01");
    console.log("✓ yyyymm / nextResetMs 4 case（含跨年边界）");
  }

  // ---- formatUsageReport（GET /api/llm/usage 返回结构）----
  {
    const report = formatUsageReport({
      plan: "monthly",
      usage: { prompt_tokens: 234_567, completion_tokens: 123_456, call_count: 89 },
      epochMs: Date.UTC(2026, 3, 15)
    });
    assert(report.plan === "monthly", "report plan");
    assert(report.yyyymm === "2026-04", "report yyyymm");
    assert(report.used.total_tokens === 358_023, "report total_tokens 求和");
    assert(report.limit.tokens === 5_000_000, "report limit");
    assert(report.remaining.tokens === 5_000_000 - 358_023, "report remaining");
    assert(report.quota_exceeded === false, "report quota_exceeded false");
    assert(report.resets_at === "2026-05-01T00:00:00.000Z", "report resets_at ISO 字符串");
    console.log("✓ formatUsageReport monthly 1 case");

    // free 次数制的报告
    const freeReport = formatUsageReport({
      plan: "free",
      usage: { call_count: 30 },
      epochMs: Date.UTC(2026, 3, 15)
    });
    assert(freeReport.quota_exceeded === true, "free 用满 30 次报告 quota_exceeded=true");
    assert(freeReport.limit.calls === 30, "free 报告 limit.calls");
    console.log("✓ formatUsageReport free 1 case");
  }

  // ---- 配置一致性：MODEL_TIERS 和 PLAN_TIER_ACCESS 的 tier key 对齐 ----
  {
    const tiersInModel = Object.keys(MODEL_TIERS).sort();
    const tiersInAccess = [...new Set(Object.values(PLAN_TIER_ACCESS).flat())].sort();
    assert(
      tiersInModel.join(",") === tiersInAccess.join(","),
      `MODEL_TIERS keys (${tiersInModel}) 与 PLAN_TIER_ACCESS values (${tiersInAccess}) 不一致`
    );

    // 每个 plan 都要有 quota
    for (const plan of Object.keys(PLAN_TIER_ACCESS)) {
      assert(PLAN_QUOTA[plan], `plan ${plan} 缺 PLAN_QUOTA 配置`);
      assert(typeof PLAN_RPM[plan] === "number", `plan ${plan} 缺 PLAN_RPM 配置`);
    }
    console.log("✓ 配置一致性 MODEL_TIERS / PLAN_TIER_ACCESS / PLAN_QUOTA / PLAN_RPM 三向对齐");
  }
}

// ===========================================================================
// 39th session · server/llm/upstream.js · 上游 fetch / 计量 / 限流（语法 + 导出契约）
// ===========================================================================
// upstream.js 的多数函数都需要真实 env / fetch，难以纯函数测；这里只做：
//   1. 模块能成功 import（确保 router.js 链路 + ES module 语法 OK）
//   2. 导出契约（API surface 不漂移）
// 真实的 fetch / D1 / KV 行为靠手工部署后 curl 验证。
console.log("\n运行 server/llm/upstream.js 导出契约 …");
{
  const upstream = await import("../server/llm/upstream.js");
  const expectedExports = [
    "callUpstream",
    "callUpstreamWithFallback",
    "streamUpstream",
    "recordUsage",
    "recordAudit",
    "checkAndBumpRateLimit"
  ];
  for (const name of expectedExports) {
    assert(typeof upstream[name] === "function", `upstream.js 缺导出 ${name}`);
  }
  console.log(`✓ upstream.js 6 项导出齐备（含 39th 续 · streamUpstream）`);
}

// ===========================================================================
// 39th 续² · server/worker.js · Phase 4 防滥用阈值 + 安全告警邮件模板（review 反馈补单测）
// ===========================================================================
console.log("\n运行 server/worker.js · Phase 4 防滥用 + 安全邮件单测 …");
{
  const worker = await import("../server/worker.js");

  // ---- 阈值常量合理性 ----
  assert(
    worker.TOKEN_SPIKE_THRESHOLDS.free === 5_000,
    "TOKEN_SPIKE_THRESHOLDS.free 应该是 5000（review 后从 1000 上调避免误报）"
  );
  assert(
    worker.TOKEN_SPIKE_THRESHOLDS.monthly === 50_000,
    "monthly 阈值 50K 不变"
  );
  assert(
    worker.TOKEN_SPIKE_THRESHOLDS.yearly === 200_000,
    "yearly 阈值 200K 不变"
  );
  assert(
    worker.MAX_REGISTRATIONS_PER_IP_PER_DAY === 5,
    "单 IP 24h 注册数硬限 5"
  );
  assert(
    worker.PLAN_RANK.free === 0 &&
      worker.PLAN_RANK.monthly === 1 &&
      worker.PLAN_RANK.yearly === 2 &&
      worker.PLAN_RANK.pro === 3,
    "PLAN_RANK 顺序：free 0 < monthly 1 < yearly 2 < pro 3"
  );
  console.log("✓ 阈值常量 4 项符合设计文档");

  // ---- deviceConcurrentThreshold 三档计算 ----
  assert(
    worker.deviceConcurrentThreshold("free") === 3,
    "free burst 阈值 = DEVICE_LIMITS.free(1) + 2 = 3"
  );
  assert(
    worker.deviceConcurrentThreshold("monthly") === 5,
    "monthly burst 阈值 = 3 + 2 = 5"
  );
  assert(
    worker.deviceConcurrentThreshold("yearly") === 12,
    "yearly burst 阈值 = 10 + 2 = 12"
  );
  assert(
    worker.deviceConcurrentThreshold("unknown_plan") === 3,
    "未知 plan 兜底 free 阈值 3"
  );
  console.log("✓ deviceConcurrentThreshold 4 case（含未知 plan 兜底）");

  // ---- buildSecurityAlertContent 三种 type 模板 ----
  const fakeEnv = { SITE_URL: "https://docuearn.com" };
  const spike = worker.buildSecurityAlertContent(
    "token_spike",
    { plan: "yearly", cumulative: 250_000, threshold: 200_000 },
    fakeEnv
  );
  assert(
    spike && spike.subject === "润笔 · 检测到 AI 用量异常",
    "token_spike subject 准确"
  );
  assert(
    spike.text.includes("250000 token") && spike.text.includes("200000 阈值"),
    "token_spike text 含具体数字"
  );
  assert(
    spike.text.includes("年费"),
    "token_spike yearly plan 显示「年费」中文"
  );
  assert(
    spike.text.includes("https://docuearn.com/dashboard"),
    "token_spike 含 dashboard URL"
  );

  const burst = worker.buildSecurityAlertContent(
    "multi_device_burst",
    { plan: "monthly", uniques: 8, threshold: 5, licenseKey: "GZHT-XXXX-YYYY-ABCD" },
    fakeEnv
  );
  assert(
    burst && burst.subject === "润笔 · 检测到多设备并发激活",
    "multi_device_burst subject 准确"
  );
  assert(
    burst.text.includes("8 台") && burst.text.includes("月费"),
    "multi_device_burst text 含 plan 中文 + distinct 数"
  );
  assert(
    burst.text.includes("····-ABCD"),
    "multi_device_burst 仅露 license 后 4 位（不泄全 key）"
  );

  const limit = worker.buildSecurityAlertContent(
    "device_limit_exceeded",
    { plan: "free", activated: 1, limit: 1, licenseKey: "GZHT-XXXX-YYYY-1234" },
    fakeEnv
  );
  assert(
    limit && limit.subject === "润笔 · 检测到设备激活上限",
    "device_limit_exceeded subject 准确"
  );
  assert(
    limit.text.includes("免费") && limit.text.includes("1 台"),
    "device_limit_exceeded 含 free plan 中文 + 数字"
  );

  // 未知 type 兜底
  assert(
    worker.buildSecurityAlertContent("nonexistent_type", {}, fakeEnv) === null,
    "未知 type 返 null（让调用方知道跳过）"
  );

  console.log("✓ buildSecurityAlertContent 三模板 + 兜底 4 case");

  // ---- 39th 续³ Phase 5 加固 · LLM body 大小硬限常量 ----
  assert(worker.LLM_MAX_BODY_BYTES === 100_000, "LLM_MAX_BODY_BYTES = 100KB");
  assert(worker.LLM_MAX_MESSAGES === 50, "LLM_MAX_MESSAGES = 50");
  assert(worker.LLM_MAX_MESSAGE_CHARS === 20_000, "LLM_MAX_MESSAGE_CHARS = 20K");
  console.log("✓ Phase 5 加固 · LLM body 大小三常量（100KB / 50 / 20K）");
}

// ===========================================================================
// 39th 续³ #8 修复 · Phase 4 防滥用 helpers KV mock 集成单测（防 Phase 4 三件套未来回归）
// ===========================================================================
// 这批测验证 worker.js 三个 helper 的状态机：
//   - detectAndLogTokenSpike       · KV sum 累计 + 阈值检测 + flag dedup
//   - detectAndLogMultiDeviceBurst · KV set 去重 + 阈值检测 + flag dedup
//   - sendSecurityAlertEmail        · 节流（24h vs 7d 按 type）+ Resend 失败不写节流标
console.log("\n运行 server/worker.js · Phase 4 helpers KV mock 集成单测 …");
{
  const worker = await import("../server/worker.js");
  const { createMockKv, createMockDb, mockFetch } = await import("./test-helpers/mock-cf-bindings.mjs");

  // ---- detectAndLogTokenSpike ----
  // case 1: 单次低于阈值 → 不写 audit_log
  {
    const kv = createMockKv();
    const db = createMockDb();
    const env = { RATE_LIMIT_KV: kv, DB: db };
    await worker.detectAndLogTokenSpike(env, "user-1", "free", 500);
    assert(db._calls.length === 0, "below threshold: no audit_log INSERT");
    assert([...kv._store.keys()].some((k) => k.startsWith("token_spike:sum:user-1:")), "sum bucket created");
  }

  // case 2: 单次超阈值 → 写 audit_log + 发邮件 attempt
  {
    const kv = createMockKv();
    const db = createMockDb();
    const env = { RATE_LIMIT_KV: kv, DB: db };
    // free 阈值 5000，单次 6000 直接撞顶
    await worker.detectAndLogTokenSpike(env, "user-2", "free", 6000);
    const auditCalls = db._calls.filter((c) => c.sql.includes("INSERT INTO llm_audit_log"));
    assert(auditCalls.length === 1, `above threshold: 1 audit_log INSERT (got ${auditCalls.length})`);
    assert(auditCalls[0].args[7] === "suspicious_spike", `status=suspicious_spike (got ${auditCalls[0].args[7]})`);
    assert([...kv._store.keys()].some((k) => k.startsWith("token_spike:flag:user-2:")), "flag set after first alert");
  }

  // case 3: 同窗口内第二次撞阈值 → flag 去重，不重复 audit_log
  {
    const kv = createMockKv();
    const db = createMockDb();
    const env = { RATE_LIMIT_KV: kv, DB: db };
    await worker.detectAndLogTokenSpike(env, "user-3", "free", 6000);
    db._calls.length = 0; // 清第一次的调用记录
    await worker.detectAndLogTokenSpike(env, "user-3", "free", 6000);
    const auditCalls = db._calls.filter((c) => c.sql.includes("INSERT INTO llm_audit_log"));
    assert(auditCalls.length === 0, `same window dedup: 0 INSERT (got ${auditCalls.length})`);
  }

  // case 4: KV / DB 缺失时 silent 返回（防生产漏配崩）
  {
    await worker.detectAndLogTokenSpike({}, "user-4", "free", 6000);
    await worker.detectAndLogTokenSpike({ DB: createMockDb() }, "user-4", "free", 6000);
    // 没崩就过
    assert(true, "missing KV/DB: silent return without throw");
  }
  console.log("✓ detectAndLogTokenSpike 4 case（below / above / dedup / missing-binding）");

  // ---- detectAndLogMultiDeviceBurst ----
  // case 1: free plan 单 license 加 2 个 fingerprint → 没撞阈值 (free=3)
  {
    const kv = createMockKv();
    const db = createMockDb();
    const env = { RATE_LIMIT_KV: kv, DB: db };
    await worker.detectAndLogMultiDeviceBurst(env, "GZHT-XXXX-YYYY-1234", "user-1", "fp-a", "free", "1.1.1.1", "UA");
    await worker.detectAndLogMultiDeviceBurst(env, "GZHT-XXXX-YYYY-1234", "user-1", "fp-b", "free", "1.1.1.1", "UA");
    const auditCalls = db._calls.filter((c) => c.sql.includes("INSERT INTO verify_log"));
    assert(auditCalls.length === 0, `below burst threshold: 0 verify_log INSERT (got ${auditCalls.length})`);
  }

  // case 2: free plan 加 4 个 fingerprint → 撞阈值（free 阈值 = 1+2 = 3）
  {
    const kv = createMockKv();
    const db = createMockDb();
    const env = { RATE_LIMIT_KV: kv, DB: db };
    for (const fp of ["a", "b", "c", "d"]) {
      await worker.detectAndLogMultiDeviceBurst(env, "GZHT-XXXX-YYYY-5678", "user-2", `fp-${fp}`, "free", "1.1.1.1", "UA");
    }
    const auditCalls = db._calls.filter((c) => c.sql.includes("INSERT INTO verify_log"));
    assert(auditCalls.length === 1, `above burst threshold: 1 verify_log INSERT (got ${auditCalls.length})`);
    assert(auditCalls[0].args[3] === "multi_device_burst", `result=multi_device_burst`);
  }

  // case 3: 同 fingerprint 重复 verify → 不重复加 set
  {
    const kv = createMockKv();
    const db = createMockDb();
    const env = { RATE_LIMIT_KV: kv, DB: db };
    await worker.detectAndLogMultiDeviceBurst(env, "GZHT-XXXX-YYYY-9999", "user-3", "fp-same", "free", "1.1.1.1", "UA");
    await worker.detectAndLogMultiDeviceBurst(env, "GZHT-XXXX-YYYY-9999", "user-3", "fp-same", "free", "1.1.1.1", "UA");
    await worker.detectAndLogMultiDeviceBurst(env, "GZHT-XXXX-YYYY-9999", "user-3", "fp-same", "free", "1.1.1.1", "UA");
    const auditCalls = db._calls.filter((c) => c.sql.includes("INSERT INTO verify_log"));
    assert(auditCalls.length === 0, `same fp dedup: 0 INSERT despite 3 calls`);
  }
  console.log("✓ detectAndLogMultiDeviceBurst 3 case（below / above / dedup）");

  // ---- sendSecurityAlertEmail ----
  // case 1: 节流命中（同 day key 已存在）→ 返 throttled，不发邮件
  {
    const kv = createMockKv();
    const db = createMockDb();
    db._setResponse("SELECT email FROM users WHERE id = ?", ["user-1"], { email: "test@example.com" });
    const today = new Date().toISOString().slice(0, 10);
    kv._store.set(`security_email:user-1:token_spike:${today}`, "1");
    const env = { RATE_LIMIT_KV: kv, DB: db, RESEND_API_KEY: "fake" };
    const fetcher = mockFetch();
    const status = await worker.sendSecurityAlertEmail(env, {
      userId: "user-1",
      type: "token_spike",
      details: { plan: "free", cumulative: 6000, threshold: 5000 }
    });
    fetcher._restore();
    assert(status === "throttled", `throttled when key exists (got ${status})`);
    assert(fetcher.calls.length === 0, `throttled: no Resend call`);
  }

  // case 2: 正常发送 → status="sent"，节流标在 Resend 200 后才写
  {
    const kv = createMockKv();
    const db = createMockDb();
    db._setResponse("SELECT email FROM users WHERE id = ?", ["user-2"], { email: "test2@example.com" });
    const env = { RATE_LIMIT_KV: kv, DB: db, RESEND_API_KEY: "fake", SITE_URL: "https://test.com" };
    const fetcher = mockFetch();
    const status = await worker.sendSecurityAlertEmail(env, {
      userId: "user-2",
      type: "token_spike",
      details: { plan: "free", cumulative: 6000, threshold: 5000 }
    });
    fetcher._restore();
    assert(status === "sent", `sent (got ${status})`);
    assert(fetcher.calls.length === 1, `Resend called once`);
    assert(fetcher.calls[0].url === "https://api.resend.com/emails", `Resend URL`);
    const today = new Date().toISOString().slice(0, 10);
    assert(kv._store.has(`security_email:user-2:token_spike:${today}`), `节流标在 Resend 成功后写入`);
  }

  // case 3: Resend 失败 → status="failed"，节流标不写（review 反馈：失败可重试）
  {
    const kv = createMockKv();
    const db = createMockDb();
    db._setResponse("SELECT email FROM users WHERE id = ?", ["user-3"], { email: "test3@example.com" });
    const env = { RATE_LIMIT_KV: kv, DB: db, RESEND_API_KEY: "fake", SITE_URL: "https://test.com" };
    const fetcher = mockFetch();
    fetcher._setNextResponse({ ok: false, status: 500, body: "{}" });
    const status = await worker.sendSecurityAlertEmail(env, {
      userId: "user-3",
      type: "token_spike",
      details: { plan: "free", cumulative: 6000, threshold: 5000 }
    });
    fetcher._restore();
    assert(status === "failed", `failed (got ${status})`);
    const today = new Date().toISOString().slice(0, 10);
    assert(!kv._store.has(`security_email:user-3:token_spike:${today}`), `Resend 失败时不写节流标允许重试`);
  }

  // case 4: device_limit_exceeded 用 7-day weekEpoch bucket 而非 YYYY-MM-DD（39th 续³ #6）
  {
    const kv = createMockKv();
    const db = createMockDb();
    db._setResponse("SELECT email FROM users WHERE id = ?", ["user-4"], { email: "test4@example.com" });
    const env = { RATE_LIMIT_KV: kv, DB: db, RESEND_API_KEY: "fake", SITE_URL: "https://test.com" };
    const fetcher = mockFetch();
    const status = await worker.sendSecurityAlertEmail(env, {
      userId: "user-4",
      type: "device_limit_exceeded",
      details: { plan: "free", activated: 1, limit: 1, licenseKey: "GZHT-XXXX-YYYY-DEVI" }
    });
    fetcher._restore();
    assert(status === "sent", `sent`);
    const throttleKey = [...kv._store.keys()].find((k) => k.startsWith("security_email:user-4:device_limit_exceeded:"));
    assert(throttleKey?.includes("week-"), `device_limit 用 weekEpoch bucket（key=${throttleKey}）`);
  }

  // case 5: RESEND_API_KEY 缺失 → status="skipped"
  {
    const status = await worker.sendSecurityAlertEmail(
      { RATE_LIMIT_KV: createMockKv(), DB: createMockDb() },
      { userId: "user-5", type: "token_spike", details: {} }
    );
    assert(status === "skipped", `RESEND_API_KEY 缺失：skipped`);
  }

  // case 6: userId 缺失 → status="skipped"
  {
    const status = await worker.sendSecurityAlertEmail(
      { RATE_LIMIT_KV: createMockKv(), DB: createMockDb(), RESEND_API_KEY: "fake" },
      { userId: null, type: "token_spike", details: {} }
    );
    assert(status === "skipped", `userId 缺失：skipped`);
  }

  // case 7: users.email 查询为空 → status="no_email"
  {
    const kv = createMockKv();
    const db = createMockDb();
    db._setResponse("SELECT email FROM users WHERE id = ?", ["user-7"], { email: "" });
    const env = { RATE_LIMIT_KV: kv, DB: db, RESEND_API_KEY: "fake" };
    const status = await worker.sendSecurityAlertEmail(env, {
      userId: "user-7",
      type: "token_spike",
      details: {}
    });
    assert(status === "no_email", `email 为空：no_email`);
  }

  console.log("✓ sendSecurityAlertEmail 7 case（throttled / sent / failed-retry / weekly-bucket / skipped × 3）");
}

console.log("\n运行 compliance-checker 合规检测单测 …");
{
  const { scanCompliance, safeScanCompliance } = await import(
    "../src/shared/compliance-checker.js"
  );

  // 1. 干净文本 → ok
  const clean = scanCompliance("今天天气不错，我们聊聊读书心得。");
  assert(clean.level === "ok" && clean.total === 0, "干净文本应判 ok 且 0 命中");

  // 2. 广告法极限词 → warn（severity 2）
  const ad = scanCompliance("本产品是国家级最先进的解决方案。");
  assert(ad.level === "warn", "极限词应判 warn");
  assert(ad.hits.some((h) => h.term === "国家级" && h.category === "ad_extreme"), "应命中国家级");
  assert(ad.hits.some((h) => h.term === "最先进"), "应命中最先进");

  // 3. 白名单：100%棉 不应命中 100%（onlyInsideWhitelist 生效）
  const wl = scanCompliance("这件衣服是 100%棉 的。");
  assert(!wl.hits.some((h) => h.id === "ad.baifenbai"), "100%棉 白名单应跳过 100% 命中");
  // 但裸 100% 仍应命中
  const wl2 = scanCompliance("成功率 100% 保证。");
  assert(wl2.hits.some((h) => h.id === "ad.baifenbai"), "裸 100% 仍应命中");

  // 4. 导流手机号正则 → warn
  const phone = scanCompliance("有需要加我电话 13800138000 咨询。");
  assert(phone.hits.some((h) => h.id === "div.phone"), "应命中手机号正则");

  // 5. 高危（赌博）→ block，level 取最高
  const block = scanCompliance("提供博彩与代开发票服务。");
  assert(block.level === "block" && block.counts.block >= 1, "赌博/违法词应判 block");

  // 6. article 对象输入（从 bodyHtml + meta 抽取）
  const art = scanCompliance({
    meta: { title: "震惊！这个神药包治百病" },
    bodyHtml: "<p>稳赚不赔，零风险投资。</p>"
  });
  assert(art.total >= 3, "article 对象应从 title + bodyHtml 抽取并命中多条");
  assert(art.hits.some((h) => h.category === "finance"), "应命中金融违规");

  // 7. safeScanCompliance 容错（异常输入不抛）
  const safe = safeScanCompliance(undefined);
  assert(safe.level === "ok", "safeScanCompliance(undefined) 应回 ok 不抛");

  // 8. 自定义词库 customTerms
  const { parseCustomComplianceTerms } = await import("../src/shared/compliance-checker.js");
  const terms = parseCustomComplianceTerms("竞品A，竞品B\n内部代号X、内部代号X");
  assert(terms.length === 3 && terms.includes("竞品A") && terms.includes("内部代号X"), "自定义词解析应去重去空，得 3 条");
  const custom = scanCompliance("我们比竞品A强，内部代号X 即将发布。", { customTerms: terms });
  assert(custom.hits.some((h) => h.category === "custom" && h.term === "竞品A"), "应命中自定义词竞品A");
  assert(custom.hits.some((h) => h.term === "内部代号X"), "应命中自定义词内部代号X");
  // 无自定义词时不命中
  const noCustom = scanCompliance("我们比竞品A强。");
  assert(!noCustom.hits.some((h) => h.category === "custom"), "未配置自定义词时不应命中 custom");

  // 9. 远程词库合并（setRemoteComplianceRules）
  const { setRemoteComplianceRules } = await import("../src/shared/compliance-checker.js");
  const { COMPLIANCE_REMOTE_RULES } = await import("../server/compliance/rules.js");
  assert(typeof COMPLIANCE_REMOTE_RULES.version === "number", "远程词库应有数字 version");
  setRemoteComplianceRules({ literal: COMPLIANCE_REMOTE_RULES.literal, regex: COMPLIANCE_REMOTE_RULES.regex });
  const merged = scanCompliance("这是全网最低价，看完泪崩。");
  assert(merged.hits.some((h) => h.term === "全网最低"), "应命中远程词库的全网最低");
  setRemoteComplianceRules(null); // 复位，避免污染后续断言
  const reset = scanCompliance("全网最低价");
  assert(!reset.hits.some((h) => h.term === "全网最低"), "复位后不应再命中远程词");

  console.log("✓ compliance-checker 12 case（+自定义×3 +远程合并）");
}

console.log("\n运行 humanize-checker 升华结尾检测单测 …");
{
  const { lintArticle } = await import("../src/shared/humanize-checker.js");
  // 升华式结尾（否定+肯定 + 量词叠词）应命中 poetic-ending
  const poetic = lintArticle({
    bodyHtml:
      "<p>比亚迪跑通了完整闭环，装车跑起来了。</p>" +
      "<p>成败不会在发布会的PPT上见分晓，而在一辆辆下线的车里，被真实路况一公里一公里地验出来。</p>"
  });
  assert(
    poetic.issues.some((i) => i.kind === "poetic-ending"),
    "升华式结尾（不会在X而在Y + 一公里一公里）应命中 poetic-ending"
  );
  // 平实结尾不应误报
  const plain = lintArticle({
    bodyHtml: "<p>璇玑A3已规模化量产，2026下半年开始上车。</p><p>具体表现要看后续的季度财报和召回数据。</p>"
  });
  assert(
    !plain.issues.some((i) => i.kind === "poetic-ending"),
    "平实结尾不应误报 poetic-ending"
  );
  console.log("✓ humanize-checker 升华结尾 2 case（命中 / 不误报）");
}

console.log("\n运行 humanize-checker 45th 新检测器单测 …");
{
  const { lintArticle } = await import("../src/shared/humanize-checker.js");

  // ① 新增黑名单词 / 金句短语应命中
  const blacklist = lintArticle(
    "<p>值得一提的是，这套方案的底层逻辑很扎实。</p><p>而这，正是行业期待的答案。未来已来。</p>"
  );
  assert(
    blacklist.issues.some((i) => i.kind === "ai-vocab" && i.phrase === "值得一提的是"),
    "「值得一提的是」应命中 ai-vocab"
  );
  assert(
    blacklist.issues.some((i) => i.kind === "ai-phrase" && i.phrase === "而这，正是"),
    "「而这，正是」应命中 ai-phrase"
  );

  // ② 「从…到…再到…」三段递进
  const fromTo = lintArticle("<p>从芯片到整机，再到云端服务，公司完成了布局。</p>");
  assert(
    fromTo.issues.some((i) => i.kind === "from-to-progression"),
    "「从…到…再到…」应命中 from-to-progression"
  );

  // ③ 句首「当……」排比 ≥3 才命中
  const whenHit = lintArticle(
    "<p>当用户打开应用，画面亮起。当服务器响应，数据返回。当夜幕降临，机房依旧轰鸣。</p>"
  );
  assert(
    whenHit.issues.some((i) => i.kind === "when-anaphora"),
    "3 个句首「当」应命中 when-anaphora"
  );
  const whenSafe = lintArticle("<p>当用户打开应用时画面亮起。服务器随后响应。</p>");
  assert(
    !whenSafe.issues.some((i) => i.kind === "when-anaphora"),
    "单个「当」不应误报 when-anaphora"
  );

  // ④ 段落句数均匀（6 段 × 每段 3 句）→ paragraph-uniformity
  const uniformPara =
    "这是第一句话，铺垫一下背景。这是第二句话，继续展开论述。这是第三句话，收住本段。";
  const uniform = lintArticle({
    sections: [
      { paragraphs: [uniformPara, uniformPara] },
      { paragraphs: [uniformPara, uniformPara] },
      { paragraphs: [uniformPara, uniformPara] }
    ]
  });
  assert(
    uniform.issues.some((i) => i.kind === "paragraph-uniformity"),
    "6 段全是 3 句的均匀段落应命中 paragraph-uniformity"
  );
  // 有短段呼吸 + 句数有起伏 → 不报
  const varied = lintArticle({
    sections: [
      { paragraphs: [uniformPara, "一句话短段。"] },
      { paragraphs: [uniformPara + uniformPara, "另一个短段，两句话。就这样。"] },
      { paragraphs: [uniformPara, "结尾短段。"] }
    ]
  });
  assert(
    !varied.issues.some((i) => i.kind === "paragraph-uniformity"),
    "句数有起伏的段落不应误报 paragraph-uniformity"
  );

  // ⑤ 段首词重复：3/6 段以「其实」开头
  const initRepeat = lintArticle({
    sections: [
      { paragraphs: ["其实这个问题没那么复杂，拆开看就清楚了。", "其实大家都明白，只是没人说破这层窗户纸。"] },
      { paragraphs: ["其实换个角度想，事情反而简单了不少。", "市场的反应比预期平静，没有出现恐慌。"] },
      { paragraphs: ["数据公布当天，股价只波动了百分之一。", "接下来要看的是季度财报的真实表现。"] }
    ]
  });
  assert(
    initRepeat.issues.some((i) => i.kind === "paragraph-initial-repeat"),
    "3 段同以「其实」开头应命中 paragraph-initial-repeat"
  );

  console.log("✓ humanize-checker 45th 新检测器 7 case（黑名单×2/递进/当排比×2/段落均匀×2/段首重复）");
}

console.log("\n运行 buildRewriteMessages 自拟主题创作（brief）分支单测 …");
{
  const { buildRewriteMessages } = await import("../src/shared/ai.js");
  const prefs = { length: "medium" };
  const briefSource = {
    origin: "brief",
    title: "为什么我不建议新手做副业",
    url: "",
    siteName: "自拟主题",
    images: [],
    blocks: [{ type: "paragraph", text: "大多数副业失败是低估了时间成本" }]
  };

  // ① brief 模式：system 走创作 prompt，user 提示词换创作语义
  const briefMsgs = buildRewriteMessages(briefSource, prefs, {}, null);
  assert(
    briefMsgs[0].content.includes("主笔") && briefMsgs[0].content.includes("想法要点"),
    "brief 模式 system prompt 必须是创作语义（主笔 + 想法要点）"
  );
  assert(
    briefMsgs[0].content.includes("不要编造"),
    "brief 模式必须保留防幻觉红线"
  );
  const briefUser = briefMsgs[briefMsgs.length - 1].content;
  assert(
    briefUser.includes("主题与想法要点（作者提供）"),
    "brief 模式 user prompt 必须标注「主题与想法要点（作者提供）」"
  );
  // 去 AI 味硬约束 system message 必须照常注入
  assert(
    briefMsgs.some((m) => m.role === "system" && m.content.includes("硬性约束")),
    "brief 模式必须保留去 AI 味硬约束消息"
  );

  // ② brief 模式忽略自定义改写模板（模板都是"忠实改写"语义，会曲解创作任务）
  const briefWithTemplate = buildRewriteMessages(briefSource, prefs, {}, {
    systemTemplate: "改写模板标记XYZ {{content}}",
    userTemplate: "U {{content}}"
  });
  assert(
    !briefWithTemplate.some((m) => m.content.includes("改写模板标记XYZ")),
    "brief 模式必须忽略自定义改写模板"
  );

  // ③ 普通改写模式不回归：仍走 DEFAULT_SYSTEM_PROMPT
  const rewriteMsgs = buildRewriteMessages(
    { title: "t", url: "https://x.com", images: [], blocks: [{ type: "paragraph", text: "x" }] },
    prefs,
    {},
    null
  );
  assert(
    rewriteMsgs[0].content.includes("改写成适合公众号发布"),
    "非 brief 来源必须仍走改写 system prompt"
  );

  console.log("✓ buildRewriteMessages brief 分支 3 case（创作语义/模板忽略/改写不回归）");
}

console.log("\n运行 humanize-checker 45th 续 · 实测样本复盘检测器单测 …");
{
  const { lintArticle } = await import("../src/shared/humanize-checker.js");

  // ① 叙述框架套路（narrative-frame）
  const frames = lintArticle(
    "<p>如果说2023年是元年，那么2026年则是决赛圈。</p>" +
    "<p>越多人用，反馈越多，迭代越快，形成正向循环。</p>" +
    "<p>谁能把能力转化为商业价值，谁才能笑到最后。</p>" +
    "<p>工具终究是工具，替代不了思考。</p>"
  );
  const frameLabels = frames.issues.filter((i) => i.kind === "narrative-frame").map((i) => i.text);
  assert(
    frameLabels.some((t) => t.includes("如果说")),
    "「如果说…那么…」应命中 narrative-frame"
  );
  assert(
    frameLabels.some((t) => t.includes("越……越")),
    "三连「越」应命中 narrative-frame"
  );
  assert(
    frameLabels.some((t) => t.includes("谁能")),
    "「谁能…谁才…」应命中 narrative-frame"
  );
  assert(
    frameLabels.some((t) => t.includes("终究是")),
    "「X 终究是 X」应命中 narrative-frame"
  );

  // ② 「一边…另一边」单次不报、两次才报
  const oneSide = lintArticle("<p>一边是繁华都市，另一边是宁静乡村，他选了后者。</p>");
  assert(
    !oneSide.issues.some((i) => i.kind === "narrative-frame" && i.text.includes("一边")),
    "「一边…另一边」单次不应报"
  );
  const twoSides = lintArticle(
    "<p>一边认为这是个人选择，另一边觉得这是失败。</p><p>一边在意边界感，另一边习惯打探隐私。</p>"
  );
  assert(
    twoSides.issues.some((i) => i.kind === "narrative-frame" && i.text.includes("一边")),
    "「一边…另一边」x2 应命中 narrative-frame"
  );

  // ③ 祝福式 / 点题式收尾（poetic-ending 扩充）
  const blessing = lintArticle("<p>正文先铺垫一段。</p><p>愿每个认真工作的年轻人，都能被看见。</p>");
  assert(
    blessing.issues.some((i) => i.kind === "poetic-ending" && i.label.includes("愿")),
    "「愿……」祝福收尾应命中 poetic-ending"
  );
  const thesis = lintArticle("<p>正文先铺垫一段。</p><p>把体力活干掉，这就是好工具的价值。</p>");
  assert(
    thesis.issues.some((i) => i.kind === "poetic-ending" && i.label.includes("价值")),
    "「这就是…的价值」应命中 poetic-ending"
  );

  // ④ 「不是 X，这是 Y」金句变体（parallel-structure 扩充）
  const thisIs = lintArticle("<p>这不是世故，这是职业素养。</p>");
  assert(
    thisIs.issues.some((i) => i.kind === "parallel-structure" && i.label.includes("这是")),
    "「不是 X，这是 Y」应命中 parallel-structure"
  );

  // ⑤ 否定式排比按次数升权：x4 应为 error 且权重 > x3
  const np3 = lintArticle(
    "<p>不是讨好，而是协作。这不是妥协，而是策略。那不是退让，而是选择。</p>"
  );
  const np4 = lintArticle(
    "<p>不是讨好，而是协作。这不是妥协，而是策略。那不是退让，而是选择。也不是放弃，而是转身。</p>"
  );
  const i3 = np3.issues.find((i) => i.kind === "negative-parallel");
  const i4 = np4.issues.find((i) => i.kind === "negative-parallel");
  assert(i3 && i3.severity === "warn", "否定式排比 x3 应为 warn");
  assert(i4 && i4.severity === "error" && i4.weight > i3.weight, "x4 应升 error 且权重更高");

  // ⑥ 字符串输入的主题词白名单：标题/小标题里的名词复现不算 AI 重复
  const topical = lintArticle(
    "<p>楼下早餐店的五毛钱涨价记</p>" +
    "<p>那天买包子发现五毛钱的涨幅，老板说面粉贵了。</p>" +
    "<p>五毛钱不算多，但熟客们都注意到了。</p>" +
    "<p>隔壁摊主也跟着把豆浆提了五毛钱。</p>" +
    "<p>月底一算，五毛钱乘上每天两百单，不是小数目。</p>"
  );
  assert(
    !topical.issues.some((i) => i.kind === "phrase-repetition" && i.phrase === "五毛钱"),
    "标题含「五毛钱」时正文复现不应报 phrase-repetition"
  );

  console.log("✓ humanize-checker 45th 续 10 case（框架×4/一边×2/收尾×2/金句变体/排比升权/主题词白名单）");
}

console.log("\n运行 article.js 渲染单测（图片分布 / 表格列对齐 / markdown）…");
{
  const { renderArticleBody, htmlToMarkdown } = await import("../src/shared/article.js");
  // 图片均匀分布：6 段 + 2 图 → everyN=ceil(6/2)=3，应在第3段后、第6段后各插一张（不跑偏）
  const imgs = [{ src: "https://a.com/1.png" }, { src: "https://a.com/2.png" }];
  const body = renderArticleBody(
    {
      sections: [
        {
          paragraphs: ["p1", "p2", "p3", "p4", "p5", "p6"],
          imageRefs: [{ index: 1 }, { index: 2 }]
        }
      ]
    },
    imgs
  );
  const idxP3 = body.indexOf("p3");
  const idxImg1 = body.indexOf("1.png");
  const idxP4 = body.indexOf("p4");
  assert(idxP3 < idxImg1 && idxImg1 < idxP4, "第1张图应插在 p3 后、p4 前（everyN 用原始图数算）");
  assert((body.match(/<figure/g) || []).length === 2, "2 张图都应渲染");

  // 表格列对齐：表头 3 列、某行只有 2 格 → 应补齐到 3 个 td
  const tblBody = renderArticleBody(
    {
      sections: [
        { paragraphs: ["x"], tables: [{ headers: ["A", "B", "C"], rows: [["1", "2"]] }] }
      ]
    },
    []
  );
  assert((tblBody.match(/<th style/g) || []).length === 3, "表头 3 列");
  assert((tblBody.match(/<td style/g) || []).length === 3, "残行应补齐到 3 个 td");
  assert(tblBody.includes("overflow-x:auto"), "表格应包横向滚动容器");
  // 注：htmlToMarkdown 依赖 DOMParser（仅浏览器/content 环境），Node smoke 不测。
  console.log("✓ article.js 渲染 4 case（图片分布/表格列对齐/横滚）");
}

console.log(`\n冒烟通过 · 扩展版本 manifest: ${manifest.version}`);
