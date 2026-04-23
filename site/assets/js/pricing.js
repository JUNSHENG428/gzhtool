/**
 * pricing.js — 把 [data-checkout] 按钮接到 Lemon Squeezy 结账链接。
 * --------------------------------------------------------------
 * 关键点：
 *   - 链接配置统一来自 site-config.js（不再硬编码到本文件）
 *   - 已登录用户自动 prefill 邮箱，省一次输入
 *   - 自动加 success / cancel URL（让用户付款后回到 dashboard）
 *   - 如果开启 LEMON_USE_OVERLAY，按钮加 .lemonsqueezy-button class
 *     并按 LS 官方约定附加 lemon.js（见 https://docs.lemonsqueezy.com/help/lemonjs/what-is-lemonjs）
 *   - 配置缺失时按钮禁用并提示，避免用户点了"立即订阅"跳到 404
 */
import { auth, getToken } from "./api.js";
import { SITE_CONFIG } from "./site-config.js";

const LEMON_OVERLAY_SCRIPT = "https://app.lemonsqueezy.com/js/lemon.js";

document.addEventListener("DOMContentLoaded", async () => {
  const buttons = document.querySelectorAll("[data-checkout]");
  if (!buttons.length) return;

  let prefillEmail = "";
  if (getToken()) {
    try {
      const data = await auth.me();
      prefillEmail = data?.user?.email || "";
    } catch {
      // ignore — 未登录或登录已过期，按未登录处理
    }
  }

  buttons.forEach((btn) => {
    const variant = btn.dataset.checkout;
    const base = SITE_CONFIG.LEMON_LINKS?.[variant] || "";

    if (!base || base.includes("REPLACE-ME")) {
      // 配置还没改 → 不要静默跳到无效链接，改成"待配置"提示
      btn.classList.add("is-disabled");
      btn.setAttribute("aria-disabled", "true");
      btn.textContent = "支付通道未配置";
      btn.addEventListener("click", (e) => {
        e.preventDefault();
        alert(
          "Lemon Squeezy checkout 链接还没填到 site/assets/js/site-config.js 里，\n请把对应 variant 的真实 URL 填进去再发布上线。"
        );
      });
      return;
    }

    const params = new URLSearchParams();
    if (prefillEmail) params.set("checkout[email]", prefillEmail);
    // success / cancel 回流：让付款完成后用户回到我们自己的 dashboard
    if (SITE_CONFIG.CHECKOUT_SUCCESS_URL) {
      params.set("checkout[success_url]", absoluteUrl(SITE_CONFIG.CHECKOUT_SUCCESS_URL));
    }

    btn.href = `${base}${base.includes("?") ? "&" : "?"}${params.toString()}`;

    if (SITE_CONFIG.LEMON_USE_OVERLAY) {
      // overlay 模式：LS 官方 lemon.js 会拦截这个 class 的链接，弹窗式付款
      btn.classList.add("lemonsqueezy-button");
    } else {
      // 跳新页模式
      btn.setAttribute("target", "_blank");
      btn.setAttribute("rel", "noopener");
    }
  });

  if (SITE_CONFIG.LEMON_USE_OVERLAY) {
    injectLemonOverlayScript();
  }
});

/**
 * 把站内相对路径 → 完整 URL（LS 要求 success_url 必须是绝对地址）
 */
function absoluteUrl(pathOrUrl) {
  if (/^https?:\/\//.test(pathOrUrl)) return pathOrUrl;
  const base = SITE_CONFIG.SITE_BASE.replace(/\/+$/, "");
  return `${base}${pathOrUrl.startsWith("/") ? "" : "/"}${pathOrUrl}`;
}

function injectLemonOverlayScript() {
  if (document.querySelector(`script[src="${LEMON_OVERLAY_SCRIPT}"]`)) return;
  const s = document.createElement("script");
  s.src = LEMON_OVERLAY_SCRIPT;
  s.defer = true;
  document.body.appendChild(s);
}
