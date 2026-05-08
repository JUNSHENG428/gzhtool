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

# —— 品牌色（与 design-tokens --brand / --brand-hover / --on-brand-warm 对齐）——
# 用于 Primary.TButton 突出主操作（启动 helper），副操作仍用默认 ttk.TButton
BRAND = "#173722"
BRAND_HOVER = "#1f4a2e"
ON_BRAND = "#f0d4b0"

# —— 语义状态（39th 续³ Batch 11：与扩展端 design-tokens.css --state-* 完全对齐）——
# 之前用 #fbbf24/#10b981/#ef4444 是 Tailwind 默认色，与扩展视觉脱节；
# 改用项目调色板让 desktop / 扩展 / 网站三端状态色统一感成立。
STATUS_IDLE = "#9ca3af"
STATUS_BUSY = "#b87514"  # design-tokens --state-warning
STATUS_OK = "#2e7d4f"    # design-tokens --state-success
STATUS_ERR = "#b94540"   # design-tokens --state-danger

# —— 日志 tag 配色（39th 续³ Batch 11：日志窗 INFO/WARN/ERROR 不同色让运维一眼锁定问题）——
LOG_INFO = TEXT_PRIMARY
LOG_WARN = STATUS_BUSY
LOG_ERROR = STATUS_ERR
LOG_DEBUG = TEXT_HINT

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

    # 39th 续³ Batch 11：Primary.TButton 突出主操作（启动 helper / 重要 confirm 按钮）。
    # 副操作（停止 / 自检 / 打开日志目录 / 检查更新）保持默认 TButton（ghost 样式），
    # 让用户视线第一时间锁定主操作——production-quality UI 的「视觉层级」基础。
    style.configure(
        "Primary.TButton",
        background=BRAND,
        foreground=ON_BRAND,
        padding=(14, 8),
        borderwidth=0,
        focusthickness=0,
    )
    style.map(
        "Primary.TButton",
        background=[("active", BRAND_HOVER), ("disabled", "#9ca39c")],
        foreground=[("disabled", "#dcdcdc")],
    )

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
