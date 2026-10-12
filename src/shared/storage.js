import {
  DEFAULT_PROMPT_TEMPLATES,
  DEFAULT_SESSION,
  DEFAULT_SETTINGS,
  STORAGE_KEYS
} from "./defaults.js";

export async function getSettings() {
  const stored = await chrome.storage.local.get(STORAGE_KEYS.settings);
  return { ...DEFAULT_SETTINGS, ...(stored[STORAGE_KEYS.settings] || {}) };
}

export async function saveSettings(patch) {
  const next = { ...(await getSettings()), ...patch };
  await chrome.storage.local.set({ [STORAGE_KEYS.settings]: next });
  return next;
}

export async function getSession() {
  const stored = await chrome.storage.local.get(STORAGE_KEYS.session);
  return { ...DEFAULT_SESSION, ...(stored[STORAGE_KEYS.session] || {}) };
}

let sessionWriter = null;

// Set only by the service-worker entry point. Pages always send a patch to it.
export function setSessionWriter(writer) {
  sessionWriter = writer;
}

export async function saveSession(patch) {
  if (sessionWriter) return sessionWriter(patch);
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage({ type: "SAVE_SESSION", patch }, (response) => {
      const error = chrome.runtime.lastError;
      if (error) return reject(new Error(error.message));
      if (!response?.ok) return reject(new Error(response?.error?.message || "会话保存失败"));
      resolve(response.data);
    });
  });
}

export async function getPromptTemplates() {
  const stored = await chrome.storage.local.get(STORAGE_KEYS.promptTemplates);
  const raw = stored[STORAGE_KEYS.promptTemplates];
  const presetMap = new Map(DEFAULT_PROMPT_TEMPLATES.map((t) => [t.id, t]));
  if (!Array.isArray(raw) || raw.length === 0) {
    return DEFAULT_PROMPT_TEMPLATES.map(cloneTemplate);
  }

  const seenIds = new Set();
  const merged = [];
  for (const item of raw) {
    if (!item || typeof item !== "object" || !item.id) continue;
    if (seenIds.has(item.id)) continue;
    seenIds.add(item.id);
    if (presetMap.has(item.id)) {
      merged.push(mergeWithPreset(item, presetMap.get(item.id)));
    } else {
      merged.push(normalizeStoredTemplate(item));
    }
  }
  for (const preset of DEFAULT_PROMPT_TEMPLATES) {
    if (!seenIds.has(preset.id)) {
      merged.push(cloneTemplate(preset));
    }
  }
  return merged;
}

export async function savePromptTemplates(templates) {
  const safe = Array.isArray(templates) ? templates.filter((t) => t && t.id) : [];
  await chrome.storage.local.set({ [STORAGE_KEYS.promptTemplates]: safe });
  return safe;
}

export async function getActiveTemplateId() {
  const stored = await chrome.storage.local.get(STORAGE_KEYS.activeTemplateId);
  const value = stored[STORAGE_KEYS.activeTemplateId];
  return typeof value === "string" ? value : "";
}

export async function setActiveTemplateId(id) {
  await chrome.storage.local.set({ [STORAGE_KEYS.activeTemplateId]: String(id || "") });
}

export async function getActivePromptTemplate() {
  const [templates, activeId] = await Promise.all([
    getPromptTemplates(),
    getActiveTemplateId()
  ]);
  if (!activeId) return null;
  return templates.find((t) => t.id === activeId) || null;
}

function cloneTemplate(template) {
  return {
    id: template.id,
    name: template.name,
    icon: template.icon || "📝",
    description: template.description || "",
    systemTemplate: template.systemTemplate || "",
    userTemplate: template.userTemplate || "",
    defaults: { ...(template.defaults || {}) },
    temperature:
      template.temperature == null || template.temperature === ""
        ? null
        : Number(template.temperature),
    model: template.model || ""
  };
}

function mergeWithPreset(stored, preset) {
  const base = cloneTemplate(preset);
  return {
    ...base,
    name: stored.name || base.name,
    icon: stored.icon || base.icon,
    description: stored.description || base.description,
    systemTemplate: stored.systemTemplate || base.systemTemplate,
    userTemplate: stored.userTemplate || base.userTemplate,
    defaults: { ...base.defaults, ...(stored.defaults || {}) },
    temperature:
      stored.temperature === undefined || stored.temperature === null || stored.temperature === ""
        ? base.temperature
        : Number(stored.temperature),
    model: stored.model ?? base.model
  };
}

function normalizeStoredTemplate(stored) {
  return {
    id: String(stored.id),
    name: stored.name || "未命名模板",
    icon: stored.icon || "📝",
    description: stored.description || "",
    systemTemplate: stored.systemTemplate || "",
    userTemplate: stored.userTemplate || "",
    defaults: {
      tone: stored.defaults?.tone || "",
      angle: stored.defaults?.angle || "",
      length: stored.defaults?.length || "medium",
      cta: stored.defaults?.cta || "",
      audience: stored.defaults?.audience || ""
    },
    temperature:
      stored.temperature === undefined || stored.temperature === null || stored.temperature === ""
        ? null
        : Number(stored.temperature),
    model: stored.model || "",
    useVoiceSample: ["auto", "force-on", "force-off"].includes(stored.useVoiceSample)
      ? stored.useVoiceSample
      : "auto",
    humanizePassAllowed: stored.humanizePassAllowed === false ? false : true,
    humanizeProfile:
      stored.humanizeProfile && typeof stored.humanizeProfile === "object"
        ? stored.humanizeProfile
        : null,
    // AI 生成模板的元信息：之前重载会丢掉，导致「保存后切回此模板自动套用杂志主题」失效、
    // 以及无法「按原问卷再生成」。这里显式保留。
    aiGenerated: stored.aiGenerated === true,
    suggestedTheme: stored.suggestedTheme || null,
    quizMeta:
      stored.quizMeta && typeof stored.quizMeta === "object" ? stored.quizMeta : null
  };
}
