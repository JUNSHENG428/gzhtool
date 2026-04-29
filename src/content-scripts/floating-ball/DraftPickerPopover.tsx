/**
 * 多草稿场景下的 picker 浮层
 *
 * 触发：1 号球（拉草稿）click 时，如果 STATE.payload.drafts.length > 1，
 * 弹在 strip 左侧让用户选哪一篇。比"展开 dock 内 select"体验流畅
 * （不必先 hover 主球展开 dock）。
 *
 * 视觉规范：
 *   - 锚定在 wrapperRect.left - popoverWidth - 8px（左偏出 strip）
 *   - 顶部对齐 wrapperRect.top
 *   - 暖米底 + 项目阴影 + 12px 圆角
 *   - hover 行高亮（cream → cream-muted）
 *
 * 关闭：选完一项 / Esc / 任意点击外部
 */
import { useEffect } from "react";
import { tokens } from "./lib/tokens";
import type { DraftItem } from "./types";

const POPOVER_WIDTH = 240;
const ROW_PADDING = "10px 12px";

type Props = {
  drafts: DraftItem[];
  /** strip wrapper 的 getBoundingClientRect，决定 popover 浮在哪里 */
  anchorRect: DOMRect;
  onPick: (articleId: string) => void;
  onClose: () => void;
};

export function DraftPickerPopover(props: Props) {
  // Esc 关闭
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") props.onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [props]);

  // 点击外部关闭（延一帧挂避免触发当次点击）
  useEffect(() => {
    const onClick = (e: MouseEvent) => {
      const t = e.target as HTMLElement | null;
      if (t?.closest?.(".__runbi-draft-popover")) return;
      props.onClose();
    };
    const t = window.setTimeout(
      () => document.addEventListener("mousedown", onClick, { once: true }),
      0
    );
    return () => {
      window.clearTimeout(t);
      document.removeEventListener("mousedown", onClick);
    };
  }, [props]);

  const left = Math.max(
    8,
    Math.min(
      window.innerWidth - POPOVER_WIDTH - 8,
      props.anchorRect.left - POPOVER_WIDTH - 8
    )
  );
  const top = Math.max(8, Math.min(window.innerHeight - 320, props.anchorRect.top));

  return (
    <div
      className="__runbi-draft-popover"
      style={{
        position: "fixed",
        left: `${left}px`,
        top: `${top}px`,
        zIndex: 2147483647,
        width: `${POPOVER_WIDTH}px`,
        maxHeight: "320px",
        overflow: "auto",
        padding: "6px",
        background: tokens.surfaceElevated,
        border: `1px solid ${tokens.line}`,
        borderRadius: "12px",
        boxShadow: tokens.shadowLg,
        fontFamily: tokens.fontSans,
        fontSize: "13px"
      }}
    >
      <div
        style={{
          padding: "8px 12px 6px",
          color: tokens.softInk,
          fontSize: "11px",
          letterSpacing: "0.04em",
          textTransform: "uppercase"
        }}
      >
        选择要拉的草稿（{props.drafts.length}）
      </div>
      {props.drafts.map((draft) => (
        <button
          key={draft.id}
          type="button"
          onClick={() => props.onPick(draft.id)}
          style={{
            display: "block",
            width: "100%",
            textAlign: "left",
            padding: ROW_PADDING,
            background: "transparent",
            border: 0,
            borderRadius: "8px",
            color: tokens.ink,
            cursor: "pointer",
            fontFamily: "inherit",
            fontSize: "inherit"
          }}
          onMouseEnter={(e) => (e.currentTarget.style.background = tokens.cream)}
          onMouseLeave={(e) => (e.currentTarget.style.background = "transparent")}
        >
          <div
            style={{
              fontWeight: 500,
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap"
            }}
          >
            {draft.title || "未命名草稿"}
          </div>
          {(draft.index != null || draft.total != null) && (
            <div
              style={{
                color: tokens.softInk,
                fontSize: "11px",
                marginTop: "2px"
              }}
            >
              第 {draft.index} / {draft.total} 篇
            </div>
          )}
        </button>
      ))}
    </div>
  );
}
