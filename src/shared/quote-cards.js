/**
 * quote-cards.js —— 金句卡片渲染模块
 *
 * 把一句「金句」排版成可直接用于公众号 / 小红书的贴图（PNG）。
 *
 * 为什么是「SVG 排版 → Canvas 转 PNG」而不是文生图：
 *   - 零成本、毫秒级出图、视觉 100% 可控、同一账号风格统一
 *   - 平台需要的是确定的图片文件（上传素材库 / 直接发布），不是不可控的 AI 插画
 *
 * 设计分层：
 *   - buildQuoteCardSvg(): 纯函数，只吐 SVG 字符串（无 DOM 依赖，可在 Node 里跑、可单测、可生成预览）
 *   - renderQuoteCardBlob() / renderQuoteCardDataUrl(): 浏览器侧，把 SVG 光栅化成 PNG
 *
 * 视觉取向（反 AI 模板感）：
 *   - 衬线大字做主角（中文编辑感），单一 accent 贯穿，留白克制，不堆渐变 / emoji
 *   - 用「」中文引号、编号序章、细分隔线、账号落款这些"有审校过"的细节
 */

/** 两种平台尺寸：公众号方图 + 小红书 3:4 竖图 */
export const CARD_SIZES = Object.freeze({
  square: { id: "square", w: 1080, h: 1080, label: "公众号 1080×1080" },
  portrait: { id: "portrait", w: 1080, h: 1440, label: "小红书 1080×1440" }
});

/**
 * 3 套卡片主题——配色与 THEME_PRESETS 的气质对齐（墨韵书香 / 新叶专栏 / 清新知识卡），
 * 但金句卡片是独立视觉语言，只取「底色 + 墨色 + accent + 字体」四个核心变量。
 */
export const CARD_THEMES = Object.freeze({
  ink: {
    label: "墨韵书香",
    bg: "#f4eee1",
    ink: "#23211c",
    sub: "#857c68",
    accent: "#b23a2e",
    font: "'Source Han Serif SC','Noto Serif SC','Songti SC',serif",
    serif: true
  },
  forest: {
    label: "新叶专栏",
    bg: "#0f2e25",
    ink: "#f3faf6",
    sub: "#9fc7b6",
    accent: "#8fd3b0",
    font: "'Source Han Serif SC','Noto Serif SC','Songti SC',serif",
    serif: true
  },
  mint: {
    label: "清新知识卡",
    bg: "#f1f7f3",
    panel: "#ffffff",
    ink: "#1d2b26",
    sub: "#6d8278",
    accent: "#1f9d63",
    font: "'PingFang SC','Microsoft YaHei',sans-serif",
    serif: false
  }
});

const ZH_PUNCT_NO_LINE_START = "，。、！？；：）】」』.!?,;:";

/**
 * 估算单字符的相对宽度（以 1em 为基准）。
 * CJK / 全角标点≈1em，ASCII 字母数字≈0.56em，空格≈0.3em。
 * 不依赖 canvas measureText，保证纯函数可在任意环境跑。
 */
function charWidthEm(ch) {
  const code = ch.codePointAt(0);
  if (ch === " ") return 0.3;
  // ASCII 可见字符
  if (code >= 0x21 && code <= 0x7e) return 0.56;
  // 其余按全角处理（中文、全角标点、emoji 等）
  return 1;
}

/** 按可用宽度做中文友好换行，标点不放行首，限制最大行数 */
function wrapText(text, fontSize, maxWidth, maxLines) {
  const maxEm = maxWidth / fontSize;
  const lines = [];
  let cur = "";
  let curEm = 0;
  const chars = Array.from(String(text || ""));
  for (let i = 0; i < chars.length; i += 1) {
    const ch = chars[i];
    const w = charWidthEm(ch);
    if (curEm + w > maxEm && cur) {
      // 如果下一个字符是不能放行首的标点，先把它带到当前行尾
      const next = chars[i];
      if (ZH_PUNCT_NO_LINE_START.includes(next)) {
        cur += next;
        lines.push(cur);
        cur = "";
        curEm = 0;
        continue;
      }
      lines.push(cur);
      cur = ch;
      curEm = w;
    } else {
      cur += ch;
      curEm += w;
    }
    if (lines.length >= maxLines) break;
  }
  if (cur && lines.length < maxLines) lines.push(cur);
  return lines.slice(0, maxLines);
}

function escapeXml(s) {
  return String(s || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** 根据金句长度自适应字号（短句更大、更有张力；长句缩小保证不溢出） */
function pickFontSize(len, size) {
  const base = size.id === "portrait" ? 1 : 1;
  let fs;
  if (len <= 12) fs = 86;
  else if (len <= 20) fs = 72;
  else if (len <= 32) fs = 60;
  else if (len <= 48) fs = 50;
  else fs = 42;
  return Math.round(fs * base);
}

/**
 * 构造单张金句卡片的 SVG 字符串（纯函数）。
 * @param {string} quote 金句文本
 * @param {object} opts { themeName, sizeId, index, total, accountName }
 * @returns {string} SVG 字符串
 */
export function buildQuoteCardSvg(quote, opts = {}) {
  const theme = CARD_THEMES[opts.themeName] || CARD_THEMES.ink;
  const size = CARD_SIZES[opts.sizeId] || CARD_SIZES.square;
  const W = size.w;
  const H = size.h;
  const pad = Math.round(W * 0.11); // ≈120
  const maxTextWidth = W - pad * 2;

  const text = String(quote || "").trim();
  const fontSize = pickFontSize(text.length, size);
  const lineHeight = Math.round(fontSize * 1.6);
  const maxLines = size.id === "portrait" ? 8 : 6;
  const lines = wrapText(text, fontSize, maxTextWidth, maxLines);

  const blockH = lines.length * lineHeight;
  const centerY = H / 2;
  let y = centerY - blockH / 2 + fontSize * 0.8;

  const tspans = lines
    .map((line) => {
      const t = `<tspan x="${pad}" y="${y}">${escapeXml(line)}</tspan>`;
      y += lineHeight;
      return t;
    })
    .join("");

  const total = Number(opts.total) || 0;
  const idx = Number(opts.index) || 0;
  const indexLabel = idx ? String(idx).padStart(2, "0") : "";
  const counterLabel = idx && total ? `${String(idx).padStart(2, "0")} / ${String(total).padStart(2, "0")}` : indexLabel;
  const accountName = escapeXml(opts.accountName || "");

  // 装饰性大引号字形位置（标题上方）
  const quoteGlyphY = pad + Math.round(W * 0.16);
  const quoteGlyphSize = Math.round(W * 0.2);

  // mint 主题用白色内卡片承托；其余主题纯色底
  const panel =
    theme.panel
      ? `<rect x="${Math.round(pad * 0.55)}" y="${Math.round(pad * 0.55)}" width="${W - pad * 1.1}" height="${H - pad * 1.1}" rx="36" fill="${theme.panel}"/>`
      : "";

  const footerY = H - pad + Math.round(fontSize * 0.1);

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
  <rect width="${W}" height="${H}" fill="${theme.bg}"/>
  ${panel}
  <!-- 序号印 -->
  <rect x="${pad}" y="${pad - Math.round(fontSize * 0.2)}" width="14" height="${Math.round(fontSize * 1.0)}" rx="7" fill="${theme.accent}"/>
  <text x="${pad + 30}" y="${pad + Math.round(fontSize * 0.55)}" font-family="${theme.font}" font-size="40" font-weight="700" fill="${theme.accent}" letter-spacing="2">${indexLabel}</text>
  <!-- 装饰大引号 -->
  <text x="${pad - 8}" y="${quoteGlyphY}" font-family="Georgia,'Source Han Serif SC',serif" font-size="${quoteGlyphSize}" fill="${theme.accent}" opacity="0.18">&#8220;</text>
  <!-- 金句主体 -->
  <text font-family="${theme.font}" font-size="${fontSize}" font-weight="${theme.serif ? 700 : 600}" fill="${theme.ink}" letter-spacing="1" style="text-anchor:start;">
    ${tspans}
  </text>
  <!-- 底部分隔线 + 落款 -->
  <rect x="${pad}" y="${footerY - 46}" width="64" height="5" rx="2.5" fill="${theme.accent}"/>
  <text x="${pad}" y="${footerY}" font-family="${theme.font}" font-size="30" fill="${theme.sub}" letter-spacing="1">${accountName}</text>
  <text x="${W - pad}" y="${footerY}" font-family="${theme.font}" font-size="28" fill="${theme.sub}" text-anchor="end" letter-spacing="2">${counterLabel}</text>
</svg>`;
}

/** SVG 字符串 → PNG Blob（浏览器侧；OffscreenCanvas 优先，降级普通 canvas） */
export function svgToPngBlob(svg, w, h) {
  return new Promise((resolve, reject) => {
    if (typeof Image === "undefined") {
      reject(new Error("当前环境不支持 Canvas 渲染（需要在页面侧调用）"));
      return;
    }
    const svgBlob = new Blob([svg], { type: "image/svg+xml;charset=utf-8" });
    const url = URL.createObjectURL(svgBlob);
    const img = new Image();
    img.onload = () => {
      try {
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
      } catch (err) {
        URL.revokeObjectURL(url);
        reject(err);
      }
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error("SVG 转图失败（可能是字体或 SVG 结构问题）"));
    };
    img.src = url;
  });
}

/** 渲染单张卡片 → PNG Blob */
export async function renderQuoteCardBlob(quote, opts = {}) {
  const size = CARD_SIZES[opts.sizeId] || CARD_SIZES.square;
  const svg = buildQuoteCardSvg(quote, opts);
  return svgToPngBlob(svg, size.w, size.h);
}

/** 渲染单张卡片 → data URL（用于预览 / 插入编辑器 img.src） */
export async function renderQuoteCardDataUrl(quote, opts = {}) {
  const blob = await renderQuoteCardBlob(quote, opts);
  return await blobToDataUrl(blob);
}

/** 批量渲染 → [{ index, quote, blob, dataUrl }] */
export async function renderQuoteCards(quotes, opts = {}) {
  const list = Array.isArray(quotes) ? quotes : [];
  const out = [];
  for (let i = 0; i < list.length; i += 1) {
    const blob = await renderQuoteCardBlob(list[i], { ...opts, index: i + 1, total: list.length });
    out.push({ index: i + 1, quote: list[i], blob, dataUrl: await blobToDataUrl(blob) });
  }
  return out;
}

function blobToDataUrl(blob) {
  return new Promise((resolve, reject) => {
    const fr = new FileReader();
    fr.onload = () => resolve(fr.result);
    fr.onerror = () => reject(new Error("Blob 转 dataURL 失败"));
    fr.readAsDataURL(blob);
  });
}
