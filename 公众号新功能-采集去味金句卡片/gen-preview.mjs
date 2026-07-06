// 用真实 buildQuoteCardSvg 生成卡片预览页（what-you-see-is-what-ships）
import { buildQuoteCardSvg, CARD_THEMES, CARD_SIZES } from "../src/shared/quote-cards.js";
import { writeFileSync } from "node:fs";

const samples = [
  "真正的效率不是做更多，而是敢于不做。",
  "AI 写得再快，也替代不了你真实的判断力。",
  "工具是手段，人味才是公众号的护城河。"
];
const account = "@马俊生的 AI 实验室";

const themeIds = Object.keys(CARD_THEMES);
const sizeIds = Object.keys(CARD_SIZES);

let cols = "";
for (const sizeId of sizeIds) {
  let cards = "";
  themeIds.forEach((themeName, i) => {
    const svg = buildQuoteCardSvg(samples[i % samples.length], {
      themeName,
      sizeId,
      index: i + 1,
      total: themeIds.length,
      accountName: account
    });
    cards += `<figure class="card">
      <div class="frame ${sizeId}">${svg}</div>
      <figcaption>${CARD_THEMES[themeName].label} · ${CARD_SIZES[sizeId].label}</figcaption>
    </figure>`;
  });
  cols += `<section class="col"><h2>${CARD_SIZES[sizeId].label}</h2><div class="row">${cards}</div></section>`;
}

const html = `<!doctype html><html lang="zh"><head><meta charset="utf-8">
<title>金句卡片 · 设计预览</title>
<style>
  body{margin:0;background:#1b1b1f;color:#e8e8ea;font-family:'PingFang SC',system-ui,sans-serif;padding:40px;}
  h1{font-weight:700;font-size:24px;margin:0 0 4px;}
  .lede{color:#9a9aa2;margin:0 0 32px;font-size:14px;}
  .col{margin-bottom:40px;}
  h2{font-size:15px;color:#b9b9c0;font-weight:600;margin:0 0 16px;letter-spacing:1px;}
  .row{display:flex;gap:28px;flex-wrap:wrap;}
  .card{margin:0;}
  .frame{border-radius:18px;overflow:hidden;box-shadow:0 18px 50px rgba(0,0,0,.45);background:#000;}
  .frame.square{width:300px;height:300px;}
  .frame.portrait{width:300px;height:400px;}
  .frame svg{width:100%;height:100%;display:block;}
  figcaption{margin-top:12px;font-size:13px;color:#9a9aa2;text-align:center;}
</style></head>
<body>
  <h1>金句卡片 · 3 套主题 × 2 尺寸</h1>
  <p class="lede">墨韵书香（宣纸朱红 · 衬线）/ 新叶专栏（深绿薄荷 · 衬线）/ 清新知识卡（白底翠绿 · 黑体）。这就是上线后实际渲染的样式。</p>
  ${cols}
</body></html>`;

writeFileSync(new URL("./card-preview-v2.html", import.meta.url), html, "utf8");
console.log("wrote card-preview-v2.html");
