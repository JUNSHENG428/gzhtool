/**
 * 站点共享脚本：高亮当前导航 + 头部账号入口动态切换。
 * 各页 <script type="module" src="./assets/js/site.js"></script> 引入即可。
 */

import { auth, getToken, clearToken } from "./api.js";

document.addEventListener("DOMContentLoaded", () => {
  highlightActiveNav();
  void renderNavCta();
  initScrollReveal();
});

/**
 * 滚动揭示：给 .reveal 元素挂 IntersectionObserver，进入视口加 .is-visible。
 * - 只触发一次（unobserve），避免来回滚动反复闪。
 * - prefers-reduced-motion 用户直接全部显示，不做任何动画。
 * - JS 不可用时由 CSS 的 `.no-js .reveal` 兜底（HTML 上加 `<html class="no-js">`，
 *   site.js 顶部立刻去掉 no-js 类）。
 */
function initScrollReveal() {
  const root = document.documentElement;
  root.classList.remove("no-js");
  const els = document.querySelectorAll(".reveal");
  if (!els.length) return;

  const reduced = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
  if (reduced || typeof IntersectionObserver === "undefined") {
    els.forEach((el) => el.classList.add("is-visible"));
    return;
  }

  const io = new IntersectionObserver(
    (entries) => {
      entries.forEach((entry) => {
        if (entry.isIntersecting) {
          entry.target.classList.add("is-visible");
          io.unobserve(entry.target);
        }
      });
    },
    { rootMargin: "0px 0px -8% 0px", threshold: 0.08 }
  );
  els.forEach((el) => io.observe(el));
}

function highlightActiveNav() {
  const path = location.pathname.split("/").pop() || "index.html";
  const links = document.querySelectorAll(".site-nav-links a");
  links.forEach((a) => {
    const href = a.getAttribute("href") || "";
    if (href === path || (path === "" && href === "index.html")) {
      a.classList.add("active");
    }
  });
}

async function renderNavCta() {
  const cta = document.querySelector(".site-nav-cta");
  if (!cta) return;
  const token = getToken();
  if (!token) {
    cta.innerHTML = `
      <a class="btn btn-ghost" href="./login">登录</a>
      <a class="btn btn-primary" href="./pricing">购买 Pro</a>
    `;
    return;
  }
  try {
    const data = await auth.me();
    const email = data?.user?.email || "我的账号";
    cta.innerHTML = `
      <a class="btn btn-ghost" href="./dashboard" title="${escapeAttr(email)}">控制台</a>
      <button class="btn btn-primary" type="button" data-action="logout">退出</button>
    `;
    cta.querySelector('[data-action="logout"]')?.addEventListener("click", () => {
      clearToken();
      location.reload();
    });
  } catch {
    // token 失效已经被 api.js 处理（自动跳转），这里直接显示未登录
    cta.innerHTML = `
      <a class="btn btn-ghost" href="./login">登录</a>
      <a class="btn btn-primary" href="./pricing">购买 Pro</a>
    `;
  }
}

function escapeAttr(value) {
  return String(value || "").replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
}
