/**
 * 润笔 mp 浮球 React 端类型定义
 *
 * 三种类型源：
 *   1. **SW 消息协议**（与 src/background/service-worker.js 保持同步）
 *   2. **vanilla helper bridge**（window.__runbi_mp_helper，由 wechat-editor-helper.js 暴露）
 *   3. **域内 model**（DraftItem / ProfileInfo / FloatingBallState 等业务类型）
 *
 * 修改 SW 协议或 helper bridge 字段时记得**两边同步**。
 */

// ── SW 消息协议（与 src/background/service-worker.js 对齐）──────────────

export type FloatingBallPosition = { x: number; y: number };

/** GET_FLOATING_BALL_STATE 返回 data 形态 */
export type FloatingBallStateResponse = {
  enabled: boolean;
  position: FloatingBallPosition | null;
};

/** PULL_DRAFT_TO_MP_EDITOR payload */
export type PullDraftPayload = {
  /** 多草稿场景下的目标稿件 id；缺省则 SW 默认拉「当前激活」 */
  articleId?: string;
};

/** OPEN_EXTENSION_PAGE payload —— 仅接受 SW 白名单内的相对路径 */
export type OpenExtensionPagePayload = {
  path:
    | "src/workspace/workspace.html"
    | "src/options/options.html"
    | "src/pages/hot-topics.html"
    | "src/pages/help.html"
    | "src/popup/popup.html";
};

export type SaveFloatingBallPositionPayload = FloatingBallPosition;

export type DisableFloatingBallPayload = void;

export type GetFloatingBallStatePayload = void;

/** 跨模块消息总表，sendMessage / onMessage 用 keyof 约束类型 */
export type MessageMap = {
  GET_FLOATING_BALL_STATE: GetFloatingBallStatePayload;
  PULL_DRAFT_TO_MP_EDITOR: PullDraftPayload;
  OPEN_EXTENSION_PAGE: OpenExtensionPagePayload;
  DISABLE_FLOATING_BALL: DisableFloatingBallPayload;
  SAVE_FLOATING_BALL_POSITION: SaveFloatingBallPositionPayload;
};

/** 各消息的回复形态 */
export type MessageReply = {
  GET_FLOATING_BALL_STATE: { ok: true; data: FloatingBallStateResponse } | { ok: false; error: string };
  PULL_DRAFT_TO_MP_EDITOR:
    | { ok: true; payload?: PullSuccessPayload }
    | { ok: false; error: string; errorCode?: string };
  OPEN_EXTENSION_PAGE: { ok: true } | { ok: false; error: string };
  DISABLE_FLOATING_BALL: { ok: true };
  SAVE_FLOATING_BALL_POSITION: { ok: true };
};

/** PULL 成功后 SW 推送给 mp tab 的 payload（关键业务字段） */
export type PullSuccessPayload = {
  drafts?: DraftItem[];
  profile?: ProfileInfo;
  // 其他字段（title / contentHtml / cover / digest / 等）由 vanilla helper 的
  // IMPORT_ARTICLE_TO_WECHAT_EDITOR 监听处理，React 端不直接消费
  [key: string]: unknown;
};

// ── 域内业务类型 ────────────────────────────────────────────────────

export type DraftItem = {
  id: string;
  title: string;
  /** 仅多草稿 picker 用：第几篇 / 总几篇 */
  index?: number;
  total?: number;
};

export type ProfileInfo = {
  /** 草稿绑定的目标公众号名（用于和 mp 后台导航栏的当前账号名做模糊匹配） */
  targetProfileName?: string;
  targetProfileIndex?: number;
};

/** 1 号球（拉草稿）状态点三态：绿=匹配 / 橙=不匹配 / 灰=未关联或读不到 */
export type ProfileMatchState = "match" | "mismatch" | "unknown";

/** dock 状态反馈面板 result（vanilla helper renderHelperDock 入参） */
export type HelperResult = {
  ok: boolean;
  title?: string;
  message?: string;
  detail?: string;
  level?: "info" | "success" | "warning" | "error";
};

// ── window.__runbi_mp_helper bridge（由 vanilla helper IIFE 末尾挂） ─

declare global {
  interface Window {
    __runbi_mp_helper?: Readonly<{
      /** 启发式读取 mp 后台导航栏当前账号名，读不到返回 "" */
      readCurrentMpAccountName: () => string;
      /** 当前页是不是真的 mp 编辑页（不是列表页/数据页） */
      isEditorPage: () => boolean;
      /** 拉草稿后/出错时的状态反馈 dock；result 形态见 HelperResult */
      renderHelperDock: (result: HelperResult) => void;
    }>;
  }
}

// 让此文件被认为是 module（declare global 必须写在 module 里）
export {};
