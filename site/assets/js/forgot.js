/**
 * forgot.js — 「忘记密码」页面：调用 /api/auth/request-reset。
 * --------------------------------------------------------------
 * 安全策略：
 *   - 不论邮箱存在与否，都给出"已发送"反馈，防止账号枚举
 *   - 同 IP 限速由 worker 兜底（worker 端 rateLimit）
 *   - 提交成功后禁用表单 60s，避免连点
 */
import { auth } from "./api.js";

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const formEl = document.getElementById("forgotForm");
const submitBtn = document.getElementById("submitBtn");
const emailEl = document.getElementById("email");
const feedbackEl = document.getElementById("feedback");

formEl?.addEventListener("submit", async (e) => {
  e.preventDefault();
  const email = emailEl.value.trim();
  if (!email || !EMAIL_RE.test(email)) {
    setFeedback("请输入有效邮箱。", "warning");
    emailEl.focus();
    return;
  }
  setBusy(true);
  try {
    const res = await auth.requestReset(email);
    // 39th 续³ Phase 5 加固 · 关闭枚举漏洞（worker 永远返 sent:true 不区分用户是否存在
    // / 邮件是否发成功）。原 P0-2 sent:false + reason 已被废弃 —— 攻击者可枚举哪些邮箱
    // 已注册（已注册 + Resend 故障返 sent:false vs 未注册返 sent:true）。
    // UX 取舍：Resend 故障时用户看到"已发送"但收不到邮件 → 让用户自己重试 / 检查垃圾邮件 /
    // 联系 support；运维侧需监控 Resend 失败率（worker console.error 已记录）。
    setFeedback(
      "如果该邮箱有账号，我们会发一封重置链接邮件。30 分钟内有效，记得检查垃圾邮件；如长时间未收到请联系 support@docuearn.com。",
      "success"
    );
    // DEBUG 模式下 worker 会顺便把 resetUrl 直接返回前端（仅 ENVIRONMENT=development
    // 且 DEBUG_RESET=1 同时成立时；生产恒为空），方便联调。
    if (res?.resetUrl) {
      const link = document.createElement("a");
      link.href = res.resetUrl;
      link.textContent = "🛠 调试模式直链：点这里直接进入重置页";
      link.style.display = "block";
      link.style.marginTop = "10px";
      feedbackEl.appendChild(link);
    }
    cooldownSubmit(60);
  } catch (error) {
    setFeedback(error?.message || "发送失败，请稍后再试。", "error");
  } finally {
    setBusy(false);
  }
});

function setBusy(busy) {
  if (!submitBtn) return;
  submitBtn.disabled = busy;
  if (busy) submitBtn.textContent = "发送中…";
  else if (!submitBtn.dataset.cooldown) submitBtn.textContent = "发送重置链接";
}

function cooldownSubmit(seconds) {
  if (!submitBtn) return;
  submitBtn.disabled = true;
  submitBtn.dataset.cooldown = "1";
  let left = seconds;
  submitBtn.textContent = `${left}s 后可重发`;
  const t = setInterval(() => {
    left -= 1;
    if (left <= 0) {
      clearInterval(t);
      submitBtn.disabled = false;
      delete submitBtn.dataset.cooldown;
      submitBtn.textContent = "发送重置链接";
    } else {
      submitBtn.textContent = `${left}s 后可重发`;
    }
  }, 1000);
}

function setFeedback(text, tone) {
  if (!feedbackEl) return;
  if (!text) {
    feedbackEl.classList.remove("show");
    feedbackEl.textContent = "";
    return;
  }
  feedbackEl.dataset.tone = tone || "muted";
  feedbackEl.textContent = text;
  feedbackEl.classList.add("show");
}
