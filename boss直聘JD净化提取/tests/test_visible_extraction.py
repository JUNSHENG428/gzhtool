#!/usr/bin/env python3
"""模块一 + 模块二（CSS 隐藏过滤 + z-index 遮罩识别）的真实浏览器验证。

用本地 HTML fixture（不请求真实 Boss 直聘站点），起一个 headless
Chromium 加载页面，验证 get_visible_segments() 能：

  - 剔除 display:none / visibility:hidden / font-size:0 / 屏幕外定位的噪音节点
  - 剔除被 z-index 遮罩覆盖的"假"文字，保留遮罩下方的真实文字
  - 保留所有真正可见、参与渲染的正文

需要本机已安装 Chrome/Chromium，CI 环境若无浏览器可跳过（见 SkipTest）。
"""

from __future__ import annotations

import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from jd_extractor import get_visible_segments, segments_to_text, normalize_text  # noqa: E402

FIXTURE_PATH = Path(__file__).parent / "fixture_jd_page.html"


class VisibleExtractionTest(unittest.TestCase):
    page = None

    @classmethod
    def setUpClass(cls) -> None:
        try:
            from DrissionPage import ChromiumPage
            from DrissionPage import ChromiumOptions
        except ImportError as exc:  # pragma: no cover
            raise unittest.SkipTest(f"DrissionPage 未安装: {exc}")

        try:
            opts = ChromiumOptions().headless()
            cls.page = ChromiumPage(addr_or_opts=opts)
            cls.page.get(FIXTURE_PATH.as_uri())
        except Exception as exc:  # pragma: no cover
            raise unittest.SkipTest(f"当前环境无法启动浏览器，跳过真机验证: {exc}")

    @classmethod
    def tearDownClass(cls) -> None:
        if cls.page is not None:
            cls.page.quit()

    def test_filters_noise_and_masked_text(self) -> None:
        ele = self.page.ele("#jd")
        self.assertIsNotNone(ele, "未找到 fixture 里的 JD 容器")

        segments = get_visible_segments(ele)
        text = normalize_text(segments_to_text(segments))

        # 应当保留的真实正文
        for expected in (
            "负责后端服务开发与维护",
            "参与核心系统架构设计",
            "本科及以上学历",
            # 场景一：遮罩层本身没有文字内容（纯粹用来劫持点击/选中），
            # 真实文字在视觉上仍然可见，应当被保留
            "15k-25k",
            "欢迎有志之士加入我们的团队",
            # 场景二：遮罩层本身带有不透明的"假"内容，视觉上它才是最终
            # 显示的那一层，应当保留这层内容
            "虚假占位地址",
        ):
            self.assertIn(expected, text, f"应保留的正文缺失: {expected!r}\n完整结果:\n{text}")

        # 不应当出现的干扰/隐藏/遮罩内容
        for noise in (
            "kanzhun",
            "直聘",
            "噪音噪音",
            "这段屏幕外的文字不应该出现在结果里",
            # 场景二：被不透明遮罩盖住的真实文字，视觉上已不可见，不应输出
            "上海市浦东新区",
        ):
            self.assertNotIn(noise, text, f"不应出现的干扰内容混入结果: {noise!r}\n完整结果:\n{text}")


if __name__ == "__main__":
    unittest.main()
