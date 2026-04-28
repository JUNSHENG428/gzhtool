"""Tkinter 极简 GUI。

设计原则：
- 用 Python 自带的 Tkinter，零额外依赖（PyInstaller 包尺寸最小）
- 主窗口结构：状态灯 + 启停按钮 + 端口/headless 设置 + 日志窗 + 检查更新链接
- 服务跑在 background 线程，主 UI 线程永不阻塞（DrissionPage ensure_browser
  在第一次抓取时才会真正启动 Chromium，可能耗几秒，避开 UI 卡顿）
- 关闭窗口 = 停止 helper 后退出（避免后台僵尸进程）
- 任何异常都通过日志窗 + messagebox 暴露给用户

等以后想加系统托盘/开机自启再单独引入 pystray 等依赖，目前不做。

视觉：主题常量与 ttk 样式见 `ui_theme.py`（与扩展 design-tokens 气质对齐；故意不用 WebView，
避免 PyInstaller 体积与跨平台调试成本）。
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

from . import ui_theme as theme
from .config import (
    APP_NAME_EN,
    APP_NAME_ZH,
    DEFAULT_HOST,
    DEFAULT_PORT,
    DEFAULT_TIMEOUT_MS,
    app_config_dir,
    app_log_dir,
    helper_token_path,
    load_or_create_helper_token,
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
        self.root.minsize(580, 400)
        self.root.configure(background=theme.BG_WINDOW)
        self._ttk_style = theme.apply_ttk_style(self.root)
        try:
            self._ttk_style.configure("Main.TFrame", background=theme.BG_WINDOW)
            self._ttk_style.configure(
                "Main.TLabel",
                background=theme.BG_WINDOW,
                foreground=theme.TEXT_PRIMARY,
            )
        except Exception:
            pass

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
        # 启动期就把 token 准备好（懒加载文件）。如果用户在 GUI 里点「关闭鉴权」，
        # 也只是在 RuntimeOptions 里把 auth_token 置空，不会删掉文件，方便随时重开。
        self._auth_token = load_or_create_helper_token()

        # —— Tk 变量 —— #
        self.var_status = tk.StringVar(value="未启动")
        self.var_port = tk.StringVar(value=str(DEFAULT_PORT))
        self.var_host = tk.StringVar(value=DEFAULT_HOST)
        self.var_headless = tk.BooleanVar(value=True)
        self.var_auth_enabled = tk.BooleanVar(value=True)
        self.var_allow_private = tk.BooleanVar(value=False)
        self.var_token_display = tk.StringVar(value=self._mask_token(self._auth_token))

        self._build_ui()
        self._poll_log_queue()

        # —— 启动时异步检查更新 —— #
        check_for_update_async(self._on_update_info)

    # ————————————————————————————————————————————————————
    #  UI 构建
    # ————————————————————————————————————————————————————
    def _build_ui(self) -> None:
        pad = theme.PAD_OUTER

        # 顶部：状态灯 + 标题
        top = ttk.Frame(self.root, style="Main.TFrame")
        top.pack(fill="x", **pad)
        self._status_dot = tk.Canvas(
            top,
            width=18,
            height=18,
            highlightthickness=0,
            bg=theme.BG_CANVAS,
        )
        self._status_dot.pack(side="left")
        self._draw_status_dot(theme.STATUS_IDLE)
        ttk.Label(
            top,
            textvariable=self.var_status,
            font=theme.ui_heading_font(),
            style="Main.TLabel",
        ).pack(side="left", padx=(8, 0))

        # 一键复制 helper 地址给扩展用
        self._copy_btn = ttk.Button(
            top, text="复制 helper 地址", command=self._copy_helper_url
        )
        self._copy_btn.pack(side="right")

        # 中部：参数区
        config = ttk.LabelFrame(self.root, text="启动参数")
        config.pack(fill="x", **pad)
        config.grid_columnconfigure(1, weight=1)

        ttk.Label(config, text="监听地址", foreground=theme.TEXT_PRIMARY).grid(
            row=0, column=0, sticky="nw", **theme.PAD_COMPACT
        )
        ttk.Entry(config, textvariable=self.var_host, width=20).grid(
            row=0, column=1, sticky="ew", padx=4, pady=6
        )
        ttk.Label(config, text="端口", foreground=theme.TEXT_PRIMARY).grid(
            row=0, column=2, sticky="nw", padx=(20, 4), pady=6
        )
        ttk.Entry(config, textvariable=self.var_port, width=8).grid(
            row=0, column=3, sticky="w", padx=4, pady=6
        )

        ttk.Checkbutton(
            config,
            text="无头浏览器（推荐；调试时关掉可看到 Chromium 窗口）",
            variable=self.var_headless,
        ).grid(row=1, column=0, columnspan=4, sticky="w", padx=8, pady=(0, 6))

        ttk.Checkbutton(
            config,
            text="开启 token 鉴权（推荐；只允许扩展端凭 token 访问 /scrape）",
            variable=self.var_auth_enabled,
        ).grid(row=2, column=0, columnspan=4, sticky="w", padx=8, pady=(0, 6))

        ttk.Checkbutton(
            config,
            text="允许抓取本机/内网地址（默认禁止以阻断 SSRF；只在需要抓 localhost 时开）",
            variable=self.var_allow_private,
        ).grid(row=3, column=0, columnspan=4, sticky="w", padx=8, pady=(0, 6))

        # —— 安全凭据区 —— #
        sec = ttk.LabelFrame(self.root, text="安全凭据")
        sec.pack(fill="x", **pad)
        sec.grid_columnconfigure(1, weight=1)

        ttk.Label(sec, text="helper token:", foreground=theme.TEXT_PRIMARY).grid(
            row=0, column=0, sticky="nw", **theme.PAD_COMPACT
        )
        ttk.Label(
            sec,
            textvariable=self.var_token_display,
            foreground=theme.TEXT_SECONDARY,
        ).grid(row=0, column=1, sticky="ew", padx=4, pady=6)
        ttk.Button(sec, text="重置 token", command=self._regenerate_token).grid(
            row=0, column=2, sticky="e", padx=8, pady=6
        )
        self._token_hint_label = ttk.Label(
            sec,
            text="出于安全考虑，token 默认遮显示。点「复制 helper 地址」会把含 token 的完整地址写入剪贴板。",
            foreground=theme.TEXT_HINT,
            wraplength=520,
            justify="left",
        )
        self._token_hint_label.grid(
            row=1, column=0, columnspan=3, sticky="ew", padx=8, pady=(0, 6)
        )

        # 启停按钮
        actions = ttk.Frame(self.root, style="Main.TFrame")
        actions.pack(fill="x", **pad)
        self._start_btn = ttk.Button(actions, text="启动 helper", command=self._on_start)
        self._start_btn.pack(side="left")
        self._stop_btn = ttk.Button(
            actions, text="停止", command=self._on_stop, state="disabled"
        )
        self._stop_btn.pack(side="left", padx=(8, 0))
        ttk.Button(
            actions, text="一键自检", command=self._run_self_check
        ).pack(side="left", padx=(8, 0))

        ttk.Button(
            actions, text="打开日志目录", command=self._open_log_folder
        ).pack(side="right")
        ttk.Button(
            actions, text="检查更新", command=self._manual_check_update
        ).pack(side="right", padx=(0, 8))

        # 底部：日志窗（pack 填满 LabelFrame 客户区，跨 Tk 版本最稳）
        log_frame = ttk.LabelFrame(self.root, text="运行日志")
        log_frame.pack(fill="both", expand=True, **pad)
        self._log_text = scrolledtext.ScrolledText(
            log_frame,
            height=12,
            font=theme.log_mono_font(),
            state="disabled",
            wrap="word",
            background=theme.BG_LOG,
            foreground=theme.TEXT_PRIMARY,
            insertbackground=theme.TEXT_PRIMARY,
            highlightthickness=0,
            borderwidth=0,
        )
        self._log_text.pack(fill="both", expand=True, padx=6, pady=6)

        # 状态栏
        bar = ttk.Frame(self.root, style="Main.TFrame")
        bar.pack(fill="x", side="bottom")
        ttk.Separator(bar, orient="horizontal").pack(fill="x")
        tk.Label(
            bar,
            text=f"v{__version__}  ·  日志: {app_log_dir() / 'helper.log'}",
            bg=theme.BG_WINDOW,
            fg=theme.TEXT_HINT,
            font=theme.ui_body_font(),
        ).pack(side="left", padx=12, pady=4)

        self.root.bind("<Configure>", self._on_root_configure)

    def _on_root_configure(self, event: object) -> None:
        """窗口变宽时拉长 token 说明换行宽度，避免右侧大量留白。"""
        if event.widget != self.root:
            return
        w = max(280, self.root.winfo_width() - 100)
        try:
            self._token_hint_label.configure(wraplength=w)
        except Exception:
            pass

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
            auth_token=self._auth_token if self.var_auth_enabled.get() else "",
            allow_private_hosts=bool(self.var_allow_private.get()),
        )

        self._is_busy = True
        self._start_btn.configure(state="disabled")
        self._set_status("正在启动 …", theme.STATUS_BUSY)

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
            f"运行中 · http://{self.var_host.get()}:{self.var_port.get()}",
            theme.STATUS_OK,
        )
        self._start_btn.configure(state="disabled")
        self._stop_btn.configure(state="normal")

    def _on_start_failed(self, reason: str) -> None:
        self._is_busy = False
        self._controller = None
        self._set_status("启动失败", theme.STATUS_ERR)
        self._start_btn.configure(state="normal")
        self._stop_btn.configure(state="disabled")
        messagebox.showerror("启动失败", reason)

    def _on_stop(self) -> None:
        if self._is_busy or self._controller is None:
            return
        self._is_busy = True
        self._set_status("正在停止 …", theme.STATUS_BUSY)

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
        self._set_status("未启动", theme.STATUS_IDLE)
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
        base_url = f"http://{host}:{port}"
        token = self._auth_token if self.var_auth_enabled.get() else ""
        if token:
            # 带 token 的形式：扩展端「helper 地址」字段填这一段即可，
            # 解析时会自动把 ?token= 拆出来存到 settings.drissionHelperToken。
            url = f"{base_url}/?token={token}"
            tip = (
                f"含 token 的 helper 地址已复制：\n{base_url}/?token=…（已隐藏）\n\n"
                "请在浏览器扩展的「桌面助手」设置区粘贴此地址，"
                "扩展会自动拆出 token，无需单独输入。"
            )
        else:
            url = f"{base_url}/"
            tip = (
                f"helper 地址 {url} 已复制到剪贴板。\n"
                "当前未开启鉴权，任何能访问 127.0.0.1:%s 的进程都可以调用 helper。\n"
                "建议保持「开启 token 鉴权」勾选并重新复制。"
            ) % port
        self.root.clipboard_clear()
        self.root.clipboard_append(url)
        logging.info("helper 地址已复制到剪贴板：%s", base_url)
        messagebox.showinfo("已复制", tip)

    def _regenerate_token(self) -> None:
        if not messagebox.askyesno(
            "重置 token",
            "重置后旧 token 立即失效，扩展端需要重新粘贴新地址。\n确认重置？",
        ):
            return
        self._auth_token = load_or_create_helper_token(force_new=True)
        self.var_token_display.set(self._mask_token(self._auth_token))
        logging.info("已重置 helper token，文件路径：%s", helper_token_path())
        messagebox.showinfo(
            "已重置",
            (
                "新 token 已生成。\n"
                "请点「复制 helper 地址」获取新的连接串，并重新粘贴到扩展设置页。"
            ),
        )

    @staticmethod
    def _mask_token(token: str) -> str:
        token = (token or "").strip()
        if not token:
            return "（未生成）"
        if len(token) <= 10:
            return token[:2] + "…" + token[-2:]
        return token[:4] + "…" + token[-4:]

    def _run_self_check(self) -> None:
        """一键自检：把环境信息打成 markdown 表，复制到剪贴板，方便排错时贴给客服。

        覆盖项：
        - 操作系统 / Python 版本
        - helper 版本 / 端口 / 鉴权 / 内网开关
        - DrissionPage 是否能 import + 版本
        - Chromium 可执行文件能否找到（DrissionPage 默认查找）
        - 端口是否被占用
        - token 文件路径 / 日志路径
        """
        report = self._collect_diagnostics()
        self.root.clipboard_clear()
        self.root.clipboard_append(report)
        logging.info("已生成诊断报告并复制到剪贴板")
        messagebox.showinfo(
            "自检完成",
            "诊断信息已复制到剪贴板，可以直接粘贴给客服或贴到 GitHub Issue。\n\n"
            "如果某一项显示 ❌，先按提示修复再启动 helper。",
        )

    def _collect_diagnostics(self) -> str:
        import platform
        import socket as _socket

        lines = ["# 润笔桌面助手 自检报告", ""]

        # —— 基础环境 —— #
        lines.append("## 基础环境")
        lines.append(f"- 操作系统: {platform.platform()}")
        lines.append(f"- Python: {platform.python_version()} ({sys.executable})")
        lines.append(f"- helper 版本: v{__version__}")

        # —— 服务参数 —— #
        lines.append("")
        lines.append("## 服务参数")
        lines.append(f"- 监听: {self.var_host.get()}:{self.var_port.get()}")
        lines.append(f"- 无头浏览器: {'开' if self.var_headless.get() else '关'}")
        lines.append(f"- 鉴权: {'开（推荐）' if self.var_auth_enabled.get() else '关（不推荐）'}")
        lines.append(
            f"- 内网抓取: {'允许' if self.var_allow_private.get() else '禁止（默认）'}"
        )
        lines.append(f"- 当前状态: {self.var_status.get()}")

        # —— DrissionPage —— #
        lines.append("")
        lines.append("## DrissionPage")
        try:
            import DrissionPage  # noqa: WPS433

            dp_version = getattr(DrissionPage, "__version__", "unknown")
            lines.append(f"- ✅ 已安装 DrissionPage v{dp_version}")
        except Exception as exc:  # noqa: BLE001
            lines.append(f"- ❌ 无法 import DrissionPage：{exc}")
            lines.append("  → 命令行用户请 `pip install DrissionPage`；桌面 .app 用户请重装 helper。")

        # —— Chromium —— #
        lines.append("")
        lines.append("## Chromium / Chrome")
        chrome_path = self._guess_chrome_path()
        if chrome_path:
            lines.append(f"- ✅ 检测到浏览器: {chrome_path}")
        else:
            lines.append("- ❌ 未在常见路径找到 Chrome / Chromium / Edge。")
            lines.append("  → 请安装 Chrome 或 Edge；DrissionPage 需要它们做内核。")

        # —— 端口 —— #
        lines.append("")
        lines.append("## 端口")
        try:
            port_int = int(self.var_port.get())
        except ValueError:
            port_int = DEFAULT_PORT
        sock = _socket.socket(_socket.AF_INET, _socket.SOCK_STREAM)
        sock.settimeout(0.4)
        try:
            sock.connect(("127.0.0.1", port_int))
            lines.append(
                f"- ⚠️ 端口 {port_int} 已被某个进程占用。如果不是 helper 自己，"
                "请先停掉占用程序或换一个端口。"
            )
        except (ConnectionRefusedError, OSError):
            lines.append(f"- ✅ 端口 {port_int} 当前空闲。")
        finally:
            sock.close()

        # —— 文件路径 —— #
        lines.append("")
        lines.append("## 文件路径")
        lines.append(f"- 配置目录: {app_config_dir()}")
        lines.append(f"- token 文件: {helper_token_path()}（{'存在' if helper_token_path().exists() else '不存在'}）")
        lines.append(f"- 日志目录: {app_log_dir()}")

        return "\n".join(lines)

    @staticmethod
    def _guess_chrome_path() -> str:
        candidates: list[str] = []
        if sys.platform == "darwin":
            candidates += [
                "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
                "/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary",
                "/Applications/Chromium.app/Contents/MacOS/Chromium",
                "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
            ]
        elif sys.platform == "win32":
            program_files = [
                __import__("os").environ.get(name, "")
                for name in ("ProgramFiles", "ProgramFiles(x86)", "LOCALAPPDATA")
            ]
            for base in [p for p in program_files if p]:
                candidates += [
                    f"{base}\\Google\\Chrome\\Application\\chrome.exe",
                    f"{base}\\Microsoft\\Edge\\Application\\msedge.exe",
                ]
        else:
            candidates += [
                "/usr/bin/google-chrome",
                "/usr/bin/chromium",
                "/usr/bin/chromium-browser",
                "/usr/bin/microsoft-edge",
            ]
        from pathlib import Path as _Path

        for path in candidates:
            try:
                if path and _Path(path).exists():
                    return path
            except OSError:
                continue
        return ""

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
