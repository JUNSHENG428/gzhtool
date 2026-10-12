import assert from "node:assert/strict";
import { test, before, after } from "node:test";
import { buildRewriteMessages, normalizeArticle, requestHumanizeJudge, requestDeepHumanizeRewrite } from "../src/shared/ai.js";
import { DEFAULT_PROMPT_TEMPLATES } from "../src/shared/defaults.js";
import { createArticleDraftState } from "../src/shared/article.js";
import { createReadableDigest } from "../src/shared/digest.js";
import { runHumanizePass } from "../src/shared/humanize-pass.js";

const originalFetch = globalThis.fetch;
before(() => { globalThis.fetch = async () => { throw new Error("Tests must not access the network"); }; });
after(() => { globalThis.fetch = originalFetch; });
const settings = { aiSourceMode: "custom", apiKey: "test-only", apiBaseUrl: "https://example.test/chat", model: "mock" };
const source = { title: "招聘统计", images: [], blocks: [{ type: "paragraph", text: "甲调查：2025届高中生，岗位数与求职人数之比为3.2。乙调查：2026届本科生，该比值为1.5。" }] };

for (const [name, template, origin] of [
  ["默认改写", null],
  ["行业观察", DEFAULT_PROMPT_TEMPLATES.find(t => t.id === "preset-deep-analysis")],
  ["已保存的旧模板", { systemTemplate: "旧模板：写成行业观察。", userTemplate: "{{content}}", humanizeProfile: { burstinessMin: 0.9 } }],
  ["自拟主题", null, "brief"]
]) {
  test(`${name}保留素材口径并使用清晰表达约束`, () => {
    const messages = buildRewriteMessages({ ...source, origin }, { length: "medium" }, settings, template);
    const system = messages.filter(m => m.role === "system").map(m => m.content).join("\n");
    assert.match(system, /事实与原意准确 > 读者一次读懂/);
    assert.match(system, /不同年份、人群或调查/);
    assert.match(system, /没有合适建议时 cta 返回空字符串/);
    assert.doesNotMatch(system, /标准差 \/ 均值 ≥|相邻三句不得|列举优先 2 项或 4 项|允许在文中出现 1–2 处/);
    assert.ok(messages.at(-1).content.includes(source.blocks[0].text));
    if (name === "已保存的旧模板") assert.match(messages[0].content, /旧模板/);
  });
}

test("模型明确留空CTA时不再把写作指令填入正文", () => {
  const article = normalizeArticle({ title: "招聘统计", sections: [], cta: "" }, source, { cta: "结尾给出一个行动建议" });
  assert.equal(article.cta, "");
  assert.equal(createArticleDraftState(article).meta.cta, "");
  assert.equal(normalizeArticle({ sections: [] }, source, { cta: "作者已写的结束语" }).cta, "作者已写的结束语");
});

test("长导语生成摘要时停在完整句子，正文不被截短", () => {
  const first = "这两项统计分别对应高中生和本科生。";
  const lead = first + "统计对象和调查年份不同，".repeat(20) + "不能直接比较。";
  const draft = createArticleDraftState({ lead, sections: [] });
  assert.equal(draft.meta.digest, first);
  assert.equal(draft.meta.lead, lead);
});

test("摘要不把小数点当句号，也保留句尾引号", () => {
  assert.equal(createReadableDigest("比值是3.2。" + "待核实".repeat(60)), "比值是3.2。");
  assert.equal(createReadableDigest("他说：“对象不同。”" + "后文".repeat(100)), "他说：“对象不同。”");
  assert.equal(createReadableDigest("The ratio is 3.2. " + "More context. ".repeat(20), 20), "The ratio is 3.2.");
});

test("没有句界的长摘录显式省略，且不拆开emoji", () => {
  const result = createReadableDigest("甲".repeat(118) + "🌱" + "乙".repeat(20));
  assert.equal(result, "甲".repeat(118) + "…");
  assert.ok(result.length <= 120);
  assert.equal(createReadableDigest("  简短摘要。  "), "简短摘要。");
  assert.equal(createReadableDigest(""), "");
});

async function withMock(t, response, run) {
  const requests = [];
  t.mock.method(globalThis, "fetch", async (url, init) => {
    assert.equal(url, settings.apiBaseUrl);
    requests.push(JSON.parse(init.body));
    return new Response(JSON.stringify({ choices: [{ message: { content: response } }] }), { status: 200 });
  });
  await run(requests);
}

test("二次润色不再提高随机性，保留图片、列表及原稿", async t => {
  const article = { title: "招聘", lead: "", sections: [{ heading: "统计口径", paragraphs: ["两项调查分别统计高中生和本科生。"], bulletPoints: ["甲调查", "乙调查"], imageRefs: [{ index: 1 }], quote: "原话" }], cta: "" };
  const original = structuredClone(article);
  await withMock(t, "甲调查统计高中生，乙调查统计本科生。", async requests => {
    const result = await runHumanizePass({ article, settings, intensity: "strong" });
    assert.equal(result.applied, true);
    assert.equal(requests.length, 1);
    assert.equal(requests[0].temperature, 0.4);
    const prompt = requests[0].messages[0].content;
    assert.match(prompt, /你只收到当前段落/);
    assert.match(prompt, /统计对象、时间、单位、分母和来源/);
    assert.doesNotMatch(prompt, /标准差\/均值 ≥|说实话…\/讲真…|AI 词替换字典/);
    assert.deepEqual(result.article.sections[0].imageRefs, original.sections[0].imageRefs);
    assert.deepEqual(result.article.sections[0].bulletPoints, original.sections[0].bulletPoints);
    assert.equal(result.article.sections[0].quote, "原话");
    assert.deepEqual(article, original);
  });
});

test("深度评审关注理解与证据，输出具体问题而非作者身份判断", async t => {
  await withMock(t, JSON.stringify({ score: 62, verdict: "比较口径缺失", findings: [{ excerpt: "前者更好", reason: "未说明比较的对象和年份" }] }), async requests => {
    const result = await requestHumanizeJudge(settings, "<p>前者更好。</p>");
    assert.equal(result.findings[0].reason, "未说明比较的对象和年份");
    assert.match(requests[0].messages[0].content, /跨人群跨年份直接比较/);
    assert.match(requests[0].messages[0].content, /不能宣称事实已经核实/);
    assert.doesNotMatch(requests[0].messages[0].content, /GPTZero|越高越像真人/);
  });
});

test("深度返工传入具体问题，不鼓励新增个人细节", async t => {
  await withMock(t, "<p>两项调查的对象不同。</p>", async requests => {
    const result = await requestDeepHumanizeRewrite(settings, "<p>前者更好。</p>", [{ excerpt: "前者", reason: "指代不明" }]);
    assert.equal(result, "<p>两项调查的对象不同。</p>");
    assert.match(requests[0].messages[0].content, /指代不明/);
    assert.match(requests[0].messages[0].content, /不能重新核实来源/);
    assert.doesNotMatch(requests[0].messages[0].content, /适度加入具体细节|真人的随机起伏/);
  });
});
