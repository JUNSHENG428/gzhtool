import { DEFAULT_SETTINGS } from "../shared/defaults.js";
import { getSettings } from "../shared/storage.js";

const runtimeAvailable = Boolean(globalThis.chrome?.runtime?.id);
const settings = runtimeAvailable ? await getSettings().catch(() => DEFAULT_SETTINGS) : DEFAULT_SETTINGS;
const manifest = runtimeAvailable ? chrome.runtime.getManifest() : { version: "web-preview" };

hydrateTextFields();
bindActions();

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
