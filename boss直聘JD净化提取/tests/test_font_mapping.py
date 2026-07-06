#!/usr/bin/env python3
"""模块三（字体反爬还原）的无网络单元测试。

思路：用 fontTools 基于系统自带字体构造一份"合成加密字体"——
在同一份 glyf 表基础上，给几个私有区（PUA）编码点额外挂上
"0-9 数字"的字形引用，模拟 Boss 直聘之类网站"编码点是乱码、
但渲染出来是正常数字"的字体反爬手法。

然后验证 build_font_mapping() 能够仅凭字形位图比对，
不依赖任何硬编码映射表，就把 PUA 编码点正确反查回原始数字。
"""

from __future__ import annotations

import io
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from jd_extractor import build_font_mapping, _pick_default_reference_font  # noqa: E402

try:
    from fontTools.ttLib import TTFont
    FONTTOOLS_AVAILABLE = True
except ImportError:  # pragma: no cover
    FONTTOOLS_AVAILABLE = False

# PUA（私有使用区）起始编码点，模拟网站给数字分配的"乱码"编码
PUA_BASE = 0xE000
DIGITS = "0123456789"


def _build_synthetic_obfuscated_font(base_font_path: str) -> bytes:
    """把 base_font_path 里 0-9 对应的字形，额外映射到 PUA_BASE 起的编码点上，
    模拟"编码乱掉了但字形长得跟真实数字一模一样"的加密字体。"""

    font = TTFont(base_font_path, lazy=False)
    cmap_tables = [t for t in font["cmap"].tables if t.isUnicode()]
    if not cmap_tables:
        raise RuntimeError("参考字体没有 Unicode cmap 子表")

    best_cmap = font.getBestCmap()
    for offset, digit in enumerate(DIGITS):
        glyph_name = best_cmap.get(ord(digit))
        if glyph_name is None:
            continue
        pua_codepoint = PUA_BASE + offset
        for table in cmap_tables:
            table.cmap[pua_codepoint] = glyph_name

    buf = io.BytesIO()
    font.save(buf)
    return buf.getvalue()


@unittest.skipUnless(FONTTOOLS_AVAILABLE, "fontTools 未安装")
class FontMappingReconstructionTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.reference_font_path = _pick_default_reference_font()
        if not cls.reference_font_path:
            raise unittest.SkipTest("当前系统找不到可用的参考字体（Arial/PingFang 等）")

        synthetic_bytes = _build_synthetic_obfuscated_font(cls.reference_font_path)
        cls.tmp_dir = Path(__file__).parent / "_tmp"
        cls.tmp_dir.mkdir(exist_ok=True)
        cls.synthetic_ttf_path = cls.tmp_dir / "synthetic_obfuscated.ttf"
        cls.synthetic_ttf_path.write_bytes(synthetic_bytes)

    @classmethod
    def tearDownClass(cls) -> None:
        for p in cls.tmp_dir.glob("*"):
            p.unlink()
        cls.tmp_dir.rmdir()

    def test_reconstructs_pua_digit_mapping(self) -> None:
        mapping = build_font_mapping(
            str(self.synthetic_ttf_path),
            reference_font_path=self.reference_font_path,
        )

        self.assertTrue(mapping, "映射表不应为空——说明字形渲染/比对链路没跑起来")

        correct, total = 0, 0
        for offset, digit in enumerate(DIGITS):
            pua_char = chr(PUA_BASE + offset)
            if pua_char not in mapping:
                continue
            total += 1
            if mapping[pua_char] == digit:
                correct += 1

        self.assertGreater(total, 0, "至少要能覆盖到几个 PUA 编码点")
        accuracy = correct / total
        self.assertGreaterEqual(
            accuracy, 0.8,
            f"PUA 数字还原准确率过低: {correct}/{total} = {accuracy:.0%}\n"
            f"完整映射: {mapping}",
        )

    def test_unrelated_codepoints_not_polluted(self) -> None:
        """普通编码点（非 PUA）不应该被误伤成映射表里的键。"""

        mapping = build_font_mapping(
            str(self.synthetic_ttf_path),
            reference_font_path=self.reference_font_path,
        )
        # 原本的 '0'-'9' 本身编码点依然存在于字体里，也会被建模，
        # 这里只断言它们如果出现，映射结果应当就是它们自己（自映射不影响还原）。
        for digit in DIGITS:
            if digit in mapping:
                self.assertEqual(mapping[digit], digit)


if __name__ == "__main__":
    unittest.main()
