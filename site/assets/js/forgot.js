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
    // P0-2：worker 已支持 sent:false + reason 区分"邮件没真发出去"的运维问题
    //   - email_not_configured: 后端漏配 RESEND_API_KEY → 用户收不到邮件
    //   - email_send_failed:    Resend 接口报错或网络失败
    // 用户存在但邮件没发的分支才会到这里；不存在用户仍走 sent:true 防枚举。
    if (res?.sent === false) {
      const reason = res?.reason || "";
      const friendly =
        reason === "email_not_configured"
          ? "邮件服务暂未配置，重置链接没能发出。请联系网站管理员，或晚些再试。"
          : "邮件发送暂时失败，请稍后再试一次；如反复失败请联系网站管理员。";
      setFeedback(friendly, "error");
    } else {
      setFeedback(
        "如果该邮箱有账号，我们会发一封重置链接邮件。30 分钟内有效，记得检查垃圾邮件。",
        "success"
      );
    }
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
