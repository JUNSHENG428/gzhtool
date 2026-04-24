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
import { auth, license, getToken, clearToken } from "./api.js";

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
  changePwFeedback: document.getElementById("changePwFeedback")
};

document.addEventListener("DOMContentLoaded", () => {
  if (!getToken()) {
    location.href = "./login";
    return;
  }
  void hydrate();
  bindGlobalActions();
  bindChangePassword();
  handleCheckoutReturn();
});

function bindGlobalActions() {
  els.logoutBtn?.addEventListener("click", () => {
    clearToken();
    location.href = "./login";
  });
  els.changePwBtn?.addEventListener("click", () => openModal(els.changePwModal));

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
 * URL 形如 /dashboard.html?from=checkout&result=success
 * 我们弹一个 toast 告诉他「Pro 权益开通中，几十秒后会自动同步到账号」。
 */
function handleCheckoutReturn() {
  const params = new URLSearchParams(location.search);
  if (params.get("from") !== "checkout") return;
  const result = params.get("result");
  if (result === "success") {
    showToast(
      "支付完成 ✓ Pro 权益正在开通，30 秒内会自动同步到你的账号。",
      "success",
      5000
    );
    setTimeout(() => void hydrate(), 5000);
  } else if (result === "cancel") {
    showToast("已取消支付，可以随时回来继续。", "warning");
  }
  // 把 query 清掉，避免刷新就再 toast 一次
  if (history.replaceState) {
    history.replaceState({}, "", location.pathname);
  }
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
}

function renderAccount(data) {
  const user = data?.user || {};
  const lic = data?.license || {};
  const plan = lic.plan || "free";

  if (els.email) els.email.textContent = user.email || "—";
  if (els.created) els.created.textContent = formatDate(user.created_at);
  if (els.plan) els.plan.textContent = plan === "pro" ? "Pro" : "Free";
  if (els.planPill) {
    els.planPill.textContent = plan === "pro" ? "PRO" : "FREE";
    els.planPill.className = `dash-plan-pill ${plan === "pro" ? "pro" : "free"}`;
  }
  if (els.expires) {
    const expiresAt = lic.expiresAt || lic.expires_at;
    els.expires.textContent = expiresAt
      ? formatDate(expiresAt)
      : (plan === "pro" ? "按订阅周期续费" : "—");
  }
  if (els.greeting) {
    els.greeting.textContent = user.email ? `你好，${user.email.split("@")[0]}` : "欢迎回来";
  }
  if (els.sub) {
    els.sub.textContent = plan === "pro"
      ? "Pro 会员已激活，所有功能立即可用。"
      : "管理你的会员权益、绑定设备和账号设置。";
  }
}

function renderLicenseList(lic) {
  if (!els.list) return;
  const keys = Array.isArray(lic?.keys) ? lic.keys : [];
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
  const planTitle = row.plan === "pro" ? "Pro 会员" : String(row.plan || "Free");
  const statusTag = row.status === "active" ? "已激活"
    : row.status === "expired" ? "已过期"
    : row.status === "revoked" ? "已禁用"
    : row.status || "—";
  const devices = Array.isArray(row.devices) ? row.devices : [];

  // 注：row.key 是后端会员激活码（备用激活方案，普通用户用账号自动同步即可）。
  // 默认折叠到 details 里，避免页面看起来像卡密店。
  return `
    <div class="dash-license" data-key="${escapeAttr(row.key)}">
      <div class="dash-license-meta">
        <span class="dash-license-key">${escapeHtml(planTitle)}</span>
        <span class="dash-license-info">
          ${escapeHtml(statusTag)} · ${escapeHtml(expires)} · 已激活 ${devices.length} 台设备
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
      ${renderDevicesBlock(row.key, devices)}
    </div>
  `;
}

function renderDevicesBlock(key, devices) {
  if (!devices.length) {
    return `
      <details class="dash-license-devices">
        <summary>设备：暂无激活记录</summary>
      </details>
    `;
  }
  const items = devices.map((d) => `
    <div class="dash-device" data-device-id="${escapeAttr(d.id || "")}" data-fingerprint="${escapeAttr(d.fingerprint || "")}">
      <div class="dash-device-meta">
        <span class="dash-device-label">${escapeHtml(d.label || "未命名设备")}</span>
        <span class="dash-device-fp">指纹 ${escapeHtml(d.fingerprint || "—")} · 上次活跃 ${formatDateTime(d.last_seen_at)}</span>
      </div>
      <div class="dash-device-actions">
        <button class="btn btn-ghost" type="button" data-action="device-unbind" data-license-key="${escapeAttr(key)}">解绑</button>
      </div>
    </div>
  `).join("");
  return `
    <details class="dash-license-devices" open>
      <summary>设备 ${devices.length} 台（点击折叠）</summary>
      ${items}
    </details>
  `;
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
      await auth.changePassword(oldPw, newPw);
      els.changePwForm.reset();
      closeModal(els.changePwModal);
      showToast("密码已更新，下次登录请使用新密码。", "success", 4000);
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
