#!/usr/bin/env python3
"""集成示例：在列表页/详情页爬虫里调用 extract_clean_jd。

演示结构（仅供参考，选择器与接口地址均为占位符，需按实际页面调整）：

  1. 列表页：走 Boss 直聘搜索结果的 JSON 接口拿到职位 id / 详情页链接。
  2. 详情页：DrissionPage 打开每条详情页，随机延时 + 模拟滚动（避免风控）。
  3. 定位 JD 正文容器（如 .job-sec-text），调用 extract_clean_jd() 净化提取。
  4. 写入 CSV，正文字段使用净化后的干净文本。

仅用于个人学习和数据分析研究，请遵守目标网站服务条款，不要用于商业性
批量采集，并保持合理的抓取频率。
"""

from __future__ import annotations

import csv
import logging
import random
import time
from pathlib import Path

from DrissionPage import ChromiumPage

from jd_extractor import ExtractOptions, extract_clean_jd

logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(levelname)s] %(message)s")
logger = logging.getLogger("example_crawler")

# --- 占位配置，请按实际情况替换 --------------------------------------------

JD_CONTAINER_SELECTOR = ".job-sec-text"  # JD 正文容器（占位，需按实际页面确认）
OUTPUT_CSV = Path(__file__).parent / "jobs_output.csv"


def random_delay(min_s: float = 1.5, max_s: float = 4.0) -> None:
    """沿用原有的随机延时策略，避免固定节奏触发风控。"""

    time.sleep(random.uniform(min_s, max_s))


def simulate_human_scroll(page, steps: int = 4) -> None:
    """沿用原有的滚动模拟策略：分段滚动 + 随机停顿，避免"秒到底"的机器特征。"""

    for _ in range(steps):
        page.scroll.down(random.randint(200, 500))
        random_delay(0.4, 1.2)


def fetch_job_list(list_api_url: str) -> list[dict]:
    """占位：从列表页 JSON 接口拿职位基本信息（id、标题、详情页链接等）。

    真实项目里这里应该复用现有的"现有爬虫"逻辑（DrissionPage SessionPage /
    requests 直接请求 JSON 接口），此处只做接口示意。
    """

    raise NotImplementedError(
        "请替换为实际的列表页 JSON 接口调用逻辑，返回形如 "
        "[{'job_id': ..., 'title': ..., 'detail_url': ...}, ...] 的列表"
    )


def crawl_job_detail(page: ChromiumPage, detail_url: str) -> str:
    """打开详情页，定位 JD 容器并调用净化提取接口，返回干净文本。"""

    page.get(detail_url)
    random_delay()
    simulate_human_scroll(page)

    ele = page.ele(JD_CONTAINER_SELECTOR, timeout=10)
    if ele is None:
        logger.warning("未找到 JD 容器 %s，页面: %s", JD_CONTAINER_SELECTOR, detail_url)
        return ""

    options = ExtractOptions(
        # 参考字体留空则自动探测系统常见字体；如需更高准确率，
        # 建议手动指定一个视觉上更接近目标网站正文字体的 ttf/ttc 路径。
        reference_font_path=None,
    )
    clean_text = extract_clean_jd(ele, page=page, options=options)
    return clean_text


def main(list_api_url: str) -> None:
    jobs = fetch_job_list(list_api_url)
    page = ChromiumPage()

    OUTPUT_CSV.parent.mkdir(parents=True, exist_ok=True)
    with OUTPUT_CSV.open("w", newline="", encoding="utf-8-sig") as f:
        writer = csv.DictWriter(f, fieldnames=["job_id", "title", "detail_url", "jd_text"])
        writer.writeheader()

        for job in jobs:
            try:
                jd_text = crawl_job_detail(page, job["detail_url"])
            except Exception as exc:  # noqa: BLE001 - 单条失败不阻断整体抓取
                logger.exception("抓取详情页失败: %s", job.get("detail_url"))
                jd_text = ""
            writer.writerow(
                {
                    "job_id": job.get("job_id", ""),
                    "title": job.get("title", ""),
                    "detail_url": job.get("detail_url", ""),
                    "jd_text": jd_text,
                }
            )
            random_delay(2.0, 5.0)

    page.quit()
    logger.info("完成，输出文件: %s", OUTPUT_CSV)


if __name__ == "__main__":
    main(list_api_url="https://www.zhipin.com/wapi/zpgeek/search/joblist.json")
