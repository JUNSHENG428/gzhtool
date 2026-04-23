/**
 * reset.js — 「设置新密码」页面：调用 /api/auth/reset。
 * --------------------------------------------------------------
 * 流程：
 *   1) 从 ?token= 拿到一次性 token；缺 token 直接提示并跳「忘记密码」
 *   2) 校验两次输入一致 + 强度
 *   3) 调用 worker；worker 返回新 JWT → 立即 setToken 并跳 dashboard
 */
import { auth, setToken } from "./api.js";

const formEl = document.getElementById("resetForm");
const submitBtn = document.getElementById("submitBtn");
const newPwEl = document.getElementById("newPassword");
const newPw2El = document.getElementById("newPassword2");
const feedbackEl = document.getElementById("feedback");
const subEl = document.getElementById("resetSub");
const passwordToggleEl = document.getElementById("passwordToggle");
const passwordStrengthEl = document.getElementById("passwordStrength");
const passwordStrengthTextEl = document.getElementById("passwordStrengthText");

const params = new URLSearchParams(location.search);
const token = params.get("token") || "";

document.addEventListener("DOMContentLoaded", () => {
  if (!token) {
    setFeedback("链接缺少 token。请回到「忘记密码」重新申请。", "error");
    if (submitBtn) submitBtn.disabled = true;
    if (subEl) subEl.textContent = "未检测到有效 token";
  }
});

passwordToggleEl?.addEventListener("click", () => {
  const showing = newPwEl.type === "text";
  newPwEl.type = showing ? "password" : "text";
  newPw2El.type = newPwEl.type;
  passwordToggleEl.textContent = showing ? "显示" : "隐藏";
});

newPwEl?.addEventListener("input", () => updateStrength(newPwEl.value));

formEl?.addEventListener("submit", async (e) => {
  e.preventDefault();
  if (!token) return;
  const pw = newPwEl.value;
  const pw2 = newPw2El.value;
  if (!pw || !pw2) {
    setFeedback("请填写两次新密码。", "warning");
    return;
  }
  if (pw.length < 8) {
    setFeedback("新密码至少 8 位。", "warning");
    return;
  }
  if (pw !== pw2) {
    setFeedback("两次输入的密码不一致。", "error");
    return;
  }
  if (estimateStrength(pw).level === "weak") {
    setFeedback("密码太弱，建议加入数字 / 大写 / 符号。", "warning");
    return;
  }

  setBusy(true);
  try {
    const data = await auth.reset(token, pw);
    if (data?.token) {
      // worker 重置成功后会直接发新 JWT，自动登录 + 跳 dashboard
      setToken(data.token);
      setFeedback("密码已更新，正在跳转到控制台…", "success");
      setTimeout(() => { location.href = "./dashboard.html"; }, 500);
    } else {
      setFeedback("已重置，请使用新密码登录。", "success");
      setTimeout(() => { location.href = "./login.html"; }, 800);
    }
  } catch (error) {
    setFeedback(error?.message || "重置失败，请重新申请链接。", "error");
  } finally {
    setBusy(false);
  }
});

function setBusy(busy) {
  if (!submitBtn) return;
  submitBtn.disabled = busy;
  submitBtn.textContent = busy ? "保存中…" : "保存新密码";
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

function estimateStrength(pw) {
  let score = 0;
  if (pw.length >= 8) score++;
  if (pw.length >= 12) score++;
  if (/\d/.test(pw)) score++;
  if (/[a-z]/.test(pw) && /[A-Z]/.test(pw)) score++;
  if (/[^A-Za-z0-9]/.test(pw)) score++;
  let level = "weak";
  if (score >= 4) level = "strong";
  else if (score >= 2) level = "medium";
  return { score, level };
}

function updateStrength(pw) {
  if (!passwordStrengthEl) return;
  if (!pw) {
    passwordStrengthEl.removeAttribute("data-level");
    if (passwordStrengthTextEl) passwordStrengthTextEl.textContent = "—";
    return;
  }
  const { level } = estimateStrength(pw);
  passwordStrengthEl.dataset.level = level;
  if (passwordStrengthTextEl) {
    passwordStrengthTextEl.textContent = level === "strong" ? "强" : level === "medium" ? "中" : "弱";
  }
}
