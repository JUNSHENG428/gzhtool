"""桌面助手应用层常量。

要改产品名 / bundle id / 默认端口 / 更新检查源，只改这一个文件。
"""

from __future__ import annotations

import os
import sys
from pathlib import Path


# —— 产品标识 —— #
APP_NAME_EN = "Runbi Helper"
APP_NAME_ZH = "润笔助手"
# mac bundle id（必须是反向域名格式；改这里要同步改 PyInstaller spec 的 bundle_identifier）
BUNDLE_ID = "com.docuearn.helper"
# Windows 注册表/快捷方式标识
WIN_APP_ID = "Docuearn.RunbiHelper"

# —— 服务默认值 —— #
DEFAULT_HOST = "127.0.0.1"
DEFAULT_PORT = 7788
DEFAULT_TIMEOUT_MS = 30000

# —— 更新检查 —— #
# 用 GitHub Release API 拉最新版本（不需要自建 endpoint）。
# 优先读环境变量（方便 fork 用户自己改），缺省回落到当前仓库。
GITHUB_RELEASE_REPO = os.environ.get("RUNBI_HELPER_REPO") or "JUNSHENG428/gzhtool"
# Release tag 前缀，避免和扩展 release 混。例如 helper-v0.1.0
RELEASE_TAG_PREFIX = "helper-v"

# —— 路径 —— #
def is_frozen() -> bool:
    """PyInstaller 打包后 sys.frozen=True，并通过 sys._MEIPASS 暴露资源目录。"""
    return getattr(sys, "frozen", False)


def resource_root() -> Path:
    """返回打包资源根目录。

    - 打包后：sys._MEIPASS（PyInstaller 临时解压目录）
    - 开发模式：仓库根目录（desktop 的上一级）
    """
    if is_frozen():
        meipass = getattr(sys, "_MEIPASS", None)
        if meipass:
            return Path(meipass)
    # 开发模式：desktop/helper_app/config.py → 仓库根
    return Path(__file__).resolve().parents[2]


def scrape_script_path() -> Path:
    """前端注入脚本（与浏览器扩展 content-script 共用同一份源）的绝对路径。

    打包时通过 PyInstaller spec 的 datas 把这个文件以
    `src/content-scripts/scrape-article.js` 的相对路径塞进资源根目录，
    这里就能用同一段代码同时支持开发模式和打包后模式。
    """
    return resource_root() / "src" / "content-scripts" / "scrape-article.js"


def app_log_dir() -> Path:
    """跨平台用户级日志目录，给 GUI 写日志、给用户排查问题用。

    - mac: ~/Library/Logs/Runbi Helper
    - win: %LOCALAPPDATA%/Runbi Helper/Logs
    - linux/其它: ~/.runbi-helper/logs
    """
    home = Path.home()
    if sys.platform == "darwin":
        path = home / "Library" / "Logs" / APP_NAME_EN
    elif sys.platform == "win32":
        base = os.environ.get("LOCALAPPDATA") or str(home)
        path = Path(base) / APP_NAME_EN / "Logs"
    else:
        path = home / ".runbi-helper" / "logs"
    path.mkdir(parents=True, exist_ok=True)
    return path
