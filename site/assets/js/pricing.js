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

const QRCODE_LIB = "https://cdn.jsdelivr.net/npm/qrcode@1.5.4/build/qrcode.min.js";
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
    btn.addEventListener("click", (e) => {
      e.preventDefault();
      void onCheckoutClick(planCode);
    });
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
        <canvas class="hpj-modal-qr" width="220" height="220"></canvas>
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

  // 渲染二维码（虎皮椒返回的 url_qrcode 已经是支付链接，需要本地转 QR；
  // 也可能直接是图片 URL — 兼容两种）
  const canvas = overlay.querySelector(".hpj-modal-qr");
  if (/^https?:\/\/.+\.(png|jpg|jpeg|gif)/i.test(order.qrcode)) {
    // 后端直接返回的是图片 URL
    const img = document.createElement("img");
    img.src = order.qrcode;
    img.alt = "支付二维码";
    img.width = 220;
    img.height = 220;
    canvas.replaceWith(img);
  } else {
    try {
      await ensureQrcodeLib();
      // eslint-disable-next-line no-undef
      await QRCode.toCanvas(canvas, order.qrcode, { width: 220, margin: 1 });
    } catch (err) {
      console.error("[checkout] qr render failed", err);
      const fallback = document.createElement("a");
      fallback.href = order.qrcode;
      fallback.target = "_blank";
      fallback.rel = "noopener";
      fallback.textContent = "点此打开支付链接";
      canvas.replaceWith(fallback);
    }
  }

  const statusBox = overlay.querySelector(".hpj-modal-status");
  const statusText = overlay.querySelector(".hpj-status-text");

  // 启动轮询
  const t0 = Date.now();
  let stopped = false;
  overlay.addEventListener("hpj-stop-poll", () => (stopped = true));
  const observer = new MutationObserver(() => {
    if (!document.body.contains(overlay)) {
      stopped = true;
      observer.disconnect();
    }
  });
  observer.observe(document.body, { childList: true });

  while (!stopped && Date.now() - t0 < POLL_TIMEOUT_MS) {
    await sleep(POLL_INTERVAL_MS);
    if (stopped) break;
    try {
      const q = await api(
        `/api/payment/hupijiao/query?trade_order_id=${encodeURIComponent(order.trade_order_id)}`
      );
      if (q.status === "paid") {
        statusBox.dataset.state = "paid";
        statusText.textContent = "支付成功！正在跳转控制台…";
        await sleep(1200);
        observer.disconnect();
        close();
        location.href = "/dashboard.html?from=checkout&result=success";
        return;
      }
      if (q.status === "expired") {
        statusBox.dataset.state = "expired";
        statusText.textContent = "二维码已过期，请关闭重试";
        observer.disconnect();
        return;
      }
      if (q.status === "refunded" || q.status === "failed") {
        statusBox.dataset.state = "failed";
        statusText.textContent = "订单已" + (q.status === "refunded" ? "退款" : "失败");
        observer.disconnect();
        return;
      }
    } catch (err) {
      // 网络抖动忽略，下一轮继续
      console.warn("[checkout] poll error", err);
    }
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
    .hpj-modal-steps{margin:0 0 16px;padding-left:20px;font-size:.88rem;color:#475569;line-height:1.7;}
    .hpj-modal-steps strong{color:#0f172a;}
    .hpj-modal-note{margin:0;font-size:.78rem;color:#94a3b8;}
    .hpj-modal-note code{background:#f1f5f9;padding:2px 5px;border-radius:4px;
      font-family:ui-monospace,monospace;color:#475569;font-size:.78rem;}
  `;
  const style = document.createElement("style");
  style.id = "hpj-modal-style";
  style.textContent = css;
  document.head.appendChild(style);
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
