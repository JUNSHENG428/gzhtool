import { formatRuntimeError } from "../shared/utils.js";
import { getSettings } from "../shared/storage.js";
import { getLicenseState, subscribeLicenseChanges } from "../shared/license.js";

const els = {
  status: document.querySelector("#status"),
  pageCard: document.querySelector("#pageCard"),
  pageCardTitle: document.querySelector("#pageCardTitle"),
  pageCardHost: document.querySelector("#pageCardHost"),
  pageCardBadge: document.querySelector("#pageCardBadge"),
  aiCard: document.querySelector("#aiCard"),
  aiCardDot: document.querySelector("#aiCardDot"),
  aiCardTitle: document.querySelector("#aiCardTitle"),
  aiCardModel: document.querySelector("#aiCardModel"),
  captureAndOpen: document.querySelector("#captureAndOpen"),
  captureSelection: document.querySelector("#captureSelection"),
  captureReadable: document.querySelector("#captureReadable"),
  captureRaw: document.querySelector("#captureRaw"),
  openWorkspace: document.querySelector("#openWorkspace"),
  openAgent: document.querySelector("#openAgentButton"),
  openOptions: document.querySelector("#openOptions"),
  openHotTopics: document.querySelector("#openHotTopics"),
  refreshHotTopics: document.querySelector("#refreshHotTopics"),
  hotTopicsSource: document.querySelector("#hotTopicsSource"),
  hotTopicsList: document.querySelector("#hotTopicsList"),
  lastSourceCard: document.querySelector("#lastSourceCard"),
  lastSourceText: document.querySelector("#lastSourceText"),
  licensePill: document.querySelector("#licensePill"),
  licensePillLabel: document.querySelector("#licensePillLabel"),
  licensePillHint: document.querySelector("#licensePillHint")
};

const SITE_LABELS = [
  { match: /(^|\.)mp\.weixin\.qq\.com$/i, label: "公众号" },
  { match: /(^|\.)zhihu\.com$/i, label: "知乎" },
  { match: /(^|\.)(weibo\.com|m\.weibo\.cn|s\.weibo\.com)$/i, label: "微博" },
  { match: /(^|\.)juejin\.cn$/i, label: "掘金" },
  { match: /(^|\.)xiaohongshu\.com$/i, label: "小红书" },
  { match: /(^|\.)36kr\.com$/i, label: "36氪" },
  { match: /(^|\.)huxiu\.com$/i, label: "虎嗅" },
  { match: /(^|\.)leiphone\.com$/i, label: "雷锋网" },
  { match: /(^|\.)v2ex\.com$/i, label: "V2EX" },
  { match: /(^|\.)news\.ycombinator\.com$/i, label: "Hacker News" },
  { match: /(^|\.)medium\.com$/i, label: "Medium" },
  { match: /(^|\.)substack\.com$/i, label: "Substack" }
];

let statusFadeTimer = null;
let currentTab = null;
let activeHotSource = "zhihu";

void initPopup();

async function initPopup() {
  bindEvents();
  bindTabs();
  await Promise.all([
    hydrateCurrentTab(),
    hydrateAiStatus(),
    hydrateSession(),
    hydrateLicenseStatus(),
    loadHotTopics(false)
  ]);

  // license / 登录态变化时（任意一处：options 激活、sw 后台复验、解绑）都自动刷新徽章
  subscribeLicenseChanges(() => {
    void hydrateLicenseStatus();
  });
}

/**
 * Tab 切换：只切显示，不卸载/重渲染任何 pane（保留状态）。
 * 与业务逻辑解耦；业务事件仍在 bindEvents() 里。
 */
function bindTabs() {
  const tabs = document.querySelectorAll(".popup-tab[data-tab]");
  const panes = document.querySelectorAll(".popup-pane[data-pane]");
  if (!tabs.length || !panes.length) return;

  function activate(tabName) {
    tabs.forEach((btn) => {
      const isActive = btn.dataset.tab === tabName;
      btn.classList.toggle("is-active", isActive);
      btn.setAttribute("aria-selected", isActive ? "true" : "false");
    });
    panes.forEach((pane) => {
      pane.dataset.active = pane.dataset.pane === tabName ? "true" : "false";
    });
    try {
      sessionStorage.setItem("popupActiveTab", tabName);
    } catch { /* ignore */ }
  }

  tabs.forEach((btn) => {
    btn.addEventListener("click", () => activate(btn.dataset.tab));
  });

  // 还原上次离开时的 Tab（用 sessionStorage，关 popup 后也能保持本次会话内一致）
  let initial = "write";
  try {
    const saved = sessionStorage.getItem("popupActiveTab");
    if (saved && ["write", "hot", "me"].includes(saved)) initial = saved;
  } catch { /* ignore */ }
  activate(initial);
}

function bindEvents() {
  els.captureAndOpen?.addEventListener("click", () => triggerCapture("readable"));
  els.captureSelection?.addEventListener("click", () => triggerCapture("selection"));
  els.captureReadable?.addEventListener("click", () => triggerCapture("readable"));
  els.captureRaw?.addEventListener("click", () => triggerCapture("raw"));

  els.openWorkspace?.addEventListener("click", () =>
    runAction({ type: "OPEN_WORKSPACE", autoCapture: false }, "已打开编辑台。")
  );

  els.openAgent?.addEventListener("click", async () => {
    await chrome.tabs.create({
      url: chrome.runtime.getURL("src/pages/agent.html")
    });
    window.close();
  });

  els.openOptions?.addEventListener("click", async () => {
    await chrome.runtime.openOptionsPage();
    window.close();
  });

  els.licensePill?.addEventListener("click", async () => {
    // openOptionsPage 不支持 hash 跳转，所以先打开 options 页 + #license 锚点。
    await chrome.tabs.create({
      url: chrome.runtime.getURL("src/options/options.html#license")
    });
    window.close();
  });

  els.openHotTopics?.addEventListener("click", () =>
    openInternalPage("src/pages/hot-topics.html")
  );

  els.refreshHotTopics?.addEventListener("click", () => void loadHotTopics(true));

  // 「我的」Tab 内的入口：复用现有打开 options / welcome / workspace 的逻辑
  document.querySelector("#openOptionsExtra")?.addEventListener("click", async () => {
    await chrome.runtime.openOptionsPage();
    window.close();
  });

  document.querySelector("#openWelcome")?.addEventListener("click", () =>
    openInternalPage("src/pages/welcome.html")
  );

  document.querySelector("#openWorkspaceFromMe")?.addEventListener("click", () =>
    runAction({ type: "OPEN_WORKSPACE", autoCapture: false }, "已打开编辑台。")
  );
}

async function hydrateCurrentTab() {
  const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
  currentTab = tabs?.[0] || null;

  if (!currentTab) {
    setPageCard("未找到当前标签页", "", false);
    return;
  }

  const canCapture = isScrapableUrl(currentTab.url);
  const host = formatHost(currentTab.url);
  const label = host ? labelForHost(host) : currentTab.title || "未命名页面";
  setPageCard(label, host, canCapture);
}

async function hydrateLicenseStatus() {
  if (!els.licensePill) return;
  try {
    const state = await getLicenseState();
    setLicensePill(state.status, state.label, state.hint);
  } catch {
    setLicensePill("free", "免费版", "未激活会员，所有基础功能均可使用");
  }
}

function setLicensePill(status, label, hint) {
  if (!els.licensePill) return;
  els.licensePill.dataset.status = status || "free";
  if (els.licensePillLabel) els.licensePillLabel.textContent = label || "免费版";
  if (els.licensePillHint) els.licensePillHint.textContent = hint || "";
  els.licensePill.title = hint ? `${label} · ${hint}` : label || "";
}

async function hydrateAiStatus() {
  try {
    const settings = await getSettings();
    const apiKey = String(settings.apiKey || "").trim();
    const model = String(settings.model || "").trim();

    if (!apiKey) {
      setAiCard("missing", "AI 未配置", "请到设置填写 API Key");
      return;
    }
    setAiCard("ready", "AI 接口已就绪", model || "默认模型");
  } catch (error) {
    setAiCard("missing", "AI 状态未知", "无法读取设置，请重新加载扩展");
  }
}

async function hydrateSession() {
  const response = await chrome.runtime.sendMessage({ type: "GET_CONTEXT" }).catch((error) => ({
    ok: false,
    error
  }));

  if (!response?.ok) {
    els.lastSourceCard.hidden = true;
    return;
  }

  const session = response.data || {};
  const title = session.lastSourceTitle || session.lastCapture?.title || "";
  const url = session.lastSourceUrl || session.lastCapture?.url || "";
  if (!title && !url) {
    els.lastSourceCard.hidden = true;
    return;
  }

  els.lastSourceCard.hidden = false;
  els.lastSourceText.textContent = [title || "未命名来源", formatHost(url)].filter(Boolean).join(" · ");
}

async function loadHotTopics(forceRefresh) {
  if (!els.hotTopicsList) return;
  setHotTopicsLoading(true);

  try {
    const response = await chrome.runtime.sendMessage({
      type: "FETCH_HOT_TOPICS",
      payload: { source: activeHotSource, forceRefresh: Boolean(forceRefresh) }
    });

    if (!response?.ok) {
      renderHotTopics([], { errorMessage: response?.error?.message || "热点加载失败，可点刷新重试" });
      return;
    }

    const payload = response.data || {};
    const items = Array.isArray(payload.items) ? payload.items.slice(0, 3) : [];
    if (els.hotTopicsSource) {
      const label = payload.label || payload.sourceName || "今日热点";
      els.hotTopicsSource.textContent = `来源：${label}`;
    }
    if (payload.mode === "portal" && payload.portal) {
      renderHotTopics([], { errorMessage: payload.portal.title || "请到「热点捕捉」打开" });
    } else {
      renderHotTopics(items, {});
    }
  } catch (error) {
    renderHotTopics([], { errorMessage: formatRuntimeError(error, "热点加载失败") });
  } finally {
    setHotTopicsLoading(false);
  }
}

function setHotTopicsLoading(isLoading) {
  els.refreshHotTopics?.classList.toggle("is-loading", Boolean(isLoading));
  if (isLoading) {
    els.hotTopicsList.innerHTML = '<li class="hot-topics-skeleton">加载中…</li>';
  }
}

function renderHotTopics(items, { errorMessage = "" } = {}) {
  els.hotTopicsList.innerHTML = "";
  if (!items.length) {
    const li = document.createElement("li");
    li.className = "is-empty";
    li.textContent = errorMessage || "暂无热点，可点击刷新";
    els.hotTopicsList.appendChild(li);
    return;
  }

  items.forEach((item, idx) => {
    const li = document.createElement("li");
    li.title = item.title || "";
    li.dataset.url = item.url || "";

    const rank = document.createElement("span");
    rank.className = "rank";
    rank.textContent = String(idx + 1);

    const text = document.createElement("span");
    text.className = "text";
    text.textContent = item.title || "（无标题）";

    li.append(rank, text);
    li.addEventListener("click", () => {
      if (item.url) {
        chrome.tabs.create({ url: item.url });
        window.close();
      }
    });
    els.hotTopicsList.appendChild(li);
  });
}

function setPageCard(title, host, canCapture) {
  els.pageCardTitle.textContent = title;
  els.pageCardHost.textContent = host || (canCapture ? "" : "该页面不支持直接抓取");
  els.captureAndOpen.disabled = !canCapture;
  els.captureSelection.disabled = !canCapture;
  els.captureReadable.disabled = !canCapture;
  els.captureRaw.disabled = !canCapture;

  els.pageCardBadge.textContent = canCapture ? "可抓取" : "不可抓取";
  els.pageCardBadge.dataset.state = canCapture ? "ready" : "blocked";
  els.pageCard.dataset.state = canCapture ? "ready" : "blocked";
}

function setAiCard(state, title, modelText) {
  els.aiCard.dataset.state = state;
  els.aiCardDot.dataset.state = state;
  els.aiCardTitle.textContent = title;
  els.aiCardModel.textContent = modelText;
}

function triggerCapture(mode) {
  if (!isScrapableUrl(currentTab?.url)) {
    setStatus("当前页面不支持抓取，请切到普通网页后重试。", "warning");
    return;
  }
  const successMessage =
    mode === "selection"
      ? "已打开编辑台，正在抓取选中文字。"
      : mode === "raw"
      ? "已打开编辑台，正在原样抓取整页。"
      : "已打开编辑台，正在抓取当前页面。";
  void runAction(
    { type: "PREPARE_SOURCE_AND_OPEN_WORKSPACE", captureMode: mode },
    successMessage
  );
}

async function runAction(message, successText) {
  setBusy(true);
  setStatus("处理中...", "info");

  try {
    const response = await chrome.runtime.sendMessage(message);
    if (!response?.ok) {
      setStatus(formatRuntimeError(response?.error, "执行失败，请稍后重试。"), "error");
      return;
    }
    setStatus(successText, "success");
    window.close();
  } catch (error) {
    setStatus(formatRuntimeError(error, "执行失败，请检查扩展是否已重新加载。"), "error");
  } finally {
    setBusy(false);
  }
}

function setBusy(isBusy) {
  const captureButtons = [
    els.captureAndOpen,
    els.captureSelection,
    els.captureReadable,
    els.captureRaw
  ];
  const canCapture = isScrapableUrl(currentTab?.url);
  captureButtons.forEach((button) => {
    if (!button) return;
    button.disabled = isBusy || !canCapture;
  });
  if (els.openWorkspace) els.openWorkspace.disabled = isBusy;
}

function setStatus(message, type = "info") {
  clearTimeout(statusFadeTimer);

  const validTypes = new Set(["info", "success", "warning", "error"]);
  const safeType = validTypes.has(type) ? type : "info";

  els.status.textContent = message;
  els.status.dataset.statusType = safeType;
  els.status.classList.remove("is-faded");

  statusFadeTimer = setTimeout(
    () => els.status.classList.add("is-faded"),
    safeType === "error" || safeType === "warning" ? 8000 : 4000
  );
}

async function openInternalPage(path) {
  await chrome.tabs.create({ url: chrome.runtime.getURL(path) });
  window.close();
}

function isScrapableUrl(url = "") {
  return /^https?:\/\//i.test(String(url || ""));
}

function formatHost(url = "") {
  try {
    return new URL(url).host.replace(/^www\./, "");
  } catch {
    return "";
  }
}

function labelForHost(host) {
  for (const entry of SITE_LABELS) {
    if (entry.match.test(host)) return entry.label;
  }
  return "网页";
}
