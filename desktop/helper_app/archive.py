"""把 /scrape 的 capture 结果归档到 ~/Documents/Runbi/Inbox/ 为 markdown。

设计：
- 永不抛错（写失败只 logging.warning），不阻塞 /scrape 响应
- 同步写小文件（每篇 markdown < 100KB，写盘 < 5ms 不影响用户感知）
- 文件名：{YYYY-MM-DD HH-MM} {title前30字}.md，重名加 -1 -2 后缀
- 内容：YAML front matter（site/author/url/captured_at）+ markdown body
- 转换：blocks 已结构化（paragraph/heading/image/quote/code/list/table），
  逐 block 翻译到 markdown 语法，**无需引入 html2text 等新依赖**（PyInstaller 包大小不增加）

调用方：server.py do_POST /scrape 成功路径 + gui.py 批量抓取（B5）
"""

from __future__ import annotations

import logging
import re
from datetime import datetime
from pathlib import Path
from typing import Optional


def inbox_dir() -> Path:
    """跨平台 Inbox 目录：
    - mac/linux: ~/Documents/Runbi/Inbox
    - win:      %USERPROFILE%\\Documents\\Runbi\\Inbox
    - 极旧/无 Documents 目录的 Linux：~/Runbi/Inbox 兜底
    """
    home = Path.home()
    docs = home / "Documents"
    base = docs if docs.exists() else home
    target = base / "Runbi" / "Inbox"
    target.mkdir(parents=True, exist_ok=True)
    return target


def archive_capture(capture: dict, source_url: str = "") -> Optional[Path]:
    """归档一个 capture 到 Inbox。永不抛错。

    Returns:
        写入的文件路径；失败或 capture 为空时返回 None
    """
    if not isinstance(capture, dict):
        return None
    blocks = capture.get("blocks")
    if not isinstance(blocks, list) or not blocks:
        return None

    try:
        title = str(capture.get("title") or "").strip() or "未命名"
        ts = datetime.now()
        prefix = ts.strftime("%Y-%m-%d %H-%M")
        safe_title = _sanitize_filename(title[:30])
        filename = f"{prefix} {safe_title}.md"

        path = inbox_dir() / filename
        # 同分钟内重名加后缀（极少触发，但批量抓取时可能命中）
        if path.exists():
            for i in range(1, 100):
                alt = inbox_dir() / f"{prefix} {safe_title}-{i}.md"
                if not alt.exists():
                    path = alt
                    break

        body = capture_to_markdown(capture, source_url, captured_at=ts)
        path.write_text(body, encoding="utf-8")
        logging.info("[archive] 已归档 → %s", path)
        return path
    except Exception:
        logging.warning("[archive] 归档写入失败", exc_info=True)
        return None


def capture_to_markdown(
    capture: dict, source_url: str = "", captured_at: Optional[datetime] = None
) -> str:
    """capture（含 blocks）→ markdown 字符串。

    输出格式：
        # 文章标题

        ---
        site: 来源站名
        author: 作者
        url: 原文链接
        captured_at: 2026-05-09T14:30:00
        via: Runbi Helper
        ---

        正文段落...

        ## 二级标题

        > 引用段
        ...
    """
    title = str(capture.get("title") or "").strip() or "未命名"
    site = str(capture.get("siteName") or "").strip()
    author = str(capture.get("author") or "").strip()
    url = str(source_url or capture.get("url") or "").strip()
    when = (captured_at or datetime.now()).isoformat(timespec="seconds")

    parts: list[str] = [f"# {title}", ""]

    # YAML front matter（only fields we have）
    parts.append("---")
    if site:
        parts.append(f"site: {_yaml_escape(site)}")
    if author:
        parts.append(f"author: {_yaml_escape(author)}")
    if url:
        parts.append(f"url: {url}")
    parts.append(f"captured_at: {when}")
    parts.append("via: Runbi Helper")
    parts.append("---")
    parts.append("")

    for block in capture.get("blocks") or []:
        if not isinstance(block, dict):
            continue
        bt = block.get("type")
        if bt == "paragraph":
            text = str(block.get("text") or "").strip()
            if text:
                parts.append(text)
                parts.append("")
        elif bt == "heading":
            # 限制 level 到 h2-h6（h1 已被 title 占用）
            level = max(2, min(6, int(block.get("level") or 2)))
            text = str(block.get("text") or "").strip()
            if text:
                parts.append(f"{'#' * level} {text}")
                parts.append("")
        elif bt == "image":
            src = str(block.get("src") or "").strip()
            alt = str(block.get("alt") or "").strip() or "图片"
            caption = str(block.get("caption") or "").strip()
            if src:
                parts.append(f"![{_md_escape(alt)}]({src})")
                if caption:
                    parts.append(f"*{caption}*")
                parts.append("")
        elif bt == "quote":
            text = str(block.get("text") or "").strip()
            if text:
                for line in text.splitlines():
                    parts.append(f"> {line}")
                parts.append("")
        elif bt == "code":
            lang = str(block.get("language") or "").strip()
            code = str(block.get("text") or "")
            parts.append(f"```{lang}")
            parts.append(code)
            parts.append("```")
            parts.append("")
        elif bt == "list":
            ordered = bool(block.get("ordered"))
            items = block.get("items") or []
            for i, item in enumerate(items, 1):
                marker = f"{i}." if ordered else "-"
                parts.append(f"{marker} {str(item).strip()}")
            parts.append("")
        elif bt == "table":
            headers = block.get("headers") or []
            rows = block.get("rows") or []
            if headers:
                parts.append("| " + " | ".join(str(h) for h in headers) + " |")
                parts.append("|" + "|".join(" --- " for _ in headers) + "|")
            for row in rows:
                if isinstance(row, list):
                    parts.append("| " + " | ".join(str(c) for c in row) + " |")
            parts.append("")

    return "\n".join(parts).rstrip() + "\n"


# 文件名非法字符（mac/win/linux 综合）
_FILENAME_BAD = re.compile(r'[\\/:*?"<>|\n\r\t]')


def _sanitize_filename(name: str) -> str:
    cleaned = _FILENAME_BAD.sub("", name).strip()
    # 文件名末尾不能是 . 或 空格（Windows）
    cleaned = cleaned.rstrip(". ")
    return cleaned or "untitled"


def _yaml_escape(s: str) -> str:
    """YAML front matter value：含 : 或前导特殊字符时加引号。"""
    if not s:
        return '""'
    if any(c in s for c in ":#&*!|>'\"%@`") or s.startswith(("- ", "? ")):
        return '"' + s.replace('\\', '\\\\').replace('"', '\\"') + '"'
    return s


def _md_escape(s: str) -> str:
    """markdown alt text 等位置的转义：[ ] 转义防止误关闭。"""
    return s.replace("[", "\\[").replace("]", "\\]")


__all__ = [
    "inbox_dir",
    "archive_capture",
    "capture_to_markdown",
]
