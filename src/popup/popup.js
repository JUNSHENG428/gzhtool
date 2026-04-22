import { formatRuntimeError } from "../shared/utils.js";

const els = {
  status: document.querySelector("#status"),
  runtimeBadge: document.querySelector("#runtimeBadge"),
  currentTabTitle: document.querySelector("#currentTabTitle"),
  currentTabHost: document.querySelector("#currentTabHost"),
  captureAndOpen: document.querySelector("#captureAndOpen"),
  openWorkspace: document.querySelector("#openWorkspace"),
  openHotTopics: document.querySelector("#openHotTopics"),
  openOptions: document.querySelector("#openOptions"),
  openWelcome: document.querySelector("#openWelcome"),
  openHelp: document.querySelector("#openHelp"),
  lastSourceText: document.querySelector("#lastSourceText")
};

let statusFadeTimer = null;
let currentTab = null;

void initPopup();

async function initPopup() {
  bindEvents();
  await Promise.all([hydrateCurrentTab(), hydrateSession()]);
}

function bindEvents() {
  els.captureAndOpen?.addEventListener("click", () =>
    runAction(
      { type: "PREPARE_SOURCE_AND_OPEN_WORKSPACE" },
      "已打开编辑台，正在抓取当前页面。"
    )
  );
  els.openWorkspace?.addEventListener("click", () =>
    runAction({ type: "OPEN_WORKSPACE", autoCapture: false }, "已打开编辑台。")
  );
  els.openHotTopics?.addEventListener("click", () => openInternalPage("src/pages/hot-topics.html"));
  els.openWelcome?.addEventListener("click", () => openInternalPage("src/pages/welcome.html"));
  els.openHelp?.addEventListener("click", () => openInternalPage("src/pages/help.html"));
  els.openOptions?.addEventListener("click", async () => {
    await chrome.runtime.openOptionsPage();
    window.close();
  });
}

async function hydrateCurrentTab() {
  const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
  currentTab = tabs?.[0] || null;

  if (!currentTab) {
    setCurrentPage("未找到当前标签页", "", false);
    return;
  }

  const canCapture = isScrapableUrl(currentTab.url);
  setCurrentPage(currentTab.title || "未命名页面", formatHost(currentTab.url), canCapture);
}

async function hydrateSession() {
  const response = await chrome.runtime.sendMessage({ type: "GET_CONTEXT" }).catch((error) => ({
    ok: false,
    error
  }));

  if (!response?.ok) {
    els.lastSourceText.textContent = "暂时无法读取最近记录";
    return;
  }

  const session = response.data || {};
  const title = session.lastSourceTitle || session.lastCapture?.title || "";
  const url = session.lastSourceUrl || session.lastCapture?.url || "";
  if (!title && !url) {
    els.lastSourceText.textContent = "暂无记录";
    return;
  }

  els.lastSourceText.textContent = [title || "未命名来源", formatHost(url)].filter(Boolean).join(" · ");
}

function setCurrentPage(title, host, canCapture) {
  els.currentTabTitle.textContent = title;
  els.currentTabHost.textContent = host || (canCapture ? "" : "该页面不支持直接抓取");
  els.captureAndOpen.disabled = !canCapture;
  els.runtimeBadge.textContent = canCapture ? "可抓取" : "不可抓取";
  els.runtimeBadge.dataset.state = canCapture ? "ready" : "blocked";
}

async function runAction(message, successText) {
  if (message.type === "PREPARE_SOURCE_AND_OPEN_WORKSPACE" && !isScrapableUrl(currentTab?.url)) {
    setStatus("当前页面不支持抓取，请切到普通网页后重试。", "warning");
    return;
  }

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
  document.querySelectorAll("button").forEach((button) => {
    if (button.id === "captureAndOpen" && !isScrapableUrl(currentTab?.url)) {
      button.disabled = true;
      return;
    }
    button.disabled = isBusy;
  });
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
