import { applyThemePreferenceFromStorage } from "../shared/theme.js";

applyThemePreferenceFromStorage();

import { DEFAULT_SETTINGS } from "../shared/defaults.js";
import { clearHistory, listSnapshots } from "../shared/history.js";
import { getSettings, saveSettings } from "../shared/storage.js";
import { formatRuntimeError, escapeHtml } from "../shared/utils.js";

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
  wechatDefaultOnlyFansCanComment: document.querySelector("#wechatDefaultOnlyFansCanComment")
};

const statusElement = document.querySelector("#status");
const testConnectionButton = document.querySelector("#testConnectionButton");
const testConnectionResult = document.querySelector("#testConnectionResult");
const testWechatConnectionButton = document.querySelector("#testWechatConnectionButton");
const testWechatConnectionResult = document.querySelector("#testWechatConnectionResult");
const exportHistoryButton = document.querySelector("#exportHistoryButton");
const clearHistoryButton = document.querySelector("#clearHistoryButton");

document.querySelector("#saveButton").addEventListener("click", saveForm);
document.querySelector("#resetAiButton")?.addEventListener("click", () =>
  resetSection("ai")
);
document.querySelector("#resetWechatButton")?.addEventListener("click", () =>
  resetSection("wechat")
);
document.querySelector("#resetPreferencesButton")?.addEventListener("click", () =>
  resetSection("preferences")
);
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
    setStatus(`请检查以下字段：${invalidFields.join("、")}`);
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

  await saveSettings(patch);
  setStatus("设置已保存。");
}

const SECTION_KEYS = {
  ai: ["apiBaseUrl", "apiKey", "model", "temperature"],
  wechat: [
    "wechatAppId",
    "wechatAppSecret",
    "wechatDefaultAuthor",
    "wechatDefaultSourceUrl",
    "wechatDefaultPublishMode",
    "wechatDefaultOpenComment",
    "wechatDefaultOnlyFansCanComment"
  ],
  preferences: [
    "defaultAudience",
    "defaultTone",
    "defaultAngle",
    "defaultCta"
  ]
};

const SECTION_LABELS = {
  ai: "AI 接口",
  wechat: "公众号凭证",
  preferences: "改写偏好"
};

async function resetSection(section) {
  const keys = SECTION_KEYS[section];
  if (!keys) return;
  const label = SECTION_LABELS[section];
  if (!confirm(`确定要重置「${label}」为默认值？多账号列表与其它分区不会被影响。`)) {
    return;
  }
  const settings = await getSettings();
  const patch = { ...settings };
  for (const key of keys) {
    patch[key] = DEFAULT_SETTINGS[key];
  }
  await saveSettings(patch);
  await hydrateForm();
  if (section === "ai") clearTestResult(testConnectionResult);
  if (section === "wechat") clearTestResult(testWechatConnectionResult);
  setStatus(`已重置「${label}」。`);
}

function setStatus(message) {
  statusElement.textContent = message;
}

async function openInternalPage(path) {
  await chrome.tabs.create({ url: chrome.runtime.getURL(path) });
}

async function testAiConnection() {
  testConnectionButton.disabled = true;
  setTestResult(testConnectionResult, "loading", "正在测试...");

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
  setTestResult(testWechatConnectionResult, "loading", "正在测试...");

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
        "验证成功，token 将在发布时使用"
      );
      return;
    }

    setTestResult(
      testWechatConnectionResult,
      "error",
      formatRuntimeError(response?.error, "验证失败，请检查公众号配置。")
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

function setTestResult(element, state, message) {
  element.dataset.state = state;
  element.textContent = message;
}

function clearTestResult(element) {
  delete element.dataset.state;
  element.textContent = "";
}

async function exportAllHistory() {
  exportHistoryButton.disabled = true;

  try {
    const historyEntries = await listSnapshots();
    if (historyEntries.length === 0) {
      setStatus("还没有可导出的草稿记录。");
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

    setStatus(`已导出 ${historyEntries.length} 条草稿记录。`);
  } catch (error) {
    setStatus(error.message || "导出失败，请稍后再试。");
  } finally {
    exportHistoryButton.disabled = false;
  }
}

async function clearAllHistory() {
  clearHistoryButton.disabled = true;

  try {
    const historyEntries = await listSnapshots();
    if (historyEntries.length === 0) {
      setStatus("还没有可清空的草稿记录。");
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
    setStatus(cleared ? "已清空所有草稿记录。" : "清空失败，请稍后再试。");
  } catch (error) {
    setStatus(error.message || "清空失败，请稍后再试。");
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
      setStatus("账号已删除，记得点「保存设置」才会生效。");
    });
  });
}

async function addProfile() {
  const name = profileFields.name?.value.trim();
  const appId = profileFields.appId?.value.trim();
  const appSecret = profileFields.appSecret?.value.trim();
  const author = profileFields.author?.value.trim();

  if (!name || !appId || !appSecret) {
    setStatus("请填写账号名称、AppID 和 AppSecret。");
    return;
  }

  currentProfiles.push({ name, appId, appSecret, author });

  profileFields.name.value = "";
  profileFields.appId.value = "";
  profileFields.appSecret.value = "";
  profileFields.author.value = "";

  renderProfiles();
  await saveSettings({ wechatProfiles: currentProfiles });
  setStatus(`账号「${name}」已添加并保存。`);
}
