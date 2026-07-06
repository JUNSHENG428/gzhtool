/**
 * card-renderer.js —— 金句文字卡片渲染模块
 * 运行环境：content script / UI 页面（需要 Canvas，可在主线程或 OffscreenCanvas）
 *
 * 为什么用「SVG 排版 → Canvas 转 PNG」而不是文生图？
 *   - 成本为零、出图毫秒级、视觉 100% 可控、风格统一
 *   - 公众号需要的是确定的图片文件（上传素材库），不是不可控的 AI 插画
 *
 * 流程：金句文本 → 套用卡片模板(SVG) → 自动换行排版 → drawImage 到 Canvas → toBlob(png)
 * 产出 PNG Blob，可直接：① 预览 ② 下载 ③ 走微信「上传图片」接口塞进素材库
 */

/** 卡片主题预设——和你的 THEME_PRESETS 体系对齐，可扩展 */
export const CARD_THEMES = {
  "editorial-green": {
    bg: "#0f2e25", accent: "#7fd1ae", text: "#f3faf6", sub: "#9fc7b6",
    fontFamily: "PingFang SC, Microsoft YaHei, sans-serif",
  },
  cream: {
    bg: "#fdf6e3", accent: "#d6a86a", text: "#2c2720", sub: "#8a7d68",
    fontFamily: "Songti SC, SimSun, serif",
  },
  ink: {
    bg: "#1a1a1a", accent: "#e8b84b", text: "#f5f5f5", sub: "#999",
    fontFamily: "PingFang SC, Microsoft YaHei, sans-serif",
  },
};

const CARD_W = 1080; // 公众号常用正方/竖图宽度
const CARD_H = 1080;

/**
 * 渲染单张金句卡片
 * @param {string} quote 金句文本
 * @param {object} opts { themeName, accountName, index }
 * @returns {Promise<Blob>} PNG 图片 Blob
 */
export async function renderQuoteCard(quote, opts = {}) {
  const theme = CARD_THEMES[opts.themeName] || CARD_THEMES["editorial-green"];
  const svg = buildCardSvg(quote, theme, opts);
  return svgToPngBlob(svg, CARD_W, CARD_H);
}

/** 批量渲染 */
export async function renderQuoteCards(quotes, opts = {}) {
  const out = [];
  for (let i = 0; i < quotes.length; i += 1) {
    const blob = await renderQuoteCard(quotes[i], { ...opts, index: i + 1 });
    out.push({ index: i + 1, quote: quotes[i], blob });
  }
  return out;
}

/** 构造卡片 SVG（含自动换行） */
function buildCardSvg(quote, theme, opts) {
  const padding = 110;
  const maxTextWidth = CARD_W - padding * 2;
  // 根据字数动态定字号：短句更大，长句更小
  const fontSize = quote.length <= 14 ? 76 : quote.length <= 24 ? 60 : 48;
  const lineHeight = fontSize * 1.5;
  const lines = wrapText(quote, maxTextWidth, fontSize);

  // 垂直居中
  const blockH = lines.length * lineHeight;
  let y = (CARD_H - blockH) / 2 + fontSize;

  const tspans = lines
    .map((line) => {
      const t = `<tspan x="${CARD_W / 2}" y="${y}">${escapeXml(line)}</tspan>`;
      y += lineHeight;
      return t;
    })
    .join("");

  const accountName = escapeXml(opts.accountName || "");
  const indexLabel = opts.index ? `0${opts.index}`.slice(-2) : "";

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${CARD_W}" height="${CARD_H}" viewBox="0 0 ${CARD_W} ${CARD_H}">
    <rect width="${CARD_W}" height="${CARD_H}" fill="${theme.bg}"/>
    <!-- 装饰：左上角序号 + 引号 -->
    <text x="${padding}" y="${padding + 30}" font-family="${theme.fontFamily}" font-size="40" font-weight="700" fill="${theme.accent}">${indexLabel}</text>
    <text x="${padding - 10}" y="${padding + 140}" font-family="Georgia, serif" font-size="160" fill="${theme.accent}" opacity="0.25">&#8220;</text>
    <!-- 金句主体 -->
    <text font-family="${theme.fontFamily}" font-size="${fontSize}" font-weight="600" fill="${theme.text}" text-anchor="middle" letter-spacing="1">
      ${tspans}
    </text>
    <!-- 底部装饰线 + 账号名 -->
    <rect x="${padding}" y="${CARD_H - 150}" width="80" height="6" rx="3" fill="${theme.accent}"/>
    <text x="${padding}" y="${CARD_H - 100}" font-family="${theme.fontFamily}" font-size="30" fill="${theme.sub}">${accountName}</text>
  </svg>`;
}

/** 中文友好的按宽度换行（中文按字宽估算，无需测量 API） */
function wrapText(text, maxWidth, fontSize) {
  const charPerLine = Math.floor(maxWidth / (fontSize * 1.05)); // 中文字宽≈字号
  const lines = [];
  let current = "";
  for (const ch of text) {
    current += ch;
    // 中文按字数断行；遇到标点尽量不放行首
    if (current.length >= charPerLine && !/[，。、！？；："）】]/.test(text[current.length] || "")) {
      lines.push(current);
      current = "";
    }
  }
  if (current) lines.push(current);
  return lines.slice(0, 6); // 最多 6 行，防溢出
}

/** SVG 字符串 → PNG Blob（通过 Canvas） */
function svgToPngBlob(svg, w, h) {
  return new Promise((resolve, reject) => {
    const svgBlob = new Blob([svg], { type: "image/svg+xml;charset=utf-8" });
    const url = URL.createObjectURL(svgBlob);
    const img = new Image();
    img.onload = () => {
      const canvas =
        typeof OffscreenCanvas !== "undefined"
          ? new OffscreenCanvas(w, h)
          : Object.assign(document.createElement("canvas"), { width: w, height: h });
      const ctx = canvas.getContext("2d");
      ctx.drawImage(img, 0, 0, w, h);
      URL.revokeObjectURL(url);

      if (canvas.convertToBlob) {
        canvas.convertToBlob({ type: "image/png" }).then(resolve).catch(reject);
      } else {
        canvas.toBlob((b) => (b ? resolve(b) : reject(new Error("toBlob 失败"))), "image/png");
      }
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error("SVG 转图失败（字体或 SVG 结构问题）"));
    };
    img.src = url;
  });
}

function escapeXml(s) {
  return String(s || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
