/**
 * src/pages/topic-planner-ui.js
 * --------------------------------------------------------
 * 「AI 选题规划」前端界面（挂在 hot-topics.html 的 .topic-planner-entry 区块上）。
 *
 * 职责：
 *  1) 渲染入口按钮 + 上次规划的小卡片
 *  2) 弹出「选题画像」问卷 modal，收集 contentPillars / purpose / articleTypes /
 *     audiences / tone / risk / exclusions / excludeKeywords / outputCount
 *  3) 调 service-worker 的 PLAN_TOPICS 走完整流水线（fetch 多源 → 过滤评分 → AI 总监）
 *  4) 渲染推荐卡片，每条提供 4 个动作：
 *       ✨ 确认抓取改写  → SCRAPE_BACKGROUND_AND_IMPORT 抓原文 + workspace?import=1&autoRewrite=1
 *       📥 仅入库原文    → SCRAPE_BACKGROUND_AND_IMPORT + workspace?import=1
 *       📝 用提纲开稿    → IMPORT_OUTLINE_DRAFT 把 AI 提纲塞进 session.lastCapture + workspace?import=1&autoRewrite=1
 *       ♻️ 换一个角度    → 复用 candidatePool 重发 PLAN_TOPICS({ reroll: { itemId, previousAngle } })
 *  5) 抓取失败时自动兜底到「用提纲开稿」并提示用户
 *  6) 模板绑定：每张卡可自选 prompt template（默认走 AI 推荐的 suggestedTemplateId
 *     或当前 hotRewriteTemplateSelect 选中的模板）。点确认抓取改写时把目标模板写进
 *     activeTemplateId，避免 workspace 用上一次的模板浪费 AI 配额。
 *
 * 与 hot-topics.js 的关系：
 *  - 不依赖 hot-topics.js 的内部状态；通过 chrome.storage.onChanged 同步模板列表。
 *  - 不修改也不读取 hot-topics 列表区域的 DOM。
 */

import { formatRuntimeError, escapeHtml } from "../shared/utils.js";
import {
  getPromptTemplates,
  getActiveTemplateId,
  setActiveTemplateId
} from "../shared/storage.js";
import {
  STORAGE_KEYS,
  TOPIC_PROFILE_CATEGORIES,
  TOPIC_PROFILE_PURPOSES,
  TOPIC_PROFILE_ARTICLE_TYPES,
  TOPIC_PROFILE_AUDIENCES,
  TOPIC_PROFILE_TONES,
  TOPIC_PROFILE_RISK_LEVELS,
  TOPIC_PROFILE_EXCLUSIONS,
  TOPIC_PROFILE_OUTPUT_COUNTS,
  DEFAULT_TOPIC_PROFILE
} from "../shared/defaults.js";
import { buildOutlineCapture } from "../shared/topic-planner.js";
import { PAID_FEATURES, checkLicense } from "../shared/license.js";
import { showUpgradeModal } from "../shared/upgrade-modal.js";
import { ensureHostPermissionFromGesture } from "../shared/host-permissions.js";

const runtimeOk = Boolean(globalThis.chrome?.runtime?.id);
const PLAN_TOPICS_TIMEOUT_MS = 90_000;
const REROLL_TIMEOUT_MS = 75_000;

const entryEl = document.querySelector('[data-el="topicPlannerEntry"]');
const metaEl = entryEl?.querySelector('[data-el="topicPlannerMeta"]');
const resultEl = entryEl?.querySelector('[data-el="topicPlannerResult"]');
const openBtn = entryEl?.querySelector('[data-act="open-topic-planner"]');

if (entryEl && openBtn) {
  if (!runtimeOk) {
    metaEl.textContent = "请在扩展环境内打开本页才能使用 AI 选题。";
    openBtn.disabled = true;
  } else {
    init();
  }
}

// =====================================================================
// 模块状态
// =====================================================================
let _profile = { ...DEFAULT_TOPIC_PROFILE };
let _lastPlan = null;
let _templates = [];
let _activeTemplateId = "";
let _modal = null;
let _busyKey = null;

async function init() {
  await Promise.all([loadProfileAndPlan(), refreshTemplates()]);
  renderEntryMeta();
  renderResult();
  bindStorageSync();

  openBtn.addEventListener("click", () => openProfileModal());
}

async function loadProfileAndPlan() {
  try {
    const data = await chrome.storage.local.get([
      STORAGE_KEYS.topicProfile,
      STORAGE_KEYS.topicPlanCache
    ]);
    if (data[STORAGE_KEYS.topicProfile]) {
      _profile = {
        ...DEFAULT_TOPIC_PROFILE,
        ...data[STORAGE_KEYS.topicProfile]
      };
    }
    if (data[STORAGE_KEYS.topicPlanCache]) {
      _lastPlan = data[STORAGE_KEYS.topicPlanCache];
    }
  } catch (err) {
    console.warn("[topic-planner-ui] 读取本地存储失败：", err);
  }
}

async function persistProfile() {
  _profile.updatedAt = Date.now();
  try {
    await chrome.storage.local.set({
      [STORAGE_KEYS.topicProfile]: _profile
    });
  } catch (err) {
    console.warn("[topic-planner-ui] 保存画像失败：", err);
  }
}

async function persistPlanCache(plan) {
  try {
    await chrome.storage.local.set({
      [STORAGE_KEYS.topicPlanCache]: plan
    });
  } catch (err) {
    console.warn("[topic-planner-ui] 缓存推荐失败：", err);
  }
}

async function refreshTemplates() {
  try {
    const [tpls, activeId] = await Promise.all([
      getPromptTemplates(),
      getActiveTemplateId()
    ]);
    _templates = Array.isArray(tpls) ? tpls : [];
    _activeTemplateId = activeId || (_templates[0]?.id ?? "");
  } catch (err) {
    console.warn("[topic-planner-ui] 加载模板失败：", err);
  }
}

function bindStorageSync() {
  chrome.storage?.onChanged?.addListener((changes, area) => {
    if (area !== "local") return;
    if (
      changes[STORAGE_KEYS.promptTemplates] ||
      changes[STORAGE_KEYS.activeTemplateId]
    ) {
      void refreshTemplates();
    }
  });
}

// =====================================================================
// 入口区域渲染
// =====================================================================
function renderEntryMeta() {
  if (!metaEl) return;
  if (_lastPlan?.savedAt) {
    const t = new Date(_lastPlan.savedAt).toLocaleString("zh-CN", {
      hour12: false
    });
    metaEl.textContent = `上次规划：${t}`;
  } else {
    metaEl.textContent = "首次使用：先回答 8 道画像题再出选题。";
  }
}

function renderResult() {
  if (!resultEl) return;
  if (!_lastPlan?.data?.recommendedTopics?.length) {
    resultEl.hidden = true;
    resultEl.innerHTML = "";
    return;
  }
  resultEl.hidden = false;
  const { strategySummary, recommendedTopics, rejectedPatterns, meta } =
    _lastPlan.data;
  const isFreeTrial = meta?.isFreeTrial;
  const trial = meta?.trial;
  const sourcesUsed = meta?.sourcesUsed || [];

  resultEl.innerHTML = [
    strategySummary
      ? `<p class="topic-planner-result__summary">${escapeHtml(strategySummary)}</p>`
      : "",
    `<p class="topic-planner-result__meta">${escapeHtml(
      [
        isFreeTrial
          ? `免费试用：今日已用 ${trial?.used ?? 1}/${trial?.limit ?? 1}（升级 Pro 解锁完整 ${_profile.outputCount || 5} 条 + 「换一个角度」）`
          : `Pro 模式 · 候选池 ${meta?.aiPoolSize || recommendedTopics.length} 条 → 推荐 ${recommendedTopics.length} 条`,
        sourcesUsed.length ? `源：${sourcesUsed.join(" / ")}` : ""
      ]
        .filter(Boolean)
        .join(" · ")
    )}</p>`,
    `<div class="topic-planner-cards" data-el="topicCards">${recommendedTopics
      .map((rec, idx) => renderTopicCardHtml(rec, idx))
      .join("")}</div>`,
    Array.isArray(rejectedPatterns) && rejectedPatterns.length
      ? `<p class="topic-rejected-list"><strong>这一轮算法已排除：</strong>${escapeHtml(rejectedPatterns.join("、"))}</p>`
      : ""
  ]
    .filter(Boolean)
    .join("");

  bindCardActions();
}

function renderTopicCardHtml(rec, idx) {
  const c = rec.candidate || {};
  const hasUrl = Boolean(c.url);
  const tplName =
    _templates.find((t) => t.id === rec.suggestedTemplateId)?.name ||
    "（按下方下拉选择）";
  const articleTypeLabel = TOPIC_PROFILE_ARTICLE_TYPES.find(
    (a) => a.id === rec.articleType
  )?.label;
  const confidencePct = Math.round((rec.confidence ?? 0.6) * 100);

  const titleHtml = hasUrl
    ? `<a class="topic-card__title-link" href="${escapeAttr(c.url)}" target="_blank" rel="noopener noreferrer">${escapeHtml(rec.originalTitle || c.title || "")}</a>`
    : escapeHtml(rec.originalTitle || c.title || "");

  return `
    <article class="topic-card" data-itemid="${escapeAttr(rec.itemId)}" data-card-idx="${idx}">
      <div class="topic-card__header">
        <span class="topic-card__rank">#${idx + 1}</span>
        <h3 class="topic-card__title">${titleHtml}</h3>
      </div>
      <div class="topic-card__chips">
        <span class="topic-chip topic-chip--source">${escapeHtml(c.sourceLabel || c.source || "未知源")}</span>
        ${articleTypeLabel ? `<span class="topic-chip">${escapeHtml(articleTypeLabel)}</span>` : ""}
        <span class="topic-chip topic-chip--confidence">把握度 ${confidencePct}%</span>
        ${hasUrl ? "" : `<span class="topic-chip topic-chip--no-url">⚠️ 无原文链接 · 仅可提纲开稿</span>`}
      </div>
      ${
        rec.scoreReason
          ? `<div class="topic-card__section">
              <span class="topic-card__label">为什么写</span>
              <p class="topic-card__value">${escapeHtml(rec.scoreReason)}</p>
            </div>`
          : ""
      }
      ${
        rec.recommendedAngle
          ? `<div class="topic-card__section">
              <span class="topic-card__label">建议切口</span>
              <p class="topic-card__value">${escapeHtml(rec.recommendedAngle)}</p>
            </div>`
          : ""
      }
      ${
        Array.isArray(rec.outline) && rec.outline.length
          ? `<div class="topic-card__section">
              <span class="topic-card__label">提纲</span>
              <ul class="topic-card__outline">${rec.outline
                .map((o) => `<li>${escapeHtml(o)}</li>`)
                .join("")}</ul>
            </div>`
          : ""
      }
      ${
        Array.isArray(rec.titleCandidates) && rec.titleCandidates.length
          ? `<div class="topic-card__section">
              <span class="topic-card__label">备选标题</span>
              <div class="topic-card__title-options">${rec.titleCandidates
                .map((t) => `<span class="topic-title-option">${escapeHtml(t)}</span>`)
                .join("")}</div>
            </div>`
          : ""
      }
      <p class="topic-card__risk">⚠️ ${escapeHtml(rec.riskNotes || "无明显风险")}</p>
      <div class="topic-card__template">
        <span>使用模板：</span>
        <span class="topic-card__template-name" data-el="cardTemplateName">${escapeHtml(tplName)}</span>
        <select aria-label="为这条选题选择改写模板" data-el="cardTemplateSelect">${_templates
          .map(
            (t) =>
              `<option value="${escapeAttr(t.id)}" ${
                t.id === (rec.suggestedTemplateId || _activeTemplateId)
                  ? "selected"
                  : ""
              }>${escapeHtml((t.icon || "📝") + " " + (t.name || "未命名模板"))}</option>`
          )
          .join("")}</select>
      </div>
      <div class="topic-card__actions">
        <button type="button" class="primary" data-act="confirm-rewrite" ${hasUrl ? "" : "disabled title=\"该条目没有原文链接，请用「用提纲开稿」\""}>✨ 确认抓取并改写</button>
        <button type="button" class="primary ghost" data-act="import-only" ${hasUrl ? "" : "disabled"}>📥 仅入库原文</button>
        <button type="button" class="ghost" data-act="outline-only">📝 用提纲开稿</button>
        <button type="button" class="ghost" data-act="reroll-angle">♻️ 换一个角度</button>
      </div>
      <p class="topic-card__error" data-el="cardError" hidden></p>
    </article>
  `;
}

function bindCardActions() {
  const cards = resultEl?.querySelectorAll(".topic-card") || [];
  cards.forEach((card) => {
    const idx = Number(card.dataset.cardIdx);
    const select = card.querySelector('[data-el="cardTemplateSelect"]');
    const nameEl = card.querySelector('[data-el="cardTemplateName"]');
    select?.addEventListener("change", () => {
      const t = _templates.find((tt) => tt.id === select.value);
      if (nameEl) nameEl.textContent = t?.name || "（自定义）";
    });
    card.querySelectorAll("button[data-act]").forEach((btn) => {
      btn.addEventListener("click", () =>
        handleCardAction(card, idx, btn.dataset.act, select?.value || "")
      );
    });
  });
}

// =====================================================================
// 卡片动作
// =====================================================================
async function handleCardAction(cardEl, idx, action, chosenTemplateId) {
  const rec = _lastPlan?.data?.recommendedTopics?.[idx];
  if (!rec) return;
  if (_busyKey) {
    showCardError(cardEl, "上一个操作还没结束，请稍候。");
    return;
  }
  _busyKey = `${idx}-${action}`;
  cardEl.classList.add("is-busy");
  clearCardError(cardEl);

  try {
    if (action === "confirm-rewrite" || action === "import-only") {
      await runScrapeFlow(cardEl, rec, action === "confirm-rewrite", chosenTemplateId);
    } else if (action === "outline-only") {
      await runOutlineFlow(rec, chosenTemplateId, /*autoRewrite*/ true);
    } else if (action === "reroll-angle") {
      await runReroll(rec);
    }
  } catch (err) {
    showCardError(cardEl, formatRuntimeError(err?.message, "操作失败，请重试。"));
  } finally {
    _busyKey = null;
    cardEl.classList.remove("is-busy");
  }
}

async function runScrapeFlow(cardEl, rec, autoRewrite, chosenTemplateId) {
  const url = rec.candidate?.url;
  if (!url) {
    showCardError(cardEl, "该条没有可访问的原文链接，请改用「用提纲开稿」。");
    return;
  }
  if (chosenTemplateId && chosenTemplateId !== _activeTemplateId) {
    await setActiveTemplateId(chosenTemplateId);
    _activeTemplateId = chosenTemplateId;
  }
  // 必须在 click handler 用户手势上下文里申请 origin 权限 ——
  // SW 端 ensureOptionalHostPermission 没有 user activation，会抛 "must be called during a user gesture"。
  const permitted = await ensureHostPermissionFromGesture(url, "抓取并改写");
  if (!permitted) {
    showCardError(
      cardEl,
      "需要授权访问该原文域名才能抓取，请在弹窗里点「允许」后重试，或改用「用提纲开稿」。"
    );
    return;
  }
  let scrapeRes;
  try {
    scrapeRes = await sendMessageWithTimeout(
      { type: "SCRAPE_BACKGROUND_AND_IMPORT", payload: { url } },
      35_000
    );
  } catch (err) {
    showCardError(
      cardEl,
      `${err?.message || "后台抓取异常"}。已自动切换到「用提纲开稿」兜底。`
    );
    await runOutlineFlow(rec, chosenTemplateId, autoRewrite);
    return;
  }
  if (!scrapeRes?.ok) {
    const reason = formatRuntimeError(scrapeRes?.error, "后台抓取失败");
    showCardError(cardEl, `${reason}。已自动切换到「用提纲开稿」兜底。`);
    await runOutlineFlow(rec, chosenTemplateId, autoRewrite);
    return;
  }
  const targetUrl =
    chrome.runtime.getURL("src/workspace/workspace.html") +
    (autoRewrite ? "?import=1&autoRewrite=1" : "?import=1");
  chrome.tabs.create({ url: targetUrl });
}

async function runOutlineFlow(rec, chosenTemplateId, autoRewrite) {
  const capture = buildOutlineCapture(rec, _profile);
  if (!capture) return;
  if (chosenTemplateId && chosenTemplateId !== _activeTemplateId) {
    await setActiveTemplateId(chosenTemplateId);
    _activeTemplateId = chosenTemplateId;
  }
  const res = await sendMessageWithTimeout(
    { type: "IMPORT_OUTLINE_DRAFT", payload: { capture } },
    10_000
  );
  if (!res?.ok) {
    throw new Error(formatRuntimeError(res?.error, "提纲入库失败"));
  }
  const targetUrl =
    chrome.runtime.getURL("src/workspace/workspace.html") +
    (autoRewrite ? "?import=1&autoRewrite=1" : "?import=1");
  chrome.tabs.create({ url: targetUrl });
}

async function runReroll(rec) {
  const license = await checkLicense("ai.topicPlanner");
  if (!license.ok) {
    showUpgradeModal({
      featureName: PAID_FEATURES["ai.topicPlanner"]?.name || "AI 选题规划",
      hint: PAID_FEATURES["ai.topicPlanner"]?.hint || "",
      blocked: "本次被拦的是「换一个角度」",
      gain: "升级 Pro 后：换角度无限次 + 推荐数量按你设置的 3/5/10 出全量结果。"
    });
    return;
  }
  const cachedPool = _lastPlan?.data?.candidatePool || [];
  const itemId = rec.itemId;
  const previousAngle = rec.recommendedAngle || "";
  const res = await sendMessageWithTimeout(
    {
      type: "PLAN_TOPICS",
      payload: {
        profile: _profile,
        cachedPool,
        reroll: { itemId, previousAngle }
      }
    },
    REROLL_TIMEOUT_MS
  );
  if (!res?.ok) {
    throw new Error(formatRuntimeError(res?.error, "换角度失败"));
  }
  const newRec = res.data?.recommendedTopics?.[0];
  if (!newRec) {
    throw new Error("AI 没给出新角度，请稍后重试。");
  }
  // 替换原推荐里这一条，写回缓存并重渲染
  const idx = _lastPlan.data.recommendedTopics.findIndex(
    (r) => r.itemId === itemId
  );
  if (idx >= 0) {
    _lastPlan.data.recommendedTopics[idx] = newRec;
    _lastPlan.savedAt = Date.now();
    await persistPlanCache(_lastPlan);
    renderResult();
    renderEntryMeta();
  }
}

function showCardError(cardEl, msg) {
  cardEl.classList.add("is-error");
  const errEl = cardEl.querySelector('[data-el="cardError"]');
  if (errEl) {
    errEl.textContent = msg;
    errEl.hidden = false;
  }
}

function clearCardError(cardEl) {
  cardEl.classList.remove("is-error");
  const errEl = cardEl.querySelector('[data-el="cardError"]');
  if (errEl) {
    errEl.textContent = "";
    errEl.hidden = true;
  }
}

// =====================================================================
// 问卷 modal
// =====================================================================
function openProfileModal() {
  if (!_modal) _modal = mountModal();
  fillModalFromProfile();
  _modal.backdrop.hidden = false;
  // 没填过画像 → 默认聚焦第一个 chip
  const firstChip = _modal.body.querySelector(".topic-planner-chip");
  firstChip?.focus();
}

function closeModal() {
  if (_modal) _modal.backdrop.hidden = true;
}

function mountModal() {
  const backdrop = document.createElement("div");
  backdrop.className = "topic-planner-backdrop";
  backdrop.hidden = true;
  backdrop.innerHTML = `
    <form class="topic-planner-modal" role="dialog" aria-modal="true" aria-labelledby="topicPlannerModalTitle">
      <div class="topic-planner-modal__head">
        <div>
          <span class="topic-planner-modal__badge">60 秒画像 · AI 主编会先过滤噪音</span>
          <h3 id="topicPlannerModalTitle">让 AI 先懂你的号，再替你挑选题</h3>
          <p>选题规划会先拉取候选热点、做算法评分，再调用 AI 主编输出推荐卡片。勾选越准，结果越像你的选题会。</p>
        </div>
        <button type="button" class="topic-planner-modal__close" data-act="close" aria-label="关闭选题画像">关闭</button>
      </div>

      <div class="topic-planner-modal__body" data-el="modalBody"></div>

      <div class="topic-planner-modal__footer">
        <p class="topic-planner-modal__footer-meta" data-el="modalQuotaMeta"></p>
        <div class="topic-planner-modal__footer-actions">
          <button type="button" class="ghost" data-act="cancel">取消</button>
          <button type="submit" class="primary" data-act="submit">📍 生成选题</button>
        </div>
      </div>
    </form>
  `;
  document.body.appendChild(backdrop);

  const form = backdrop.querySelector("form");
  const body = backdrop.querySelector('[data-el="modalBody"]');
  const meta = backdrop.querySelector('[data-el="modalQuotaMeta"]');
  body.innerHTML = renderModalBodyHtml();

  // 关闭
  backdrop.querySelector('[data-act="close"]').addEventListener("click", closeModal);
  backdrop.querySelector('[data-act="cancel"]').addEventListener("click", closeModal);
  backdrop.addEventListener("click", (e) => {
    if (e.target === backdrop) closeModal();
  });

  // chip toggle
  body.addEventListener("click", (e) => {
    const chip = e.target.closest(".topic-planner-chip");
    if (!chip || !body.contains(chip)) return;
    e.preventDefault();
    const group = chip.dataset.group;
    const id = chip.dataset.id;
    if (!group || !id) return;
    if (group === "outputCount") {
      body.querySelectorAll(`.topic-planner-chip[data-group="outputCount"]`).forEach((c) =>
        c.setAttribute("aria-pressed", c === chip ? "true" : "false")
      );
      _profile.outputCount = Number(id) || 5;
      return;
    }
    if (group === "purpose" || group === "tone" || group === "risk") {
      // 单选
      body.querySelectorAll(`.topic-planner-chip[data-group="${group}"]`).forEach((c) =>
        c.setAttribute("aria-pressed", c === chip ? "true" : "false")
      );
      _profile[group] = id;
      return;
    }
    // 多选
    const next = chip.getAttribute("aria-pressed") === "true" ? "false" : "true";
    chip.setAttribute("aria-pressed", next);
    const list = new Set(_profile[group] || []);
    if (next === "true") list.add(id);
    else list.delete(id);
    _profile[group] = Array.from(list);
  });

  // 排除关键字 textarea
  body.addEventListener("input", (e) => {
    if (e.target.matches('[data-el="excludeKeywords"]')) {
      const raw = e.target.value || "";
      _profile.excludeKeywords = raw
        .split(/[，,、\s]+/)
        .map((s) => s.trim())
        .filter(Boolean);
    }
  });

  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    if (!validateProfile()) return;
    await persistProfile();
    await runPlanning(meta, form);
  });

  return { backdrop, body, meta, form };
}

function renderModalBodyHtml() {
  return [
    chipFieldHtml({
      label: "1. 内容领域（必选 1-3 个）",
      hint: "决定 AI 自动从哪些热点源拉候选。",
      group: "contentPillars",
      multi: true,
      options: Object.entries(TOPIC_PROFILE_CATEGORIES).map(([id, v]) => ({
        id,
        label: v.label
      }))
    }),
    rowHtml([
      chipFieldHtml({
        label: "2. 写作目的",
        group: "purpose",
        multi: false,
        options: TOPIC_PROFILE_PURPOSES
      }),
      chipFieldHtml({
        label: "3. 表达基调",
        group: "tone",
        multi: false,
        options: TOPIC_PROFILE_TONES
      })
    ]),
    chipFieldHtml({
      label: "4. 文章类型偏好（多选）",
      hint: "决定推荐里哪些「能写、能发、不踩雷」的体裁会被加权。",
      group: "articleTypes",
      multi: true,
      options: TOPIC_PROFILE_ARTICLE_TYPES
    }),
    chipFieldHtml({
      label: "5. 目标读者（多选）",
      group: "audiences",
      multi: true,
      options: TOPIC_PROFILE_AUDIENCES
    }),
    rowHtml([
      chipFieldHtml({
        label: "6. 风险偏好",
        hint: "保守=避开一切争议，正常=主流公众号默认值，敢写=可以触碰边界话题。",
        group: "risk",
        multi: false,
        options: TOPIC_PROFILE_RISK_LEVELS
      }),
      chipFieldHtml({
        label: "7. 推荐数量",
        hint: "免费版固定 1 条，Pro 按你勾选的数量出。",
        group: "outputCount",
        multi: false,
        options: TOPIC_PROFILE_OUTPUT_COUNTS.map((n) => ({
          id: String(n),
          label: `${n} 条`
        }))
      })
    ]),
    chipFieldHtml({
      label: "8. 不要写哪些内容（多选）",
      hint: "命中即整条剔除。下方还可加自定义关键词。",
      group: "exclusions",
      multi: true,
      options: TOPIC_PROFILE_EXCLUSIONS
    }),
    `<div class="topic-planner-modal__field">
      <label class="topic-planner-modal__label">
        自定义排除关键字
        <span class="topic-planner-modal__hint">用逗号或空格分隔，如「房价 比特币 离婚」</span>
      </label>
      <textarea class="topic-planner-modal__textarea" data-el="excludeKeywords" placeholder="留空表示不额外排除"></textarea>
    </div>`,
    `<div class="topic-planner-modal__error" data-el="modalError" hidden></div>`,
    `<div class="topic-planner-modal__loading" data-el="modalLoading" hidden></div>`
  ].join("");
}

function rowHtml(items) {
  return `<div class="topic-planner-modal__row">${items.join("")}</div>`;
}

function chipFieldHtml({ label, hint, group, multi, options }) {
  const chips = options
    .map(
      (opt) => `<button type="button" class="topic-planner-chip" data-group="${escapeAttr(group)}" data-id="${escapeAttr(opt.id)}" aria-pressed="false">${escapeHtml(opt.label)}</button>`
    )
    .join("");
  return `
    <div class="topic-planner-modal__field" data-field="${escapeAttr(group)}">
      <label class="topic-planner-modal__label">
        <span>${escapeHtml(label)}</span>
        ${hint ? `<span class="topic-planner-modal__hint">${escapeHtml(hint)}</span>` : ""}
      </label>
      <div class="topic-planner-chip-group">${chips}</div>
    </div>
  `;
}

function fillModalFromProfile() {
  if (!_modal) return;
  const body = _modal.body;
  // 单选/多选 chip 状态
  body.querySelectorAll(".topic-planner-chip").forEach((chip) => {
    const group = chip.dataset.group;
    const id = chip.dataset.id;
    let pressed = false;
    if (group === "outputCount") {
      pressed = String(_profile.outputCount || 5) === id;
    } else if (group === "purpose" || group === "tone" || group === "risk") {
      pressed = (_profile[group] || "") === id;
    } else {
      pressed = Array.isArray(_profile[group]) && _profile[group].includes(id);
    }
    chip.setAttribute("aria-pressed", pressed ? "true" : "false");
  });
  // 关键字
  const ta = body.querySelector('[data-el="excludeKeywords"]');
  if (ta) ta.value = (_profile.excludeKeywords || []).join("，");
  // 错误清空
  const err = body.parentElement.querySelector('[data-el="modalError"]');
  if (err) {
    err.hidden = true;
    err.textContent = "";
  }
  const loading = body.parentElement.querySelector('[data-el="modalLoading"]');
  if (loading) {
    loading.hidden = true;
    loading.textContent = "";
  }
  // 配额提示
  refreshModalQuota();
}

async function refreshModalQuota() {
  if (!_modal) return;
  const meta = _modal.meta;
  if (!meta) return;
  try {
    const lic = await checkLicense("ai.topicPlanner");
    meta.textContent = lic.ok
      ? "Pro 版：不限次数，按设置数量出全量推荐。"
      : "免费试用：今日 1 次额度（仅展示 1 条结果），明日 0 点重置。";
  } catch {
    meta.textContent = "";
  }
}

function validateProfile() {
  if (!_modal) return false;
  const errEl = _modal.body.parentElement.querySelector('[data-el="modalError"]');
  const set = (msg) => {
    if (!errEl) return;
    errEl.hidden = false;
    errEl.textContent = msg;
  };
  if ((_profile.contentPillars || []).length === 0) {
    set("请至少选 1 个「内容领域」，AI 才知道该从哪些热点源里挑。");
    return false;
  }
  if (errEl) {
    errEl.hidden = true;
    errEl.textContent = "";
  }
  return true;
}

async function runPlanning(metaEl, formEl) {
  const errEl = formEl.querySelector('[data-el="modalError"]');
  const loadingEl = formEl.querySelector('[data-el="modalLoading"]');
  const submitBtn = formEl.querySelector('[data-act="submit"]');
  const originalSubmitText = submitBtn?.innerHTML || "📍 生成选题";
  if (errEl) errEl.hidden = true;
  const stopPlanningHints = startPlanningHintTicker(loadingEl);
  formEl.classList.add("is-planning");
  submitBtn.disabled = true;
  submitBtn.innerHTML = "生成中…";
  try {
    const res = await sendMessageWithTimeout(
      {
        type: "PLAN_TOPICS",
        payload: { profile: _profile }
      },
      PLAN_TOPICS_TIMEOUT_MS
    );
    if (!res?.ok) {
      const code = res?.errorCode;
      if (code === "LICENSE_QUOTA_EXCEEDED") {
        showUpgradeModal({
          featureName: PAID_FEATURES["ai.topicPlanner"]?.name || "AI 选题规划",
          hint:
            PAID_FEATURES["ai.topicPlanner"]?.hint ||
            "升级 Pro 即可不限次出选题。",
          blocked: "本次被拦的是「AI 选题规划免费试用额度」",
          gain: "升级 Pro 后：每天不限次 + 按设置数量出全量推荐 + 解锁「换一个角度」。"
        });
      } else if (code === "AI_NOT_CONFIGURED") {
        if (errEl) {
          errEl.hidden = false;
          errEl.textContent =
            "AI 接口未配置，请先到「AI 设置」补完 API Base URL / API Key / Model 后再试。";
        }
      } else if (code === "AI_TIMEOUT") {
        if (errEl) {
          errEl.hidden = false;
          errEl.textContent =
            res?.error ||
            "AI 接口响应太慢，本次已中断。建议换更快模型、降低推荐数量或稍后重试。";
        }
      } else if (errEl) {
        errEl.hidden = false;
        errEl.textContent = formatRuntimeError(res?.error, "选题失败，请稍后重试。");
      }
      return;
    }
    _lastPlan = {
      savedAt: Date.now(),
      data: res.data,
      profileSnapshot: { ..._profile }
    };
    await persistPlanCache(_lastPlan);
    renderResult();
    renderEntryMeta();
    closeModal();
  } catch (err) {
    if (errEl) {
      errEl.hidden = false;
      errEl.textContent = formatRuntimeError(
        err?.message,
        "调用后台超时，请稍后重试。"
      );
    }
  } finally {
    stopPlanningHints();
    formEl.classList.remove("is-planning");
    submitBtn.disabled = false;
    submitBtn.innerHTML = originalSubmitText;
  }
}

// =====================================================================
// 工具
// =====================================================================
function escapeAttr(value) {
  return escapeHtml(String(value)).replace(/'/g, "&#39;").replace(/"/g, "&quot;");
}

function startPlanningHintTicker(loadingEl) {
  if (!loadingEl) return () => {};
  const startedAt = Date.now();
  const steps = [
    { at: 0, text: "正在拉取候选热点源，通常 10 秒内完成。" },
    { at: 10, text: "正在做硬过滤、8 维评分和多样性筛选。" },
    { at: 24, text: "已进入 AI 主编分析阶段，慢模型可能需要多等一会儿。" },
    { at: 45, text: "AI 仍在响应。如果接口较慢，后台会主动中断并给出明确原因。" },
    { at: 70, text: "还在等待后台返回，建议检查模型速度或 API 网关状态。" }
  ];

  loadingEl.hidden = false;
  const render = () => {
    const elapsed = Math.floor((Date.now() - startedAt) / 1000);
    const current = steps.reduce(
      (picked, step) => (elapsed >= step.at ? step : picked),
      steps[0]
    );
    loadingEl.textContent = `${current.text} 已等待 ${elapsed} 秒。`;
  };
  render();
  const timer = setInterval(render, 1000);
  return () => {
    clearInterval(timer);
    loadingEl.hidden = true;
    loadingEl.textContent = "";
  };
}

function sendMessageWithTimeout(message, timeoutMs) {
  return new Promise((resolve, reject) => {
    let done = false;
    const timer = setTimeout(() => {
      if (done) return;
      done = true;
      reject(
        new Error(
          `等待后台响应超时（${Math.round(timeoutMs / 1000)} 秒）。可以稍后重试，或检查网络/AI 接口。`
        )
      );
    }, timeoutMs);
    chrome.runtime.sendMessage(message, (resp) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      const lastErr = chrome.runtime?.lastError;
      if (lastErr) {
        reject(new Error(`扩展通信失败：${lastErr.message || "lastError"}`));
        return;
      }
      resolve(resp);
    });
  });
}
