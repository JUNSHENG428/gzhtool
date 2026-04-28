import { formatRuntimeError } from "../shared/utils.js";
import { getSettings } from "../shared/storage.js";
import { STORAGE_KEYS } from "../shared/defaults.js";
import {
  getLicenseState,
  subscribeLicenseChanges,
  getAuthRecord,
  getLicenseSummaryText,
  verifyLicenseRemote
} from "../shared/license.js";
import { getUsageSnapshot } from "../shared/usage-stats.js";

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
  openOptions: document.querySelector("#openOptions"),
  openHotTopics: document.querySelector("#openHotTopics"),
  refreshHotTopics: document.querySelector("#refreshHotTopics"),
  hotTopicsSource: document.querySelector("#hotTopicsSource"),
  hotTopicsList: document.querySelector("#hotTopicsList"),
  lastSourceCard: document.querySelector("#lastSourceCard"),
  lastSourceText: document.querySelector("#lastSourceText"),
  licensePill: document.querySelector("#licensePill"),
  licensePillLabel: document.querySelector("#licensePillLabel"),
  licensePillHint: document.querySelector("#licensePillHint"),
  captureHint: document.querySelector("#captureHint"),
  memberQuotaRemain: document.querySelector("#memberQuotaRemain"),
  memberPlanLine: document.querySelector("#memberPlanLine"),
  memberAccountLine: document.querySelector("#memberAccountLine"),
  memberSyncBtn: document.querySelector("#memberSyncBtn")
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
  // 先注册跨页变更监听，再跑可能耗时的热点 / 会员初始化。
  // 否则用户从 options 保存设置时，popup 可能仍卡在 loadHotTopics，
  // 导致这次 settings.onChanged 被错过，AI 模型卡片停在旧值。
  subscribeLicenseChanges(() => {
    void hydrateLicenseStatus();
  });
  subscribeSettingsChanges(() => {
    void hydrateAiStatus();
  });
  await Promise.all([
    hydrateCurrentTab(),
    hydrateAiStatus(),
    hydrateSession(),
    hydrateLicenseStatus(),
    loadHotTopics(false)
  ]);

  // license / settings 监听已在初始化开始时注册，避免慢请求期间漏掉变更事件。
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

  els.memberSyncBtn?.addEventListener("click", async () => {
    setStatus("正在向服务器同步会员状态…", "info");
    try {
      const state = await getLicenseState({ refresh: false });
      if (!state?.key) {
        // 未绑定 key 时，「同步」≈ 提示用户去 options 登录 / 激活
        await chrome.tabs.create({
          url: chrome.runtime.getURL("src/options/options.html#license")
        });
        window.close();
        return;
      }
      const result = await verifyLicenseRemote(state.key, { silent: true });
      if (result?.ok || result?.status === "active") {
        setStatus("已同步会员状态 ✓", "success");
      } else {
        const msg = result?.message || result?.reason || "服务器返回未通过";
        setStatus(`同步未通过：${msg}`, "warning");
      }
      await hydrateLicenseStatus();
    } catch (err) {
      setStatus(formatRuntimeError(err, "同步失败，请稍后再试。"), "error");
    }
  });
}

function subscribeSettingsChanges(callback) {
  if (typeof callback !== "function") return () => {};
  if (typeof chrome === "undefined" || !chrome?.storage?.onChanged) {
    return () => {};
  }
  const listener = (changes, area) => {
    if (area !== "local") return;
    if (!changes[STORAGE_KEYS.settings]) return;
    try {
      callback(changes[STORAGE_KEYS.settings]);
    } catch (error) {
      console.warn("[popup] settings subscriber failed", error);
    }
  };
  chrome.storage.onChanged.addListener(listener);
  return () => {
    try {
      chrome.storage.onChanged.removeListener(listener);
    } catch {
      // ignore
    }
  };
}

async function hydrateCurrentTab() {
  const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
  currentTab = tabs?.[0] || null;

  if (!currentTab) {
    setPageCard({ kind: "unknown", title: "未找到当前标签页", host: "" });
    return;
  }

  const detect = detectPageKind(currentTab);
  setPageCard(detect);
}

/**
 * 4 态网页可用性判断（P0：当前网页卡增加可用性提示）：
 *   - normal       普通网页（http/https）→ 可抓取
 *   - wechat-mp    公众号后台 → 不能直接抓，但可引导到「设置 / 多账号绑定」
 *   - blocked-host 浏览器内部页 / 扩展页 → 不可抓
 *   - no-permission 协议不支持（file://、chrome-extension://、view-source 等）
 */
function detectPageKind(tab) {
  const rawUrl = String(tab?.url || "").trim();
  const url = rawUrl.toLowerCase();
  const host = formatHost(rawUrl);

  if (!rawUrl) {
    return { kind: "unknown", title: tab?.title || "未命名页面", host: "", url: "" };
  }
  // chrome:// / edge:// / about:// 等浏览器内部页
  if (/^(chrome|edge|brave|about|view-source):/i.test(rawUrl)) {
    return { kind: "blocked-host", title: tab?.title || "浏览器内部页", host, url: rawUrl };
  }
  // 扩展自身页面
  if (/^chrome-extension:/i.test(rawUrl)) {
    return { kind: "blocked-host", title: "扩展内部页", host, url: rawUrl };
  }
  // 本地文件
  if (/^file:/i.test(rawUrl)) {
    return { kind: "no-permission", title: "本地文件页", host, url: rawUrl };
  }
  if (!/^https?:/i.test(rawUrl)) {
    return { kind: "no-permission", title: tab?.title || "未知协议页面", host, url: rawUrl };
  }
  // 公众号后台（mp.weixin.qq.com 含 cgi-bin / advanced）— 不抓正文，引导走"绑定 AppID"
  if (host === "mp.weixin.qq.com" && /\/(cgi-bin|advanced|appmsgpublish|smartreply)/i.test(url)) {
    return { kind: "wechat-mp", title: "公众号后台", host, url: rawUrl };
  }
  // 普通网页
  const label = host ? labelForHost(host) : (tab?.title || "未命名页面");
  return { kind: "normal", title: label, host, url: rawUrl };
}

async function hydrateLicenseStatus() {
  if (!els.licensePill) return;
  let state = null;
  let auth = null;
  let usage = null;
  try {
    [state, auth, usage] = await Promise.all([
      getLicenseState({ refresh: false }).catch(() => null),
      getAuthRecord().catch(() => null),
      getUsageSnapshot().catch(() => null)
    ]);
  } catch (err) {
    console.warn("[popup] hydrateLicense failed", err);
  }

  const summary = getLicenseSummaryText(state, { usage, auth });
  setLicensePill(summary);
  renderMemberMeta({ state, auth, usage, summary });
}

function setLicensePill(summary) {
  if (!els.licensePill || !summary) return;
  els.licensePill.dataset.status = summary.tone || "free";
  if (els.licensePillLabel) els.licensePillLabel.textContent = summary.label || "免费版";
  if (els.licensePillHint) els.licensePillHint.textContent = summary.sub || "";
  els.licensePill.title = summary.sub ? `${summary.label} · ${summary.sub}` : summary.label || "";
}

/**
 * 「我的」Tab 的会员状态明细行。和 license-pill 一起组成完整的"会员卡"。
 * 文案统一从 getLicenseSummaryText 出，确保和 workspace pill / member 页一致。
 */
function renderMemberMeta({ state, auth, usage, summary }) {
  if (els.memberQuotaRemain) {
    if (state?.plan === "pro" && state?.dailyQuota === -1) {
      els.memberQuotaRemain.textContent = "Pro · 不限次数";
    } else {
      const cap = Number.isFinite(state?.dailyQuota) && state.dailyQuota > 0
        ? state.dailyQuota
        : 5;
      const used = Number(usage?.today?.rewrite) || 0;
      const remain = Math.max(0, cap - used);
      els.memberQuotaRemain.textContent = `${remain} / ${cap} 次`;
    }
  }

  if (els.memberPlanLine) {
    if (state?.status === "expiring") {
      els.memberPlanLine.textContent = `Pro · 还剩 ${state.daysLeft} 天到期`;
    } else if (state?.status === "pro") {
      els.memberPlanLine.textContent = state?.expiresAt
        ? `Pro · 有效至 ${formatYmd(state.expiresAt)}`
        : "Pro · 长期有效";
    } else if (state?.status === "expired" || state?.status === "invalid") {
      els.memberPlanLine.textContent = summary?.label || "已到期";
    } else if (state?.status === "stale") {
      els.memberPlanLine.textContent = "需要重新验证";
    } else {
      els.memberPlanLine.textContent = "免费版";
    }
  }

  if (els.memberAccountLine) {
    const email = auth?.user?.email || state?.user?.email;
    els.memberAccountLine.textContent = email || "未登录 · 点同步可登录";
  }
}

function formatYmd(ts) {
  const d = new Date(Number(ts) || 0);
  if (!Number.isFinite(d.getTime())) return "";
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
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

/**
 * 渲染当前网页卡（4 态）。state 来自 detectPageKind()。
 *   normal       → 可抓取，主按钮可用
 *   wechat-mp    → 不抓正文；主按钮置灰，副提示引导去「设置」绑定 AppID
 *   blocked-host → 内部页 / 扩展页，主按钮置灰
 *   no-permission → file:// 之类，主按钮置灰
 */
function setPageCard(detect) {
  const kind = detect?.kind || "unknown";
  const canCapture = kind === "normal";

  els.pageCardTitle.textContent = detect?.title || "未命名页面";

  const hostText = detect?.host || "";
  const subByKind = {
    normal: hostText,
    "wechat-mp": "公众号后台 · 不抓正文，可去设置绑定 AppID",
    "blocked-host": "浏览器内部页 / 扩展页 · 不可抓取",
    "no-permission": "扩展无权限访问该协议（例如 file://）",
    unknown: "无法识别当前页面"
  };
  els.pageCardHost.textContent = subByKind[kind] || hostText;

  els.captureAndOpen.disabled = !canCapture;
  els.captureSelection.disabled = !canCapture;
  els.captureReadable.disabled = !canCapture;
  els.captureRaw.disabled = !canCapture;

  const badgeByKind = {
    normal: { text: "普通网页", state: "ready" },
    "wechat-mp": { text: "公众号后台", state: "info" },
    "blocked-host": { text: "不可抓取页面", state: "blocked" },
    "no-permission": { text: "无权限页面", state: "blocked" },
    unknown: { text: "检测中", state: "loading" }
  };
  const badge = badgeByKind[kind];
  els.pageCardBadge.textContent = badge.text;
  els.pageCardBadge.dataset.state = badge.state;
  els.pageCard.dataset.state = badge.state === "ready" ? "ready" : badge.state === "info" ? "info" : "blocked";

  // 抓取后去向提示：随状态调整
  if (els.captureHint) {
    if (canCapture) {
      els.captureHint.textContent = "抓取后会自动进入「编辑台」，再点 AI 改写。";
      els.captureHint.dataset.tone = "info";
    } else if (kind === "wechat-mp") {
      els.captureHint.textContent = "想直接发到这个公众号？请到「设置 → 公众号」绑定 AppID/AppSecret。";
      els.captureHint.dataset.tone = "warning";
    } else {
      els.captureHint.textContent = "请切到普通网页（http/https）后再抓取。";
      els.captureHint.dataset.tone = "warning";
    }
  }
}

function setAiCard(state, title, modelText) {
  els.aiCard.dataset.state = state;
  els.aiCardDot.dataset.state = state;
  els.aiCardTitle.textContent = title;
  els.aiCardModel.textContent = modelText;
}

function triggerCapture(mode) {
  const detect = currentTab ? detectPageKind(currentTab) : { kind: "unknown" };
  if (detect.kind !== "normal") {
    const tip = detect.kind === "wechat-mp"
      ? "当前在公众号后台，无法抓正文。请切到普通网页后再试。"
      : "当前页面不支持抓取，请切到普通网页（http/https）后重试。";
    setStatus(tip, "warning");
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
  // 当前标签可抓取性 = detectPageKind 返回 normal
  const canCapture = currentTab && detectPageKind(currentTab).kind === "normal";
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
