#!/usr/bin/env node
/**
 * 单测：AI 返回的文章 JSON 偶尔会把字符串字段包成对象
 * （如 { text: "..." }）。归一化层必须抽出真实文本，不能让
 * JS 隐式 String(object) 后在正文里出现 [object Object]。
 */

import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "..");

const { normalizeArticle } = await import(resolve(ROOT, "src/shared/ai.js"));
const { renderArticleBody } = await import(resolve(ROOT, "src/shared/article.js"));

let pass = 0;
let fail = 0;

function check(name, condition) {
  if (condition) {
    console.log(`  ✓ ${name}`);
    pass += 1;
  } else {
    console.log(`  ✗ ${name}`);
    fail += 1;
  }
}

console.log("article normalization · object field guard");

const sourceImages = [
  {
    src: "https://example.com/chart.png",
    alt: { text: "来源图表" },
    caption: { content: "来源图注" }
  }
];

const article = normalizeArticle(
  {
    title: { text: "酒企利润承压" },
    subtitle: { content: "行业观察" },
    lead: { value: "年轻人不喝，不只是口味问题。" },
    sections: [
      {
        heading: { text: "库存压力先到利润表" },
        paragraphs: [
          { text: "高端酒还能撑住价格，中低端渠道已经开始松动。" },
          { content: "促销不是偶发动作，而是库存周转变慢后的自然反应。" },
          ["渠道不再愿意压货", { text: "现金流就会先紧起来。" }]
        ],
        bulletPoints: [{ value: "收入降速" }, { label: "利润承压" }],
        quote: { text: "账算不过来，热闹就会先停下来。" },
        imageRefs: [{ index: 1, caption: { content: "白酒行业库存变化" } }],
        codeBlocks: [{ language: { value: "text" }, text: { content: "sample" } }],
        tables: [
          {
            headers: [{ text: "指标" }, { content: "变化" }],
            rows: [[{ value: "净利润" }, { text: "下滑" }]]
          }
        ],
        mathBlocks: [{ latex: { text: "P=R-C" } }]
      }
    ],
    closing: { text: "真正要看的，是下一轮消费场景能不能回来。" },
    cta: { content: "关注润笔，继续拆行业文章。" },
    wechatTitleOptions: [{ text: "白酒生意，正在换算法" }],
    keywords: [{ value: "白酒" }, { label: "利润" }]
  },
  { title: { text: "来源标题" }, images: sourceImages },
  { cta: { text: "默认 CTA" } }
);

const html = renderArticleBody(article, sourceImages);
const serialized = JSON.stringify(article) + html;

check("标题对象被抽成字符串", article.title === "酒企利润承压");
check("段落对象数组被抽成字符串", article.sections[0].paragraphs[1].includes("促销不是偶发动作"));
check("嵌套数组段落被合并成文本", article.sections[0].paragraphs[2].includes("现金流就会先紧起来"));
check("quote 对象不会渲染成 [object Object]", html.includes("<blockquote>账算不过来，热闹就会先停下来。</blockquote>"));
check("表格对象单元格被抽成字符串", html.includes(">净利润</td>") && html.includes(">下滑</td>"));
check("整篇文章与 HTML 都不含 [object Object]", !serialized.includes("[object Object]"));

console.log(`\n  共 ${pass + fail} 项 · 通过 ${pass} · 失败 ${fail}\n`);
process.exit(fail > 0 ? 1 : 0);
