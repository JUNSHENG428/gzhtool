# 端到端 user journey 报告

生成时间：2026-04-23T07:59:54.764Z
真实抓取的 URL：https://sspai.com/a/JZbWkJ

**总计**：✓ 31 ・ ! 0 ・ ✗ 0

所有截图存在：`dist/journey-shots/`

| Stage | Check | Status | Detail |
|---|---|---|---|
| J1 | popup 我的页 license 文案 = "免费版" | ✅ |  |
| J2-guard | 错误页/302 抓取被健全检查拦截 | ✅ | 抓到的内容太少 （抓到 1 块 / 174 字），可能命中了登录墙、错误页或反爬拦截页。请在浏览器里打开 https://sspai.com/post/9600 |
| J2 | 抓取成功：https://sspai.com/a/JZbWkJ | ✅ | title="原来你对写作是真爱：少数派 2025 年度征文结…" blocks=38 字数=1441 |
| J2-quality | 标题非空 | ✅ | 原来你对写作是真爱：少数派 2025 年度征文结果公布 - 少数派 |
| J2-quality | 站点识别 | ✅ | 少数派 - 高品质数字消费指南 |
| J2-quality | 作者识别 | ✅ | 少数派编辑部 |
| J2-quality | block 数量 | ✅ | 38 块 |
| J2-quality | 图片识别 | ✅ | 9 张 |
| J2-quality | 正文字数 | ✅ | 1441 字 |
| J3 | 编辑器加载 + 内容回填耗时 4790ms | ✅ |  |
| J3 | 标题输入框被自动填入 | ✅ | "原来你对写作是真爱：少数派 2025 年度征文结果公布 - …" (32/32) |
| J3 | 副标题输入框被自动填入 | ✅ | "少数派 - 高品质数字消费指南" |
| J3 | 作者输入框被自动填入 | ✅ | "少数派编辑部" (6/16) |
| J3 | 公众号预览有内容（≥500 字符 HTML） | ✅ | 8819 chars |
| J3 | 字数面板显示 HTML 字符 / 20000 | ✅ | 正文 0 字 · HTML 0 / 20,000 |
| J4 | 切到「发布」视图后预览面板可见 | ✅ | {"found":true,"w":294,"h":860,"top":250.0859375} |
| J4 | themeSelect 总数 = 11 | ✅ | editorial-green, modern-amber, minimal-mono, warm-rose, tech-blue, editorial-newyorker, kinfolk-quiet, wired-neon, monocle-soft, vogue-didone, paper-zine |
| J4 | 主题 新刊衬线 · The New Yorker（editorial-newyorker） | ✅ | inline-style 59 节点 / sig=-1afe0cb |
| J4 | 主题 静语生活 · Kinfolk（kinfolk-quiet） | ✅ | inline-style 59 节点 / sig=-358dc27d |
| J4 | 主题 霓虹科技 · Wired（wired-neon） | ✅ | inline-style 59 节点 / sig=7d784963 |
| J4 | 主题 杏色商业 · Monocle（monocle-soft） | ✅ | inline-style 59 节点 / sig=1362092b |
| J4 | 主题 时装大刊 · Vogue（vogue-didone） | ✅ | inline-style 59 节点 / sig=-262bee07 |
| J4 | 主题 独立刊物 · Zine（paper-zine） | ✅ | inline-style 59 节点 / sig=61bedab0 |
| J4 | 6 套主题样式签名互异性 | ✅ | 6/6 个唯一签名 |
| J4 | 6 套主题截图视觉差异 | ✅ | 6/6 张图视觉不同 |
| J5 | AI 改写按钮可见 | ✅ |  |
| J5 | mock LLM 命中次数 | ✅ | 1 次 |
| J5 | AI 改写流程完成 | ✅ | 耗时 522ms |
| J5 | mock 导语渲染到 preview | ✅ |  |
| J5 | mock 章节标题渲染到 preview | ✅ |  |
| J5 | 整个 J3-J5 过程 console 干净 | ✅ |  |