/**
 * workspace-router.js
 * ----------------------------------------------------------------
 * 极简 hash 路由 + 工作台首页（dashboard）数据填充。
 *
 * 路由表：
 *   #dashboard  默认首页（数据卡 + 快捷入口 + 最近草稿）
 *   #layout     编辑排版（包住原有 .workspace-layout）
 *   #capture    抓取入口面板
 *   #rewrite    AI 改写说明
 *   #publish    发布说明
 *   #hot        热点（占位，C 阶段填）
 *   #agent      AI 选题代笔（占位，C 阶段填）
 *   #member     会员中心（Phase 3 填）
 *   #settings   特殊路由，触发 openOptionsButton 的点击（打开新标签页）
 *   #help       特殊路由，触发 openHelpButton 的点击（打开新标签页）
 *
 * 不依赖任何框架；使用原生 DOM。
 */

import { getUsageSnapshot } from "../shared/usage-stats.js";
import { subscribeLicenseChanges } from "../shared/license.js";

const VALID_ROUTES = new Set([
  "dashboard",
  "layout",
  "capture",
  "publish",
  "hot",
  "agent",
  "member",
]);

const VIEW_META = {
  dashboard: { title: "工作台", sub: "今天在写什么？" },
  layout: { title: "编辑排版", sub: "草稿包 + 标题 + 正文，AI 改写在工具条" },
  capture: { title: "抓取", sub: "把网页内容拽进编辑台" },
  publish: { title: "推草稿 / 发布", sub: "封面 + 预览 + 推送到公众号" },
  hot: { title: "热点", sub: "今日热榜 + 一键入库" },
  agent: { title: "AI 选题代笔", sub: "多平台自动找选题并起草" },
  member: { title: "会员中心", sub: "套餐 / 到期 / 续费" },
};

/**
 * 解析当前 hash，规范化路由名。
 */
function readRoute() {
  const raw = (location.hash || "").replace(/^#/, "").trim();
  if (!raw) return "dashboard";
  if (VALID_ROUTES.has(raw)) return raw;
  // 兼容外链直接打开
  if (raw === "settings" || raw === "help") return raw;
  return "dashboard";
}

/**
 * 切换显示对应视图，并刷新侧栏 / 顶部标题。
 */
function applyRoute(route) {
  const views = document.querySelectorAll("[data-view]");
  views.forEach((node) => {
    node.dataset.active = node.dataset.view === route ? "true" : "false";
  });

  const navItems = document.querySelectorAll(".ui-nav-item[data-route]");
  navItems.forEach((node) => {
    if (node.dataset.route === route) {
      node.setAttribute("aria-current", "page");
      node.classList.add("is-active");
    } else {
      node.removeAttribute("aria-current");
      node.classList.remove("is-active");
    }
  });

  const meta = VIEW_META[route] || VIEW_META.dashboard;
  const titleEl = document.getElementById("topViewTitle");
  const subEl = document.getElementById("topViewSub");
  if (titleEl) titleEl.textContent = meta.title;
  if (subEl) subEl.textContent = meta.sub;

  // 滚动到顶
  const main = document.querySelector(".ui-shell-content");
  if (main) main.scrollTop = 0;

  // 懒加载嵌入式 iframe（首次进入对应路由时才设 src，避免冷启动卡顿）
  ensureEmbedFrameLoaded(route);
}

/**
 * 当且仅当首次切到 hot / agent 路由时，把 data-src 提升为真正的 src。
 * 之后再切走再切回不会重复加载（保持上一次的状态）。
 */
function ensureEmbedFrameLoaded(route) {
  if (route !== "hot" && route !== "agent") return;
  const frame = document.querySelector(`.workspace-view[data-view="${route}"] iframe.embed-frame`);
  if (!frame) return;
  if (frame.dataset.loaded === "true") return;

  const pending = frame.dataset.src;
  if (!pending) return;

  const loading = document.querySelector(`[data-embed-loading="${route}"]`);
  const finalize = () => {
    frame.dataset.loaded = "true";
    if (loading) loading.dataset.hidden = "true";
  };

  // 用 chrome.runtime.getURL 把相对路径转为扩展内绝对 URL，
  // 避免 workspace.html 所在 src/workspace/ 与 src/pages/ 相对路径错乱
  let url = pending;
  try {
    if (globalThis.chrome?.runtime?.getURL) {
      url = chrome.runtime.getURL(pending);
    }
  } catch {
    // ignore，fall back to raw data-src
  }

  frame.addEventListener("load", finalize, { once: true });
  // 兜底：5s 后无论是否触发 load 都把 loading 隐藏，避免长期遮挡
  setTimeout(finalize, 5000);

  frame.src = url;
  frame.removeAttribute("data-src");
}

/**
 * 处理特殊路由（settings / help）— 触发隐藏按钮的 click，复用 workspace.js 已绑事件。
 * 触发后回到上一个真实路由（避免 URL 卡在 #settings 上）。
 */
function handleSpecialRoute(route, prevRoute) {
  if (route === "settings") {
    const btn = document.getElementById("openOptionsButton");
    if (btn) btn.click();
  } else if (route === "help") {
    const btn = document.getElementById("openHelpButton");
    if (btn) btn.click();
  }
  // 立刻把 hash 改回去，但不触发再一次 hashchange 路由
  const fallback = prevRoute && VALID_ROUTES.has(prevRoute) ? prevRoute : "dashboard";
  history.replaceState(null, "", `#${fallback}`);
  applyRoute(fallback);
}

/**
 * 设置侧栏点击 + 「快捷入口」点击委托。
 */
function bindNavigation() {
  document.addEventListener("click", (event) => {
    const target = event.target.closest("[data-route]");
    if (!target) return;
    const route = target.dataset.route;
    if (!route) return;
    event.preventDefault();
    if (route === "settings" || route === "help") {
      const prev = readRoute();
      handleSpecialRoute(route, prev);
      return;
    }
    if (location.hash !== `#${route}`) {
      location.hash = route;
    } else {
      applyRoute(route); // 已是当前路由，强制刷新
    }
  });

  window.addEventListener("hashchange", () => {
    const route = readRoute();
    if (route === "settings" || route === "help") {
      handleSpecialRoute(route, "dashboard");
      return;
    }
    applyRoute(route);
  });
}

/**
 * dashboard 数据填充：本地草稿数 / 公众号账号数 / AI 改写次数等
 * 仅基于 chrome.storage.local，不联网；不存在的数据降级为 "—"。
 */
async function fillDashboard() {
  if (!globalThis.chrome?.storage?.local) return;

  try {
    const all = await new Promise((resolve) => {
      chrome.storage.local.get(null, (data) => resolve(data || {}));
    });

    // 本地草稿数：以 historyDrafts / drafts 等键为准
    const draftKeys = ["historyDrafts", "drafts", "draftHistory"];
    let draftCount = 0;
    for (const k of draftKeys) {
      const arr = all[k];
      if (Array.isArray(arr)) draftCount = Math.max(draftCount, arr.length);
    }
    const draftEl = document.getElementById("statDraft");
    if (draftEl) {
      draftEl.innerHTML = `${draftCount}<span class="ui-stat-num-unit">篇</span>`;
    }

    // 公众号账号数
    const settings = all.settings || {};
    const profiles = Array.isArray(settings.wechatProfiles) ? settings.wechatProfiles : [];
    const defaultAccountFilled = !!(settings.wechatAppId && settings.wechatAppSecret);
    const accountCount = profiles.length + (defaultAccountFilled ? 1 : 0);
    const accountEl = document.getElementById("statAccount");
    const accountActiveEl = document.getElementById("statAccountActive");
    if (accountEl) {
      accountEl.innerHTML = `${accountCount}<span class="ui-stat-num-unit">个</span>`;
    }
    if (accountActiveEl) {
      if (accountCount === 0) {
        accountActiveEl.textContent = "未配置";
      } else {
        const idx = settings.activeWechatProfileIndex;
        const active =
          typeof idx === "number" && idx >= 0 && profiles[idx]
            ? profiles[idx].name || `账号 ${idx + 1}`
            : "默认账号";
        accountActiveEl.textContent = `当前：${active}`;
      }
    }

    // 本周抓取 / AI 改写次数：使用 usage-stats 真实埋点
    await fillUsageStats();

    // 最近草稿列表
    fillRecentDrafts(all);
  } catch (err) {
    console.warn("[workspace-router] dashboard fill failed", err);
  }
}

/**
 * Phase F：把 usage-stats 数据渲染到顶部 4 张数据卡 + 「今日产能」区。
 */
async function fillUsageStats() {
  let snap;
  try {
    snap = await getUsageSnapshot();
  } catch (err) {
    console.warn("[workspace-router] read usage stats failed", err);
    return;
  }

  // 顶部 4 张卡里复用两张：本周抓取 / 今日 AI 改写
  const captureEl = document.getElementById("statCapture");
  if (captureEl) {
    const n = snap.last7days.capture || 0;
    captureEl.innerHTML = `${n}<span class="ui-stat-num-unit">篇</span>`;
  }
  const rewriteEl = document.getElementById("statRewrite");
  if (rewriteEl) {
    const n = snap.today.rewrite || 0;
    rewriteEl.innerHTML = `${n}<span class="ui-stat-num-unit">次</span>`;
  }

  // 「今日产能」区
  setText("usageTodayCapture", snap.today.capture || 0);
  setText("usageTodayRewrite", snap.today.rewrite || 0);
  setText("usageTodayPublish", snap.today.publish || 0);
  setText("usageTodayAgent", snap.today.agentImport || 0);

  setText("usageWeekCapture", `7 天 ${snap.last7days.capture || 0}`);
  setText("usageWeekRewrite", `7 天 ${snap.last7days.rewrite || 0}`);
  setText("usageWeekPublish", `7 天 ${snap.last7days.publish || 0}`);
  setText("usageWeekAgent", `7 天 ${snap.last7days.agentImport || 0}`);

  const updatedEl = document.getElementById("usageUpdatedAt");
  if (updatedEl) {
    updatedEl.textContent = formatUpdatedAt(snap.updatedAt);
  }

  const peakEl = document.getElementById("usagePeakLine");
  if (peakEl) {
    if (snap.peakDay && snap.peakDay.total > 0) {
      const sum =
        (snap.total.capture || 0) +
        (snap.total.rewrite || 0) +
        (snap.total.publish || 0) +
        (snap.total.agentImport || 0);
      peakEl.textContent = `历史峰值 ${snap.peakDay.date} · ${snap.peakDay.total} 次 · 累计 ${sum} 次`;
      peakEl.hidden = false;
    } else {
      peakEl.textContent = "还没有产能记录，去抓一篇文章试试。";
      peakEl.hidden = false;
    }
  }
}

function setText(id, value) {
  const el = document.getElementById(id);
  if (el) el.textContent = String(value);
}

function formatUpdatedAt(iso) {
  if (!iso) return "";
  try {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return "";
    const diffMin = Math.floor((Date.now() - d.getTime()) / 60000);
    if (diffMin < 1) return "刚刚更新";
    if (diffMin < 60) return `${diffMin} 分钟前更新`;
    const diffHour = Math.floor(diffMin / 60);
    if (diffHour < 24) return `${diffHour} 小时前更新`;
    return d.toLocaleDateString("zh-CN");
  } catch {
    return "";
  }
}

function fillRecentDrafts(all) {
  const list = document.getElementById("dashboardRecentList");
  if (!list) return;
  const drafts =
    all.historyDrafts || all.drafts || all.draftHistory || [];
  const records = Array.isArray(drafts) ? drafts.slice(0, 6) : [];
  if (records.length === 0) return; // 保留默认 empty state

  list.innerHTML = "";
  records.forEach((rec, i) => {
    const li = document.createElement("li");
    li.className = "ui-mini-list-item";
    const title = rec.title || rec.name || `草稿 ${i + 1}`;
    const ts = rec.savedAt || rec.timestamp || rec.updatedAt;
    let timeText = "";
    if (ts) {
      try {
        const d = new Date(ts);
        if (!Number.isNaN(d.getTime())) {
          const now = Date.now();
          const diffMin = Math.floor((now - d.getTime()) / 60000);
          if (diffMin < 1) timeText = "刚刚";
          else if (diffMin < 60) timeText = `${diffMin} 分钟前`;
          else if (diffMin < 60 * 24) timeText = `${Math.floor(diffMin / 60)} 小时前`;
          else timeText = `${Math.floor(diffMin / 60 / 24)} 天前`;
        }
      } catch {
        // ignore date parse error
      }
    }
    li.innerHTML = `
      <span class="ui-mini-list-rank">${i + 1}</span>
      <span class="ui-mini-list-text"></span>
      <span class="ui-mini-list-meta"></span>
    `;
    li.querySelector(".ui-mini-list-text").textContent = title;
    li.querySelector(".ui-mini-list-meta").textContent = timeText;
    li.addEventListener("click", () => {
      // 点击恢复 → 切到编辑排版视图（实际恢复逻辑由 workspace.js 历史抽屉处理）
      location.hash = "layout";
      const historyBtn = document.getElementById("historyButton");
      if (historyBtn) historyBtn.click();
    });
    list.appendChild(li);
  });
}

/**
 * 顶部状态栏：会员徽章 / AI 状态。
 * 这部分由 license / settings 监听补充；这里只做初始读取。
 */
async function syncTopStatus() {
  if (!globalThis.chrome?.storage?.local) return;
  try {
    const data = await new Promise((resolve) => {
      chrome.storage.local.get(["licenseRecord", "settings"], (d) => resolve(d || {}));
    });
    const pill = document.getElementById("topMemberPill");
    const label = document.getElementById("topMemberLabel");
    const navBadge = document.getElementById("navMemberBadge");
    if (pill && label) {
      const rec = data.licenseRecord;
      if (rec && rec.plan === "pro") {
        pill.dataset.status = "pro";
        label.textContent = "PRO";
        if (navBadge) {
          navBadge.hidden = false;
          navBadge.textContent = "PRO";
        }
      } else if (rec && rec.status === "expired") {
        pill.dataset.status = "expired";
        label.textContent = "已到期";
      } else {
        pill.dataset.status = "free";
        label.textContent = "免费版";
      }
    }

    const aiPill = document.getElementById("topAiStatus");
    if (aiPill) {
      const settings = data.settings || {};
      const hasApiKey = !!(settings.openaiApiKey || settings.aiApiKey || settings.apiKey);
      const model = settings.openaiModel || settings.aiModel || settings.model || "gpt";
      if (hasApiKey) {
        aiPill.dataset.tone = "success";
        aiPill.textContent = `AI · ${model}`;
      } else {
        aiPill.dataset.tone = "warning";
        aiPill.textContent = "AI · 未配置";
      }
    }

    // 会员中心入口点击 → 也让顶部 pill 可点
    if (pill && !pill.dataset.bound) {
      pill.addEventListener("click", () => {
        location.hash = "member";
      });
      pill.dataset.bound = "1";
    }
  } catch (err) {
    console.warn("[workspace-router] sync top status failed", err);
  }
}

/**
 * 抓取入口（capture 视图里的 3 个按钮）— 直接复用 popup 的抓取流程：
 * 通过 background 发消息让用户当前 active tab 走对应抓取分支。
 */
function bindCaptureShortcuts() {
  const map = [
    ["captureSelection2", "selection"],
    ["captureReadable2", "readable"],
    ["captureRaw2", "raw"],
  ];
  map.forEach(([id, mode]) => {
    const btn = document.getElementById(id);
    if (!btn) return;
    btn.addEventListener("click", () => {
      // 复用顶部主"抓取最近浏览页"按钮 — 它已经绑了对应消息
      const main = document.getElementById("captureButton");
      if (main) {
        // 临时把 mode 写到 dataset，由 workspace-capture.js 读
        main.dataset.captureMode = mode;
        main.click();
      }
    });
  });

  const quickCapture = document.getElementById("quickCaptureCurrent");
  if (quickCapture) {
    quickCapture.addEventListener("click", () => {
      const main = document.getElementById("captureButton");
      if (main) main.click();
    });
  }
}

/**
 * 「在新页打开」按钮：把对应独立页打开到新标签页。
 * hot 已由 workspace.js 绑定 (openHotTopicsPage)，这里只补 agent。
 */
function bindEmbedOpenButtons() {
  const agentBtn = document.getElementById("openAgentButton");
  if (agentBtn && !agentBtn.dataset.bound) {
    agentBtn.addEventListener("click", () => {
      try {
        if (globalThis.chrome?.tabs?.create && globalThis.chrome?.runtime?.getURL) {
          chrome.tabs.create({ url: chrome.runtime.getURL("src/pages/agent.html") });
        } else {
          window.open("../pages/agent.html", "_blank");
        }
      } catch (err) {
        console.warn("[workspace-router] open agent failed", err);
      }
    });
    agentBtn.dataset.bound = "1";
  }
}

/**
 * 初始化路由。需在 workspace.js 主流程加载完后调用。
 */
export function initWorkspaceRouter() {
  bindNavigation();
  bindCaptureShortcuts();
  bindEmbedOpenButtons();
  fillDashboard();
  syncTopStatus();
  applyRoute(readRoute());

  // license / auth 变化时实时刷新顶部 license badge（统一通过 license.js 订阅）
  subscribeLicenseChanges(() => {
    syncTopStatus();
    fillDashboard();
  });

  // settings / 草稿 / 计数器 等其它变化继续走 storage.onChanged
  if (globalThis.chrome?.storage?.onChanged) {
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== "local") return;
      if (changes.settings) {
        syncTopStatus();
      }
      if (
        changes.historyDrafts ||
        changes.drafts ||
        changes.dashboardCounters ||
        changes.usageStats ||
        changes.settings
      ) {
        fillDashboard();
      }
    });
  }
}
