/**
 * pricing.js — 把 [data-checkout="monthly|yearly"] 按钮接到虎皮椒（HuPiJiao）支付。
 * --------------------------------------------------------------
 * 流程：
 *   ① 用户点按钮 → 检查登录态（未登录跳 login.html?next=/pricing#xxx）
 *   ② 调 POST /api/payment/hupijiao/create { plan } → 拿 url_qrcode + trade_order_id
 *   ③ 弹一个二维码 modal（PC 微信扫码 + 文案）
 *   ④ 每 2 秒 GET /api/payment/hupijiao/query 一次，最多 5 分钟
 *   ⑤ 拿到 status=paid → 关 modal + toast「Pro 已开通」+ 跳 dashboard
 *
 * 依赖：api.js 提供的 getApiBase / getToken / api() 工具。
 */
import { api, getApiBase, getToken } from "./api.js";
import { SITE_CONFIG } from "./site-config.js";

// 本地 vendor 路径（自托管，不依赖外网 CDN，国内访问稳定）
// davidshimjs/qrcodejs：纯浏览器 19KB，API：new QRCode(element, { text, width, height, ... })
const QRCODE_LIB = "./assets/vendor/qrcode.min.js";
const POLL_INTERVAL_MS = 2000;
const POLL_TIMEOUT_MS = 5 * 60 * 1000;

// 支付回流后，前端再花 60s 轮询 /api/me 等 webhook 把权益落库；
// 超过这个时间还不是 Pro 就提示用户手动刷新。
const MEMBER_SYNC_TIMEOUT_MS = 60 * 1000;
const MEMBER_SYNC_INTERVAL_MS = 3000;

document.addEventListener("DOMContentLoaded", () => {
  const buttons = document.querySelectorAll("[data-checkout]");
  if (!buttons.length) return;

  ensureModalStyles();
  ensureBannerStyles();

  buttons.forEach((btn) => {
    const planCode = btn.dataset.checkout;
    if (!SITE_CONFIG.PLANS?.[planCode]) {
      btn.classList.add("is-disabled");
      btn.setAttribute("aria-disabled", "true");
      btn.textContent = "套餐未配置";
      btn.dataset.cta = "noop";
      return;
    }
    if (btn.tagName === "A") {
      btn.removeAttribute("target");
      btn.setAttribute("role", "button");
    }
    btn.dataset.cta = "checkout";
    setCheckoutHref(btn);

    // 单一 click 入口；按当前 dataset.cta 派发
    btn.addEventListener("click", (e) => {
      const cta = btn.dataset.cta;
      if (cta === "checkout") {
        e.preventDefault();
        e.stopPropagation();
        void onCheckoutClick(planCode);
      } else if (cta === "syncing" || cta === "noop") {
        e.preventDefault();
        e.stopPropagation();
      }
      // cta === "guest" / "pro" → <a href> 直接跳，不拦截
    });
    btn.addEventListener("auxclick", (e) => {
      const cta = btn.dataset.cta;
      if (cta === "checkout" || cta === "syncing" || cta === "noop") e.preventDefault();
    });
  });

  void hydrateMemberState(buttons);
});

function setCheckoutHref(btn) {
  if (btn.tagName === "A") btn.setAttribute("href", "javascript:void(0)");
}

async function onCheckoutClick(planCode) {
  if (!getToken()) {
    const next = encodeURIComponent(`/pricing.html#${planCode}`);
    location.href = `./login?next=${next}`;
    return;
  }

  let order;
  try {
    order = await api("/api/payment/hupijiao/create", {
      method: "POST",
      body: { plan: planCode }
    });
  } catch (err) {
    alert("下单失败：" + (err?.message || "未知错误"));
    return;
  }
  if (!order?.qrcode) {
    alert("支付平台返回异常，请稍后重试");
    return;
  }

  await openCheckoutModal(order);
}

/* --------------------------------- modal --------------------------------- */
async function openCheckoutModal(order) {
  const overlay = document.createElement("div");
  overlay.className = "hpj-modal-overlay";
  overlay.innerHTML = `
    <div class="hpj-modal" role="dialog" aria-modal="true" aria-label="微信扫码支付">
      <button class="hpj-modal-close" type="button" aria-label="关闭">&times;</button>
      <h2 class="hpj-modal-title">${escapeHtml(order.title)}</h2>
      <p class="hpj-modal-amount">¥<strong>${Number(order.total_fee).toFixed(2)}</strong></p>
      <div class="hpj-modal-qrwrap">
        <div class="hpj-modal-qr"></div>
        <div class="hpj-modal-status" data-state="waiting">
          <span class="hpj-spinner"></span>
          <span class="hpj-status-text">等待扫码支付…</span>
        </div>
      </div>
      <ol class="hpj-modal-steps">
        <li>用<strong>微信</strong>扫描左侧二维码</li>
        <li>确认支付金额，点击「立即支付」</li>
        <li>支付成功后，本页会自动开通会员，无需手动刷新</li>
      </ol>
      <div class="hpj-modal-actions">
        <button class="hpj-action-btn" type="button" data-action="check-paid">我已完成支付，立即查询</button>
      </div>
      <p class="hpj-modal-note">
        二维码有效期 5 分钟。订单号：<code>${escapeHtml(order.trade_order_id)}</code>
      </p>
    </div>
  `;
  document.body.appendChild(overlay);
  document.body.style.overflow = "hidden";

  const close = () => {
    document.body.style.overflow = "";
    overlay.remove();
  };
  overlay.querySelector(".hpj-modal-close").addEventListener("click", close);
  overlay.addEventListener("click", (e) => {
    if (e.target === overlay) close();
  });

  const qrSlot = overlay.querySelector(".hpj-modal-qr");
  const looksLikeImage = /\.(png|jpe?g|gif|webp)(?:$|\?)/i.test(order.qrcode || "")
    || /api\.xunhupay\.com.*qrcode/i.test(order.qrcode || "");

  if (looksLikeImage) {
    const img = document.createElement("img");
    img.src = order.qrcode;
    img.alt = "微信支付二维码";
    img.width = 220;
    img.height = 220;
    img.style.cssText = "border-radius:6px;background:#fff;display:block;";
    img.onerror = () => {
      img.replaceWith(buildPayLinkFallback(order.h5_url || order.qrcode));
    };
    qrSlot.replaceWith(img);
  } else {
    try {
      await ensureQrcodeLib();
      qrSlot.style.cssText = "width:220px;height:220px;background:#fff;border-radius:6px;padding:6px;flex-shrink:0;";
      // eslint-disable-next-line no-undef
      new QRCode(qrSlot, {
        text: order.qrcode,
        width: 208,
        height: 208,
        // eslint-disable-next-line no-undef
        correctLevel: QRCode.CorrectLevel.M
      });
    } catch (err) {
      console.error("[checkout] qr render failed", err);
      qrSlot.replaceWith(buildPayLinkFallback(order.h5_url || order.qrcode));
    }
  }

  const statusBox = overlay.querySelector(".hpj-modal-status");
  const statusText = overlay.querySelector(".hpj-status-text");
  const checkBtn = overlay.querySelector('[data-action="check-paid"]');

  let stopped = false;
  let checking = false;
  overlay.addEventListener("hpj-stop-poll", () => (stopped = true));
  const observer = new MutationObserver(() => {
    if (!document.body.contains(overlay)) {
      stopped = true;
      observer.disconnect();
    }
  });
  observer.observe(document.body, { childList: true });

  // 单次查询：返回 true 表示终态（paid/expired/refunded/failed），调用方应停止轮询
  async function pollOnce({ manual = false } = {}) {
    if (checking) return false;
    checking = true;
    try {
      const q = await api(
        `/api/payment/hupijiao/query?trade_order_id=${encodeURIComponent(order.trade_order_id)}`
      );
      if (q.status === "paid") {
        statusBox.dataset.state = "paid";
        statusText.textContent = "支付成功！正在跳转控制台…";
        stopped = true;
        await sleep(1200);
        observer.disconnect();
        close();
        location.href = "/dashboard.html?from=checkout&result=success";
        return true;
      }
      if (q.status === "expired") {
        statusBox.dataset.state = "expired";
        statusText.textContent = "二维码已过期，请关闭重试";
        stopped = true;
        observer.disconnect();
        return true;
      }
      if (q.status === "refunded" || q.status === "failed") {
        statusBox.dataset.state = "failed";
        statusText.textContent = "订单已" + (q.status === "refunded" ? "退款" : "失败");
        stopped = true;
        observer.disconnect();
        return true;
      }
      if (manual) {
        statusText.textContent = "尚未收到支付回执，请稍候 5 秒再试…";
        setTimeout(() => {
          if (!stopped) statusText.textContent = "等待扫码支付…";
        }, 5000);
      }
      return false;
    } catch (err) {
      console.warn("[checkout] poll error", err);
      if (manual) statusText.textContent = "查询失败，请检查网络后重试";
      return false;
    } finally {
      checking = false;
    }
  }

  if (checkBtn) {
    checkBtn.addEventListener("click", async () => {
      checkBtn.disabled = true;
      checkBtn.textContent = "查询中…";
      await pollOnce({ manual: true });
      checkBtn.disabled = false;
      checkBtn.textContent = "我已完成支付，立即查询";
    });
  }

  const t0 = Date.now();
  while (!stopped && Date.now() - t0 < POLL_TIMEOUT_MS) {
    await sleep(POLL_INTERVAL_MS);
    if (stopped) break;
    const finished = await pollOnce();
    if (finished) return;
  }

  if (!stopped) {
    statusBox.dataset.state = "expired";
    statusText.textContent = "等待超时，请关闭后重试";
  }
  observer.disconnect();
}

/* --------------------------------- helpers --------------------------------- */
function ensureQrcodeLib() {
  if (typeof window === "undefined") return Promise.resolve();
  // eslint-disable-next-line no-undef
  if (typeof QRCode !== "undefined") return Promise.resolve();
  return new Promise((resolve, reject) => {
    const s = document.createElement("script");
    s.src = QRCODE_LIB;
    s.onload = resolve;
    s.onerror = () => reject(new Error("二维码库加载失败"));
    document.head.appendChild(s);
  });
}

function ensureModalStyles() {
  if (document.getElementById("hpj-modal-style")) return;
  const css = `
    .hpj-modal-overlay{position:fixed;inset:0;background:rgba(15,23,42,.55);
      backdrop-filter:blur(4px);z-index:9999;display:flex;align-items:center;
      justify-content:center;padding:24px;animation:hpjFade .15s ease-out;}
    @keyframes hpjFade{from{opacity:0}to{opacity:1}}
    .hpj-modal{position:relative;background:#fff;border-radius:16px;
      box-shadow:0 24px 60px rgba(0,0,0,.25);max-width:420px;width:100%;
      padding:32px 28px 24px;font-family:inherit;color:#0f172a;}
    .hpj-modal-close{position:absolute;top:12px;right:14px;width:32px;height:32px;
      border:none;background:transparent;font-size:24px;line-height:1;cursor:pointer;
      color:#64748b;border-radius:8px;}
    .hpj-modal-close:hover{background:#f1f5f9;color:#0f172a;}
    .hpj-modal-title{margin:0 0 4px;font-size:1.1rem;font-weight:600;}
    .hpj-modal-amount{margin:0 0 18px;font-size:1.4rem;color:#dc2626;}
    .hpj-modal-amount strong{font-size:2rem;font-weight:700;letter-spacing:-1px;}
    .hpj-modal-qrwrap{display:flex;gap:18px;align-items:center;
      background:#f8fafc;border:1px solid #e2e8f0;border-radius:12px;
      padding:16px;margin-bottom:18px;}
    .hpj-modal-qr,.hpj-modal-qrwrap img{flex-shrink:0;border-radius:6px;background:#fff;}
    .hpj-modal-status{flex:1;display:flex;align-items:center;gap:10px;font-size:.9rem;color:#475569;}
    .hpj-modal-status[data-state=paid]{color:#15803d;}
    .hpj-modal-status[data-state=expired]{color:#b45309;}
    .hpj-modal-status[data-state=failed]{color:#b91c1c;}
    .hpj-spinner{display:inline-block;width:14px;height:14px;border:2px solid #cbd5e1;
      border-top-color:#0f172a;border-radius:50%;animation:hpjSpin .9s linear infinite;}
    .hpj-modal-status[data-state=paid] .hpj-spinner,
    .hpj-modal-status[data-state=expired] .hpj-spinner,
    .hpj-modal-status[data-state=failed] .hpj-spinner{display:none;}
    @keyframes hpjSpin{to{transform:rotate(360deg);}}
    .hpj-modal-steps{margin:0 0 12px;padding-left:20px;font-size:.88rem;color:#475569;line-height:1.7;}
    .hpj-modal-steps strong{color:#0f172a;}
    .hpj-modal-actions{display:flex;gap:8px;margin:0 0 14px;}
    .hpj-action-btn{flex:1;padding:10px 14px;border:1px solid #cbd5e1;background:#fff;
      border-radius:8px;cursor:pointer;font-size:.88rem;color:#0f172a;
      transition:background .15s,border-color .15s;}
    .hpj-action-btn:hover{background:#f1f5f9;border-color:#94a3b8;}
    .hpj-action-btn:disabled{opacity:.6;cursor:not-allowed;}
    .hpj-modal-note{margin:0;font-size:.78rem;color:#94a3b8;}
    .hpj-modal-note code{background:#f1f5f9;padding:2px 5px;border-radius:4px;
      font-family:ui-monospace,monospace;color:#475569;font-size:.78rem;}
  `;
  const style = document.createElement("style");
  style.id = "hpj-modal-style";
  style.textContent = css;
  document.head.appendChild(style);
}

function buildPayLinkFallback(url) {
  const wrap = document.createElement("div");
  wrap.style.cssText = "width:220px;height:220px;display:flex;align-items:center;justify-content:center;background:#fff;border-radius:6px;padding:8px;text-align:center;font-size:.85rem;color:#475569;";
  wrap.innerHTML = `<div>二维码加载失败<br><a href="${escapeHtml(url || "#")}" target="_blank" rel="noopener" style="display:inline-block;margin-top:8px;color:#2563eb;text-decoration:underline;">点此打开支付页</a></div>`;
  return wrap;
}

function escapeHtml(s) {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// 暴露给 dashboard 用的 API base，方便排查
if (typeof window !== "undefined") {
  window.__HPJ_API_BASE__ = getApiBase();
}

/* =====================================================================
 * 会员状态：进入 pricing 时调一次 /api/me，把订阅按钮换成对应形态
 * ---------------------------------------------------------------------
 * 四种状态：
 *   - guest   未登录          → 「登录后同步会员」  跳 /login?next=/pricing
 *   - pro     已开通 Pro      → 「已开通 · 进入控制台」 跳 /dashboard
 *   - syncing 刚支付完但权益还没落库 → 「正在同步会员，稍后刷新…」（禁用）
 *                              并启动轮询直到 plan === "pro" 或 60s 超时
 *   - checkout 已登录免费用户 → 默认「立即订阅」走支付流程
 * ===================================================================== */

let memberPollTimer = null;
let memberPollStartedAt = 0;

async function hydrateMemberState(buttons) {
  const params = new URLSearchParams(location.search);
  const justCheckedOut =
    params.get("from") === "checkout" && params.get("result") === "success";

  if (!getToken()) {
    applyButtonsState(buttons, "guest");
    showStatusBanner({
      tone: "info",
      text: "登录后这里会自动显示你的订阅状态。",
      action: { text: "前往登录", href: nextLoginHref() }
    });
    return;
  }

  let me;
  try {
    me = await api("/api/me");
  } catch (err) {
    if (err?.status !== 401) {
      console.warn("[pricing] /api/me failed", err);
      showStatusBanner({
        tone: "warning",
        text: "暂时拿不到会员状态，可稍后刷新页面再试。",
        action: { text: "立即刷新", onClick: () => location.reload() }
      });
    }
    // 401 已在 api.js 内处理跳转登录
    return;
  }

  applyMemberState(buttons, me, { justCheckedOut });

  if (justCheckedOut && (me?.license?.plan || "free") !== "pro") {
    startMemberSyncPolling(buttons);
  }
}

function applyMemberState(buttons, me, { justCheckedOut } = {}) {
  const plan = me?.license?.plan || "free";
  const email = me?.user?.email || "";
  const expiresAt = me?.license?.expiresAt || me?.license?.expires_at || 0;

  if (plan === "pro") {
    // 临近到期窗口：按钮回到可点状态、文案改"立即续费"，
    // 横幅 tone 翻 warning + 倒计时，让用户能就地续费。
    // 7 天阈值与 src/shared/license.js EXPIRING_SOON_MS 对齐。
    const msLeft = expiresAt > 0 ? expiresAt - Date.now() : Infinity;
    const isExpiring = expiresAt > 0 && msLeft > 0 && msLeft <= 7 * 24 * 60 * 60 * 1000;

    if (isExpiring) {
      const daysLeft = Math.max(1, Math.ceil(msLeft / (24 * 60 * 60 * 1000)));
      applyButtonsState(buttons, "renew");
      showStatusBanner({
        tone: "warning",
        text: `${email ? email + "  ·  " : ""}Pro 会员还剩 ${daysLeft} 天到期（${formatExpiry(expiresAt)}），建议提前续费避免功能中断。`,
        action: { text: "进入控制台", href: "./dashboard.html" }
      });
      return;
    }

    applyButtonsState(buttons, "pro");
    showStatusBanner({
      tone: "success",
      text: `${email ? email + "  ·  " : ""}Pro 会员已开通${
        expiresAt ? `，有效至 ${formatExpiry(expiresAt)}` : ""
      }，可直接进入控制台管理设备与权益。`,
      action: { text: "进入控制台", href: "./dashboard.html" }
    });
    return;
  }

  if (justCheckedOut) {
    applyButtonsState(buttons, "syncing");
    showStatusBanner({
      tone: "warning",
      text: "支付完成 ✓ 正在为账号开通 Pro 权益（一般 10～30 秒到账）。",
      action: { text: "立即刷新", onClick: () => location.reload() }
    });
    return;
  }

  applyButtonsState(buttons, "checkout");
  showStatusBanner({
    tone: "info",
    text: `${email ? email + " · " : ""}当前是免费版，选择套餐后扫码支付即可一键升级。`
  });
}

function applyButtonsState(buttons, state) {
  buttons.forEach((btn) => {
    if (btn.dataset.cta === "noop") return;
    btn.classList.remove("is-disabled");
    btn.removeAttribute("aria-disabled");

    switch (state) {
      case "checkout": {
        btn.dataset.cta = "checkout";
        btn.textContent = "立即订阅";
        applyCardStyle(btn);
        setCheckoutHref(btn);
        break;
      }
      case "guest": {
        btn.dataset.cta = "guest";
        btn.textContent = "登录后同步会员";
        applyCardStyle(btn, /*forceGhost*/ true);
        if (btn.tagName === "A") btn.setAttribute("href", nextLoginHref());
        break;
      }
      case "pro": {
        btn.dataset.cta = "pro";
        btn.textContent = "已开通 · 进入控制台";
        applyCardStyle(btn, true);
        if (btn.tagName === "A") btn.setAttribute("href", "./dashboard.html");
        break;
      }
      case "syncing": {
        btn.dataset.cta = "syncing";
        btn.textContent = "正在同步会员，稍后刷新…";
        btn.classList.add("is-disabled");
        btn.setAttribute("aria-disabled", "true");
        applyCardStyle(btn, true);
        setCheckoutHref(btn);
        break;
      }
      case "renew": {
        // 临近到期：行为同 checkout（点了走支付），但文案改"续费"，
        // 让月付/年付都成为合法选择，且按 featured 卡保留 primary 色突出
        btn.dataset.cta = "checkout";
        btn.textContent = "立即续费";
        applyCardStyle(btn);
        setCheckoutHref(btn);
        break;
      }
      default:
        break;
    }
  });
}

// featured 卡片默认是 btn-primary，其它是 btn-ghost。
// 切换状态时如果是 guest/pro/syncing 我们统一用 btn-ghost，
// 否则恢复到该卡片"出厂"样式。
function applyCardStyle(btn, forceGhost = false) {
  const featured = btn.closest(".price-card.featured");
  btn.classList.remove("btn-primary", "btn-ghost");
  if (!forceGhost && featured) btn.classList.add("btn-primary");
  else btn.classList.add("btn-ghost");
}

function nextLoginHref() {
  const next = encodeURIComponent("/pricing.html");
  return `./login?next=${next}`;
}

function startMemberSyncPolling(buttons) {
  if (memberPollTimer) return;
  memberPollStartedAt = Date.now();
  memberPollTimer = setInterval(async () => {
    if (Date.now() - memberPollStartedAt > MEMBER_SYNC_TIMEOUT_MS) {
      stopMemberSyncPolling();
      showStatusBanner({
        tone: "warning",
        text: "同步耗时较长，可手动刷新；或稍后再来查看，权益不会丢失。",
        action: { text: "立即刷新", onClick: () => location.reload() }
      });
      return;
    }
    try {
      const me = await api("/api/me");
      if ((me?.license?.plan || "free") === "pro") {
        stopMemberSyncPolling();
        applyMemberState(buttons, me, { justCheckedOut: false });
      }
    } catch {
      // 间歇性错误忽略，继续等下一轮
    }
  }, MEMBER_SYNC_INTERVAL_MS);
}

function stopMemberSyncPolling() {
  if (memberPollTimer) {
    clearInterval(memberPollTimer);
    memberPollTimer = null;
  }
}

/* --------------------------- 顶部会员状态横幅 --------------------------- */
function showStatusBanner({ tone = "info", text, action } = {}) {
  let banner = document.getElementById("memberStatusBanner");
  if (!banner) {
    banner = document.createElement("div");
    banner.id = "memberStatusBanner";
    banner.className = "member-status-banner";
    const heroSection = document.querySelector(".hero");
    if (heroSection) {
      heroSection.insertAdjacentElement("afterend", banner);
    } else {
      document.querySelector("main")?.prepend(banner);
    }
  }
  banner.dataset.tone = tone;
  const actionHtml = action
    ? action.href
      ? `<a class="member-status-banner__action" href="${escapeHtml(action.href)}">${escapeHtml(action.text)}</a>`
      : `<button type="button" class="member-status-banner__action">${escapeHtml(action.text)}</button>`
    : "";
  banner.innerHTML = `
    <div class="member-status-banner__inner">
      <span class="member-status-banner__text">${escapeHtml(text)}</span>
      ${actionHtml}
    </div>
  `;
  if (action?.onClick) {
    banner
      .querySelector(".member-status-banner__action")
      ?.addEventListener("click", action.onClick);
  }
}

function ensureBannerStyles() {
  if (document.getElementById("member-status-banner-style")) return;
  const css = `
    .member-status-banner{box-sizing:border-box;max-width:920px;margin:0 auto 8px;
      padding:14px 18px;border-radius:14px;font-size:0.92rem;color:#0f172a;
      background:#eff6ff;border:1px solid #bfdbfe;}
    .member-status-banner[data-tone=success]{background:#ecfdf5;border-color:#a7f3d0;color:#065f46;}
    .member-status-banner[data-tone=warning]{background:#fffbeb;border-color:#fde68a;color:#92400e;}
    .member-status-banner__inner{display:flex;align-items:center;justify-content:space-between;
      gap:14px;flex-wrap:wrap;}
    .member-status-banner__text{flex:1 1 280px;line-height:1.55;}
    .member-status-banner__action{display:inline-flex;align-items:center;justify-content:center;
      padding:7px 14px;border-radius:9px;border:1px solid currentColor;background:transparent;
      color:inherit;cursor:pointer;font-size:0.86rem;font-family:inherit;
      text-decoration:none;font-weight:500;transition:background .15s;}
    .member-status-banner__action:hover{background:rgba(15,23,42,.06);}
  `;
  const style = document.createElement("style");
  style.id = "member-status-banner-style";
  style.textContent = css;
  document.head.appendChild(style);
}

function formatExpiry(value) {
  const ts = Number(value);
  if (!Number.isFinite(ts) || ts <= 0) return "";
  const d = new Date(ts > 1e12 ? ts : ts * 1000);
  if (!Number.isFinite(d.getTime())) return "";
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}
