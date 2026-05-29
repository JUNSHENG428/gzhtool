/**
 * dashboard.js — 控制台主逻辑。
 * --------------------------------------------------------------
 * 数据来自 /api/me（worker.js）：
 * {
 *   ok: true,
 *   user: { id, email, created_at, last_login_at },
 *   license: {
 *     plan: "free" | "pro",
 *     activeKey, expiresAt,
 *     keys: [{
 *       key, plan, status, expires_at, created_at,
 *       devices: [{ id, fingerprint, label, activated_at, last_seen_at }]
 *     }]
 *   }
 * }
 *
 * 新增能力（B 阶段）：
 *   - 每张 license 下展示设备列表 + 单独解绑设备
 *   - 修改密码弹窗
 *   - 付款回流 toast（?from=checkout&result=success）
 */
import { auth, license, getToken, clearToken, setToken, api } from "./api.js";

const els = {
  greeting: document.getElementById("dashGreeting"),
  sub: document.getElementById("dashSub"),
  email: document.getElementById("accountEmail"),
  created: document.getElementById("accountCreated"),
  plan: document.getElementById("accountPlan"),
  planPill: document.getElementById("accountPlanPill"),
  expires: document.getElementById("accountExpires"),
  logoutBtn: document.getElementById("logoutBtn"),
  changePwBtn: document.getElementById("changePwBtn"),
  list: document.getElementById("licenseList"),
  toastHost: document.getElementById("toastHost"),
  changePwModal: document.getElementById("changePwModal"),
  changePwForm: document.getElementById("changePwForm"),
  changePwSubmit: document.getElementById("changePwSubmit"),
  changePwFeedback: document.getElementById("changePwFeedback"),
  pluginPwCard: document.getElementById("pluginPwCard"),
  setPwBtn: document.getElementById("setPwBtn"),
  setPwModal: document.getElementById("setPwModal"),
  setPwForm: document.getElementById("setPwForm"),
  setPwSubmit: document.getElementById("setPwSubmit"),
  setPwFeedback: document.getElementById("setPwFeedback"),
  // 39th session · 平台 LLM 月度用量卡
  aiUsageBody: document.getElementById("aiUsageBody"),
  aiUsageRefreshBtn: document.getElementById("aiUsageRefreshBtn")
};

document.addEventListener("DOMContentLoaded", () => {
  if (!getToken()) {
    location.href = "./login";
    return;
  }
  void hydrate();
  bindGlobalActions();
  bindChangePassword();
  bindSetPassword();
  handleCheckoutReturn();
});

function bindGlobalActions() {
  els.logoutBtn?.addEventListener("click", () => {
    clearToken();
    location.href = "./login";
  });
  els.changePwBtn?.addEventListener("click", () => openModal(els.changePwModal));
  els.setPwBtn?.addEventListener("click", () => {
    setSetPwFeedback("");
    if (els.setPwForm) els.setPwForm.reset();
    openModal(els.setPwModal);
  });
  // 39th session · AI 用量手动刷新按钮
  els.aiUsageRefreshBtn?.addEventListener("click", () => {
    loadAiUsage().catch((err) => console.warn("[dashboard] refresh ai usage failed", err));
  });

  // 所有 [data-modal-close] 关闭最近的 modal-backdrop
  document.querySelectorAll("[data-modal-close]").forEach((el) => {
    el.addEventListener("click", () => {
      const modal = el.closest(".modal-backdrop");
      if (modal) closeModal(modal);
    });
  });

  // 点 backdrop（不是 modal 本体）也关闭
  document.querySelectorAll(".modal-backdrop").forEach((bk) => {
    bk.addEventListener("click", (e) => {
      if (e.target === bk) closeModal(bk);
    });
  });

  // ESC 关闭
  document.addEventListener("keydown", (e) => {
    if (e.key !== "Escape") return;
    document.querySelectorAll(".modal-backdrop:not([hidden])").forEach((m) => closeModal(m));
  });
}

/**
 * 付款回流：用户从第三方支付平台付完款回到 dashboard
 * URL 形如 /dashboard.html?from=checkout&result=success&order=xxx
 *   - 前端立刻 hydrate 一次（如果 webhook 抢在前面到了，直接显示已开通）
 *   - 没到的话顶部挂一个 syncing 徽标 + 每 3s 轮询 /api/me，最多 60s
 *   - plan === "pro" 时停止轮询，撤掉徽标，弹"已开通"toast
 *   - 60s 还没到账时撤徽标 + 改提示，让用户手动刷新
 *   - 不论哪种结局都把 ?from=checkout 清掉，避免刷新二次触发
 */
const SYNC_TIMEOUT_MS = 60 * 1000;
const SYNC_INTERVAL_MS = 3000;
let syncPollTimer = null;
let syncStartedAt = 0;

async function handleCheckoutReturn() {
  const params = new URLSearchParams(location.search);
  if (params.get("from") !== "checkout") return;
  const result = params.get("result");

  if (history.replaceState) {
    history.replaceState({}, "", location.pathname);
  }

  if (result === "cancel") {
    showToast("已取消支付，可以随时回来继续。", "warning");
    return;
  }
  if (result !== "success") return;

  showToast("支付完成 ✓ 正在为账号开通 Pro 权益…", "success", 4000);

  // 给 hydrate() 一次机会先把数据拉回来；如果 webhook 抢在前面，直接收尾。
  try {
    const data = await auth.me();
    renderAccount(data);
    renderLicenseList(data?.license);
    if ((data?.license?.plan || "free") === "pro") {
      showToast("Pro 会员已开通 ✓", "success", 3500);
      return;
    }
  } catch {
    // 拉数据失败也无妨，下面照样起轮询
  }

  showSyncIndicator("正在同步会员权益（最多约 30 秒）…");
  startMembershipPolling();
}

function startMembershipPolling() {
  if (syncPollTimer) return;
  syncStartedAt = Date.now();

  // 注：DOMContentLoaded 里已经 hydrate() 过一次（webhook 抢在前面就直接显示已开通）。
  // 这里只起定时器，避免和 hydrate() 同帧并发拉两次 /api/me。
  syncPollTimer = setInterval(() => {
    if (Date.now() - syncStartedAt > SYNC_TIMEOUT_MS) {
      stopMembershipPolling();
      hideSyncIndicator();
      showToast(
        "权益还在路上，可手动刷新查看；如几分钟后仍未开通请联系 support@docuearn.com。",
        "warning",
        6000
      );
      return;
    }
    void tickMembership();
  }, SYNC_INTERVAL_MS);
}

async function tickMembership() {
  try {
    const data = await auth.me();
    renderAccount(data);
    renderLicenseList(data?.license);
    // 39th 续 · 任何付费档位（pro / yearly / monthly）都视为开通成功
    const p = data?.license?.plan || "free";
    if (p === "pro" || p === "yearly" || p === "monthly") {
      stopMembershipPolling();
      hideSyncIndicator();
      const label = p === "yearly" ? "Pro 年付" : p === "monthly" ? "Pro 月付" : "Pro 会员";
      showToast(`${label}已开通 ✓`, "success", 4000);
    }
  } catch (error) {
    if (error?.status === 401) {
      stopMembershipPolling();
    }
    // 其它错误：等下一轮再试
  }
}

function stopMembershipPolling() {
  if (syncPollTimer) {
    clearInterval(syncPollTimer);
    syncPollTimer = null;
  }
}

function showSyncIndicator(text) {
  let el = document.getElementById("checkoutSyncBadge");
  if (!el) {
    el = document.createElement("div");
    el.id = "checkoutSyncBadge";
    el.className = "checkout-sync-badge";
    ensureSyncBadgeStyles();
    const sub = els.sub;
    if (sub?.parentNode) {
      sub.parentNode.insertBefore(el, sub.nextSibling);
    } else {
      document.querySelector(".dash-shell .wrap")?.prepend(el);
    }
  }
  el.innerHTML = `
    <span class="checkout-sync-badge__dot"></span>
    <span class="checkout-sync-badge__text"></span>
    <button type="button" class="checkout-sync-badge__refresh">立即刷新</button>
  `;
  el.querySelector(".checkout-sync-badge__text").textContent = text;
  el
    .querySelector(".checkout-sync-badge__refresh")
    .addEventListener("click", () => location.reload());
}

function hideSyncIndicator() {
  document.getElementById("checkoutSyncBadge")?.remove();
}

function ensureSyncBadgeStyles() {
  if (document.getElementById("checkout-sync-badge-style")) return;
  const css = `
    .checkout-sync-badge{display:inline-flex;align-items:center;gap:10px;
      margin:14px auto 0;padding:8px 14px;border-radius:999px;
      background:#fffbeb;border:1px solid #fde68a;color:#92400e;
      font-size:0.86rem;line-height:1;}
    .checkout-sync-badge__dot{width:8px;height:8px;border-radius:50%;
      background:#f59e0b;animation:cs-pulse 1.2s ease-in-out infinite;}
    @keyframes cs-pulse{0%,100%{opacity:.45;}50%{opacity:1;}}
    .checkout-sync-badge__refresh{border:none;background:transparent;
      color:#b45309;cursor:pointer;font-size:0.86rem;font-family:inherit;
      padding:0 0 0 6px;border-left:1px solid rgba(180,83,9,.3);font-weight:500;}
    .checkout-sync-badge__refresh:hover{color:#92400e;}
  `;
  const style = document.createElement("style");
  style.id = "checkout-sync-badge-style";
  style.textContent = css;
  document.head.appendChild(style);
}

async function hydrate() {
  try {
    const data = await auth.me();
    renderAccount(data);
    renderLicenseList(data?.license);
  } catch (error) {
    if (error?.status !== 401) {
      els.list.innerHTML = `<div class="empty-state">加载失败：${escapeHtml(error?.message || "未知错误")}</div>`;
    }
  }
  // 39th session · 平台 LLM 月度用量（独立 fetch，不阻塞会员摘要 hydrate）
  loadAiUsage().catch((err) => console.warn("[dashboard] loadAiUsage failed", err));
}

/**
 * 39th session · 平台 LLM 代理月度用量卡渲染。
 *
 * 状态机：
 *   - 加载中     → "加载用量中…" muted 占位
 *   - 401        → api.js 拦截器已自动跳 login（这里不会到达）
 *   - 网络/其他错 → 「加载失败：xx · [重试]」
 *   - 200 ok     → 渲染进度条 + 元信息（plan / 剩余 / 调用次数 / 重置天数）+ 教育性 hint
 *
 * 数据复用 worker /api/llm/usage 与 popup / options 端用的同一个端点；
 * 用户切到平台模式后此数据会随每次调用增长，不切平台模式或没调用过则全为 0。
 */
async function loadAiUsage() {
  if (!els.aiUsageBody) return;
  els.aiUsageBody.innerHTML = `<p class="muted">加载用量中…</p>`;

  let payload;
  try {
    payload = await api("/api/llm/usage", { auth: true });
  } catch (err) {
    if (err?.status === 401) return; // api.js 拦截器已跳 login
    els.aiUsageBody.innerHTML = `
      <p class="muted">加载失败：${escapeHtml(err?.message || "未知错误")}</p>
      <button class="btn btn-ghost" type="button" id="aiUsageRetryInline">重试</button>
    `;
    document.getElementById("aiUsageRetryInline")?.addEventListener("click", loadAiUsage);
    return;
  }
  if (!payload?.ok) {
    els.aiUsageBody.innerHTML = `<p class="muted">${escapeHtml(payload?.error || "未知错误")}</p>`;
    return;
  }

  const { plan, used, limit, remaining, resets_at, quota_exceeded, yyyymm } = payload;
  const isTokenPlan = limit && limit.tokens != null;
  const usedNum = isTokenPlan ? Number(used?.total_tokens || 0) : Number(used?.call_count || 0);
  const limitNum = Number(isTokenPlan ? limit.tokens : limit?.calls || 0);
  const remainNum = Number(isTokenPlan ? remaining?.tokens || 0 : remaining?.calls || 0);
  const pct = limitNum > 0 ? Math.min(100, (usedNum / limitNum) * 100) : 0;
  const fillClass = quota_exceeded ? "is-danger" : pct >= 80 ? "is-warning" : "";
  const planLabel = { free: "免费版", monthly: "月费会员", yearly: "年费会员" }[plan] || plan || "—";
  const unit = isTokenPlan ? "token" : "次";
  const resetDate = resets_at ? new Date(resets_at) : null;
  const days =
    resetDate && !Number.isNaN(resetDate.getTime())
      ? Math.max(0, Math.ceil((resetDate.getTime() - Date.now()) / 86_400_000))
      : null;

  els.aiUsageBody.innerHTML = `
    <div class="ai-usage-row">
      <div>
        <span class="dash-plan-pill ${plan === "yearly" ? "pro" : plan === "monthly" ? "pro" : "free"}">${escapeHtml(planLabel)}</span>
        <span class="muted" style="margin-left:8px;font-size:0.86rem;">${escapeHtml(yyyymm || "")}</span>
      </div>
      <div class="ai-usage-headline">
        <strong>${formatDashUsage(usedNum)}</strong>
        <span class="muted"> / ${formatDashUsage(limitNum)} ${unit}</span>
      </div>
    </div>
    <div class="ai-usage-bar">
      <div class="ai-usage-bar-fill ${fillClass}" style="width:${pct.toFixed(1)}%"></div>
    </div>
    <div class="ai-usage-meta">
      <span>剩余 <strong>${formatDashUsage(remainNum)}</strong> ${unit}</span>
      ${used?.call_count != null ? `<span>本月调用 ${used.call_count} 次</span>` : ""}
      ${days != null ? `<span>${days} 天后重置（${resetDate.toISOString().slice(0, 10)} UTC）</span>` : ""}
      <span>${pct.toFixed(1)}% 已用</span>
    </div>
    ${
      quota_exceeded
        ? `<p class="ai-usage-cta" style="margin-top:14px;color:#a13c1f;"><strong>本月额度已用完。</strong>升级会员获取更多额度，或等待下月重置。 <a href="./pricing">查看套餐 →</a></p>`
        : ""
    }
    <p class="muted" style="font-size:0.82rem;margin-top:14px;">
      额度按 UTC 自然月计算，每月 1 日 00:00:00 UTC 自动重置。
      Free 30 次/月（仅经济档）· 月费会员 5M token/月（经济 + 标准档）· 年费会员 20M token/月（含旗舰档 GPT-4o + 解锁自定义 API Key）。
    </p>
  `;
}

// K/M 缩写格式化（与 options / popup 同算法）
function formatDashUsage(n) {
  const num = Number(n) || 0;
  if (num >= 1_000_000) return (num / 1_000_000).toFixed(2) + "M";
  if (num >= 10_000) return (num / 1_000).toFixed(1) + "K";
  if (num >= 1_000) return (num / 1_000).toFixed(2) + "K";
  return String(num);
}

function renderAccount(data) {
  const user = data?.user || {};
  const lic = data?.license || {};
  const plan = lic.plan || "free";

  // 39th 续 · 套餐显示按真实 plan 区分（pro 历史 SKU / yearly 年付 / monthly 月付 / free）
  const planTitleMap = { pro: "Pro 会员", yearly: "Pro 年付", monthly: "Pro 月付", free: "Free" };
  const planPillMap = { pro: "PRO", yearly: "YEAR", monthly: "MONTH", free: "FREE" };
  const isPaidPlan = plan === "pro" || plan === "yearly" || plan === "monthly";

  if (els.email) els.email.textContent = user.email || "—";
  if (els.created) els.created.textContent = formatDate(user.created_at);
  if (els.plan) els.plan.textContent = planTitleMap[plan] || "Free";
  if (els.planPill) {
    els.planPill.textContent = planPillMap[plan] || "FREE";
    els.planPill.className = `dash-plan-pill ${isPaidPlan ? "pro" : "free"}`;
  }
  if (els.expires) {
    const expiresAt = lic.expiresAt || lic.expires_at;
    els.expires.textContent = expiresAt
      ? formatDate(expiresAt)
      : (isPaidPlan ? "按订阅周期续费" : "—");
  }
  if (els.greeting) {
    els.greeting.textContent = user.email ? `你好，${user.email.split("@")[0]}` : "欢迎回来";
  }
  if (els.sub) {
    els.sub.textContent = isPaidPlan
      ? `${planTitleMap[plan] || "Pro"} 已激活，所有功能立即可用。`
      : "管理你的会员权益、绑定设备和账号设置。";
  }

  // OAuth-only 用户（用 Google 注册、还没设置过密码）→ 显示「设置插件登录密码」卡片。
  // 一旦用户成功设置了密码，下次 /api/me 返回 needsPluginPassword=false，卡片自动隐藏。
  if (els.pluginPwCard) {
    const needsPw = !!user.needsPluginPassword;
    els.pluginPwCard.hidden = !needsPw;
  }

  renderRenewalBanner(plan, lic);
}

/**
 * 临近到期 / 已到期续费提醒横幅。
 * 触发条件：
 *   - plan === "pro"
 *   - expiresAt > 0（永久会员不弹）
 *   - 剩余 ≤ 7 天 或者已到期
 * 横幅放在欢迎语下方、账号卡上方，琥珀色 / 红色 + 「立即续费」按钮。
 */
function renderRenewalBanner(plan, lic) {
  const host = document.querySelector(".dash-shell .wrap") || document.querySelector("main");
  if (!host) return;

  let banner = document.getElementById("renewalBanner");
  const expiresAt = Number(lic?.expiresAt || lic?.expires_at) || 0;
  // 39th 续 · 续费提醒覆盖所有付费档（pro / yearly / monthly）
  const isPaidForBanner = plan === "pro" || plan === "yearly" || plan === "monthly";
  if (!isPaidForBanner || expiresAt <= 0) {
    banner?.remove();
    return;
  }

  const msLeft = expiresAt - Date.now();
  const totalDays = Math.ceil(msLeft / (24 * 60 * 60 * 1000));
  // 已到期由 expired 状态去处理，这里只管 8 天 ~ 已到期 0 天的提醒区间
  if (msLeft > 7 * 24 * 60 * 60 * 1000) {
    banner?.remove();
    return;
  }

  const expired = msLeft <= 0;
  const daysLeft = Math.max(1, totalDays);

  if (!banner) {
    banner = document.createElement("div");
    banner.id = "renewalBanner";
    banner.className = "renewal-banner";
    banner.setAttribute("role", "status");
    banner.setAttribute("aria-live", "polite");
    ensureRenewalBannerStyles();
    const greeting = document.querySelector(".section-head");
    if (greeting?.parentNode) {
      greeting.parentNode.insertBefore(banner, greeting.nextSibling);
    } else {
      host.prepend(banner);
    }
  }

  banner.dataset.tone = expired ? "danger" : "warning";
  banner.innerHTML = `
    <div class="renewal-banner__inner">
      <span class="renewal-banner__icon" aria-hidden="true">⏳</span>
      <div class="renewal-banner__body">
        <strong class="renewal-banner__title">
          ${expired
            ? `Pro 会员已于 ${escapeHtml(formatDate(expiresAt))} 到期`
            : `Pro 会员还剩 ${daysLeft} 天到期`}
        </strong>
        <p class="renewal-banner__desc">
          ${expired
            ? "续费后会员权益立即恢复，绑定的设备与历史无需重新设置。"
            : `到期日 ${escapeHtml(formatDate(expiresAt))}。建议提前续费，避免到期当天 Pro 功能突然停用。`}
        </p>
      </div>
      <a class="renewal-banner__action" href="./pricing">立即续费</a>
    </div>
  `;
}

function ensureRenewalBannerStyles() {
  if (document.getElementById("renewal-banner-style")) return;
  const css = `
    .renewal-banner{box-sizing:border-box;max-width:920px;margin:0 auto 22px;
      padding:16px 18px;border-radius:14px;border:1px solid #fde68a;
      background:#fffbeb;color:#92400e;}
    .renewal-banner[data-tone=danger]{background:#fef2f2;border-color:#fecaca;color:#991b1b;}
    .renewal-banner__inner{display:flex;align-items:center;gap:14px;flex-wrap:wrap;}
    .renewal-banner__icon{font-size:22px;line-height:1;flex-shrink:0;}
    .renewal-banner__body{flex:1 1 280px;min-width:0;}
    .renewal-banner__title{display:block;font-size:0.98rem;font-weight:600;line-height:1.4;}
    .renewal-banner__desc{margin:4px 0 0;font-size:0.86rem;line-height:1.55;color:inherit;opacity:0.9;}
    .renewal-banner__action{display:inline-flex;align-items:center;justify-content:center;
      padding:8px 18px;border-radius:9px;background:currentColor;color:#fff !important;
      font-size:0.88rem;font-weight:600;text-decoration:none;
      transition:opacity .15s;flex-shrink:0;}
    .renewal-banner__action:hover{opacity:0.85;}
    .renewal-banner[data-tone=warning] .renewal-banner__action{background:#d97706;}
    .renewal-banner[data-tone=danger] .renewal-banner__action{background:#dc2626;}
  `;
  const style = document.createElement("style");
  style.id = "renewal-banner-style";
  style.textContent = css;
  document.head.appendChild(style);
}

function renderLicenseList(lic) {
  if (!els.list) return;
  const allKeys = Array.isArray(lic?.keys) ? lic.keys : [];
  const keys = allKeys.filter((k) => k && k.status !== "refunded");
  if (!keys.length) {
    els.list.innerHTML = `
      <div class="empty-state">
        还没有 Pro 会员。<a href="./pricing">开通 Pro 会员</a> 后会立即在这里显示开通状态。
      </div>
    `;
    return;
  }
  els.list.innerHTML = keys.map(renderLicenseRow).join("");
  els.list.querySelectorAll("[data-action]").forEach((btn) => {
    btn.addEventListener("click", () => handleLicenseAction(btn));
  });
}

function renderLicenseRow(row) {
  const expires = row.expires_at && Number(row.expires_at) > 0
    ? `有效至 ${formatDate(row.expires_at)}`
    : "按订阅周期续费";
  const planTitle = row.plan === "pro" ? "Pro 会员"
    : row.plan === "monthly" ? "月费会员"
    : row.plan === "yearly" ? "年费会员"
    : String(row.plan || "Free");
  const statusTag = row.status === "active" ? "已激活"
    : row.status === "expired" ? "已过期"
    : row.status === "revoked" ? "已禁用"
    : row.status === "refunded" ? "已退款"
    : row.status || "—";
  const devices = Array.isArray(row.devices) ? row.devices : [];
  // 39th 续 · 设备配额角标（Strategy B：Free 1 / Monthly 3 / Yearly 10）
  const limit = Number(row.deviceLimit) || 1;
  const isOverLimit = devices.length > limit;
  const isNearLimit = !isOverLimit && devices.length >= limit;
  const deviceTone = isOverLimit ? "over" : isNearLimit ? "warn" : "ok";
  const deviceLine = `已激活 <strong>${devices.length} / ${limit}</strong> 台设备`;

  // 注：row.key 是后端会员激活码（备用激活方案，普通用户用账号自动同步即可）。
  // 默认折叠到 details 里，避免页面看起来像卡密店。
  return `
    <div class="dash-license" data-key="${escapeAttr(row.key)}">
      <div class="dash-license-meta">
        <span class="dash-license-key">${escapeHtml(planTitle)}</span>
        <span class="dash-license-info" data-device-tone="${deviceTone}">
          ${escapeHtml(statusTag)} · ${escapeHtml(expires)} · ${deviceLine}
        </span>
      </div>
      <div class="dash-license-actions">
        <button class="btn btn-ghost" type="button" data-action="unbind">解绑此账号</button>
      </div>
      <details class="dash-license-advanced">
        <summary>高级（备用激活码，正常情况无需使用）</summary>
        <div class="dash-license-advanced-body">
          <p class="muted" style="font-size:0.82rem;margin:4px 0 8px;">
            正常使用请直接在扩展中登录此账号即可自动同步会员权益。<br>
            以下激活码仅在账号登录异常时作为备用手段使用。
          </p>
          <code style="font-size:0.78rem;color:#475569;word-break:break-all;">${escapeHtml(row.key)}</code>
          <button class="btn btn-ghost" style="margin-left:8px;" type="button" data-action="copy">复制</button>
        </div>
      </details>
      ${renderDevicesBlock(row.key, devices, limit)}
    </div>
  `;
}

function renderDevicesBlock(key, devices, limit) {
  if (!devices.length) {
    return `
      <details class="dash-license-devices">
        <summary>设备：暂无激活记录</summary>
      </details>
    `;
  }
  // 39th 续 · 设备行加 user_agent_hint + "X 天前" 相对时间，stale 行加视觉灰化
  const STALE_DAYS = 30;
  const staleCutoff = Date.now() - STALE_DAYS * 86_400_000;
  const items = devices.map((d) => {
    const isStale = Number(d.last_seen_at) > 0 && Number(d.last_seen_at) < staleCutoff;
    const fpShort = d.fingerprint ? String(d.fingerprint).slice(0, 8) : "—";
    const ago = formatRelativeTime(d.last_seen_at);
    const uaHint = d.userAgentHint ? ` · ${escapeHtml(d.userAgentHint)}` : "";
    return `
    <div class="dash-device${isStale ? " is-stale" : ""}" data-device-id="${escapeAttr(d.id || "")}" data-fingerprint="${escapeAttr(d.fingerprint || "")}">
      <div class="dash-device-meta">
        <span class="dash-device-label">${escapeHtml(d.label || "未命名设备")}${uaHint}</span>
        <span class="dash-device-fp">指纹 ${escapeHtml(fpShort)} · ${escapeHtml(ago)}（${formatDateTime(d.last_seen_at)}）</span>
      </div>
      <div class="dash-device-actions">
        <button class="btn btn-ghost" type="button" data-action="device-unbind" data-license-key="${escapeAttr(key)}">解绑</button>
      </div>
    </div>`;
  }).join("");
  // 39th 续 · 一键清理 N 天未活跃按钮（仅当存在 stale 设备时显示，避免按钮乱晃）
  const staleCount = devices.filter((d) => Number(d.last_seen_at) > 0 && Number(d.last_seen_at) < staleCutoff).length;
  const pruneBtn = staleCount > 0
    ? `<button class="btn btn-ghost dash-license-prune-btn" type="button" data-action="prune-stale" data-license-key="${escapeAttr(key)}" data-prune-days="${STALE_DAYS}">清理 ${STALE_DAYS} 天未活跃（${staleCount} 台）</button>`
    : "";
  const overflowHint = devices.length > Number(limit)
    ? `<p class="muted" style="font-size:12px;margin:6px 0 10px;color:#a13c1f;">⚠️ 当前激活数已超会员上限 ${limit} 台。系统每小时自动清理 90 天未活跃的设备；建议手动清理或解绑闲置设备。</p>`
    : "";
  return `
    <details class="dash-license-devices" open>
      <summary>设备 ${devices.length} 台${staleCount > 0 ? ` · ${staleCount} 台 ${STALE_DAYS} 天未活跃` : ""}（点击折叠）</summary>
      ${overflowHint}
      ${items}
      ${pruneBtn ? `<div style="margin-top:10px;">${pruneBtn}</div>` : ""}
    </details>
  `;
}

// 39th 续 · 相对时间格式化（"3 分钟前 / 2 天前 / 5 个月前"）
// 与扩展端 formatAgo 同语义；放此处独立避免引 src/shared 编译依赖
function formatRelativeTime(ts) {
  const t = Number(ts) || 0;
  if (!t) return "—";
  const diff = Date.now() - t;
  if (diff < 60_000) return "刚刚";
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} 分钟前`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)} 小时前`;
  const days = Math.floor(diff / 86_400_000);
  if (days < 30) return `${days} 天前`;
  if (days < 365) return `${Math.floor(days / 30)} 个月前`;
  return `${Math.floor(days / 365)} 年前`;
}

async function handleLicenseAction(btn) {
  const action = btn.dataset.action;

  if (action === "device-unbind") {
    const deviceEl = btn.closest("[data-device-id]");
    const key = btn.dataset.licenseKey;
    const deviceId = deviceEl?.dataset.deviceId || "";
    const fingerprint = deviceEl?.dataset.fingerprint || "";
    if (!key || (!deviceId && !fingerprint)) return;
    if (!confirm("确定要解绑这台设备？该设备的扩展会在下次联网核验时回到免费版。")) return;
    btn.disabled = true;
    btn.textContent = "处理中…";
    try {
      await license.unbindDevice(key, fingerprint, deviceId);
      showToast("已解绑该设备。", "success");
      await hydrate();
    } catch (error) {
      showToast(`解绑设备失败：${error?.message || "未知错误"}`, "error");
      btn.disabled = false;
      btn.textContent = "解绑";
    }
    return;
  }

  // 39th 续 · 一键清理 N 天未活跃设备（per license）
  if (action === "prune-stale") {
    const key = btn.dataset.licenseKey;
    const days = Number(btn.dataset.pruneDays) || 30;
    if (!key) return;
    if (!confirm(`确定清理此 License 下 ${days} 天未活跃的设备？这些设备的扩展会在下次联网核验时回到免费版，需要时可以重新激活。`)) return;
    btn.disabled = true;
    const originalText = btn.textContent;
    btn.textContent = "清理中…";
    try {
      const resp = await license.pruneStaleDevices(key, days);
      const n = Number(resp?.deleted) || 0;
      if (n > 0) {
        showToast(`已清理 ${n} 台 ${days} 天未活跃设备。`, "success");
      } else {
        showToast("没有 stale 设备可清理。", "info");
      }
      await hydrate();
    } catch (error) {
      showToast(`清理失败：${error?.message || "未知错误"}`, "error");
      btn.disabled = false;
      btn.textContent = originalText;
    }
    return;
  }

  // license 行级动作（copy / unbind 整张 key）
  const item = btn.closest("[data-key]");
  const key = item?.dataset.key;
  if (!key) return;

  if (action === "copy") {
    try {
      await navigator.clipboard.writeText(key);
      flashBtn(btn, "已复制");
    } catch {
      alert(`请手动复制：${key}`);
    }
  } else if (action === "unbind") {
    if (!confirm(`确定要从此账号解绑当前 Pro 会员权益？解绑后可在其它账号下重新绑定。`)) return;
    btn.disabled = true;
    btn.textContent = "处理中…";
    try {
      await license.unbind(key);
      showToast("已解绑会员权益。", "success");
      await hydrate();
    } catch (error) {
      showToast(`解绑失败：${error?.message || "未知错误"}`, "error");
      btn.disabled = false;
      btn.textContent = "解绑此账号";
    }
  }
}

/* ====== 修改密码 ====== */

function bindChangePassword() {
  if (!els.changePwForm) return;
  els.changePwForm.addEventListener("submit", async (e) => {
    e.preventDefault();
    const oldPw = els.changePwForm.oldPassword.value;
    const newPw = els.changePwForm.newPassword.value;
    const newPw2 = els.changePwForm.newPassword2.value;
    setChangePwFeedback("");

    if (!oldPw || !newPw || !newPw2) {
      setChangePwFeedback("请填写完整。", "warning");
      return;
    }
    if (newPw.length < 8) {
      setChangePwFeedback("新密码至少 8 位。", "warning");
      return;
    }
    if (newPw !== newPw2) {
      setChangePwFeedback("两次输入的新密码不一致。", "error");
      return;
    }
    if (oldPw === newPw) {
      setChangePwFeedback("新密码不能和旧密码相同。", "warning");
      return;
    }

    els.changePwSubmit.disabled = true;
    els.changePwSubmit.textContent = "保存中…";
    try {
      const res = await auth.changePassword(oldPw, newPw);
      // 后端改密后吊销所有旧 JWT 并发一个新 token，更新本地避免当前会话被踢出。
      if (res && res.token) setToken(res.token);
      els.changePwForm.reset();
      closeModal(els.changePwModal);
      showToast("密码已更新，其他设备需重新登录。", "success", 4000);
    } catch (error) {
      setChangePwFeedback(error?.message || "保存失败", "error");
    } finally {
      els.changePwSubmit.disabled = false;
      els.changePwSubmit.textContent = "保存新密码";
    }
  });
}

function setChangePwFeedback(text, tone) {
  if (!els.changePwFeedback) return;
  if (!text) {
    els.changePwFeedback.classList.remove("show");
    els.changePwFeedback.textContent = "";
    return;
  }
  els.changePwFeedback.dataset.tone = tone || "muted";
  els.changePwFeedback.textContent = text;
  els.changePwFeedback.classList.add("show");
}

/* ====== 为 OAuth-only 账号设置插件登录密码 ====== */

function bindSetPassword() {
  if (!els.setPwForm) return;
  els.setPwForm.addEventListener("submit", async (e) => {
    e.preventDefault();
    const newPw = els.setPwForm.newPassword.value;
    const newPw2 = els.setPwForm.newPassword2.value;
    setSetPwFeedback("");

    if (!newPw || !newPw2) {
      setSetPwFeedback("请填写新密码并再次确认。", "warning");
      return;
    }
    if (newPw.length < 8) {
      setSetPwFeedback("新密码至少 8 位。", "warning");
      return;
    }
    if (newPw !== newPw2) {
      setSetPwFeedback("两次输入的密码不一致。", "error");
      return;
    }

    els.setPwSubmit.disabled = true;
    els.setPwSubmit.textContent = "保存中…";
    try {
      await auth.setPassword(newPw);
      els.setPwForm.reset();
      closeModal(els.setPwModal);
      showToast(
        "密码已设置 ✓ 现在可以在 Chrome 插件里用「邮箱 + 密码」登录本账号。",
        "success",
        5000
      );
      // 重新拉一次 /api/me，让 needsPluginPassword 翻成 false → 卡片自动隐藏
      await hydrate();
    } catch (error) {
      setSetPwFeedback(error?.message || "保存失败", "error");
    } finally {
      els.setPwSubmit.disabled = false;
      els.setPwSubmit.textContent = "保存密码";
    }
  });
}

function setSetPwFeedback(text, tone) {
  if (!els.setPwFeedback) return;
  if (!text) {
    els.setPwFeedback.classList.remove("show");
    els.setPwFeedback.textContent = "";
    return;
  }
  els.setPwFeedback.dataset.tone = tone || "muted";
  els.setPwFeedback.textContent = text;
  els.setPwFeedback.classList.add("show");
}

/* ====== Modal / Toast helpers ====== */

function openModal(modal) {
  if (!modal) return;
  modal.hidden = false;
  // 自动 focus 第一个输入框，键盘可达
  modal.querySelector("input, button, [tabindex]")?.focus();
}

function closeModal(modal) {
  if (!modal) return;
  modal.hidden = true;
}

function showToast(text, tone = "muted", durationMs = 3200) {
  if (!els.toastHost) return;
  const node = document.createElement("div");
  node.className = "toast";
  node.dataset.tone = tone;
  node.textContent = text;
  els.toastHost.appendChild(node);
  setTimeout(() => {
    node.style.transition = "opacity 200ms ease";
    node.style.opacity = "0";
    setTimeout(() => node.remove(), 220);
  }, durationMs);
}

function flashBtn(btn, text) {
  const original = btn.textContent;
  btn.textContent = text;
  btn.disabled = true;
  setTimeout(() => {
    btn.textContent = original;
    btn.disabled = false;
  }, 1200);
}

function formatDate(value) {
  if (!value) return "—";
  const ts = Number(value);
  if (!Number.isFinite(ts) || ts <= 0) return "—";
  // worker 既可能存秒级也可能存毫秒。> 1e12 视为毫秒。
  const d = new Date(ts > 1e12 ? ts : ts * 1000);
  if (!Number.isFinite(d.getTime())) return "—";
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function formatDateTime(value) {
  if (!value) return "—";
  const ts = Number(value);
  if (!Number.isFinite(ts) || ts <= 0) return "—";
  const d = new Date(ts > 1e12 ? ts : ts * 1000);
  if (!Number.isFinite(d.getTime())) return "—";
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function pad(n) {
  return String(n).padStart(2, "0");
}

function escapeHtml(value) {
  return String(value || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function escapeAttr(value) {
  return escapeHtml(value).replace(/"/g, "&quot;");
}
