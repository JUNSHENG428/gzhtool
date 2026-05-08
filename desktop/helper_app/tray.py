"""macOS 菜单栏图标（NSStatusBar via rumps）。仅 macOS + 安装了 rumps 时启用。

设计：
- rumps 在主线程跑 NSApplication，tkinter 通过 rumps.Timer 每 50ms 调 root.update()
  驱动事件循环（避免双 mainloop 冲突）
- 关闭 tkinter 主窗口只 withdraw 不 destroy → 菜单栏「打开主窗口」可恢复
- 用户从菜单点「退出」才真正 destroy tk → 触发 _drive_tkinter 抛 TclError → 自动退出 rumps
- rumps 不可用时（Linux/Win/未装）gracefully 退到原 tkinter mainloop 模式

为什么用 rumps 而不直接调 PyObjC NSStatusBar：
- rumps 是 NSStatusBar 的轻量 wrapper（~50KB），API 远比 PyObjC 简洁
- PyInstaller 打包 rumps 比打包完整 PyObjC 子集小一半

为什么不用 pystray（跨平台）：
- pystray 在 macOS 上图标渲染常见 issue（菜单不响应 / 高 DPI 模糊）
- 我们只需要 mac 版菜单栏，win/linux 走主窗口模式即可
"""

from __future__ import annotations

import logging
import sys
import tkinter as tk

try:
    import rumps  # type: ignore
except ImportError:
    rumps = None  # type: ignore

# 三档 emoji 状态图标（macOS 菜单栏支持 unicode/emoji 文本图标）
ICON_IDLE = "⚪"
ICON_BUSY = "🟡"
ICON_OK = "🟢"
ICON_ERR = "🔴"


def is_available() -> bool:
    """检测当前平台 + rumps 是否可用。"""
    return sys.platform == "darwin" and rumps is not None


def run_with_tray(helper_app) -> None:
    """以 tray 模式运行 helper（macOS only）。

    helper_app 是已构造的 HelperApp 实例（self.root 已建好但未调 mainloop）。
    本函数不返回——直到用户点菜单「退出」才退出 NSApplication.run()。

    rumps 不可用时 fallback 到 tkinter mainloop（确保跨平台兼容）。
    """
    if not is_available():
        # fallback：用原有 mainloop（win/linux/未装 rumps）
        helper_app.root.mainloop()
        return

    tray = TrayApp(helper_app)
    # 关闭主窗口只 withdraw 让用户能从菜单栏唤起；真正退出走菜单「退出」
    helper_app.root.protocol(
        "WM_DELETE_WINDOW",
        lambda: _withdraw_with_hint(helper_app),
    )
    tray.run()


def _withdraw_with_hint(helper_app) -> None:
    """关闭主窗口时给个 toast 提示「app 还在菜单栏跑着」（仅第一次）。"""
    try:
        helper_app.root.withdraw()
        if not getattr(helper_app, "_tray_hint_shown", False):
            helper_app._tray_hint_shown = True
            try:
                rumps.notification(
                    title="Runbi Helper 仍在运行",
                    subtitle="主窗口已关闭，可从菜单栏「⚪/🟢」图标重新打开",
                    message="或从菜单栏「退出 Runbi Helper」彻底退出",
                )
            except Exception:
                # 通知中心权限被拒——静默
                pass
    except tk.TclError:
        pass


if rumps is not None:
    class TrayApp(rumps.App):  # type: ignore[misc]
        """菜单栏 app。状态项 + 启停 + 打开主窗口 + 打开 Inbox + 退出。"""

        def __init__(self, helper_app):
            super().__init__(
                "Runbi Helper",
                title=ICON_IDLE,
                icon=None,
                quit_button=None,  # 自己加退出菜单（让标签可控）
            )
            self._helper = helper_app

            # 状态项保留引用，方便后续直接改 title 而不用 menu key 索引
            self._status_item = rumps.MenuItem("状态：未启动")

            self.menu = [
                self._status_item,
                None,  # separator
                rumps.MenuItem("启动 helper", callback=self._on_start),
                rumps.MenuItem("停止", callback=self._on_stop),
                None,
                rumps.MenuItem("打开主窗口", callback=self._on_show_window),
                rumps.MenuItem("打开 Inbox（抓取归档）", callback=self._on_open_inbox),
                None,
                rumps.MenuItem("退出 Runbi Helper", callback=self._on_quit),
            ]

            # 50ms 驱动 tkinter event loop（足够流畅 + 不占 CPU）
            self._tk_timer = rumps.Timer(self._drive_tkinter, 0.05)
            self._tk_timer.start()

            # 500ms 同步 helper 运行状态到菜单栏图标 + 状态项文字
            self._status_timer = rumps.Timer(self._sync_status, 0.5)
            self._status_timer.start()

        # ─── tkinter event loop bridge ─── #
        def _drive_tkinter(self, _sender) -> None:
            try:
                self._helper.root.update()
            except tk.TclError:
                # tk 主窗口已 destroy（用户从菜单点了「退出」）→ 退出 rumps
                self._tk_timer.stop()
                self._status_timer.stop()
                try:
                    rumps.quit_application()
                except Exception:
                    pass

        def _sync_status(self, _sender) -> None:
            """根据 helper 运行状态同步菜单栏图标 + 文字。每 500ms 调一次。"""
            try:
                ctrl = getattr(self._helper, "_controller", None)
                running = bool(ctrl and ctrl.is_running)
                busy = bool(getattr(self._helper, "_is_busy", False))
                batch = bool(getattr(self._helper, "_batch_running", False))

                if busy or batch:
                    icon = ICON_BUSY
                    text = "状态：批量抓取中" if batch else "状态：忙（启动中）"
                elif running:
                    icon = ICON_OK
                    port = getattr(self._helper, "var_port", None)
                    text = f"状态：运行中（:{port.get() if port else '?'}）"
                else:
                    icon = ICON_IDLE
                    text = "状态：未启动"

                if self.title != icon:
                    self.title = icon
                if self._status_item.title != text:
                    self._status_item.title = text
            except Exception:
                logging.warning("[tray] sync_status failed", exc_info=True)

        # ─── 菜单回调 ─── #
        def _on_start(self, _sender) -> None:
            try:
                self._on_show_window(None)  # 启动时显示主窗口让用户看到日志
                self._helper._on_start()
            except Exception:
                logging.exception("[tray] start failed")

        def _on_stop(self, _sender) -> None:
            try:
                self._helper._on_stop()
            except Exception:
                logging.exception("[tray] stop failed")

        def _on_show_window(self, _sender) -> None:
            try:
                self._helper.root.deiconify()
                self._helper.root.lift()
                self._helper.root.focus_force()
            except tk.TclError:
                pass

        def _on_open_inbox(self, _sender) -> None:
            try:
                self._helper._open_inbox_folder()
            except Exception:
                logging.exception("[tray] open inbox failed")

        def _on_quit(self, _sender) -> None:
            try:
                self._helper._on_close()  # 走标准关闭流程：stop helper + destroy root
            except Exception:
                logging.exception("[tray] quit close failed")
            # _on_close 会异步 destroy root → 下次 _drive_tkinter tick 抛 TclError → quit_application


__all__ = ["is_available", "run_with_tray"]
