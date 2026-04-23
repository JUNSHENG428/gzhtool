/**
 * login.js — 处理登录 / 注册表单。
 * --------------------------------------------------------------
 * 默认显示登录；点 "注册" Tab 切换到注册模式（提交时调用 /api/register，成功后自动登录）。
 *
 * 强化点：
 *   - 邮箱格式实时校验（盲点：avoid HTML5 validation 在 novalidate 下被吞）
 *   - 密码强度可视化（注册模式才显示）
 *   - 密码可见 toggle
 *   - 「记住我」：勾上 → token 存 localStorage；不勾 → 仅 sessionStorage（关浏览器即失效）
 *   - 「忘记密码」入口直接跳 /forgot.html
 *   - 错误信息友好化映射
 *
 * 登录成功后直接跳 dashboard.html。
 */
import { auth, getToken, setToken } from "./api.js";

const tabs = document.querySelectorAll(".auth-tabs button[data-tab]");
const titleEl = document.getElementById("authTitle");
const subEl = document.getElementById("authSub");
const submitBtn = document.getElementById("submitBtn");
const formEl = document.getElementById("authForm");
const emailEl = document.getElementById("email");
const emailHintEl = document.getElementById("emailHint");
const passwordEl = document.getElementById("password");
const passwordHintEl = document.getElementById("passwordHint");
const passwordToggleEl = document.getElementById("passwordToggle");
const passwordStrengthEl = document.getElementById("passwordStrength");
const passwordStrengthFillEl = document.getElementById("passwordStrengthFill"); // eslint-disable-line no-unused-vars
const passwordStrengthTextEl = document.getElementById("passwordStrengthText");
const rememberMeEl = document.getElementById("rememberMe");
const feedbackEl = document.getElementById("feedback");

// 邮箱正则：与 worker.js 的 isValidEmail 行为对齐（不强求 RFC 5322 完整覆盖）
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

let mode = "login";

document.addEventListener("DOMContentLoaded", () => {
  // 已登录直接跳 dashboard，避免重复登录
  if (getToken()) {
    location.href = "./dashboard";
    return;
  }
  if (location.search.includes("from=expired")) {
    setFeedback("登录已过期，请重新登录。", "warning");
  }
  if (location.search.includes("mode=register")) {
    setMode("register");
  }
  // 把上次填的邮箱预填回来（仅"记住我"路径，体验类增强）
  const remembered = safeReadLocal("gzh_site_remember_email");
  if (remembered) emailEl.value = remembered;
});

tabs.forEach((btn) => {
  btn.addEventListener("click", () => setMode(btn.dataset.tab));
});

// 实时邮箱校验（blur 时再提示，避免输入中途打断）
emailEl.addEventListener("blur", () => {
  const v = emailEl.value.trim();
  if (!v) {
    showEmailHint("");
    return;
  }
  if (!EMAIL_RE.test(v)) {
    showEmailHint("邮箱格式看起来不对，确认下？", "error");
  } else {
    showEmailHint("");
  }
});

passwordToggleEl?.addEventListener("click", () => {
  const showing = passwordEl.type === "text";
  passwordEl.type = showing ? "password" : "text";
  passwordToggleEl.textContent = showing ? "显示" : "隐藏";
  passwordToggleEl.setAttribute("aria-label", showing ? "显示密码" : "隐藏密码");
});

passwordEl.addEventListener("input", () => {
  if (mode !== "register") return;
  updatePasswordStrength(passwordEl.value);
});

formEl.addEventListener("submit", async (event) => {
  event.preventDefault();
  const email = emailEl.value.trim();
  const password = passwordEl.value;

  if (!email) {
    setFeedback("请填写邮箱。", "warning");
    emailEl.focus();
    return;
  }
  if (!EMAIL_RE.test(email)) {
    setFeedback("邮箱格式不正确。", "error");
    emailEl.focus();
    return;
  }
  if (!password) {
    setFeedback("请填写密码。", "warning");
    passwordEl.focus();
    return;
  }
  if (mode === "register" && password.length < 8) {
    setFeedback("密码至少 8 位。", "warning");
    passwordEl.focus();
    return;
  }
  if (mode === "register" && estimateStrength(password).level === "weak") {
    setFeedback("密码太弱，建议加入数字 / 大写 / 符号。", "warning");
    passwordEl.focus();
    return;
  }

  setBusy(true);
  try {
    const data = mode === "register"
      ? await auth.register(email, password)
      : await auth.login(email, password);
    if (data?.token) {
      setToken(data.token);
      // 「记住我」：保留邮箱（不保留密码！）
      if (rememberMeEl?.checked) {
        safeWriteLocal("gzh_site_remember_email", email);
      } else {
        safeWriteLocal("gzh_site_remember_email", "");
      }
      setFeedback(mode === "register" ? "注册成功，正在跳转…" : "登录成功，正在跳转…", "success");
      setTimeout(() => {
        location.href = "./dashboard";
      }, 380);
    } else {
      setFeedback("服务器未返回 token，请稍后重试。", "error");
    }
  } catch (error) {
    setFeedback(humanizeAuthError(error), "error");
  } finally {
    setBusy(false);
  }
});

function setMode(next) {
  mode = next === "register" ? "register" : "login";
  tabs.forEach((btn) => btn.classList.toggle("active", btn.dataset.tab === mode));
  if (mode === "register") {
    titleEl.textContent = "注册账号";
    subEl.textContent = "邮箱 + 密码即可创建，无需手机号";
    submitBtn.textContent = "注册";
    passwordEl.setAttribute("autocomplete", "new-password");
    passwordHintEl.textContent = "请使用至少 8 位密码（字母 + 数字 + 符号 更安全）。";
    passwordStrengthEl.hidden = false;
    updatePasswordStrength(passwordEl.value);
  } else {
    titleEl.textContent = "登录";
    subEl.textContent = "使用注册时的邮箱和密码登录";
    submitBtn.textContent = "登录";
    passwordEl.setAttribute("autocomplete", "current-password");
    passwordHintEl.textContent = "如果忘记了，可以通过邮箱重置。";
    passwordStrengthEl.hidden = true;
  }
  setFeedback("");
}

function setBusy(busy) {
  submitBtn.disabled = busy;
  submitBtn.textContent = busy
    ? (mode === "register" ? "注册中…" : "登录中…")
    : (mode === "register" ? "注册" : "登录");
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

function showEmailHint(text, tone) {
  if (!emailHintEl) return;
  if (!text) {
    emailHintEl.hidden = true;
    emailHintEl.textContent = "";
    return;
  }
  emailHintEl.hidden = false;
  emailHintEl.textContent = text;
  emailHintEl.dataset.tone = tone || "muted";
}

/**
 * 密码强度评估：
 *   - 4 个维度：长度、是否含数字、是否含大小写混合、是否含符号。
 *   - 综合得分 → weak / medium / strong。
 *   - 不上传服务端，纯 UI 提示，启发用户使用更强密码。
 */
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

function updatePasswordStrength(pw) {
  if (!passwordStrengthEl) return;
  if (!pw) {
    passwordStrengthEl.removeAttribute("data-level");
    passwordStrengthTextEl.textContent = "—";
    return;
  }
  const { level } = estimateStrength(pw);
  passwordStrengthEl.dataset.level = level;
  passwordStrengthTextEl.textContent = level === "strong" ? "强" : level === "medium" ? "中" : "弱";
}

/**
 * 把 worker 抛出的错误信息再加一层"友好化映射"。
 * worker 已经返回中文 error，我们这里只对常见情况补充上下文。
 */
function humanizeAuthError(error) {
  const message = error?.message || "操作失败";
  if (error?.status === 409) return "该邮箱已注册，可直接登录或点「忘记密码」找回。";
  if (error?.status === 401) return "邮箱或密码错误，确认下大小写。";
  if (error?.kind === "network") return "网络异常，请检查网络后重试。";
  return message;
}

function safeReadLocal(key) {
  try { return localStorage.getItem(key) || ""; } catch { return ""; }
}
function safeWriteLocal(key, value) {
  try {
    if (value) localStorage.setItem(key, value);
    else localStorage.removeItem(key);
  } catch { /* ignore */ }
}
