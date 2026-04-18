// Apply theme preference
(function applyThemePreference() {
  try {
    const preference = localStorage.getItem("workspace-theme-preference") || "auto";
    const prefersDark = window.matchMedia("(prefers-color-scheme: dark)").matches;
    const isDark = preference === "dark" || (preference === "auto" && prefersDark);
    document.documentElement.setAttribute("data-theme", isDark ? "dark" : "light");
  } catch {
    // ignore
  }
})();

import { DEFAULT_SETTINGS } from "../shared/defaults.js";
import { clearHistory, listSnapshots } from "../shared/history.js";
import { getSettings, saveSettings } from "../shared/storage.js";
import { formatRuntimeError } from "../shared/utils.js";

const fields = {
  productName: document.querySelector("#productName"),
  operatorName: document.querySelector("#operatorName"),
  supportEmail: document.querySelector("#supportEmail"),
  officialSiteUrl: document.querySelector("#officialSiteUrl"),
  apiBaseUrl: document.querySelector("#apiBaseUrl"),
  apiKey: document.querySelector("#apiKey"),
  model: document.querySelector("#model"),
  temperature: document.querySelector("#temperature"),
  defaultAudience: document.querySelector("#defaultAudience"),
  defaultTone: document.querySelector("#defaultTone"),
  defaultAngle: document.querySelector("#defaultAngle"),
  defaultCta: document.querySelector("#defaultCta"),
  wechatAppId: document.querySelector("#wechatAppId"),
  wechatAppSecret: document.querySelector("#wechatAppSecret"),
  wechatDefaultAuthor: document.querySelector("#wechatDefaultAuthor"),
  wechatDefaultSourceUrl: document.querySelector("#wechatDefaultSourceUrl"),
  wechatDefaultPublishMode: document.querySelector("#wechatDefaultPublishMode"),
  wechatDefaultOpenComment: document.querySelector("#wechatDefaultOpenComment"),
  wechatDefaultOnlyFansCanComment: document.querySelector("#wechatDefaultOnlyFansCanComment"),
  rsshubBaseUrl: document.querySelector("#rsshubBaseUrl")
};

const statusElement = document.querySelector("#status");
let statusFadeTimer = null;
const testConnectionButton = document.querySelector("#testConnectionButton");
const testConnectionResult = document.querySelector("#testConnectionResult");
const testWechatConnectionButton = document.querySelector("#testWechatConnectionButton");
const testWechatConnectionResult = document.querySelector("#testWechatConnectionResult");
const exportHistoryButton = document.querySelector("#exportHistoryButton");
const clearHistoryButton = document.querySelector("#clearHistoryButton");

document.querySelector("#saveButton").addEventListener("click", saveForm);
document.querySelector("#resetButton").addEventListener("click", resetForm);
testConnectionButton.addEventListener("click", testAiConnection);
testWechatConnectionButton.addEventListener("click", testWechatConnection);
exportHistoryButton.addEventListener("click", exportAllHistory);
clearHistoryButton.addEventListener("click", clearAllHistory);

const profileFields = {
  name: document.querySelector("#profileName"),
  appId: document.querySelector("#profileAppId"),
  appSecret: document.querySelector("#profileAppSecret"),
  author: document.querySelector("#profileAuthor")
};
const profilesContainer = document.querySelector("#wechatProfilesContainer");
let currentProfiles = [];

document.querySelector("#addProfileButton")?.addEventListener("click", addProfile);
document.querySelector("#openWelcomePage").addEventListener("click", () =>
  openInternalPage("src/pages/welcome.html")
);
document.querySelector("#openHotTopicsPage").addEventListener("click", () =>
  openInternalPage("src/pages/hot-topics.html")
);
document.querySelector("#openHelpPage").addEventListener("click", () =>
  openInternalPage("src/pages/help.html")
);
document.querySelector("#openPermissionsPage").addEventListener("click", () =>
  openInternalPage("src/pages/permissions.html")
);
document.querySelector("#openPrivacyPage").addEventListener("click", () =>
  openInternalPage("src/pages/privacy.html")
);
document.querySelector("#openTermsPage").addEventListener("click", () =>
  openInternalPage("src/pages/terms.html")
);

[fields.apiBaseUrl, fields.apiKey, fields.model].forEach((field) => {
  field.addEventListener("input", () => clearTestResult(testConnectionResult));
});

[fields.wechatAppId, fields.wechatAppSecret].forEach((field) => {
  field.addEventListener("input", () => clearTestResult(testWechatConnectionResult));
});

await hydrateForm();

async function hydrateForm() {
  const settings = await getSettings();
  for (const [key, field] of Object.entries(fields)) {
    if (field.type === "checkbox") {
      field.checked = Boolean(settings[key]);
      continue;
    }
    field.value = settings[key] ?? "";
  }
  currentProfiles = Array.isArray(settings.wechatProfiles) ? settings.wechatProfiles : [];
  renderProfiles();
}

async function saveForm() {
  const invalidFields = [];

  for (const [key, field] of Object.entries(fields)) {
    if (!field.checkValidity || field.checkValidity()) continue;
    const label = field.closest("label")?.querySelector("span")?.textContent || key;
    invalidFields.push(label);
  }

  if (invalidFields.length > 0) {
    setStatus(`请检查以下字段：${invalidFields.join("、")}`, "error");
    invalidFields.forEach((label) => {
      const field = Object.values(fields).find((f) => f.closest("label")?.querySelector("span")?.textContent === label);
      field?.focus();
    });
    return;
  }

  const patch = {};
  for (const [key, field] of Object.entries(fields)) {
    if (field.type === "checkbox") {
      patch[key] = field.checked;
    } else if (field.type === "number") {
      patch[key] = Number(field.value);
    } else {
      patch[key] = field.value.trim();
    }
  }
  patch.wechatProfiles = currentProfiles;

  try {
    await saveSettings(patch);
    setStatus("设置已保存。", "success");
  } catch (error) {
    setStatus(error?.message || "保存失败，请稍后再试。", "error");
  }
}

async function resetForm() {
  if (
    !confirm(
      "确定将所有设置恢复为默认值？将清除已填写的 API 与公众号凭证等信息（草稿历史不受影响）。"
    )
  ) {
    return;
  }
  await saveSettings(DEFAULT_SETTINGS);
  await hydrateForm();
  clearTestResult(testConnectionResult);
  clearTestResult(testWechatConnectionResult);
  setStatus("已恢复默认设置。", "success");
}

function setStatus(message, type = "info", { persist = false } = {}) {
  clearTimeout(statusFadeTimer);
  const validTypes = new Set(["info", "success", "warning", "error"]);
  const safeType = validTypes.has(type) ? type : "info";
  statusElement.textContent = message;
  statusElement.setAttribute("data-status-type", safeType);
  statusElement.classList.remove("is-faded");

  if (persist || !message) return;

  const delayMs = safeType === "error" ? 8000 : 4000;
  statusFadeTimer = setTimeout(() => {
    statusElement.classList.add("is-faded");
  }, delayMs);
}

async function openInternalPage(path) {
  await chrome.tabs.create({ url: chrome.runtime.getURL(path) });
}

async function testAiConnection() {
  testConnectionButton.disabled = true;
  setTestResult(testConnectionResult, "loading", "测试中...");

  try {
    const response = await chrome.runtime.sendMessage({
      type: "TEST_AI_CONNECTION",
      payload: {
        baseUrl: fields.apiBaseUrl.value.trim(),
        apiKey: fields.apiKey.value.trim(),
        model: fields.model.value.trim()
      }
    });

    if (response?.ok) {
      setTestResult(
        testConnectionResult,
        "success",
        `连接成功，延迟 ${Number(response.latencyMs || 0)} ms，模型 ${response.model || fields.model.value.trim() || "-"}`
      );
      return;
    }

    setTestResult(
      testConnectionResult,
      "error",
      formatRuntimeError(response?.error, "连接失败，请检查配置。")
    );
  } catch (error) {
    setTestResult(testConnectionResult, "error", error.message || "连接失败，请稍后再试。");
  } finally {
    testConnectionButton.disabled = false;
  }
}

async function testWechatConnection() {
  testWechatConnectionButton.disabled = true;
  setTestResult(testWechatConnectionResult, "loading", "测试中...");

  try {
    const response = await chrome.runtime.sendMessage({
      type: "TEST_WECHAT_CONNECTION",
      payload: {
        appId: fields.wechatAppId.value.trim(),
        appSecret: fields.wechatAppSecret.value.trim()
      }
    });

    if (response?.ok) {
      setTestResult(
        testWechatConnectionResult,
        "success",
        "凭证有效，发布时将自动使用"
      );
      return;
    }

    const error = response?.error || {};

    if (error.code === "WECHAT_IP_NOT_WHITELISTED" && error.ipSeen) {
      setWechatTestResultIpWhitelistError(testWechatConnectionResult, error);
      return;
    }

    setTestResult(
      testWechatConnectionResult,
      "error",
      formatRuntimeError(error, "验证失败，请检查公众号配置。")
    );
  } catch (error) {
    setTestResult(
      testWechatConnectionResult,
      "error",
      error.message || "验证失败，请稍后再试。"
    );
  } finally {
    testWechatConnectionButton.disabled = false;
  }
}

function setWechatTestResultIpWhitelistError(element, error) {
  element.dataset.state = "error";
  element.replaceChildren();

  const main = document.createElement("div");
  main.className = "wechat-test-err-main";
  main.textContent = formatRuntimeError(error, "验证失败，请检查公众号配置。");

  const copyBtn = document.createElement("button");
  copyBtn.type = "button";
  copyBtn.className = "wechat-test-ip-copy";
  copyBtn.textContent = `当前出口 IP：${error.ipSeen}（点击复制）`;

  copyBtn.addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText(error.ipSeen);
      copyBtn.textContent = `已复制：${error.ipSeen}`;
    } catch {
      copyBtn.textContent = "复制失败，请手动选择 IP";
    }
  });

  element.append(main, copyBtn);
}

function setTestResult(element, state, message) {
  element.dataset.state = state;
  element.textContent = message;
}

function clearTestResult(element) {
  delete element.dataset.state;
  element.replaceChildren();
}

async function exportAllHistory() {
  exportHistoryButton.disabled = true;

  try {
    const historyEntries = await listSnapshots();
    if (historyEntries.length === 0) {
      setStatus("还没有可导出的草稿记录。", "warning");
      return;
    }

    const payload = {
      version: 1,
      exportedAt: new Date().toISOString(),
      history: historyEntries
    };
    const stamp = new Date()
      .toISOString()
      .replace(/[-:]/g, "")
      .replace(/\.\d{3}Z$/, "")
      .replace("T", "-");
    const blob = new Blob([JSON.stringify(payload, null, 2)], {
      type: "application/json;charset=utf-8"
    });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `draft-history-${stamp}.json`;
    anchor.click();
    URL.revokeObjectURL(url);

    setStatus(`已导出 ${historyEntries.length} 条草稿记录。`, "success");
  } catch (error) {
    setStatus(error.message || "导出失败，请稍后再试。", "error");
  } finally {
    exportHistoryButton.disabled = false;
  }
}

async function clearAllHistory() {
  clearHistoryButton.disabled = true;

  try {
    const historyEntries = await listSnapshots();
    if (historyEntries.length === 0) {
      setStatus("还没有可清空的草稿记录。", "warning");
      return;
    }

    if (
      !confirm(
        `确定清空全部 ${historyEntries.length} 条本地草稿历史？此操作不可恢复。`
      )
    ) {
      return;
    }

    const cleared = await clearHistory();
    setStatus(
      cleared ? "已清空所有草稿记录。" : "清空失败，请稍后再试。",
      cleared ? "success" : "error"
    );
  } catch (error) {
    setStatus(error.message || "清空失败，请稍后再试。", "error");
  } finally {
    clearHistoryButton.disabled = false;
  }
}

function renderProfiles() {
  if (!profilesContainer) return;
  if (currentProfiles.length === 0) {
    profilesContainer.innerHTML = '<p class="profiles-empty">还没有添加任何公众号账号。上方填写后点「添加账号」即可保存多套凭证。</p>';
    return;
  }

  profilesContainer.innerHTML = currentProfiles.map((profile, index) => `
    <div class="profile-card">
      <div class="profile-info">
        <strong>${escapeHtml(profile.name || `账号 ${index + 1}`)}</strong>
        <span>AppID: ${escapeHtml(profile.appId)}</span>
        <span>作者: ${escapeHtml(profile.author || "-")}</span>
      </div>
      <button type="button" class="ghost" data-delete-profile="${index}">删除</button>
    </div>
  `).join("");

  profilesContainer.querySelectorAll("[data-delete-profile]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const idx = Number(btn.dataset.deleteProfile);
      currentProfiles.splice(idx, 1);
      renderProfiles();
      setStatus("账号已删除，记得点「保存设置」才会生效。", "warning");
    });
  });
}

async function addProfile() {
  const name = profileFields.name?.value.trim();
  const appId = profileFields.appId?.value.trim();
  const appSecret = profileFields.appSecret?.value.trim();
  const author = profileFields.author?.value.trim();

  if (!name || !appId || !appSecret) {
    setStatus("请填写账号名称、AppID 和 AppSecret。", "error");
    return;
  }

  currentProfiles.push({ name, appId, appSecret, author });

  profileFields.name.value = "";
  profileFields.appId.value = "";
  profileFields.appSecret.value = "";
  profileFields.author.value = "";

  renderProfiles();
  try {
    await saveSettings({ wechatProfiles: currentProfiles });
    setStatus(`已添加账号 "${name}"。`, "success");
  } catch (error) {
    setStatus(error?.message || "保存失败，请稍后再试。", "error");
  }
}

function escapeHtml(value) {
  return String(value || "")
    .replace(/\u0026/g, "\u0026amp;")
    .replace(/\u003c/g, "\u0026lt;")
    .replace(/\u003e/g, "\u0026gt;")
    .replace(/"/g, "\u0026quot;")
    .replace(/'/g, "\u0026#39;");
}
