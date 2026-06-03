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
import { requestPunchlines } from "../shared/ai.js";
import {
  renderQuoteCards,
  CARD_SIZES,
  CARD_THEMES
} from "../shared/quote-cards.js";

// 当前金句文本（提炼一次后缓存，切主题 / 尺寸只重渲不重新调 AI）
let _punchlines = [];
let _rendered = []; // [{ index, quote, blob, dataUrl }]
let _busy = false;

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
    setStatus(`提炼到 ${_punchlines.length} 句，正在生成卡片…`, "info");
    await renderAndShow();
    setStatus(`已生成 ${_rendered.length} 张卡片，可下载或插入正文。`, "success");
  } catch (err) {
    console.warn("[workspace-cards] generate failed", err);
    setStatus(`生成失败：${err?.message || err}`, "error");
  } finally {
    setBusy(false);
  }
}

/** 用当前缓存的金句 + 当前主题/尺寸重渲卡片并刷新网格 */
async function renderAndShow() {
  const opts = currentOpts();
  _rendered = await renderQuoteCards(_punchlines, opts);
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
    li.innerHTML = `
      <div class="card-thumb ${aspectClass}">
        <img alt="金句卡片 ${card.index}" />
      </div>
      <p class="card-quote"></p>
      <div class="card-cell-actions">
        <button type="button" class="ghost card-download">下载</button>
        <button type="button" class="ghost card-insert">插入正文</button>
      </div>
    `;
    li.querySelector("img").src = card.dataUrl;
    li.querySelector(".card-quote").textContent = card.quote;
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

/** 切主题 / 尺寸 / 落款时，若已有金句则即时重渲（不重新调 AI） */
async function onOptionChange() {
  if (!_punchlines.length || _busy) return;
  setBusy(true);
  setStatus("重新排版卡片…", "info");
  try {
    await renderAndShow();
    setStatus(`已更新 ${_rendered.length} 张卡片。`, "success");
  } catch (err) {
    setStatus(`重排失败：${err?.message || err}`, "error");
  } finally {
    setBusy(false);
  }
}

export function initWorkspaceCards() {
  const genBtn = $("generateCardsButton");
  if (!genBtn) return; // 视图不存在（旧 HTML）时静默跳过

  genBtn.addEventListener("click", generateCards);
  $("downloadAllCardsButton")?.addEventListener("click", downloadAll);
  $("insertAllCardsButton")?.addEventListener("click", insertAll);
  $("cardThemeSelect")?.addEventListener("change", onOptionChange);
  $("cardSizeSelect")?.addEventListener("change", onOptionChange);
  // 落款用 blur / change，避免每个字符都重渲
  $("cardAccountInput")?.addEventListener("change", onOptionChange);

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
