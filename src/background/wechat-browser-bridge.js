/**
 * 浏览器登录模式发布通道（mode === "browser"）。
 *
 * 与 cgi-bin/draft/add 的 API 模式不同，这里不调任何官方 API、不需要
 * appId/AppSecret、不需要 IP 白名单。流程：
 *   1. 找一个已经在 mp 后台编辑页的 tab（如果没有就新开一个）
 *   2. 等 tab status === "complete"（最长 10s）
 *   3. 通过 chrome.tabs.sendMessage 把第一篇文章的 meta+html 发到
 *      wechat-editor-helper.js（内容脚本，已存在）；helper 在 DOM 上
 *      把标题/摘要/作者/原文链接/正文 HTML 写进编辑器
 *   4. 用户在 mp 后台手动点「保存草稿」（合规底线，不自动点）
 *
 * Phase A 限制：
 *   - 多图文：仅同步第一篇，meta.requiresMultiArticleManual 透给 UI
 *   - 封面图：不自动上传（DataTransfer 模拟拖拽放在 Phase B）
 *   - 群发：不支持（API 模式独享）
 *
 * 错误处理：throw 出来的 Error 会被 service-worker 全局 catch + classifyError
 * 转成结构化对象。这里抛 Error 时挂 .browserModeCode，errors.js classifyError
 * 优先读 flag 直接走专属分支，避免被通用规则（如 SCRAPE_TAB_FAILED）误判。
 */

import { ErrorCode } from "../shared/errors.js";
import { WECHAT_WEB_EDITOR_URL } from "../shared/defaults.js";

const TAB_LOAD_TIMEOUT_MS = 10000;
const TAB_POLL_INTERVAL_MS = 300;
const MP_LOGIN_PATH_RE = /\/mp\.weixin\.qq\.com\/(?:cgi-bin\/loginpage|safe\/safeqrconnect|cgi-bin\/bizlogin)/i;
// 必须命中"真正在写图文"的 URL；列表 / 设置 / 数据中心 / 草稿箱列表也含 /cgi-bin/appmsg，
// 但 query 是 action=list 之类，不能误判成编辑页（否则 helper 会把标题写进列表搜索框）。
// 编辑器 URL 形如 .../cgi-bin/appmsg?t=media/appmsg_edit_v2&action=edit&...
//        或      .../cgi-bin/appmsg?...&action=add&...
const MP_EDITOR_PATH_RE = /\/cgi-bin\/appmsg.*?(?:action=(?:edit|add)|t=media\/appmsg_edit)/i;

/**
 * 把 article bundle 通过浏览器登录模式发布到 mp 编辑页。
 *
 * @param {object} payload    - 与 PUBLISH_TO_WECHAT API 模式同一个 payload
 * @param {object} ctx        - { profileLabel: string }
 * @returns {Promise<{
 *   tabId: number,
 *   mode: "browser",
 *   message: string,
 *   fields: { titleWritten: boolean, digestWritten: boolean, authorWritten: boolean, sourceUrlWritten: boolean, bodyWritten: boolean },
 *   requiresMultiArticleManual?: boolean
 * }>}
 */
export async function publishViaBrowser(payload, ctx = {}) {
  const articles = Array.isArray(payload?.articles) ? payload.articles : [];
  if (articles.length === 0) {
    throw browserError(
      ErrorCode.WECHAT_BROWSER_INJECT_FAILED,
      "没有可同步的文章。"
    );
  }

  const first = articles[0];
  if (!first?.meta?.title || !first?.html) {
    throw browserError(
      ErrorCode.WECHAT_BROWSER_INJECT_FAILED,
      "第一篇文章缺少标题或正文。"
    );
  }

  const tab = await openOrFocusEditorTab();
  await waitForEditorReady(tab.id);

  // 写入前账号比对（防串号）：PULL 侧早有 profile 状态点 + disabled 拦截，
  // Push 侧此前直接找到编辑页就写——mp 登着账号 B 而草稿目标是账号 A 时会写错号。
  await assertMpAccountMatches(tab.id, payload);

  const helperPayload = {
    meta: {
      title: String(first.meta.title || ""),
      digest: String(first.meta.digest || ""),
      author: String(first.meta.author || ""),
      contentSourceUrl: String(first.meta.contentSourceUrl || ""),
      // 让 wechat-editor-helper 在 dock 文案里区分「浏览器登录模式」和「同步到网页编辑器」两个入口
      publishMode: "browser",
      profileLabel: String(ctx.profileLabel || "")
    },
    html: String(first.html || "")
  };

  const response = await chrome.tabs
    .sendMessage(tab.id, {
      type: "IMPORT_ARTICLE_TO_WECHAT_EDITOR",
      payload: helperPayload
    })
    .catch((error) => ({
      ok: false,
      error: error?.message || "公众号编辑页没有响应。"
    }));

  if (!response?.ok) {
    throw browserError(
      ErrorCode.WECHAT_BROWSER_INJECT_FAILED,
      response?.error || "公众号编辑页没有响应（content script 可能尚未注入）。"
    );
  }

  if (!response.titleWritten && !response.bodyWritten) {
    throw browserError(
      ErrorCode.WECHAT_BROWSER_INJECT_FAILED,
      "标题和正文都没有写入成功，可能是编辑页选择器失效。"
    );
  }

  return {
    tabId: tab.id,
    mode: "browser",
    message: response.message || "已写入公众号编辑页，请在 mp 后台手动点「保存草稿」。",
    fields: {
      titleWritten: Boolean(response.titleWritten),
      digestWritten: Boolean(response.digestWritten),
      authorWritten: Boolean(response.authorWritten),
      sourceUrlWritten: Boolean(response.sourceUrlWritten),
      bodyWritten: Boolean(response.bodyWritten)
    },
    requiresMultiArticleManual: articles.length > 1
  };
}

async function openOrFocusEditorTab() {
  const tabs = await chrome.tabs
    .query({ url: ["https://mp.weixin.qq.com/*"] })
    .catch(() => []);

  // 优先复用已经停在**真正编辑页**的 tab（MP_EDITOR_PATH_RE 现在精确到 action=edit/add）。
  // 找不到时**直接新开**一个编辑页 tab，**不再**强行 navigate 用户其他 mp tab
  // （草稿箱列表 / 数据中心 / 设置等）—— 那种 navigate 会丢失用户在那 tab 上的工作，
  // 而且如果 fallback 抢的 tab navigate 还没完成就跑 content script，会把标题
  // 写进列表页搜索框（用户报告的具体症状）。
  let tab = tabs.find((item) => MP_EDITOR_PATH_RE.test(item.url || "")) || null;

  if (tab?.id) {
    await chrome.tabs.update(tab.id, { active: true });
  } else {
    tab = await chrome.tabs.create({ url: WECHAT_WEB_EDITOR_URL, active: true });
  }

  if (tab?.windowId) {
    await chrome.windows.update(tab.windowId, { focused: true }).catch(() => {});
  }

  return tab;
}

async function waitForEditorReady(tabId) {
  const startedAt = Date.now();

  while (Date.now() - startedAt < TAB_LOAD_TIMEOUT_MS) {
    const tab = await chrome.tabs.get(tabId).catch(() => null);
    if (!tab) {
      throw browserError(
        ErrorCode.WECHAT_BROWSER_EDITOR_NOT_OPEN,
        "公众号编辑页 tab 已关闭。"
      );
    }

    // 登录态丢失时 mp 后台会把请求 302 到登录页 — 提前识别比让用户对着空白等 10s 体感好
    if (MP_LOGIN_PATH_RE.test(tab.url || "")) {
      throw browserError(
        ErrorCode.WECHAT_BROWSER_NOT_LOGGED_IN,
        "公众号要求登录后才能访问编辑页。"
      );
    }

    if (tab.status === "complete" && MP_EDITOR_PATH_RE.test(tab.url || "")) {
      // 给前端 JS 多 400ms 把 contenteditable 渲染出来，否则 sendMessage 后选择器命中失败
      await sleep(400);
      return tab;
    }

    await sleep(TAB_POLL_INTERVAL_MS);
  }

  // 超时：再读一次 url，把登录页 / 非编辑页两种情况各自抛专属错误
  const lastTab = await chrome.tabs.get(tabId).catch(() => null);
  if (lastTab && MP_LOGIN_PATH_RE.test(lastTab.url || "")) {
    throw browserError(
      ErrorCode.WECHAT_BROWSER_NOT_LOGGED_IN,
      "公众号要求登录后才能访问编辑页。"
    );
  }
  throw browserError(
    ErrorCode.WECHAT_BROWSER_EDITOR_NOT_OPEN,
    "公众号编辑页 10 秒内仍未加载完成。"
  );
}

/**
 * 写入前比对 mp 后台当前登录账号与草稿目标账号。
 *
 * 比对语义与浮球 PULL 侧完全一致（wechat-editor-helper.js renderHelperDock）：
 *   - 模糊匹配：全等或互相 includes（profile 名可能写「主号」，mp 显示「主号-认证」）
 *   - fail-open：payload.accountName 为空（未命名 profile / 默认账号，无比对基准）、
 *     content script 没响应、或 mp 页面读不到账号名时一律放行——
 *     宁可漏拦不可误拦，和 PULL 侧「没读到 mp 账号 = 放行」保持同一原则。
 * 只有「两边都读到了且确实对不上」才抛 ACCOUNT_MISMATCH 中止写入。
 */
async function assertMpAccountMatches(tabId, payload) {
  const expected = String(payload?.accountName || "").trim();
  if (!expected) return;

  const probe = await chrome.tabs
    .sendMessage(tabId, { type: "READ_MP_ACCOUNT_NAME" })
    .catch(() => null);
  const mpAccount = String(probe?.account || "").replace(/\s+/g, " ").trim();
  if (!mpAccount) return;

  const matches =
    expected === mpAccount ||
    expected.includes(mpAccount) ||
    mpAccount.includes(expected);
  if (!matches) {
    throw browserError(
      ErrorCode.WECHAT_BROWSER_ACCOUNT_MISMATCH,
      `mp 后台当前登录的是「${mpAccount}」，但这篇文章的发布账号是「${expected}」。` +
        "为防止内容写进错误的公众号，已中止同步。" +
        `请在 mp 后台切换到「${expected}」再重试，或回编辑台把「发布账号」改成「${mpAccount}」。`
    );
  }
}

function browserError(code, detail) {
  const err = new Error(detail || code);
  err.browserModeCode = code;
  return err;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
