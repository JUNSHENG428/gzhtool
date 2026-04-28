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
const MP_EDITOR_PATH_RE = /\/cgi-bin\/appmsg/i;

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

  // 已经停在编辑页的 tab 优先复用，避免覆盖用户已经手填的字段
  let tab =
    tabs.find((item) => MP_EDITOR_PATH_RE.test(item.url || "")) ||
    tabs.find((item) => /mp\.weixin\.qq\.com/i.test(item.url || "")) ||
    null;

  if (tab?.id) {
    if (!MP_EDITOR_PATH_RE.test(tab.url || "")) {
      await chrome.tabs.update(tab.id, { active: true, url: WECHAT_WEB_EDITOR_URL });
    } else {
      await chrome.tabs.update(tab.id, { active: true });
    }
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

function browserError(code, detail) {
  const err = new Error(detail || code);
  err.browserModeCode = code;
  return err;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
