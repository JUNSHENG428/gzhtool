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


def app_config_dir() -> Path:
    """跨平台用户级配置目录，存放 helper_token.txt 等持久化的安全凭据。

    选择"用户级"而不是仓库内：
    - 仓库内可能被多端共享/被 git 误提交，token 反而泄漏；
    - 用户级目录天然单机，重装 helper 不丢；
    - 与日志目录拆开，方便用户「只清缓存日志、保留 token」。

    路径策略与 app_log_dir 对齐：
    - mac: ~/Library/Application Support/Runbi Helper
    - win: %APPDATA%/Runbi Helper
    - linux/其它: ~/.runbi-helper
    """
    home = Path.home()
    if sys.platform == "darwin":
        path = home / "Library" / "Application Support" / APP_NAME_EN
    elif sys.platform == "win32":
        base = os.environ.get("APPDATA") or str(home)
        path = Path(base) / APP_NAME_EN
    else:
        path = home / ".runbi-helper"
    path.mkdir(parents=True, exist_ok=True)
    return path


def helper_token_path() -> Path:
    """token 文件位置。GUI / CLI 启动时如不存在则懒生成。"""
    return app_config_dir() / "helper_token.txt"


def load_or_create_helper_token(force_new: bool = False) -> str:
    """读取持久化 token，若不存在则生成 32 字节十六进制串并落盘（mode=0600）。

    设计要点：
    - 对老用户透明：第一次启动时静默生成，扩展端首次连接拿不到 401 后引导用户「在 GUI 里复制完整地址」。
    - token 是高熵的，本地暴露给本机 Chrome 扩展即可，不参与远端鉴权。
    - 用户也可以走 `--auth-token ""` 显式关闭鉴权（兼容老用户）。
    """
    import secrets

    path = helper_token_path()
    if not force_new and path.exists():
        try:
            token = path.read_text(encoding="utf-8").strip()
        except Exception:
            token = ""
        if token:
            return token

    token = secrets.token_hex(32)
    try:
        path.write_text(token, encoding="utf-8")
        # POSIX 上设成 600，Windows 没有 chmod 概念会无声忽略
        try:
            os.chmod(path, 0o600)
        except OSError:
            pass
    except OSError:
        # 写不了文件就退化为「内存内 token」：本次启动有效，下次重启会换。
        # 比抛异常导致 helper 起不来更对用户友好。
        pass
    return token
