/**
 * 浮球右键菜单（自渲染浮层，不用 chrome.contextMenus）
 *
 * 项目里 4 项默认菜单（FloatingBall.tsx 提供）：
 *   - 贴边隐藏 / 取消贴边
 *   - 永久隐藏浮球
 *   - 重置位置
 *   - 打开润笔工作台
 *
 * 关闭：菜单项 click（先执行 onClick 再 onClose）/ 外部点击 / Esc。
 */
import { useEffect } from "react";
import { tokens } from "./lib/tokens";

type Item = {
  label: string;
  hint?: string;
  onClick: () => void | Promise<void>;
};

type Props = {
  x: number;
  y: number;
  items: Item[];
  onClose: () => void;
};

export function ContextMenu(props: Props) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") props.onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [props]);

  return (
    <div
      className="__runbi-context-menu"
      style={{
        position: "fixed",
        left: `${Math.min(props.x, window.innerWidth - 220)}px`,
        top: `${Math.min(props.y, window.innerHeight - 200)}px`,
        zIndex: 2147483647,
        minWidth: "200px",
        padding: "6px",
        background: tokens.surfaceElevated,
        border: `1px solid ${tokens.line}`,
        borderRadius: "12px",
        boxShadow: tokens.shadowLg,
        fontFamily: tokens.fontSans,
        fontSize: "13px"
      }}
      onClick={(e) => e.stopPropagation()}
    >
      {props.items.map((item) => (
        <button
          key={item.label}
          type="button"
          onClick={async () => {
            await item.onClick();
            props.onClose();
          }}
          style={{
            display: "block",
            width: "100%",
            textAlign: "left",
            padding: "8px 10px",
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
          <div style={{ fontWeight: 500 }}>{item.label}</div>
          {item.hint && (
            <div
              style={{
                color: tokens.softInk,
                fontSize: "11px",
                marginTop: "2px"
              }}
            >
              {item.hint}
            </div>
          )}
        </button>
      ))}
    </div>
  );
}
