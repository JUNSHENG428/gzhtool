#!/usr/bin/env python3
"""JD 正文净化提取模块。

针对 Boss 直聘等招聘网站 JD 详情页的三类反爬/防复制机制，提供绕过方案：

- 模块一：CSS 隐藏元素过滤 —— 剔除 display:none / visibility:hidden /
  font-size≈0 / opacity≈0 / 绝对定位偏移屏幕外的干扰节点。
- 模块二：z-index 遮罩识别 —— 通过 elementFromPoint 判断某段文字在视觉上
  是否真的处于最上层，排除被透明遮罩覆盖、或反过来只是遮罩本身的内容。
- 模块三：自定义字体反爬还原 —— 检测非常规命名的 @font-face，下载字体文件，
  用字形位图哈希比对，反查"加密编码 -> 真实字符"映射表并还原文本。

对外主接口：extract_clean_jd(ele)。

注意：本模块仅用于个人学习与数据分析研究，请遵守目标网站的服务条款与
robots 协议，不要用于商业性批量采集，并保留原有的随机延时/滚动模拟策略。
"""

from __future__ import annotations

import hashlib
import io
import json
import logging
import os
import re
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Callable, Iterable, Optional
from urllib.parse import urljoin, urlparse

logger = logging.getLogger("jd_extractor")

CACHE_DIR = Path(__file__).resolve().parent / "font_cache"
CACHE_DIR.mkdir(parents=True, exist_ok=True)

# ---------------------------------------------------------------------------
# 通用小工具
# ---------------------------------------------------------------------------


def normalize_text(text: str) -> str:
    """去除多余空行、统一换行符、收敛行内多余空白。"""

    text = text.replace("\r\n", "\n").replace("\r", "\n")
    lines = [re.sub(r"[ \t\u3000]+", " ", line).strip() for line in text.split("\n")]
    cleaned: list[str] = []
    blank_run = 0
    for line in lines:
        if line == "":
            blank_run += 1
            if blank_run > 1:
                continue
        else:
            blank_run = 0
        cleaned.append(line)
    return "\n".join(cleaned).strip("\n")


def _normalize_font_family(raw: str) -> str:
    """从 `"BossFont", -apple-system, sans-serif` 这类声明里取出第一个字体名。"""

    if not raw:
        return ""
    first = raw.split(",")[0]
    return first.strip().strip('"').strip("'").lower()


# ---------------------------------------------------------------------------
# 模块一 + 模块二：可见文本提取（CSS 隐藏过滤 + z-index 遮罩识别）
# ---------------------------------------------------------------------------
#
# 两个模块都需要"活页面"的 getComputedStyle / getBoundingClientRect /
# elementFromPoint 实时几何信息，因此合并成一次 run_js 调用完成，
# 避免逐节点往返 Python<->浏览器 拖慢速度（验收要求：单页新增耗时 <1s）。

_EXTRACT_VISIBLE_SEGMENTS_JS = r"""
(function (container) {
  var BLOCK_TAGS = {
    P: 1, DIV: 1, LI: 1, UL: 1, OL: 1, H1: 1, H2: 1, H3: 1, H4: 1, H5: 1,
    H6: 1, SECTION: 1, ARTICLE: 1, TABLE: 1, TR: 1, HR: 1
  };
  var OFFSCREEN_MARGIN = 50;
  var out = [];

  function isCssHidden(style) {
    // 模块一：display / visibility / font-size / opacity 隐藏判定
    if (style.display === 'none') return true;
    if (style.visibility === 'hidden' || style.visibility === 'collapse') return true;
    var fontSize = parseFloat(style.fontSize);
    if (!isNaN(fontSize) && fontSize <= 1) return true;
    var opacity = parseFloat(style.opacity);
    if (!isNaN(opacity) && opacity <= 0.05) return true;
    return false;
  }

  function isOffscreen(el, style) {
    if (style.position !== 'absolute' && style.position !== 'fixed') return false;
    var rect = el.getBoundingClientRect();
    if (rect.width === 0 && rect.height === 0) return false;
    if (rect.right < -OFFSCREEN_MARGIN || rect.bottom < -OFFSCREEN_MARGIN) return true;
    var vw = window.innerWidth || document.documentElement.clientWidth || 0;
    if (rect.left > vw + 2000 || rect.top > 20000) return true;
    return false;
  }

  function isMaskedAtPoint(ownerEl, rect) {
    // 模块二：取文字节点包围盒中心点，用 elementFromPoint 反查最终视觉最上层
    // 的元素。关键判断依据（对应需求里的"遮罩通常无文字内容"）：
    //   - 如果最上层元素自己没有任何文字内容，说明它只是一个用来劫持鼠标
    //     选中/点击的透明层，并不会挡住底下文字的"视觉"呈现 —— 这种情况
    //     不应该把真实文字排除掉。
    //   - 如果最上层元素自己就带有实打实的文字内容，说明它才是真正视觉上
    //     盖住这块区域的那一层，此时才应该把被压在下面的文字排除。
    if (rect.width <= 0 || rect.height <= 0) return false;
    var vw = window.innerWidth || document.documentElement.clientWidth || 0;
    var vh = window.innerHeight || document.documentElement.clientHeight || 0;
    var cx = Math.min(Math.max(rect.left + rect.width / 2, 0), vw - 1);
    var cy = Math.min(Math.max(rect.top + rect.height / 2, 0), vh - 1);
    if (cx < 0 || cy < 0 || cx >= vw || cy >= vh) return false;
    var topEl = document.elementFromPoint(cx, cy);
    if (!topEl) return false;
    if (topEl === ownerEl || ownerEl.contains(topEl) || topEl.contains(ownerEl)) return false;
    var topText = (topEl.textContent || '').trim();
    if (topText === '') return false;
    var topStyle = window.getComputedStyle(topEl);
    if (topStyle.pointerEvents === 'none') return false;
    return true;
  }

  function walk(node) {
    if (node.nodeType === Node.TEXT_NODE) {
      var text = node.nodeValue;
      if (!text || !text.trim()) return;
      var parent = node.parentElement;
      if (!parent) return;
      var style = window.getComputedStyle(parent);
      if (isCssHidden(style) || isOffscreen(parent, style)) return;
      var range = document.createRange();
      range.selectNodeContents(node);
      var rect = range.getBoundingClientRect();
      range.detach && range.detach();
      if (isMaskedAtPoint(parent, rect)) return;
      out.push({ t: text, f: style.fontFamily || '' });
      return;
    }
    if (node.nodeType !== Node.ELEMENT_NODE) return;
    var el = node;
    var style = window.getComputedStyle(el);
    if (isCssHidden(style) || isOffscreen(el, style)) return;
    var tag = el.tagName;
    if (tag === 'BR') { out.push({ b: 1 }); return; }
    if (tag === 'SCRIPT' || tag === 'STYLE' || tag === 'NOSCRIPT') return;
    var isBlock = !!BLOCK_TAGS[tag] || style.display === 'block' ||
      style.display === 'list-item' || style.display === 'table-row';
    if (isBlock) out.push({ b: 1 });
    var children = el.childNodes;
    for (var i = 0; i < children.length; i++) walk(children[i]);
    if (isBlock) out.push({ b: 1 });
  }

  walk(container);
  return JSON.stringify(out);
})
"""


@dataclass
class TextSegment:
    text: str
    font_family: str


def get_visible_segments(ele) -> list[dict]:
    """对 JD 容器元素跑一次 JS，拿到"已过滤隐藏节点 + 已排除遮罩层"的
    原始片段序列（保留字体信息与换行标记，供后续模块三还原/格式化用）。

    ele: DrissionPage 的 ChromiumElement（JD 正文容器，如 .job-sec-text）。
    """

    raw = ele.run_js(f"return ({_EXTRACT_VISIBLE_SEGMENTS_JS})(this);")
    if raw is None:
        return []
    if isinstance(raw, str):
        try:
            return json.loads(raw)
        except json.JSONDecodeError:
            logger.warning("解析可见文本片段 JSON 失败，原始返回: %r", raw[:200])
            return []
    # 某些 DrissionPage 版本会自动把 JSON 字符串解析成 Python 对象
    if isinstance(raw, list):
        return raw
    return []


def segments_to_text(segments: Iterable[dict], font_mappings: Optional[dict] = None) -> str:
    """把 JS 提取到的片段序列拼回文本；若提供了 font_mappings
    （font_family -> {加密字符: 真实字符}），顺带做模块三的字体还原。"""

    font_mappings = font_mappings or {}
    parts: list[str] = []
    for seg in segments:
        if seg.get("b"):
            parts.append("\n")
            continue
        text = seg.get("t", "")
        family = _normalize_font_family(seg.get("f", ""))
        mapping = font_mappings.get(family)
        if mapping:
            text = "".join(mapping.get(ch, ch) for ch in text)
        parts.append(text)
    return "".join(parts)


# ---------------------------------------------------------------------------
# 模块三：自定义字体反爬还原
# ---------------------------------------------------------------------------

_COMMON_FONT_KEYWORDS = (
    "arial", "helvetica", "pingfang", "microsoft", "yahei", "simsun",
    "simhei", "source han", "noto", "roboto", "segoe", "hiragino",
    "stheiti", "droid", "sans-serif", "serif", "monospace", "system-ui",
    "-apple-system", "tahoma", "verdana", "georgia", "times", "苹方",
    "微软雅黑", "黑体", "宋体",
)

_FIND_FONT_FACES_JS = r"""
(function () {
  var out = [];
  var sheets = document.styleSheets;
  for (var i = 0; i < sheets.length; i++) {
    var rules;
    try { rules = sheets[i].cssRules || sheets[i].rules; } catch (e) { continue; }
    if (!rules) continue;
    for (var j = 0; j < rules.length; j++) {
      var rule = rules[j];
      // 新版 Chrome 已经不再暴露 CSSRule.FONT_FACE_RULE 这个数字常量，
      // 优先用 instanceof 判断，兼容旧引擎再退回 rule.type === 5。
      var isFontFace = (typeof CSSFontFaceRule !== 'undefined' && rule instanceof CSSFontFaceRule) ||
        rule.type === 5;
      if (isFontFace) {
        var family = (rule.style.getPropertyValue('font-family') || '')
          .replace(/["']/g, '').trim();
        var src = rule.style.getPropertyValue('src') || '';
        out.push({ family: family, src: src });
      }
    }
  }
  return JSON.stringify(out);
})
"""

_URL_RE = re.compile(r"url\((['\"]?)([^'\")]+)\1\)")


@dataclass
class FontFace:
    family: str
    url: str


def find_font_faces(page) -> list[FontFace]:
    """扫描当前页面所有样式表里的 @font-face 规则，解析出 font-family
    与字体文件 url（已转换为绝对地址）。"""

    raw = page.run_js(f"return ({_FIND_FONT_FACES_JS})();")
    if isinstance(raw, str):
        try:
            entries = json.loads(raw)
        except json.JSONDecodeError:
            return []
    elif isinstance(raw, list):
        entries = raw
    else:
        entries = []

    result: list[FontFace] = []
    base_url = getattr(page, "url", "") or ""
    for entry in entries:
        family = (entry.get("family") or "").strip()
        src = entry.get("src") or ""
        urls = _URL_RE.findall(src)
        for _, raw_url in urls:
            if raw_url.startswith("data:"):
                continue
            abs_url = urljoin(base_url, raw_url)
            result.append(FontFace(family=family, url=abs_url))
    return result


def looks_like_obfuscated_font(font_face: FontFace) -> bool:
    """启发式判断某个 @font-face 是否"非常规命名"、疑似反爬加密字体。

    规则：
    - font-family 命中常见字体关键字（Arial / 苹方 / 微软雅黑 等）-> 认为是正常字体。
    - 否则：文件名或字体名看起来像随机哈希/无语义字符串 -> 判定为可疑加密字体。

    这是启发式规则，可能有极少数误判（比如网站真的用了小众品牌字体）。
    调用方可以通过 extract_clean_jd(font_family_filter=...) 自定义覆盖判断。
    """

    fam_lower = font_face.family.lower()
    if any(k in fam_lower for k in _COMMON_FONT_KEYWORDS):
        return False
    basename = os.path.basename(urlparse(font_face.url).path)
    name_no_ext = os.path.splitext(basename)[0]
    if re.fullmatch(r"[a-f0-9]{6,}", name_no_ext, re.IGNORECASE):
        return True
    if re.fullmatch(r"[a-zA-Z0-9_\-]{4,}", fam_lower):
        return True
    return True


def download_font_bytes(page, url: str, session=None, timeout: float = 15.0) -> bytes:
    """下载字体文件二进制内容。优先复用页面 cookies（部分站点校验来源）。"""

    import requests

    sess = session or requests.Session()
    headers = {
        "User-Agent": (
            "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
            "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36"
        ),
        "Referer": getattr(page, "url", "") or "",
    }
    try:
        cookies = {c["name"]: c["value"] for c in page.cookies()}
    except Exception:
        cookies = {}
    resp = sess.get(url, headers=headers, cookies=cookies, timeout=timeout)
    resp.raise_for_status()
    return resp.content


def _convert_to_ttf_bytes(font_bytes: bytes) -> bytes:
    """woff/woff2/ttf/otf 统一转成标准 sfnt(ttf)，供 PIL 渲染字形用。"""

    from fontTools.ttLib import TTFont

    font = TTFont(io.BytesIO(font_bytes), lazy=True)
    if font.flavor is not None:
        font.flavor = None
    buf = io.BytesIO()
    font.save(buf)
    return buf.getvalue()


# --- 字形位图哈希（dHash）比对，用于反查加密编码 -> 真实字符 -------------

_DEFAULT_CANDIDATE_CHARS = "0123456789.,%+-·/年月日周天时分~"
_DEFAULT_REFERENCE_FONT_CANDIDATES = (
    "/System/Library/Fonts/Supplemental/Arial.ttf",
    "/System/Library/Fonts/Helvetica.ttc",
    "/System/Library/Fonts/PingFang.ttc",
    "C:/Windows/Fonts/msyh.ttc",
    "C:/Windows/Fonts/arial.ttf",
    "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
)


def _pick_default_reference_font() -> Optional[str]:
    for path in _DEFAULT_REFERENCE_FONT_CANDIDATES:
        if Path(path).exists():
            return path
    return None


def _render_glyph(font_path: str, codepoint: int, size: int = 96, font_number: int = 0):
    from PIL import Image, ImageDraw, ImageFont

    try:
        pil_font = ImageFont.truetype(font_path, size=int(size * 0.8), index=font_number)
    except Exception as exc:
        logger.debug("加载参考字体失败 %s: %s", font_path, exc)
        return None

    ch = chr(codepoint)
    img = Image.new("L", (size, size), 255)
    draw = ImageDraw.Draw(img)
    try:
        bbox = draw.textbbox((0, 0), ch, font=pil_font)
    except Exception:
        return None
    w, h = bbox[2] - bbox[0], bbox[3] - bbox[1]
    if w <= 0 or h <= 0:
        return None
    x = (size - w) // 2 - bbox[0]
    y = (size - h) // 2 - bbox[1]
    draw.text((x, y), ch, font=pil_font, fill=0)
    return img


def _dhash(img, hash_size: int = 24) -> list[bool]:
    small = img.resize((hash_size + 1, hash_size)).convert("L")
    pixels = list(small.getdata())
    bits: list[bool] = []
    for row in range(hash_size):
        offset = row * (hash_size + 1)
        row_pixels = pixels[offset:offset + hash_size + 1]
        for col in range(hash_size):
            bits.append(row_pixels[col] > row_pixels[col + 1])
    return bits


def _hamming(a: list[bool], b: list[bool]) -> int:
    return sum(1 for x, y in zip(a, b) if x != y)


# Unicode 私有使用区（Private Use Area）。反爬加密字体几乎总是把"乱码编码"
# 分配在这几个区间——因为 PUA 保证不会跟任何真实字符冲突，这也是这类字体
# 反爬手法之所以敢"乱分配编码"还不破坏其它正常文字渲染的原因。
# 只对落在 PUA 里的编码点做字形比对/替换，天然避免误伤字体里恰好包含的
# 普通 ASCII/CJK 字形（比如同一个 @font-face 里顺带带了几个西文字母）。
_PUA_RANGES = ((0xE000, 0xF8FF), (0xF0000, 0xFFFFD), (0x100000, 0x10FFFD))


def is_private_use_codepoint(codepoint: int) -> bool:
    return any(lo <= codepoint <= hi for lo, hi in _PUA_RANGES)


def build_font_mapping(
    ttf_path: str,
    reference_font_path: Optional[str] = None,
    candidate_chars: str = _DEFAULT_CANDIDATE_CHARS,
    match_threshold: int = 60,
    only_private_use_area: bool = True,
) -> dict[str, str]:
    """解析加密字体的 cmap，把每个私有编码字形渲染成位图，
    用 dHash 与"标准字体渲染出的候选真实字符"做最近邻比对，
    重建"加密字符 -> 真实字符"映射表。

    这是一种通用的、不依赖硬编码映射的字形比对方案：只要目标网站
    重新生成了字体文件（换了 codepoint 排布），只要视觉形状不变，
    这里都能重新推导出正确映射，天然支持"增量更新"。

    only_private_use_area: 默认只对 Unicode 私有使用区（PUA）编码点做字形
    还原——这既是真实反爬字体的实现特征，也避免误伤字体里恰好包含的普通
    ASCII/CJK 字形（例如同一份字体顺带带了几个西文字母的字形数据）。

    局限：候选字符集合默认只覆盖数字/常见符号（薪资等场景足够），
    如果 JD 正文里更大范围的汉字也被加密，需要扩展 candidate_chars，
    并且比对准确率会随字符集增大而下降（详见 README 已知局限）。
    """

    from fontTools.ttLib import TTFont

    reference_font_path = reference_font_path or _pick_default_reference_font()
    if not reference_font_path:
        logger.warning("找不到可用的参考字体，无法构建字体映射表")
        return {}

    ref_hashes: dict[str, list[bool]] = {}
    for ch in candidate_chars:
        img = _render_glyph(reference_font_path, ord(ch))
        if img is not None:
            ref_hashes[ch] = _dhash(img)

    tt = TTFont(ttf_path, lazy=True)
    try:
        cmap = tt.getBestCmap() or {}
    except Exception as exc:
        logger.warning("解析加密字体 cmap 失败: %s", exc)
        return {}

    mapping: dict[str, str] = {}
    for codepoint in cmap:
        if only_private_use_area and not is_private_use_codepoint(codepoint):
            continue
        img = _render_glyph(ttf_path, codepoint)
        if img is None:
            continue
        glyph_hash = _dhash(img)
        best_char, best_dist = None, None
        for ch, ref_hash in ref_hashes.items():
            dist = _hamming(glyph_hash, ref_hash)
            if best_dist is None or dist < best_dist:
                best_dist, best_char = dist, ch
        if best_char is not None and best_dist is not None and best_dist <= match_threshold:
            mapping[chr(codepoint)] = best_char
    return mapping


# --- 缓存层：按字体文件内容哈希做增量更新 ----------------------------------


def _cache_paths(content_hash: str) -> tuple[Path, Path]:
    return (
        CACHE_DIR / f"{content_hash}.ttf",
        CACHE_DIR / f"{content_hash}.json",
    )


def get_or_build_font_mapping(
    font_bytes: bytes,
    font_url: str = "",
    reference_font_path: Optional[str] = None,
    max_age_hours: float = 24.0,
    force_rebuild: bool = False,
) -> dict[str, str]:
    """字体映射表的缓存入口。

    缓存 key 是字体文件内容的 sha256（不是 url）——Boss 直聘等站点更换
    映射表时字体文件内容必然变化，所以内容哈希天然实现"文件一变就重建"，
    不需要手动维护过期规则；max_age_hours 只是兜底的定期刷新兜底策略。
    """

    content_hash = hashlib.sha256(font_bytes).hexdigest()[:20]
    ttf_path, meta_path = _cache_paths(content_hash)

    if not force_rebuild and meta_path.exists():
        try:
            meta = json.loads(meta_path.read_text(encoding="utf-8"))
            age = time.time() - meta.get("built_at", 0)
            if age < max_age_hours * 3600:
                logger.debug("命中字体映射缓存 %s（age=%.0fs）", content_hash, age)
                return meta.get("mapping", {})
        except (json.JSONDecodeError, OSError):
            pass

    if not ttf_path.exists():
        try:
            ttf_bytes = _convert_to_ttf_bytes(font_bytes)
        except Exception as exc:
            logger.warning("字体转换为 ttf 失败（%s），跳过还原: %s", font_url, exc)
            return {}
        ttf_path.write_bytes(ttf_bytes)

    mapping = build_font_mapping(str(ttf_path), reference_font_path=reference_font_path)
    meta_path.write_text(
        json.dumps(
            {
                "built_at": time.time(),
                "font_url": font_url,
                "content_hash": content_hash,
                "mapping_size": len(mapping),
                "mapping": mapping,
            },
            ensure_ascii=False,
            indent=2,
        ),
        encoding="utf-8",
    )
    logger.info("字体映射表已重建：%s -> %d 个映射（%s）", font_url, len(mapping), content_hash)
    return mapping


# ---------------------------------------------------------------------------
# 提取流程整合：extract_clean_jd(ele)
# ---------------------------------------------------------------------------


@dataclass
class ExtractOptions:
    reference_font_path: Optional[str] = None
    font_family_filter: Optional[Callable[[FontFace], bool]] = None
    max_font_cache_age_hours: float = 24.0
    download_session=None  # type: ignore[assignment]
    enable_font_restore: bool = True


def extract_clean_jd(ele, page=None, options: Optional[ExtractOptions] = None) -> str:
    """对外主接口：输入 JD 正文容器元素，返回净化还原后的干净文本。

    ele: DrissionPage ChromiumElement，例如 page.ele('.job-sec-text')。
    page: 该元素所属的 ChromiumPage/TabPage；不传则用 ele.owner 兜底。
    options: 可选的 ExtractOptions，用于覆盖参考字体路径 / 字体过滤规则等。

    流程：
      1) 模块一：CSS 隐藏元素过滤（在 JS 里完成）。
      2) 模块二：z-index 遮罩识别，排除被遮罩覆盖 / 本身是遮罩的内容（JS 里完成）。
      3) 模块三：若检测到自定义字体，下载并反查字形映射表，还原加密字符。
      4) 基础格式化：去除多余空行、统一换行符。
    """

    options = options or ExtractOptions()
    page = page or getattr(ele, "owner", None)
    if page is None:
        raise ValueError("无法确定元素所属页面，请显式传入 page 参数")

    segments = get_visible_segments(ele)
    if not segments:
        return ""

    font_mappings: dict[str, str] = {}
    if options.enable_font_restore:
        used_families = {
            _normalize_font_family(seg.get("f", ""))
            for seg in segments
            if not seg.get("b")
        }
        used_families.discard("")

        font_filter = options.font_family_filter or looks_like_obfuscated_font
        try:
            all_faces = find_font_faces(page)
        except Exception as exc:
            logger.warning("扫描 @font-face 失败: %s", exc)
            all_faces = []

        candidate_faces = [
            face
            for face in all_faces
            if _normalize_font_family(face.family) in used_families and font_filter(face)
        ]

        seen_families: set[str] = set()
        for face in candidate_faces:
            fam_key = _normalize_font_family(face.family)
            if fam_key in seen_families:
                continue
            seen_families.add(fam_key)
            try:
                font_bytes = download_font_bytes(page, face.url, session=options.download_session)
            except Exception as exc:
                logger.warning("下载字体失败 %s: %s", face.url, exc)
                continue
            mapping = get_or_build_font_mapping(
                font_bytes,
                font_url=face.url,
                reference_font_path=options.reference_font_path,
                max_age_hours=options.max_font_cache_age_hours,
            )
            if mapping:
                font_mappings[fam_key] = mapping

    raw_text = segments_to_text(segments, font_mappings=font_mappings)
    return normalize_text(raw_text)


__all__ = [
    "extract_clean_jd",
    "ExtractOptions",
    "get_visible_segments",
    "segments_to_text",
    "find_font_faces",
    "looks_like_obfuscated_font",
    "download_font_bytes",
    "build_font_mapping",
    "get_or_build_font_mapping",
    "normalize_text",
    "FontFace",
]
