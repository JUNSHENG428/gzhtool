/** 浏览器导入的单一入口。待确认稿件按 tab 持久化，页面就绪后续接；不代点保存或发布。 */
import { ErrorCode } from "../shared/errors.js";

const PREFIX = "runbiWechatImport:";
const RECEIPT_PREFIX = "runbiWechatReceipt:";
const MAX_AGE = 60 * 60 * 1000;
const tabQueues = new Map();

export function isWechatEditorUrl(value) {
  try {
    const url = new URL(value);
    return url.origin === "https://mp.weixin.qq.com" && url.pathname === "/cgi-bin/appmsg" &&
      (["edit", "add"].includes(url.searchParams.get("action")) || /^media\/appmsg_edit(?:_v\d+)?$/.test(url.searchParams.get("t") || ""));
  } catch { return false; }
}

export function newWechatEditorUrl(fromUrl = "") {
  const url = new URL("https://mp.weixin.qq.com/cgi-bin/appmsg");
  url.search = "?t=media/appmsg_edit_v2&action=edit&type=77&isNew=1&lang=zh_CN";
  try {
    const from = new URL(fromUrl);
    const token = from.searchParams.get("token");
    if (from.origin === url.origin && /^\d+$/.test(token || "")) url.searchParams.set("token", token);
  } catch {}
  return url.href;
}

async function chooseTab({ preferredTabId, forceNew = false } = {}) {
  const tabs = await chrome.tabs.query({ url: ["https://mp.weixin.qq.com/*"] });
  const preferred = tabs.find(t => t.id === preferredTabId);
  const editor = !forceNew && (isWechatEditorUrl(preferred?.url) ? preferred :
    [...tabs].sort((a,b) => (b.lastAccessed || 0) - (a.lastAccessed || 0)).find(t => isWechatEditorUrl(t.url)));
  const tab = editor
    ? await chrome.tabs.update(editor.id, { active: true })
    : await chrome.tabs.create({ url: newWechatEditorUrl(preferred?.url || tabs[0]?.url), active: true });
  if (tab.windowId) await chrome.windows.update(tab.windowId, { focused: true }).catch(() => {});
  return tab;
}

function serializeTab(tabId, action) {
  const prior = tabQueues.get(tabId) || Promise.resolve();
  const next = prior.catch(() => {}).then(action);
  tabQueues.set(tabId, next);
  return next.finally(() => { if (tabQueues.get(tabId) === next) tabQueues.delete(tabId); });
}

async function pendingFor(tabId) {
  const key = PREFIX + tabId;
  const record = (await chrome.storage.local.get(key))[key];
  if (!record) return null;
  if (Date.now() - record.createdAt > MAX_AGE) {
    await chrome.storage.local.remove(key);
    return null;
  }
  return record;
}

async function deliver(tabId, record) {
  const payload = { ...record.payload, transferId: record.transferId, destinationTabId: tabId };
  const response = await chrome.tabs.sendMessage(tabId, { type: "IMPORT_ARTICLE_TO_WECHAT_EDITOR", payload }).catch(() => null);
  if (response?.ok === false) throw new Error(response.error || "公众号导入准备失败。");
  return {
    tabId, transferId: record.transferId, articleTitle: payload.meta.title,
    articleId: payload.selectedArticleId || payload.bundle?.articleId || "",
    status: response?.status || "awaiting-editor", bodyWritten: false,
    message: response?.message || "稿件已准备好。请登录公众号并打开新建图文，随后确认导入。",
    ...response
  };
}

function sameImport(a, b) {
  // Chrome storage 可能改变属性顺序；比较语义内容，忽略仅用于展示的发送时间。
  const canonical = value => {
    if (Array.isArray(value)) return value.map(canonical);
    if (value && typeof value === "object") return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])]));
    return value;
  };
  const stable = value => canonical({ ...value, bundle: value.bundle ? { ...value.bundle, syncedAt: 0 } : undefined });
  return JSON.stringify(stable(a)) === JSON.stringify(stable(b));
}

export async function stageWechatImport(payload, options = {}) {
  if (!String(payload?.meta?.title || "").trim() || !String(payload?.html || "").trim()) {
    const error = new Error("请先填写稿件标题和正文，再送到公众号。");
    error.browserModeCode = ErrorCode.WECHAT_BROWSER_INJECT_FAILED;
    throw error;
  }
  const tab = await chooseTab(options);
  return serializeTab(tab.id, async () => {
    const pending = await pendingFor(tab.id);
    if (pending) {
      if (sameImport(pending.payload, payload)) return deliver(tab.id, pending);
      throw new Error("公众号页面已有一篇待确认稿件，请先导入或取消，再选择另一篇。");
    }
    const record = { payload, transferId: crypto.randomUUID(), createdAt: Date.now() };
    await chrome.storage.local.set({ [PREFIX + tab.id]: record });
    return deliver(tab.id, record);
  });
}

export async function resumeWechatImport(tabId) {
  return serializeTab(tabId, async () => {
    const record = await pendingFor(tabId);
    return record ? deliver(tabId, record) : null;
  });
}

export async function moveWechatImportToNewTab(tabId, transferId) {
  return serializeTab(tabId, async () => {
    const record = await pendingFor(tabId);
    if (!record || record.transferId !== transferId) throw new Error("待导入稿件已失效，请重新选择。");
    const result = await stageWechatImport(record.payload, { preferredTabId: tabId, forceNew: true });
    await chrome.storage.local.remove(PREFIX + tabId);
    return result;
  });
}

export async function recordWechatImportResult(tabId, result) {
  return serializeTab(tabId, async () => {
    const record = await pendingFor(tabId);
    const receiptKey = RECEIPT_PREFIX + tabId;
    const previous = (await chrome.storage.local.get(receiptKey))[receiptKey];
    if (result?.transferId !== (record?.transferId || previous?.transferId)) return null;
    const allowed = ["written", "partial", "cancelled", "save-unconfirmed", "saved", "restored", "unsaved"];
    if (!allowed.includes(result.status)) return null;
    const data = {
      ...result, tabId, syncedAt: new Date().toISOString(),
      articleTitle: record?.payload?.meta?.title || previous?.articleTitle || "",
      articleId: record?.payload?.selectedArticleId || record?.payload?.bundle?.articleId || previous?.articleId || ""
    };
    await chrome.storage.local.set({ [receiptKey]: data });
    if (record) await chrome.storage.local.remove(PREFIX + tabId);
    return data;
  });
}

export async function publishViaBrowser(payload, ctx = {}) {
  const articles = Array.isArray(payload?.articles) ? payload.articles : [];
  if (articles.length !== 1) throw new Error("浏览器导入一次处理一篇。请在工作台选择当前篇，送到公众号后再添加下一篇。");
  const first = articles[0];
  const result = await stageWechatImport({
    meta: { ...first.meta, publishMode: "browser" }, html: first.html,
    profile: { targetProfileName: payload.accountName || ctx.profileLabel || "" }
  });
  return { ...result, mode: "browser" };
}
