/**
 * task-registry.js
 *
 * 后台 service worker 维护的"任务中心"数据层。
 *
 * 把 AI 改写 / 抓取等耗时操作从"前台 modal 阻塞"模式改造成后台任务模式：
 * 用户触发后立即返回任务 id，task 在后台跑，前端通过 TASK_LIST_CHANGED
 * 事件 + LIST_TASKS 拉取实时更新右下角任务中心 UI（workspace-task-center.js）。
 *
 * 设计要点：
 *  - task.id 是内部 id（"tsk-..."），requestId 与 SW 现有 broadcastRewriteProgress
 *    一一对应，不破坏 humanize-pass / SKIP_HUMANIZE_PASS 协议。
 *  - 并发闸：rewrite / capture 各自最多 2 in-flight，超出压 pending 队列。
 *  - 持久化用 chrome.storage.session（chrome 重启清空，SW 被 kill 不清空）—
 *    这正好匹配我们的需求，跨进程崩溃恢复但跨 chrome 重启清理 stale。
 *  - AbortController 不可 serialize，restore 时一律丢弃，stale 任务直接标 failed。
 */

const STORAGE_KEY = "__task_registry";

const MAX_PARALLEL_BY_TYPE = {
  rewrite: 2,
  capture: 2
};

const RECENT_DONE_LIMIT = 5;
const STALE_RUNNING_MS = 5 * 60 * 1000;
const PERSIST_DEBOUNCE_MS = 200;

/** @type {Map<string, Task>} */
const tasks = new Map();
/** @type {Map<string, AbortController>} */
const controllers = new Map();

let persistTimer = null;
let notifyTimer = null;

/**
 * @typedef {Object} Task
 * @property {string} id
 * @property {string} requestId   // 与 SW broadcastRewriteProgress 兼容
 * @property {'rewrite'|'capture'} type
 * @property {string} articleId
 * @property {string} articleTitle
 * @property {'pending'|'running'|'done'|'failed'|'cancelled'} status
 * @property {string} [phase]
 * @property {number} [current]
 * @property {number} [total]
 * @property {number} startedAt
 * @property {number} [finishedAt]
 * @property {string} [error]
 * @property {*} [result]
 */

function newTaskId() {
  return `tsk-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * 创建一个 task；并发未满 status='running'，否则 'pending' 入队。
 *
 * 历史决策：曾经在这里加过「同 articleId + 同 type 自动取消老 task」的 dedup
 * 逻辑（2026-04-29 33rd session 初版），目的是避免用户连点改写按钮造成双倍 token。
 * 但实测后发现该逻辑误伤了「用户已切到副篇又对同一篇 article 触发改写」的合理场景，
 * 而且即便严格语义"同篇连点"也是用户的选择（用户能在 task center 看到老任务还在跑，
 * 自己决定是否取消）。**现已移除自动 dedup**，所有 task 一律平等入 queue，max 2 并发。
 */
export function addTask({ type, articleId, articleTitle, requestId }) {
  const id = newTaskId();
  const task = {
    id,
    requestId: requestId || id,
    type,
    articleId: articleId || "",
    articleTitle: articleTitle || "未命名",
    status: "pending",
    phase: "queued",
    current: 0,
    total: 0,
    startedAt: Date.now()
  };

  // 并发闸
  const running = countByStatus(type, "running");
  if (running < MAX_PARALLEL_BY_TYPE[type]) {
    task.status = "running";
  }

  tasks.set(id, task);
  schedulePersistAndNotify();
  return { taskId: id, requestId: task.requestId, started: task.status === "running" };
}

export function updateTask(taskId, patch) {
  const task = tasks.get(taskId);
  if (!task) return null;
  Object.assign(task, patch);
  schedulePersistAndNotify();
  return task;
}

/** 通过 requestId 找 task（兼容 SW 内现有 requestId 路由） */
export function findTaskByRequestId(requestId) {
  if (!requestId) return null;
  for (const t of tasks.values()) {
    if (t.requestId === requestId) return t;
  }
  return null;
}

/** 完成 task：标 done/failed/cancelled + 触发 pending 队列 pop */
export function completeTask(taskId, { status, error, result } = {}) {
  const task = tasks.get(taskId);
  if (!task) return null;
  // 终态保护：cancelled 在前，done 在后的场景不让 done 覆盖 cancelled
  // （eg 用户点取消后主流程还跑完了 sendResponse，再来 complete done 应当 no-op）
  if (task.status === "done" || task.status === "failed" || task.status === "cancelled") {
    return task;
  }
  task.status = status || "done";
  task.finishedAt = Date.now();
  if (error !== undefined) task.error = String(error);
  if (result !== undefined) task.result = result;
  controllers.delete(taskId);

  // 修剪 done/failed/cancelled 历史，最多保留 RECENT_DONE_LIMIT 条
  trimDoneTasks();

  // pop pending 队列里 type 匹配的最早一个
  promotePendingTask(task.type);

  schedulePersistAndNotify();
  return task;
}

export function cancelTask(taskId) {
  const task = tasks.get(taskId);
  if (!task) return false;
  if (task.status === "done" || task.status === "failed" || task.status === "cancelled") {
    return false;
  }
  // 触发 abort controller（如果挂了）
  const controller = controllers.get(taskId);
  if (controller) {
    try {
      controller.abort();
    } catch {
      // ignore
    }
  }
  task.status = "cancelled";
  task.finishedAt = Date.now();
  controllers.delete(taskId);
  trimDoneTasks();
  promotePendingTask(task.type);
  schedulePersistAndNotify();
  return true;
}

export function attachAbortController(taskId, controller) {
  if (!tasks.has(taskId)) return;
  controllers.set(taskId, controller);
}

export function getAbortController(taskId) {
  return controllers.get(taskId) || null;
}

/** 序列化输出给前端：只取必要字段，剔除 _internal */
export function getTaskListSnapshot() {
  const running = [];
  const pending = [];
  const done = [];
  for (const t of tasks.values()) {
    const view = pickPublicFields(t);
    if (t.status === "running") running.push(view);
    else if (t.status === "pending") pending.push(view);
    else done.push(view);
  }
  // running / pending 按 startedAt 升序；done 按 finishedAt 降序
  running.sort((a, b) => a.startedAt - b.startedAt);
  pending.sort((a, b) => a.startedAt - b.startedAt);
  done.sort((a, b) => (b.finishedAt || 0) - (a.finishedAt || 0));
  return { running, pending, done };
}

function pickPublicFields(t) {
  return {
    id: t.id,
    requestId: t.requestId,
    type: t.type,
    articleId: t.articleId,
    articleTitle: t.articleTitle,
    status: t.status,
    phase: t.phase,
    current: t.current,
    total: t.total,
    startedAt: t.startedAt,
    finishedAt: t.finishedAt,
    error: t.error,
    cancelReason: t.cancelReason
    // result 不下发到前端 list（可能很大，前端按需另取）
  };
}

/** 前端拉具体 task 的 result（rewrite 返回完整 article doc） */
export function getTaskResult(taskId) {
  const task = tasks.get(taskId);
  return task ? task.result : null;
}

function countByStatus(type, status) {
  let n = 0;
  for (const t of tasks.values()) {
    if (t.type === type && t.status === status) n += 1;
  }
  return n;
}

function trimDoneTasks() {
  const doneList = [];
  for (const t of tasks.values()) {
    if (t.status === "done" || t.status === "failed" || t.status === "cancelled") {
      doneList.push(t);
    }
  }
  doneList.sort((a, b) => (b.finishedAt || 0) - (a.finishedAt || 0));
  for (const old of doneList.slice(RECENT_DONE_LIMIT)) {
    tasks.delete(old.id);
    controllers.delete(old.id);
  }
}

/** running 槽位空出后，把同类型最早的 pending 提为 running。 */
function promotePendingTask(type) {
  const running = countByStatus(type, "running");
  if (running >= MAX_PARALLEL_BY_TYPE[type]) return;
  let earliest = null;
  for (const t of tasks.values()) {
    if (t.type === type && t.status === "pending") {
      if (!earliest || t.startedAt < earliest.startedAt) earliest = t;
    }
  }
  if (earliest) {
    earliest.status = "running";
    earliest.phase = "starting";
  }
}

// ---------------------------------------------------------------------
// 持久化 + 广播
// ---------------------------------------------------------------------

function schedulePersistAndNotify() {
  if (!persistTimer) {
    persistTimer = setTimeout(() => {
      persistTimer = null;
      void persistNow();
    }, PERSIST_DEBOUNCE_MS);
  }
  if (!notifyTimer) {
    notifyTimer = setTimeout(() => {
      notifyTimer = null;
      notifyChanged();
    }, 0);
  }
}

async function persistNow() {
  const serializable = [];
  for (const t of tasks.values()) {
    serializable.push({
      ...t,
      // result 体积可能很大（完整 article doc），持久化裁剪到必要字段
      result: t.result ? safeSummarizeResult(t.result) : undefined
    });
  }
  try {
    await chrome.storage.session.set({ [STORAGE_KEY]: serializable });
  } catch {
    // session storage 可能未启用（极旧 chrome），降级到内存即可
  }
}

function safeSummarizeResult(result) {
  // 防止 result 里有循环引用 / DOM 节点造成 set 失败；只保留 plain object 字段
  try {
    return JSON.parse(JSON.stringify(result));
  } catch {
    return null;
  }
}

function notifyChanged() {
  try {
    chrome.runtime
      .sendMessage({ type: "TASK_LIST_CHANGED", payload: getTaskListSnapshot() })
      .catch(() => {});
  } catch {
    // 老版本 chrome 无监听者直接 throw，吞掉
  }
}

/** SW 启动时调：从 storage.session 恢复 + 清理 stale。 */
export async function restoreAndCleanStale() {
  try {
    const stored = await chrome.storage.session.get(STORAGE_KEY);
    const list = stored?.[STORAGE_KEY];
    if (Array.isArray(list)) {
      const now = Date.now();
      for (const t of list) {
        if (!t || !t.id) continue;
        // running 但启动时间太久 → 当 stale，标记 failed（SW 重启了，老 task 不会再续跑）
        if (
          t.status === "running" &&
          typeof t.startedAt === "number" &&
          now - t.startedAt > STALE_RUNNING_MS
        ) {
          t.status = "failed";
          t.finishedAt = now;
          t.error = "service worker 重启，任务被中断";
        } else if (t.status === "running" || t.status === "pending") {
          // 即使没超 stale 阈值，SW 重启后老 task 也无 controller 续跑了
          t.status = "failed";
          t.finishedAt = now;
          t.error = "service worker 重启，任务被中断";
        }
        tasks.set(t.id, t);
      }
      trimDoneTasks();
    }
  } catch {
    // ignore
  }
}

// ---------------------------------------------------------------------
// CANCEL_TASK 反向兼容 SKIP_HUMANIZE_PASS
// ---------------------------------------------------------------------

/**
 * 兼容老 requestId 直接调用：找到 requestId 对应的 task，触发 cancel。
 * 用于把现有 SKIP_HUMANIZE_PASS handler 桥接进 task-registry。
 */
export function cancelByRequestId(requestId) {
  const task = findTaskByRequestId(requestId);
  if (!task) return false;
  return cancelTask(task.id);
}

/**
 * 取消同 articleId + 同 type 的所有 running/pending task。
 *
 * 与 33rd session 删掉的 rewrite-rewrite dedup 不同——这里不是"自动取消用户连点的同种任务"，
 * 而是**跨类型联动**：用户抓取新内容 = 该 article 的老 rewrite 任务必然产出废弃数据
 * （rewrite 用的是抓前的 source 副本，跑完后 apply 会覆盖用户刚抓的新内容）。
 *
 * 调用点：service-worker.js SCRAPE_LAST_SOURCE_TAB handler 在 register 新 capture task
 * 之后立即调 `cancelRunningTasksForArticle(articleId, "rewrite")`。
 *
 * 取消时给每个被 cancel 的 task 写一个 cancelReason，前端 task-center 读到这个
 * reason 后能给用户显示"为什么被取消"的归因 toast。
 *
 * 返回被取消的 task 数。
 */
export function cancelRunningTasksForArticle(articleId, type, cancelReason) {
  if (!articleId) return 0;
  const targets = [];
  for (const t of tasks.values()) {
    if (
      (t.status === "running" || t.status === "pending") &&
      t.type === type &&
      t.articleId === articleId
    ) {
      targets.push(t.id);
    }
  }
  for (const id of targets) {
    if (cancelReason) {
      const t = tasks.get(id);
      if (t) t.cancelReason = cancelReason;
    }
    cancelTask(id);
  }
  return targets.length;
}
