#!/usr/bin/env python3
"""本地 DrissionPage helper 命令行入口（兼容跳转）。

历史上完整逻辑住在这个文件里，471 行。为了支持桌面 GUI + PyInstaller 打包，
核心代码在 0.4.0 之后被抽到 desktop/helper_app/server.py，本文件保留作为
**老用户的命令行入口**：所有命令行参数 1:1 兼容老版本，行为完全一致。

变更总结（对老用户透明）:
- 启动方式不变：python3 scripts/drissionpage_helper.py [...args]
- 监听端口、--headless / --browser-address / --user-data-path 等所有参数不变
- 输出日志格式不变
- /health 和 /scrape 接口契约不变
- 新增 /version 接口（轻量返回版本号，不拉浏览器）

桌面 GUI 用户请下载预编译的 Runbi Helper.app / .exe，不用关心这个脚本。
"""

from __future__ import annotations

import argparse
import os
import sys
from pathlib import Path

# 把仓库根加入 sys.path，让 `from desktop.helper_app...` 这样的 import 能 work
REPO_ROOT = Path(__file__).resolve().parents[1]
if str(REPO_ROOT) not in sys.path:
    sys.path.insert(0, str(REPO_ROOT))

from desktop.helper_app.config import (
    DEFAULT_HOST,
    DEFAULT_PORT,
    DEFAULT_TIMEOUT_MS,
    load_or_create_helper_token,
)
from desktop.helper_app.server import RuntimeOptions, run_cli


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="本地 DrissionPage 抓取 helper")
    parser.add_argument("--host", default=DEFAULT_HOST, help="监听地址，默认 127.0.0.1")
    parser.add_argument(
        "--port", type=int, default=DEFAULT_PORT, help="监听端口，默认 7788"
    )
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
    parser.add_argument(
        "--auth-token",
        default=None,
        help=(
            "本地 helper 的 token；不传 = 从持久化文件读取/自动生成；"
            '传空字符串 "" = 显式关闭鉴权（仅推荐内网无人值守场景）。'
        ),
    )
    parser.add_argument(
        "--allow-private-hosts",
        action="store_true",
        help=(
            "允许 helper 抓取 127.0.0.1 / 10.0.0.0/8 等私网地址。"
            "默认禁止以阻断 SSRF；只在你确认要抓本地服务时再开。"
        ),
    )
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    if args.auth_token is None:
        token = load_or_create_helper_token()
    else:
        token = args.auth_token.strip()
    opts = RuntimeOptions(
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
        auth_token=token,
        allow_private_hosts=bool(args.allow_private_hosts),
    )
    return run_cli(opts)


if __name__ == "__main__":
    sys.exit(main())
