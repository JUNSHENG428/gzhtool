/**
 * quote-cards.js —— 金句 / 封面卡片渲染模块
 *
 * 把一句「金句」或「吸睛标题」排版成可直接用于公众号 / 小红书的贴图（PNG）。
 *
 * 为什么是「SVG 排版 → Canvas 转 PNG」而不是文生图：
 *   - 零成本、毫秒级出图、视觉 100% 可控、同一账号风格统一
 *   - 平台需要的是确定的图片文件（上传素材库 / 直接发布），不是不可控的 AI 插画
 *
 * 设计分层：
 *   - buildQuoteCardSvg() / buildCoverCardSvg(): 纯函数，只吐 SVG 字符串
 *   - render*Blob() / render*Cards(): 浏览器侧光栅化
 *
 * textStyle 覆盖（实时编辑）：
 *   { color, fontSize, highlight, highlightColor, underline, align, vAlign }
 */

/** 两种平台尺寸：公众号方图 + 小红书 3:4 竖图 */
export const CARD_SIZES = Object.freeze({
  square: { id: "square", w: 1080, h: 1080, label: "公众号 1080×1080" },
  portrait: { id: "portrait", w: 1080, h: 1440, label: "小红书 1080×1440" }
});

/**
 * 卡片主题——底色 + 墨色 + accent + 字体。
 * 金句 / 封面共用；新增主题时同步 workspace.html 下拉选项。
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
  },
  night: {
    label: "午夜蓝调",
    bg: "#0c1222",
    ink: "#e8eef8",
    sub: "#8b9bb8",
    accent: "#5b8def",
    font: "'PingFang SC','Microsoft YaHei',sans-serif",
    serif: false
  },
  sunset: {
    label: "落日珊瑚",
    bg: "#2a1512",
    ink: "#fff1e8",
    sub: "#d4a090",
    accent: "#ff7a59",
    font: "'Source Han Serif SC','Noto Serif SC','Songti SC',serif",
    serif: true
  },
  paper: {
    label: "素纸铅字",
    bg: "#faf8f4",
    panel: "#ffffff",
    ink: "#1a1a1a",
    sub: "#8a8680",
    accent: "#2c2c2c",
    font: "'Source Han Serif SC','Noto Serif SC','Songti SC',serif",
    serif: true
  },
  lavender: {
    label: "雾紫信笺",
    bg: "#f3eef8",
    panel: "#ffffff",
    ink: "#2d2440",
    sub: "#8b7fa3",
    accent: "#7c5cbf",
    font: "'PingFang SC','Microsoft YaHei',sans-serif",
    serif: false
  },
  amber: {
    label: "琥珀暖光",
    bg: "#1f1608",
    ink: "#fff6e0",
    sub: "#c9a86c",
    accent: "#e8a838",
    font: "'Source Han Serif SC','Noto Serif SC','Songti SC',serif",
    serif: true
  },
  ocean: {
    label: "深海青瓷",
    bg: "#e8f4f6",
    panel: "#ffffff",
    ink: "#0d2f38",
    sub: "#5a8a94",
    accent: "#1a8a9a",
    font: "'PingFang SC','Microsoft YaHei',sans-serif",
    serif: false
  }
});

/** 艺术字体预设（系统字体栈，SVG 光栅化时依赖本机已装字体） */
export const CARD_FONTS = Object.freeze({
  theme: {
    id: "theme",
    label: "跟随主题",
    font: "",
    serif: null,
    sample: "主题"
  },
  song: {
    id: "song",
    label: "宋体书香",
    font: "'Source Han Serif SC','Noto Serif SC','Songti SC','STSong',serif",
    serif: true,
    sample: "书香"
  },
  kai: {
    id: "kai",
    label: "楷体手札",
    font: "'Kaiti SC','STKaiti','KaiTi','楷体',serif",
    serif: true,
    sample: "手札"
  },
  hei: {
    id: "hei",
    label: "黑体海报",
    font: "'PingFang SC','Hiragino Sans GB','Microsoft YaHei','Heiti SC',sans-serif",
    serif: false,
    sample: "海报"
  },
  yuan: {
    id: "yuan",
    label: "圆体亲和",
    font: "'PingFang SC','Hiragino Sans GB','Yuanti SC','Microsoft YaHei',sans-serif",
    serif: false,
    sample: "亲和"
  },
  fangsong: {
    id: "fangsong",
    label: "仿宋报刊",
    font: "'STFangsong','FangSong','仿宋',serif",
    serif: true,
    sample: "报刊"
  },
  mono: {
    id: "mono",
    label: "等宽科技",
    font: "'SF Mono','Menlo','Consolas','Courier New',monospace",
    serif: false,
    sample: "科技"
  },
  display: {
    id: "display",
    label: "展示大字",
    font: "'Arial Black','Helvetica Neue','PingFang SC','Microsoft YaHei',sans-serif",
    serif: false,
    sample: "大字"
  }
});

/** 文字样式默认值（实时编辑面板的初始态） */
export const DEFAULT_TEXT_STYLE = Object.freeze({
  color: "",
  bg: "",
  accent: "",
  fontFamily: "theme",
  fontSize: 0,
  letterSpacing: 0,
  bold: false,
  highlight: false,
  highlightColor: "#ffe566",
  underline: false,
  align: "auto",
  vAlign: "middle"
});

const ZH_PUNCT_NO_LINE_START = "，。、！？；：）】」』.!?,;:";

function isHexColor(s) {
  return typeof s === "string" && /^#[0-9a-fA-F]{3,8}$/.test(s.trim());
}

function resolveFont(theme, style) {
  const preset = CARD_FONTS[style.fontFamily] || CARD_FONTS.theme;
  if (!preset.font) {
    return { font: theme.font, serif: theme.serif };
  }
  return { font: preset.font, serif: preset.serif };
}

function charWidthEm(ch) {
  const code = ch.codePointAt(0);
  if (ch === " ") return 0.3;
  if (code >= 0x21 && code <= 0x7e) return 0.56;
  return 1;
}

/** 按可用宽度做中文友好换行，标点不放行首，限制最大行数 */
export function wrapText(text, fontSize, maxWidth, maxLines) {
  const maxEm = maxWidth / fontSize;
  const lines = [];
  let cur = "";
  let curEm = 0;
  const chars = Array.from(String(text || ""));
  for (let i = 0; i < chars.length; i += 1) {
    const ch = chars[i];
    const w = charWidthEm(ch);
    if (curEm + w > maxEm && cur) {
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

function pickFontSize(len, size) {
  let fs;
  if (len <= 12) fs = 86;
  else if (len <= 20) fs = 72;
  else if (len <= 32) fs = 60;
  else if (len <= 48) fs = 50;
  else fs = 42;
  return Math.round(fs);
}

function pickCoverFontSize(len, size) {
  const scale = size.id === "portrait" ? 1.08 : 1;
  let fs;
  if (len <= 10) fs = 96;
  else if (len <= 16) fs = 82;
  else if (len <= 22) fs = 68;
  else if (len <= 30) fs = 56;
  else fs = 48;
  return Math.round(fs * scale);
}

/** 归一化 textStyle，非法值回退默认 */
export function normalizeTextStyle(raw = {}) {
  const src = raw && typeof raw === "object" ? raw : {};
  const align = ["left", "center", "right", "auto"].includes(src.align) ? src.align : "auto";
  const vAlign = ["top", "middle", "bottom"].includes(src.vAlign) ? src.vAlign : "middle";
  const fontSize = Math.max(0, Math.min(140, Math.round(Number(src.fontSize) || 0)));
  const letterSpacing = Math.max(0, Math.min(20, Math.round(Number(src.letterSpacing) || 0)));
  const fontFamily = CARD_FONTS[src.fontFamily] ? src.fontFamily : "theme";
  const color = isHexColor(src.color) ? src.color.trim() : "";
  const bg = isHexColor(src.bg) ? src.bg.trim() : "";
  const accent = isHexColor(src.accent) ? src.accent.trim() : "";
  const highlightColor = isHexColor(src.highlightColor)
    ? src.highlightColor.trim()
    : DEFAULT_TEXT_STYLE.highlightColor;
  return {
    color,
    bg,
    accent,
    fontFamily,
    fontSize,
    letterSpacing,
    bold: Boolean(src.bold),
    highlight: Boolean(src.highlight),
    highlightColor,
    underline: Boolean(src.underline),
    align,
    vAlign
  };
}

function estimateLineWidth(line, fontSize) {
  let em = 0;
  for (const ch of Array.from(line)) em += charWidthEm(ch);
  return em * fontSize;
}

/**
 * 根据对齐方式算每行 x，以及 text-anchor。
 * @returns {{ x: number, anchor: string }}
 */
function resolveAlign(align, pad, W, defaultAlign) {
  const a = align === "auto" ? defaultAlign : align;
  if (a === "center") return { x: Math.round(W / 2), anchor: "middle", name: "center" };
  if (a === "right") return { x: W - pad, anchor: "end", name: "right" };
  return { x: pad, anchor: "start", name: "left" };
}

/** 垂直位置：返回首行基线 y */
function resolveStartY(vAlign, H, pad, blockH, fontSize) {
  if (vAlign === "top") return pad + Math.round(H * 0.18) + fontSize;
  if (vAlign === "bottom") return H - pad - 90 - (blockH - fontSize);
  // middle
  return Math.round(H / 2) - Math.round(blockH / 2) + fontSize * 0.85;
}

/**
 * 生成主体文字层：高亮底条 + tspan + 下划线。
 * linesYs: [{ line, y, width }]
 */
function buildTextLayer({
  lines,
  startY,
  lineHeight,
  fontSize,
  font,
  fontWeight,
  fill,
  alignX,
  anchor,
  letterSpacing,
  highlight,
  highlightColor,
  underline
}) {
  let y = startY;
  const tspans = [];
  const highlights = [];
  const underlines = [];

  for (const line of lines) {
    const w = estimateLineWidth(line, fontSize);
    let rectX = alignX;
    if (anchor === "middle") rectX = alignX - w / 2;
    else if (anchor === "end") rectX = alignX - w;

    if (highlight) {
      const padX = Math.round(fontSize * 0.12);
      const padY = Math.round(fontSize * 0.18);
      highlights.push(
        `<rect x="${Math.round(rectX - padX)}" y="${Math.round(y - fontSize + padY)}" width="${Math.round(w + padX * 2)}" height="${Math.round(fontSize * 1.15)}" rx="6" fill="${highlightColor}" opacity="0.55"/>`
      );
    }
    if (underline) {
      underlines.push(
        `<rect x="${Math.round(rectX)}" y="${Math.round(y + fontSize * 0.18)}" width="${Math.round(w)}" height="4" rx="2" fill="${fill}" opacity="0.85"/>`
      );
    }
    tspans.push(`<tspan x="${alignX}" y="${y}" text-anchor="${anchor}">${escapeXml(line)}</tspan>`);
    y += lineHeight;
  }

  return `${highlights.join("\n  ")}
  <text font-family="${font}" font-size="${fontSize}" font-weight="${fontWeight}" fill="${fill}" letter-spacing="${letterSpacing}">
    ${tspans.join("")}
  </text>
  ${underlines.join("\n  ")}`;
}

/**
 * 构造单张金句卡片的 SVG 字符串（纯函数）。
 * @param {string} quote 金句文本
 * @param {object} opts { themeName, sizeId, index, total, accountName, textStyle }
 */
export function buildQuoteCardSvg(quote, opts = {}) {
  const theme = CARD_THEMES[opts.themeName] || CARD_THEMES.ink;
  const size = CARD_SIZES[opts.sizeId] || CARD_SIZES.square;
  const style = normalizeTextStyle(opts.textStyle);
  const W = size.w;
  const H = size.h;
  const pad = Math.round(W * 0.11);
  const maxTextWidth = W - pad * 2;

  const text = String(quote || "").trim();
  const autoFs = pickFontSize(text.length, size);
  const fontSize = style.fontSize > 0 ? style.fontSize : autoFs;
  const lineHeight = Math.round(fontSize * 1.6);
  const maxLines = size.id === "portrait" ? 8 : 6;
  const lines = wrapText(text, fontSize, maxTextWidth, maxLines);
  const blockH = lines.length * lineHeight;

  const { x: alignX, anchor } = resolveAlign(style.align, pad, W, "left");
  const startY = resolveStartY(style.vAlign, H, pad, blockH, fontSize);
  const fill = style.color || theme.ink;
  const bg = style.bg || theme.bg;
  const accent = style.accent || theme.accent;
  const { font, serif } = resolveFont(theme, style);
  const fontWeight = style.bold ? 800 : serif ? 700 : 600;
  const letterSpacing = style.letterSpacing > 0 ? style.letterSpacing : 1;

  const total = Number(opts.total) || 0;
  const idx = Number(opts.index) || 0;
  const indexLabel = idx ? String(idx).padStart(2, "0") : "";
  const counterLabel = idx && total ? `${String(idx).padStart(2, "0")} / ${String(total).padStart(2, "0")}` : indexLabel;
  const accountName = escapeXml(opts.accountName || "");

  const quoteGlyphY = pad + Math.round(W * 0.16);
  const quoteGlyphSize = Math.round(W * 0.2);

  const panel =
    theme.panel && !style.bg
      ? `<rect x="${Math.round(pad * 0.55)}" y="${Math.round(pad * 0.55)}" width="${W - pad * 1.1}" height="${H - pad * 1.1}" rx="36" fill="${theme.panel}"/>`
      : "";

  const footerY = H - pad + Math.round(fontSize * 0.1);
  const textLayer = buildTextLayer({
    lines,
    startY,
    lineHeight,
    fontSize,
    font,
    fontWeight,
    fill,
    alignX,
    anchor,
    letterSpacing,
    highlight: style.highlight,
    highlightColor: style.highlightColor,
    underline: style.underline
  });

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
  <rect width="${W}" height="${H}" fill="${bg}"/>
  ${panel}
  <rect x="${pad}" y="${pad - Math.round(fontSize * 0.2)}" width="14" height="${Math.round(Math.min(fontSize, 86) * 1.0)}" rx="7" fill="${accent}"/>
  <text x="${pad + 30}" y="${pad + Math.round(Math.min(fontSize, 86) * 0.55)}" font-family="${font}" font-size="40" font-weight="700" fill="${accent}" letter-spacing="2">${indexLabel}</text>
  <text x="${pad - 8}" y="${quoteGlyphY}" font-family="Georgia,'Source Han Serif SC',serif" font-size="${quoteGlyphSize}" fill="${accent}" opacity="0.18">&#8220;</text>
  ${textLayer}
  <rect x="${pad}" y="${footerY - 46}" width="64" height="5" rx="2.5" fill="${accent}"/>
  <text x="${pad}" y="${footerY}" font-family="${font}" font-size="30" fill="${theme.sub}" letter-spacing="1">${accountName}</text>
  <text x="${W - pad}" y="${footerY}" font-family="${font}" font-size="28" fill="${theme.sub}" text-anchor="end" letter-spacing="2">${counterLabel}</text>
</svg>`;
}

/**
 * 构造单张「封面标题」卡片的 SVG。
 * @param {string} title
 * @param {object} opts { themeName, sizeId, index, total, accountName, hook, textStyle }
 */
export function buildCoverCardSvg(title, opts = {}) {
  const theme = CARD_THEMES[opts.themeName] || CARD_THEMES.ink;
  const size = CARD_SIZES[opts.sizeId] || CARD_SIZES.square;
  const style = normalizeTextStyle(opts.textStyle);
  const W = size.w;
  const H = size.h;
  const pad = Math.round(W * 0.1);
  const maxTextWidth = W - pad * 2;

  const text = String(title || "").trim();
  const hook = escapeXml(String(opts.hook || "").trim().slice(0, 8));
  const autoFs = pickCoverFontSize(text.length, size);
  const fontSize = style.fontSize > 0 ? style.fontSize : autoFs;
  const lineHeight = Math.round(fontSize * 1.45);
  const maxLines = size.id === "portrait" ? 6 : 5;
  const lines = wrapText(text, fontSize, maxTextWidth, maxLines);
  const blockH = lines.length * lineHeight;

  const { x: alignX, anchor } = resolveAlign(style.align, pad, W, "center");
  const startY = resolveStartY(style.vAlign, H, pad, blockH, fontSize);
  const fill = style.color || theme.ink;
  const bg = style.bg || theme.bg;
  const accent = style.accent || theme.accent;
  const { font, serif } = resolveFont(theme, style);
  const fontWeight = style.bold ? 900 : serif ? 800 : 700;
  const letterSpacing = style.letterSpacing > 0 ? style.letterSpacing : 2;
  const centerX = Math.round(W / 2);

  const idx = Number(opts.index) || 0;
  const total = Number(opts.total) || 0;
  const variant = idx ? (idx - 1) % 3 : 0;
  const indexLabel = idx ? String(idx).padStart(2, "0") : "";
  const counterLabel = idx && total ? `${String(idx).padStart(2, "0")} / ${String(total).padStart(2, "0")}` : indexLabel;
  const accountName = escapeXml(opts.accountName || "");
  const footerY = H - pad;

  const panel =
    theme.panel && !style.bg
      ? `<rect x="${Math.round(pad * 0.5)}" y="${Math.round(pad * 0.5)}" width="${W - pad}" height="${H - pad}" rx="40" fill="${theme.panel}"/>`
      : "";

  // hook 只用于预览区 UI 标签，不画进 PNG
  const hookBadge = "";

  let variantDecor = "";
  if (variant === 0) {
    variantDecor = `<rect x="${pad}" y="${pad}" width="${W - pad * 2}" height="6" rx="3" fill="${accent}"/>`;
  } else if (variant === 1) {
    variantDecor = `<rect x="0" y="0" width="${Math.round(W * 0.06)}" height="${H}" fill="${accent}" opacity="0.85"/>`;
  } else {
    // 不再画大号序号水印
    variantDecor = `<rect x="${pad}" y="${H - pad - 80}" width="${W - pad * 2}" height="3" fill="${accent}" opacity="0.5"/>
  <rect x="${pad}" y="${H - pad - 68}" width="${Math.round((W - pad * 2) * 0.4)}" height="3" fill="${accent}"/>`;
  }

  const textLayer = buildTextLayer({
    lines,
    startY,
    lineHeight,
    fontSize,
    font,
    fontWeight,
    fill,
    alignX,
    anchor,
    letterSpacing,
    highlight: style.highlight,
    highlightColor: style.highlightColor,
    underline: style.underline
  });

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
  <rect width="${W}" height="${H}" fill="${bg}"/>
  ${panel}
  ${variantDecor}
  ${hookBadge}
  ${textLayer}
  <rect x="${centerX - 40}" y="${footerY - 52}" width="80" height="4" rx="2" fill="${accent}"/>
  <text x="${centerX}" y="${footerY - 12}" font-family="${font}" font-size="28" fill="${theme.sub}" text-anchor="middle" letter-spacing="1">${accountName}</text>
  <text x="${W - pad}" y="${footerY}" font-family="${font}" font-size="26" fill="${theme.sub}" text-anchor="end" letter-spacing="2">${counterLabel}</text>
</svg>`;
}

/** SVG 字符串 → PNG Blob */
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

function blobToDataUrl(blob) {
  return new Promise((resolve, reject) => {
    const fr = new FileReader();
    fr.onload = () => resolve(fr.result);
    fr.onerror = () => reject(new Error("Blob 转 dataURL 失败"));
    fr.readAsDataURL(blob);
  });
}

export async function renderQuoteCardBlob(quote, opts = {}) {
  const size = CARD_SIZES[opts.sizeId] || CARD_SIZES.square;
  const svg = buildQuoteCardSvg(quote, opts);
  return svgToPngBlob(svg, size.w, size.h);
}

export async function renderQuoteCardDataUrl(quote, opts = {}) {
  const blob = await renderQuoteCardBlob(quote, opts);
  return await blobToDataUrl(blob);
}

/**
 * 批量渲染金句卡片。
 * opts.textStyles?: Array|Object — 按 index-1 / key 取每张的 textStyle
 */
export async function renderQuoteCards(quotes, opts = {}) {
  const list = Array.isArray(quotes) ? quotes : [];
  const out = [];
  for (let i = 0; i < list.length; i += 1) {
    const textStyle = pickTextStyle(opts.textStyles, i);
    const blob = await renderQuoteCardBlob(list[i], {
      ...opts,
      textStyle,
      index: i + 1,
      total: list.length
    });
    out.push({
      index: i + 1,
      quote: list[i],
      textStyle,
      blob,
      dataUrl: await blobToDataUrl(blob)
    });
  }
  return out;
}

export async function renderCoverCardBlob(title, opts = {}) {
  const size = CARD_SIZES[opts.sizeId] || CARD_SIZES.square;
  const svg = buildCoverCardSvg(title, opts);
  return svgToPngBlob(svg, size.w, size.h);
}

export async function renderCoverCards(titles, opts = {}) {
  const list = Array.isArray(titles) ? titles : [];
  const out = [];
  for (let i = 0; i < list.length; i += 1) {
    const item = list[i];
    const title = typeof item === "string" ? item : String(item?.title || "");
    const hook = typeof item === "object" ? String(item?.hook || "") : "";
    const textStyle = pickTextStyle(opts.textStyles, i);
    const blob = await renderCoverCardBlob(title, {
      ...opts,
      hook,
      textStyle,
      index: i + 1,
      total: list.length
    });
    out.push({
      index: i + 1,
      title,
      hook,
      textStyle,
      blob,
      dataUrl: await blobToDataUrl(blob)
    });
  }
  return out;
}

function pickTextStyle(textStyles, i) {
  if (!textStyles) return normalizeTextStyle();
  if (Array.isArray(textStyles)) return normalizeTextStyle(textStyles[i]);
  if (typeof textStyles === "object") {
    return normalizeTextStyle(textStyles[i] || textStyles[String(i)] || textStyles[i + 1]);
  }
  return normalizeTextStyle();
}
