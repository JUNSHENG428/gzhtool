/**
 * workspace-task-center.js
 *
 * 右下角浮动任务中心：折叠气泡 + 展开面板 + toast。
 *
 * 职责：
 *  - 启动时 sendMessage(LIST_TASKS) 拉一次全量；运行时监听 TASK_LIST_CHANGED 增量
 *  - 渲染进行中 / 待执行 / 最近完成三段任务列表
 *  - 进行中任务可取消（CANCEL_TASK），完成任务可点[查看]跳到对应 article
 *  - task 从 running → done/failed 时，如果当前 article 不是任务关联的 article，
 *    弹 toast 提醒并提供[查看]跳转
 *
 * 不直接发起任务：rewrite / capture 仍由各自模块 sendMessage(REWRITE_ARTICLE / SCRAPE_*)，
 * 注册到 task-registry 是 SW 端的事。本模块仅消费状态变化。
 */

let _ctx;
let _root;
let _bubble;
let _badge;
let _panel;
let _toastHost;
let _expanded = false;

/** 本地缓存的 task 列表，从 LIST_TASKS / TASK_LIST_CHANGED 同步 */
let _snapshot = { running: [], pending: [], done: [] };
/** 上一帧的 task status，用于 detect 完成事件触发 toast */
const _lastStatusByTaskId = new Map();

const TOAST_TIMEOUT_MS = 5000;
const MAX_VISIBLE_TOASTS = 3;

/**
 * @param {Object} ctx
 * @param {() => string} ctx.getCurrentArticleId
 * @param {(articleId: string) => Promise<boolean>} ctx.goToArticle
 *   返回 true 表示跳转成功；false 表示找不到 article
 * @param {(task: object) => Promise<void>} ctx.onTaskDone
 *   rewrite 完成时让 workspace-rewrite 应用结果到 article
 */
export function mountTaskCenter(ctx) {
  _ctx = ctx;

  _root = document.querySelector("#taskCenterRoot");
  if (!_root) {
    console.warn("[task-center] #taskCenterRoot 容器不存在，跳过 mount");
    return;
  }

  _root.innerHTML = `
    <div class="task-center__toasts" data-task-center-toasts></div>
    <div class="task-center__panel" data-task-center-panel hidden>
      <header class="task-center__panel-head">
        <span class="task-center__panel-title">后台任务</span>
        <button type="button" class="task-center__panel-close" data-task-center-close aria-label="收起">×</button>
      </header>
      <div class="task-center__panel-body" data-task-center-body></div>
    </div>
    <button
      type="button"
      class="task-center__bubble"
      data-task-center-bubble
      aria-label="后台任务"
      aria-expanded="false"
    >
      <span class="task-center__bubble-icon" aria-hidden="true">⚙</span>
      <span class="task-center__bubble-badge" data-task-center-badge hidden>0</span>
    </button>
  `;

  _bubble = _root.querySelector("[data-task-center-bubble]");
  _badge = _root.querySelector("[data-task-center-badge]");
  _panel = _root.querySelector("[data-task-center-panel]");
  _toastHost = _root.querySelector("[data-task-center-toasts]");

  _bubble.addEventListener("click", () => setExpanded(!_expanded));

  // 全 _root 事件委托：close / cancel / goto / toast-close 全部走一份 handler，
  // 避免动态创建 toast 元素时 listener 注册时机不稳的问题。
  _root.addEventListener("click", (event) => {
    const target = event.target;
    if (!(target instanceof Element)) return;

    const closeBtn = target.closest("[data-task-center-close]");
    if (closeBtn && _root.contains(closeBtn)) {
      event.stopPropagation();
      setExpanded(false);
      return;
    }
    const toastCloseBtn = target.closest("[data-task-toast-close]");
    if (toastCloseBtn) {
      event.stopPropagation();
      const toastEl = toastCloseBtn.closest(".task-center__toast");
      toastEl?.remove();
      return;
    }
    const cancelBtn = target.closest("[data-task-cancel]");
    if (cancelBtn) {
      event.stopPropagation();
      const taskId = cancelBtn.dataset.taskCancel;
      void cancelTask(taskId);
      return;
    }
    const goBtn = target.closest("[data-task-goto]");
    if (goBtn) {
      event.stopPropagation();
      const taskId = goBtn.dataset.taskGoto;
      // toast 上的 [查看] 点完顺手把 toast 关掉
      const toastEl = goBtn.closest(".task-center__toast");
      toastEl?.remove();
      void handleGoToTask(taskId);
      return;
    }
    const retryBtn = target.closest("[data-task-retry]");
    if (retryBtn) {
      event.stopPropagation();
      const taskId = retryBtn.dataset.taskRetry;
      const toastEl = retryBtn.closest(".task-center__toast");
      toastEl?.remove();
      void handleRetryTask(taskId);
      return;
    }
  });

  // 监听后台推送的 task list change
  chrome.runtime.onMessage.addListener((message) => {
    if (message?.type === "TASK_LIST_CHANGED") {
      applySnapshot(message.payload || { running: [], pending: [], done: [] });
    }
  });

  // 初次拉一次全量
  void chrome.runtime
    .sendMessage({ type: "LIST_TASKS" })
    .then((response) => {
      if (response?.ok && response.data) {
        applySnapshot(response.data);
      }
    })
    .catch(() => {});

  render();
}

function setExpanded(expanded) {
  _expanded = expanded;
  _panel.hidden = !expanded;
  _bubble.setAttribute("aria-expanded", String(expanded));
  _root.dataset.expanded = String(expanded);
}

function applySnapshot(snapshot) {
  const previous = _snapshot;
  _snapshot = {
    running: Array.isArray(snapshot.running) ? snapshot.running : [],
    pending: Array.isArray(snapshot.pending) ? snapshot.pending : [],
    done: Array.isArray(snapshot.done) ? snapshot.done : []
  };

  // detect 完成事件 → 决定是否弹 toast / 触发 onTaskDone
  detectCompletedTasks(previous);

  render();
}

function detectCompletedTasks(previous) {
  const allCurrent = [..._snapshot.running, ..._snapshot.pending, ..._snapshot.done];
  const currentArticleId = safeGetCurrentArticleId();

  for (const task of allCurrent) {
    const wasRunning = (previous.running || []).some((t) => t.id === task.id) ||
      (previous.pending || []).some((t) => t.id === task.id);
    const lastStatus = _lastStatusByTaskId.get(task.id);

    // 终态首次出现 = 这一帧刚完成
    const justCompleted =
      (task.status === "done" || task.status === "failed" || task.status === "cancelled") &&
      lastStatus !== task.status;

    if (justCompleted) {
      handleTaskCompleted(task, currentArticleId, wasRunning);
    }

    _lastStatusByTaskId.set(task.id, task.status);
  }

  // 清理已不存在的 task 的 _lastStatusByTaskId 记录（修剪掉 done 队列后的）
  const aliveIds = new Set(allCurrent.map((t) => t.id));
  for (const id of _lastStatusByTaskId.keys()) {
    if (!aliveIds.has(id)) _lastStatusByTaskId.delete(id);
  }
}

async function handleTaskCompleted(task, currentArticleId, wasRunning) {
  // rewrite / capture 任务完成且成功：调 onTaskDone 让 workspace-rewrite/capture 应用结果。
  // **关键**：TASK_LIST_CHANGED broadcast 故意不带 task.result（payload 体积优化），
  // 必须在 apply 前手动拉 result（GET_TASK_RESULT），否则 apply 函数会因 result=undefined
  // 直接 return —— 表现就是用户点[查看]后看到的还是改写前的内容（"好像没保存"）。
  if (
    (task.type === "rewrite" || task.type === "capture" || task.type === "deepHumanize") &&
    task.status === "done" &&
    _ctx?.onTaskDone
  ) {
    const taskWithResult = await ensureTaskResult(task);
    try {
      await _ctx.onTaskDone(taskWithResult);
    } catch (err) {
      console.warn("[task-center] onTaskDone 失败", err);
    }
  }

  // toast 条件：
  // - 当前不在该 article（即用户切走了 / 关心的是后台跑的 task）
  // - 或 task 失败 / 取消（不管在不在该 article 都要让用户知道）
  const shouldToast =
    task.status === "failed" ||
    task.status === "cancelled" ||
    (task.articleId && task.articleId !== currentArticleId);

  if (shouldToast && wasRunning) {
    showToast(task);
  }
}

/**
 * 按需从 SW 拉 task.result。
 * TASK_LIST_CHANGED broadcast 出于体积考虑不带 result（pickPublicFields 剔除），
 * apply 前必须显式 GET_TASK_RESULT 拉一次。
 */
async function ensureTaskResult(task) {
  if (task?.result) return task;
  if (!task?.id) return task;
  try {
    const resp = await chrome.runtime.sendMessage({
      type: "GET_TASK_RESULT",
      payload: { taskId: task.id }
    });
    if (resp?.ok && resp.data) {
      return { ...task, result: resp.data };
    }
  } catch (err) {
    console.warn("[task-center] GET_TASK_RESULT 失败", err);
  }
  return task;
}

function safeGetCurrentArticleId() {
  try {
    return _ctx?.getCurrentArticleId?.() || "";
  } catch {
    return "";
  }
}

async function cancelTask(taskId) {
  if (!taskId) return;
  try {
    await chrome.runtime.sendMessage({ type: "CANCEL_TASK", payload: { taskId } });
  } catch (err) {
    console.warn("[task-center] CANCEL_TASK 失败", err);
  }
}

/**
 * 用户点 [重试] 按钮：先切到 task 关联的 article，再让 ctx 重发同类型操作。
 *
 * 不在 SW 端做"复活老 task"——LLM payload 已发完，老 task 的输入数据未必还在
 * task.result 里（rewrite 失败时常常 result 为 null）。最稳的做法是让前端切回
 * 该 article 后，调原入口（rewriteArticle / captureSource）重新发起一个新 task。
 */
async function handleRetryTask(taskId) {
  const task = findTaskById(taskId);
  if (!task || !task.articleId) return;
  const ok = await _ctx?.goToArticle?.(task.articleId);
  if (!ok) {
    showToast({
      ...task,
      status: "failed",
      _customMessage: "重试失败：找不到对应文章"
    });
    return;
  }
  try {
    await _ctx?.retryTask?.(task);
  } catch (err) {
    console.warn("[task-center] retry 触发失败", err);
  }
}

async function handleGoToTask(taskId) {
  const task = findTaskById(taskId);
  if (!task) return;
  if (!task.articleId) return;

  const ok = await _ctx?.goToArticle?.(task.articleId);
  if (!ok) {
    showToast({
      ...task,
      status: "failed",
      _customMessage: "找不到对应文章——可能已删除"
    });
    return;
  }

  // 如果任务已 done，把完整 result 拉过来再触发 apply（TASK_LIST_CHANGED 不带 result）
  if (
    (task.type === "rewrite" || task.type === "capture" || task.type === "deepHumanize") &&
    task.status === "done" &&
    _ctx?.onTaskDone
  ) {
    const taskWithResult = await ensureTaskResult(task);
    try {
      await _ctx.onTaskDone(taskWithResult);
    } catch (err) {
      console.warn("[task-center] goto 后 onTaskDone 失败", err);
    }
  }
}

function findTaskById(taskId) {
  return [..._snapshot.running, ..._snapshot.pending, ..._snapshot.done].find(
    (t) => t.id === taskId
  );
}

// ---------------------------------------------------------------------
// 渲染
// ---------------------------------------------------------------------

function render() {
  const runningCount = _snapshot.running.length + _snapshot.pending.length;

  // bubble badge
  if (runningCount > 0) {
    _badge.textContent = String(runningCount);
    _badge.hidden = false;
    _root.dataset.busy = "true";
  } else {
    _badge.hidden = true;
    delete _root.dataset.busy;
  }

  // panel body
  const body = _root.querySelector("[data-task-center-body]");
  if (!body) return;

  const totalTasks = _snapshot.running.length + _snapshot.pending.length + _snapshot.done.length;
  if (totalTasks === 0) {
    body.innerHTML = `
      <div class="task-center__empty">
        <p>还没有后台任务</p>
        <p class="task-center__empty-hint">改写、抓取或深度去 AI 味时会在这里看到进度</p>
      </div>
    `;
    return;
  }

  const sections = [];
  if (_snapshot.running.length || _snapshot.pending.length) {
    const items = [..._snapshot.running, ..._snapshot.pending];
    sections.push(`
      <section class="task-center__section">
        <h4 class="task-center__section-title">进行中 (${items.length})</h4>
        <ul class="task-center__list">
          ${items.map(renderRunningChip).join("")}
        </ul>
      </section>
    `);
  }
  if (_snapshot.done.length) {
    sections.push(`
      <section class="task-center__section">
        <h4 class="task-center__section-title">最近完成 (${_snapshot.done.length})</h4>
        <ul class="task-center__list">
          ${_snapshot.done.map(renderDoneChip).join("")}
        </ul>
      </section>
    `);
  }

  body.innerHTML = sections.join("");
}

function renderRunningChip(task) {
  const phaseLabel = phaseToLabel(task);
  const progressBar = renderProgressBar(task);
  const typeLabel = taskTypeLabel(task.type);
  const statusBadge =
    task.status === "pending"
      ? `<span class="task-center__chip-pill task-center__chip-pill--pending">排队中</span>`
      : `<span class="task-center__chip-pill task-center__chip-pill--running">处理中</span>`;

  return `
    <li class="task-center__chip task-center__chip--running" data-task-id="${escapeHtml(task.id)}">
      <div class="task-center__chip-head">
        <span class="task-center__chip-type task-center__chip-type--${task.type}">${typeLabel}</span>
        <span class="task-center__chip-title" title="${escapeHtml(task.articleTitle)}">${escapeHtml(task.articleTitle)}</span>
        ${statusBadge}
      </div>
      <div class="task-center__chip-meta">
        <span class="task-center__chip-phase">${phaseLabel}</span>
        ${progressBar}
      </div>
      <div class="task-center__chip-actions">
        <button type="button" class="task-center__chip-btn task-center__chip-btn--ghost" data-task-cancel="${escapeHtml(task.id)}">取消</button>
      </div>
    </li>
  `;
}

function renderDoneChip(task) {
  const elapsed = task.finishedAt && task.startedAt
    ? `${Math.max(1, Math.round((task.finishedAt - task.startedAt) / 1000))}s`
    : "";
  const statusIcon = task.status === "done" ? "✓" : task.status === "failed" ? "✗" : "⊘";
  const statusClass =
    task.status === "done" ? "task-center__chip--done"
      : task.status === "failed" ? "task-center__chip--failed"
        : "task-center__chip--cancelled";
  const typeLabel = taskTypeLabel(task.type);
  const statusLabel = task.status === "done" ? "已完成"
    : task.status === "failed" ? "失败"
      : "已取消";
  // 错误 / 取消原因都用同一行展示（cancelReason 是 cross-type 自动 cancel 写的归因）
  const errorOrReason = task.status === "failed" && task.error
    ? task.error
    : task.status === "cancelled" && task.cancelReason
      ? task.cancelReason
      : "";
  const error = errorOrReason
    ? `<p class="task-center__chip-error" title="${escapeHtml(errorOrReason)}">${escapeHtml(errorOrReason)}</p>`
    : "";
  const goButton = task.articleId
    ? `<button type="button" class="task-center__chip-btn" data-task-goto="${escapeHtml(task.id)}">查看</button>`
    : "";
  // 失败 / 取消的任务都给一个 [重试] 按钮，省去用户切回 layout 重新点改写的累
  const retryButton = (task.status === "failed" || task.status === "cancelled") && task.articleId
    ? `<button type="button" class="task-center__chip-btn task-center__chip-btn--ghost" data-task-retry="${escapeHtml(task.id)}">重试</button>`
    : "";

  return `
    <li class="task-center__chip ${statusClass}" data-task-id="${escapeHtml(task.id)}">
      <div class="task-center__chip-head">
        <span class="task-center__chip-status" aria-hidden="true">${statusIcon}</span>
        <span class="task-center__chip-type task-center__chip-type--${task.type}">${typeLabel}</span>
        <span class="task-center__chip-title" title="${escapeHtml(task.articleTitle)}">${escapeHtml(task.articleTitle)}</span>
      </div>
      <div class="task-center__chip-meta">
        <span class="task-center__chip-phase">${statusLabel}${elapsed ? ` · ${elapsed}` : ""}</span>
      </div>
      ${error}
      <div class="task-center__chip-actions">
        ${retryButton}
        ${goButton}
      </div>
    </li>
  `;
}

function phaseToLabel(task) {
  const phase = task.phase || "queued";
  if (task.status === "pending") return "排队中…";
  switch (phase) {
    case "queued":
    case "starting":
      return "准备中…";
    case "pass1:start":
      return "AI 改写中…";
    case "pass1:streaming": {
      // 39th 续 · Phase 3b · 流式实时反馈：「AI 流式生成中… 1234 字 / 56 token」
      const chars = Number(task.streamingChars) || 0;
      const tokens = Number(task.streamingTokens) || 0;
      const segments = ["AI 流式生成中…"];
      if (chars > 0) segments.push(`${chars} 字`);
      if (tokens > 0) segments.push(`${tokens} token`);
      return segments.join("  ");
    }
    case "pass1:done":
      return "分析 AI 痕迹…";
    case "pass2:plan":
      return "规划润色段落…";
    case "pass2:start":
      return "开始润色…";
    case "pass2:tick":
      return `润色中 ${task.current || 0}/${task.total || 0}`;
    case "pass2:done":
      return "润色完成…";
    case "done":
      return "收尾…";
    case "capture:start":
      return "抓取开始…";
    case "capture:fetching":
      return "抓取中…";
    case "capture:parsing":
      return "解析正文…";
    case "capture:done":
      return "抓取完成…";
    case "deepHumanize:judge":
      return "AI 审稿员正在评审…";
    case "deepHumanize:rewrite":
      return "正在整体重写…";
    default:
      return phase;
  }
}

function renderProgressBar(task) {
  const total = Number(task.total) || 0;
  const current = Number(task.current) || 0;
  if (total > 0 && current >= 0) {
    const pct = Math.min(100, Math.round((current / total) * 100));
    return `
      <div class="task-center__progress" role="progressbar" aria-valuemin="0" aria-valuemax="${total}" aria-valuenow="${current}">
        <div class="task-center__progress-fill" style="width: ${pct}%"></div>
      </div>
    `;
  }
  // indeterminate
  return `
    <div class="task-center__progress task-center__progress--indeterminate" role="progressbar" aria-busy="true">
      <div class="task-center__progress-fill"></div>
    </div>
  `;
}

// ---------------------------------------------------------------------
// Toast
// ---------------------------------------------------------------------

function showToast(task) {
  if (!_toastHost) return;

  // 防淹没：超过 MAX_VISIBLE_TOASTS 时挤掉最老的
  while (_toastHost.children.length >= MAX_VISIBLE_TOASTS) {
    _toastHost.firstElementChild?.remove();
  }

  const el = document.createElement("div");
  el.className = `task-center__toast task-center__toast--${task.status}`;
  el.setAttribute("role", "status");

  const typeLabel = taskTypeLabel(task.type);
  const statusLabel = task.status === "done" ? "已完成"
    : task.status === "failed" ? "失败"
      : "已取消";
  const customMessage = task._customMessage;
  const title = escapeHtml(task.articleTitle || "未命名");

  // 取消归因：cancelReason 是 task-registry 在 cross-type cancel 时写入的，
  // 比如 capture 触发自动取消同 article 的 rewrite 时会写"因抓取新内容自动取消…"
  const hint = customMessage
    || (task.status === "cancelled" && task.cancelReason)
    || (task.status === "failed" && task.error);

  el.innerHTML = `
    <div class="task-center__toast-body">
      <span class="task-center__toast-icon" aria-hidden="true">${task.status === "done" ? "✓" : task.status === "failed" ? "✗" : "⊘"}</span>
      <div class="task-center__toast-text">
        <strong>《${title}》${typeLabel}${statusLabel}</strong>
        ${hint
          ? `<span class="task-center__toast-hint" title="${escapeHtml(hint)}">${escapeHtml(hint)}</span>`
          : ""
        }
      </div>
      ${task.articleId && task.status === "done"
        ? `<button type="button" class="task-center__toast-cta" data-task-goto="${escapeHtml(task.id)}">查看</button>`
        : ""
      }
      ${task.articleId && (task.status === "failed" || task.status === "cancelled")
        ? `<button type="button" class="task-center__toast-cta" data-task-retry="${escapeHtml(task.id)}">重试</button>`
        : ""
      }
      <button type="button" class="task-center__toast-close" aria-label="关闭" data-task-toast-close>×</button>
    </div>
  `;

  _toastHost.appendChild(el);

  // 点击交互（[查看] / [×]）由 _root 顶层事件委托统一处理，不在此处绑定。

  // 自动消失：5s 后移除；hover 到 toast 上时取消计时（让用户看完再决定）
  const timer = setTimeout(() => el.remove(), TOAST_TIMEOUT_MS);
  el.addEventListener("mouseenter", () => clearTimeout(timer));
}

// ---------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------

function taskTypeLabel(type) {
  switch (type) {
    case "rewrite":
      return "改写";
    case "capture":
      return "抓取";
    case "deepHumanize":
      return "深度去 AI 味";
    default:
      return String(type || "任务");
  }
}

function escapeHtml(input) {
  return String(input ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}
