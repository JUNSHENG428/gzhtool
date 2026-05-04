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
/* P0：闸门拦截统一文案 — 用 row 把「本次被拦」「升级后获得」分两行 */
.license-upgrade-rows {
  display: grid;
  gap: 10px;
  margin: 4px 0 16px;
}
.license-upgrade-row {
  display: grid;
  grid-template-columns: auto 1fr;
  gap: 10px;
  padding: 10px 12px;
  border-radius: 10px;
  background: #f8fafc;
  border: 1px solid #e2e8f0;
  font-size: 13px;
  line-height: 1.55;
  color: #334155;
}
.license-upgrade-row[data-tone="blocked"] {
  background: #fef3f2;
  border-color: #fecaca;
}
.license-upgrade-row[data-tone="gain"] {
  background: #ecfdf5;
  border-color: #bbf7d0;
}
.license-upgrade-row .license-upgrade-row-label {
  font-weight: 700;
  color: #0f172a;
  white-space: nowrap;
}
.license-upgrade-row[data-tone="blocked"] .license-upgrade-row-label {
  color: #b91c1c;
}
.license-upgrade-row[data-tone="gain"] .license-upgrade-row-label {
  color: #14532d;
}
.license-upgrade-row .license-upgrade-row-text {
  color: #334155;
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
 *   blocked        - string  选填：覆盖默认「本次被拦的是…」文案
 *   gain           - string  选填：覆盖默认「升级 Pro 后立即获得…」文案
 *                              （不传则把 hint 当成「升级后获得什么」展示）
 *   primaryAction  - { label, url? , onClick? } 选填：默认 "查看 Pro 套餐"
 *   secondaryLabel - string 选填：默认 "我先用免费版"
 *   onClose        - () => void 选填
 *
 *  P0 上架前体验统一：原来一个 hint 把「拦了什么」和「升级后能干嘛」混在一起，
 *  用户看完一脸懵。新版把弹窗 body 拆成两行：
 *    🚫 本次被拦的是「<featureName>」
 *    🌱 升级 Pro 后立即获得：<gain || hint>
 *  这样无论是免费额度耗尽、还是模板锁、还是多账号超限，所有 Pro 闸门都呈现一致结构。
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

  // P0：「本次被拦 / 升级后获得」结构化文案
  const blockedLine = String(options.blocked || `本次被拦的是「${featureName}」`);
  const gainLine = String(options.gain || hint);

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
        <div class="license-upgrade-rows">
          <div class="license-upgrade-row" data-tone="blocked">
            <span class="license-upgrade-row-label">本次被拦</span>
            <span class="license-upgrade-row-text">${escape(blockedLine)}</span>
          </div>
          <div class="license-upgrade-row" data-tone="gain">
            <span class="license-upgrade-row-label">升级后获得</span>
            <span class="license-upgrade-row-text">${escape(gainLine)}</span>
          </div>
        </div>
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

// ---------------------------------------------------------------------
// 39th 续 · 设备激活撞顶友好 modal
// ---------------------------------------------------------------------

/**
 * 把 verify 接口返回的 device_limit_exceeded 错误转成升级 modal。
 *
 * 设计：复用 showUpgradeModal 的双行（被拦 / 升级后获得）+ bullets 结构，
 * 但文案换成「解绑而非升级」语义——撞顶不是付费门槛而是已付费用户的运维操作。
 *
 * 返回 true 表示已识别并弹出 modal（调用方可短路其他错误处理）；
 * 返回 false 表示该错误不是 device_limit，调用方继续走原路径。
 *
 * 用法：
 *   try { await verifyLicenseRemote(key); }
 *   catch (err) {
 *     if (showDeviceLimitModal(err)) return;  // 已弹 modal，退出
 *     showRegularToast(err);
 *   }
 */
export function showDeviceLimitModal(err) {
  if (err?.data?.reason !== "device_limit_exceeded") return false;
  const activated = Number(err.data.activated) || 0;
  const limit = Number(err.data.limit) || 1;
  const plan = String(err.data.plan || "free");
  const planLabel =
    plan === "yearly"
      ? "年费会员"
      : plan === "monthly"
        ? "月费会员"
        : plan === "free"
          ? "免费版"
          : "当前会员";

  showUpgradeModal({
    featureName: "本设备激活",
    blocked: `本 License 已激活 ${activated} 台设备，达到「${planLabel}」上限 ${limit} 台`,
    gain: "前往会员中心解绑闲置设备 → 即时释放配额，再来扩展按一次「刷新会员状态」即可激活本机",
    bullets: [
      "三档配额：免费版 1 台 · 月费 3 台 · 年费 10 台（覆盖公司+家+移动场景）",
      "解绑后该设备的扩展会在下次联网核验时回到免费版，可再次激活",
      "「清理 30 天未活跃」按钮可批量释放 stale 设备",
      "系统每小时自动清 90 天未活跃的设备，长期未用的无需手动管理"
    ],
    primaryAction: { label: "前往会员中心解绑", url: "https://docuearn.com/dashboard" },
    secondaryLabel: "稍后再说"
  });
  return true;
}
