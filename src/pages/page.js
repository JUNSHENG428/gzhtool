import { DEFAULT_SETTINGS } from "../shared/defaults.js";
import { getSettings } from "../shared/storage.js";
import { escapeHtml } from "../shared/utils.js";

const runtimeAvailable = Boolean(globalThis.chrome?.runtime?.id);
const settings = runtimeAvailable ? await getSettings().catch(() => DEFAULT_SETTINGS) : DEFAULT_SETTINGS;
const manifest = runtimeAvailable ? chrome.runtime.getManifest() : { version: "web-preview" };

// Single source of truth for last-updated date across legal/help pages
export const LAST_UPDATED_AT = "2026-04-22";

// Unified topnav: 5 core pages
const TOPNAV_ITEMS = [
  { id: "welcome", href: "./welcome.html", label: "欢迎" },
  { id: "hot-topics", href: "./hot-topics.html", label: "热点捕捉" },
  { id: "agent", href: "./agent.html", label: "AI 选题代笔" },
  { id: "workspace", action: "open-workspace", label: "编辑台" },
  { id: "help", href: "./help.html", label: "帮助中心" },
  { id: "options", action: "open-options", label: "设置" }
];

// Footer secondary links: legal pages
const FOOTER_LINKS = [
  { href: "./permissions.html", label: "权限说明" },
  { href: "./privacy.html", label: "隐私政策" },
  { href: "./terms.html", label: "服务条款" }
];

renderTopnav();
renderPageFooter();
hydrateTextFields();
bindActions();

function renderTopnav() {
  const containers = document.querySelectorAll("[data-topnav]");
  if (containers.length === 0) return;

  const currentPage = document.documentElement.dataset.page || "";

  containers.forEach((container) => {
    container.innerHTML = "";
    for (const item of TOPNAV_ITEMS) {
      const node = document.createElement(item.action ? "button" : "a");
      node.className = "topnav-link";
      node.textContent = item.label;
      if (item.href) {
        node.href = item.href;
      }
      if (item.action) {
        node.type = "button";
        node.dataset.action = item.action;
      }
      if (item.id === currentPage) {
        node.setAttribute("aria-current", "page");
      }
      container.appendChild(node);
    }
  });
}

function renderPageFooter() {
  const containers = document.querySelectorAll("[data-page-footer]");
  if (containers.length === 0) return;

  containers.forEach((container) => {
    container.innerHTML = "";

    const linkRow = document.createElement("div");
    linkRow.className = "page-footer-links";
    for (const link of FOOTER_LINKS) {
      const a = document.createElement("a");
      a.href = link.href;
      a.textContent = link.label;
      a.className = "page-footer-link";
      linkRow.appendChild(a);
    }
    container.appendChild(linkRow);

    const meta = document.createElement("div");
    meta.className = "page-footer-meta muted";
    meta.innerHTML = `版本 <span data-version>${escapeHtml(manifest.version)}</span> · 最后更新 <span data-last-updated>${escapeHtml(LAST_UPDATED_AT)}</span>`;
    container.appendChild(meta);
  });
}

function hydrateTextFields() {
  document.querySelectorAll("[data-product-name]").forEach((node) => {
    node.textContent = valueOrFallback(settings.productName, DEFAULT_SETTINGS.productName);
  });

  document.querySelectorAll("[data-operator-name]").forEach((node) => {
    const value = valueOrFallback(settings.operatorName, "请先在设置页填写运营主体");
    node.textContent = value;
    node.classList.toggle("placeholder", !settings.operatorName?.trim());
  });

  document.querySelectorAll("[data-support-email]").forEach((node) => {
    const email = settings.supportEmail?.trim();
    if (email) {
      node.textContent = email;
      if (node.tagName === "A") {
        node.href = `mailto:${email}`;
      }
      return;
    }

    node.textContent = "请先在设置页填写客服邮箱";
    node.classList.add("placeholder");
    if (node.tagName === "A") {
      node.removeAttribute("href");
    }
  });

  document.querySelectorAll("[data-site-url]").forEach((node) => {
    const url = settings.officialSiteUrl?.trim();
    if (url) {
      node.textContent = url;
      if (node.tagName === "A") {
        node.href = url;
      }
      return;
    }

    node.textContent = "未设置官网";
    node.classList.add("placeholder");
    if (node.tagName === "A") {
      node.removeAttribute("href");
    }
  });

  document.querySelectorAll("[data-version]").forEach((node) => {
    node.textContent = manifest.version;
  });

  document.querySelectorAll("[data-last-updated]").forEach((node) => {
    if (!node.textContent.trim()) {
      node.textContent = LAST_UPDATED_AT;
    }
  });
}

function bindActions() {
  document.querySelectorAll("[data-runtime-only]").forEach((node) => {
    node.hidden = !runtimeAvailable;
  });

  document.querySelectorAll("[data-action]").forEach((button) => {
    button.addEventListener("click", async () => {
      if (!runtimeAvailable) {
        return;
      }

      const action = button.dataset.action;
      if (action === "open-options") {
        await chrome.runtime.openOptionsPage();
        return;
      }

      if (action === "open-workspace") {
        await chrome.tabs.create({
          url: chrome.runtime.getURL("src/workspace/workspace.html")
        });
        return;
      }
    });
  });
}

function valueOrFallback(value, fallback) {
  const text = String(value || "").trim();
  return text || fallback;
}
