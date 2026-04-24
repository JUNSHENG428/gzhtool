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

document.addEventListener("DOMContentLoaded", () => {
  const buttons = document.querySelectorAll("[data-checkout]");
  if (!buttons.length) return;

  ensureModalStyles();

  buttons.forEach((btn) => {
    const planCode = btn.dataset.checkout;
    if (!SITE_CONFIG.PLANS?.[planCode]) {
      btn.classList.add("is-disabled");
      btn.setAttribute("aria-disabled", "true");
      btn.textContent = "套餐未配置";
      return;
    }
    if (btn.tagName === "A") {
      btn.removeAttribute("target");
      btn.setAttribute("href", "javascript:void(0)");
      btn.setAttribute("role", "button");
    }
    btn.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      void onCheckoutClick(planCode);
    });
    btn.addEventListener("auxclick", (e) => e.preventDefault());
  });
});

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
  return String(s || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// 暴露给 dashboard 用的 API base，方便排查
if (typeof window !== "undefined") {
  window.__HPJ_API_BASE__ = getApiBase();
}
