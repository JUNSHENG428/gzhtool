/**
 * 润笔 mp 浮球 · type-safe sendMessage 包装
 *
 * 仅做单向 send（content script → SW），不挂 onMessage listener
 * （vanilla helper 已经挂 IMPORT_ARTICLE_TO_WECHAT_EDITOR 监听，那条是业务回流，
 * 不在 React 端的关注点内）。
 *
 * 关键：从 content script click 触发的 sendMessage **保留** user gesture
 * activation 约 5s，让 SW 端 await chrome.tabs.create / chrome.sidePanel.open
 * 等需要 user gesture 的 API 还能用。
 */
import type { MessageMap, MessageReply } from "../types";

type Envelope<K extends keyof MessageMap = keyof MessageMap> = {
  type: K;
  payload: MessageMap[K];
};

/**
 * content → background 发消息。
 * @returns SW 端 sendResponse 的内容；如 SW 不可达（首次加载偶发）会 reject。
 */
export function sendMessage<K extends keyof MessageMap>(
  type: K,
  payload: MessageMap[K]
): Promise<MessageReply[K]> {
  return chrome.runtime.sendMessage({ type, payload } satisfies Envelope<K>);
}
