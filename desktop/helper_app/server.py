"""DrissionPage helper HTTP 服务（核心逻辑）。

历史上这套代码住在 scripts/drissionpage_helper.py 单文件里。为了支持 PyInstaller
桌面打包 + GUI，这里抽出来作为独立模块，并做了 3 处差异:

1. scrape-article.js 的路径走 config.scrape_script_path()，自动兼容
   "开发模式（仓库根）" 和 "打包模式（PyInstaller 解压目录）"。
2. 新增 /version 接口，扩展端可以拉本地 helper 版本，提示用户升级。
3. 暴露 ServerController，让 GUI 能在线程里启停服务而不阻塞主 UI 线程。

命令行入口由 scripts/drissionpage_helper.py 兼容跳转。
"""

from __future__ import annotations

import contextlib
import json
import logging
import os
import threading
import time
from dataclasses import dataclass, field
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Callable, Optional
from urllib.parse import urlparse

# DrissionPage 是重依赖（拉起 Chromium）。GUI 启动期不需要它，所以延迟在
# DrissionRuntime.ensure_browser() 真正用到时才 import，避免 GUI 出错前
# 就被 DrissionPage 缺失/版本问题吓退用户。
from .config import (
    APP_NAME_EN,
    DEFAULT_HOST,
    DEFAULT_PORT,
    DEFAULT_TIMEOUT_MS,
    scrape_script_path,
)
from .version import __version__ as HELPER_VERSION


# —————————————————————————————————————————————————————————————————————————————
#  浏览器准备脚本（与原 scripts/drissionpage_helper.py 完全等价）
# —————————————————————————————————————————————————————————————————————————————
PREPARE_PAGE_SCRIPT = r"""
(() => {
  const textRe = /(展开|更多|阅读全文|查看全文|显示更多|余下全文|read more|show more|more)/i;
  const selectors = [
    "button",
    "[role='button']",
    "a",
    "summary",
    "[aria-expanded='false']",
    ".expand",
    ".show-more",
    ".read-more"
  ];

  const isVisible = (el) => {
    if (!el) return false;
    const style = window.getComputedStyle(el);
    const rect = el.getBoundingClientRect();
    return (
      style &&
      style.display !== "none" &&
      style.visibility !== "hidden" &&
      rect.width > 0 &&
      rect.height > 0
    );
  };

  let clicked = 0;
  document.querySelectorAll(selectors.join(",")).forEach((el) => {
    const text = (el.innerText || el.textContent || "").trim().slice(0, 64);
    if (!textRe.test(text) || !isVisible(el)) {
      return;
    }
    try {
      el.click();
      clicked += 1;
    } catch (_) {}
  });

  try {
    document.querySelectorAll("img[loading='lazy']").forEach((img) => {
      img.loading = "eager";
    });
  } catch (_) {}

  return clicked;
})()
"""

SCROLL_SCRIPT = """
return (async () => {
  const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  let lastHeight = 0;
  let stableCount = 0;
  for (let i = 0; i < 10; i += 1) {
    const nextY = Math.min(window.scrollY + window.innerHeight * 0.9, document.body.scrollHeight);
    window.scrollTo(0, nextY);
    await pause(180);
    const currentHeight = document.documentElement.scrollHeight;
    if (currentHeight === lastHeight) {
      stableCount += 1;
      if (stableCount >= 3) break;
    } else {
      stableCount = 0;
      lastHeight = currentHeight;
    }
  }
  window.scrollTo(0, 0);
  await pause(240);
  return true;
})();
"""


# —————————————————————————————————————————————————————————————————————————————
#  工具函数
# —————————————————————————————————————————————————————————————————————————————
def json_dumps(payload: dict) -> bytes:
    return json.dumps(payload, ensure_ascii=False).encode("utf-8")


def is_http_url(url: str) -> bool:
    try:
        parsed = urlparse(url)
    except Exception:
        return False
    return parsed.scheme in {"http", "https"} and bool(parsed.netloc)


def normalize_mode(mode: str) -> str:
    lowered = str(mode or "").strip().lower()
    if lowered == "raw":
        return "page"
    if lowered in {"readable", "page", "selection"}:
        return lowered
    return "readable"


# —————————————————————————————————————————————————————————————————————————————
#  运行时配置（GUI 和命令行都可以构造，参数集合刻意保持向后兼容）
# —————————————————————————————————————————————————————————————————————————————
@dataclass
class RuntimeOptions:
    host: str = DEFAULT_HOST
    port: int = DEFAULT_PORT
    timeout_ms: int = DEFAULT_TIMEOUT_MS
    headless: bool = True
    browser_path: str = ""
    browser_address: str = ""
    local_port: int = 0
    user_data_path: str = ""
    system_user_path: bool = False
    log_level: str = field(
        default_factory=lambda: os.environ.get("LOG_LEVEL", "INFO")
    )


# —————————————————————————————————————————————————————————————————————————————
#  DrissionRuntime（核心抓取逻辑）
# —————————————————————————————————————————————————————————————————————————————
class DrissionRuntime:
    def __init__(self, opts: RuntimeOptions) -> None:
        self.opts = opts
        self._browser = None
        self._lock = threading.Lock()
        self._drission_module = None  # 懒加载 DrissionPage
        self._chromium_cls = None
        self._chromium_options_cls = None

        script_path = scrape_script_path()
        if not script_path.exists():
            raise FileNotFoundError(
                f"找不到抓取脚本：{script_path}\n"
                "（打包后请检查 PyInstaller spec datas 是否包含 src/content-scripts/scrape-article.js）"
            )
        self._scraper_source = script_path.read_text(encoding="utf-8")

    # —— DrissionPage 懒加载 —— #
    def _ensure_drission_imported(self) -> None:
        if self._drission_module is not None:
            return
        try:
            import DrissionPage  # noqa: WPS433 (intentional lazy import)
            from DrissionPage import Chromium, ChromiumOptions  # noqa: WPS433
        except Exception as exc:  # pragma: no cover - 缺依赖时由 GUI 弹错
            raise RuntimeError(
                "无法加载 DrissionPage。\n"
                "如果你是命令行运行，请先 `pip install DrissionPage`。\n"
                "如果你是用桌面版 .app/.exe，请提交 issue（这种情况是打包出问题了）。\n"
                f"原始错误：{exc}"
            ) from exc
        self._drission_module = DrissionPage
        self._chromium_cls = Chromium
        self._chromium_options_cls = ChromiumOptions

    def drission_version(self) -> str:
        if self._drission_module is None:
            return ""
        return getattr(self._drission_module, "__version__", "")

    def browser_mode_label(self) -> str:
        if self.opts.browser_address:
            return "attach"
        return "headless" if self.opts.headless else "headed"

    def ensure_browser(self):
        if self._browser is not None:
            return self._browser

        self._ensure_drission_imported()
        Chromium = self._chromium_cls
        ChromiumOptions = self._chromium_options_cls

        if self.opts.browser_address:
            self._browser = Chromium(self.opts.browser_address)
            return self._browser

        options = ChromiumOptions(read_file=False)
        if self.opts.local_port:
            options.set_local_port(self.opts.local_port)
        else:
            options.auto_port()

        if self.opts.browser_path:
            options.set_browser_path(self.opts.browser_path)

        if self.opts.user_data_path:
            options.set_user_data_path(self.opts.user_data_path)
        elif self.opts.system_user_path and hasattr(options, "use_system_user_path"):
            options.use_system_user_path()

        options.headless(self.opts.headless)
        options.set_timeouts(
            base=min(max(self.opts.timeout_ms / 1000, 5), 15),
            page_load=max(self.opts.timeout_ms / 1000, 10),
            script=max(self.opts.timeout_ms / 1000, 10),
        )

        self._browser = Chromium(options)
        return self._browser

    def probe(self) -> dict:
        """/health 用：拉起 browser 验证可用，附带版本号。"""
        with self._lock:
            browser = self.ensure_browser()
            _ = browser.latest_tab
            return {
                "ok": True,
                "helperVersion": HELPER_VERSION,
                "drissionVersion": self.drission_version(),
                "browserMode": self.browser_mode_label(),
                "appName": APP_NAME_EN,
            }

    def scrape(self, url: str, capture_mode: str, timeout_ms: int) -> dict:
        if not is_http_url(url):
            raise ValueError("只支持抓取 http / https 页面。")

        mode = normalize_mode(capture_mode)
        if mode == "selection":
            raise ValueError("增强抓取不支持“只抓选中文字”，请改用扩展内置抓取。")

        started_at = time.time()
        timeout_sec = max(timeout_ms / 1000, 8)

        with self._lock:
            browser = self.ensure_browser()
            tab = browser.new_tab(background=True)
            try:
                with contextlib.suppress(Exception):
                    tab.set.timeouts(
                        base=min(timeout_sec, 12),
                        page_load=timeout_sec,
                        script=timeout_sec,
                    )

                tab.get(url, retry=1, interval=1, timeout=timeout_sec)
                self._wait_for_stable_dom(tab, min(timeout_sec, 8))
                self._prepare_dynamic_page(tab)
                capture = self._run_capture_script(tab, mode, timeout_sec)

                if not isinstance(capture, dict):
                    raise RuntimeError("增强抓取没有返回可解析内容。")
                if capture.get("scrapeError"):
                    raise RuntimeError(
                        str(capture.get("scrapeMessage") or "增强抓取失败，请稍后重试。")
                    )

                blocks = capture.get("blocks")
                if not isinstance(blocks, list) or not blocks:
                    raise RuntimeError(
                        "增强抓取没有拿到正文内容，可能页面仍在懒加载或需要登录。"
                    )

                capture["url"] = str(capture.get("url") or getattr(tab, "url", url) or url)
                capture["title"] = str(
                    capture.get("title") or getattr(tab, "title", "") or ""
                )
                capture["captureEngine"] = "drissionpage"
                capture["captureEngineLabel"] = "DrissionPage 增强抓取"
                capture["captureMode"] = mode
                capture["captureHelper"] = {
                    "helperVersion": HELPER_VERSION,
                    "drissionVersion": self.drission_version(),
                    "browserMode": self.browser_mode_label(),
                    "latencyMs": int((time.time() - started_at) * 1000),
                }
                return capture
            finally:
                with contextlib.suppress(Exception):
                    tab.close()

    def shutdown(self) -> None:
        browser = self._browser
        self._browser = None
        if browser is None:
            return
        with contextlib.suppress(Exception):
            browser.quit()

    # —— 动态加载/滚动展开 —— #
    def _prepare_dynamic_page(self, tab) -> None:
        self._wait_for_stable_dom(tab, 5)
        with contextlib.suppress(Exception):
            tab.run_js(PREPARE_PAGE_SCRIPT)
        with contextlib.suppress(Exception):
            tab.run_js(SCROLL_SCRIPT)
        time.sleep(0.8)

    def _run_capture_script(self, tab, mode: str, timeout_sec: float) -> dict:
        last_error = None
        for _ in range(2):
            self._wait_for_stable_dom(tab, min(timeout_sec, 6))
            try:
                tab.run_js(self._scraper_source)
                return tab.run_js("return window.__gzhRunCapture(arguments[0]);", mode)
            except Exception as exc:
                last_error = exc
                if "页面被刷新" not in str(exc):
                    raise
                time.sleep(0.6)
        if last_error:
            raise last_error
        raise RuntimeError("增强抓取脚本注入失败。")

    def _wait_for_stable_dom(self, tab, timeout_sec: float) -> None:
        deadline = time.time() + max(timeout_sec, 1)
        while time.time() < deadline:
            with contextlib.suppress(Exception):
                tab.wait.doc_loaded(
                    timeout=min(1.5, max(deadline - time.time(), 0.2)),
                    raise_err=False,
                )
            with contextlib.suppress(Exception):
                if not getattr(tab.states, "is_loading", False):
                    time.sleep(0.25)
                    return
            time.sleep(0.15)


# —————————————————————————————————————————————————————————————————————————————
#  HTTP Handler（与原版完全等价 + 新增 /version）
# —————————————————————————————————————————————————————————————————————————————
class HelperHandler(BaseHTTPRequestHandler):
    runtime: Optional[DrissionRuntime] = None

    def do_OPTIONS(self) -> None:  # noqa: N802
        self.send_response(204)
        self._send_cors_headers()
        self.end_headers()

    def do_GET(self) -> None:  # noqa: N802
        path = self.path.rstrip("/") or "/"
        if path in {"", "/", "/health"}:
            try:
                payload = self.runtime.probe()
                self._write_json(200, payload)
            except Exception as exc:
                logging.exception("health failed")
                self._write_json(500, {"ok": False, "error": str(exc)})
            return

        if path == "/version":
            # 不拉浏览器，纯返回版本，给扩展端轻量轮询用
            self._write_json(
                200,
                {
                    "ok": True,
                    "appName": APP_NAME_EN,
                    "helperVersion": HELPER_VERSION,
                },
            )
            return

        self._write_json(404, {"ok": False, "error": "接口不存在。"})

    def do_POST(self) -> None:  # noqa: N802
        if self.path.rstrip("/") != "/scrape":
            self._write_json(404, {"ok": False, "error": "接口不存在。"})
            return

        try:
            data = self._read_json()
        except ValueError as exc:
            self._write_json(400, {"ok": False, "error": str(exc)})
            return

        url = str(data.get("url") or "").strip()
        capture_mode = normalize_mode(data.get("captureMode"))
        timeout_ms = int(data.get("timeoutMs") or DEFAULT_TIMEOUT_MS)

        try:
            started_at = time.time()
            capture = self.runtime.scrape(url, capture_mode, timeout_ms)
            latency_ms = int((time.time() - started_at) * 1000)
            self._write_json(
                200,
                {
                    "ok": True,
                    "latencyMs": latency_ms,
                    "helperVersion": HELPER_VERSION,
                    "data": capture,
                },
            )
        except ValueError as exc:
            self._write_json(400, {"ok": False, "error": str(exc)})
        except Exception as exc:
            logging.exception("scrape failed: %s", url)
            self._write_json(500, {"ok": False, "error": str(exc)})

    def log_message(self, format: str, *args) -> None:  # noqa: A003
        logging.info("%s - %s", self.address_string(), format % args)

    def _read_json(self) -> dict:
        length = int(self.headers.get("Content-Length") or "0")
        raw = self.rfile.read(length) if length > 0 else b"{}"
        try:
            data = json.loads(raw.decode("utf-8") or "{}")
        except Exception as exc:
            raise ValueError("请求体不是合法 JSON。") from exc
        if not isinstance(data, dict):
            raise ValueError("请求体必须是 JSON 对象。")
        return data

    def _write_json(self, status: int, payload: dict) -> None:
        body = json_dumps(payload)
        self.send_response(status)
        self._send_cors_headers()
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _send_cors_headers(self) -> None:
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")


# —————————————————————————————————————————————————————————————————————————————
#  ServerController：GUI 友好，包装 ThreadingHTTPServer + DrissionRuntime
# —————————————————————————————————————————————————————————————————————————————
class ServerController:
    """把 helper 服务包成可启停的对象，GUI 主线程只调 start/stop 即可。"""

    def __init__(
        self,
        opts: Optional[RuntimeOptions] = None,
        on_log: Optional[Callable[[str], None]] = None,
    ) -> None:
        self.opts = opts or RuntimeOptions()
        self._on_log = on_log
        self._server: Optional[ThreadingHTTPServer] = None
        self._serve_thread: Optional[threading.Thread] = None
        self._runtime: Optional[DrissionRuntime] = None

    @property
    def is_running(self) -> bool:
        return self._server is not None

    def start(self) -> None:
        if self.is_running:
            self._log("helper 已经在运行了，忽略重复启动。")
            return

        self._runtime = DrissionRuntime(self.opts)
        HelperHandler.runtime = self._runtime

        try:
            self._server = ThreadingHTTPServer(
                (self.opts.host, self.opts.port), HelperHandler
            )
        except OSError as exc:
            self._runtime = None
            HelperHandler.runtime = None
            raise RuntimeError(
                f"端口 {self.opts.port} 已被占用，请换一个或先关掉占用程序。\n原始错误：{exc}"
            ) from exc

        self._serve_thread = threading.Thread(
            target=self._server.serve_forever,
            kwargs={"poll_interval": 0.5},
            daemon=True,
            name="helper-http",
        )
        self._serve_thread.start()
        self._log(
            f"helper 已启动: http://{self.opts.host}:{self.opts.port}  "
            f"模式={self._runtime.browser_mode_label()}"
        )

    def stop(self) -> None:
        server, runtime = self._server, self._runtime
        self._server = None
        self._runtime = None
        HelperHandler.runtime = None

        if server is not None:
            with contextlib.suppress(Exception):
                server.shutdown()
            with contextlib.suppress(Exception):
                server.server_close()
        if runtime is not None:
            runtime.shutdown()
        if self._serve_thread is not None:
            self._serve_thread.join(timeout=2.0)
            self._serve_thread = None
        self._log("helper 已停止。")

    def _log(self, msg: str) -> None:
        logging.info(msg)
        if self._on_log is not None:
            with contextlib.suppress(Exception):
                self._on_log(msg)


# —————————————————————————————————————————————————————————————————————————————
#  命令行入口（保持与原 scripts/drissionpage_helper.py 一致的 CLI 行为）
# —————————————————————————————————————————————————————————————————————————————
def run_cli(opts: RuntimeOptions) -> int:
    """阻塞式跑 helper（用于命令行 / scripts/drissionpage_helper.py 兼容跳转）。"""
    logging.basicConfig(
        level=getattr(logging, str(opts.log_level).upper(), logging.INFO),
        format="[%(asctime)s] %(levelname)s %(message)s",
    )

    controller = ServerController(opts)
    controller.start()
    try:
        # 主线程在前台 sleep 等中断信号
        while controller.is_running:
            time.sleep(0.5)
    except KeyboardInterrupt:
        pass
    finally:
        controller.stop()
    return 0
