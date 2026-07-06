#!/usr/bin/env python3
"""端到端集成测试：验证 extract_clean_jd() 把模块一/二/三串起来后，
在一个模拟了"CSS 噪音 + z-index 遮罩 + 自定义加密字体"三种反爬手法
的本地页面上，能还原出与浏览器视觉呈现完全一致的干净文本。

不访问真实 Boss 直聘站点：本地起一个 HTTP 服务器托管 fixture 页面
和合成加密字体文件，模拟真实场景里"下载字体文件"这一步。
"""

from __future__ import annotations

import functools
import http.server
import io
import sys
import threading
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from jd_extractor import ExtractOptions, extract_clean_jd, _pick_default_reference_font  # noqa: E402

try:
    from fontTools.ttLib import TTFont
    FONTTOOLS_AVAILABLE = True
except ImportError:  # pragma: no cover
    FONTTOOLS_AVAILABLE = False

PUA_BASE = 0xE000  # 与 test_font_mapping.py 里的合成加密字体约定一致


def _build_synthetic_obfuscated_font(base_font_path: str) -> bytes:
    font = TTFont(base_font_path, lazy=False)
    cmap_tables = [t for t in font["cmap"].tables if t.isUnicode()]
    best_cmap = font.getBestCmap()
    for offset, digit in enumerate("0123456789"):
        glyph_name = best_cmap.get(ord(digit))
        if glyph_name is None:
            continue
        for table in cmap_tables:
            table.cmap[PUA_BASE + offset] = glyph_name
    buf = io.BytesIO()
    font.save(buf)
    return buf.getvalue()


def _pua_digits(s: str) -> str:
    """把普通数字字符串转成对应的 PUA 加密字符（模拟网页源码里的乱码）。"""

    return "".join(chr(PUA_BASE + int(ch)) if ch.isdigit() else ch for ch in s)


class ExtractCleanJdEndToEndTest(unittest.TestCase):
    server = None
    server_thread = None
    page = None
    tmp_dir = None

    @classmethod
    def setUpClass(cls) -> None:
        if not FONTTOOLS_AVAILABLE:
            raise unittest.SkipTest("fontTools 未安装")

        ref_font = _pick_default_reference_font()
        if not ref_font:
            raise unittest.SkipTest("找不到可用的系统参考字体")

        try:
            from DrissionPage import ChromiumPage, ChromiumOptions
        except ImportError as exc:  # pragma: no cover
            raise unittest.SkipTest(f"DrissionPage 未安装: {exc}")

        cls.tmp_dir = Path(__file__).parent / "_tmp_e2e"
        cls.tmp_dir.mkdir(exist_ok=True)

        font_bytes = _build_synthetic_obfuscated_font(ref_font)
        (cls.tmp_dir / "obf7x2q.ttf").write_bytes(font_bytes)

        salary_encrypted = _pua_digits("15") + "k-" + _pua_digits("25") + "k"
        html = f"""<!DOCTYPE html>
<html><head><meta charset="UTF-8">
<style>
  @font-face {{ font-family: 'obf7x2q'; src: url('obf7x2q.ttf'); }}
  .salary {{ font-family: 'obf7x2q', sans-serif; }}
  .mask-wrap {{ position: relative; display: inline-block; }}
  .mask-overlay {{ position: absolute; inset: 0; z-index: 5; }}
  .real-text {{ position: relative; z-index: 1; }}
  .noise {{ display: none; }}
</style></head>
<body>
  <div class="jd">
    <p>岗位职责：负责推荐系统研发<span class="noise">kanzhun干扰词</span>。</p>
    <p>薪资：
      <span class="mask-wrap">
        <span class="mask-overlay"></span>
        <span class="real-text salary">{salary_encrypted}</span>
      </span>
      ，13薪。
    </p>
  </div>
</body></html>"""
        (cls.tmp_dir / "fixture.html").write_text(html, encoding="utf-8")

        handler = functools.partial(http.server.SimpleHTTPRequestHandler, directory=str(cls.tmp_dir))
        cls.server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), handler)
        cls.port = cls.server.server_address[1]
        cls.server_thread = threading.Thread(target=cls.server.serve_forever, daemon=True)
        cls.server_thread.start()

        try:
            opts = ChromiumOptions().headless()
            cls.page = ChromiumPage(addr_or_opts=opts)
            cls.page.get(f"http://127.0.0.1:{cls.port}/fixture.html")
        except Exception as exc:  # pragma: no cover
            raise unittest.SkipTest(f"当前环境无法启动浏览器，跳过端到端验证: {exc}")

        cls.reference_font_path = ref_font

    @classmethod
    def tearDownClass(cls) -> None:
        if cls.page is not None:
            cls.page.quit()
        if cls.server is not None:
            cls.server.shutdown()
        if cls.tmp_dir is not None:
            for p in cls.tmp_dir.glob("*"):
                p.unlink()
            cls.tmp_dir.rmdir()

    def test_extract_clean_jd_full_pipeline(self) -> None:
        ele = self.page.ele(".jd")
        self.assertIsNotNone(ele)

        options = ExtractOptions(reference_font_path=self.reference_font_path)
        text = extract_clean_jd(ele, page=self.page, options=options)

        self.assertIn("负责推荐系统研发", text)
        self.assertIn("13薪", text)
        self.assertNotIn("kanzhun", text)
        self.assertNotIn("干扰词", text)
        # 加密字体还原：视觉上是 "15k-25k"，源码里其实是私有区乱码编码
        self.assertIn("15k-25k", text, f"字体反爬还原失败，完整结果:\n{text}")
        # 原始加密编码点不应该原样残留在输出里
        self.assertNotIn(chr(PUA_BASE + 1), text)


if __name__ == "__main__":
    unittest.main()
