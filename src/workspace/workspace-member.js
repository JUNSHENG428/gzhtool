/**
 * workspace-member.js
 * ----------------------------------------------------------------
 * #member 路由的实现：会员中心摘要页。
 *
 * 设计取舍：
 *   - 真实「登录 / 注册 / 绑定 License Key / 解绑设备」操作仍由 options 页负责，
 *     workspace 只做：当前状态总览 + 解锁清单 + 跳转入口。
 *   - 这样避免在两个页面重复实现一遍 license UI；用户在一个地方做事。
 *
 * 依赖：
 *   - license.js   getLicenseState / getAuthRecord / getDeviceFingerprint /
 *                   verifyLicenseRemote / PAID_FEATURES / subscribeLicenseChanges
 *   - usage-stats  getUsageSnapshot（取今日 rewrite 次数）
 *
 * 不联网；所有"主要 CTA"按钮跳官网定价或扩展 options 页。
 */

import {
  getLicenseState,
  getAuthRecord,
  getDeviceFingerprint,
  verifyLicenseRemote,
  PAID_FEATURES,
  subscribeLicenseChanges,
  LICENSE_CONSTANTS,
  getLicenseSummaryText,
  isPaidPlan
} from "../shared/license.js";
import { getUsageSnapshot } from "../shared/usage-stats.js";

const FREE_DAILY_REWRITE_QUOTA =
  LICENSE_CONSTANTS?.FREE_DAILY_REWRITE_QUOTA || 5;
const FREE_MULTI_ACCOUNT_LIMIT =
  LICENSE_CONSTANTS?.FREE_MULTI_ACCOUNT_LIMIT || 2;

const FALLBACK_PRICING_URL = "https://docuearn.com/pricing";
const FALLBACK_HELP_URL = "https://docuearn.com";

// 内部状态：避免短时间重复触发刷新（防抖）
let _refreshing = false;
let _lastRender = 0;

// =============================================================
// 入口
// =============================================================

export function initWorkspaceMember() {
  // 首次绘制 + 后续订阅
  void renderMember();

  bindButtons();

  // license / auth 任意一处变化都重绘
  try {
    subscribeLicenseChanges(() => void renderMember());
  } catch (err) {
    console.warn("[member] subscribeLicenseChanges failed", err);
  }

  // 切到 #member 路由时强制刷新一次（用户可能在 options 改了状态）
  window.addEventListener("hashchange", () => {
    if ((location.hash || "").replace(/^#/, "") === "member") {
      void renderMember();
    }
  });

  // usage / settings 变化也重绘配额条
  if (globalThis.chrome?.storage?.onChanged) {
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== "local") return;
      if (
        changes.usageStats ||
        changes.settings ||
        changes.wechatWriterLicense ||
        changes.wechatWriterLicenseAuth
      ) {
        void renderMember();
      }
    });
  }
}

// =============================================================
// 主渲染
// =============================================================

async function renderMember() {
  // 防抖：100ms 内的多次调用合并
  const now = Date.now();
  if (now - _lastRender < 80) return;
  _lastRender = now;

  let state;
  let auth;
  let device;
  let usage;
  let accountInfo;

  try {
    [state, auth, device, usage, accountInfo] = await Promise.all([
      getLicenseState({ refresh: false }).catch(() => null),
      getAuthRecord().catch(() => null),
      getDeviceFingerprint().catch(() => null),
      getUsageSnapshot().catch(() => null),
      readAccountInfo().catch(() => ({ count: 0, capLabel: "—" }))
    ]);
  } catch (err) {
    console.warn("[member] render failed", err);
    return;
  }

  renderHero(state, auth, device, usage);
  renderQuotaRewrite(state, usage);
  renderQuotaAccount(state, accountInfo);
  renderFeatureList(state);
  renderActionButtons(state);
}

// =============================================================
// 顶部状态卡
// =============================================================

function renderHero(state, auth, device, usage) {
  const root = document.getElementById("memberHeroSection");
  if (!root) return;

  // P0：统一会员状态文案 — popup/workspace pill/member hero/options 现在都走 getLicenseSummaryText。
  // 旧的 pickHeroStatus 留作 fallback（state 异常/字段缺失时仍能渲染）。
  let status;
  try {
    const todayRewrite = Number(usage?.today?.rewrite) || 0;
    const summary = getLicenseSummaryText(state, {
      auth,
      usage: { today: { rewrite: todayRewrite } }
    });
    status = {
      tone: summary.tone === "pro" ? "pro"
        : summary.tone === "expiring" ? "expiring"
        : summary.tone === "expired" || summary.tone === "invalid" ? "expired"
        : summary.tone === "stale" ? "stale"
        : summary.tone === "free" ? "free"
        : summary.tone === "guest" ? "guest"
        : "loading",
      label: summary.label,
      hint: summary.sub
    };
  } catch (err) {
    console.warn("[member] getLicenseSummaryText failed, fallback", err);
    status = pickHeroStatus(state, auth);
  }
  root.dataset.status = status.tone;

  setText("memberHeroLabel", status.label);
  setText("memberHeroHint", status.hint);

  // tags
  const email =
    auth?.user?.email ||
    state?.user?.email ||
    "";
  toggleTag("memberHeroEmail", email ? `账号 · ${email}` : "");

  toggleTag(
    "memberHeroExpire",
    state?.expiresAt && Number(state.expiresAt) > 0
      ? `${isPaidPlan(state.plan) ? "会员有效至" : "到期"} · ${formatDate(state.expiresAt)}`
      : isPaidPlan(state?.plan)
        ? "会员（按订阅周期续费）"
        : ""
  );

  toggleTag(
    "memberHeroKey",
    state?.displayKey ? `会员编号 · ${state.displayKey}` : ""
  );

  toggleTag(
    "memberHeroDevice",
    device?.label ? `本机 · ${device.label}` : ""
  );
}

function pickHeroStatus(state, auth) {
  if (!state) {
    return {
      tone: "loading",
      label: "正在读取会员状态…",
      hint: "请稍候，从本地缓存读取"
    };
  }
  if (state.status === "pro") {
    return {
      tone: "pro",
      label: "Pro 会员",
      hint: state.hint || "感谢支持，所有 Pro 功能已解锁"
    };
  }
  if (state.status === "expiring") {
    const days = Number(state.daysLeft) || 1;
    return {
      tone: "expiring",
      label: `Pro 还剩 ${days} 天到期`,
      hint:
        state.hint ||
        `建议提前续费，避免到期当天 Pro 功能突然停用；可随时续 1 个月或 1 年。`
    };
  }
  if (state.status === "expired") {
    return {
      tone: "expired",
      label: "Pro 已到期",
      hint: state.hint || "续费后即可继续使用 Pro 功能"
    };
  }
  if (state.status === "stale") {
    return {
      tone: "stale",
      label: "需要重新验证",
      hint: state.hint || "已超过 7 天未联网核验，请点「向服务器复验」"
    };
  }
  if (state.status === "invalid") {
    return {
      tone: "expired",
      label: "授权异常",
      hint: state.hint || "会员权益已被服务端冻结，请联系客服处理"
    };
  }
  if (auth?.user?.email) {
    return {
      tone: "free",
      label: "免费版（已登录）",
      hint: "此账号尚未开通 Pro 会员；开通后可立即解锁全部能力"
    };
  }
  return {
    tone: "guest",
    label: "免费版",
    hint: "未登录账号，所有基础功能依然可用；登录后可跨设备同步会员权益"
  };
}

// =============================================================
// 今日 AI 改写额度
// =============================================================

function renderQuotaRewrite(state, usage) {
  const used = Number(usage?.today?.rewrite) || 0;

  let cap;
  let capLabel;
  let pct;
  let hint;

  if (state?.dailyQuota === -1) {
    cap = -1;
    capLabel = "无限";
    pct = Math.min(100, used > 0 ? 12 + Math.min(used, 50) : 0);
    hint = `今日已使用 ${used} 次，会员不限次数`;
  } else {
    cap = Number(state?.dailyQuota);
    if (!Number.isFinite(cap) || cap <= 0) cap = FREE_DAILY_REWRITE_QUOTA;
    pct = Math.min(100, Math.round((used / cap) * 100));
    const remain = Math.max(0, cap - used);
    hint =
      remain > 0
        ? `今日剩余 ${remain} 次（明天 0 点重置）`
        : `今日额度已用完，明天 0 点重置；或升级 Pro 解除限制`;
  }

  setText("memberQuotaRewriteUsed", String(used));
  setText("memberQuotaRewriteCap", cap === -1 ? " / ∞" : ` / ${cap}`);
  setText("memberQuotaRewriteHint", hint);

  const bar = document.getElementById("memberQuotaRewriteBar");
  if (bar) {
    bar.style.width = `${pct}%`;
    bar.dataset.tone =
      cap === -1 ? "pro" : pct >= 100 ? "danger" : pct >= 75 ? "warning" : "normal";
  }
  // 整个 card 的语义色
  const card = document.getElementById("memberQuotaRewrite");
  if (card) card.dataset.tone = cap === -1 ? "pro" : pct >= 100 ? "danger" : "normal";
}

// =============================================================
// 公众号账号绑定
// =============================================================

async function readAccountInfo() {
  if (!globalThis.chrome?.storage?.local) {
    return { count: 0, defaultFilled: false };
  }
  const data = await new Promise((resolve) => {
    chrome.storage.local.get(["settings"], (d) => resolve(d || {}));
  });
  const settings = data.settings || {};
  const profiles = Array.isArray(settings.wechatProfiles) ? settings.wechatProfiles : [];
  const defaultFilled = !!(settings.wechatAppId && settings.wechatAppSecret);
  return {
    count: profiles.length + (defaultFilled ? 1 : 0),
    defaultFilled
  };
}

function renderQuotaAccount(state, accountInfo) {
  const used = Number(accountInfo?.count) || 0;
  const isPro = isPaidPlan(state?.plan);

  let cap;
  let capLabel;
  let pct;
  let hint;

  if (isPro) {
    cap = -1;
    capLabel = " / ∞";
    pct = Math.min(100, used * 8);
    hint =
      used === 0
        ? "Pro 会员支持无限公众号绑定，去「设置」绑定第一个公众号"
        : `已绑定 ${used} 个，Pro 会员无上限`;
  } else {
    cap = FREE_MULTI_ACCOUNT_LIMIT;
    capLabel = ` / ${cap}`;
    pct = Math.min(100, Math.round((used / cap) * 100));
    if (used === 0) {
      hint = `免费版可绑定 ${cap} 个公众号；当前 0 个，去「设置」开始`;
    } else if (used >= cap) {
      hint = `免费版上限 ${cap} 个已满；开通 Pro 会员解锁多公众号矩阵`;
    } else {
      hint = `免费版还可再绑 ${cap - used} 个；升级 Pro 后无限`;
    }
  }

  setText("memberQuotaAccountUsed", String(used));
  setText("memberQuotaAccountCap", capLabel);
  setText("memberQuotaAccountHint", hint);

  const bar = document.getElementById("memberQuotaAccountBar");
  if (bar) {
    bar.style.width = `${pct}%`;
    bar.dataset.tone =
      isPro ? "pro" : pct >= 100 ? "danger" : pct >= 75 ? "warning" : "normal";
  }
  const card = document.getElementById("memberQuotaAccount");
  if (card) card.dataset.tone = isPro ? "pro" : pct >= 100 ? "danger" : "normal";
}

// =============================================================
// 付费功能解锁清单
// =============================================================

function renderFeatureList(state) {
  const list = document.getElementById("memberFeatureList");
  if (!list) return;

  const isPro = isPaidPlan(state?.plan);
  const features = state?.features || {};

  // 排序规则：先解锁的，再 Pro 限定的；同组内固定按 PAID_FEATURES 顺序
  const entries = Object.entries(PAID_FEATURES);
  const unlocked = [];
  const locked = [];
  entries.forEach(([key, meta]) => {
    const enabled =
      meta.tier === "free" ? true : !!(isPro && features[key] !== false);
    (enabled ? unlocked : locked).push({ key, meta, enabled });
  });

  list.innerHTML = "";
  [...unlocked, ...locked].forEach(({ key, meta, enabled }) => {
    const li = document.createElement("li");
    li.className = "member-feature-item";
    li.dataset.tier = meta.tier;
    li.dataset.enabled = enabled ? "true" : "false";

    const icon = document.createElement("span");
    icon.className = "member-feature-icon";
    icon.setAttribute("aria-hidden", "true");
    icon.innerHTML = enabled
      ? '<svg viewBox="0 0 24 24" width="14" height="14"><path fill="currentColor" d="M9 16.2 4.8 12l-1.4 1.4L9 19 21 7l-1.4-1.4Z"/></svg>'
      : '<svg viewBox="0 0 24 24" width="14" height="14"><path fill="currentColor" d="M12 17a1.5 1.5 0 0 1-1.5-1.5v-3a1.5 1.5 0 0 1 3 0v3A1.5 1.5 0 0 1 12 17Zm5-7v-2a5 5 0 0 0-10 0v2H5v11h14V10Zm-2 0H9V8a3 3 0 0 1 6 0Z"/></svg>';

    const body = document.createElement("div");
    body.className = "member-feature-body";

    const head = document.createElement("div");
    head.className = "member-feature-head";

    const name = document.createElement("strong");
    name.className = "member-feature-name";
    name.textContent = meta.name;

    const tier = document.createElement("span");
    tier.className = "member-feature-tier";
    tier.dataset.tier = meta.tier;
    tier.textContent = meta.tier === "pro" ? "Pro" : "免费";

    head.append(name, tier);

    const hint = document.createElement("p");
    hint.className = "member-feature-hint";
    hint.textContent = meta.hint || "";

    body.append(head, hint);
    li.append(icon, body);
    list.appendChild(li);
  });
}

// =============================================================
// 顶部 / 操作按钮 文案与跳转
// =============================================================

function renderActionButtons(state) {
  const isPro = isPaidPlan(state?.plan);
  const expiring = state?.status === "expiring";
  const expired = state?.status === "expired" || state?.status === "invalid";
  const stale = state?.status === "stale";

  let primary;
  let secondary;

  if (expiring) {
    // 临近到期：把"续费"提到主按钮位置，避免用户误以为还远；
    // 仍走 pricing 而不是 settings，方便直接走支付。
    primary = { label: "立即续费 Pro", action: "pricing" };
    secondary = { label: "管理会员 / 设备", action: "settings" };
  } else if (isPro) {
    primary = { label: "管理会员 / 续费", action: "settings" };
    secondary = { label: "查看 Pro 会员", action: "pricing" };
  } else if (expired) {
    primary = { label: "立即续费 Pro", action: "pricing" };
    secondary = { label: "去设置查看会员状态", action: "settings" };
  } else if (stale) {
    primary = { label: "向服务器复验", action: "refresh" };
    secondary = { label: "去设置查看会员状态", action: "settings" };
  } else {
    primary = { label: "开通 Pro 会员", action: "pricing" };
    secondary = { label: "登录账号 / 同步会员", action: "settings" };
  }

  const primaryBtn = document.getElementById("memberPrimaryBtn");
  const secondaryBtn = document.getElementById("memberSecondaryBtn");
  if (primaryBtn) {
    primaryBtn.dataset.action = primary.action;
    setText("memberPrimaryBtnLabel", primary.label);
  }
  if (secondaryBtn) {
    secondaryBtn.dataset.action = secondary.action;
    setText("memberSecondaryBtnLabel", secondary.label);
  }

  // pricing 链接保持最新
  const pricingHref = pickPricingUrl();
  const pricingLink = document.getElementById("memberPricingLink");
  if (pricingLink) pricingLink.href = pricingHref;
  const pricingTile = document.getElementById("memberOpenPricingBtn");
  if (pricingTile) pricingTile.href = pricingHref;
  const helpTile = document.getElementById("memberOpenHelpBtn");
  if (helpTile) helpTile.href = pickHelpUrl();
}

// =============================================================
// 事件绑定（一次性）
// =============================================================

function bindButtons() {
  const primaryBtn = document.getElementById("memberPrimaryBtn");
  const secondaryBtn = document.getElementById("memberSecondaryBtn");
  const settingsTile = document.getElementById("memberOpenSettingsBtn");
  const refreshTile = document.getElementById("memberRefreshBtn");

  primaryBtn?.addEventListener("click", () => handleAction(primaryBtn.dataset.action));
  secondaryBtn?.addEventListener("click", () => handleAction(secondaryBtn.dataset.action));
  settingsTile?.addEventListener("click", () => openOptionsLicense());
  refreshTile?.addEventListener("click", () => triggerRefresh());
}

function handleAction(action) {
  if (action === "pricing") {
    openExternal(pickPricingUrl());
  } else if (action === "refresh") {
    void triggerRefresh();
  } else {
    openOptionsLicense();
  }
}

function openOptionsLicense() {
  // 打开 options 页并锚到会员激活区
  const path = "src/options/options.html#licenseSection";
  try {
    if (globalThis.chrome?.runtime?.getURL && globalThis.chrome?.tabs?.create) {
      chrome.tabs.create({ url: chrome.runtime.getURL(path) });
      return;
    }
  } catch (err) {
    console.warn("[member] open options failed", err);
  }
  // 兜底：尝试用 openOptionsPage（没法带 hash，但保证能打开）
  try {
    chrome.runtime.openOptionsPage();
  } catch (err) {
    console.warn("[member] openOptionsPage failed", err);
  }
}

function openExternal(url) {
  try {
    if (globalThis.chrome?.tabs?.create) {
      chrome.tabs.create({ url });
      return;
    }
  } catch {
    // ignore
  }
  window.open(url, "_blank", "noopener");
}

async function triggerRefresh() {
  if (_refreshing) return;
  _refreshing = true;
  showFeedback("正在向服务器复验当前会员权益…", "muted");

  try {
    const state = await getLicenseState({ refresh: false });
    if (!state?.key) {
      // 没绑定 key 的话，复验也没意义；引导到设置
      showFeedback("当前账号尚未开通 Pro 会员；请先开通后再复验。", "warning");
      return;
    }
    const result = await verifyLicenseRemote(state.key, { silent: true });
    if (result?.ok || result?.status === "active") {
      showFeedback("已重新核验通过 ✓", "success");
    } else {
      const msg = result?.message || result?.reason || "服务器返回未通过";
      showFeedback(`复验未通过：${msg}`, "warning");
    }
    await renderMember();
  } catch (err) {
    showFeedback(`复验失败：${err?.message || err}`, "warning");
  } finally {
    _refreshing = false;
  }
}

// =============================================================
// 通用工具
// =============================================================

function setText(id, value) {
  const el = document.getElementById(id);
  if (el) el.textContent = value == null ? "" : String(value);
}

function toggleTag(id, value) {
  const el = document.getElementById(id);
  if (!el) return;
  if (value) {
    el.textContent = value;
    el.hidden = false;
  } else {
    el.textContent = "";
    el.hidden = true;
  }
}

function formatDate(ts) {
  const n = Number(ts);
  if (!Number.isFinite(n) || n <= 0) return "";
  try {
    const d = new Date(n);
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, "0");
    const day = String(d.getDate()).padStart(2, "0");
    return `${y}-${m}-${day}`;
  } catch {
    return "";
  }
}

function pickPricingUrl() {
  try {
    if (typeof window !== "undefined" && window.__pricingUrl) {
      return String(window.__pricingUrl);
    }
  } catch {
    // ignore
  }
  return FALLBACK_PRICING_URL;
}

function pickHelpUrl() {
  try {
    if (typeof window !== "undefined" && window.__helpUrl) {
      return String(window.__helpUrl);
    }
  } catch {
    // ignore
  }
  return FALLBACK_HELP_URL;
}

function showFeedback(text, tone = "muted") {
  const el = document.getElementById("memberRefreshFeedback");
  if (!el) return;
  el.textContent = text;
  el.dataset.tone = tone;
  el.hidden = false;
  // 4s 后自动淡出（成功 / 失败提示都不需要常驻）
  clearTimeout(el._t);
  el._t = setTimeout(() => {
    el.hidden = true;
  }, tone === "success" ? 3000 : 6000);
}
