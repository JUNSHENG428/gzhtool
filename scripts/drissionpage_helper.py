#!/usr/bin/env python3
"""本地 DrissionPage helper。

用途：
1. 作为 Chrome 扩展的可选增强抓取服务运行在本机 HTTP 端口
2. 用 DrissionPage 打开动态页面
3. 复用仓库现有的 `src/content-scripts/scrape-article.js` 抽取正文和图片

默认监听：http://127.0.0.1:7788
"""

from __future__ import annotations

import argparse
import atexit
import contextlib
import json
import logging
import os
import signal
import sys
import threading
import time
import warnings
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlparse

warnings.filterwarnings("ignore", category=Warning, module="requests")

try:
    import DrissionPage
    from DrissionPage import Chromium, ChromiumOptions
except Exception as exc:  # pragma: no cover - 启动期错误直接给用户看
    raise SystemExit(
        "无法导入 DrissionPage。请先执行 `pip install DrissionPage`，再重新启动 helper。\n"
        f"原始错误：{exc}"
    ) from exc


HELPER_VERSION = "0.1.0"
DEFAULT_TIMEOUT_MS = 30000
REPO_ROOT = Path(__file__).resolve().parents[1]
SCRAPER_SCRIPT_PATH = REPO_ROOT / "src" / "content-scripts" / "scrape-article.js"

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


class DrissionRuntime:
    def __init__(self, args: argparse.Namespace) -> None:
        self.args = args
        self._browser = None
        self._lock = threading.Lock()
        if not SCRAPER_SCRIPT_PATH.exists():
            raise FileNotFoundError(f"找不到抓取脚本：{SCRAPER_SCRIPT_PATH}")
        self._scraper_source = SCRAPER_SCRIPT_PATH.read_text(encoding="utf-8")

    def browser_mode_label(self) -> str:
        if self.args.browser_address:
            return "attach"
        return "headless" if self.args.headless else "headed"

    def ensure_browser(self):
        if self._browser is not None:
            return self._browser

        if self.args.browser_address:
            self._browser = Chromium(self.args.browser_address)
            return self._browser

        options = ChromiumOptions(read_file=False)
        if self.args.local_port:
            options.set_local_port(self.args.local_port)
        else:
            options.auto_port()

        if self.args.browser_path:
            options.set_browser_path(self.args.browser_path)

        if self.args.user_data_path:
            options.set_user_data_path(self.args.user_data_path)
        elif self.args.system_user_path and hasattr(options, "use_system_user_path"):
            options.use_system_user_path()

        options.headless(self.args.headless)
        options.set_timeouts(
            base=min(max(self.args.timeout_ms / 1000, 5), 15),
            page_load=max(self.args.timeout_ms / 1000, 10),
            script=max(self.args.timeout_ms / 1000, 10),
        )

        self._browser = Chromium(options)
        return self._browser

    def probe(self) -> dict:
        with self._lock:
            browser = self.ensure_browser()
            _ = browser.latest_tab
            return {
                "ok": True,
                "helperVersion": HELPER_VERSION,
                "drissionVersion": getattr(DrissionPage, "__version__", ""),
                "browserMode": self.browser_mode_label(),
                "scraperScript": str(SCRAPER_SCRIPT_PATH.relative_to(REPO_ROOT)),
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
                    raise RuntimeError("增强抓取没有拿到正文内容，可能页面仍在懒加载或需要登录。")

                capture["url"] = str(capture.get("url") or getattr(tab, "url", url) or url)
                capture["title"] = str(
                    capture.get("title") or getattr(tab, "title", "") or ""
                )
                capture["captureEngine"] = "drissionpage"
                capture["captureEngineLabel"] = "DrissionPage 增强抓取"
                capture["captureMode"] = mode
                capture["captureHelper"] = {
                    "helperVersion": HELPER_VERSION,
                    "drissionVersion": getattr(DrissionPage, "__version__", ""),
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

    def _prepare_dynamic_page(self, tab) -> None:
        self._wait_for_stable_dom(tab, 5)
        with contextlib.suppress(Exception):
            tab.run_js(PREPARE_PAGE_SCRIPT)

        scroll_script = """
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
        with contextlib.suppress(Exception):
            tab.run_js(scroll_script)
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
                tab.wait.doc_loaded(timeout=min(1.5, max(deadline - time.time(), 0.2)), raise_err=False)
            with contextlib.suppress(Exception):
                if not getattr(tab.states, "is_loading", False):
                    time.sleep(0.25)
                    return
            time.sleep(0.15)


class HelperHandler(BaseHTTPRequestHandler):
    runtime: DrissionRuntime | None = None

    def do_OPTIONS(self) -> None:  # noqa: N802
        self.send_response(204)
        self._send_cors_headers()
        self.end_headers()

    def do_GET(self) -> None:  # noqa: N802
        if self.path.rstrip("/") not in {"", "/health"}:
            self._write_json(404, {"ok": False, "error": "接口不存在。"})
            return

        try:
            payload = self.runtime.probe()
            self._write_json(200, payload)
        except Exception as exc:
            logging.exception("health failed")
            self._write_json(500, {"ok": False, "error": str(exc)})

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


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="本地 DrissionPage 抓取 helper")
    parser.add_argument("--host", default="127.0.0.1", help="监听地址，默认 127.0.0.1")
    parser.add_argument("--port", type=int, default=7788, help="监听端口，默认 7788")
    parser.add_argument(
        "--timeout-ms",
        type=int,
        default=DEFAULT_TIMEOUT_MS,
        help="默认抓取超时，单位毫秒，默认 30000",
    )
    parser.add_argument(
        "--headless",
        action=argparse.BooleanOptionalAction,
        default=True,
        help="是否以 headless 模式启动浏览器，默认开启",
    )
    parser.add_argument(
        "--browser-path",
        default="",
        help="可选：指定 Chromium 浏览器可执行文件路径",
    )
    parser.add_argument(
        "--browser-address",
        default="",
        help="可选：接管已有浏览器，例如 127.0.0.1:9222 或 ws://...",
    )
    parser.add_argument(
        "--local-port",
        type=int,
        default=0,
        help="可选：启动本地浏览器时使用固定调试端口；不填则自动找空闲端口",
    )
    parser.add_argument(
        "--user-data-path",
        default="",
        help="可选：指定浏览器用户目录，适合需要复用登录态的场景",
    )
    parser.add_argument(
        "--system-user-path",
        action="store_true",
        help="可选：尽量复用系统浏览器用户目录（只在未指定 user-data-path 时生效）",
    )
    parser.add_argument(
        "--log-level",
        default=os.environ.get("LOG_LEVEL", "INFO"),
        help="日志级别，默认 INFO",
    )
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    logging.basicConfig(
        level=getattr(logging, str(args.log_level).upper(), logging.INFO),
        format="[%(asctime)s] %(levelname)s %(message)s",
    )

    runtime = DrissionRuntime(args)
    HelperHandler.runtime = runtime
    server = ThreadingHTTPServer((args.host, args.port), HelperHandler)

    def shutdown(*_args) -> None:
        logging.info("正在关闭 DrissionPage helper ...")
        with contextlib.suppress(Exception):
            server.shutdown()
        runtime.shutdown()

    atexit.register(runtime.shutdown)
    with contextlib.suppress(Exception):
        signal.signal(signal.SIGTERM, shutdown)
        signal.signal(signal.SIGINT, shutdown)

    logging.info(
        "DrissionPage helper 已启动: http://%s:%s  模式=%s  DrissionPage=%s",
        args.host,
        args.port,
        runtime.browser_mode_label(),
        getattr(DrissionPage, "__version__", ""),
    )

    try:
        server.serve_forever(poll_interval=0.5)
    finally:
        runtime.shutdown()
    return 0


if __name__ == "__main__":
    sys.exit(main())
