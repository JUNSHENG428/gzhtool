/**
 * AI 选题代笔 · agent 页 render 层
 * ----------------------------------------------------------------
 * 与 agent-runner.js 的协作模式不变（依旧通过 chrome.runtime.sendMessage RUN_AGENT_TASK），
 * 这里只重写 UI：
 *   - 控制台改为单行大输入 + 平台 chip + 高级选项折叠
 *   - 三态主体（empty / running / done）
 *   - 4 平台圆点进度条 + 详细日志抽屉
 *   - brief.angles 每条加「展开提纲」按钮 → modal 预览 → 进工作台
 *   - 左侧最近任务抽屉（最多 20 条 + 钉选）
 */

import { escapeHtml, formatRuntimeError } from "../shared/utils.js";
import { PLATFORM_COOKIE_RULES, PLATFORM_IDS } from "../shared/agent/credentials.js";
import {
  addAgentTask,
  getAgentConfig,
  getAgentTask,
  listAgentTasks,
  pinAgentTask,
  removeAgentTask
} from "../shared/agent/agent-store.js";

const PLATFORM_LIST = PLATFORM_IDS.map((id) => ({
  id,
  name: PLATFORM_COOKIE_RULES[id]?.name || id,
  loginUrl: PLATFORM_COOKIE_RULES[id]?.loginUrl || ""
}));

// 空态展示用的示例主题（点一下填进输入框）
const SAMPLE_QUERIES = [
  { title: "AI 笔记软件", desc: "测评、对比、付费墙差异，适合数字工具号" },
  { title: "Apple Vision Pro 国行", desc: "上手体验、办公适配、创作者评价" },
  { title: "美联储加息预期", desc: "宏观、消费、出海，财经科技号常用" },
  { title: "周末徒步路线", desc: "本地化、季节性，适合生活方式号" }
];

const elements = {
  query: document.getElementById("agentQuery"),
  platforms: document.getElementById("agentPlatforms"),
  perPlatform: document.getElementById("agentPerPlatform"),
  finalLimit: document.getElementById("agentFinalLimit"),
  concurrency: document.getElementById("agentConcurrency"),
  include: document.getElementById("agentIncludeKeywords"),
  exclude: document.getElementById("agentExcludeKeywords"),
  enableBrief: document.getElementById("agentEnableBrief"),
  runButton: document.getElementById("agentRunButton"),
  refreshCredButton: document.getElementById("agentRefreshCredButton"),
  status: document.getElementById("agentStatus"),
  stage: document.getElementById("agentStage"),
  progressDots: document.getElementById("agentProgressDots"),
  logToggle: document.getElementById("agentLogToggle"),
  logPanel: document.getElementById("agentLogPanel"),
  sampleQueries: document.getElementById("agentSampleQueries"),
  hitsList: document.getElementById("agentHitsList"),
  hitsMeta: document.getElementById("agentHitsMeta"),
  resetButton: document.getElementById("agentResetButton"),
  briefCard: document.getElementById("agentBriefCard"),
  briefSummary: document.getElementById("agentBriefSummary"),
  briefTakeaways: document.getElementById("agentBriefTakeaways"),
  briefAngles: document.getElementById("agentBriefAngles"),
  briefTitles: document.getElementById("agentBriefTitles"),
  briefRisk: document.getElementById("agentBriefRisk"),
  historyList: document.getElementById("agentHistoryList"),
  historyCount: document.getElementById("agentHistoryCount"),
  outlineModal: document.getElementById("agentOutlineModal"),
  outlineBody: document.getElementById("agentOutlineBody"),
  outlineClose: document.getElementById("agentOutlineClose"),
  outlineCancel: document.getElementById("agentOutlineCancel"),
  outlineImport: document.getElementById("agentOutlineImport")
};

const state = {
  cookieStatuses: new Map(),
  running: false,
  // 当前展示在主区的任务（包含 query / hits / brief），用于 drill-down 引用
  currentTask: null,
  // drill-down 拿到的 outline，用户点「进工作台」时使用
  pendingOutline: null,
  pendingOutlineMeta: null,
  // 如果用户从历史里点开一条任务，记录它的 id（避免重复入库）
  activeHistoryId: null
};

renderPlatforms();
renderSampleQueries();
await applyDefaultsFromConfig();
await refreshCredentialStatus();
await refreshHistoryList();

bindEvents();

/* ============== 初始化 ============== */

async function applyDefaultsFromConfig() {
  try {
    const config = await getAgentConfig();
    const enabled = new Set(config.defaultPlatforms || []);
    elements.platforms.querySelectorAll("input[name='agent-platform']").forEach((cb) => {
      cb.checked = enabled.has(cb.value);
      const chip = cb.closest(".agent-chip");
      if (chip) chip.dataset.checked = String(cb.checked);
    });
    elements.perPlatform.value = config.perPlatformLimit;
    elements.finalLimit.value = config.finalLimit;
    elements.concurrency.value = config.concurrency;
    elements.enableBrief.checked = Boolean(config.enableBrief);
  } catch (error) {
    console.warn("[agent] failed to load defaults", error);
  }
}

function bindEvents() {
  elements.runButton.addEventListener("click", () => runAgent());
  elements.refreshCredButton.addEventListener("click", () => refreshCredentialStatus(true));
  elements.query.addEventListener("keydown", (event) => {
    if (event.key === "Enter" && !event.isComposing) {
      event.preventDefault();
      runAgent();
    }
  });
  // 用户开始编辑主题词，清掉「正在查看历史快照」的视觉提示，避免误解
  elements.query.addEventListener("input", () => {
    if (state.activeHistoryId != null) {
      state.activeHistoryId = null;
      void refreshHistoryList();
    }
  });

  // 「新任务」按钮：清空当前结果，回到空态
  if (elements.resetButton) {
    elements.resetButton.addEventListener("click", () => {
      resetToEmpty();
      elements.query.focus();
    });
  }

  elements.logToggle.addEventListener("click", () => {
    const open = elements.logPanel.hasAttribute("hidden");
    if (open) {
      elements.logPanel.removeAttribute("hidden");
      elements.logToggle.dataset.open = "true";
      elements.logToggle.setAttribute("aria-expanded", "true");
    } else {
      elements.logPanel.setAttribute("hidden", "");
      elements.logToggle.dataset.open = "false";
      elements.logToggle.setAttribute("aria-expanded", "false");
    }
  });

  // 平台 chip：点 label 也能切勾选
  elements.platforms.addEventListener("change", (event) => {
    const cb = event.target;
    if (!(cb instanceof HTMLInputElement) || cb.name !== "agent-platform") return;
    const chip = cb.closest(".agent-chip");
    if (chip) chip.dataset.checked = String(cb.checked);
  });

  // 示例主题：点一下填进 query
  elements.sampleQueries.addEventListener("click", (event) => {
    const card = event.target.closest("[data-sample]");
    if (!card) return;
    elements.query.value = card.dataset.sample || "";
    elements.query.focus();
  });

  // 历史抽屉
  elements.historyList.addEventListener("click", handleHistoryClick);

  // outline modal
  elements.outlineClose.addEventListener("click", closeOutlineModal);
  elements.outlineCancel.addEventListener("click", closeOutlineModal);
  elements.outlineModal.addEventListener("click", (event) => {
    if (event.target === elements.outlineModal) closeOutlineModal();
  });
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && !elements.outlineModal.hasAttribute("hidden")) {
      closeOutlineModal();
    }
  });
  elements.outlineImport.addEventListener("click", importOutlineToWorkspace);

  chrome.runtime.onMessage.addListener((message) => {
    if (message?.type === "AGENT_PROGRESS") {
      handleProgressEvent(message.payload || {});
    }
  });
}

/* ============== 平台 chip / 示例 / 凭据 ============== */

function renderPlatforms() {
  elements.platforms.innerHTML = PLATFORM_LIST.map(
    (p) => `
      <label class="agent-chip" data-platform="${p.id}" data-checked="true">
        <input type="checkbox" name="agent-platform" value="${p.id}" checked />
        <span>${escapeHtml(p.name)}</span>
        <span class="agent-chip-status" data-state="loading" data-status-for="${p.id}">检查中</span>
      </label>
    `
  ).join("");
}

function renderSampleQueries() {
  elements.sampleQueries.innerHTML = SAMPLE_QUERIES.map(
    (s) => `
      <button type="button" class="agent-empty-card" data-sample="${escapeHtml(s.title)}">
        <span class="agent-empty-card-title">${escapeHtml(s.title)}</span>
        <span class="agent-empty-card-desc">${escapeHtml(s.desc)}</span>
      </button>
    `
  ).join("");
}

async function refreshCredentialStatus(showStatus = false) {
  if (showStatus) {
    setStatus("正在重新检查浏览器登录状态…", "loading");
  }
  try {
    const response = await chrome.runtime.sendMessage({
      type: "GET_PLATFORM_CREDENTIAL_STATUS",
      payload: { platforms: PLATFORM_IDS }
    });
    if (!response?.ok) {
      throw new Error(response?.error?.message || "无法读取登录状态");
    }
    const statuses = response.data?.statuses || [];
    state.cookieStatuses = new Map(statuses.map((s) => [s.platformId, s]));
    statuses.forEach(updatePlatformStatusUI);
    if (showStatus) {
      const loggedInCount = statuses.filter((s) => s.loggedIn).length;
      setStatus(`登录状态已刷新：${loggedInCount}/${statuses.length} 个平台可用。`, "success");
    }
  } catch (error) {
    setStatus(formatRuntimeError(error?.message, "读取登录状态失败"), "error");
    PLATFORM_LIST.forEach((p) => {
      const node = elements.platforms.querySelector(`[data-status-for="${p.id}"]`);
      if (!node) return;
      node.dataset.state = "missing";
      node.textContent = "无法读取";
    });
  }
}

function updatePlatformStatusUI(status) {
  const node = elements.platforms.querySelector(`[data-status-for="${status.platformId}"]`);
  if (!node) return;
  if (status.loggedIn) {
    node.dataset.state = "ok";
    node.textContent = "已登录";
  } else {
    node.dataset.state = "missing";
    node.textContent = "未登录";
    // 把 chip 整体变成"可点登录"：直接挂个补登入口（非破坏性）
    const chip = node.closest(".agent-chip");
    if (chip && !chip.querySelector(".agent-chip-relogin")) {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "agent-chip-relogin";
      btn.textContent = "去登录";
      btn.addEventListener("click", (event) => {
        event.preventDefault();
        openLogin(status.platformId);
      });
      chip.appendChild(btn);
    }
  }
}

async function openLogin(platformId) {
  try {
    const response = await chrome.runtime.sendMessage({
      type: "OPEN_PLATFORM_LOGIN",
      payload: { platformId }
    });
    if (!response?.ok) {
      throw new Error(response?.error?.message || "无法打开登录页");
    }
    setStatus("已打开登录页，登录完成后回来点「刷新登录状态」。", "loading");
  } catch (error) {
    setStatus(error?.message || "无法打开登录页", "error");
  }
}

function gatherSelectedPlatforms() {
  return Array.from(elements.platforms.querySelectorAll("input[name='agent-platform']:checked")).map(
    (input) => input.value
  );
}

/* ============== 跑批主流程 ============== */

/**
 * 跑一次 agent。
 * @param {object} [preset]  可选；从历史「重跑」过来时直接复用 query / options
 */
async function runAgent(preset = null) {
  if (state.running) return;

  // 如果是重跑：先把表单还原到 preset，让用户看到「我跑的是什么参数」
  if (preset?.query) {
    elements.query.value = preset.query;
    if (preset.options) applyOptionsToForm(preset.options);
  }

  const query = elements.query.value.trim();
  if (!query) {
    setStatus("请先填写主题关键词。", "error");
    elements.query.focus();
    return;
  }
  const platforms = gatherSelectedPlatforms();
  if (platforms.length === 0) {
    setStatus("请至少勾选一个平台。", "error");
    return;
  }

  // 跑新任务时如果还有 outline modal 悬挂，强制关掉，避免引用旧 task
  if (!elements.outlineModal.hasAttribute("hidden")) {
    closeOutlineModal();
  }

  state.running = true;
  state.activeHistoryId = null;
  state.currentTask = null;
  elements.runButton.disabled = true;
  elements.runButton.textContent = "运行中…";
  elements.logPanel.innerHTML = "";
  elements.hitsList.innerHTML = "";
  elements.briefCard.hidden = true;
  elements.hitsMeta.textContent = "正在执行…";
  setStatus("正在调度 Agent，请稍候…", "loading");
  setStage("running");
  resetProgressDots(platforms);
  void refreshHistoryList();

  const options = {
    platforms,
    perPlatformLimit: clampInt(elements.perPlatform.value, 1, 30, 8),
    finalLimit: clampInt(elements.finalLimit.value, 1, 30, 10),
    concurrency: clampInt(elements.concurrency.value, 1, 4, 2),
    extraKeywords: elements.include.value,
    excludeKeywords: elements.exclude.value,
    enableBrief: elements.enableBrief.checked
  };

  try {
    const response = await chrome.runtime.sendMessage({
      type: "RUN_AGENT_TASK",
      payload: { query, options }
    });

    if (!response?.ok) {
      throw new Error(response?.error?.message || "Agent 执行失败");
    }
    const data = response.data || {};
    if (!data.ok) {
      setStatus(data.message || "Agent 任务未能完成。", "error");
      elements.hitsMeta.textContent = "未拿到有效结果";
      setStage("done");
      return;
    }

    state.currentTask = {
      query,
      options,
      hits: data.hits || [],
      brief: data.brief || null,
      summary: data.summary || null,
      errors: data.errors || [],
      skipped: data.skipped || []
    };

    renderHits(data.hits || []);
    renderBrief(data.brief);
    elements.hitsMeta.textContent = formatSummary(data);
    setStage("done");

    const errMsgs = (data.errors || []).map((e) => `${e.platformId}: ${e.message}`);
    if (errMsgs.length > 0) {
      setStatus(`完成（部分平台失败）：${errMsgs.join("；")}`, "error");
    } else {
      setStatus(`完成。命中 ${data.hits?.length || 0} 条选题。`, "success");
    }

    // 持久化到历史（异步，失败不阻塞）
    void persistCurrentTask();
  } catch (error) {
    setStatus(error?.message || "Agent 执行失败", "error");
    elements.hitsMeta.textContent = "执行失败";
    setStage("done");
  } finally {
    state.running = false;
    elements.runButton.disabled = false;
    elements.runButton.textContent = "开始跑任务";
  }
}

async function persistCurrentTask() {
  if (!state.currentTask) return;
  // 整体失败的任务（没拿到任何 hit、也没生成 brief）不写历史，
  // 避免历史抽屉里全是「0 条」的废任务。失败原因依然保留在状态行里。
  const t = state.currentTask;
  const isFailure = (!t.hits || t.hits.length === 0) && !t.brief;
  if (isFailure) {
    return;
  }
  try {
    const saved = await addAgentTask({
      query: t.query,
      options: t.options,
      hits: t.hits,
      brief: t.brief,
      summary: t.summary,
      errors: t.errors,
      skipped: t.skipped
    });
    if (saved?.id) state.activeHistoryId = saved.id;
    await refreshHistoryList();
  } catch (error) {
    console.warn("[agent] persist task failed", error);
  }
}

/* ============== 三态 / 进度 ============== */

function setStage(stage) {
  elements.stage.dataset.agentStage = stage;
}

function resetProgressDots(platforms) {
  elements.progressDots.innerHTML = platforms
    .map((id) => {
      const name = PLATFORM_COOKIE_RULES[id]?.name || id;
      return `
        <div class="agent-progress-dot" data-platform-dot="${id}" data-state="pending">
          <span class="dot-mark"></span>
          <span>${escapeHtml(name)}</span>
          <small data-count></small>
        </div>
      `;
    })
    .join("");
}

function setDotState(platformId, stateName, count) {
  if (!platformId) return;
  const dot = elements.progressDots.querySelector(`[data-platform-dot="${platformId}"]`);
  if (!dot) return;
  dot.dataset.state = stateName;
  if (count != null) {
    const small = dot.querySelector("[data-count]");
    if (small) small.textContent = `${count} 条`;
  }
}

function handleProgressEvent(progress) {
  appendLog(progress);

  switch (progress.phase) {
    case "platform-start":
      setDotState(progress.platformId, "running");
      break;
    case "platform-done":
      setDotState(progress.platformId, "done", progress.count);
      break;
    case "platform-error":
      setDotState(progress.platformId, "error");
      break;
    case "credentials-done":
      // 把跳过的平台标成 skipped
      if (Array.isArray(progress.skipped)) {
        progress.skipped.forEach((s) => setDotState(s.platformId, "skipped"));
      }
      break;
    default:
      break;
  }
}

function appendLog(progress) {
  const time = new Date(progress.ts || Date.now()).toLocaleTimeString("zh-CN", { hour12: false });
  const line = document.createElement("div");
  line.className = "agent-log-line";
  if (progress.phase) line.dataset.phase = progress.phase;
  line.innerHTML = `<span class="ts">${escapeHtml(time)}</span><span>${escapeHtml(progress.message || progress.phase || "")}</span>`;
  elements.logPanel.appendChild(line);
  elements.logPanel.scrollTop = elements.logPanel.scrollHeight;
}

/* ============== Brief / Hits 渲染 ============== */

function renderHits(hits) {
  if (!hits || hits.length === 0) {
    elements.hitsList.innerHTML = `<p class="agent-hits-empty">没有命中任何热帖，试着换主题词或放宽筛选。</p>`;
    return;
  }
  elements.hitsList.innerHTML = hits
    .map((hit, index) => {
      const relevance = typeof hit.relevance === "number" ? hit.relevance : null;
      const relBadge =
        relevance != null
          ? `<span class="relevance-badge" title="主题相关度">相关 ${(relevance * 100).toFixed(0)}%</span>`
          : "";
      return `
        <article class="agent-hit-card" data-hit-index="${index}">
          <h4>
            <a href="${escapeHtml(hit.url)}" target="_blank" rel="noopener noreferrer">${escapeHtml(hit.title)}</a>
          </h4>
          <div class="agent-hit-meta">
            <span class="platform-badge">${escapeHtml(hit.platformName)}</span>
            ${relBadge}
            ${hit.author ? `<span>${escapeHtml(hit.author)}</span>` : ""}
            ${hit.hotScore ? `<span>${escapeHtml(hit.hotScore)}</span>` : ""}
            ${hit.publishedAt ? `<span>${escapeHtml(formatTime(hit.publishedAt))}</span>` : ""}
          </div>
          ${hit.summary ? `<p class="agent-hit-summary">${escapeHtml(truncate(hit.summary, 200))}</p>` : ""}
          <div class="agent-hit-actions">
            <button type="button" class="primary" data-action="import" data-url="${escapeHtml(hit.url)}">一键入库 → 编辑台</button>
            <button type="button" data-action="copy" data-url="${escapeHtml(hit.url)}">复制链接</button>
          </div>
        </article>
      `;
    })
    .join("");

  elements.hitsList.querySelectorAll("button[data-action='import']").forEach((btn) => {
    btn.addEventListener("click", () => importHit(btn.dataset.url, btn));
  });
  elements.hitsList.querySelectorAll("button[data-action='copy']").forEach((btn) => {
    btn.addEventListener("click", () => {
      navigator.clipboard
        .writeText(btn.dataset.url || "")
        .then(() => setStatus("已复制链接到剪贴板。", "success"))
        .catch(() => setStatus("复制失败，请手动选择文字。", "error"));
    });
  });
}

async function importHit(url, button) {
  if (!url) return;
  if (button) {
    button.disabled = true;
    button.textContent = "正在抓取…";
  }
  try {
    const response = await chrome.runtime.sendMessage({
      type: "IMPORT_AGENT_HIT",
      payload: { url }
    });
    if (!response?.ok) {
      throw new Error(response?.error?.message || "抓取失败");
    }
    chrome.tabs.create({
      url: chrome.runtime.getURL("src/workspace/workspace.html") + "?import=1"
    });
    setStatus("已抓取并打开编辑台。", "success");
  } catch (error) {
    setStatus(error?.message || "入库失败，请稍后再试。", "error");
  } finally {
    if (button) {
      button.disabled = false;
      button.textContent = "一键入库 → 编辑台";
    }
  }
}

function renderBrief(brief) {
  if (!brief) {
    elements.briefCard.hidden = true;
    return;
  }
  elements.briefCard.hidden = false;
  elements.briefSummary.textContent = brief.themeSummary || "（模型未返回总结）";
  elements.briefTakeaways.innerHTML = (brief.hotTakeaways || [])
    .map((item) => `<li>${escapeHtml(item)}</li>`)
    .join("");

  // angles：每条加「展开」按钮触发 drill-down
  const angles = brief.recommendedAngles || [];
  elements.briefAngles.innerHTML = angles
    .map(
      (item, idx) => `
      <li class="agent-angle-row">
        <span class="agent-angle-text">${escapeHtml(item)}</span>
        <button type="button" class="agent-angle-expand" data-angle-index="${idx}">展开</button>
      </li>
    `
    )
    .join("");
  elements.briefAngles.querySelectorAll(".agent-angle-expand").forEach((btn) => {
    btn.addEventListener("click", () => {
      const idx = Number(btn.dataset.angleIndex);
      const angle = angles[idx];
      if (angle) void openOutlineModal(angle, btn);
    });
  });

  elements.briefTitles.innerHTML = (brief.titleCandidates || [])
    .map((item) => `<li>${escapeHtml(item)}</li>`)
    .join("");
  elements.briefRisk.textContent = brief.riskNotes || "";
}

/* ============== Drill-Down outline modal ============== */

async function openOutlineModal(angle, triggerButton) {
  if (!state.currentTask) {
    setStatus("没有可展开的上下文，请先跑一次任务。", "error");
    return;
  }
  state.pendingOutline = null;
  state.pendingOutlineMeta = { query: state.currentTask.query, angle };
  elements.outlineImport.disabled = true;
  elements.outlineBody.innerHTML = `<div class="agent-modal-loading">AI 正在生成提纲…</div>`;
  elements.outlineModal.removeAttribute("hidden");

  if (triggerButton) {
    triggerButton.disabled = true;
    triggerButton.textContent = "生成中…";
  }

  try {
    const response = await chrome.runtime.sendMessage({
      type: "GENERATE_ANGLE_OUTLINE",
      payload: {
        query: state.currentTask.query,
        angle,
        hits: state.currentTask.hits.slice(0, 10).map((h) => ({
          platformName: h.platformName,
          title: h.title,
          summary: h.summary
        }))
      }
    });
    if (!response?.ok) {
      throw new Error(response?.error?.message || "AI 生成提纲失败");
    }
    state.pendingOutline = response.data;
    renderOutlineModal(response.data, angle);
    elements.outlineImport.disabled = false;
  } catch (error) {
    elements.outlineBody.innerHTML = `<div class="agent-modal-error">${escapeHtml(
      error?.message || "AI 生成失败，请稍后重试。"
    )}</div>`;
  } finally {
    if (triggerButton) {
      triggerButton.disabled = false;
      triggerButton.textContent = "展开";
    }
  }
}

function renderOutlineModal(outline, angle) {
  const segments = Array.isArray(outline?.outline) ? outline.outline : [];
  const keyPoints = Array.isArray(outline?.keyPoints) ? outline.keyPoints : [];
  const hits = Array.isArray(state.currentTask?.hits) ? state.currentTask.hits : [];
  const refs = Array.isArray(outline?.referencedHits) ? outline.referencedHits : [];

  const html = `
    <p class="agent-modal-meta">围绕「${escapeHtml(angle)}」展开</p>

    <div class="agent-modal-section">
      <h4>建议标题</h4>
      <p>${escapeHtml(outline?.title || "（未给出）")}</p>
    </div>

    <div class="agent-modal-section">
      <h4>提纲（${segments.length} 段）</h4>
      <ol>
        ${segments
          .map(
            (seg) => `
          <li>
            <strong>${escapeHtml(seg.heading || "")}</strong>
            ${seg.summary ? `<div style="color: var(--soft-ink); font-size: 13px; margin-top: 2px">${escapeHtml(seg.summary)}</div>` : ""}
          </li>
        `
          )
          .join("")}
      </ol>
    </div>

    ${
      keyPoints.length > 0
        ? `
      <div class="agent-modal-section">
        <h4>关键论点</h4>
        <ul>${keyPoints.map((p) => `<li>${escapeHtml(p)}</li>`).join("")}</ul>
      </div>
    `
        : ""
    }

    ${
      refs.length > 0
        ? `
      <div class="agent-modal-section">
        <h4>引用的热帖</h4>
        <ul>${refs
          .map((idx) => {
            const hit = hits[idx - 1];
            if (!hit) return `<li>#${escapeHtml(String(idx))}（未找到）</li>`;
            return `<li><a href="${escapeHtml(hit.url)}" target="_blank" rel="noopener noreferrer">${escapeHtml(hit.title)}</a> · ${escapeHtml(hit.platformName)}</li>`;
          })
          .join("")}
        </ul>
      </div>
    `
        : ""
    }
  `;
  elements.outlineBody.innerHTML = html;
}

function closeOutlineModal() {
  elements.outlineModal.setAttribute("hidden", "");
  state.pendingOutline = null;
  state.pendingOutlineMeta = null;
}

async function importOutlineToWorkspace() {
  if (!state.pendingOutline || !state.pendingOutlineMeta) {
    setStatus("提纲尚未生成，无法入库。", "error");
    return;
  }
  elements.outlineImport.disabled = true;
  elements.outlineImport.textContent = "正在入库…";
  try {
    const response = await chrome.runtime.sendMessage({
      type: "IMPORT_AGENT_OUTLINE",
      payload: {
        outline: state.pendingOutline,
        query: state.pendingOutlineMeta.query,
        angle: state.pendingOutlineMeta.angle
      }
    });
    if (!response?.ok) {
      throw new Error(response?.error?.message || "提纲入库失败");
    }
    chrome.tabs.create({
      url: chrome.runtime.getURL("src/workspace/workspace.html") + "?import=1"
    });
    closeOutlineModal();
    setStatus("提纲已入库并打开编辑台。", "success");
  } catch (error) {
    setStatus(error?.message || "提纲入库失败。", "error");
  } finally {
    elements.outlineImport.disabled = false;
    elements.outlineImport.textContent = "进工作台开稿";
  }
}

/* ============== 历史抽屉 ============== */

async function refreshHistoryList() {
  try {
    const tasks = await listAgentTasks();
    elements.historyCount.textContent = String(tasks.length);
    if (tasks.length === 0) {
      elements.historyList.innerHTML = `<div class="agent-history-empty">还没有跑过任务<br />跑一次后会自动留档</div>`;
      return;
    }
    elements.historyList.innerHTML = tasks
      .map((t) => {
        const isActive = t.id === state.activeHistoryId;
        const cls = ["agent-history-item"];
        if (t.isPinned) cls.push("is-pinned");
        if (isActive) cls.push("is-active");
        const hits = Array.isArray(t.hits) ? t.hits.length : 0;
        return `
          <div class="${cls.join(" ")}" role="listitem" data-task-id="${escapeHtml(t.id)}">
            <span class="agent-history-item-actions">
              <button type="button" data-action="rerun" title="按上次参数重跑">↻</button>
              <button type="button" data-action="pin" data-pinned="${t.isPinned ? "true" : "false"}" title="${t.isPinned ? "取消钉选" : "钉住"}">${t.isPinned ? "★" : "☆"}</button>
              <button type="button" data-action="remove" title="删除">✕</button>
            </span>
            <div class="agent-history-item-title" data-action="open">${escapeHtml(t.query || "(无主题词)")}</div>
            <div class="agent-history-item-meta">
              <span>${hits} 条</span>
              <span class="dot"></span>
              <span>${escapeHtml(formatRelativeTime(t.createdAt))}</span>
              ${t.brief ? '<span class="dot"></span><span title="包含 AI 选题总结">brief</span>' : ""}
            </div>
          </div>
        `;
      })
      .join("");
  } catch (error) {
    console.warn("[agent] refresh history failed", error);
  }
}

async function handleHistoryClick(event) {
  const item = event.target.closest(".agent-history-item");
  if (!item) return;
  const id = item.dataset.taskId;
  if (!id) return;

  const actionBtn = event.target.closest("button[data-action]");
  if (actionBtn) {
    event.stopPropagation();
    const action = actionBtn.dataset.action;
    if (action === "pin") {
      const willPin = actionBtn.dataset.pinned !== "true";
      await pinAgentTask(id, willPin);
      await refreshHistoryList();
      return;
    }
    if (action === "remove") {
      await removeAgentTask(id);
      if (state.activeHistoryId === id) state.activeHistoryId = null;
      await refreshHistoryList();
      return;
    }
    if (action === "rerun") {
      const task = await getAgentTask(id);
      if (!task) {
        setStatus("找不到这条历史任务，可能已被删除。", "error");
        await refreshHistoryList();
        return;
      }
      // 用上次的 query / options 重跑；preset 走主路径
      await runAgent({ query: task.query, options: task.options || {} });
      return;
    }
  }

  // 点条目主体：把这条任务的 hits/brief 重新 hydrate 到右侧（不重跑）
  await openHistoryTask(id);
}

async function openHistoryTask(id) {
  try {
    const task = await getAgentTask(id);
    if (!task) return;

    // 载入历史时如有打开的 outline modal，关掉，避免引用旧 task 的上下文
    if (!elements.outlineModal.hasAttribute("hidden")) {
      closeOutlineModal();
    }

    state.currentTask = {
      query: task.query,
      options: task.options || {},
      hits: task.hits || [],
      brief: task.brief || null,
      summary: task.summary || null,
      errors: task.errors || [],
      skipped: task.skipped || []
    };
    state.activeHistoryId = id;
    elements.query.value = task.query || "";
    if (task.options) applyOptionsToForm(task.options);

    setStage("done");
    renderHits(task.hits || []);
    renderBrief(task.brief);
    elements.hitsMeta.textContent = task.hits?.length
      ? `命中 ${task.hits.length} 条 · 历史快照（不重跑）`
      : "历史快照（无命中）";
    setStatus(`已载入历史任务：${task.query}`, "success");
    await refreshHistoryList();
  } catch (error) {
    setStatus(error?.message || "载入历史任务失败。", "error");
  }
}

/**
 * 把 task.options 还原到表单（平台 chip + 高级选项）。
 * 静默：不存在的字段保持表单当前值。
 */
function applyOptionsToForm(options) {
  if (!options || typeof options !== "object") return;
  if (Array.isArray(options.platforms) && options.platforms.length > 0) {
    const want = new Set(options.platforms);
    elements.platforms.querySelectorAll("input[name='agent-platform']").forEach((cb) => {
      cb.checked = want.has(cb.value);
      const chip = cb.closest(".agent-chip");
      if (chip) chip.dataset.checked = String(cb.checked);
    });
  }
  if (Number.isFinite(Number(options.perPlatformLimit))) {
    elements.perPlatform.value = String(options.perPlatformLimit);
  }
  if (Number.isFinite(Number(options.finalLimit))) {
    elements.finalLimit.value = String(options.finalLimit);
  }
  if (Number.isFinite(Number(options.concurrency))) {
    elements.concurrency.value = String(options.concurrency);
  }
  if (typeof options.extraKeywords === "string") {
    elements.include.value = options.extraKeywords;
  }
  if (typeof options.excludeKeywords === "string") {
    elements.exclude.value = options.excludeKeywords;
  }
  if (typeof options.enableBrief === "boolean") {
    elements.enableBrief.checked = options.enableBrief;
  }
}

/**
 * 清空当前结果，回到 empty 态。
 * 不动表单值（用户可能想稍微改改主题词再跑），不动历史，不动登录态。
 */
function resetToEmpty() {
  if (state.running) return;
  if (!elements.outlineModal.hasAttribute("hidden")) {
    closeOutlineModal();
  }
  state.currentTask = null;
  state.activeHistoryId = null;
  elements.hitsList.innerHTML = "";
  elements.briefCard.hidden = true;
  elements.hitsMeta.textContent = "等待开始…";
  elements.logPanel.innerHTML = "";
  setStage("empty");
  setStatus("");
  void refreshHistoryList();
}

/* ============== 工具函数 ============== */

function setStatus(message, stateName) {
  elements.status.textContent = message || "";
  if (stateName) {
    elements.status.dataset.state = stateName;
  } else {
    delete elements.status.dataset.state;
  }
}

function clampInt(value, min, max, fallback) {
  const n = Math.round(Number(value));
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, n));
}

function truncate(text, max) {
  const s = String(text || "");
  return s.length > max ? `${s.slice(0, max)}…` : s;
}

function formatTime(value) {
  if (!value) return "";
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return value;
  return d.toLocaleString("zh-CN", { hour12: false });
}

function formatRelativeTime(ts) {
  if (!ts) return "";
  const diff = Date.now() - Number(ts);
  if (!Number.isFinite(diff) || diff < 0) return "";
  const minute = 60 * 1000;
  const hour = 60 * minute;
  const day = 24 * hour;
  if (diff < minute) return "刚刚";
  if (diff < hour) return `${Math.floor(diff / minute)} 分钟前`;
  if (diff < day) return `${Math.floor(diff / hour)} 小时前`;
  if (diff < 30 * day) return `${Math.floor(diff / day)} 天前`;
  return new Date(ts).toLocaleDateString("zh-CN");
}

function formatSummary(data) {
  const summary = data.summary || {};
  const hits = data.hits || [];
  const skipped = data.skipped || [];
  const parts = [`命中 ${hits.length} 条`];
  if (summary.raw != null) parts.push(`原始 ${summary.raw} 条`);
  if (summary.attempted != null)
    parts.push(`参与平台 ${summary.attempted}/${summary.requested ?? summary.attempted}`);
  if (skipped.length > 0) parts.push(`跳过 ${skipped.length} 个平台（未登录）`);
  return parts.join(" · ");
}
