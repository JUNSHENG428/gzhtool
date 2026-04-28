"""Runbi Helper 界面主题常量（Tk/ttk）。

与浏览器扩展 `src/pages/design-tokens.css` 气质对齐：暖纸底、墨绿系正文、琥珀点缀；
不引入 CSS/WebView，仅 hex + 字体族名，供 gui.py 单一引用。

Tk 不支持 CSS 式字体 fallback 列表，故正文/标题按平台选用常见系统字体；
等宽日志区按平台选用 Menlo / Consolas / DejaVu Sans Mono。
"""

from __future__ import annotations

import sys
from typing import Tuple

# —— 文本与表面（对齐 design-tokens --ink / --soft-ink / --muted / --cream）——
TEXT_PRIMARY = "#1a2620"
TEXT_SECONDARY = "#3d4f45"
TEXT_MUTED = "#5a6b62"
TEXT_HINT = "#6b7280"

BG_WINDOW = "#f7f5ef"
BG_LOG = "#fffdf8"
BG_CANVAS = BG_WINDOW

# —— 语义状态（与既有 gui 行为一致：灰/黄/绿/红）——
STATUS_IDLE = "#9ca3af"
STATUS_BUSY = "#fbbf24"
STATUS_OK = "#10b981"
STATUS_ERR = "#ef4444"

# —— 间距（与 8px 栅格一致）——
PAD_OUTER = {"padx": 12, "pady": 8}
PAD_COMPACT = {"padx": 8, "pady": 6}


def ui_heading_font() -> Tuple[str, int, str]:
    """状态行主标题：粗体。"""
    fam = _ui_family()
    return (fam, 13, "bold")


def ui_body_font() -> Tuple[str, int]:
    """常规标签。"""
    return (_ui_family(), 10)


def log_mono_font() -> Tuple[str, int]:
    """运行日志等宽区（跨平台首选项）。"""
    if sys.platform == "darwin":
        return ("Menlo", 10)
    if sys.platform == "win32":
        return ("Consolas", 10)
    return ("DejaVu Sans Mono", 10)


def _ui_family() -> str:
    if sys.platform == "darwin":
        return "PingFang SC"
    if sys.platform == "win32":
        return "Segoe UI"
    return "DejaVu Sans"


def labelframe_label_font() -> Tuple[str, int, str]:
    """分组标题略强调。"""
    fam = _ui_family()
    return (fam, 10, "bold")


def apply_ttk_style(root) -> object:
    """配置跨平台相对一致的 ttk（clam）间距与分组样式；返回 `ttk.Style`。

    避免全局改 `TLabel`/`TFrame` 底色，以免分组框内外标签与父容器不一致；
    正文颜色在 gui 里对单独控件传 `foreground=`。
    """
    from tkinter import ttk

    style = ttk.Style(root)
    try:
        style.theme_use("clam")
    except Exception:
        pass

    lf_pad = (10, 8, 10, 12)
    style.configure(
        "TLabelframe",
        background=BG_LOG,
        relief="solid",
        borderwidth=1,
        padding=lf_pad,
    )
    style.configure("TLabelframe.Label", background=BG_LOG, foreground=TEXT_SECONDARY)
    try:
        style.configure("TLabelframe.Label", font=labelframe_label_font())
    except Exception:
        pass

    style.configure("TButton", padding=(10, 6))
    style.configure("TCheckbutton", background=BG_LOG, foreground=TEXT_PRIMARY)
    style.map(
        "TCheckbutton",
        background=[("active", BG_LOG), ("!disabled", BG_LOG)],
    )

    try:
        style.configure("TEntry", fieldbackground="#ffffff", foreground=TEXT_PRIMARY)
    except Exception:
        pass

    return style
