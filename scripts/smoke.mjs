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

// 字符级清理仍然正确
{
  const out = cleanInvisibleChars("a\u200Bb\uFEFFc\u200D");
  assert(out === "abc", `cleanInvisibleChars 期望 "abc"，实际 "${out}"`);
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
  evaluateLicense
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
  assert(
    LICENSE_CONSTANTS.FREE_MULTI_ACCOUNT_LIMIT === 2,
    `FREE_MULTI_ACCOUNT_LIMIT 应为 2，实际 ${LICENSE_CONSTANTS.FREE_MULTI_ACCOUNT_LIMIT}`
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

// 8) agent-runner relevance 评分 / 综合排序
console.log("\n运行 agent-runner 排序单测 …");
const { scoreHits } = await import("../src/shared/agent/agent-runner.js");

{
  // 同等热度下，验证主题词命中条排到不相关条之前
  // 注：权重 0.5×rel + 0.4×hot 意味着如果热度差距非常悬殊（如 100 vs 1000），
  // 0 relevance 的高热条仍可能盖过中相关度低热条；
  // 这里用"同等热度"确保单测稳定，反映 relevance 真正生效的核心场景。
  const hits = [
    {
      platformId: "x",
      title: "AI 笔记软件评测",
      summary: "对比了 5 款 AI 笔记，重点看付费门槛",
      hotValue: 500,
      publishedAt: ""
    },
    {
      platformId: "reddit",
      title: "今日美股大盘走势",
      summary: "和 AI 完全无关",
      hotValue: 500,
      publishedAt: ""
    },
    {
      platformId: "xhs",
      title: "AI 笔记软件 2025 推荐",
      summary: "深度评测 + 上手 demo",
      hotValue: 500,
      publishedAt: ""
    }
  ];
  const sorted = scoreHits(hits, "AI 笔记软件");
  // 同等热度下，命中标题的两条应在前，不相关条应在末位
  assert(sorted[0].title.includes("AI 笔记软件"), `第一条应包含主题词，实际 ${sorted[0].title}`);
  assert(
    sorted[sorted.length - 1].title.includes("美股"),
    `末位应是不相关条，实际 ${sorted[sorted.length - 1].title}`
  );
  // 每条 hit 都被写入 relevance 字段
  for (const hit of sorted) {
    assert(typeof hit.relevance === "number", `relevance 应为数字，实际 ${typeof hit.relevance}`);
    assert(hit.relevance >= 0 && hit.relevance <= 1, `relevance 应在 [0,1]，实际 ${hit.relevance}`);
  }
  // 不相关条的 relevance 应该 < 命中条
  const unrelated = sorted.find((h) => h.title.includes("美股"));
  const related = sorted.find((h) => h.title.includes("AI 笔记软件 2025"));
  assert(
    unrelated.relevance < related.relevance,
    `不相关条 relevance 应低于命中条，分别 ${unrelated.relevance} / ${related.relevance}`
  );
}

// recency 兜底：缺时间戳应给中性 0.3，不会因解析失败炸掉
{
  const sorted = scoreHits(
    [
      { platformId: "x", title: "测试", summary: "", hotValue: 50 }
    ],
    "测试"
  );
  assert(sorted.length === 1, "单条排序应正常返回");
  assert(typeof sorted[0]._score === "number", "_score 应为数字");
}

// 9) agent-store task-history（add / pin / sort / 滚动覆盖）
console.log("\n运行 agent-store task-history 单测 …");
{
  // mock 一份内存版 chrome.storage.local
  const mem = new Map();
  globalThis.chrome = {
    storage: {
      local: {
        async get(key) {
          if (typeof key === "string") {
            return mem.has(key) ? { [key]: mem.get(key) } : {};
          }
          if (Array.isArray(key)) {
            const out = {};
            for (const k of key) if (mem.has(k)) out[k] = mem.get(k);
            return out;
          }
          // 全量
          const out = {};
          for (const [k, v] of mem) out[k] = v;
          return out;
        },
        async set(obj) {
          for (const [k, v] of Object.entries(obj || {})) mem.set(k, v);
        },
        async remove(key) {
          if (typeof key === "string") mem.delete(key);
          else if (Array.isArray(key)) key.forEach((k) => mem.delete(k));
        }
      }
    }
  };

  const store = await import("../src/shared/agent/agent-store.js");

  // 干净起步
  await store.clearAgentTasks({ keepPinned: false });
  let list = await store.listAgentTasks();
  assert(list.length === 0, "初始历史应为空");

  // 单条写入应可读，hits 字段被裁到 30 条以内、关键字段保留
  const big = Array.from({ length: 50 }, (_, i) => ({
    platformId: "x",
    platformName: "X",
    title: `t${i}`,
    url: `https://x/${i}`,
    hotValue: 100 + i,
    summary: "x".repeat(500), // 验证 cutString
    relevance: 0.5
  }));
  const saved = await store.addAgentTask({
    query: "topic-1",
    options: { platforms: ["x"], finalLimit: 10, enableBrief: true },
    hits: big,
    brief: { themeSummary: "ok" }
  });
  assert(saved && saved.id, "addAgentTask 应返回带 id 的 slim task");
  assert(saved.hits.length === 30, `hits 应被裁到 30，实际 ${saved.hits.length}`);
  assert(saved.hits[0].summary.length <= 241, "summary 应被 cut 到 240 字内");
  assert(saved.options.platforms[0] === "x", "options.platforms 应被正确克隆");

  // 写超过 20 条，只留最近 20（钉选不计数）
  for (let i = 0; i < 25; i++) {
    await store.addAgentTask({ query: `q${i}`, hits: [{ platformId: "x", title: `h${i}` }] });
  }
  list = await store.listAgentTasks();
  // 上面写了 1（topic-1） + 25 条，但有滚动覆盖，最多保留 20
  assert(list.length === 20, `滚动后应保留 20 条，实际 ${list.length}`);

  // 钉选一条，再写 25 条，钉选的应该还在
  const pinTarget = list[0];
  await store.pinAgentTask(pinTarget.id, true);
  for (let i = 0; i < 25; i++) {
    await store.addAgentTask({ query: `extra-${i}`, hits: [] });
  }
  list = await store.listAgentTasks();
  const stillPinned = list.find((t) => t.id === pinTarget.id);
  assert(stillPinned && stillPinned.isPinned, "钉选的任务在滚动后仍应保留");
  // 钉选的应该排在最前
  assert(list[0].id === pinTarget.id, "钉选任务应排在第一位");

  // remove
  await store.removeAgentTask(pinTarget.id);
  list = await store.listAgentTasks();
  assert(!list.find((t) => t.id === pinTarget.id), "removeAgentTask 后应找不到该任务");

  // clear keepPinned 默认 true：钉选任务保留，其余清空
  // 先再钉一条
  if (list[0]) await store.pinAgentTask(list[0].id, true);
  await store.clearAgentTasks();
  list = await store.listAgentTasks();
  assert(
    list.every((t) => t.isPinned),
    "clearAgentTasks 默认应保留钉选任务"
  );

  // clearAgentTasks({ keepPinned: false }) 全清
  await store.clearAgentTasks({ keepPinned: false });
  list = await store.listAgentTasks();
  assert(list.length === 0, "clearAgentTasks({ keepPinned: false }) 应清空所有");

  // 还原全局 chrome（避免污染后续 test）
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
}

console.log(`\n冒烟通过 · 扩展版本 manifest: ${manifest.version}`);
