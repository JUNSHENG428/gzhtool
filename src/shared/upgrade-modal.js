/**
 * src/shared/upgrade-modal.js
 * --------------------------------------------------------
 * 通用「升级到 Pro」软闸门弹窗。
 *
 * 任何前端页面（options / workspace / popup）都可以：
 *   import { showUpgradeModal } from "../shared/upgrade-modal.js";
 *   showUpgradeModal({
 *     featureName: "多公众号管理",
 *     hint: "免费版最多绑定 2 个公众号，升级 Pro 可无限切换矩阵账号。",
 *     primaryAction: { label: "查看 Pro 套餐", url: "https://..." }
 *   });
 *
 * 设计原则：
 *  - 不引入第三方 UI 库，全部用原生 DOM。
 *  - 弹窗只能存在一份（多次调用会替换内容）。
 *  - 可被 ESC / 点击遮罩关闭，对键盘用户友好。
 *  - 不依赖 chrome API，service-worker 不能直接调；后台需要时改用 chrome.runtime.sendMessage 让 UI 弹。
 */

const STYLE_ID = "license-upgrade-modal-style";
const ROOT_ID = "license-upgrade-modal-root";

const CSS = `
.license-upgrade-backdrop {
  position: fixed;
  inset: 0;
  z-index: 99999;
  background: rgba(15, 23, 42, 0.55);
  backdrop-filter: blur(6px);
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 24px;
  animation: license-upgrade-fade 160ms ease-out;
}
.license-upgrade-card {
  width: min(100%, 460px);
  background: #ffffff;
  border-radius: 20px;
  box-shadow: 0 24px 60px -16px rgba(15, 23, 42, 0.35),
    0 12px 24px -12px rgba(15, 23, 42, 0.18);
  overflow: hidden;
  font-family: -apple-system, "PingFang SC", "Hiragino Sans GB", system-ui, sans-serif;
  color: #1f2937;
  animation: license-upgrade-pop 200ms cubic-bezier(.22,1,.36,1);
}
.license-upgrade-head {
  padding: 24px 24px 12px;
  background: linear-gradient(135deg, #ecfccb 0%, #f0fdf4 50%, #ffffff 100%);
  border-bottom: 1px solid rgba(0,0,0,.04);
  position: relative;
}
.license-upgrade-pill {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 4px 10px;
  border-radius: 999px;
  background: #14532d;
  color: #ecfdf5;
  font-size: 11px;
  font-weight: 600;
  letter-spacing: .03em;
}
.license-upgrade-title {
  margin: 12px 0 4px;
  font-size: 19px;
  font-weight: 700;
  color: #0f172a;
}
.license-upgrade-subtitle {
  margin: 0;
  font-size: 13px;
  color: #475569;
}
.license-upgrade-close {
  position: absolute;
  top: 14px;
  right: 14px;
  width: 32px;
  height: 32px;
  border-radius: 10px;
  border: none;
  background: rgba(15, 23, 42, .04);
  color: #475569;
  font-size: 16px;
  cursor: pointer;
  transition: background 120ms;
}
.license-upgrade-close:hover {
  background: rgba(15, 23, 42, .08);
  color: #0f172a;
}
.license-upgrade-body {
  padding: 18px 24px 4px;
  font-size: 14px;
  line-height: 1.7;
  color: #374151;
}
.license-upgrade-feature {
  margin: 8px 0 16px;
  padding: 12px 14px;
  background: #f8fafc;
  border: 1px solid #e2e8f0;
  border-radius: 12px;
  font-size: 13px;
  color: #334155;
}
.license-upgrade-feature strong {
  color: #14532d;
}
.license-upgrade-list {
  margin: 8px 0 0;
  padding-left: 18px;
  color: #475569;
  font-size: 13px;
  line-height: 1.7;
}
.license-upgrade-list li { margin: 4px 0; }
.license-upgrade-actions {
  padding: 14px 24px 22px;
  display: flex;
  gap: 10px;
  justify-content: flex-end;
  flex-wrap: wrap;
}
.license-upgrade-btn {
  appearance: none;
  border: none;
  cursor: pointer;
  padding: 9px 18px;
  border-radius: 12px;
  font-size: 13px;
  font-weight: 600;
  font-family: inherit;
  transition: transform 120ms, box-shadow 120ms, background 120ms;
}
.license-upgrade-btn:active { transform: translateY(1px); }
.license-upgrade-primary {
  background: linear-gradient(135deg, #14532d 0%, #166534 100%);
  color: #ffffff;
  box-shadow: 0 6px 16px -6px rgba(20, 83, 45, .55);
}
.license-upgrade-primary:hover {
  box-shadow: 0 10px 22px -6px rgba(20, 83, 45, .6);
}
.license-upgrade-ghost {
  background: transparent;
  color: #475569;
}
.license-upgrade-ghost:hover {
  background: rgba(15, 23, 42, .05);
  color: #0f172a;
}
@keyframes license-upgrade-fade {
  from { opacity: 0; }
  to { opacity: 1; }
}
@keyframes license-upgrade-pop {
  from { opacity: 0; transform: translateY(8px) scale(.97); }
  to { opacity: 1; transform: translateY(0) scale(1); }
}
`;

function ensureStyle() {
  if (typeof document === "undefined") return;
  if (document.getElementById(STYLE_ID)) return;
  const style = document.createElement("style");
  style.id = STYLE_ID;
  style.textContent = CSS;
  document.head.appendChild(style);
}

function ensureRoot() {
  if (typeof document === "undefined") return null;
  let root = document.getElementById(ROOT_ID);
  if (root) return root;
  root = document.createElement("div");
  root.id = ROOT_ID;
  document.body.appendChild(root);
  return root;
}

let _activeKeydownHandler = null;

function close() {
  if (typeof document === "undefined") return;
  const root = document.getElementById(ROOT_ID);
  if (root) root.replaceChildren();
  if (_activeKeydownHandler) {
    document.removeEventListener("keydown", _activeKeydownHandler);
    _activeKeydownHandler = null;
  }
}

/**
 * 显示一个升级到 Pro 的软闸门弹窗。
 * @param {object} options
 *   featureName    - string  必填：被拦截的功能名（"多公众号管理"）
 *   hint           - string  必填：解释为什么被拦截 / Pro 能解锁什么
 *   bullets        - string[] 选填：底部要点列表
 *   primaryAction  - { label, url? , onClick? } 选填：默认 "查看 Pro 套餐"
 *   secondaryLabel - string 选填：默认 "我先用免费版"
 *   onClose        - () => void 选填
 */
export function showUpgradeModal(options = {}) {
  if (typeof document === "undefined" || typeof window === "undefined") {
    return;
  }
  ensureStyle();
  const root = ensureRoot();
  if (!root) return;

  const featureName = String(options.featureName || "Pro 功能");
  const hint = String(options.hint || "升级到 Pro 即可解锁该功能。");
  const bullets = Array.isArray(options.bullets) ? options.bullets : [];
  const primary = options.primaryAction || {
    label: "查看 Pro 套餐",
    url: "https://docuearn.com/pricing"
  };
  const secondaryLabel = options.secondaryLabel || "我先用免费版";

  root.replaceChildren();

  const backdrop = document.createElement("div");
  backdrop.className = "license-upgrade-backdrop";
  backdrop.setAttribute("role", "dialog");
  backdrop.setAttribute("aria-modal", "true");

  backdrop.innerHTML = `
    <div class="license-upgrade-card">
      <div class="license-upgrade-head">
        <button class="license-upgrade-close" type="button" aria-label="关闭">×</button>
        <span class="license-upgrade-pill">PRO 专属</span>
        <h2 class="license-upgrade-title">解锁「${escape(featureName)}」</h2>
        <p class="license-upgrade-subtitle">免费版可继续使用全部基础功能，升级仅解锁该高级能力。</p>
      </div>
      <div class="license-upgrade-body">
        <p class="license-upgrade-feature">${escape(hint)}</p>
        ${
          bullets.length
            ? `<ul class="license-upgrade-list">${bullets
                .map((b) => `<li>${escape(b)}</li>`)
                .join("")}</ul>`
            : ""
        }
      </div>
      <div class="license-upgrade-actions">
        <button type="button" class="license-upgrade-btn license-upgrade-ghost" data-action="close">
          ${escape(secondaryLabel)}
        </button>
        <button type="button" class="license-upgrade-btn license-upgrade-primary" data-action="primary">
          ${escape(primary.label || "查看 Pro 套餐")}
        </button>
      </div>
    </div>
  `;

  root.appendChild(backdrop);

  const cleanup = () => {
    close();
    if (typeof options.onClose === "function") {
      try { options.onClose(); } catch { /* ignore */ }
    }
  };

  backdrop.querySelector(".license-upgrade-close").addEventListener("click", cleanup);
  backdrop.querySelector('[data-action="close"]').addEventListener("click", cleanup);
  backdrop.querySelector('[data-action="primary"]').addEventListener("click", () => {
    if (typeof primary.onClick === "function") {
      try { primary.onClick(); } catch { /* ignore */ }
    }
    if (primary.url) {
      try {
        if (globalThis.chrome?.tabs?.create) {
          chrome.tabs.create({ url: primary.url });
        } else {
          window.open(primary.url, "_blank", "noopener,noreferrer");
        }
      } catch {
        window.open(primary.url, "_blank", "noopener,noreferrer");
      }
    }
    cleanup();
  });

  backdrop.addEventListener("click", (event) => {
    if (event.target === backdrop) cleanup();
  });

  _activeKeydownHandler = (event) => {
    if (event.key === "Escape") cleanup();
  };
  document.addEventListener("keydown", _activeKeydownHandler);
}

export function closeUpgradeModal() {
  close();
}

function escape(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}
