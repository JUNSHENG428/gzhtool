"""通过 GitHub Release API 检查桌面助手是否有新版本。

设计目标：
- 不引入额外依赖，只用 stdlib 的 urllib（PyInstaller 包尺寸不增加）
- 5 秒超时，永远不阻塞主线程，永远不抛
- 返回结构化结果，GUI 决定怎么展示
"""

from __future__ import annotations

import json
import re
import threading
from dataclasses import dataclass
from typing import Callable, Optional
from urllib.error import URLError
from urllib.request import Request, urlopen

from .config import GITHUB_RELEASE_REPO, RELEASE_TAG_PREFIX
from .version import __version__


@dataclass
class UpdateInfo:
    has_update: bool
    current: str
    latest: str = ""
    html_url: str = ""
    notes: str = ""
    error: str = ""


def _semver_tuple(v: str) -> tuple:
    """非常宽松的 SemVer 解析，比较够用。非数字段全部当 0。"""
    parts = re.split(r"[^\d]+", v.strip())
    nums = []
    for p in parts:
        if not p:
            continue
        try:
            nums.append(int(p))
        except ValueError:
            nums.append(0)
        if len(nums) >= 3:
            break
    while len(nums) < 3:
        nums.append(0)
    return tuple(nums)


def _strip_prefix(tag: str) -> str:
    if tag.startswith(RELEASE_TAG_PREFIX):
        return tag[len(RELEASE_TAG_PREFIX) :]
    return tag.lstrip("v")


def check_for_update_sync(timeout_sec: float = 5.0) -> UpdateInfo:
    """同步检查；GUI 不要直接调用，套一层线程更安全。"""
    if not GITHUB_RELEASE_REPO:
        return UpdateInfo(
            has_update=False,
            current=__version__,
            error="未配置 GITHUB_RELEASE_REPO，跳过检查。",
        )

    url = f"https://api.github.com/repos/{GITHUB_RELEASE_REPO}/releases"
    req = Request(url, headers={"User-Agent": "RunbiHelper-Updater"})
    try:
        with urlopen(req, timeout=timeout_sec) as resp:
            payload = json.loads(resp.read().decode("utf-8") or "[]")
    except URLError as exc:
        return UpdateInfo(
            has_update=False, current=__version__, error=f"网络请求失败：{exc}"
        )
    except Exception as exc:
        return UpdateInfo(has_update=False, current=__version__, error=str(exc))

    if not isinstance(payload, list):
        return UpdateInfo(
            has_update=False, current=__version__, error="GitHub 返回结构异常。"
        )

    latest = ""
    latest_tuple = (0, 0, 0)
    latest_payload = None
    for item in payload:
        tag = str(item.get("tag_name") or "")
        # 只看带 helper 前缀的，避免与浏览器扩展的 release 混淆
        if not tag.startswith(RELEASE_TAG_PREFIX):
            continue
        if item.get("draft") or item.get("prerelease"):
            continue
        version = _strip_prefix(tag)
        version_tuple = _semver_tuple(version)
        if version_tuple > latest_tuple:
            latest_tuple = version_tuple
            latest = version
            latest_payload = item

    if not latest:
        return UpdateInfo(
            has_update=False, current=__version__, error="未发现 helper Release。"
        )

    has_update = latest_tuple > _semver_tuple(__version__)
    return UpdateInfo(
        has_update=has_update,
        current=__version__,
        latest=latest,
        html_url=str((latest_payload or {}).get("html_url") or ""),
        notes=str((latest_payload or {}).get("body") or "")[:1000],
    )


def check_for_update_async(callback: Callable[[UpdateInfo], None]) -> threading.Thread:
    """后台线程检查，通过 callback 把结果回传给 GUI。callback 不能抛。"""

    def _runner() -> None:
        info = check_for_update_sync()
        try:
            callback(info)
        except Exception:  # noqa: BLE001 - 守护 GUI 线程
            pass

    thread = threading.Thread(target=_runner, daemon=True, name="updater-check")
    thread.start()
    return thread


__all__ = [
    "UpdateInfo",
    "check_for_update_sync",
    "check_for_update_async",
]
