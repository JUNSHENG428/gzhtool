import { DEFAULT_SETTINGS } from "../shared/defaults.js";
import { clearHistory, listSnapshots } from "../shared/history.js";
import {
  PROVIDER_PRESETS,
  CUSTOM_PROVIDER_KEY,
  DEFAULT_PROVIDER_KEY,
  findProviderByBaseUrl,
  getProviderByKey
} from "../shared/providers.js";
import { getSettings, saveSettings } from "../shared/storage.js";
import { formatRuntimeError, escapeHtml } from "../shared/utils.js";
import { originPatternFromUrl } from "../shared/host-permissions.js";
import {
  normalizeDrissionHelperToken,
  parseDrissionHelperInput
} from "../shared/drission.js";
import { initPromptTemplates } from "./prompt-templates.js";
import {
  PAID_FEATURES,
  checkAccountLimit,
  checkLicense,
  clearAuthRecord,
  clearLicenseRecord,
  deactivateDevice,
  evaluateLicense,
  fetchAccountSummary,
  getAuthRecord,
  getLicenseRecord,
  getLicenseState,
  login,
  register,
  bindLicenseToAccount,
  unbindLicenseFromAccount,
  validateLicenseKeyOffline,
  verifyLicenseRemote,
  subscribeLicenseChanges,
  getLicenseSummaryText
} from "../shared/license.js";
import { getUsageSnapshot } from "../shared/usage-stats.js";
import { showUpgradeModal } from "../shared/upgrade-modal.js";

/**
 * 「下载桌面助手」横幅常量。
 *
 * 必须放在文件顶部（import 之后、任何 top-level 调用之前），
 * 因为下面 ~第 90 行的 `initHelperDownloadBanner()` 是 top-level 调用——
 * `function` 声明会 hoist，但函数体里引用的 `const HELPER_DOWNLOAD` 不 hoist，
 * 如果 const 写在调用点之后，会触发 TDZ：
 *   "Cannot access 'HELPER_DOWNLOAD' before initialization"
 *
 * 设计目标:
 * - 不依赖任何后端：URL 和最新版本号写死，靠仓库提交更新（避免新增运维 endpoint）。
 * - 修改"下载链接"和"安装文档"只需要改下面这三个字段。
 */
const HELPER_DOWNLOAD = {
  releaseUrl:
    "https://github.com/JUNSHENG428/gzhtool/releases?q=helper-v&expanded=true",
  guideUrl:
    "https://github.com/JUNSHENG428/gzhtool/blob/main/docs/USER_DOWNLOAD_HELPER.md",
  latestVersion: "0.2.0"
};

const fields = {
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
  // P1.3 / P1.2 · 微信 API 代理 + 群发策略
  wechatApiBase: document.querySelector("#wechatApiBase"),
  wechatSendStrategy: document.querySelector("#wechatSendStrategy"),
  wechatSendTagId: document.querySelector("#wechatSendTagId"),
  wechatSendIgnoreReprint: document.querySelector("#wechatSendIgnoreReprint"),
  hotTopicsNewsnowBase: document.querySelector("#hotTopicsNewsnowBase"),
  drissionEnabled: document.querySelector("#drissionEnabled"),
  drissionHelperUrl: document.querySelector("#drissionHelperUrl"),
  drissionTimeoutMs: document.querySelector("#drissionTimeoutMs")
};

const statusElement = document.querySelector("#status");
const testConnectionButton = document.querySelector("#testConnectionButton");
const testConnectionResult = document.querySelector("#testConnectionResult");
// 服务商下拉与配套 UI 元素 —— 不进 fields 字典：它不写 storage，只是 baseUrl 的快捷入口。
const aiProviderSelect = document.querySelector("#aiProvider");
const aiProviderHint = document.querySelector("#aiProviderHint");
const aiProviderKeyLink = document.querySelector("#aiProviderKeyLink");
const apiKeyHint = document.querySelector("#apiKeyHint");
const commonModelList = document.querySelector("#commonModelList");
const testWechatConnectionButton = document.querySelector("#testWechatConnectionButton");
const testWechatConnectionResult = document.querySelector("#testWechatConnectionResult");
const testHotTopicsNewsnowButton = document.querySelector("#testHotTopicsNewsnow");
const testHotTopicsNewsnowResult = document.querySelector("#testHotTopicsNewsnowResult");
const testDrissionConnectionButton = document.querySelector("#testDrissionConnectionButton");
const testDrissionConnectionResult = document.querySelector("#testDrissionConnectionResult");
const drissionHelperTokenStatus = document.querySelector("#drissionHelperTokenStatus");

// 隐藏在 module 作用域，不放进 fields 字典里 → saveForm 通用循环不会把 ""
// 或别的脏值吹掉它；只在 saveForm 末尾显式合并到 patch.drissionHelperToken。
let pendingHelperToken = "";
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
if (testHotTopicsNewsnowButton) {
  testHotTopicsNewsnowButton.addEventListener("click", () =>
    testHotTopicsBackend("newsnow")
  );
}
testDrissionConnectionButton?.addEventListener("click", testDrissionConnection);
initHelperDownloadBanner();
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

// 发布通道单选切换：实时更新 hint 文案 + 切灰 appId/AppSecret 输入框，
// 让用户一眼看到「当前选中模式需不需要凭证」。
document.querySelectorAll('input[name="profileMode"]').forEach((radio) => {
  radio.addEventListener("change", refreshProfileModeUi);
});
// 初次渲染（DOMContentLoaded 后立即同步）
queueMicrotask(refreshProfileModeUi);

function refreshProfileModeUi() {
  const mode = readSelectedProfileMode();
  const isApi = mode === "api";
  if (profileFields.appId) profileFields.appId.disabled = !isApi;
  if (profileFields.appSecret) profileFields.appSecret.disabled = !isApi;
  const hint = document.querySelector("#profileModeHint");
  if (hint) {
    hint.textContent = isApi
      ? "API 模式：必须填写 AppID + AppSecret，且把当前出口 IP 加进公众号后台「IP 白名单」。失败常见原因是 40164（IP 不在白名单）。"
      : "浏览器登录模式：填好账号名称即可，发布时会自动打开 mp 后台编辑页并把内容写入；最后一步保存草稿由你在 mp 后台手动点（合规底线）。";
  }
}
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

[fields.drissionEnabled, fields.drissionHelperUrl, fields.drissionTimeoutMs]
  .filter(Boolean)
  .forEach((field) => {
    const evt = field.type === "checkbox" ? "change" : "input";
    field.addEventListener(evt, () => clearTestResult(testDrissionConnectionResult));
  });

// helper 地址支持「粘贴含 ?token=… 的整段 URL」自动拆 token：
// - paste 走 clipboard 事件，能在浏览器把值塞进 input 之前拿到原始文本，立即拆 token；
// - 兜底再监听 change/blur，处理用户手敲完输入失焦的场景。
fields.drissionHelperUrl?.addEventListener("paste", (event) => {
  const text = event.clipboardData?.getData("text") ?? "";
  if (text) {
    event.preventDefault();
    fields.drissionHelperUrl.value = text;
    applyHelperUrlInput(text);
  }
});
fields.drissionHelperUrl?.addEventListener("change", () => {
  applyHelperUrlInput(fields.drissionHelperUrl.value);
});
fields.drissionHelperUrl?.addEventListener("blur", () => {
  applyHelperUrlInput(fields.drissionHelperUrl.value);
});

// 闸门：DrissionPage 是 Pro 功能，免费用户尝试勾选时拦截并弹升级框
fields.drissionEnabled?.addEventListener("change", async (event) => {
  if (!event.target.checked) return;
  const access = await checkLicense("scrape.drission");
  if (access.ok) return;
  event.target.checked = false;
  showUpgradeModal({
    featureName: PAID_FEATURES["scrape.drission"].name,
    hint: access.hint || PAID_FEATURES["scrape.drission"].hint,
    bullets: [
      "走真实 Chromium，绕过反爬与懒加载",
      "对动态加载内容（如电商详情页）友好",
      "失败时自动回退到内置抓取，不会卡死"
    ],
    primaryAction: { label: "查看 Pro 会员", url: pricingUrl() }
  });
});

// 注意：所有 init 入口集中放到文件末尾的 bootstrapOptionsPage()，
// 否则某些 init 函数访问的 module-level const 此时还在 TDZ，
// 会抛 ReferenceError 并中断后面的初始化。

async function hydrateForm() {
  const settings = await getSettings();
  for (const [key, field] of Object.entries(fields)) {
    if (!field) continue;
    if (field.type === "checkbox") {
      field.checked = Boolean(settings[key]);
      continue;
    }
    field.value = settings[key] ?? "";
  }
  // 根据已存的 apiBaseUrl 反推服务商，填好下拉与 datalist；
  // 必须放在通用 fields 循环之后 —— 此时 fields.apiBaseUrl.value 才是真实值。
  syncProviderUiFromBaseUrl();
  pendingHelperToken = normalizeDrissionHelperToken(settings.drissionHelperToken || "");
  refreshHelperTokenStatus();
  currentProfiles = Array.isArray(settings.wechatProfiles) ? settings.wechatProfiles : [];
  renderProfiles();
}

/**
 * 用 PROVIDER_PRESETS 填充服务商下拉。只在初始化时调一次。
 */
function buildProviderSelectOptions() {
  if (!aiProviderSelect) return;
  aiProviderSelect.innerHTML = "";
  for (const provider of PROVIDER_PRESETS) {
    const opt = document.createElement("option");
    opt.value = provider.key;
    opt.textContent = provider.name;
    aiProviderSelect.appendChild(opt);
  }
}

/**
 * 应用某个服务商预设到表单：写 baseUrl + 重建模型 datalist + 更新 Key 帮助链接。
 * `triggeredByUser=true` 时（用户操作下拉）会清空 model 字段、并触发 input 事件让
 * dirty 状态被检测到；hydrateForm 里反推时不要清 model（用户保存的 model 已在 fields）。
 */
function applyProviderPreset(key, { triggeredByUser = false } = {}) {
  const provider = getProviderByKey(key) || getProviderByKey(CUSTOM_PROVIDER_KEY);
  if (!provider) return;

  // 1) baseUrl —— 自定义档不动用户输入
  if (provider.key !== CUSTOM_PROVIDER_KEY) {
    if (fields.apiBaseUrl.value !== provider.baseUrl) {
      fields.apiBaseUrl.value = provider.baseUrl;
      if (triggeredByUser) {
        fields.apiBaseUrl.dispatchEvent(new Event("input", { bubbles: true }));
      }
    }
  }

  // 2) 模型 datalist —— 从预设填，没有就清空（用户手填）
  if (commonModelList) {
    commonModelList.innerHTML = "";
    for (const model of provider.models || []) {
      const opt = document.createElement("option");
      opt.value = model.id;
      // datalist 的 textContent 在大多数浏览器作为辅助说明文本展示。
      opt.textContent = model.label || model.id;
      commonModelList.appendChild(opt);
    }
  }

  // 3) 用户切换服务商时把当前模型也重置为推荐首选，避免「Kimi baseUrl + gpt-4o-mini」错配
  if (triggeredByUser) {
    const firstModel = provider.models?.[0]?.id || "";
    if (firstModel) {
      fields.model.value = firstModel;
      fields.model.dispatchEvent(new Event("input", { bubbles: true }));
    } else if (provider.key === CUSTOM_PROVIDER_KEY) {
      // 自定义档不强制清空，用户可能想保留原值
    }
  }

  // 4) 申请 Key 链接 + Key 帮助文案
  if (aiProviderKeyLink) {
    if (provider.apiKeyUrl) {
      aiProviderKeyLink.href = provider.apiKeyUrl;
      aiProviderKeyLink.hidden = false;
    } else {
      aiProviderKeyLink.removeAttribute("href");
      aiProviderKeyLink.hidden = true;
    }
  }
  if (apiKeyHint) {
    const tail = "只保存在你本机浏览器，不会上传。";
    apiKeyHint.textContent = provider.apiKeyHint
      ? `${provider.apiKeyHint} ${tail}`
      : tail;
  }

  // 5) 选中项同步（避免代码内调用与下拉显示不一致）
  if (aiProviderSelect && aiProviderSelect.value !== provider.key) {
    aiProviderSelect.value = provider.key;
  }
}

/**
 * 用当前 baseUrl 反推服务商并刷新 UI。供 hydrate 与 baseUrl 手改时复用。
 */
function syncProviderUiFromBaseUrl() {
  const matched = findProviderByBaseUrl(fields.apiBaseUrl.value);
  const key = matched ? matched.key : CUSTOM_PROVIDER_KEY;
  applyProviderPreset(key, { triggeredByUser: false });
}

/**
 * 一次性初始化服务商下拉：填选项 + 装事件。bootstrapOptionsPage 在 hydrateForm
 * 之前调用，保证 hydrate 反推服务商时 select 节点已经能拿到 options。
 */
function initAiProviderSelect() {
  buildProviderSelectOptions();
  if (!aiProviderSelect) return;

  aiProviderSelect.addEventListener("change", (event) => {
    const key = event.target.value || DEFAULT_PROVIDER_KEY;
    applyProviderPreset(key, { triggeredByUser: true });
    // 切换服务商通常意味着要重新测连，清掉旧结果避免误导。
    clearTestResult(testConnectionResult);
  });

  // 用户手改 baseUrl → 反推服务商；命不中则自动切到「自定义」。
  // 在已有的 `clearTestResult` 监听器之后挂第二个 input 监听器，互不影响。
  fields.apiBaseUrl.addEventListener("input", () => {
    const matched = findProviderByBaseUrl(fields.apiBaseUrl.value);
    const desiredKey = matched ? matched.key : CUSTOM_PROVIDER_KEY;
    if (aiProviderSelect.value !== desiredKey) {
      aiProviderSelect.value = desiredKey;
      // 注意：这里不调 applyProviderPreset —— 它会反过来覆盖用户正在敲的 baseUrl。
      // 只刷新「申请 Key 链接」「Key 帮助文案」「datalist 候选」即可。
      const provider = getProviderByKey(desiredKey);
      if (provider) {
        if (commonModelList) {
          commonModelList.innerHTML = "";
          for (const model of provider.models || []) {
            const opt = document.createElement("option");
            opt.value = model.id;
            opt.textContent = model.label || model.id;
            commonModelList.appendChild(opt);
          }
        }
        if (aiProviderKeyLink) {
          if (provider.apiKeyUrl) {
            aiProviderKeyLink.href = provider.apiKeyUrl;
            aiProviderKeyLink.hidden = false;
          } else {
            aiProviderKeyLink.removeAttribute("href");
            aiProviderKeyLink.hidden = true;
          }
        }
        if (apiKeyHint) {
          const tail = "只保存在你本机浏览器，不会上传。";
          apiKeyHint.textContent = provider.apiKeyHint
            ? `${provider.apiKeyHint} ${tail}`
            : tail;
        }
      }
    }
  });
}

function refreshHelperTokenStatus() {
  if (!drissionHelperTokenStatus) return;
  if (pendingHelperToken) {
    drissionHelperTokenStatus.textContent =
      "✅ 已检测到 helper token，请求会通过 X-Runbi-Helper-Token 安全传输。如需更新，重新粘贴新 helper 地址即可。";
    drissionHelperTokenStatus.style.color = "#15803d";
  } else {
    drissionHelperTokenStatus.textContent =
      "建议在桌面助手 GUI 点「复制 helper 地址」并粘贴到这里。token 会被自动拆出并加密保存，不会显示在地址栏。";
    drissionHelperTokenStatus.style.color = "";
  }
}

function applyHelperUrlInput(rawValue) {
  const parsed = parseDrissionHelperInput(rawValue);
  if (parsed.token) {
    pendingHelperToken = normalizeDrissionHelperToken(parsed.token);
  }
  // 把字段值替换成不带 token 的干净 URL（避免 token 留在 DOM/HTML 缓存里）
  if (parsed.url && parsed.url !== rawValue) {
    fields.drissionHelperUrl.value = parsed.url;
  }
  refreshHelperTokenStatus();
}

async function saveForm() {
  const invalidFields = [];

  for (const [key, field] of Object.entries(fields)) {
    if (!field) continue;
    if (!field.checkValidity || field.checkValidity()) continue;
    const label = field.closest("label")?.querySelector("span")?.textContent || key;
    invalidFields.push(label);
  }

  if (invalidFields.length > 0) {
    setStatus(`请检查以下字段：${invalidFields.join("、")}`);
    invalidFields.forEach((label) => {
      const field = Object.values(fields).find(
        (f) => f && f.closest("label")?.querySelector("span")?.textContent === label
      );
      field?.focus();
    });
    return;
  }

  const patch = {};
  for (const [key, field] of Object.entries(fields)) {
    if (!field) continue;
    if (field.type === "checkbox") {
      patch[key] = field.checked;
    } else if (field.type === "number") {
      patch[key] = Number(field.value);
    } else {
      patch[key] = field.value.trim();
    }
  }

  // helper URL 在保存前再拆一次，避免用户手敲后没触发 blur 就直接点保存
  if (typeof patch.drissionHelperUrl === "string" && patch.drissionHelperUrl) {
    const parsed = parseDrissionHelperInput(patch.drissionHelperUrl);
    if (parsed.token) {
      pendingHelperToken = normalizeDrissionHelperToken(parsed.token);
    }
    patch.drissionHelperUrl = parsed.url || "";
  }
  patch.drissionHelperToken = normalizeDrissionHelperToken(pendingHelperToken);
  patch.wechatProfiles = currentProfiles;

  await saveSettings(patch);
  refreshHelperTokenStatus();
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
    "wechatDefaultOnlyFansCanComment",
    "wechatApiBase",
    "wechatSendStrategy",
    "wechatSendTagId",
    "wechatSendIgnoreReprint"
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

/**
 * 在前端用户手势上下文里申请目标 origin 的 host permission。
 *
 * 必须在 options 页面（按钮 click handler 同步链路里）调用，不能放到
 * service worker —— MV3 的 service worker 没有用户手势，
 * `chrome.permissions.request` 会抛 "must be called during a user gesture"。
 *
 * 一旦用户在前端授权过，service-worker 后续调 `permissions.contains` 就会拿到 true，
 * 不需要再触发提示。
 */
async function ensureHostPermissionFromUserGesture(targetUrl) {
  const origin = originPatternFromUrl(targetUrl);
  if (!origin) return true;
  if (!globalThis.chrome?.permissions) return true;
  const granted = await chrome.permissions.contains({ origins: [origin] });
  if (granted) return true;
  return chrome.permissions.request({ origins: [origin] });
}

async function testAiConnection() {
  testConnectionButton.disabled = true;
  setTestResult(testConnectionResult, "loading", "正在测试...");

  const baseUrl = fields.apiBaseUrl.value.trim();
  const apiKey = fields.apiKey.value.trim();
  const model = fields.model.value.trim();

  try {
    // 必须在 click handler 还在用户手势上下文时同步申请 —— 一旦中间 await 了
    // service-worker，浏览器就认为用户手势已结束，再调 permissions.request 会抛
    // "must be called during a user gesture"。
    const permitted = await ensureHostPermissionFromUserGesture(baseUrl);
    if (!permitted) {
      setTestResult(
        testConnectionResult,
        "error",
        "需要授权访问该 API 域名才能测试连接，请在弹窗里点「允许」。"
      );
      return;
    }

    const response = await chrome.runtime.sendMessage({
      type: "TEST_AI_CONNECTION",
      payload: {
        baseUrl,
        apiKey,
        model
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
        appSecret: fields.wechatAppSecret.value.trim(),
        // P1.3 · 把代理地址也透给后端，方便用户"配代理 → 一键测通"
        wechatApiBase: fields.wechatApiBase?.value?.trim() || ""
      }
    });

    if (response?.ok) {
      // 强提示：拿到 token 不等于「能发草稿/能群发」。
      // 典型反例是 48001：服务号未认证或接口未开通时 token 可拿，但 add_draft 会拒。
      const note =
        response.note ||
        "已拿到 access_token。但本测试只能验证 AppID/AppSecret + IP 白名单，无法验证草稿/发布接口权限（如 48001 需要在真实发布时才能暴露）。";
      setTestResult(testWechatConnectionResult, "success", note);
      return;
    }

    // 拼装诊断信息：errcode / rid 透传给 UI，方便用户排查
    const baseError = formatRuntimeError(response?.error, "验证失败，请检查公众号配置。");
    const diagBits = [];
    if (response?.errcode) diagBits.push(`errcode=${response.errcode}`);
    if (response?.rid) diagBits.push(`rid=${response.rid}`);
    const message = diagBits.length
      ? `${baseError}（${diagBits.join("，")}）`
      : baseError;

    setTestResult(testWechatConnectionResult, "error", message);
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

// ---------------------------------------------------------------------------
// P1.2 · 公众号群发：拉取标签 + 月配额可视化
// ---------------------------------------------------------------------------
function initWechatExtras() {
  const tagsBtn = document.querySelector("#fetchWechatTagsBtn");
  if (tagsBtn) tagsBtn.addEventListener("click", fetchWechatTags);
  void refreshWechatSendUsage();
}

async function fetchWechatTags() {
  const tagsBtn = document.querySelector("#fetchWechatTagsBtn");
  const result = document.querySelector("#wechatTagsResult");
  if (!tagsBtn || !result) return;

  const appId = fields.wechatAppId?.value?.trim();
  const appSecret = fields.wechatAppSecret?.value?.trim();
  if (!appId || !appSecret) {
    setTestResult(result, "error", "请先在上方填写 AppID + AppSecret，并保存。");
    return;
  }

  tagsBtn.disabled = true;
  setTestResult(result, "loading", "正在拉取标签...");

  try {
    const response = await chrome.runtime.sendMessage({
      type: "LIST_WECHAT_TAGS",
      payload: {
        // 用 form 里当前的值，让用户能在没保存的情况下也测一遍
        appId,
        appSecret,
        wechatApiBase: fields.wechatApiBase?.value?.trim() || ""
      }
    });
    if (!response?.ok) {
      const msg = formatRuntimeError(response?.error, "拉取失败，请检查权限。");
      const verifiedHint = response?.error?.requiresVerifiedAccount
        ? "（48001/53400：通常意味着账号未认证或不开放此接口；订阅号无标签接口）"
        : "";
      setTestResult(result, "error", `${msg}${verifiedHint}`);
      return;
    }
    const tags = Array.isArray(response.data?.tags) ? response.data.tags : [];
    if (tags.length === 0) {
      setTestResult(result, "success", "拉取成功，但当前账号没有任何标签。可到「公众号后台 → 用户管理 → 标签管理」新建。");
      return;
    }
    const lines = tags
      .map((t) => `#${t.id} · ${escapeHtml(t.name)}（${t.count} 人）`)
      .join("｜");
    setTestResult(result, "success", `共 ${tags.length} 个标签：${lines}`);
  } catch (error) {
    setTestResult(result, "error", error.message || "拉取失败，请稍后再试。");
  } finally {
    tagsBtn.disabled = false;
  }
}

/** 把"本月已用群发全员次数 / 4"展示出来；进入新自然月时自动归零保存。 */
async function refreshWechatSendUsage() {
  const label = document.querySelector("#wechatSendAllUsageCountLabel");
  if (!label) return;
  try {
    const settings = await getSettings();
    const ym = `${new Date().getFullYear()}-${String(new Date().getMonth() + 1).padStart(2, "0")}`;
    if (settings.wechatSendAllUsageMonth !== ym) {
      // 新一个月，归零 + 持久化（不阻塞 UI）
      await saveSettings({
        wechatSendAllUsageMonth: ym,
        wechatSendAllUsageCount: 0
      });
      label.textContent = "0";
    } else {
      label.textContent = String(Number(settings.wechatSendAllUsageCount || 0));
    }
  } catch {
    label.textContent = "?";
  }
}

async function testHotTopicsBackend(kind) {
  if (kind !== "newsnow") return;
  const button = testHotTopicsNewsnowButton;
  const resultEl = testHotTopicsNewsnowResult;
  const baseField = fields.hotTopicsNewsnowBase;
  if (!button || !resultEl) return;

  button.disabled = true;
  setTestResult(resultEl, "loading", "正在测试...");

  try {
    const response = await chrome.runtime.sendMessage({
      type: "TEST_HOT_TOPICS_BACKEND",
      payload: { kind, baseUrl: baseField?.value?.trim() || "" }
    });

    if (response?.ok) {
      setTestResult(
        resultEl,
        "success",
        `${response.message || "OK"} · ${Number(response.latencyMs || 0)} ms · ${response.base || ""}`
      );
      return;
    }

    setTestResult(
      resultEl,
      "error",
      `${response?.message || "测试失败"}（${response?.base || "?"}，${Number(response?.latencyMs || 0)} ms）`
    );
  } catch (error) {
    setTestResult(resultEl, "error", error.message || "测试失败，请稍后再试。");
  } finally {
    button.disabled = false;
  }
}

async function testDrissionConnection() {
  if (!testDrissionConnectionButton || !testDrissionConnectionResult) return;

  testDrissionConnectionButton.disabled = true;
  setTestResult(testDrissionConnectionResult, "loading", "正在测试 helper...");

  // 测连接时也允许 inline 拆 token：用户可能贴了完整地址但还没点保存
  const rawUrl = fields.drissionHelperUrl?.value?.trim() || "";
  const parsed = parseDrissionHelperInput(rawUrl);
  if (parsed.token && parsed.token !== pendingHelperToken) {
    pendingHelperToken = normalizeDrissionHelperToken(parsed.token);
    if (parsed.url && fields.drissionHelperUrl.value !== parsed.url) {
      fields.drissionHelperUrl.value = parsed.url;
    }
    refreshHelperTokenStatus();
  }

  try {
    const response = await chrome.runtime.sendMessage({
      type: "TEST_DRISSION_CONNECTION",
      payload: {
        helperUrl: parsed.url || rawUrl,
        helperToken: pendingHelperToken,
        timeoutMs: Number(fields.drissionTimeoutMs?.value || 0) || undefined
      }
    });

    if (response?.ok) {
      const detail = [
        response.helperVersion && `helper v${response.helperVersion}`,
        response.drissionVersion && `DrissionPage v${response.drissionVersion}`,
        response.browserMode && `browser=${response.browserMode}`,
        Number.isFinite(response.latencyMs) && `latency=${response.latencyMs}ms`
      ]
        .filter(Boolean)
        .join(" · ");
      setTestResult(
        testDrissionConnectionResult,
        "success",
        detail ? `helper 可用：${detail}` : "helper 可用。"
      );
      return;
    }

    setTestResult(
      testDrissionConnectionResult,
      "error",
      formatRuntimeError(response?.error, "helper 不可达，请检查地址和端口。")
    );
  } catch (error) {
    setTestResult(
      testDrissionConnectionResult,
      "error",
      error.message || "测试失败，请稍后再试。"
    );
  } finally {
    testDrissionConnectionButton.disabled = false;
  }
}

/**
 * 「下载桌面助手」横幅初始化。
 *
 * 行为:
 * - 如果当前 helperUrl 已经填了 + 检测到 helper 在跑，就显示"已连接"提示，避免
 *   误导那些已经装好的用户重新下载。
 * - 检测走 HEAD/GET helperUrl + "/version"（轻量，不会拉浏览器），3 秒超时。
 *
 * 注：HELPER_DOWNLOAD 常量定义在文件顶部（import 后），原因见那里的注释。
 */
function initHelperDownloadBanner() {
  const downloadBtn = document.querySelector("#helperDownloadButton");
  const guideBtn = document.querySelector("#helperDownloadGuide");
  const versionEl = document.querySelector("#helperDownloadVersion");
  if (!downloadBtn) return;

  downloadBtn.href = HELPER_DOWNLOAD.releaseUrl;
  if (guideBtn) guideBtn.href = HELPER_DOWNLOAD.guideUrl;
  if (versionEl) {
    versionEl.textContent = `最新版本 v${HELPER_DOWNLOAD.latestVersion} · 支持 macOS / Windows`;
  }

  detectHelperVersion().then((info) => {
    if (!versionEl) return;
    if (!info) return;
    if (info.error) {
      versionEl.textContent = `最新版本 v${HELPER_DOWNLOAD.latestVersion} · 支持 macOS / Windows`;
      return;
    }
    const local = info.helperVersion;
    const latest = HELPER_DOWNLOAD.latestVersion;
    if (compareSemver(local, latest) < 0) {
      versionEl.textContent = `本机已装 v${local}，有新版 v${latest} 可下载`;
      versionEl.style.color = "#b45309";
    } else {
      versionEl.textContent = `本机已装并连通：v${local}（最新）`;
      versionEl.style.color = "#15803d";
    }
  });
}

async function detectHelperVersion() {
  const url = String(fields.drissionHelperUrl?.value || "").trim();
  if (!url) return null;
  let endpoint;
  try {
    endpoint = new URL("version", /\/$/.test(url) ? url : `${url}/`).toString();
  } catch {
    return { error: "URL 不合法" };
  }

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 3000);
  try {
    const resp = await fetch(endpoint, { signal: ctrl.signal });
    if (!resp.ok) return { error: `HTTP ${resp.status}` };
    const data = await resp.json();
    return {
      helperVersion: String(data?.helperVersion || ""),
      appName: String(data?.appName || "")
    };
  } catch (err) {
    return { error: String(err?.message || err) };
  } finally {
    clearTimeout(timer);
  }
}

function compareSemver(a, b) {
  const norm = (v) =>
    String(v || "0.0.0")
      .replace(/^v/, "")
      .split(/[^\d]+/)
      .filter(Boolean)
      .map((n) => Number(n) || 0);
  const aa = norm(a);
  const bb = norm(b);
  for (let i = 0; i < Math.max(aa.length, bb.length); i += 1) {
    const x = aa[i] || 0;
    const y = bb[i] || 0;
    if (x !== y) return x - y;
  }
  return 0;
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
    profilesContainer.innerHTML = '<p class="profiles-empty">还没有绑定任何公众号。上方填写后点「添加公众号」即可保存多套凭证。</p>';
    return;
  }

  profilesContainer.innerHTML = currentProfiles.map((profile, index) => {
    const profileMode = profile.mode === "browser" ? "browser" : "api";
    const modeBadge = profileMode === "browser"
      ? '<span style="display:inline-block;padding:2px 8px;border-radius:999px;background:#e8f4cf;color:#2f4d10;font-size:11px;font-weight:600;">浏览器登录</span>'
      : '<span style="display:inline-block;padding:2px 8px;border-radius:999px;background:#e6effd;color:#143a73;font-size:11px;font-weight:600;">API 模式</span>';
    const credLine = profileMode === "api"
      ? `<span>AppID: ${escapeHtml(profile.appId || "-")}</span>`
      : '<span style="color:var(--muted-color, #777);">无需 appId / AppSecret</span>';
    return `
      <div class="profile-card">
        <div class="profile-info">
          <strong>${escapeHtml(profile.name || `账号 ${index + 1}`)} ${modeBadge}</strong>
          ${credLine}
          <span>作者: ${escapeHtml(profile.author || "-")}</span>
          <span class="profile-test-result" data-test-result="${index}" aria-live="polite"></span>
        </div>
        <div class="profile-actions">
          <button type="button" class="ghost" data-toggle-mode="${index}">切到${profileMode === "browser" ? "API" : "浏览器登录"}</button>
          ${profileMode === "api" ? `<button type="button" class="ghost" data-test-profile="${index}">测试此账号</button>` : ""}
          <button type="button" class="ghost" data-delete-profile="${index}">删除</button>
        </div>
      </div>
    `;
  }).join("");

  profilesContainer.querySelectorAll("[data-delete-profile]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const idx = Number(btn.dataset.deleteProfile);
      currentProfiles.splice(idx, 1);
      renderProfiles();
      setStatus("账号已删除，记得点「保存设置」才会生效。");
    });
  });

  // 双向切换：browser ↔ api。appId/AppSecret 字段保留不丢，方便用户来回切。
  profilesContainer.querySelectorAll("[data-toggle-mode]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const idx = Number(btn.dataset.toggleMode);
      const profile = currentProfiles[idx];
      if (!profile) return;
      const nextMode = profile.mode === "browser" ? "api" : "browser";
      if (nextMode === "api" && (!profile.appId || !profile.appSecret)) {
        setStatus(
          `账号「${profile.name}」缺少 AppID/AppSecret，无法切到 API 模式。请先在上方表单补齐后重新创建。`
        );
        return;
      }
      currentProfiles[idx] = { ...profile, mode: nextMode };
      renderProfiles();
      await saveSettings({ wechatProfiles: currentProfiles });
      setStatus(
        `账号「${profile.name}」已切到${nextMode === "browser" ? "浏览器登录" : "API"}模式。`
      );
    });
  });

  // 每个 profile 单独走一遍 testWechatConnection，方便用户在不切换默认账号的前提下
  // 验证某一套凭证是否还能用。
  profilesContainer.querySelectorAll("[data-test-profile]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const idx = Number(btn.dataset.testProfile);
      const profile = currentProfiles[idx];
      const resultEl = profilesContainer.querySelector(`[data-test-result="${idx}"]`);
      if (!profile || !resultEl) return;
      btn.disabled = true;
      const previousLabel = btn.textContent;
      btn.textContent = "测试中...";
      resultEl.textContent = "正在测试...";
      resultEl.dataset.tone = "muted";
      try {
        const response = await chrome.runtime.sendMessage({
          type: "TEST_WECHAT_CONNECTION",
          payload: { appId: profile.appId, appSecret: profile.appSecret }
        });
        if (response?.ok) {
          resultEl.textContent = `✓ 凭证可用（仅验证 token，发布权限以真实发布为准）`;
          resultEl.dataset.tone = "success";
        } else {
          const diag = [];
          if (response?.errcode) diag.push(`errcode=${response.errcode}`);
          if (response?.rid) diag.push(`rid=${response.rid}`);
          const tail = diag.length ? `（${diag.join("，")}）` : "";
          resultEl.textContent = `× ${response?.error || "测试失败"}${tail}`;
          resultEl.dataset.tone = "error";
        }
      } catch (error) {
        resultEl.textContent = `× ${error.message || "测试失败"}`;
        resultEl.dataset.tone = "error";
      } finally {
        btn.disabled = false;
        btn.textContent = previousLabel;
      }
    });
  });
}

async function addProfile() {
  const name = profileFields.name?.value.trim();
  const appId = profileFields.appId?.value.trim();
  const appSecret = profileFields.appSecret?.value.trim();
  const author = profileFields.author?.value.trim();
  const mode = readSelectedProfileMode();

  if (!name) {
    setStatus("请填写账号名称。");
    return;
  }
  // API 模式才校验 appId/AppSecret；浏览器登录模式不需要
  if (mode === "api" && (!appId || !appSecret)) {
    setStatus("API 模式需要同时填写 AppID 和 AppSecret。");
    return;
  }

  // 闸门：多账号超过免费版上限时弹升级框
  const limit = await checkAccountLimit(currentProfiles.length);
  if (!limit.ok) {
    showUpgradeModal({
      featureName: PAID_FEATURES["wechat.multiAccount"].name,
      hint: limit.hint,
      bullets: [
        "Pro 会员不限公众号绑定数量，自由切换矩阵",
        "支持每个绑定的公众号独立设置默认作者、发布模式",
        "测试连接、发布日志按公众号区分"
      ],
      primaryAction: { label: "查看 Pro 会员", url: pricingUrl() }
    });
    return;
  }

  // 浏览器登录模式不依赖 appId/AppSecret，但保留用户填的值（方便日后切回 API 模式）
  currentProfiles.push({ name, appId, appSecret, author, mode });

  profileFields.name.value = "";
  profileFields.appId.value = "";
  profileFields.appSecret.value = "";
  profileFields.author.value = "";

  renderProfiles();
  await saveSettings({ wechatProfiles: currentProfiles });
  setStatus(`账号「${name}」（${mode === "browser" ? "浏览器登录" : "API"} 模式）已添加并保存。`);
}

/**
 * 读取「发布通道」单选当前值。缺省（无元素）回落 "browser"——这是 C 端默认推荐。
 */
function readSelectedProfileMode() {
  const checked = document.querySelector('input[name="profileMode"]:checked');
  const value = checked?.value;
  return value === "api" ? "api" : "browser";
}

/* ──────────────────────────────────────────────────────────────
 * 小白友好：上手清单 + 模式切换
 * 这两块都是「附加层」：不改任何已有 input 的 ID，也不影响保存逻辑，
 * 只是读取当前值更新 UI 状态。
 * ──────────────────────────────────────────────────────────── */

const NOVICE_MODE_KEY = "gzhSettings.noviceMode.v1";
const SAVED_FLAG_KEY = "gzhSettings.savedOnce.v1";

function initNoviceMode() {
  const body = document.body;
  // 默认新手模式；用户切换过就尊重用户选择。
  let mode = "novice";
  try {
    const stored = localStorage.getItem(NOVICE_MODE_KEY);
    if (stored === "novice" || stored === "expert") mode = stored;
  } catch {}
  applyNoviceMode(mode);

  document.querySelectorAll("[data-mode]").forEach((btn) => {
    btn.addEventListener("click", (e) => {
      e.preventDefault();
      const next = btn.getAttribute("data-mode");
      if (next === "novice" || next === "expert") {
        applyNoviceMode(next);
      }
    });
  });
}

function applyNoviceMode(mode) {
  const body = document.body;
  body.setAttribute("data-novice-mode", mode === "novice" ? "on" : "off");
  document.querySelectorAll(".mode-pill").forEach((pill) => {
    const isActive = pill.getAttribute("data-mode") === mode;
    pill.classList.toggle("is-active", isActive);
    pill.setAttribute("aria-selected", String(isActive));
  });
  const hint = document.querySelector("#modeHint");
  if (hint) {
    hint.textContent =
      mode === "novice"
        ? "新手模式只显示最关键的几张配置卡，进阶能力默认收起。"
        : "高级模式：所有进阶卡片都已展开，包括多账号、热点接口、Prompt 模板等。";
  }
  try {
    localStorage.setItem(NOVICE_MODE_KEY, mode === "novice" ? "novice" : "expert");
  } catch {}
}

/**
 * Phase E：左侧分区导航
 * - 点击：smooth 滚动到对应 card，并轻微 flash 提示
 * - 滚动：用 IntersectionObserver 反向高亮"当前可视分区"
 * 不动任何业务逻辑，仅 UI 行为。
 */
function initQuickNav() {
  const nav = document.querySelector("#settingsQuicknav");
  if (!nav) return;
  const items = Array.from(nav.querySelectorAll(".settings-quicknav-item[data-section-target]"));
  if (!items.length) return;

  const sections = Array.from(document.querySelectorAll("[data-section-key]"));
  if (!sections.length) return;

  const keyToItem = new Map();
  items.forEach((item) => {
    const key = item.getAttribute("data-section-target");
    if (key) keyToItem.set(key, item);

    item.addEventListener("click", (event) => {
      event.preventDefault();
      const target = sections.find((sec) => sec.getAttribute("data-section-key") === key);
      if (!target) return;
      target.scrollIntoView({ behavior: "smooth", block: "start" });
      target.classList.remove("is-anchor-flash");
      // 强制 reflow 以重启动画
      void target.offsetWidth;
      target.classList.add("is-anchor-flash");
      setTimeout(() => target.classList.remove("is-anchor-flash"), 1700);
      setActiveQuickNav(key);
    });
  });

  function setActiveQuickNav(key) {
    items.forEach((item) => {
      item.classList.toggle(
        "is-active",
        item.getAttribute("data-section-target") === key
      );
    });
  }

  // 反向高亮：取交叉比例最高的那个 section 作为当前
  const visibility = new Map();
  const observer = new IntersectionObserver(
    (entries) => {
      entries.forEach((entry) => {
        const key = entry.target.getAttribute("data-section-key");
        if (!key) return;
        visibility.set(key, entry.isIntersecting ? entry.intersectionRatio : 0);
      });
      let maxKey = null;
      let maxRatio = 0;
      visibility.forEach((ratio, key) => {
        if (ratio > maxRatio) {
          maxRatio = ratio;
          maxKey = key;
        }
      });
      if (maxKey) setActiveQuickNav(maxKey);
    },
    {
      // 在视口上半部分判定，与 scrollIntoView block:'start' 体感一致
      rootMargin: "-15% 0px -55% 0px",
      threshold: [0, 0.25, 0.5, 0.75, 1]
    }
  );
  sections.forEach((sec) => observer.observe(sec));
}

function initChecklist() {
  // 跳转按钮：点击「跳到这一步」滚到对应 input 并 focus。
  document.querySelectorAll("[data-jump]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const id = btn.getAttribute("data-jump");
      if (!id) return;
      const target = document.getElementById(id);
      if (!target) return;
      target.scrollIntoView({ behavior: "smooth", block: "center" });
      // 等滚动结束再 focus，避免 smooth-scroll 被 focus 中断
      setTimeout(() => target.focus({ preventScroll: true }), 350);
      target.classList.add("field-flash");
      setTimeout(() => target.classList.remove("field-flash"), 1200);
    });
  });

  // 输入变化时实时更新清单状态。
  const watch = [
    fields.apiBaseUrl,
    fields.apiKey,
    fields.model,
    fields.wechatAppId,
    fields.wechatAppSecret
  ].filter(Boolean);
  watch.forEach((field) => {
    field.addEventListener("input", refreshChecklist);
  });

  // 保存按钮额外打个标记：用来判定「第三步」是否已完成。
  document.querySelector("#saveButton")?.addEventListener("click", () => {
    try {
      localStorage.setItem(SAVED_FLAG_KEY, "1");
    } catch {}
    setTimeout(refreshChecklist, 50);
  });

  refreshChecklist();
}

function refreshChecklist() {
  const aiOk =
    isFilled(fields.apiBaseUrl?.value) &&
    isFilled(fields.apiKey?.value) &&
    isFilled(fields.model?.value);
  const wechatOk =
    isFilled(fields.wechatAppId?.value) && isFilled(fields.wechatAppSecret?.value);
  let savedOk = false;
  try {
    savedOk = localStorage.getItem(SAVED_FLAG_KEY) === "1" && aiOk;
  } catch {}

  setChecklistStep("ai", aiOk);
  setChecklistStep("wechat", wechatOk);
  setChecklistStep("save", savedOk);
}

function setChecklistStep(step, done) {
  const item = document.querySelector(`.checklist-item[data-step="${step}"]`);
  if (!item) return;
  item.classList.toggle("is-done", Boolean(done));
  const status = item.querySelector(".step-status");
  if (status) {
    status.setAttribute("data-status", done ? "done" : "missing");
    status.textContent = done ? "已完成" : step === "save" ? "未保存" : "未完成";
  }
}

function isFilled(value) {
  return typeof value === "string" && value.trim().length > 0;
}

/* ============== 会员激活（联网账号 + License 绑定） ============== */

const licenseEls = {
  section: null,
  statusBox: null,
  statusLabel: null,
  statusHint: null,
  statusKey: null,
  refreshBtn: null,

  authTabs: null,
  emailInput: null,
  passwordInput: null,
  authSubmitBtn: null,
  authFeedback: null,
  accountStatus: null,
  accountInfo: null,
  accountEmail: null,
  logoutBtn: null,

  input: null,
  activateBtn: null,
  clearBtn: null,
  feedback: null,
  pricingLink: null,

  listBlock: null,
  listContainer: null,
  featuresList: null
};

let _licenseAuthMode = "login"; // "login" | "register"

async function initLicenseSection() {
  licenseEls.section = document.querySelector("#licenseSection");
  if (!licenseEls.section) return;

  licenseEls.statusBox = document.querySelector("#licenseStatusBox");
  licenseEls.statusLabel = document.querySelector("#licenseStatusLabel");
  licenseEls.statusHint = document.querySelector("#licenseStatusHint");
  licenseEls.statusKey = document.querySelector("#licenseStatusKey");
  licenseEls.refreshBtn = document.querySelector("#licenseRefreshBtn");

  licenseEls.authTabs = document.querySelector("#licenseAuthTabs");
  licenseEls.emailInput = document.querySelector("#licenseEmailInput");
  licenseEls.passwordInput = document.querySelector("#licensePasswordInput");
  licenseEls.authSubmitBtn = document.querySelector("#licenseAuthSubmitBtn");
  licenseEls.authFeedback = document.querySelector("#licenseAuthFeedback");
  licenseEls.accountStatus = document.querySelector("#licenseAccountStatus");
  licenseEls.accountInfo = document.querySelector("#licenseAccountInfo");
  licenseEls.accountEmail = document.querySelector("#licenseAccountEmail");
  licenseEls.logoutBtn = document.querySelector("#licenseLogoutBtn");

  licenseEls.input = document.querySelector("#licenseKeyInput");
  licenseEls.activateBtn = document.querySelector("#licenseActivateBtn");
  licenseEls.clearBtn = document.querySelector("#licenseClearBtn");
  licenseEls.feedback = document.querySelector("#licenseFeedback");
  licenseEls.pricingLink = document.querySelector("#licensePricingLink");

  licenseEls.listBlock = document.querySelector("#licenseListBlock");
  licenseEls.listContainer = document.querySelector("#licenseListContainer");
  licenseEls.featuresList = document.querySelector("#licenseFeaturesList");

  // 暴露给 prompt-templates.js 等模块统一拿定价链接
  if (typeof window !== "undefined") {
    window.__pricingUrl = pricingUrl();
  }
  if (licenseEls.pricingLink) {
    licenseEls.pricingLink.href = pricingUrl();
  }

  // 监听 license / 登录态变化：sw 后台复验、popup 上的快捷操作、其它 options 标签页
  // 任意更新都自动刷新 UI（不需要用户手动 reload）
  subscribeLicenseChanges(() => {
    void renderAll();
  });

  // 事件绑定
  licenseEls.refreshBtn?.addEventListener("click", handleRefreshLicense);

  licenseEls.authTabs?.addEventListener("click", (e) => {
    const target = e.target.closest("[data-auth-tab]");
    if (!target) return;
    setAuthMode(target.dataset.authTab);
  });

  licenseEls.authSubmitBtn?.addEventListener("click", handleAuthSubmit);
  [licenseEls.emailInput, licenseEls.passwordInput].forEach((el) =>
    el?.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        void handleAuthSubmit();
      }
    })
  );

  licenseEls.logoutBtn?.addEventListener("click", handleLogout);

  licenseEls.activateBtn?.addEventListener("click", handleActivateLicense);
  licenseEls.clearBtn?.addEventListener("click", handleClearLicense);
  licenseEls.input?.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      void handleActivateLicense();
    }
  });
  licenseEls.input?.addEventListener("input", () => {
    const raw = licenseEls.input.value.toUpperCase().replace(/[^0-9A-Z]/g, "");
    const padded = raw.startsWith("GZHT") ? raw : `GZHT${raw}`;
    const segments = [
      padded.slice(0, 4),
      padded.slice(4, 8),
      padded.slice(8, 12),
      padded.slice(12, 16)
    ].filter(Boolean);
    licenseEls.input.value = segments.join("-");
  });

  await renderAll();
}

function setAuthMode(mode) {
  _licenseAuthMode = mode === "register" ? "register" : "login";
  if (licenseEls.authTabs) {
    licenseEls.authTabs.querySelectorAll(".license-tab").forEach((btn) => {
      btn.classList.toggle("active", btn.dataset.authTab === _licenseAuthMode);
    });
  }
  if (licenseEls.authSubmitBtn) {
    licenseEls.authSubmitBtn.textContent = _licenseAuthMode === "register" ? "注册并登录" : "登录";
  }
  setLicenseAuthFeedback("");
}

async function renderAll() {
  await Promise.all([renderAccountUI(), renderLicenseStatus(), renderFeaturesList()]);
}

async function renderAccountUI() {
  const auth = await getAuthRecord();
  const loggedIn = Boolean(auth?.token && auth?.user?.email);

  if (licenseEls.accountStatus) {
    licenseEls.accountStatus.textContent = loggedIn
      ? `已登录：${auth.user.email}`
      : "未登录";
  }
  if (licenseEls.accountInfo) licenseEls.accountInfo.hidden = !loggedIn;
  if (licenseEls.accountEmail) licenseEls.accountEmail.textContent = auth?.user?.email || "";

  // 表单：未登录显示，登录后隐藏
  const showForm = !loggedIn;
  ["emailInput", "passwordInput", "authSubmitBtn"].forEach((k) => {
    if (licenseEls[k]) licenseEls[k].style.display = showForm ? "" : "none";
  });
  if (licenseEls.authTabs) licenseEls.authTabs.style.display = showForm ? "" : "none";

  if (licenseEls.listBlock) licenseEls.listBlock.hidden = !loggedIn;

  if (loggedIn) {
    void refreshAccountSummary();
  } else {
    renderLicenseList(null);
  }
}

async function refreshAccountSummary() {
  try {
    const data = await fetchAccountSummary();
    if (data?.ok) {
      renderLicenseList(data.license);
    } else if (data?.error) {
      setLicenseAuthFeedback(data.error, "error");
    }
  } catch (error) {
    if (error.status === 401) {
      // 已自动 clearAuthRecord，刷新 UI 即可
      await renderAccountUI();
      setLicenseAuthFeedback("登录已过期，请重新登录。", "warning");
    } else {
      setLicenseAuthFeedback(error?.message || "获取账号信息失败", "error");
    }
  }
}

function renderLicenseList(summary) {
  const container = licenseEls.listContainer;
  if (!container) return;
  const keys = Array.isArray(summary?.keys) ? summary.keys : [];
  if (!keys.length) {
    container.innerHTML = `<p class="license-list-empty">此账号暂未开通 Pro 会员。前往 <a href="${escapeHtml(pricingUrl())}" target="_blank" rel="noopener">开通 Pro 会员</a>，开通后会自动绑定到本账号。</p>`;
    return;
  }
  container.innerHTML = keys
    .map((row) => {
      const expires =
        row.expires_at && Number(row.expires_at) > 0
          ? `有效至 ${formatLicenseDate(row.expires_at)}`
          : "按订阅周期续费";
      const planTitle = row.plan === "pro" ? "Pro 会员" : String(row.plan || "Free");
      const statusTag = row.status === "active" ? "已激活" : row.status === "expired" ? "已过期" : "已禁用";
      return `
        <div class="license-list-item" data-key="${escapeAttr(row.key)}">
          <div class="license-list-item-meta">
            <strong class="license-list-key">${escapeHtml(planTitle)}</strong>
            <span class="license-list-status" data-status="${escapeAttr(row.status)}">${statusTag}</span>
            <span class="license-list-expires">${escapeHtml(expires)}</span>
          </div>
          <div class="license-list-item-actions">
            <button type="button" class="ghost-button" data-action="bind">激活到本机</button>
            <button type="button" class="ghost-button" data-action="unbind">解绑此账号</button>
          </div>
        </div>
      `;
    })
    .join("");

  container.querySelectorAll("[data-action]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const item = btn.closest("[data-key]");
      const key = item?.dataset.key;
      if (!key) return;
      const action = btn.dataset.action;
      if (action === "bind") {
        await handleBindFromList(key);
      } else if (action === "unbind") {
        await handleUnbindFromList(key);
      }
    });
  });
}

async function handleBindFromList(key) {
  if (!licenseEls.input) return;
  licenseEls.input.value = key;
  await handleActivateLicense();
}

async function handleUnbindFromList(key) {
  if (!confirm(`确定从此账号解绑当前 Pro 会员权益？解绑后可在其他账号下重新绑定。`)) return;
  try {
    const res = await unbindLicenseFromAccount(key);
    if (res?.ok) {
      setLicenseAuthFeedback("已从此账号解绑会员权益。", "success");
      await refreshAccountSummary();
      // 如果当前本机激活的就是这张 key，也清掉本地缓存
      const local = await getLicenseRecord();
      if (local?.key === key) {
        try { await deactivateDevice(key); } catch { /* ignore */ }
        await clearLicenseRecord();
        await renderLicenseStatus();
        await renderFeaturesList();
      }
    } else {
      setLicenseAuthFeedback(res?.error || "解绑失败", "error");
    }
  } catch (error) {
    setLicenseAuthFeedback(error?.message || "解绑失败", "error");
  }
}

async function handleAuthSubmit() {
  const email = licenseEls.emailInput?.value?.trim() || "";
  const password = licenseEls.passwordInput?.value || "";
  if (!email || !password) {
    setLicenseAuthFeedback("请填写邮箱和密码。", "warning");
    return;
  }
  setAuthBtnBusy(true);
  try {
    const res = _licenseAuthMode === "register"
      ? await register(email, password)
      : await login(email, password);
    if (res?.ok) {
      setLicenseAuthFeedback(_licenseAuthMode === "register" ? "注册成功，已自动登录。" : "登录成功。", "success");
      if (licenseEls.passwordInput) licenseEls.passwordInput.value = "";
      await renderAll();
    } else {
      setLicenseAuthFeedback(res?.error || "操作失败", "error");
    }
  } catch (error) {
    setLicenseAuthFeedback(error?.message || "网络异常，请稍后再试", "error");
  } finally {
    setAuthBtnBusy(false);
  }
}

async function handleLogout() {
  await clearAuthRecord();
  setLicenseAuthFeedback("已退出登录。", "muted");
  await renderAll();
}

async function handleRefreshLicense() {
  const record = await getLicenseRecord();
  if (!record?.key) {
    setLicenseFeedback("当前还没有激活任何 License。", "warning");
    return;
  }
  setLicenseFeedback("正在向服务器复验...", "muted");
  try {
    const res = await verifyLicenseRemote(record.key);
    if (res?.ok) {
      await renderLicenseStatus();
      await renderFeaturesList();
      setLicenseFeedback("已复验完成，状态已更新。", "success");
    } else {
      setLicenseFeedback(res?.error || "复验失败", "error");
    }
  } catch (error) {
    setLicenseFeedback(error?.message || "网络异常，请稍后再试", "error");
  }
}

async function renderLicenseStatus() {
  const state = await getLicenseState({ refresh: false });
  const record = await getLicenseRecord();

  // P0：会员状态文案统一 — options 会员区也走 getLicenseSummaryText（与 popup/workspace pill/member hero 一致）
  let label = state.label;
  let hint = state.hint;
  let dataStatus = state.status;
  try {
    const auth = await getAuthRecord().catch(() => null);
    const usage = await getUsageSnapshot().catch(() => null);
    const summary = getLicenseSummaryText(state, {
      auth,
      usage: { today: { rewrite: Number(usage?.today?.rewrite) || 0 } }
    });
    label = summary.label;
    hint = summary.sub;
    dataStatus = summary.tone;
  } catch (err) {
    console.warn("[options] license summary failed, fallback", err);
  }

  if (licenseEls.statusBox) licenseEls.statusBox.dataset.status = dataStatus;
  if (licenseEls.statusLabel) licenseEls.statusLabel.textContent = label;
  if (licenseEls.statusHint) licenseEls.statusHint.textContent = hint;
  if (licenseEls.statusKey) {
    if (state.displayKey) {
      licenseEls.statusKey.hidden = false;
      licenseEls.statusKey.textContent = state.displayKey;
    } else {
      licenseEls.statusKey.hidden = true;
      licenseEls.statusKey.textContent = "";
    }
  }
  if (licenseEls.clearBtn) licenseEls.clearBtn.hidden = !record;
  if (licenseEls.input && record?.key) licenseEls.input.value = record.key;
  if (licenseEls.refreshBtn) licenseEls.refreshBtn.disabled = !record;
}

async function renderFeaturesList() {
  const list = licenseEls.featuresList;
  if (!list) return;
  const state = await getLicenseState({ refresh: false });
  const isPro = state.effectivePlan === "pro";
  const items = Object.entries(PAID_FEATURES).map(([key, meta]) => {
    const enabled = meta.tier === "free" || isPro;
    return `<li class="license-feature ${enabled ? "is-on" : "is-off"}">
      <span class="license-feature-icon" aria-hidden="true">${enabled ? "✓" : "○"}</span>
      <span class="license-feature-meta">
        <strong>${escapeHtml(meta.name)}</strong>
        <span>${escapeHtml(meta.hint)}</span>
      </span>
      <span class="license-feature-tag">${meta.tier === "free" ? "FREE" : "PRO"}</span>
    </li>`;
  });
  list.innerHTML = items.join("");
}

async function handleActivateLicense() {
  if (!licenseEls.input) return;
  const raw = licenseEls.input.value.trim();
  if (!raw) {
    setLicenseFeedback("请先输入备用激活码（形如 GZHT-XXXX-XXXX-XXXX）。", "warning");
    licenseEls.input.focus();
    return;
  }

  const offline = validateLicenseKeyOffline(raw);
  if (!offline.ok) {
    setLicenseFeedback(licenseFailureMessage(offline.reason), "error");
    return;
  }

  setLicenseFeedback("正在向服务器校验会员权益...", "muted");
  setActivateBtnBusy(true);
  try {
    const verifyRes = await verifyLicenseRemote(offline.key);
    if (!verifyRes?.ok) {
      setLicenseFeedback(verifyRes?.error || "校验失败", "error");
      return;
    }

    const auth = await getAuthRecord();
    if (auth?.token) {
      try {
        await bindLicenseToAccount(offline.key);
        await refreshAccountSummary();
      } catch (error) {
        setLicenseAuthFeedback(
          `已在本机激活，但绑定到账号失败：${error?.message || "未知错误"}`,
          "warning"
        );
      }
    }

    await renderLicenseStatus();
    await renderFeaturesList();
    setLicenseFeedback(
      verifyRes.plan === "pro"
        ? "激活成功！Pro 会员所有功能立即可用。"
        : "激活成功，但当前不在 Pro 会员套餐内。",
      verifyRes.plan === "pro" ? "success" : "warning"
    );
  } catch (error) {
    setLicenseFeedback(error?.message || "网络异常，请稍后再试", "error");
  } finally {
    setActivateBtnBusy(false);
  }
}

async function handleClearLicense() {
  if (!confirm("确定从本机解绑当前 Pro 会员权益？账号上的绑定记录不受影响。")) return;
  const record = await getLicenseRecord();
  if (record?.key) {
    try { await deactivateDevice(record.key); } catch { /* ignore */ }
  }
  await clearLicenseRecord();
  if (licenseEls.input) licenseEls.input.value = "";
  await renderLicenseStatus();
  await renderFeaturesList();
  setLicenseFeedback("已从本机解绑 Pro 会员权益，回到免费版。", "muted");
}

function setActivateBtnBusy(busy) {
  if (!licenseEls.activateBtn) return;
  licenseEls.activateBtn.disabled = busy;
  licenseEls.activateBtn.textContent = busy ? "验证中..." : "激活并绑定";
}

function setAuthBtnBusy(busy) {
  if (!licenseEls.authSubmitBtn) return;
  licenseEls.authSubmitBtn.disabled = busy;
  licenseEls.authSubmitBtn.textContent = busy
    ? (_licenseAuthMode === "register" ? "注册中..." : "登录中...")
    : (_licenseAuthMode === "register" ? "注册并登录" : "登录");
}

function licenseFailureMessage(reason) {
  switch (reason) {
    case "format":
      return "格式不对：备用激活码应形如 GZHT-XXXX-XXXX-XXXX，每段 4 位字母或数字。";
    case "empty":
      return "请先填写备用激活码。";
    default:
      return "激活码不可用，请重新填写。";
  }
}

function setLicenseFeedback(text, tone) {
  if (!licenseEls.feedback) return;
  licenseEls.feedback.textContent = text;
  licenseEls.feedback.dataset.tone = tone || "muted";
}

function setLicenseAuthFeedback(text, tone) {
  if (!licenseEls.authFeedback) return;
  if (!text) {
    licenseEls.authFeedback.hidden = true;
    licenseEls.authFeedback.textContent = "";
    return;
  }
  licenseEls.authFeedback.hidden = false;
  licenseEls.authFeedback.textContent = text;
  licenseEls.authFeedback.dataset.tone = tone || "muted";
}

function formatLicenseDate(timestamp) {
  if (!timestamp) return "";
  const d = new Date(Number(timestamp));
  if (!Number.isFinite(d.getTime())) return "";
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function escapeAttr(value) {
  return escapeHtml(String(value)).replace(/"/g, "&quot;");
}

/**
 * 统一的"去定价页"链接。优先读 settings.licensePricingUrl（用户可自定义私有部署地址），
 * 否则走默认。所有升级弹窗的主按钮都通过这里取链接，避免散落硬编码。
 */
function pricingUrl() {
  return "https://docuearn.com/pricing";
}

/**
 * 入口：所有 module-level `const` 都已声明后再启动各 init。
 * （之前 await 初始化散落在文件中段，会触发 TDZ。）
 */
async function bootstrapOptionsPage() {
  // 先把服务商下拉选项与监听器装好，hydrateForm 里 syncProviderUiFromBaseUrl
  // 会用到选项节点。
  initAiProviderSelect();
  try {
    await hydrateForm();
  } catch (err) {
    console.error("[options] hydrateForm failed:", err);
  }
  try {
    await initPromptTemplates(setStatus);
  } catch (err) {
    console.error("[options] initPromptTemplates failed:", err);
  }
  initNoviceMode();
  initChecklist();
  initQuickNav();
  try {
    initWechatExtras();
  } catch (err) {
    console.error("[options] initWechatExtras failed:", err);
  }
  try {
    await initLicenseSection();
  } catch (err) {
    console.error("[options] initLicenseSection failed:", err);
  }
  // 支持从 popup 跳转过来时滚动到 #license 锚点
  if (typeof window !== "undefined" && window.location?.hash === "#license") {
    requestAnimationFrame(() => {
      document.querySelector("#licenseSection")?.scrollIntoView({
        behavior: "smooth",
        block: "start"
      });
      document.querySelector("#licenseKeyInput")?.focus();
    });
  }
}

await bootstrapOptionsPage();
