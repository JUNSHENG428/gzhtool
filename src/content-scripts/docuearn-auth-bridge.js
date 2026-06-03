/**
 * docuearn-auth-bridge.js —— 官网 → 插件 登录态自动同步桥
 *
 * 背景：插件登录态（JWT）存在扩展自己的 chrome.storage，网站登录态存在
 * docuearn.com 的 localStorage（key=gzh_site_token，见 site/assets/js/api.js）。
 * 两者是各自独立的会话，浏览器扩展默认读不到网站 cookie/localStorage 的另一侧，
 * 导致「在官网注册/登录后，插件这边没同步」。
 *
 * 本桥的做法（注入在 docuearn.com，与页面同源，可直接读页面 localStorage）：
 *   1. 页面加载后读取 gzh_site_token；
 *   2. 有值就发给 service-worker（DOCUEARN_AUTH_HANDOFF），由 SW 验证 + 落库；
 *   3. 登录通常会跳转到 /dashboard，新页面加载时本脚本会再次读到 token 完成同步；
 *      为兜底「同页登录（未跳转）」与异步写入，加一段有限轮询 + 可见性/聚焦时复查。
 *
 * 为什么不用 externally_connectable + sendMessage(extId)：
 *   那条路要求网站知道扩展 ID，而扩展未上架时 unpacked ID 不稳定、上架后才固定，
 *   还要在网站侧维护 ID 列表。content script 读同源 localStorage 不需要扩展 ID，
 *   moving parts 更少、unpacked/已上架都能用。安全边界：脚本只注入 docuearn.com，
 *   只读它自己已经持有的 token，转交给本扩展自己的 SW（SW 再调 /api/me 验真）。
 *
 * 隐私/安全：只「同步进来」（登录），从不因网站登出而清掉插件登录态——插件登录是
 * 独立会话，可能用户在插件里单独登录着。token 只发给本扩展 SW，不外泄。
 */

(function () {
  "use strict";

  const TOKEN_KEY = "gzh_site_token"; // 必须与 site/assets/js/api.js 的 TOKEN_KEY 一致
  const POLL_INTERVAL_MS = 1500;
  const POLL_MAX = 8; // 最多轮询 ~12s，覆盖同页登录后跳转前的窗口
  let lastSent = ""; // 本页已上报过的 token，去重避免刷屏

  function readToken() {
    try {
      return (
        localStorage.getItem(TOKEN_KEY) ||
        sessionStorage.getItem(TOKEN_KEY) ||
        ""
      ).trim();
    } catch {
      return "";
    }
  }

  function syncIfNeeded() {
    const token = readToken();
    if (!token || token === lastSent) return;
    lastSent = token;
    try {
      chrome.runtime.sendMessage(
        { type: "DOCUEARN_AUTH_HANDOFF", token },
        () => {
          // 吞掉 chrome.runtime.lastError（SW 未就绪 / 已卸载时不报错）
          void chrome.runtime?.lastError;
        }
      );
    } catch {
      // 扩展上下文失效（如刚更新）时静默
    }
  }

  // 1) 首次：页面 idle 时立刻读一次
  syncIfNeeded();

  // 2) 有限轮询：兜底同页登录（setToken 后还没跳转）+ 异步写入
  let polls = 0;
  const timer = setInterval(() => {
    polls += 1;
    syncIfNeeded();
    if (polls >= POLL_MAX || lastSent) clearInterval(timer);
  }, POLL_INTERVAL_MS);

  // 3) 切回标签 / 重新聚焦时复查（用户可能在别处登录后切回）
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") syncIfNeeded();
  });
  window.addEventListener("focus", syncIfNeeded);

  // 4) 站点若主动派发 auth 变化事件（未来增强），也即时同步
  window.addEventListener("docuearn:auth-changed", syncIfNeeded);
})();
