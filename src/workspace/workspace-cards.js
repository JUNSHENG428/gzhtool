/**
 * workspace-cards.js —— 「金句卡片」视图编排
 *
 * 流程：取当前编辑台正文 → AI 提炼金句（requestPunchlines）→ 渲染卡片（quote-cards）
 *       → 预览网格 → 下载 PNG / 插入正文当配图。
 *
 * Pro 闸门：ai.quoteCards（checkQuoteCardsAccess），与「去 AI 味增强」同模式。
 * AI 调用走 requestPunchlines → requestPlainChat，自动复用平台 LLM 配额 / 用户自配 Key。
 */

import { getSettings } from "../shared/storage.js";
import { checkQuoteCardsAccess, PAID_FEATURES } from "../shared/license.js";
import { showUpgradeModal } from "../shared/upgrade-modal.js";
import { requestPunchlines, requestComicChain, requestSocialPost, requestCoverTitles } from "../shared/ai.js";
import {
  renderQuoteCards,
  renderCoverCards,
  CARD_SIZES,
  CARD_THEMES,
  CARD_FONTS,
  DEFAULT_TEXT_STYLE,
  normalizeTextStyle
} from "../shared/quote-cards.js";
import {
  buildComicPrompt,
  buildComicOutline,
  generateComicTags,
  COMIC_TEMPLATE_META
} from "../shared/comic-prompt.js";

// 当前金句文本（提炼一次后缓存，切主题 / 尺寸只重渲不重新调 AI）
let _punchlines = [];
let _punchStyles = []; // 每张金句的 textStyle
let _rendered = []; // [{ index, quote, blob, dataUrl, textStyle }]
let _busy = false;

// 封面标题卡片
let _coverTitles = []; // [{ title, hook }]
let _coverStyles = [];
let _coverRendered = []; // [{ index, title, hook, blob, dataUrl, textStyle }]
let _coverBusy = false;

// 当前正在编辑的卡片：{ kind: "quote"|"cover", index: 1-based }
let _editing = null;
let _editRerenderTimer = null;

// 逻辑链漫画：拆解一次后缓存结构化数据，切画幅只重拼 prompt 不重调 AI
let _comicData = null;
let _comicTags = [];
let _comicBusy = false;

// 种草文案
let _socialBusy = false;

function $(id) {
  return document.getElementById(id);
}

function setStatus(text, tone = "info") {
  const el = $("cardsStatus");
  if (!el) return;
  el.textContent = text || "";
  el.dataset.tone = tone;
}

function setBusy(busy) {
  _busy = busy;
  const btn = $("generateCardsButton");
  if (btn) {
    btn.disabled = busy;
    btn.textContent = busy ? "处理中…" : "✨ AI 提炼金句并生成卡片";
  }
}

function getEditorBodyHtml() {
  const editor = document.querySelector("#editor");
  return editor ? editor.innerHTML || "" : "";
}

function currentOpts() {
  return {
    themeName: $("cardThemeSelect")?.value || "ink",
    sizeId: $("cardSizeSelect")?.value || "square",
    accountName: ($("cardAccountInput")?.value || "").trim()
  };
}

/** 主入口：提炼金句 + 渲染卡片 */
async function generateCards() {
  if (_busy) return;

  // 1. Pro 闸门
  const access = await checkQuoteCardsAccess();
  if (!access.ok) {
    const meta = PAID_FEATURES["ai.quoteCards"];
    showUpgradeModal({
      featureName: meta?.name || "金句卡片",
      hint: access.hint || meta?.hint || "金句卡片是会员功能。",
      bullets: [
        "AI 从你的正文里提炼最有传播力的 3-5 句金句",
        "排版成公众号方图 / 小红书竖图，3 套主题随心切",
        "下载 PNG 上传素材库，或一键插入正文当配图"
      ]
    });
    return;
  }

  // 2. 取正文
  const bodyHtml = getEditorBodyHtml();
  if (!bodyHtml.replace(/<[^>]+>/g, "").trim()) {
    setStatus("正文为空，请先到「编辑排版」改写或粘贴一篇文章。", "warning");
    return;
  }

  setBusy(true);
  setStatus("AI 正在提炼金句…", "info");
  try {
    const settings = await getSettings();
    _punchlines = await requestPunchlines(settings, bodyHtml, { max: 5 });
    if (!_punchlines.length) {
      setStatus("没能从这篇正文里提炼出合适的金句，换一篇更有观点的试试。", "warning");
      setBusy(false);
      return;
    }
    _punchStyles = _punchlines.map(() => normalizeTextStyle());
    closeCardEditor();
    setStatus(`提炼到 ${_punchlines.length} 句，正在生成卡片…`, "info");
    await renderAndShow();
    setStatus(`已生成 ${_rendered.length} 张卡片，点「编辑」可改文字样式。`, "success");
  } catch (err) {
    console.warn("[workspace-cards] generate failed", err);
    setStatus(`生成失败：${err?.message || err}`, "error");
  } finally {
    setBusy(false);
  }
}

/** 用当前缓存的金句 + 当前主题/尺寸/文字样式重渲卡片并刷新网格 */
async function renderAndShow() {
  const opts = currentOpts();
  _rendered = await renderQuoteCards(_punchlines, { ...opts, textStyles: _punchStyles });
  renderGrid();
  toggleResultButtons(true);
}

function toggleResultButtons(show) {
  const dl = $("downloadAllCardsButton");
  const ins = $("insertAllCardsButton");
  if (dl) dl.hidden = !show;
  if (ins) ins.hidden = !show;
  const empty = $("cardsEmpty");
  if (empty) empty.hidden = show;
}

function renderGrid() {
  const grid = $("cardsGrid");
  if (!grid) return;
  grid.innerHTML = "";
  const sizeId = $("cardSizeSelect")?.value || "square";
  const aspectClass = sizeId === "portrait" ? "is-portrait" : "is-square";

  _rendered.forEach((card) => {
    const li = document.createElement("li");
    li.className = "card-cell";
    if (_editing?.kind === "quote" && _editing.index === card.index) {
      li.classList.add("is-editing");
    }
    li.innerHTML = `
      <div class="card-thumb ${aspectClass}">
        <img alt="金句卡片 ${card.index}" />
      </div>
      <p class="card-quote"></p>
      <div class="card-cell-actions">
        <button type="button" class="ghost card-edit">编辑</button>
        <button type="button" class="ghost card-download">下载</button>
        <button type="button" class="ghost card-insert">插入正文</button>
      </div>
    `;
    li.querySelector("img").src = card.dataUrl;
    li.querySelector(".card-quote").textContent = card.quote;
    li.querySelector(".card-edit").addEventListener("click", () => openCardEditor("quote", card.index));
    li.querySelector(".card-download").addEventListener("click", () => downloadCard(card));
    li.querySelector(".card-insert").addEventListener("click", () => insertCard(card));
    grid.appendChild(li);
  });
}

function buildFilename(card) {
  const opts = currentOpts();
  const theme = CARD_THEMES[opts.themeName]?.label || opts.themeName;
  const size = opts.sizeId === "portrait" ? "竖图" : "方图";
  return `金句卡片-${theme}-${size}-${String(card.index).padStart(2, "0")}.png`;
}

function downloadCard(card) {
  try {
    const url = URL.createObjectURL(card.blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = buildFilename(card);
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 2000);
  } catch (err) {
    setStatus(`下载失败：${err?.message || err}`, "error");
  }
}

async function downloadAll() {
  for (const card of _rendered) {
    downloadCard(card);
    // 轻微错峰，避免浏览器把连续下载判为弹窗滥用
    await new Promise((r) => setTimeout(r, 250));
  }
}

/** 把卡片作为 <figure> 配图插入编辑台正文末尾（data URL，发布时由 publish 管线统一转存素材库） */
function insertCard(card) {
  const editor = document.querySelector("#editor");
  if (!editor) {
    setStatus("找不到编辑器，无法插入。请先切到「编辑排版」。", "warning");
    return;
  }
  const figure = document.createElement("figure");
  figure.setAttribute("data-quote-card", "1");
  const img = document.createElement("img");
  img.src = card.dataUrl;
  img.alt = `金句卡片：${card.quote}`;
  const cap = document.createElement("figcaption");
  cap.textContent = card.quote;
  figure.appendChild(img);
  figure.appendChild(cap);
  editor.appendChild(figure);
  // 触发 workspace 的输入监听 → 自动持久化 + 重渲预览
  editor.dispatchEvent(new Event("input", { bubbles: true }));
  setStatus(`已把第 ${card.index} 张卡片插入正文末尾。`, "success");
}

async function insertAll() {
  for (const card of _rendered) insertCard(card);
  setStatus(`已把 ${_rendered.length} 张卡片插入正文末尾。`, "success");
}

// ============ 封面标题卡片（正文 → 吸睛标题 → 封面贴图） ============

function setCoverStatus(text, tone = "info") {
  const el = $("coverStatus");
  if (!el) return;
  el.textContent = text || "";
  el.dataset.tone = tone;
}

function setCoverBusy(busy) {
  _coverBusy = busy;
  const btn = $("generateCoverCardsButton");
  if (btn) {
    btn.disabled = busy;
    btn.textContent = busy ? "处理中…" : "🎯 AI 生成吸睛标题并做封面卡片";
  }
}

function toggleCoverResultButtons(show) {
  const dl = $("downloadAllCoversButton");
  const ins = $("insertAllCoversButton");
  if (dl) dl.hidden = !show;
  if (ins) ins.hidden = !show;
  const empty = $("coversEmpty");
  if (empty) empty.hidden = show;
}

function renderCoversGrid() {
  const grid = $("coversGrid");
  if (!grid) return;
  grid.innerHTML = "";
  const sizeId = $("cardSizeSelect")?.value || "square";
  const aspectClass = sizeId === "portrait" ? "is-portrait" : "is-square";

  _coverRendered.forEach((card) => {
    const li = document.createElement("li");
    li.className = "card-cell";
    if (_editing?.kind === "cover" && _editing.index === card.index) {
      li.classList.add("is-editing");
    }
    const hookLabel = card.hook ? `<span class="cover-hook-badge"></span>` : "";
    li.innerHTML = `
      <div class="card-thumb ${aspectClass}">
        <img alt="封面卡片 ${card.index}" />
      </div>
      <p class="card-quote">${hookLabel}<span class="cover-title-text"></span></p>
      <div class="card-cell-actions">
        <button type="button" class="ghost cover-edit">编辑</button>
        <button type="button" class="ghost cover-download">下载</button>
        <button type="button" class="ghost cover-insert">插入正文</button>
        <button type="button" class="ghost cover-use-title">用此标题</button>
      </div>
    `;
    li.querySelector("img").src = card.dataUrl;
    if (card.hook) li.querySelector(".cover-hook-badge").textContent = card.hook;
    li.querySelector(".cover-title-text").textContent = card.title;
    li.querySelector(".cover-edit").addEventListener("click", () => openCardEditor("cover", card.index));
    li.querySelector(".cover-download").addEventListener("click", () => downloadCoverCard(card));
    li.querySelector(".cover-insert").addEventListener("click", () => insertCoverCard(card));
    li.querySelector(".cover-use-title").addEventListener("click", () => applyCoverTitle(card));
    grid.appendChild(li);
  });
}

async function renderCoversAndShow() {
  const opts = currentOpts();
  _coverRendered = await renderCoverCards(_coverTitles, { ...opts, textStyles: _coverStyles });
  renderCoversGrid();
  toggleCoverResultButtons(true);
}

/** 主入口：生成吸睛标题 + 渲染封面卡片 */
async function generateCoverCards() {
  if (_coverBusy) return;

  const access = await checkQuoteCardsAccess();
  if (!access.ok) {
    const meta = PAID_FEATURES["ai.quoteCards"];
    showUpgradeModal({
      featureName: meta?.name || "金句卡片",
      hint: access.hint || meta?.hint || "封面标题卡片是会员功能。",
      bullets: [
        "AI 从正文生成 5-6 个不同风格的吸睛标题",
        "每张标题排成封面贴图：居中大字 + 钩子标签 + 三种版式",
        "可下载、插入正文，或一键填入文章标题栏"
      ]
    });
    return;
  }

  const bodyHtml = getEditorBodyHtml();
  if (!bodyHtml.replace(/<[^>]+>/g, "").trim()) {
    setCoverStatus("正文为空，请先到「编辑排版」改写或粘贴一篇文章。", "warning");
    return;
  }

  setCoverBusy(true);
  setCoverStatus("AI 正在写吸睛标题…", "info");
  try {
    const settings = await getSettings();
    _coverTitles = await requestCoverTitles(settings, bodyHtml, { max: 6 });
    if (!_coverTitles.length) {
      setCoverStatus("没能从这篇正文里提炼出合适的封面标题，换一篇更有观点的试试。", "warning");
      setCoverBusy(false);
      return;
    }
    _coverStyles = _coverTitles.map(() => normalizeTextStyle());
    closeCardEditor();
    setCoverStatus(`生成 ${_coverTitles.length} 个标题，正在排版封面卡片…`, "info");
    await renderCoversAndShow();
    setCoverStatus(`已生成 ${_coverRendered.length} 张封面卡片，点「编辑」可改文字样式。`, "success");
  } catch (err) {
    console.warn("[workspace-cards] cover cards failed", err);
    setCoverStatus(`生成失败：${err?.message || err}`, "error");
  } finally {
    setCoverBusy(false);
  }
}

function buildCoverFilename(card) {
  const opts = currentOpts();
  const theme = CARD_THEMES[opts.themeName]?.label || opts.themeName;
  const size = opts.sizeId === "portrait" ? "竖图" : "方图";
  const safe = card.title.slice(0, 12).replace(/[/\\?%*:|"<>]/g, "");
  return `封面卡片-${theme}-${size}-${String(card.index).padStart(2, "0")}-${safe}.png`;
}

function downloadCoverCard(card) {
  try {
    const url = URL.createObjectURL(card.blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = buildCoverFilename(card);
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 2000);
  } catch (err) {
    setCoverStatus(`下载失败：${err?.message || err}`, "error");
  }
}

async function downloadAllCovers() {
  for (const card of _coverRendered) {
    downloadCoverCard(card);
    await new Promise((r) => setTimeout(r, 250));
  }
}

function insertCoverCard(card) {
  const editor = document.querySelector("#editor");
  if (!editor) {
    setCoverStatus("找不到编辑器，无法插入。请先切到「编辑排版」。", "warning");
    return;
  }
  const figure = document.createElement("figure");
  figure.setAttribute("data-cover-card", "1");
  const img = document.createElement("img");
  img.src = card.dataUrl;
  img.alt = `封面卡片：${card.title}`;
  const cap = document.createElement("figcaption");
  cap.textContent = card.title;
  figure.appendChild(img);
  figure.appendChild(cap);
  editor.appendChild(figure);
  editor.dispatchEvent(new Event("input", { bubbles: true }));
  setCoverStatus(`已把第 ${card.index} 张封面卡片插入正文末尾。`, "success");
}

async function insertAllCovers() {
  for (const card of _coverRendered) insertCoverCard(card);
  setCoverStatus(`已把 ${_coverRendered.length} 张封面卡片插入正文末尾。`, "success");
}

/** 把选中的封面标题填入编辑台标题输入框 */
function applyCoverTitle(card) {
  const input = $("titleInput");
  if (!input) {
    setCoverStatus("找不到标题输入框，请先到「编辑排版」。", "warning");
    return;
  }
  input.value = card.title;
  input.dispatchEvent(new Event("input", { bubbles: true }));
  input.dispatchEvent(new Event("change", { bubbles: true }));
  setCoverStatus(`已把「${card.title}」填入文章标题。`, "success");
}

// ============ 卡片文字实时编辑 ============

function currentTheme() {
  return CARD_THEMES[$("cardThemeSelect")?.value] || CARD_THEMES.ink;
}

function themeInkColor() {
  return currentTheme().ink;
}

function closeCardEditor() {
  _editing = null;
  const panel = $("cardTextEditor");
  if (panel) panel.hidden = true;
  document.querySelectorAll(".card-cell.is-editing").forEach((el) => el.classList.remove("is-editing"));
}

function ensureFontGrid() {
  const grid = $("cardEditFontFamily");
  if (!grid || grid.dataset.ready === "1") return;
  grid.innerHTML = "";
  Object.values(CARD_FONTS).forEach((preset) => {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "card-font-chip";
    btn.dataset.font = preset.id;
    btn.setAttribute("role", "option");
    btn.title = preset.label;
    const sample = document.createElement("span");
    sample.className = "card-font-sample";
    sample.textContent = preset.sample;
    if (preset.font) sample.style.fontFamily = preset.font;
    const name = document.createElement("span");
    name.className = "card-font-name";
    name.textContent = preset.label;
    btn.appendChild(sample);
    btn.appendChild(name);
    btn.addEventListener("click", () => {
      grid.querySelectorAll(".card-font-chip").forEach((el) => el.classList.remove("is-active"));
      btn.classList.add("is-active");
      onCardEditorChange();
    });
    grid.appendChild(btn);
  });
  grid.dataset.ready = "1";
}

function setActiveFont(fontId) {
  const grid = $("cardEditFontFamily");
  if (!grid) return;
  ensureFontGrid();
  grid.querySelectorAll(".card-font-chip").forEach((el) => {
    el.classList.toggle("is-active", el.dataset.font === fontId);
  });
}

function getActiveFontId() {
  return $("cardEditFontFamily")?.querySelector(".card-font-chip.is-active")?.dataset.font || "theme";
}

function openCardEditor(kind, index) {
  _editing = { kind, index };
  const panel = $("cardTextEditor");
  const label = $("cardTextEditorLabel");
  const applyTitleBtn = $("cardEditApplyTitle");
  if (!panel) return;

  ensureFontGrid();

  let text = "";
  let style = normalizeTextStyle();
  if (kind === "quote") {
    text = _punchlines[index - 1] || "";
    style = normalizeTextStyle(_punchStyles[index - 1]);
    if (label) label.textContent = `编辑金句卡片 ${String(index).padStart(2, "0")}`;
    if (applyTitleBtn) applyTitleBtn.hidden = true;
  } else {
    text = _coverTitles[index - 1]?.title || "";
    style = normalizeTextStyle(_coverStyles[index - 1]);
    if (label) label.textContent = `编辑封面卡片 ${String(index).padStart(2, "0")}`;
    if (applyTitleBtn) applyTitleBtn.hidden = false;
  }

  const theme = currentTheme();
  const ta = $("cardEditText");
  if (ta) ta.value = text;
  const color = $("cardEditColor");
  if (color) color.value = style.color || theme.ink;
  const bg = $("cardEditBg");
  if (bg) bg.value = style.bg || theme.bg;
  const accent = $("cardEditAccent");
  if (accent) accent.value = style.accent || theme.accent;
  const fs = $("cardEditFontSize");
  if (fs) fs.value = String(style.fontSize || 0);
  updateFontSizeLabel(style.fontSize || 0);
  const ls = $("cardEditLetterSpacing");
  if (ls) ls.value = String(style.letterSpacing || 0);
  updateLetterSpacingLabel(style.letterSpacing || 0);
  setActiveFont(style.fontFamily || "theme");
  const bold = $("cardEditBold");
  if (bold) bold.checked = style.bold;
  const hl = $("cardEditHighlight");
  if (hl) hl.checked = style.highlight;
  const hlColor = $("cardEditHighlightColor");
  if (hlColor) hlColor.value = style.highlightColor || DEFAULT_TEXT_STYLE.highlightColor;
  const ul = $("cardEditUnderline");
  if (ul) ul.checked = style.underline;
  const align = $("cardEditAlign");
  if (align) align.value = style.align || "auto";
  const vAlign = $("cardEditVAlign");
  if (vAlign) vAlign.value = style.vAlign || "middle";

  panel.hidden = false;
  if (kind === "quote") renderGrid();
  else renderCoversGrid();
  panel.scrollIntoView({ behavior: "smooth", block: "nearest" });
}

function updateFontSizeLabel(n) {
  const el = $("cardEditFontSizeVal");
  if (!el) return;
  el.textContent = n > 0 ? `${n}px` : "自动";
}

function updateLetterSpacingLabel(n) {
  const el = $("cardEditLetterSpacingVal");
  if (!el) return;
  el.textContent = n > 0 ? `${n}` : "默认";
}

function readEditorStyle() {
  const theme = currentTheme();
  const colorVal = $("cardEditColor")?.value || "";
  const bgVal = $("cardEditBg")?.value || "";
  const accentVal = $("cardEditAccent")?.value || "";
  // 与主题默认色相同时视为「跟随主题」，避免重置后被写死
  return normalizeTextStyle({
    color: colorVal && colorVal.toLowerCase() !== theme.ink.toLowerCase() ? colorVal : "",
    bg: bgVal && bgVal.toLowerCase() !== theme.bg.toLowerCase() ? bgVal : "",
    accent: accentVal && accentVal.toLowerCase() !== theme.accent.toLowerCase() ? accentVal : "",
    fontFamily: getActiveFontId(),
    fontSize: Number($("cardEditFontSize")?.value || 0),
    letterSpacing: Number($("cardEditLetterSpacing")?.value || 0),
    bold: Boolean($("cardEditBold")?.checked),
    highlight: Boolean($("cardEditHighlight")?.checked),
    highlightColor: $("cardEditHighlightColor")?.value || DEFAULT_TEXT_STYLE.highlightColor,
    underline: Boolean($("cardEditUnderline")?.checked),
    align: $("cardEditAlign")?.value || "auto",
    vAlign: $("cardEditVAlign")?.value || "middle"
  });
}

/** 把面板改动写回缓存，防抖后重渲 */
function onCardEditorChange() {
  if (!_editing) return;
  const { kind, index } = _editing;
  const i = index - 1;
  const text = ($("cardEditText")?.value || "").trim();
  const style = readEditorStyle();

  if (kind === "quote") {
    if (text) _punchlines[i] = text.slice(0, 80);
    _punchStyles[i] = style;
  } else {
    if (text && _coverTitles[i]) _coverTitles[i] = { ..._coverTitles[i], title: text.slice(0, 80) };
    _coverStyles[i] = style;
  }

  updateFontSizeLabel(style.fontSize);
  updateLetterSpacingLabel(style.letterSpacing);
  clearTimeout(_editRerenderTimer);
  _editRerenderTimer = setTimeout(() => {
    rerenderEditingCard().catch((err) => {
      console.warn("[workspace-cards] edit rerender failed", err);
    });
  }, 180);
}

async function rerenderEditingCard() {
  if (!_editing) return;
  const { kind } = _editing;
  if (kind === "quote") {
    if (_busy) return;
    _busy = true;
    try {
      await renderAndShow();
    } finally {
      _busy = false;
    }
  } else {
    if (_coverBusy) return;
    _coverBusy = true;
    try {
      await renderCoversAndShow();
    } finally {
      _coverBusy = false;
    }
  }
}

function resetCardEditorStyle() {
  if (!_editing) return;
  const theme = currentTheme();
  const color = $("cardEditColor");
  if (color) color.value = theme.ink;
  const bg = $("cardEditBg");
  if (bg) bg.value = theme.bg;
  const accent = $("cardEditAccent");
  if (accent) accent.value = theme.accent;
  const fs = $("cardEditFontSize");
  if (fs) fs.value = "0";
  updateFontSizeLabel(0);
  const ls = $("cardEditLetterSpacing");
  if (ls) ls.value = "0";
  updateLetterSpacingLabel(0);
  setActiveFont("theme");
  const bold = $("cardEditBold");
  if (bold) bold.checked = false;
  const hl = $("cardEditHighlight");
  if (hl) hl.checked = false;
  const hlColor = $("cardEditHighlightColor");
  if (hlColor) hlColor.value = DEFAULT_TEXT_STYLE.highlightColor;
  const ul = $("cardEditUnderline");
  if (ul) ul.checked = false;
  const align = $("cardEditAlign");
  if (align) align.value = "auto";
  const vAlign = $("cardEditVAlign");
  if (vAlign) vAlign.value = "middle";

  const { kind, index } = _editing;
  const i = index - 1;
  const text = ($("cardEditText")?.value || "").trim();
  const style = normalizeTextStyle();
  if (kind === "quote") {
    if (text) _punchlines[i] = text.slice(0, 80);
    _punchStyles[i] = style;
  } else {
    if (text && _coverTitles[i]) _coverTitles[i] = { ..._coverTitles[i], title: text.slice(0, 80) };
    _coverStyles[i] = style;
  }
  clearTimeout(_editRerenderTimer);
  _editRerenderTimer = setTimeout(() => {
    rerenderEditingCard().catch((err) => {
      console.warn("[workspace-cards] edit rerender failed", err);
    });
  }, 80);
}

function applyEditingAsTitle() {
  if (_editing?.kind !== "cover") return;
  const card = _coverRendered[_editing.index - 1];
  if (card) applyCoverTitle(card);
}

// ============ 逻辑链漫画 Prompt（移植自 prompt-forge） ============

function setComicStatus(text, tone = "info") {
  const el = $("comicStatus");
  if (!el) return;
  el.textContent = text || "";
  el.dataset.tone = tone;
}

function setComicBusy(busy) {
  _comicBusy = busy;
  const btn = $("generateComicPromptButton");
  if (btn) {
    btn.disabled = busy;
    btn.textContent = busy ? "拆解中…" : "🎨 AI 拆解逻辑链并生成 Prompt";
  }
}

/** 拿一个「话题」给自动标签用：优先文章标题输入框，退回漫画标题 */
function currentTopic() {
  return ($("titleInput")?.value || "").trim() || String(_comicData?.title || "");
}

/** 用缓存的结构化数据 + 当前画幅重拼 prompt 并刷新展示（概览 / 标签 / Prompt 三块） */
function renderComicPrompt() {
  if (!_comicData) return;
  const ratio = $("comicRatioSelect")?.value || "16:9";
  const prompt = buildComicPrompt(_comicData, ratio, { grounded: true });
  const ta = $("comicPromptText");
  if (ta) ta.value = prompt;

  const outline = $("comicOutline");
  if (outline) outline.textContent = buildComicOutline(_comicData);

  _comicTags = generateComicTags(currentTopic(), _comicData);
  const tagsEl = $("comicTags");
  if (tagsEl) {
    tagsEl.innerHTML = "";
    _comicTags.forEach((tag) => {
      const span = document.createElement("span");
      span.className = "comic-tag";
      span.textContent = `#${tag}`;
      tagsEl.appendChild(span);
    });
  }

  const box = $("comicResult");
  if (box) box.hidden = false;
  const copyBtn = $("copyComicPromptButton");
  if (copyBtn) copyBtn.hidden = false;
}

/** 主入口：AI 拆解正文 → 结构化逻辑链 → 生图 prompt */
async function generateComicPrompt() {
  if (_comicBusy) return;

  // 与金句卡片同一道 Pro 闸门（ai.quoteCards）
  const access = await checkQuoteCardsAccess();
  if (!access.ok) {
    const meta = PAID_FEATURES["ai.quoteCards"];
    showUpgradeModal({
      featureName: meta?.name || "金句卡片",
      hint: access.hint || meta?.hint || "逻辑链漫画 Prompt 是会员功能。",
      bullets: [
        "AI 把正文拆成环形闭环 / 传导链 / 矩阵分层等 4 种逻辑链布局",
        "一键生成可直接投喂即梦 / Midjourney / DALL·E 的中文生图 Prompt",
        "5 种画幅随心切：公众号头图、小红书竖图、朋友圈、微博卡片"
      ]
    });
    return;
  }

  const bodyHtml = getEditorBodyHtml();
  if (!bodyHtml.replace(/<[^>]+>/g, "").trim()) {
    setComicStatus("正文为空，请先到「编辑排版」改写或粘贴一篇文章。", "warning");
    return;
  }

  setComicBusy(true);
  setComicStatus("AI 正在拆解文章逻辑链…", "info");
  try {
    const settings = await getSettings();
    const template = $("comicTemplateSelect")?.value || "auto";
    _comicData = await requestComicChain(settings, bodyHtml, { template });
    renderComicPrompt();
    const meta = COMIC_TEMPLATE_META[_comicData.template];
    setComicStatus(`已生成「${meta?.name || _comicData.template}」布局的生图 Prompt，复制后投喂文生图模型即可。`, "success");
  } catch (err) {
    console.warn("[workspace-cards] comic prompt failed", err);
    setComicStatus(`生成失败：${err?.message || err}`, "error");
  } finally {
    setComicBusy(false);
  }
}

async function copyComicPrompt() {
  const ta = $("comicPromptText");
  if (!ta?.value) return;
  try {
    await navigator.clipboard.writeText(ta.value);
    setComicStatus("Prompt 已复制到剪贴板。", "success");
  } catch {
    // clipboard 权限被拒时降级为选中文本，让用户手动 Cmd+C
    ta.focus();
    ta.select();
    setComicStatus("自动复制失败，已选中文本，请按 Ctrl/Cmd+C 复制。", "warning");
  }
}

async function copyComicTags() {
  if (!_comicTags.length) return;
  try {
    await navigator.clipboard.writeText(_comicTags.map((t) => `#${t}`).join(" "));
    setComicStatus("标签已复制到剪贴板。", "success");
  } catch {
    setComicStatus("标签复制失败，请手动选取。", "warning");
  }
}

// ============ 贴图种草文案（正文 → 小红书/公众号成品文案） ============

function setSocialStatus(text, tone = "info") {
  const el = $("socialStatus");
  if (!el) return;
  el.textContent = text || "";
  el.dataset.tone = tone;
}

function setSocialBusy(busy) {
  _socialBusy = busy;
  const btn = $("generateSocialPostButton");
  if (btn) {
    btn.disabled = busy;
    btn.textContent = busy ? "写作中…" : "✍️ AI 生成种草文案";
  }
}

/** 结构化文案 → 可整体复制的排版文本 */
function formatSocialPost(r) {
  const parts = [];
  if (r.titles.length) {
    parts.push("【小红书标题备选】\n" + r.titles.map((t, i) => `${i + 1}. ${t}`).join("\n"));
  }
  if (r.post) parts.push("【小红书正文】\n" + r.post);
  if (r.gzhIntro) parts.push("【公众号导语】\n" + r.gzhIntro);
  if (r.hashtags.length) parts.push("【话题标签】\n" + r.hashtags.map((t) => `#${t}`).join(" "));
  if (r.covers.length) {
    parts.push("【封面文字建议】\n" + r.covers.map((t, i) => `${i + 1}. ${t}`).join("\n"));
  }
  return parts.join("\n\n");
}

/** 主入口：正文（+ 已有逻辑链结构）→ 种草文案 */
async function generateSocialPost() {
  if (_socialBusy) return;

  // 与金句卡片同一道 Pro 闸门（ai.quoteCards）
  const access = await checkQuoteCardsAccess();
  if (!access.ok) {
    const meta = PAID_FEATURES["ai.quoteCards"];
    showUpgradeModal({
      featureName: meta?.name || "金句卡片",
      hint: access.hint || meta?.hint || "贴图种草文案是会员功能。",
      bullets: [
        "AI 直接写出 5 个小红书标题 + 300-600 字种草正文",
        "附带公众号导语、12-18 个话题标签、3 组封面文字",
        "与逻辑链漫画贴图内容呼应，发帖一步到位"
      ]
    });
    return;
  }

  const bodyHtml = getEditorBodyHtml();
  if (!bodyHtml.replace(/<[^>]+>/g, "").trim()) {
    setSocialStatus("正文为空，请先到「编辑排版」改写或粘贴一篇文章。", "warning");
    return;
  }

  setSocialBusy(true);
  setSocialStatus("AI 正在写种草文案…", "info");
  try {
    const settings = await getSettings();
    const result = await requestSocialPost(settings, bodyHtml, {
      outline: _comicData ? buildComicOutline(_comicData) : "",
      tags: _comicTags
    });
    const ta = $("socialPostText");
    if (ta) {
      ta.value = formatSocialPost(result);
      ta.hidden = false;
    }
    const copyBtn = $("copySocialPostButton");
    if (copyBtn) copyBtn.hidden = false;
    setSocialStatus(
      `已生成 ${result.titles.length} 个标题 + 正文${result.gzhIntro ? " + 公众号导语" : ""}，复制后按板块取用。`,
      "success"
    );
  } catch (err) {
    console.warn("[workspace-cards] social post failed", err);
    setSocialStatus(`生成失败：${err?.message || err}`, "error");
  } finally {
    setSocialBusy(false);
  }
}

async function copySocialPost() {
  const ta = $("socialPostText");
  if (!ta?.value) return;
  try {
    await navigator.clipboard.writeText(ta.value);
    setSocialStatus("文案已复制到剪贴板。", "success");
  } catch {
    ta.focus();
    ta.select();
    setSocialStatus("自动复制失败，已选中文本，请按 Ctrl/Cmd+C 复制。", "warning");
  }
}

/** 切主题 / 尺寸 / 落款时，若已有金句或封面则即时重渲（不重新调 AI） */
async function onOptionChange() {
  if (_busy || _coverBusy) return;
  const hasPunch = _punchlines.length > 0;
  const hasCover = _coverTitles.length > 0;
  if (!hasPunch && !hasCover) return;

  if (hasPunch) setBusy(true);
  if (hasCover) setCoverBusy(true);
  if (hasPunch) setStatus("重新排版金句卡片…", "info");
  if (hasCover) setCoverStatus("重新排版封面卡片…", "info");
  try {
    if (hasPunch) {
      await renderAndShow();
      setStatus(`已更新 ${_rendered.length} 张金句卡片。`, "success");
    }
    if (hasCover) {
      await renderCoversAndShow();
      setCoverStatus(`已更新 ${_coverRendered.length} 张封面卡片。`, "success");
    }
  } catch (err) {
    if (hasPunch) setStatus(`重排失败：${err?.message || err}`, "error");
    if (hasCover) setCoverStatus(`重排失败：${err?.message || err}`, "error");
  } finally {
    if (hasPunch) setBusy(false);
    if (hasCover) setCoverBusy(false);
  }
}

export function initWorkspaceCards() {
  const genBtn = $("generateCardsButton");
  if (!genBtn) return; // 视图不存在（旧 HTML）时静默跳过

  genBtn.addEventListener("click", generateCards);
  $("downloadAllCardsButton")?.addEventListener("click", downloadAll);
  $("insertAllCardsButton")?.addEventListener("click", insertAll);
  $("generateCoverCardsButton")?.addEventListener("click", generateCoverCards);
  $("downloadAllCoversButton")?.addEventListener("click", downloadAllCovers);
  $("insertAllCoversButton")?.addEventListener("click", insertAllCovers);
  $("cardThemeSelect")?.addEventListener("change", onOptionChange);
  $("cardSizeSelect")?.addEventListener("change", onOptionChange);
  // 落款用 blur / change，避免每个字符都重渲
  $("cardAccountInput")?.addEventListener("change", onOptionChange);

  // 卡片文字实时编辑
  $("cardTextEditorClose")?.addEventListener("click", closeCardEditor);
  $("cardEditReset")?.addEventListener("click", resetCardEditorStyle);
  $("cardEditApplyTitle")?.addEventListener("click", applyEditingAsTitle);
  for (const id of [
    "cardEditText",
    "cardEditColor",
    "cardEditBg",
    "cardEditAccent",
    "cardEditFontSize",
    "cardEditLetterSpacing",
    "cardEditBold",
    "cardEditHighlight",
    "cardEditHighlightColor",
    "cardEditUnderline",
    "cardEditAlign",
    "cardEditVAlign"
  ]) {
    const el = $(id);
    if (!el) continue;
    const evt = el.tagName === "TEXTAREA" || el.type === "text" || el.type === "range" ? "input" : "change";
    el.addEventListener(evt, onCardEditorChange);
    if (el.type === "range") el.addEventListener("change", onCardEditorChange);
  }

  // 逻辑链漫画 Prompt
  $("generateComicPromptButton")?.addEventListener("click", generateComicPrompt);
  $("copyComicPromptButton")?.addEventListener("click", copyComicPrompt);
  $("copyComicTagsButton")?.addEventListener("click", copyComicTags);
  // 切画幅只重拼 prompt（纯函数），不重新调 AI
  $("comicRatioSelect")?.addEventListener("change", renderComicPrompt);

  // 贴图种草文案
  $("generateSocialPostButton")?.addEventListener("click", generateSocialPost);
  $("copySocialPostButton")?.addEventListener("click", copySocialPost);

  // 预填落款：用当前激活的公众号账号名（best-effort，失败也无所谓）
  getSettings()
    .then((settings) => {
      const input = $("cardAccountInput");
      if (!input || input.value) return;
      const profiles = Array.isArray(settings?.wechatProfiles) ? settings.wechatProfiles : [];
      const idx = settings?.activeWechatProfileIndex;
      const name =
        (typeof idx === "number" && profiles[idx]?.name) ||
        profiles[0]?.name ||
        "";
      if (name) input.value = name.startsWith("@") ? name : `@${name}`;
    })
    .catch(() => {});
}
