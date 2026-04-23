"""桌面助手主入口逻辑。

为啥独立成 cli.py 而不是直接放 __main__.py？
- __main__.py 是 Python 的特殊文件名，只在 `python -m PACKAGE` 时被自动加载。
- PyInstaller 打包时不会把 __main__.py 视为可被外部 import 的模块，会导致
  `from helper_app import __main__` 失败（在 frozen 应用里找不到符号）。
- 把真正的逻辑放到普通模块 cli.py，让 __main__.py 和打包入口（runbi_helper.py）
  都从 cli.py import，是最稳的做法。

允许两种调用方式：
1. 默认：启动 GUI（双击 .app / .exe，或 python -m desktop.helper_app）
2. 命令行：--no-gui 参数，无窗口模式（兼容老 scripts/drissionpage_helper.py 的用法）
"""

from __future__ import annotations

import argparse
import sys
from typing import List, Optional

from .config import DEFAULT_HOST, DEFAULT_PORT, DEFAULT_TIMEOUT_MS
from .server import RuntimeOptions, run_cli


def _parse_cli_args(argv: List[str]) -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        prog="runbi-helper",
        description="润笔桌面助手（DrissionPage 抓取通道）",
    )
    parser.add_argument(
        "--no-gui",
        action="store_true",
        help="不启动窗口，直接跑 helper（无人值守模式）",
    )
    parser.add_argument("--host", default=DEFAULT_HOST)
    parser.add_argument("--port", type=int, default=DEFAULT_PORT)
    parser.add_argument("--timeout-ms", type=int, default=DEFAULT_TIMEOUT_MS)
    parser.add_argument(
        "--headless",
        action=argparse.BooleanOptionalAction,
        default=True,
        help="是否以 headless 模式启动浏览器（默认开启）",
    )
    parser.add_argument("--browser-path", default="")
    parser.add_argument("--browser-address", default="")
    parser.add_argument("--local-port", type=int, default=0)
    parser.add_argument("--user-data-path", default="")
    parser.add_argument("--system-user-path", action="store_true")
    parser.add_argument("--log-level", default="INFO")
    return parser.parse_args(argv)


def _opts_from_args(args: argparse.Namespace) -> RuntimeOptions:
    return RuntimeOptions(
        host=args.host,
        port=args.port,
        timeout_ms=args.timeout_ms,
        headless=args.headless,
        browser_path=args.browser_path,
        browser_address=args.browser_address,
        local_port=args.local_port,
        user_data_path=args.user_data_path,
        system_user_path=args.system_user_path,
        log_level=args.log_level,
    )


def main(argv: Optional[List[str]] = None) -> int:
    args = _parse_cli_args(argv if argv is not None else sys.argv[1:])

    if args.no_gui:
        return run_cli(_opts_from_args(args))

    # 延迟 import，避免 --no-gui 模式仍把 tk 拖进 frozen 包导致体积/启动开销
    from .gui import main as gui_main

    return gui_main()
