import { DEFAULT_PROMPT_TEMPLATES, MAGAZINE_THEMES } from "../shared/defaults.js";
import {
  getPromptTemplates,
  savePromptTemplates,
  getActiveTemplateId,
  setActiveTemplateId
} from "../shared/storage.js";
import { buildRewriteMessages } from "../shared/ai.js";
import { escapeHtml } from "../shared/utils.js";
import {
  PAID_FEATURES,
  PRO_TEMPLATE_IDS,
  checkLicense,
  checkTemplateAccess,
  subscribeLicenseChanges
} from "../shared/license.js";
import { showUpgradeModal } from "../shared/upgrade-modal.js";
import { generateTemplate, QUIZ_OPTIONS } from "../shared/template-generator.js";

let _templates = [];
let _selectedId = "";
let _activeId = "";
let _lastFocusedTextarea = null;
let _setStatus = () => {};

const PRESET_IDS = new Set(DEFAULT_PROMPT_TEMPLATES.map((t) => t.id));
const PRO_IDS = new Set(PRO_TEMPLATE_IDS);

const els = {};
const SELECTORS = {
  list: "#templateList",
  form: "#templateEditorForm",
  empty: "#templateEmptyState",
  icon: "#templateIcon",
  name: "#templateName",
  system: "#templateSystem",
  user: "#templateUser",
  defaultTone: "#templateDefaultTone",
  defaultAngle: "#templateDefaultAngle",
  defaultLength: "#templateDefaultLength",
  defaultCta: "#templateDefaultCta",
  defaultAudience: "#templateDefaultAudience",
  temperature: "#templateTemperature",
  model: "#templateModel",
  badge: "#templateBadge",
  liveMeta: "#templateLiveMeta",
  systemStats: "#templateSystemStats",
  userStats: "#templateUserStats",
  addBtn: "#addTemplateButton",
  aiGenBtn: "#aiGenerateTemplateButton",
  restoreBtn: "#restoreTemplateButton",
  dupBtn: "#duplicateTemplateButton",
  delBtn: "#deleteTemplateButton",
  activeBtn: "#setActiveTemplateButton",
  previewBtn: "#previewPromptButton",
  exportBtn: "#exportTemplatesButton",
  importBtn: "#importTemplatesButton",
  importInput: "#importTemplatesInput",
  previewBackdrop: "#promptPreviewBackdrop",
  previewCloseBtn: "#promptPreviewCloseBtn",
  previewMeta: "#promptPreviewMeta",
  previewSystem: "#promptPreviewSystem",
  previewUser: "#promptPreviewUser",
  activePill: "#templateActivePill",
  // AI 生成模板对话框（问卷驱动 v0.4）
  aiGenBackdrop: "#aiGenBackdrop",
  aiGenCloseBtn: "#aiGenCloseBtn",
  aiGenStepInput: "#aiGenStepInput",
  aiGenStepLoading: "#aiGenStepLoading",
  aiGenStepPreview: "#aiGenStepPreview",
  aiGenContentPillarOther: "#aiGenContentPillarOther",
  aiGenAudience: "#aiGenAudience",
  aiGenExtraNotes: "#aiGenExtraNotes",
  aiGenError: "#aiGenError",
  aiGenSubmit: "#aiGenSubmit",
  aiGenSubmitLabel: "#aiGenSubmitLabel",
  aiGenRetryBtn: "#aiGenRetryBtn",
  aiGenSaveBtn: "#aiGenSaveBtn",
  aiGenPreviewIcon: "#aiGenPreviewIcon",
  aiGenPreviewName: "#aiGenPreviewName",
  aiGenPreviewMeta: "#aiGenPreviewMeta",
  aiGenPreviewStyle: "#aiGenPreviewStyle",
  aiGenPreviewDefaults: "#aiGenPreviewDefaults",
  aiGenPreviewTheme: "#aiGenPreviewTheme",
  aiGenPreviewThemeName: "#aiGenPreviewThemeName",
  aiGenPreviewThemeSummary: "#aiGenPreviewThemeSummary"
};

// 当前问卷答案（在对话框打开期间内存中维护，关闭时清空）
let _quizAnswers = createEmptyQuizAnswers();
function createEmptyQuizAnswers() {
  return {
    contentPillar: "",
    contentPillarOther: "",
    tone: "",
    opening: "",
    rhythm: "standard",   // 给一个温和的默认
    cta: "",
    visualTheme: "",
    audience: "",
    extraNotes: ""
  };
}

// 待保存的 AI 生成模板（在「预览」状态下暂存）
let _pendingAiTemplate = null;
let _aiGenAbortController = null;

export async function initPromptTemplates(setStatus) {
  _setStatus = typeof setStatus === "function" ? setStatus : () => {};

  for (const [key, selector] of Object.entries(SELECTORS)) {
    els[key] = document.querySelector(selector);
  }

  if (!els.list || !els.form) {
    return;
  }

  _templates = await getPromptTemplates();
  _activeId = await getActiveTemplateId();
  if (_activeId && !_templates.some((t) => t.id === _activeId)) {
    _activeId = "";
    await setActiveTemplateId("");
  }
  _selectedId = _activeId || _templates[0]?.id || "";

  renderList();
  selectTemplate(_selectedId);
  bindEvents();
  updateActivePill();

  // license / 登录态变化时刷新模板列表（PRO badge 与可点击状态实时同步）
  subscribeLicenseChanges(() => {
    renderList();
    updateActivePill();
  });
}

function bindEvents() {
  els.addBtn?.addEventListener("click", createNewTemplate);
  els.aiGenBtn?.addEventListener("click", openAiGenDialog);
  els.restoreBtn?.addEventListener("click", restoreSelectedTemplate);
  els.dupBtn?.addEventListener("click", duplicateSelectedTemplate);
  els.delBtn?.addEventListener("click", () => deleteTemplateById(_selectedId));
  els.activeBtn?.addEventListener("click", setSelectedAsActive);
  els.previewBtn?.addEventListener("click", openPreviewPrompt);
  els.exportBtn?.addEventListener("click", exportTemplates);
  els.importBtn?.addEventListener("click", () => els.importInput?.click());
  els.importInput?.addEventListener("change", importTemplates);
  els.previewCloseBtn?.addEventListener("click", closePreviewPrompt);
  els.previewBackdrop?.addEventListener("click", (e) => {
    if (e.target === els.previewBackdrop) closePreviewPrompt();
  });

  // AI 生成模板对话框
  els.aiGenCloseBtn?.addEventListener("click", closeAiGenDialog);
  els.aiGenBackdrop?.addEventListener("click", (e) => {
    if (e.target === els.aiGenBackdrop) closeAiGenDialog();
  });
  els.aiGenSubmit?.addEventListener("click", submitAiGen);
  els.aiGenRetryBtn?.addEventListener("click", () => {
    _pendingAiTemplate = null;
    showAiGenStep("input");
  });
  els.aiGenSaveBtn?.addEventListener("click", saveAiGenerated);

  // 问卷选项一次性渲染（每次打开对话框时也会重置选中态）
  renderQuizOptions();
  els.aiGenContentPillarOther?.addEventListener("input", (e) => {
    _quizAnswers.contentPillarOther = String(e.target.value || "");
  });
  els.aiGenAudience?.addEventListener("input", (e) => {
    _quizAnswers.audience = String(e.target.value || "");
  });
  els.aiGenExtraNotes?.addEventListener("input", (e) => {
    _quizAnswers.extraNotes = String(e.target.value || "");
  });

  [els.system, els.user].forEach((ta) => {
    ta?.addEventListener("focus", () => {
      _lastFocusedTextarea = ta;
    });
  });

  document.querySelectorAll(".var-chip").forEach((btn) => {
    btn.addEventListener("click", () => {
      const variable = btn.dataset.var;
      const target = _lastFocusedTextarea || els.system;
      if (target) insertAtCursor(target, `{{${variable}}}`);
    });
  });

  const autoSaveFields = [
    els.icon,
    els.name,
    els.system,
    els.user,
    els.defaultTone,
    els.defaultAngle,
    els.defaultLength,
    els.defaultCta,
    els.defaultAudience,
    els.temperature,
    els.model
  ];
  const debouncedSave = debounce(async () => {
    if (!_selectedId) return;
    saveCurrentFormToTemplate();
    await savePromptTemplates(_templates);
    renderList();
    updateTemplateMeta(_templates.find((t) => t.id === _selectedId) || null);
  }, 350);
  autoSaveFields.forEach((field) => {
    field?.addEventListener("input", debouncedSave);
  });
}

function renderList() {
  if (!els.list) return;
  if (_templates.length === 0) {
    els.list.innerHTML = '<li class="templates-list-empty">还没有任何模板，点右上的「新建」开始。</li>';
    return;
  }

  els.list.innerHTML = _templates
    .map((t) => {
      const isPreset = PRESET_IDS.has(t.id);
      const isActive = t.id === _selectedId;
      const isCurrent = t.id === _activeId;
      const isPro = PRO_IDS.has(t.id);
      return `<li class="template-item${isActive ? " active" : ""}${isPreset ? " preset" : " custom"}${isPro ? " pro" : ""}" data-id="${escapeAttr(t.id)}">
        <span class="template-item-icon">${escapeHtml(t.icon || "📝")}</span>
        <span class="template-item-name">${escapeHtml(t.name || "未命名")}</span>
        ${isCurrent ? '<span class="template-item-active" title="当前生效中">使用中</span>' : ""}
        ${isPro ? '<span class="template-item-pro" title="Pro 套餐限定模板">PRO</span>' : ""}
        ${isPreset ? '<span class="template-item-badge">预设</span>' : ""}
        ${isPreset ? "" : `<button type="button" class="template-item-delete" data-delete-id="${escapeAttr(t.id)}" aria-label="删除模板 ${escapeAttr(t.name || "未命名")}">删除</button>`}
      </li>`;
    })
    .join("");

  els.list.querySelectorAll(".template-item").forEach((item) => {
    item.addEventListener("click", () => selectTemplate(item.dataset.id));
  });

  els.list.querySelectorAll(".template-item-delete").forEach((button) => {
    button.addEventListener("click", (event) => {
      event.stopPropagation();
      deleteTemplateById(button.dataset.deleteId);
    });
  });
}

function selectTemplate(id) {
  _selectedId = id;
  renderList();
  const template = _templates.find((t) => t.id === id);
  if (!template) {
    if (els.form) els.form.hidden = true;
    if (els.empty) els.empty.hidden = false;
    updateTemplateMeta(null);
    return;
  }

  if (els.form) els.form.hidden = false;
  if (els.empty) els.empty.hidden = true;

  const isPreset = PRESET_IDS.has(template.id);
  if (els.badge) els.badge.hidden = !isPreset;
  if (els.restoreBtn) els.restoreBtn.hidden = !isPreset;
  if (els.delBtn) els.delBtn.hidden = isPreset;

  if (els.icon) els.icon.value = template.icon || "";
  if (els.name) els.name.value = template.name || "";
  if (els.system) els.system.value = template.systemTemplate || "";
  if (els.user) els.user.value = template.userTemplate || "";
  if (els.defaultTone) els.defaultTone.value = template.defaults?.tone || "";
  if (els.defaultAngle) els.defaultAngle.value = template.defaults?.angle || "";
  if (els.defaultLength) els.defaultLength.value = template.defaults?.length || "medium";
  if (els.defaultCta) els.defaultCta.value = template.defaults?.cta || "";
  if (els.defaultAudience) els.defaultAudience.value = template.defaults?.audience || "";
  if (els.temperature) {
    els.temperature.value = template.temperature != null ? String(template.temperature) : "";
  }
  if (els.model) els.model.value = template.model || "";
  updateTemplateMeta(template);
}

function saveCurrentFormToTemplate() {
  const template = _templates.find((t) => t.id === _selectedId);
  if (!template) return;

  template.icon = els.icon?.value.trim() || "📝";
  template.name = els.name?.value.trim() || "未命名";
  template.systemTemplate = els.system?.value || "";
  template.userTemplate = els.user?.value || "";
  template.defaults = {
    tone: els.defaultTone?.value.trim() || "",
    angle: els.defaultAngle?.value.trim() || "",
    length: els.defaultLength?.value || "medium",
    cta: els.defaultCta?.value.trim() || "",
    audience: els.defaultAudience?.value.trim() || ""
  };
  const tempVal = els.temperature?.value.trim();
  template.temperature = tempVal === "" || tempVal == null ? null : Number(tempVal);
  template.model = els.model?.value.trim() || "";
}

async function createNewTemplate() {
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
    model: ""
  };
  _templates.push(newTemplate);
  await savePromptTemplates(_templates);
  selectTemplate(id);
  renderList();
  _setStatus("已创建新模板。", "success");
  els.name?.focus();
  els.name?.select();
}

async function duplicateSelectedTemplate() {
  const template = _templates.find((t) => t.id === _selectedId);
  if (!template) return;
  const newId = `custom-${Date.now()}`;
  const copy = {
    ...template,
    defaults: { ...template.defaults },
    id: newId,
    name: `${template.name}（副本）`
  };
  _templates.push(copy);
  await savePromptTemplates(_templates);
  selectTemplate(newId);
  renderList();
  _setStatus("已复制为新模板。", "success");
}

async function restoreSelectedTemplate() {
  const template = _templates.find((t) => t.id === _selectedId);
  if (!template) return;
  const original = DEFAULT_PROMPT_TEMPLATES.find((t) => t.id === template.id);
  if (!original) {
    _setStatus("找不到该预设的默认版本。", "warning");
    return;
  }
  const idx = _templates.findIndex((t) => t.id === template.id);
  _templates[idx] = {
    ...original,
    defaults: { ...original.defaults }
  };
  await savePromptTemplates(_templates);
  selectTemplate(template.id);
  renderList();
  _setStatus("已恢复为预设默认内容。", "success");
}

async function deleteTemplateById(id) {
  const template = _templates.find((t) => t.id === id);
  if (!template) return;
  if (PRESET_IDS.has(template.id)) {
    _setStatus("预设模板不能删除，可点「恢复默认」回到原版。", "warning");
    return;
  }
  if (!confirm(`确定删除模板「${template.name}」？`)) return;

  const currentIndex = _templates.findIndex((t) => t.id === template.id);
  _templates = _templates.filter((t) => t.id !== template.id);

  if (_activeId === template.id) {
    _activeId = "";
    await setActiveTemplateId("");
    updateActivePill();
  }

  const next = _templates[currentIndex] || _templates[currentIndex - 1] || _templates[0] || null;
  _selectedId = next?.id || "";
  await savePromptTemplates(_templates);
  renderList();
  selectTemplate(_selectedId);
  _setStatus(`模板「${template.name}」已删除。`, "success");
}

async function setSelectedAsActive() {
  if (!_selectedId) return;
  const template = _templates.find((t) => t.id === _selectedId);
  if (!template) return;

  // 闸门：如果选中的是 Pro 限定预设，但当前不是 Pro，弹升级框
  const access = await checkTemplateAccess(template.id);
  if (!access.ok) {
    showUpgradeModal({
      featureName: PAID_FEATURES["ai.advancedTemplates"].name,
      hint: access.hint || PAID_FEATURES["ai.advancedTemplates"].hint,
      bullets: [
        "深度行业观察：抛事实 + 给判断 + 反方视角",
        "故事化叙述：用场景与人物切入，把信息融进叙述",
        "教程拆解：步骤化、可复现、含前置与坑点",
        "免费版仍可用清单整理 / 新闻速读，以及全部自定义模板"
      ],
      primaryAction: {
        label: "查看 Pro 套餐",
        url: (typeof window !== "undefined" && window.__pricingUrl) || "https://gzh.example.com/pricing"
      }
    });
    return;
  }

  _activeId = template.id;
  await setActiveTemplateId(_activeId);
  renderList();
  updateActivePill();
  _setStatus(`已把「${template.name}」设为编辑台默认改写模板。`, "success");
}

function updateActivePill() {
  if (!els.activePill) return;
  const active = _templates.find((t) => t.id === _activeId);
  if (active) {
    els.activePill.textContent = `当前生效：${active.icon || "📝"} ${active.name}`;
    els.activePill.dataset.state = "active";
  } else {
    els.activePill.textContent = "当前未启用任何模板（使用内置默认 prompt）";
    els.activePill.dataset.state = "idle";
  }
}

function openPreviewPrompt() {
  const template = _templates.find((t) => t.id === _selectedId);
  if (!template || !els.previewBackdrop) return;

  saveCurrentFormToTemplate();

  const messages = buildRewriteMessages(
    DEMO_SOURCE,
    DEMO_PREFERENCES,
    DEMO_SETTINGS,
    template
  );
  const systemPrompt = messages.find((m) => m.role === "system")?.content || "";
  const userPrompt = messages.find((m) => m.role === "user")?.content || "";
  const totalChars = systemPrompt.length + userPrompt.length;

  if (els.previewMeta) {
    els.previewMeta.textContent = `System ${systemPrompt.length} 字符 · User ${userPrompt.length} 字符 · 共 ${totalChars} 字符 · 已用示例数据填充`;
  }
  if (els.previewSystem) {
    els.previewSystem.textContent = `SYSTEM:\n${systemPrompt}`;
  }
  if (els.previewUser) {
    els.previewUser.textContent = `USER:\n${userPrompt}`;
  }
  els.previewBackdrop.hidden = false;
}

function closePreviewPrompt() {
  if (els.previewBackdrop) els.previewBackdrop.hidden = true;
}

async function exportTemplates() {
  const payload = {
    version: 1,
    exportedAt: new Date().toISOString(),
    templates: _templates
  };
  const blob = new Blob([JSON.stringify(payload, null, 2)], {
    type: "application/json;charset=utf-8"
  });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = `prompt-templates-${new Date().toISOString().slice(0, 10)}.json`;
  anchor.click();
  URL.revokeObjectURL(url);
  _setStatus("模板已导出。", "success");
}

async function importTemplates(event) {
  const file = event.target.files?.[0];
  event.target.value = "";
  if (!file) return;

  try {
    const text = await file.text();
    const payload = JSON.parse(text);
    const imported = payload?.templates;
    if (!Array.isArray(imported) || imported.length === 0) {
      _setStatus("导入文件格式不正确。", "error");
      return;
    }
    const valid = imported.filter((t) => t && t.id && t.systemTemplate && t.userTemplate);
    if (valid.length === 0) {
      _setStatus("没有有效的模板可导入。", "error");
      return;
    }

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
    _setStatus(`已导入 ${valid.length} 个模板。`, "success");
  } catch (error) {
    _setStatus(error?.message || "导入失败。", "error");
  }
}

function updateTemplateMeta(template) {
  const systemLength = String(els.system?.value || "").length;
  const userLength = String(els.user?.value || "").length;
  if (els.systemStats) els.systemStats.textContent = `${systemLength} 字符`;
  if (els.userStats) els.userStats.textContent = `${userLength} 字符`;
  if (!els.liveMeta) return;
  if (!template) {
    els.liveMeta.textContent = "未选择模板";
    return;
  }
  const isPreset = PRESET_IDS.has(template.id);
  const model = String(els.model?.value || "").trim() || "跟随全局";
  const temperature = String(els.temperature?.value || "").trim() || "跟随全局";
  els.liveMeta.textContent = `${isPreset ? "预设" : "自定义"} · System ${systemLength} 字符 · User ${userLength} 字符 · Model ${model} · Temperature ${temperature}`;
}

function insertAtCursor(textarea, text) {
  const start = textarea.selectionStart ?? textarea.value.length;
  const end = textarea.selectionEnd ?? textarea.value.length;
  const before = textarea.value.slice(0, start);
  const after = textarea.value.slice(end);
  textarea.value = before + text + after;
  textarea.selectionStart = textarea.selectionEnd = start + text.length;
  textarea.focus();
  textarea.dispatchEvent(new Event("input", { bubbles: true }));
}

function debounce(fn, delayMs = 300) {
  let timer = null;
  return (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), delayMs);
  };
}

function escapeAttr(value) {
  return escapeHtml(String(value)).replace(/"/g, "&quot;");
}

// =====================================================================
// AI 生成模板（Pro 专享）
// =====================================================================

async function openAiGenDialog() {
  // 闸门：未登录 / 非 Pro 直接弹升级框
  const access = await checkLicense("ai.templateGenerator");
  if (!access.ok) {
    showUpgradeModal({
      featureName: PAID_FEATURES["ai.templateGenerator"].name,
      hint: access.hint || PAID_FEATURES["ai.templateGenerator"].hint,
      bullets: [
        "用一句话描述风格，AI 自动写出专属改写模板",
        "自带角色设定 / 写作纪律 / 默认偏好（受众、调性、CTA）",
        "输出格式 contract 由系统锁死，AI 不会破坏改写链路",
        "可生成无限套；已生成的模板永久保留在你的模板库"
      ],
      primaryAction: {
        label: "查看 Pro 套餐",
        url: (typeof window !== "undefined" && window.__pricingUrl) || "https://docuearn.com/pricing"
      }
    });
    return;
  }

  if (!els.aiGenBackdrop) return;
  _pendingAiTemplate = null;
  resetAiGenForm();
  showAiGenStep("input");
  els.aiGenBackdrop.hidden = false;
}

function closeAiGenDialog() {
  if (!els.aiGenBackdrop) return;
  if (_aiGenAbortController) {
    try { _aiGenAbortController.abort(); } catch { /* ignore */ }
    _aiGenAbortController = null;
  }
  els.aiGenBackdrop.hidden = true;
  _pendingAiTemplate = null;
}

function resetAiGenForm() {
  if (els.aiGenError) {
    els.aiGenError.hidden = true;
    els.aiGenError.textContent = "";
  }
  if (els.aiGenSubmit) els.aiGenSubmit.disabled = false;
  if (els.aiGenSubmitLabel) els.aiGenSubmitLabel.textContent = "生成模板";
  // 清空问卷状态 + 选中态
  _quizAnswers = createEmptyQuizAnswers();
  if (els.aiGenContentPillarOther) {
    els.aiGenContentPillarOther.value = "";
    els.aiGenContentPillarOther.hidden = true;
  }
  if (els.aiGenAudience) els.aiGenAudience.value = "";
  if (els.aiGenExtraNotes) els.aiGenExtraNotes.value = "";
  document
    .querySelectorAll(".ai-gen-quiz-options [data-quiz-option]")
    .forEach((btn) => btn.classList.remove("is-selected"));
  // 默认替我们勾上 rhythm=standard，对新用户更友好
  const defaultRhythmBtn = document.querySelector(
    '[data-quiz="rhythm"] [data-quiz-option="standard"]'
  );
  defaultRhythmBtn?.classList.add("is-selected");
}

/**
 * 把 QUIZ_OPTIONS 渲染成问卷按钮 + 把 MAGAZINE_THEMES 渲染成视觉主题卡片。
 * 用事件委托：每个 `.ai-gen-quiz-options` 容器监听 click，子按钮带 data-quiz-option。
 */
function renderQuizOptions() {
  const containers = document.querySelectorAll(".ai-gen-quiz-options[data-quiz]");
  if (!containers.length) return;

  containers.forEach((container) => {
    const field = container.getAttribute("data-quiz");
    if (!field) return;

    if (field === "visualTheme") {
      // 主题卡片样式（有标题 + 灵感来源 + 摘要）
      container.innerHTML = MAGAZINE_THEMES.map(
        (theme) => `
          <button type="button" class="ai-gen-theme-card" data-quiz-option="${escapeAttr(theme.id)}">
            <span class="ai-gen-theme-name">${escapeHtml(theme.label)}</span>
            <span class="ai-gen-theme-from">灵感 · ${escapeHtml(theme.inspiration)}</span>
            <span class="ai-gen-theme-summary">${escapeHtml(theme.summary)}</span>
            <span class="ai-gen-theme-pairs">适合：${(theme.pairsWith || []).map(escapeHtml).join(" · ")}</span>
          </button>
        `
      ).join("");
    } else {
      const options = QUIZ_OPTIONS[field] || [];
      container.innerHTML = options
        .map(
          (opt) => `
            <button type="button" class="ai-gen-quiz-option" data-quiz-option="${escapeAttr(opt.id)}">
              <span class="ai-gen-quiz-option-label">${escapeHtml(opt.label)}</span>
              ${opt.hint ? `<span class="ai-gen-quiz-option-hint">${escapeHtml(opt.hint)}</span>` : ""}
            </button>
          `
        )
        .join("");
    }

    // 委托点击：单选行为
    container.addEventListener("click", (event) => {
      const target = event.target.closest("[data-quiz-option]");
      if (!target || !container.contains(target)) return;
      const value = target.getAttribute("data-quiz-option") || "";
      _quizAnswers[field] = value;

      container.querySelectorAll("[data-quiz-option]").forEach((btn) =>
        btn.classList.toggle("is-selected", btn === target)
      );

      // contentPillar=other 时显示备注输入
      if (field === "contentPillar" && els.aiGenContentPillarOther) {
        const isOther = value === "other";
        els.aiGenContentPillarOther.hidden = !isOther;
        if (isOther) setTimeout(() => els.aiGenContentPillarOther.focus(), 30);
      }
    });
  });
}

function showAiGenStep(step) {
  if (els.aiGenStepInput) els.aiGenStepInput.hidden = step !== "input";
  if (els.aiGenStepLoading) els.aiGenStepLoading.hidden = step !== "loading";
  if (els.aiGenStepPreview) els.aiGenStepPreview.hidden = step !== "preview";
}

async function submitAiGen() {
  if (els.aiGenError) {
    els.aiGenError.hidden = true;
    els.aiGenError.textContent = "";
  }

  // 二次闸门（用户在对话框开着的时候 license 可能已变化）
  const access = await checkLicense("ai.templateGenerator");
  if (!access.ok) {
    closeAiGenDialog();
    showUpgradeModal({
      featureName: PAID_FEATURES["ai.templateGenerator"].name,
      hint: access.hint || PAID_FEATURES["ai.templateGenerator"].hint,
      bullets: ["升级 Pro 后即可解锁 AI 模板生成器"],
      primaryAction: {
        label: "查看 Pro 套餐",
        url: (typeof window !== "undefined" && window.__pricingUrl) || "https://docuearn.com/pricing"
      }
    });
    return;
  }

  // 客户端先做一轮缺口校验，给出更友好的提示（避免 LLM 调用前就发现答案不全）
  const required = ["contentPillar", "tone", "opening", "rhythm", "cta", "visualTheme"];
  const missing = required.filter((k) => !_quizAnswers[k]);
  if (missing.length) {
    if (els.aiGenError) {
      els.aiGenError.hidden = false;
      els.aiGenError.textContent =
        `还有 ${missing.length} 题没选完。把所有问题答完再生成，效果会高一个量级。`;
    }
    return;
  }
  if (
    _quizAnswers.contentPillar === "other" &&
    !String(_quizAnswers.contentPillarOther || "").trim()
  ) {
    if (els.aiGenError) {
      els.aiGenError.hidden = false;
      els.aiGenError.textContent =
        "「内容定位」选了「其他」，请用一句话告诉我们方向。";
    }
    return;
  }

  showAiGenStep("loading");
  _aiGenAbortController = new AbortController();
  try {
    const { template } = await generateTemplate({
      quiz: { ..._quizAnswers },
      signal: _aiGenAbortController.signal
    });
    _pendingAiTemplate = template;
    renderAiGenPreview(template);
    showAiGenStep("preview");
  } catch (error) {
    showAiGenStep("input");
    if (els.aiGenError) {
      els.aiGenError.hidden = false;
      els.aiGenError.textContent = error?.message || "生成失败，请重试。";
    }
  } finally {
    _aiGenAbortController = null;
  }
}

function renderAiGenPreview(template) {
  if (els.aiGenPreviewIcon) els.aiGenPreviewIcon.textContent = template.icon || "✨";
  if (els.aiGenPreviewName) els.aiGenPreviewName.textContent = template.name || "未命名";
  if (els.aiGenPreviewMeta) {
    els.aiGenPreviewMeta.textContent =
      `温度 ${template.temperature ?? "—"} · 长度 ${template.defaults?.length || "medium"} · 字符数 ${template.systemTemplate.length + template.userTemplate.length}`;
  }
  if (els.aiGenPreviewStyle) {
    els.aiGenPreviewStyle.textContent = template.systemTemplate || "";
  }
  if (els.aiGenPreviewDefaults) {
    const d = template.defaults || {};
    const rows = [
      ["受众", d.audience],
      ["调性", d.tone],
      ["切入角度", d.angle],
      ["结尾 CTA", d.cta]
    ];
    els.aiGenPreviewDefaults.innerHTML = rows
      .map(([label, value]) =>
        `<dt>${escapeHtml(label)}</dt><dd>${escapeHtml(value || "（未设定）")}</dd>`
      )
      .join("");
  }

  // 视觉主题建议卡（来自问卷）
  if (els.aiGenPreviewTheme) {
    const themeId = template.suggestedTheme;
    const meta = themeId ? MAGAZINE_THEMES.find((t) => t.id === themeId) : null;
    if (meta) {
      els.aiGenPreviewTheme.hidden = false;
      if (els.aiGenPreviewThemeName) {
        els.aiGenPreviewThemeName.textContent = `${meta.label}（${meta.inspiration}）`;
      }
      if (els.aiGenPreviewThemeSummary) {
        els.aiGenPreviewThemeSummary.textContent = meta.summary;
      }
    } else {
      els.aiGenPreviewTheme.hidden = true;
    }
  }
}

async function saveAiGenerated() {
  if (!_pendingAiTemplate) return;
  const template = _pendingAiTemplate;
  _pendingAiTemplate = null;

  _templates.push(template);
  await savePromptTemplates(_templates);
  selectTemplate(template.id);
  renderList();
  closeAiGenDialog();

  const themeMeta = template.suggestedTheme
    ? MAGAZINE_THEMES.find((t) => t.id === template.suggestedTheme)
    : null;
  const tail = themeMeta
    ? `；进入「编辑台」把排版样式切到「${themeMeta.label}」即可拿到完整的杂志感。`
    : "，可以在编辑台立即使用。";
  _setStatus(`已保存 AI 生成模板「${template.name}」${tail}`, "success");
}

const DEMO_SOURCE = {
  title: "示例：本地咖啡品牌如何用 AI 工具做内容运营",
  url: "https://example.com/demo-article",
  siteName: "示例站点",
  description: "一篇用于 prompt 预览的示例稿件",
  wordCount: 1280,
  images: [
    { src: "https://example.com/img-1.png", alt: "门店照片", caption: "新店开业" },
    { src: "https://example.com/img-2.png", alt: "数据图表", caption: "增长曲线" }
  ],
  blocks: [
    { type: "heading", level: 1, text: "本地咖啡品牌如何用 AI 工具做内容运营" },
    { type: "paragraph", text: "在过去半年里，这家位于成都的本地咖啡品牌完成了一次从「门店品牌」到「内容品牌」的转身。" },
    { type: "heading", level: 2, text: "他们用 AI 做了三件事" },
    { type: "paragraph", text: "第一是改写门店日常拍摄的素材，第二是把顾客评价整理成短稿，第三是把活动文案模板化。" },
    { type: "code", language: "bash", text: "ai rewrite --source feedback.txt --tone friendly" }
  ]
};

const DEMO_PREFERENCES = {
  audience: "",
  tone: "",
  angle: "",
  length: "medium",
  cta: ""
};

const DEMO_SETTINGS = {
  defaultAudience: "关注内容运营与 AI 工具的从业者",
  defaultTone: "专业、可信、像有判断的编辑在写",
  defaultAngle: "提炼观点，重组结构，保留事实",
  defaultCta: "在结尾给出一个可执行的行动建议"
};
