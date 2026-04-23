"""Tkinter 极简 GUI。

设计原则：
- 用 Python 自带的 Tkinter，零额外依赖（PyInstaller 包尺寸最小）
- 主窗口结构：状态灯 + 启停按钮 + 端口/headless 设置 + 日志窗 + 检查更新链接
- 服务跑在 background 线程，主 UI 线程永不阻塞（DrissionPage ensure_browser
  在第一次抓取时才会真正启动 Chromium，可能耗几秒，避开 UI 卡顿）
- 关闭窗口 = 停止 helper 后退出（避免后台僵尸进程）
- 任何异常都通过日志窗 + messagebox 暴露给用户

等以后想加系统托盘/开机自启再单独引入 pystray 等依赖，目前不做。
"""

from __future__ import annotations

import logging
import queue
import sys
import threading
import tkinter as tk
import webbrowser
from logging.handlers import RotatingFileHandler
from tkinter import messagebox, scrolledtext, ttk
from typing import Optional

from .config import (
    APP_NAME_EN,
    APP_NAME_ZH,
    DEFAULT_HOST,
    DEFAULT_PORT,
    DEFAULT_TIMEOUT_MS,
    app_log_dir,
)
from .server import RuntimeOptions, ServerController
from .updater import UpdateInfo, check_for_update_async
from .version import __version__


# —— 日志桥：把 logging 的输出转发到 GUI 的日志窗口 —— #
class _QueueLogHandler(logging.Handler):
    def __init__(self, target_queue: "queue.Queue[str]") -> None:
        super().__init__()
        self.queue = target_queue

    def emit(self, record: logging.LogRecord) -> None:
        try:
            self.queue.put_nowait(self.format(record))
        except queue.Full:
            pass


def _setup_logging(log_queue: "queue.Queue[str]") -> None:
    """把 logging 同时写到 ① 日志文件（便于用户截图给客服） ② GUI 队列。"""
    root = logging.getLogger()
    root.setLevel(logging.INFO)
    root.handlers.clear()

    fmt = logging.Formatter("[%(asctime)s] %(levelname)s %(message)s")

    # 文件
    log_file = app_log_dir() / "helper.log"
    file_handler = RotatingFileHandler(
        log_file, maxBytes=2_000_000, backupCount=3, encoding="utf-8"
    )
    file_handler.setFormatter(fmt)
    root.addHandler(file_handler)

    # GUI 队列
    queue_handler = _QueueLogHandler(log_queue)
    queue_handler.setFormatter(fmt)
    root.addHandler(queue_handler)

    # stderr 兜底（命令行调试用）
    if sys.stderr is not None:
        stream = logging.StreamHandler(sys.stderr)
        stream.setFormatter(fmt)
        root.addHandler(stream)


# —— 主窗口 —— #
class HelperApp:
    def __init__(self) -> None:
        self.root = tk.Tk()
        self.root.title(f"{APP_NAME_ZH} · {APP_NAME_EN} v{__version__}")
        self.root.geometry("640x460")
        self.root.minsize(560, 400)

        # —— 跨平台菜单栏键 —— #
        try:
            # mac 下让窗口上的红绿灯关闭等于 self._on_close
            self.root.createcommand("tk::mac::Quit", self._on_close)
        except Exception:
            pass
        self.root.protocol("WM_DELETE_WINDOW", self._on_close)

        # —— 状态 —— #
        self._log_queue: "queue.Queue[str]" = queue.Queue(maxsize=1000)
        _setup_logging(self._log_queue)

        self._controller: Optional[ServerController] = None
        self._is_busy = False  # 防止启停时重复点

        # —— Tk 变量 —— #
        self.var_status = tk.StringVar(value="未启动")
        self.var_status_color = tk.StringVar(value="#9CA3AF")  # 灰
        self.var_port = tk.StringVar(value=str(DEFAULT_PORT))
        self.var_host = tk.StringVar(value=DEFAULT_HOST)
        self.var_headless = tk.BooleanVar(value=True)

        self._build_ui()
        self._poll_log_queue()

        # —— 启动时异步检查更新 —— #
        check_for_update_async(self._on_update_info)

    # ————————————————————————————————————————————————————
    #  UI 构建
    # ————————————————————————————————————————————————————
    def _build_ui(self) -> None:
        pad = {"padx": 12, "pady": 8}

        # 顶部：状态灯 + 标题
        top = ttk.Frame(self.root)
        top.pack(fill="x", **pad)
        self._status_dot = tk.Canvas(
            top, width=18, height=18, highlightthickness=0, bg=self.root.cget("bg")
        )
        self._status_dot.pack(side="left")
        self._draw_status_dot("#9CA3AF")
        ttk.Label(top, textvariable=self.var_status, font=("", 13, "bold")).pack(
            side="left", padx=(8, 0)
        )

        # 一键复制 helper 地址给扩展用
        self._copy_btn = ttk.Button(
            top, text="复制 helper 地址", command=self._copy_helper_url
        )
        self._copy_btn.pack(side="right")

        # 中部：参数区
        config = ttk.LabelFrame(self.root, text="启动参数")
        config.pack(fill="x", **pad)

        ttk.Label(config, text="监听地址").grid(row=0, column=0, sticky="w", padx=8, pady=6)
        ttk.Entry(config, textvariable=self.var_host, width=20).grid(
            row=0, column=1, sticky="w", padx=4, pady=6
        )
        ttk.Label(config, text="端口").grid(row=0, column=2, sticky="w", padx=(20, 4))
        ttk.Entry(config, textvariable=self.var_port, width=8).grid(
            row=0, column=3, sticky="w", padx=4
        )

        ttk.Checkbutton(
            config,
            text="无头浏览器（推荐；调试时关掉可看到 Chromium 窗口）",
            variable=self.var_headless,
        ).grid(row=1, column=0, columnspan=4, sticky="w", padx=8, pady=(0, 6))

        # 启停按钮
        actions = ttk.Frame(self.root)
        actions.pack(fill="x", **pad)
        self._start_btn = ttk.Button(actions, text="启动 helper", command=self._on_start)
        self._start_btn.pack(side="left")
        self._stop_btn = ttk.Button(
            actions, text="停止", command=self._on_stop, state="disabled"
        )
        self._stop_btn.pack(side="left", padx=(8, 0))

        ttk.Button(
            actions, text="打开日志目录", command=self._open_log_folder
        ).pack(side="right")
        ttk.Button(
            actions, text="检查更新", command=self._manual_check_update
        ).pack(side="right", padx=(0, 8))

        # 底部：日志窗
        log_frame = ttk.LabelFrame(self.root, text="运行日志")
        log_frame.pack(fill="both", expand=True, **pad)
        self._log_text = scrolledtext.ScrolledText(
            log_frame, height=12, font=("Menlo", 10), state="disabled", wrap="word"
        )
        self._log_text.pack(fill="both", expand=True, padx=4, pady=4)

        # 状态栏
        bar = ttk.Frame(self.root)
        bar.pack(fill="x", side="bottom")
        ttk.Separator(bar, orient="horizontal").pack(fill="x")
        ttk.Label(
            bar,
            text=f"v{__version__}  ·  日志: {app_log_dir() / 'helper.log'}",
            foreground="#6B7280",
        ).pack(side="left", padx=12, pady=4)

    def _draw_status_dot(self, color: str) -> None:
        self._status_dot.delete("all")
        self._status_dot.create_oval(2, 2, 16, 16, fill=color, outline="")

    # ————————————————————————————————————————————————————
    #  动作
    # ————————————————————————————————————————————————————
    def _on_start(self) -> None:
        if self._is_busy:
            return
        try:
            port = int(self.var_port.get())
            if not (1 <= port <= 65535):
                raise ValueError
        except ValueError:
            messagebox.showerror("端口非法", "请填写 1~65535 之间的端口号。")
            return

        opts = RuntimeOptions(
            host=self.var_host.get().strip() or DEFAULT_HOST,
            port=port,
            timeout_ms=DEFAULT_TIMEOUT_MS,
            headless=bool(self.var_headless.get()),
        )

        self._is_busy = True
        self._start_btn.configure(state="disabled")
        self._set_status("正在启动 …", "#FBBF24")

        # 启动放线程（避免 DrissionPage 懒加载阻塞 UI）
        def _runner() -> None:
            ctrl = ServerController(opts)
            try:
                ctrl.start()
            except Exception as exc:  # noqa: BLE001
                logging.error("启动失败: %s", exc)
                self.root.after(0, self._on_start_failed, str(exc))
                return
            self._controller = ctrl
            self.root.after(0, self._on_started)

        threading.Thread(target=_runner, daemon=True, name="helper-start").start()

    def _on_started(self) -> None:
        self._is_busy = False
        self._set_status(
            f"运行中 · http://{self.var_host.get()}:{self.var_port.get()}", "#10B981"
        )
        self._start_btn.configure(state="disabled")
        self._stop_btn.configure(state="normal")

    def _on_start_failed(self, reason: str) -> None:
        self._is_busy = False
        self._controller = None
        self._set_status("启动失败", "#EF4444")
        self._start_btn.configure(state="normal")
        self._stop_btn.configure(state="disabled")
        messagebox.showerror("启动失败", reason)

    def _on_stop(self) -> None:
        if self._is_busy or self._controller is None:
            return
        self._is_busy = True
        self._set_status("正在停止 …", "#FBBF24")

        def _runner() -> None:
            ctrl = self._controller
            try:
                if ctrl is not None:
                    ctrl.stop()
            except Exception as exc:  # noqa: BLE001
                logging.error("停止时出错: %s", exc)
            self._controller = None
            self.root.after(0, self._on_stopped)

        threading.Thread(target=_runner, daemon=True, name="helper-stop").start()

    def _on_stopped(self) -> None:
        self._is_busy = False
        self._set_status("未启动", "#9CA3AF")
        self._start_btn.configure(state="normal")
        self._stop_btn.configure(state="disabled")

    def _on_close(self) -> None:
        if self._controller is not None:
            try:
                self._controller.stop()
            except Exception:  # noqa: BLE001
                pass
        self.root.after(50, self.root.destroy)

    def _copy_helper_url(self) -> None:
        host = (self.var_host.get() or DEFAULT_HOST).strip()
        port = self.var_port.get().strip()
        url = f"http://{host}:{port}"
        self.root.clipboard_clear()
        self.root.clipboard_append(url)
        logging.info("helper 地址已复制到剪贴板：%s", url)
        messagebox.showinfo(
            "已复制",
            f"helper 地址 {url} 已复制到剪贴板。\n请在浏览器扩展的设置页粘贴。",
        )

    def _open_log_folder(self) -> None:
        path = app_log_dir()
        try:
            if sys.platform == "darwin":
                import subprocess  # noqa: WPS433

                subprocess.Popen(["open", str(path)])
            elif sys.platform == "win32":
                import os  # noqa: WPS433

                os.startfile(str(path))  # type: ignore[attr-defined]
            else:
                import subprocess  # noqa: WPS433

                subprocess.Popen(["xdg-open", str(path)])
        except Exception as exc:  # noqa: BLE001
            messagebox.showinfo("日志路径", f"日志目录：\n{path}\n\n打开失败：{exc}")

    # ————————————————————————————————————————————————————
    #  更新检查
    # ————————————————————————————————————————————————————
    def _manual_check_update(self) -> None:
        check_for_update_async(self._on_update_info_manual)

    def _on_update_info(self, info: UpdateInfo) -> None:
        # 静默：只有真有新版才弹
        if info.has_update:
            self.root.after(0, self._show_update_dialog, info)

    def _on_update_info_manual(self, info: UpdateInfo) -> None:
        self.root.after(0, self._show_update_dialog_manual, info)

    def _show_update_dialog(self, info: UpdateInfo) -> None:
        if not info.has_update:
            return
        if messagebox.askyesno(
            "发现新版",
            f"发现新版 v{info.latest}（当前 v{info.current}）。\n现在打开下载页？",
        ):
            if info.html_url:
                webbrowser.open(info.html_url)

    def _show_update_dialog_manual(self, info: UpdateInfo) -> None:
        if info.error:
            messagebox.showinfo("更新检查", f"暂时检查不到新版本。\n{info.error}")
            return
        if not info.has_update:
            messagebox.showinfo("已是最新", f"当前 v{info.current} 已经是最新版。")
            return
        self._show_update_dialog(info)

    # ————————————————————————————————————————————————————
    #  日志泵 & 状态灯
    # ————————————————————————————————————————————————————
    def _poll_log_queue(self) -> None:
        try:
            while True:
                line = self._log_queue.get_nowait()
                self._append_log(line)
        except queue.Empty:
            pass
        # 每 200ms 拉一次，足够流畅
        self.root.after(200, self._poll_log_queue)

    def _append_log(self, line: str) -> None:
        self._log_text.configure(state="normal")
        self._log_text.insert("end", line + "\n")
        # 简单封顶，避免长时间运行后内存爆掉
        line_count = int(self._log_text.index("end-1c").split(".")[0])
        if line_count > 500:
            self._log_text.delete("1.0", f"{line_count - 500}.0")
        self._log_text.see("end")
        self._log_text.configure(state="disabled")

    def _set_status(self, text: str, color: str) -> None:
        self.var_status.set(text)
        self._draw_status_dot(color)

    # ————————————————————————————————————————————————————
    #  入口
    # ————————————————————————————————————————————————————
    def run(self) -> None:
        self.root.mainloop()


def main() -> int:
    HelperApp().run()
    return 0
