import { DEFAULT_PROMPT_TEMPLATES } from "../shared/defaults.js";
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
  checkTemplateAccess,
  subscribeLicenseChanges
} from "../shared/license.js";
import { showUpgradeModal } from "../shared/upgrade-modal.js";
import { openAiTemplateDialog } from "../shared/ai-template-dialog.js";

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
  useVoiceSample: "#templateUseVoiceSample",
  humanizePassAllowed: "#templateHumanizePassAllowed",
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
  activePill: "#templateActivePill"
};

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
  els.aiGenBtn?.addEventListener("click", handleOpenAiGenDialog);
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
    els.model,
    els.useVoiceSample,
    els.humanizePassAllowed
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
  if (els.useVoiceSample) {
    // 老模板里没有这字段时按 "auto" 显示，保证向后兼容
    const policy = String(template.useVoiceSample || "auto");
    els.useVoiceSample.value = ["auto", "force-on", "force-off"].includes(policy)
      ? policy
      : "auto";
  }
  if (els.humanizePassAllowed) {
    // 老模板里没有 humanizePassAllowed 时按 true（允许）显示
    els.humanizePassAllowed.value =
      template.humanizePassAllowed === false ? "false" : "true";
  }
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
  // 「我的文风」/「去 AI 味」相关模板字段：注入策略 + 二次润色开关
  const policy = String(els.useVoiceSample?.value || "auto");
  template.useVoiceSample = ["auto", "force-on", "force-off"].includes(policy)
    ? policy
    : "auto";
  template.humanizePassAllowed = els.humanizePassAllowed?.value !== "false";
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
    model: "",
    useVoiceSample: "auto",
    humanizePassAllowed: true
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
        url: (typeof window !== "undefined" && window.__pricingUrl) || "https://docuearn.com/pricing"
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
// AI 生成模板（Pro 专享）— 对话框逻辑已迁出至共享模块
// src/shared/ai-template-dialog.js，本页面仅负责接 onSaved 回调把
// AI 生成的模板写入本地存储 + 刷新列表 + 自动选中。
// =====================================================================

function handleOpenAiGenDialog() {
  return openAiTemplateDialog({
    pricingUrl: (typeof window !== "undefined" && window.__pricingUrl) || undefined,
    setStatus: (msg, tone) => _setStatus(msg, tone),
    onSaved: async (template) => {
      _templates.push(template);
      await savePromptTemplates(_templates);
      renderList();
      selectTemplate(template.id);
    }
  });
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
