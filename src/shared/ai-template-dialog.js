/**
 * src/shared/ai-template-dialog.js
 * --------------------------------------------------------
 * 共享「AI 生成专属改写模板」对话框（Pro 闸门）。
 *
 * 历史：原本 #aiGenBackdrop 的 HTML/CSS/逻辑都写死在 options 里，导致
 * workspace 端无法暴露同一个 Pro 卖点。本模块把对话框 lazy-mount 到
 * document.body，options 与 workspace 共用一份代码。
 *
 * 用法：
 *   import { openAiTemplateDialog } from "../shared/ai-template-dialog.js";
 *   await openAiTemplateDialog({
 *     pricingUrl: "https://docuearn.com/pricing",
 *     onSaved: async (template) => { 写入 storage / 刷新 UI },
 *     setStatus: (msg, tone) => { 在宿主 status bar 上提示 }
 *   });
 *
 * 设计原则：
 *  - 所有 DOM 节点首次调用时挂到 document.body，复用同一份；
 *  - CSS 通过 <style> 一次性注入，避免依赖外部 .css；
 *  - Pro 闸门统一走 license.checkLicense + showUpgradeModal；
 *  - 生成成功后通过 onSaved(template) 把模板交给宿主，宿主负责持久化。
 */

import { MAGAZINE_THEMES } from "./defaults.js";
import { escapeHtml } from "./utils.js";
import { PAID_FEATURES, checkLicense } from "./license.js";
import { showUpgradeModal } from "./upgrade-modal.js";
import { generateTemplate, QUIZ_OPTIONS } from "./template-generator.js";

const STYLE_ID = "ai-template-dialog-style";
const ROOT_ID = "ai-template-dialog-root";

const PRICING_FALLBACK = "https://docuearn.com/pricing";

// ---------- 模块级状态（对话框是单例） ----------
let _mounted = false;
let _els = null;
let _quizAnswers = createEmptyQuizAnswers();
let _pendingAiTemplate = null;
let _aiGenAbortController = null;
let _onSavedCb = null;
let _setStatus = () => {};
let _pricingUrl = PRICING_FALLBACK;

function createEmptyQuizAnswers() {
  return {
    contentPillar: "",
    contentPillarOther: "",
    tone: "",
    opening: "",
    rhythm: "standard",
    cta: "",
    visualTheme: "",
    audience: "",
    extraNotes: ""
  };
}

function escapeAttr(value) {
  return escapeHtml(String(value)).replace(/"/g, "&quot;");
}

// =====================================================================
// CSS（迁出自 src/options/options.css 的 .ai-gen-* 块）
// =====================================================================
const CSS = `
.ai-template-backdrop {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.45);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 99998;
  padding: 24px;
}
.ai-template-backdrop[hidden] {
  display: none;
}
.ai-template-dialog {
  background: var(--surface, #ffffff);
  border-radius: 16px;
  width: min(900px, 100%);
  max-width: 680px;
  max-height: 90vh;
  overflow-y: auto;
  padding: 22px 24px;
  box-shadow: 0 24px 60px rgba(0, 0, 0, 0.32);
  display: flex;
  flex-direction: column;
  gap: 18px;
  font-family: -apple-system, "PingFang SC", "Hiragino Sans GB", system-ui, sans-serif;
  color: var(--ink, #1f2937);
}
.ai-template-head {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 12px;
}
.ai-template-head h3 {
  margin: 0;
  font-size: 1.05rem;
}
.ai-template-close {
  background: transparent;
  border: 1px solid var(--line, #e2e8f0);
  border-radius: 8px;
  padding: 4px 10px;
  font-size: 13px;
  color: var(--ink, #1f2937);
  cursor: pointer;
}
.ai-template-close:hover {
  background: rgba(0, 0, 0, 0.04);
}

.ai-template-tagline {
  margin: 0;
  font-size: 0.82rem;
  color: var(--soft-ink, #64748b);
  line-height: 1.65;
}

.ai-template-step {
  display: flex;
  flex-direction: column;
  gap: 14px;
}

/* 问卷块 */
.ai-template-quiz-block {
  display: flex;
  flex-direction: column;
  gap: 10px;
  padding: 16px 18px 18px;
  border-top: 1px solid var(--line, #e2e8f0);
}
.ai-template-quiz-block:first-of-type {
  border-top: none;
  padding-top: 4px;
}
.ai-template-quiz-q {
  display: flex;
  align-items: baseline;
  flex-wrap: wrap;
  gap: 10px;
}
.ai-template-quiz-num {
  font-family: 'Helvetica Neue', 'Arial', sans-serif;
  font-size: 0.7rem;
  font-weight: 700;
  letter-spacing: 0.2em;
  color: #2c6e54;
  padding: 2px 8px;
  background: rgba(44, 110, 84, 0.08);
  border-radius: 4px;
}
.ai-template-quiz-title {
  font-size: 0.96rem;
  font-weight: 700;
  color: var(--ink, #1f2937);
}
.ai-template-quiz-hint {
  flex: 1 1 100%;
  font-size: 0.76rem;
  color: var(--soft-ink, #64748b);
  line-height: 1.55;
  padding-left: 38px;
}
.ai-template-quiz-options {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  padding-left: 38px;
}
.ai-template-quiz-option {
  display: inline-flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 2px;
  padding: 9px 14px;
  background: var(--surface-soft, rgba(0, 0, 0, 0.02));
  border: 1px solid var(--line, #e2e8f0);
  border-radius: 10px;
  cursor: pointer;
  transition: border-color 0.15s ease, background 0.15s ease;
  text-align: left;
  font-family: inherit;
}
.ai-template-quiz-option:hover {
  border-color: rgba(44, 110, 84, 0.55);
  background: rgba(44, 110, 84, 0.04);
}
.ai-template-quiz-option.is-selected {
  border-color: #1f4f3a;
  background: rgba(44, 110, 84, 0.1);
  box-shadow: 0 0 0 2px rgba(44, 110, 84, 0.18);
}
.ai-template-quiz-option-label {
  font-size: 0.86rem;
  font-weight: 600;
  color: var(--ink, #1f2937);
}
.ai-template-quiz-option-hint {
  font-size: 0.72rem;
  color: var(--soft-ink, #64748b);
  line-height: 1.45;
}
.ai-template-quiz-other {
  margin-left: 38px;
  margin-top: 2px;
  width: calc(100% - 38px);
  padding: 8px 12px;
  font-size: 0.85rem;
  border-radius: 8px;
  border: 1px solid var(--line, #e2e8f0);
  background: var(--surface-soft, rgba(255, 255, 255, 0.6));
  color: var(--ink, #1f2937);
}
.ai-template-quiz-other:focus {
  outline: none;
  border-color: #2c6e54;
}

/* 视觉主题卡片网格 */
.ai-template-theme-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(220px, 1fr));
  gap: 10px;
  padding-left: 38px;
}
.ai-template-theme-card {
  display: flex;
  flex-direction: column;
  gap: 4px;
  padding: 12px 14px 13px;
  text-align: left;
  background: var(--surface-soft, rgba(0, 0, 0, 0.02));
  border: 1px solid var(--line, #e2e8f0);
  border-radius: 12px;
  cursor: pointer;
  transition: border-color 0.15s ease, background 0.15s ease;
  min-height: 110px;
  font-family: inherit;
}
.ai-template-theme-card:hover {
  border-color: rgba(44, 110, 84, 0.55);
  background: rgba(44, 110, 84, 0.04);
}
.ai-template-theme-card.is-selected {
  border-color: #1f4f3a;
  background: linear-gradient(135deg, rgba(31, 79, 58, 0.08), rgba(240, 212, 176, 0.16));
  box-shadow: 0 0 0 2px rgba(44, 110, 84, 0.2);
}
.ai-template-theme-name {
  font-family: 'Source Han Serif SC', 'Noto Serif SC', serif;
  font-size: 1rem;
  font-weight: 700;
  color: var(--ink, #1f2937);
}
.ai-template-theme-from {
  font-family: 'Helvetica Neue', 'Arial', sans-serif;
  font-size: 0.66rem;
  font-weight: 700;
  letter-spacing: 0.18em;
  text-transform: uppercase;
  color: #c08e3d;
}
.ai-template-theme-summary {
  font-size: 0.78rem;
  line-height: 1.55;
  color: var(--soft-ink, #64748b);
}
.ai-template-theme-pairs {
  font-size: 0.7rem;
  color: var(--soft-ink, #64748b);
  opacity: 0.85;
  margin-top: 2px;
  padding-top: 6px;
  border-top: 1px dashed rgba(0, 0, 0, 0.08);
}

/* Q7 选填补充区 */
.ai-template-quiz-extra {
  gap: 8px;
}
.ai-template-quiz-extra .ai-template-field-inline {
  width: 100%;
  padding-left: 38px;
}
.ai-template-field-inline {
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.ai-template-label-sm {
  font-size: 0.74rem;
  font-weight: 600;
  color: var(--soft-ink, #64748b);
  letter-spacing: 0.02em;
}
.ai-template-field-inline input[type="text"],
.ai-template-field-inline textarea {
  resize: vertical;
  min-height: 32px;
  padding: 10px 12px;
  font-size: 0.86rem;
  line-height: 1.6;
  border-radius: 10px;
  border: 1px solid var(--line, #e2e8f0);
  background: var(--surface-soft, rgba(255, 255, 255, 0.6));
  color: var(--ink, #1f2937);
  font-family: inherit;
}
.ai-template-field-inline textarea {
  min-height: 70px;
}
.ai-template-field-inline input[type="text"]:focus,
.ai-template-field-inline textarea:focus {
  outline: none;
  border-color: #2c6e54;
  box-shadow: 0 0 0 3px rgba(44, 110, 84, 0.12);
}

/* 操作栏 + 错误条 */
.ai-template-actions {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: 12px;
  flex-wrap: wrap;
}
.ai-template-error {
  flex: 1 1 100%;
  font-size: 0.82rem;
  color: #b73a3a;
  background: rgba(183, 58, 58, 0.08);
  border: 1px solid rgba(183, 58, 58, 0.25);
  border-radius: 8px;
  padding: 8px 12px;
  line-height: 1.5;
}
.ai-template-submit {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  background: linear-gradient(135deg, #1f4f3a 0%, #2c6e54 55%, #3d8b6e 100%);
  border: 1px solid rgba(240, 212, 176, 0.55);
  color: #fdf6ea;
  border-radius: 10px;
  padding: 9px 16px;
  font-size: 0.92rem;
  font-weight: 600;
  cursor: pointer;
  box-shadow:
    inset 0 1px 0 rgba(255, 255, 255, 0.18),
    0 6px 18px rgba(31, 79, 58, 0.22);
}
.ai-template-submit:hover:not(:disabled) {
  background: linear-gradient(135deg, #25593f 0%, #2f7a5d 55%, #46987a 100%);
}
.ai-template-submit:disabled {
  opacity: 0.65;
  cursor: not-allowed;
}
.ai-template-spark {
  font-size: 1rem;
  line-height: 1;
  filter: drop-shadow(0 0 4px rgba(240, 212, 176, 0.5));
}
.ai-template-secondary {
  background: transparent;
  border: 1px solid var(--line, #e2e8f0);
  border-radius: 10px;
  padding: 9px 14px;
  font-size: 0.88rem;
  color: var(--ink, #1f2937);
  cursor: pointer;
  font-family: inherit;
}
.ai-template-secondary:hover {
  background: rgba(0, 0, 0, 0.04);
}

/* Loading */
.ai-template-loading {
  align-items: center;
  text-align: center;
  padding: 36px 12px 20px;
  gap: 16px;
}
.ai-template-loading-orb {
  width: 56px;
  height: 56px;
  border-radius: 50%;
  background: conic-gradient(from 0deg, #1f4f3a, #46987a, #f0d4b0, #1f4f3a);
  filter: blur(0.4px);
  animation: ai-template-orb-spin 1.6s linear infinite;
  position: relative;
}
.ai-template-loading-orb::after {
  content: "";
  position: absolute;
  inset: 8px;
  border-radius: 50%;
  background: var(--surface, #fff);
}
@keyframes ai-template-orb-spin {
  to { transform: rotate(360deg); }
}
.ai-template-loading-title {
  margin: 0;
  font-size: 1rem;
  font-weight: 600;
  color: var(--ink, #1f2937);
}
.ai-template-loading-hint {
  margin: 0;
  font-size: 0.82rem;
  color: var(--soft-ink, #64748b);
}

/* 预览 */
.ai-template-preview-head {
  display: flex;
  align-items: center;
  gap: 14px;
  padding: 14px 16px;
  background: linear-gradient(135deg, rgba(31, 79, 58, 0.06), rgba(240, 212, 176, 0.12));
  border: 1px solid rgba(31, 79, 58, 0.12);
  border-radius: 14px;
}
.ai-template-preview-icon {
  font-size: 2rem;
  line-height: 1;
}
.ai-template-preview-title-wrap {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
}
.ai-template-preview-name {
  margin: 0;
  font-size: 1.05rem;
  font-weight: 700;
  color: var(--ink, #1f2937);
  word-break: break-word;
}
.ai-template-preview-meta {
  margin: 0;
  font-size: 0.78rem;
  color: var(--soft-ink, #64748b);
}
.ai-template-preview-theme {
  display: flex;
  flex-wrap: wrap;
  align-items: baseline;
  gap: 6px 12px;
  padding: 12px 16px;
  background: linear-gradient(135deg, rgba(192, 142, 61, 0.12), rgba(31, 79, 58, 0.06));
  border: 1px solid rgba(192, 142, 61, 0.35);
  border-radius: 12px;
}
.ai-template-preview-theme-tag {
  font-family: 'Helvetica Neue', 'Arial', sans-serif;
  font-size: 0.66rem;
  font-weight: 700;
  letter-spacing: 0.2em;
  text-transform: uppercase;
  color: #c08e3d;
  padding: 2px 8px;
  background: rgba(192, 142, 61, 0.15);
  border-radius: 4px;
}
.ai-template-preview-theme strong {
  font-family: 'Source Han Serif SC', 'Noto Serif SC', serif;
  font-size: 1rem;
  color: var(--ink, #1f2937);
}
.ai-template-preview-theme span:last-child {
  flex: 1 1 100%;
  font-size: 0.8rem;
  line-height: 1.55;
  color: var(--soft-ink, #64748b);
}
.ai-template-preview-block-wrap {
  border: 1px solid var(--line, #e2e8f0);
  border-radius: 10px;
  background: var(--surface-soft, rgba(0, 0, 0, 0.02));
  padding: 8px 12px;
}
.ai-template-preview-block-wrap > summary {
  cursor: pointer;
  font-size: 0.84rem;
  font-weight: 600;
  color: var(--ink, #1f2937);
  padding: 4px 0;
  list-style: none;
}
.ai-template-preview-block-wrap > summary::-webkit-details-marker {
  display: none;
}
.ai-template-preview-block-wrap > summary::before {
  content: "▸ ";
  display: inline-block;
  transform: translateY(-1px);
  margin-right: 6px;
  transition: transform 0.18s ease;
}
.ai-template-preview-block-wrap[open] > summary::before {
  transform: rotate(90deg);
}
.ai-template-preview-block-wrap pre {
  margin-top: 8px;
  margin-bottom: 0;
  padding: 14px;
  background: rgba(0, 0, 0, 0.04);
  border-radius: 8px;
  font-family: 'JetBrains Mono', 'SFMono-Regular', Consolas, monospace;
  font-size: 0.82rem;
  line-height: 1.55;
  white-space: pre-wrap;
  word-break: break-word;
  max-height: 320px;
  overflow-y: auto;
}
.ai-template-preview-defaults {
  margin-top: 8px;
  display: grid;
  grid-template-columns: max-content 1fr;
  gap: 6px 14px;
  font-size: 0.85rem;
  line-height: 1.55;
}
.ai-template-preview-defaults dt {
  color: var(--soft-ink, #64748b);
  font-weight: 600;
}
.ai-template-preview-defaults dd {
  margin: 0;
  color: var(--ink, #1f2937);
}
.ai-template-preview-note {
  margin: 0;
  font-size: 0.78rem;
  line-height: 1.6;
  color: var(--soft-ink, #64748b);
  padding: 10px 12px;
  background: rgba(240, 212, 176, 0.16);
  border: 1px dashed rgba(31, 79, 58, 0.25);
  border-radius: 10px;
}
`;

// =====================================================================
// HTML（迁出自 src/options/options.html 的 #aiGenBackdrop 块）
// =====================================================================
const HTML = `
<div id="${ROOT_ID}" class="ai-template-backdrop" hidden role="presentation">
  <div class="ai-template-dialog" role="dialog" aria-modal="true" aria-labelledby="aiTemplateDialogTitle">
    <div class="ai-template-head">
      <h3 id="aiTemplateDialogTitle">
        <span class="ai-template-spark" aria-hidden="true">✨</span>
        AI 生成专属改写模板
      </h3>
      <button type="button" class="ai-template-close" data-act="close">关闭</button>
    </div>

    <p class="ai-template-tagline">
      7 道选择题，AI 帮你写出一份<strong>有编辑判断 + 有杂志气质</strong>的改写模板。视觉主题来自 The New Yorker / Wired / Monocle / Vogue 等杂志的手工母版，AI 不写一行 CSS——下限就是杂志级。
    </p>

    <div class="ai-template-step" data-step="input">
      <div class="ai-template-quiz-block">
        <div class="ai-template-quiz-q">
          <span class="ai-template-quiz-num">01</span>
          <span class="ai-template-quiz-title">你的公众号在写什么？</span>
          <span class="ai-template-quiz-hint">决定 AI 给你设定的"编辑身份"</span>
        </div>
        <div class="ai-template-quiz-options" data-quiz="contentPillar"></div>
        <input data-field="contentPillarOther" class="ai-template-quiz-other" type="text" placeholder="如果选了「其他」，请用一句话告诉我们" hidden />
      </div>

      <div class="ai-template-quiz-block">
        <div class="ai-template-quiz-q">
          <span class="ai-template-quiz-num">02</span>
          <span class="ai-template-quiz-title">你想要的写作语气？</span>
          <span class="ai-template-quiz-hint">决定整篇文章的"温度"和"立场感"</span>
        </div>
        <div class="ai-template-quiz-options" data-quiz="tone"></div>
      </div>

      <div class="ai-template-quiz-block">
        <div class="ai-template-quiz-q">
          <span class="ai-template-quiz-num">03</span>
          <span class="ai-template-quiz-title">文章开头你偏好哪种方式？</span>
          <span class="ai-template-quiz-hint">前三秒决定读者是不是滑走</span>
        </div>
        <div class="ai-template-quiz-options" data-quiz="opening"></div>
      </div>

      <div class="ai-template-quiz-block">
        <div class="ai-template-quiz-q">
          <span class="ai-template-quiz-num">04</span>
          <span class="ai-template-quiz-title">段落节奏的偏好？</span>
          <span class="ai-template-quiz-hint">决定文章的"呼吸感"</span>
        </div>
        <div class="ai-template-quiz-options" data-quiz="rhythm"></div>
      </div>

      <div class="ai-template-quiz-block">
        <div class="ai-template-quiz-q">
          <span class="ai-template-quiz-num">05</span>
          <span class="ai-template-quiz-title">文章怎么收尾？</span>
          <span class="ai-template-quiz-hint">决定读者读完做什么</span>
        </div>
        <div class="ai-template-quiz-options" data-quiz="cta"></div>
      </div>

      <div class="ai-template-quiz-block ai-template-quiz-theme">
        <div class="ai-template-quiz-q">
          <span class="ai-template-quiz-num">06</span>
          <span class="ai-template-quiz-title">视觉排版风（杂志级母版）</span>
          <span class="ai-template-quiz-hint">每一套都是参照真实高级杂志手工调的，AI 不写 CSS，下限就是杂志级</span>
        </div>
        <div class="ai-template-quiz-options ai-template-theme-grid" data-quiz="visualTheme"></div>
      </div>

      <div class="ai-template-quiz-block ai-template-quiz-extra">
        <div class="ai-template-quiz-q">
          <span class="ai-template-quiz-num">07</span>
          <span class="ai-template-quiz-title">补充信息（选填，但写了效果更好）</span>
        </div>
        <label class="ai-template-field-inline">
          <span class="ai-template-label-sm">目标读者画像</span>
          <input data-field="audience" type="text" placeholder="例：25–35 岁、有判断力的科技产品决策者" />
        </label>
        <label class="ai-template-field-inline">
          <span class="ai-template-label-sm">特别想要的风格细节</span>
          <textarea data-field="extraNotes" rows="3" placeholder="例：少用形容词，多用具体数字；不要出现「赋能」「拥抱变革」这种词；如果用反讽，要克制不油腻"></textarea>
        </label>
      </div>

      <div class="ai-template-actions">
        <span data-el="error" class="ai-template-error" hidden></span>
        <button type="button" class="ai-template-submit" data-act="submit">
          <span class="ai-template-spark" aria-hidden="true">✨</span>
          <span data-el="submitLabel">生成模板</span>
        </button>
      </div>
    </div>

    <div class="ai-template-step ai-template-loading" data-step="loading" hidden>
      <div class="ai-template-loading-orb" aria-hidden="true"></div>
      <p class="ai-template-loading-title">正在让 AI 揣摩你的风格…</p>
      <p class="ai-template-loading-hint">这一步通常 5-15 秒。AI 会先想角色、再想写作纪律，最后排默认偏好。</p>
    </div>

    <div class="ai-template-step" data-step="preview" hidden>
      <div class="ai-template-preview-head">
        <span data-el="previewIcon" class="ai-template-preview-icon">✨</span>
        <div class="ai-template-preview-title-wrap">
          <h4 data-el="previewName" class="ai-template-preview-name">模板名</h4>
          <p data-el="previewMeta" class="ai-template-preview-meta">温度 0.7 · 长度 medium</p>
        </div>
      </div>

      <div data-el="previewTheme" class="ai-template-preview-theme" hidden>
        <span class="ai-template-preview-theme-tag">视觉主题</span>
        <strong data-el="previewThemeName"></strong>
        <span data-el="previewThemeSummary"></span>
      </div>

      <details class="ai-template-preview-block-wrap" open>
        <summary>角色 + 风格指令（system prompt 主体）</summary>
        <pre data-el="previewStyle"></pre>
      </details>

      <details class="ai-template-preview-block-wrap">
        <summary>默认偏好（受众 / 调性 / 角度 / CTA）</summary>
        <div data-el="previewDefaults" class="ai-template-preview-defaults"></div>
      </details>

      <p class="ai-template-preview-note">
        输出格式 contract（必须返回 JSON、保留来源图片、字段不可省略等）会被系统自动追加到模板末尾，AI 改不了。保存后请到「编辑台」把排版样式切换到上方建议的主题，杂志感才完整。
      </p>

      <div class="ai-template-actions">
        <button type="button" class="ai-template-secondary" data-act="retry">重新生成</button>
        <button type="button" class="ai-template-submit" data-act="save">保存到我的模板</button>
      </div>
    </div>
  </div>
</div>
`;

// =====================================================================
// 公开 API
// =====================================================================

/**
 * 打开 AI 模板生成对话框（带 Pro 闸门）
 * @param {object} opts
 * @param {string} [opts.pricingUrl]  Pro 升级页 URL
 * @param {(template: object) => Promise<void>|void} opts.onSaved  保存成功回调
 * @param {(msg: string, tone?: string) => void} [opts.setStatus]  宿主 status 回调
 */
export async function openAiTemplateDialog(opts = {}) {
  _onSavedCb = typeof opts.onSaved === "function" ? opts.onSaved : null;
  _setStatus = typeof opts.setStatus === "function" ? opts.setStatus : () => {};
  _pricingUrl = String(opts.pricingUrl || PRICING_FALLBACK);

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
        url: _pricingUrl
      }
    });
    return false;
  }

  ensureMounted();
  _pendingAiTemplate = null;
  resetAiGenForm();
  showAiGenStep("input");
  if (_els?.backdrop) {
    _els.backdrop.hidden = false;
  }
  return true;
}

// =====================================================================
// 内部：DOM 装载
// =====================================================================
function ensureMounted() {
  if (typeof document === "undefined") return;
  if (_mounted && _els?.backdrop?.isConnected) return;

  // 注入 CSS（once）
  if (!document.getElementById(STYLE_ID)) {
    const style = document.createElement("style");
    style.id = STYLE_ID;
    style.textContent = CSS;
    document.head.appendChild(style);
  }

  // 注入 HTML（once）
  let root = document.getElementById(ROOT_ID);
  if (!root) {
    const wrap = document.createElement("div");
    wrap.innerHTML = HTML;
    root = wrap.firstElementChild;
    document.body.appendChild(root);
  }

  _els = collectEls(root);
  renderQuizOptions();
  bindEvents();
  _mounted = true;
}

function collectEls(root) {
  const els = {
    backdrop: root,
    dialog: root.querySelector(".ai-template-dialog"),
    closeBtn: root.querySelector('[data-act="close"]'),
    submitBtn: root.querySelector('[data-act="submit"]'),
    submitLabel: root.querySelector('[data-el="submitLabel"]'),
    retryBtn: root.querySelector('[data-act="retry"]'),
    saveBtn: root.querySelector('[data-act="save"]'),
    error: root.querySelector('[data-el="error"]'),
    stepInput: root.querySelector('[data-step="input"]'),
    stepLoading: root.querySelector('[data-step="loading"]'),
    stepPreview: root.querySelector('[data-step="preview"]'),
    contentPillarOther: root.querySelector('[data-field="contentPillarOther"]'),
    audience: root.querySelector('[data-field="audience"]'),
    extraNotes: root.querySelector('[data-field="extraNotes"]'),
    previewIcon: root.querySelector('[data-el="previewIcon"]'),
    previewName: root.querySelector('[data-el="previewName"]'),
    previewMeta: root.querySelector('[data-el="previewMeta"]'),
    previewStyle: root.querySelector('[data-el="previewStyle"]'),
    previewDefaults: root.querySelector('[data-el="previewDefaults"]'),
    previewTheme: root.querySelector('[data-el="previewTheme"]'),
    previewThemeName: root.querySelector('[data-el="previewThemeName"]'),
    previewThemeSummary: root.querySelector('[data-el="previewThemeSummary"]')
  };
  return els;
}

function bindEvents() {
  if (!_els) return;
  _els.closeBtn?.addEventListener("click", closeAiGenDialog);
  _els.backdrop?.addEventListener("click", (e) => {
    if (e.target === _els.backdrop) closeAiGenDialog();
  });
  _els.submitBtn?.addEventListener("click", submitAiGen);
  _els.retryBtn?.addEventListener("click", () => {
    _pendingAiTemplate = null;
    showAiGenStep("input");
  });
  _els.saveBtn?.addEventListener("click", saveAiGenerated);

  _els.contentPillarOther?.addEventListener("input", (e) => {
    _quizAnswers.contentPillarOther = String(e.target.value || "");
  });
  _els.audience?.addEventListener("input", (e) => {
    _quizAnswers.audience = String(e.target.value || "");
  });
  _els.extraNotes?.addEventListener("input", (e) => {
    _quizAnswers.extraNotes = String(e.target.value || "");
  });

  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && _els?.backdrop && !_els.backdrop.hidden) {
      closeAiGenDialog();
    }
  });
}

function closeAiGenDialog() {
  if (!_els?.backdrop) return;
  if (_aiGenAbortController) {
    try { _aiGenAbortController.abort(); } catch { /* ignore */ }
    _aiGenAbortController = null;
  }
  _els.backdrop.hidden = true;
  _pendingAiTemplate = null;
}

function resetAiGenForm() {
  if (!_els) return;
  if (_els.error) {
    _els.error.hidden = true;
    _els.error.textContent = "";
  }
  if (_els.submitBtn) _els.submitBtn.disabled = false;
  if (_els.submitLabel) _els.submitLabel.textContent = "生成模板";
  _quizAnswers = createEmptyQuizAnswers();
  if (_els.contentPillarOther) {
    _els.contentPillarOther.value = "";
    _els.contentPillarOther.hidden = true;
  }
  if (_els.audience) _els.audience.value = "";
  if (_els.extraNotes) _els.extraNotes.value = "";
  _els.dialog?.querySelectorAll(".ai-template-quiz-options [data-quiz-option]").forEach((btn) =>
    btn.classList.remove("is-selected")
  );
  // 默认勾上 rhythm=standard
  const defaultRhythmBtn = _els.dialog?.querySelector(
    '[data-quiz="rhythm"] [data-quiz-option="standard"]'
  );
  defaultRhythmBtn?.classList.add("is-selected");

  if (_els.dialog) _els.dialog.scrollTop = 0;
}

/**
 * 把 QUIZ_OPTIONS 渲染成问卷按钮 + MAGAZINE_THEMES 渲染成视觉主题卡片。
 */
function renderQuizOptions() {
  if (!_els?.dialog) return;
  const containers = _els.dialog.querySelectorAll(".ai-template-quiz-options[data-quiz]");
  if (!containers.length) return;

  containers.forEach((container) => {
    const field = container.getAttribute("data-quiz");
    if (!field) return;

    if (field === "visualTheme") {
      container.innerHTML = MAGAZINE_THEMES.map(
        (theme) => `
          <button type="button" class="ai-template-theme-card" data-quiz-option="${escapeAttr(theme.id)}">
            <span class="ai-template-theme-name">${escapeHtml(theme.label)}</span>
            <span class="ai-template-theme-from">灵感 · ${escapeHtml(theme.inspiration)}</span>
            <span class="ai-template-theme-summary">${escapeHtml(theme.summary)}</span>
            <span class="ai-template-theme-pairs">适合：${(theme.pairsWith || []).map(escapeHtml).join(" · ")}</span>
          </button>
        `
      ).join("");
    } else {
      const options = QUIZ_OPTIONS[field] || [];
      container.innerHTML = options
        .map(
          (opt) => `
            <button type="button" class="ai-template-quiz-option" data-quiz-option="${escapeAttr(opt.id)}">
              <span class="ai-template-quiz-option-label">${escapeHtml(opt.label)}</span>
              ${opt.hint ? `<span class="ai-template-quiz-option-hint">${escapeHtml(opt.hint)}</span>` : ""}
            </button>
          `
        )
        .join("");
    }

    container.addEventListener("click", (event) => {
      const target = event.target.closest("[data-quiz-option]");
      if (!target || !container.contains(target)) return;
      const value = target.getAttribute("data-quiz-option") || "";
      _quizAnswers[field] = value;

      container.querySelectorAll("[data-quiz-option]").forEach((btn) =>
        btn.classList.toggle("is-selected", btn === target)
      );

      if (field === "contentPillar" && _els.contentPillarOther) {
        const isOther = value === "other";
        _els.contentPillarOther.hidden = !isOther;
        if (isOther) setTimeout(() => _els.contentPillarOther.focus(), 30);
      }
    });
  });
}

function showAiGenStep(step) {
  if (_els?.stepInput) _els.stepInput.hidden = step !== "input";
  if (_els?.stepLoading) _els.stepLoading.hidden = step !== "loading";
  if (_els?.stepPreview) _els.stepPreview.hidden = step !== "preview";
}

async function submitAiGen() {
  if (_els?.error) {
    _els.error.hidden = true;
    _els.error.textContent = "";
  }

  // 二次闸门
  const access = await checkLicense("ai.templateGenerator");
  if (!access.ok) {
    closeAiGenDialog();
    showUpgradeModal({
      featureName: PAID_FEATURES["ai.templateGenerator"].name,
      hint: access.hint || PAID_FEATURES["ai.templateGenerator"].hint,
      bullets: ["升级 Pro 后即可解锁 AI 模板生成器"],
      primaryAction: {
        label: "查看 Pro 套餐",
        url: _pricingUrl
      }
    });
    return;
  }

  const required = ["contentPillar", "tone", "opening", "rhythm", "cta", "visualTheme"];
  const missing = required.filter((k) => !_quizAnswers[k]);
  if (missing.length) {
    if (_els?.error) {
      _els.error.hidden = false;
      _els.error.textContent =
        `还有 ${missing.length} 题没选完。把所有问题答完再生成，效果会高一个量级。`;
    }
    return;
  }
  if (
    _quizAnswers.contentPillar === "other" &&
    !String(_quizAnswers.contentPillarOther || "").trim()
  ) {
    if (_els?.error) {
      _els.error.hidden = false;
      _els.error.textContent =
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
    if (_els?.error) {
      _els.error.hidden = false;
      _els.error.textContent = error?.message || "生成失败，请重试。";
    }
  } finally {
    _aiGenAbortController = null;
  }
}

function renderAiGenPreview(template) {
  if (!_els) return;
  if (_els.previewIcon) _els.previewIcon.textContent = template.icon || "✨";
  if (_els.previewName) _els.previewName.textContent = template.name || "未命名";
  if (_els.previewMeta) {
    _els.previewMeta.textContent =
      `温度 ${template.temperature ?? "—"} · 长度 ${template.defaults?.length || "medium"} · 字符数 ${template.systemTemplate.length + template.userTemplate.length}`;
  }
  if (_els.previewStyle) {
    _els.previewStyle.textContent = template.systemTemplate || "";
  }
  if (_els.previewDefaults) {
    const d = template.defaults || {};
    const rows = [
      ["受众", d.audience],
      ["调性", d.tone],
      ["切入角度", d.angle],
      ["结尾 CTA", d.cta]
    ];
    _els.previewDefaults.innerHTML = rows
      .map(([label, value]) =>
        `<dt>${escapeHtml(label)}</dt><dd>${escapeHtml(value || "（未设定）")}</dd>`
      )
      .join("");
  }

  if (_els.previewTheme) {
    const themeId = template.suggestedTheme;
    const meta = themeId ? MAGAZINE_THEMES.find((t) => t.id === themeId) : null;
    if (meta) {
      _els.previewTheme.hidden = false;
      if (_els.previewThemeName) {
        _els.previewThemeName.textContent = `${meta.label}（${meta.inspiration}）`;
      }
      if (_els.previewThemeSummary) {
        _els.previewThemeSummary.textContent = meta.summary;
      }
    } else {
      _els.previewTheme.hidden = true;
    }
  }
}

async function saveAiGenerated() {
  if (!_pendingAiTemplate) return;
  const template = _pendingAiTemplate;
  _pendingAiTemplate = null;

  const themeMeta = template.suggestedTheme
    ? MAGAZINE_THEMES.find((t) => t.id === template.suggestedTheme)
    : null;
  const tail = themeMeta
    ? `；进入「编辑台」把排版样式切到「${themeMeta.label}」即可拿到完整的杂志感。`
    : "，可以在编辑台立即使用。";

  closeAiGenDialog();

  try {
    if (typeof _onSavedCb === "function") {
      await _onSavedCb(template);
    }
    _setStatus(`已保存 AI 生成模板「${template.name}」${tail}`, "success");
  } catch (err) {
    console.warn("[ai-template-dialog] onSaved callback failed", err);
    _setStatus(
      `模板已生成但保存失败：${err?.message || "未知错误"}`,
      "warning"
    );
  }
}

// =====================================================================
// 测试/调试用导出（不要在业务代码中使用）
// =====================================================================
export const __INTERNAL = Object.freeze({
  createEmptyQuizAnswers,
  STYLE_ID,
  ROOT_ID
});
