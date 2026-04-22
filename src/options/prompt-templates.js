import { DEFAULT_PROMPT_TEMPLATES } from "../shared/defaults.js";
import {
  getPromptTemplates,
  savePromptTemplates,
  getActiveTemplateId,
  setActiveTemplateId
} from "../shared/storage.js";
import { buildRewriteMessages } from "../shared/ai.js";
import { escapeHtml } from "../shared/utils.js";

let _templates = [];
let _selectedId = "";
let _lastFocusedTextarea = null;
let _setStatus = () => {};
let _filterQuery = "";

const PRESET_IDS = new Set(DEFAULT_PROMPT_TEMPLATES.map((t) => t.id));

const els = {
  list: document.querySelector("#templateList"),
  form: document.querySelector("#templateEditorForm"),
  empty: document.querySelector("#templateEmptyState"),
  icon: document.querySelector("#templateIcon"),
  name: document.querySelector("#templateName"),
  system: document.querySelector("#templateSystem"),
  user: document.querySelector("#templateUser"),
  defaultTone: document.querySelector("#templateDefaultTone"),
  defaultAngle: document.querySelector("#templateDefaultAngle"),
  defaultLength: document.querySelector("#templateDefaultLength"),
  defaultCta: document.querySelector("#templateDefaultCta"),
  defaultAudience: document.querySelector("#templateDefaultAudience"),
  temperature: document.querySelector("#templateTemperature"),
  model: document.querySelector("#templateModel"),
  badge: document.querySelector("#templateBadge"),
  addBtn: document.querySelector("#addTemplateButton"),
  restoreBtn: document.querySelector("#restoreTemplateButton"),
  dupBtn: document.querySelector("#duplicateTemplateButton"),
  delBtn: document.querySelector("#deleteTemplateButton"),
  previewBtn: document.querySelector("#previewPromptButton"),
  exportBtn: document.querySelector("#exportTemplatesButton"),
  importBtn: document.querySelector("#importTemplatesButton"),
  importInput: document.querySelector("#importTemplatesInput"),
  previewBackdrop: document.querySelector("#promptPreviewBackdrop"),
  previewCloseBtn: document.querySelector("#promptPreviewCloseBtn"),
  previewMeta: document.querySelector("#promptPreviewMeta"),
  previewSystem: document.querySelector("#promptPreviewSystem"),
  previewUser: document.querySelector("#promptPreviewUser"),
  searchInput: document.querySelector("#templateSearchInput"),
  totalCount: document.querySelector("#templateTotalCount"),
  presetCount: document.querySelector("#templatePresetCount"),
  customCount: document.querySelector("#templateCustomCount"),
  liveMeta: document.querySelector("#templateLiveMeta"),
  kindPill: document.querySelector("#templateKindPill"),
  systemStats: document.querySelector("#templateSystemStats"),
  userStats: document.querySelector("#templateUserStats"),
  runtimePreview: document.querySelector("#runtimePromptPreview"),
  runtimePreviewMeta: document.querySelector("#runtimePromptPreviewMeta"),
  runtimePreviewSystem: document.querySelector("#runtimePromptPreviewSystem"),
  runtimePreviewUser: document.querySelector("#runtimePromptPreviewUser"),
  budgetBar: document.querySelector("#runtimeBudgetBar"),
  budgetBarValue: document.querySelector("#runtimeBudgetBarValue"),
  budgetBarFill: document.querySelector("#runtimeBudgetBarFill"),
  budgetBarHint: document.querySelector("#runtimeBudgetBarHint")
};

const WECHAT_HTML_LIMIT = 20000;
const WECHAT_HTML_SAFE_LIMIT = 18000;

export async function initPromptTemplates(setStatus) {
  _setStatus = typeof setStatus === "function" ? setStatus : () => {};
  _templates = await getPromptTemplates();
  const activeId = await getActiveTemplateId();
  _selectedId = _templates.some((t) => t.id === activeId) ? activeId : (_templates[0]?.id || "");
  renderList();
  selectTemplate(_selectedId);
  bindEvents(setStatus);
}

function bindEvents(setStatus) {
  els.addBtn?.addEventListener("click", () => createNewTemplate(setStatus));
  els.restoreBtn?.addEventListener("click", () => restoreSelectedTemplate(setStatus));
  els.dupBtn?.addEventListener("click", () => duplicateSelectedTemplate(setStatus));
  els.delBtn?.addEventListener("click", () => deleteSelectedTemplate(setStatus));
  els.previewBtn?.addEventListener("click", () => openPreviewPrompt());
  els.exportBtn?.addEventListener("click", () => exportTemplates(setStatus));
  els.importBtn?.addEventListener("click", () => els.importInput?.click());
  els.importInput?.addEventListener("change", (e) => importTemplates(e, setStatus));
  els.previewCloseBtn?.addEventListener("click", closePreviewPrompt);
  els.previewBackdrop?.addEventListener("click", (e) => {
    if (e.target === els.previewBackdrop) closePreviewPrompt();
  });
  els.searchInput?.addEventListener("input", () => {
    _filterQuery = els.searchInput.value.trim().toLowerCase();
    renderList();
  });

  [els.system, els.user].forEach((ta) => {
    ta?.addEventListener("focus", () => {
      _lastFocusedTextarea = ta;
    });
  });

  document.querySelectorAll(".var-chip").forEach((btn) => {
    btn.addEventListener("click", () => {
      const variable = btn.dataset.var;
      if (_lastFocusedTextarea) {
        insertAtCursor(_lastFocusedTextarea, `{{${variable}}}`);
      } else if (els.system) {
        insertAtCursor(els.system, `{{${variable}}}`);
      }
    });
  });

  // Auto-save on input
  const autoSaveFields = [
    els.icon, els.name, els.system, els.user,
    els.defaultTone, els.defaultAngle, els.defaultLength,
    els.defaultCta, els.defaultAudience, els.temperature, els.model
  ];
  autoSaveFields.forEach((field) => {
    field?.addEventListener("input", debounce(() => {
      if (_selectedId) {
        saveCurrentFormToTemplate();
        savePromptTemplates(_templates).catch(() => {});
        renderList();
        updateTemplateMeta(_templates.find((t) => t.id === _selectedId) || null);
        updateRuntimePreview(_templates.find((t) => t.id === _selectedId) || null);
      }
    }, 400));
  });
}

function renderList() {
  if (!els.list) return;
  updateTemplateStats();
  const visibleTemplates = _templates.filter(matchesFilter);
  if (visibleTemplates.length === 0) {
    els.list.innerHTML = '<li class="templates-list-empty">没有匹配的模板，换个关键词试试。</li>';
    return;
  }

  els.list.innerHTML = visibleTemplates
    .map((t) => {
      const isPreset = PRESET_IDS.has(t.id);
      const isActive = t.id === _selectedId;
      return `<li class="template-item ${isActive ? "active" : ""} ${isPreset ? "preset" : "custom"}" data-id="${escapeAttr(t.id)}">
        <span class="template-item-icon">${escapeHtml(t.icon || "📝")}</span>
        <span class="template-item-name">${escapeHtml(t.name || "未命名")}</span>
        ${isPreset ? '<span class="template-item-badge">预设</span>' : ""}
        ${isPreset ? "" : `<button type="button" class="template-item-delete" data-delete-id="${escapeAttr(t.id)}" aria-label="删除模板 ${escapeAttr(t.name || "未命名")}">删除</button>`}
      </li>`;
    })
    .join("");

  els.list.querySelectorAll(".template-item").forEach((item) => {
    item.addEventListener("click", () => {
      selectTemplate(item.dataset.id);
    });
  });

  els.list.querySelectorAll(".template-item-delete").forEach((button) => {
    button.addEventListener("click", async (event) => {
      event.stopPropagation();
      await deleteTemplateById(button.dataset.deleteId, _setStatus);
    });
  });
}

function selectTemplate(id) {
  _selectedId = id;
  renderList();
  const template = _templates.find((t) => t.id === id);
  if (!template) {
    els.form.hidden = true;
    els.empty.hidden = false;
    updateTemplateMeta(null);
    updateRuntimePreview(null);
    return;
  }

  els.form.hidden = false;
  els.empty.hidden = true;

  const isPreset = PRESET_IDS.has(template.id);
  els.badge.hidden = !isPreset;
  els.restoreBtn.hidden = !isPreset;
  els.delBtn.hidden = isPreset;

  els.icon.value = template.icon || "";
  els.name.value = template.name || "";
  els.system.value = template.systemTemplate || "";
  els.user.value = template.userTemplate || "";
  els.defaultTone.value = template.defaults?.tone || "";
  els.defaultAngle.value = template.defaults?.angle || "";
  els.defaultLength.value = template.defaults?.length || "medium";
  els.defaultCta.value = template.defaults?.cta || "";
  els.defaultAudience.value = template.defaults?.audience || "";
  els.temperature.value = template.temperature != null ? String(template.temperature) : "";
  els.model.value = template.model || "";
  updateTemplateMeta(template);
  updateRuntimePreview(template);
}

function saveCurrentFormToTemplate() {
  const template = _templates.find((t) => t.id === _selectedId);
  if (!template) return;

  template.icon = els.icon.value.trim();
  template.name = els.name.value.trim();
  template.systemTemplate = els.system.value;
  template.userTemplate = els.user.value;
  template.defaults = {
    tone: els.defaultTone.value.trim(),
    angle: els.defaultAngle.value.trim(),
    length: els.defaultLength.value || "medium",
    cta: els.defaultCta.value.trim(),
    audience: els.defaultAudience.value.trim()
  };
  const tempVal = els.temperature.value.trim();
  template.temperature = tempVal === "" ? null : Number(tempVal);
  template.model = els.model.value.trim() || null;
}

function createNewTemplate(setStatus) {
  const id = `custom-${Date.now()}`;
  const newTemplate = {
    id,
    name: "新模板",
    icon: "📝",
    systemTemplate: `你是一名资深微信公众号编辑。请将提供的来源材料改写成适合公众号发布的文章。

必须遵守这些规则：
1. 只基于提供的来源事实写作，不要编造数据。
2. 输出必须是合法 JSON，且只输出 JSON。
3. JSON 字段必须包含 title、subtitle、lead、sections、closing、cta、wechatTitleOptions、keywords。
4. 保留所有来源图片，不要删除或替换图片。
5. 保留所有代码块、表格和数学公式原样。`,
    userTemplate: `请将下面的来源材料改写成公众号文章。

改写目标：
{
  "audience": "{{audience}}",
  "tone": "{{tone}}",
  "angle": "{{angle}}",
  "requestedLength": "{{length}}",
  "cta": "{{cta}}"
}

来源信息：
- 标题：{{title}}
- URL：{{url}}
- 字数：{{wordCount}}
- 图片数：{{imageCount}}

正文内容：
{{content}}`,
    defaults: {
      tone: "",
      angle: "",
      length: "medium",
      cta: "",
      audience: ""
    },
    temperature: null,
    model: null
  };
  _templates.push(newTemplate);
  savePromptTemplates(_templates).then(() => {
    selectTemplate(id);
    renderList();
    setStatus("已创建新模板。", "success");
    els.name?.focus();
    els.name?.select();
  });
}

function duplicateSelectedTemplate(setStatus) {
  const template = _templates.find((t) => t.id === _selectedId);
  if (!template) return;
  const newId = `custom-${Date.now()}`;
  const copy = {
    ...template,
    id: newId,
    name: `${template.name}（副本）`,
    icon: template.icon
  };
  _templates.push(copy);
  savePromptTemplates(_templates).then(() => {
    selectTemplate(newId);
    renderList();
    setStatus("已复制为新模板。", "success");
  });
}

function restoreSelectedTemplate(setStatus) {
  const template = _templates.find((t) => t.id === _selectedId);
  if (!template) return;
  const original = DEFAULT_PROMPT_TEMPLATES.find((t) => t.id === template.id);
  if (!original) {
    setStatus("找不到该预设的默认版本。", "warning");
    return;
  }
  const idx = _templates.findIndex((t) => t.id === template.id);
  _templates[idx] = { ...original };
  savePromptTemplates(_templates).then(() => {
    selectTemplate(template.id);
    renderList();
    setStatus("已恢复默认内容。", "success");
  });
}

function deleteSelectedTemplate(setStatus) {
  return deleteTemplateById(_selectedId, setStatus);
}

async function deleteTemplateById(id, setStatus) {
  const template = _templates.find((t) => t.id === id);
  if (!template) return;
  if (PRESET_IDS.has(template.id)) {
    setStatus("预设模板不能删除。", "warning");
    return;
  }
  if (!confirm(`确定删除模板「${template.name}」？`)) return;

  const currentIndex = _templates.findIndex((t) => t.id === template.id);
  _templates = _templates.filter((t) => t.id !== template.id);
  const nextTemplate =
    _templates[currentIndex] ||
    _templates[currentIndex - 1] ||
    _templates[0] ||
    null;

  const activeTemplateId = await getActiveTemplateId();
  if (activeTemplateId === template.id) {
    await setActiveTemplateId("");
  }

  _selectedId = nextTemplate?.id || "";
  await savePromptTemplates(_templates);
  renderList();
  selectTemplate(_selectedId);
  setStatus(`模板「${template.name}」已删除。`, "success");
}

function openPreviewPrompt() {
  const template = _templates.find((t) => t.id === _selectedId);
  if (!template) return;

  const messages = buildRuntimePreviewMessages(template);
  const systemPrompt = messages.find((message) => message.role === "system")?.content || "";
  const userPrompt = messages.find((message) => message.role === "user")?.content || "";

  const systemChars = systemPrompt.length;
  const userChars = userPrompt.length;

  els.previewMeta.textContent =
    `System 约 ${systemChars} 字符 · User 约 ${userChars} 字符 · 总计约 ${systemChars + userChars} 字符 · 已包含图片定位、去 AI 味约束与 20000 字符限制`;
  els.previewSystem.textContent = `SYSTEM（最终发送）:\n${systemPrompt}`;
  els.previewUser.textContent = `USER（最终发送）:\n${userPrompt}`;
  els.previewBackdrop.hidden = false;
}

function closePreviewPrompt() {
  if (els.previewBackdrop) els.previewBackdrop.hidden = true;
}

function exportTemplates(setStatus) {
  const payload = {
    version: 1,
    exportedAt: new Date().toISOString(),
    templates: _templates
  };
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = `prompt-templates-${new Date().toISOString().slice(0, 10)}.json`;
  anchor.click();
  URL.revokeObjectURL(url);
  setStatus("模板已导出。", "success");
}

async function importTemplates(event, setStatus) {
  const file = event.target.files?.[0];
  event.target.value = "";
  if (!file) return;

  try {
    const text = await file.text();
    const payload = JSON.parse(text);
    const imported = payload?.templates;
    if (!Array.isArray(imported) || imported.length === 0) {
      setStatus("导入文件格式不正确。", "error");
      return;
    }

    // Validate shape
    const valid = imported.filter((t) => t.id && t.systemTemplate && t.userTemplate);
    if (valid.length === 0) {
      setStatus("没有有效的模板可导入。", "error");
      return;
    }

    // Merge: replace existing by id, append new ones
    const map = new Map(_templates.map((t) => [t.id, t]));
    for (const t of valid) {
      map.set(t.id, t);
    }
    _templates = Array.from(map.values());
    await savePromptTemplates(_templates);
    if (!_selectedId && _templates[0]) {
      _selectedId = _templates[0].id;
    }
    renderList();
    selectTemplate(_selectedId);
    setStatus(`已导入 ${valid.length} 个模板。`, "success");
  } catch (error) {
    setStatus(error?.message || "导入失败。", "error");
  }
}

function updateTemplateStats() {
  const presetCount = _templates.filter((t) => PRESET_IDS.has(t.id)).length;
  const customCount = Math.max(0, _templates.length - presetCount);
  if (els.totalCount) els.totalCount.textContent = String(_templates.length);
  if (els.presetCount) els.presetCount.textContent = String(presetCount);
  if (els.customCount) els.customCount.textContent = String(customCount);
}

function matchesFilter(template) {
  if (!_filterQuery) return true;
  const haystack = [
    template.name,
    template.icon,
    PRESET_IDS.has(template.id) ? "预设" : "自定义",
    template.defaults?.tone,
    template.defaults?.angle
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
  return haystack.includes(_filterQuery);
}

function updateTemplateMeta(template) {
  const systemLength = String(els.system?.value || "").length;
  const userLength = String(els.user?.value || "").length;
  if (els.systemStats) {
    els.systemStats.textContent = `${systemLength} 字符`;
  }
  if (els.userStats) {
    els.userStats.textContent = `${userLength} 字符`;
  }
  if (!template) {
    if (els.liveMeta) {
      els.liveMeta.textContent = _filterQuery ? "当前筛选中，未选中模板" : "未选择模板";
    }
    return;
  }

  const isPreset = PRESET_IDS.has(template.id);
  if (els.kindPill) {
    els.kindPill.textContent = isPreset ? "预设模板" : "自定义模板";
    els.kindPill.dataset.kind = isPreset ? "preset" : "custom";
  }

  const effectiveModel = String(els.model?.value || "").trim() || "跟随全局";
  const effectiveTemperature = String(els.temperature?.value || "").trim() || "跟随全局";
  const defaultCount = [
    els.defaultTone?.value,
    els.defaultAngle?.value,
    els.defaultLength?.value,
    els.defaultCta?.value,
    els.defaultAudience?.value
  ].filter((value) => String(value || "").trim()).length;

  if (els.liveMeta) {
    els.liveMeta.textContent =
      `${isPreset ? "预设" : "自定义"} · System ${systemLength} 字符 · User ${userLength} 字符 · 默认项 ${defaultCount} 个 · Model ${effectiveModel} · Temperature ${effectiveTemperature}`;
  }
}

function updateRuntimePreview(template) {
  if (!els.runtimePreview) return;
  if (!template) {
    els.runtimePreview.hidden = true;
    if (els.runtimePreviewMeta) els.runtimePreviewMeta.textContent = "等待生成预览";
    if (els.runtimePreviewSystem) els.runtimePreviewSystem.textContent = "";
    if (els.runtimePreviewUser) els.runtimePreviewUser.textContent = "";
    if (els.budgetBar) els.budgetBar.hidden = true;
    return;
  }

  const messages = buildRuntimePreviewMessages(template);
  const systemPrompt = messages.find((message) => message.role === "system")?.content || "";
  const userPrompt = messages.find((message) => message.role === "user")?.content || "";
  const systemChars = systemPrompt.length;
  const userChars = userPrompt.length;

  els.runtimePreview.hidden = false;
  if (els.runtimePreviewMeta) {
    els.runtimePreviewMeta.textContent =
      `System ${systemChars} 字符 · User ${userChars} 字符 · 总计 ${systemChars + userChars} 字符`;
  }
  if (els.runtimePreviewSystem) {
    els.runtimePreviewSystem.textContent = systemPrompt;
  }
  if (els.runtimePreviewUser) {
    els.runtimePreviewUser.textContent = userPrompt;
  }
  updateBudgetBar(template);
}

function updateBudgetBar(template) {
  if (!els.budgetBar) return;
  const lengthKey = String(template?.defaults?.length || "medium");
  const targetChars = estimateTargetChars(lengthKey);
  const imageCount = 2; // 预览用的示例来源包含 2 张图
  const estimatedHtml = estimateExportHtmlLength(targetChars, imageCount);
  const percent = Math.min(100, Math.round((estimatedHtml / WECHAT_HTML_LIMIT) * 100));
  const level =
    estimatedHtml > WECHAT_HTML_LIMIT
      ? "danger"
      : estimatedHtml > WECHAT_HTML_SAFE_LIMIT
      ? "warn"
      : "ok";

  els.budgetBar.hidden = false;
  if (els.budgetBarFill) {
    els.budgetBarFill.style.width = `${percent}%`;
    els.budgetBarFill.dataset.level = level;
  }
  if (els.budgetBarValue) {
    els.budgetBarValue.textContent =
      `${estimatedHtml.toLocaleString()} / ${WECHAT_HTML_LIMIT.toLocaleString()} 字符`;
  }
  if (els.budgetBarHint) {
    const lengthLabel = { short: "短文 800-1200 字", medium: "标准 1200-1800 字", long: "长文 1800-2600 字" }[lengthKey] || lengthKey;
    const baseHint = `估算依据：${lengthLabel} × 主题样式 + ${imageCount} 张示例图（每张约 220 字符 HTML）。真实长度会随正文变化，超出 20000 会在运行时自动压缩。`;
    els.budgetBarHint.textContent =
      level === "danger"
        ? `将超出 20000 字符硬上限，建议把默认篇幅切到更短档位。${baseHint}`
        : level === "warn"
        ? `已进入安全区上沿（>18000），请确认模板允许压缩 bulletPoints 与 quote。${baseHint}`
        : `目前处于安全区内。${baseHint}`;
    els.budgetBarHint.dataset.level = level;
  }
  els.budgetBar.querySelector(".runtime-budget-bar-track")?.setAttribute("aria-valuenow", String(estimatedHtml));
}

function estimateTargetChars(lengthKey) {
  if (lengthKey === "short") return 1000;
  if (lengthKey === "long") return 2200;
  return 1500;
}

function estimateExportHtmlLength(targetChars, imageCount) {
  const markupOverhead = Math.round(targetChars * 0.28);
  const themeShell = 1400;
  const perImage = 220;
  return targetChars + markupOverhead + themeShell + imageCount * perImage;
}

function buildRuntimePreviewMessages(template) {
  const previewTemplate = {
    ...template,
    systemTemplate: String(els.system?.value ?? template.systemTemplate ?? ""),
    userTemplate: String(els.user?.value ?? template.userTemplate ?? ""),
    defaults: {
      tone: String(els.defaultTone?.value ?? template.defaults?.tone ?? ""),
      angle: String(els.defaultAngle?.value ?? template.defaults?.angle ?? ""),
      length: String(els.defaultLength?.value ?? template.defaults?.length ?? "medium"),
      cta: String(els.defaultCta?.value ?? template.defaults?.cta ?? ""),
      audience: String(els.defaultAudience?.value ?? template.defaults?.audience ?? "")
    },
    temperature: normalizeOptionalNumber(els.temperature?.value, template.temperature),
    model: String(els.model?.value ?? template.model ?? "").trim() || null
  };

  const demoSource = {
    title: "Google 悄悄发布 Android CLI，开发流开始往终端里挤",
    url: "https://example.com/android-cli",
    siteName: "示例站点",
    wordCount: 1280,
    keywords: ["Android CLI", "Google", "开发工具"],
    images: [
      { src: "https://example.com/image-1.png", alt: "命令行截图", caption: "CLI 运行界面" },
      { src: "https://example.com/image-2.png", alt: "功能对比图", caption: "能力对比" }
    ],
    blocks: [
      { type: "paragraph", text: "Google 最近把一个面向 Android 开发者的命令行工具 quietly 放了出来，核心卖点是把原来分散在 IDE、脚手架和文档里的动作，尽量压到终端里完成。" },
      { type: "heading", level: 2, text: "它想解决的不是“能不能做”，而是“少切几个窗口”" },
      { type: "paragraph", text: "对熟悉终端的人来说，这类工具真正有吸引力的地方，往往不是功能多，而是流程更短。初始化、编译、调试、拉起模拟器，如果能在一条链路里走完，体验会顺很多。" },
      { type: "code", language: "bash", text: "android create project\nandroid build\nandroid emulator start" }
    ]
  };
  const demoPreferences = {
    audience: previewTemplate.defaults?.audience || "关注效率工具和开发流的读者",
    tone: previewTemplate.defaults?.tone || "专业冷静",
    angle: previewTemplate.defaults?.angle || "提炼观点",
    length: previewTemplate.defaults?.length || "medium",
    cta: previewTemplate.defaults?.cta || "结尾给出一个明确判断或可执行建议",
    articleIndex: 1,
    totalArticles: 1
  };
  const demoSettings = {
    defaultAudience: "关注效率工具和开发流的读者",
    defaultTone: "专业冷静",
    defaultAngle: "提炼观点",
    defaultCta: "结尾给出一个明确判断或可执行建议"
  };

  return buildRewriteMessages(demoSource, demoPreferences, demoSettings, previewTemplate);
}

function normalizeOptionalNumber(value, fallback) {
  const text = String(value ?? "").trim();
  if (!text) return fallback ?? null;
  const parsed = Number(text);
  return Number.isFinite(parsed) ? parsed : (fallback ?? null);
}

function insertAtCursor(textarea, text) {
  const start = textarea.selectionStart;
  const end = textarea.selectionEnd;
  const before = textarea.value.slice(0, start);
  const after = textarea.value.slice(end);
  textarea.value = before + text + after;
  textarea.selectionStart = textarea.selectionEnd = start + text.length;
  textarea.focus();
}

function debounce(fn, delayMs = 250) {
  let timer = null;
  return (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), delayMs);
  };
}

function escapeAttr(value) {
  return escapeHtml(value).replace(/"/g, "&quot;");
}
