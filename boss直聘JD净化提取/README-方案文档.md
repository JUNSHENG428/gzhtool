# JD 正文净化提取模块

> **重要声明**：本模块仅用于个人学习和数据分析研究，请遵守目标网站的服务条款
> 与 robots 协议。不要用于商业性批量采集，也不要用于侵犯网站权益的用途。抓取
> 时请保持合理的频率（随机延时 + 滚动模拟），避免对目标站点造成压力或触发
> 账号/IP 风控。

## 这是什么

Boss 直聘等招聘网站的 JD 详情页存在三类反爬/防复制机制，导致常规的
"选中复制"或直接抓 `innerText` 拿到的内容不完整、夹带乱码或垃圾字符。
本模块基于 DrissionPage，在现有爬虫（拿列表页 JSON 接口数据）基础上，
新增"JD 正文净化提取"能力，绕过这三类机制，输出干净、准确的职位描述文本。

对外主接口：

```python
from jd_extractor import extract_clean_jd

ele = page.ele('.job-sec-text')   # JD 正文容器
clean_text = extract_clean_jd(ele, page=page)
```

## 三类反爬机制的识别逻辑

### 模块一：CSS 隐藏元素过滤

在 JD 容器内用 `TreeWalker`/递归遍历所有文本节点，对每个文本节点的父元素
调 `getComputedStyle`，命中以下任一条件的节点直接剔除：

- `display: none`
- `visibility: hidden` / `collapse`
- `font-size <= 1px`（含 `font-size: 0`）
- `opacity <= 0.05`
- `position: absolute/fixed` 且几何位置明显偏移到可视区域之外
  （`right < -50px`、`bottom < -50px`，或 `left`/`top` 数值异常巨大）

这一步和模块二被合并进**同一次 `run_js` 调用**完成（见
`jd_extractor._EXTRACT_VISIBLE_SEGMENTS_JS`），避免逐节点在 Python 和浏览器
之间往返，这是满足"单页新增耗时 < 1 秒"验收要求的关键设计。

### 模块二：z-index 遮罩识别

对每个通过模块一过滤的文本节点，取其包围盒中心点坐标，调用
`document.elementFromPoint(cx, cy)` 反查"浏览器渐进渲染后，这个坐标点视觉上
最终显示的是哪个元素"。判断规则：

- 如果这个最上层元素就是文本节点自己（或其祖先/子孙），说明没有遮罩，正常保留。
- 如果最上层元素是别的元素，且**这个元素自己没有任何文字内容**（`textContent.trim() === ''`），
  说明它只是一个用来劫持鼠标选中/点击的透明层（真实 Boss 直聘等站点的典型实现——
  遮罩层通常不放真实内容，纯粹用于拦截 `mousedown`/`selectstart` 事件），
  这种情况下真实文字视觉上仍然可见，**不排除**。
- 如果最上层元素自己带有实打实的文字内容，说明它才是最终视觉呈现的那一层
  （比如一个不透明的"假内容"覆盖层），此时才把被压在下面的文字排除。

> 局限：遮罩识别只采样文本节点包围盒的**中心点**一个坐标，跨行、超宽的文本节点
> 理论上可能出现中心点碰巧落在遮罩外/内导致误判的边界情况；同一坐标点若被
> `pointer-events: none` 的元素覆盖也会被认为"未被真正遮罩"。生产使用中如遇到
> 特别复杂的多层叠加，建议按目标站点实际 DOM 结构调整判断条件。

### 模块三：自定义字体反爬还原

1. **检测**：扫描 `document.styleSheets` 里所有 `@font-face` 规则，解析
   `font-family` 与 `src: url(...)`。用启发式规则 `looks_like_obfuscated_font()`
   判断是否"非常规命名"：
   - 命中常见字体关键字（Arial / 苹方 / 微软雅黑 / PingFang / Noto 等）→ 判定为正常字体，跳过。
   - 字体名或文件名是无语义的随机字符串/哈希 → 判定为疑似加密字体。
   - 该规则可能有极少数误判（比如网站真用了小众品牌字体），可通过
     `ExtractOptions(font_family_filter=...)` 传入自定义判断函数覆盖。
2. **下载**：只下载 JD 容器里**实际用到**的字体（先收集容器内文本节点的
   `font-family`，再和 `@font-face` 声明的家族名交叉匹配），避免浪费在页面
   上无关的字体上。
3. **还原**：
   - 用 `fontTools` 解析字体文件的 `cmap` 表，拿到"编码点 -> glyph"映射。
   - **只处理落在 Unicode 私有使用区（PUA, `U+E000–F8FF` 等）的编码点**——
     这既是真实反爬字体的实现特征（PUA 保证不会跟任何正常字符冲突，网站才敢
     "乱分配编码"），也天然避免误伤字体里恰好包含的普通 ASCII/CJK 字形。
   - 用 PIL 把每个 PUA 编码点对应的 glyph、以及一小撮"候选真实字符"
     （默认数字 0-9 + 常见符号，见 `_DEFAULT_CANDIDATE_CHARS`）分别渲染成位图，
     计算差值哈希（dHash），按最近邻（汉明距离）匹配，重建
     "加密字符 -> 真实字符"映射表——**不依赖任何硬编码的静态映射**。
   - 用映射表对提取到的原始文本做反向替换。

> 局限：默认候选字符集只覆盖数字与常见符号（薪资、面试轮次等场景足够），
> 如果 JD 正文里更大范围的汉字也被加密，需要扩展 `candidate_chars` 并接受
> 准确率随字符集增大而下降（候选集越大、字形彼此越容易混淆，dHash 这类粗粒度
> 位图哈希不是万能的字形识别方案）。若目标站点确实加密了大段正文汉字，
> 建议升级为更强的字形比对方式（矢量轮廓比对 / 训练一个小型 OCR 分类器）。

### 提取流程整合

```
extract_clean_jd(ele)
  1. get_visible_segments(ele)          # 模块一 + 模块二，一次 run_js 搞定
  2. find_font_faces(page) + 交叉过滤    # 模块三：检测容器实际用到的可疑字体
  3. download_font_bytes / 缓存命中      # 模块三：下载 or 复用缓存
  4. get_or_build_font_mapping(...)     # 模块三：字形比对重建映射表
  5. segments_to_text(..., mapping)     # 应用映射还原文本
  6. normalize_text(...)                # 去多余空行、统一换行符
```

## 字体映射表的更新策略（增量更新，不硬编码）

缓存 key 是**字体文件内容的 sha256**（`get_or_build_font_mapping`），不是
URL。这样设计的原因：

- Boss 直聘等站点更换加密映射表时，字体文件的**内容**必然发生变化
  （哪怕文件名/URL 恰好没变），内容哈希一变，缓存自动 miss，自动重新下载、
  重新解析、重新构建映射表——不需要人工维护"多久过期"之类的规则。
- 额外叠加一个 `max_age_hours`（默认 24 小时）兜底：即使内容哈希没变，
  超过这个时间也会强制重建一次，防止极端情况下"内容没变但比对算法本身
  升级了"这种场景一直用旧结果。
- 缓存文件落在 `font_cache/` 目录，按 `{content_hash}.ttf` +
  `{content_hash}.json`（映射表 + 元信息）存放，天然支持同时缓存多个版本
  （比如新旧字体交替生效的过渡期）。

## 性能

- 模块一 + 模块二只有一次 `run_js` 往返，不随 JD 正文长度显著变慢。
- 模块三真正耗时的是"下载字体 + 渲染比对建表"，但这个成本**只发生在第一次
  遇到某个字体文件时**，后续所有用同一份字体的详情页都直接命中缓存，
  几乎零开销。真实反爬字体通常只有几十个字形（远小于测试用的全字符集字体），
  实测构建耗时在数十毫秒量级；缓存命中路径下单页新增耗时可以忽略不计。

## 使用示例

见 [`example_crawler.py`](./example_crawler.py)：演示了"列表页拿 JSON 接口数据
→ 详情页 DrissionPage 打开 → 随机延时 + 模拟滚动 → 定位 JD 容器 → 调用
`extract_clean_jd` → 写入 CSV"的完整链路。**里面的选择器、接口地址都是占位符**，
请替换成你现有列表页/详情页爬虫里实际使用的逻辑。

```python
from DrissionPage import ChromiumPage
from jd_extractor import extract_clean_jd, ExtractOptions

page = ChromiumPage()
page.get(detail_url)

ele = page.ele('.job-sec-text')
text = extract_clean_jd(ele, page=page, options=ExtractOptions(
    reference_font_path=None,          # 不传则自动探测系统常见字体
    max_font_cache_age_hours=24,       # 字体映射表兜底刷新周期
))
```

## 安装

```bash
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
```

依赖：`DrissionPage`（复用现有框架）、`fonttools[woff]` + `Brotli`（解析
woff2 字体需要）、`Pillow`（字形渲染与哈希比对）、`requests`（下载字体文件）。

## 测试

```bash
python -m unittest discover -s tests
```

三份测试：

- `tests/test_font_mapping.py`：**无网络依赖**，用 fontTools 基于系统字体
  构造一份"合成加密字体"（把 0-9 的字形额外挂到 PUA 编码点上，模拟真实反爬
  字体的实现手法），验证 `build_font_mapping()` 能纯靠字形比对正确反查映射，
  且不会误伤字体里的普通编码点。
- `tests/test_visible_extraction.py`：起一个 headless 浏览器加载本地 HTML
  fixture（模拟 CSS 隐藏噪音 + 两种 z-index 遮罩场景），验证
  `get_visible_segments()` 的过滤结果与浏览器视觉呈现一致。
- `tests/test_extract_clean_jd_e2e.py`：端到端测试，本地起 HTTP 服务器托管
  一个同时包含 CSS 噪音、z-index 遮罩、自定义加密字体的 fixture 页面，验证
  `extract_clean_jd()` 把三个模块串起来后的最终输出正确。

以上测试均不访问真实 Boss 直聘站点。

## 已知局限性

1. **z-index 遮罩识别只采样文本节点包围盒中心点**，极端情况下（跨行长文本、
   不规则形状遮罩）可能有边界误判；如目标站点遮罩实现方式特殊，需要按需调整
   `_EXTRACT_VISIBLE_SEGMENTS_JS` 里的判断条件。
2. **字体反爬还原目前只覆盖 PUA 编码点、默认候选字符集是数字+常见符号**。
   如果目标站点把大段汉字正文也做了字体加密，需要扩展候选字符集，且
   dHash 位图比对在字符集变大后准确率会下降，必要时应升级为更精细的字形
   比对方案（矢量轮廓特征、训练分类器等）。
3. **"非常规命名"字体判定是启发式规则**，可能对个别使用小众品牌字体（但
   不是反爬）的网站有误判，可通过 `ExtractOptions.font_family_filter` 自定义覆盖。
4. **依赖 Boss 直聘等站点的字体文件必须能被 `requests` 直接下载**；如果字体
   请求需要额外的签名/Token 校验，需要在 `download_font_bytes` 里补充相应的
   请求头或改用页面自身发起请求（例如通过 `run_js` + `fetch` 拿 base64）。
5. 本模块**不会**尝试绕过登录墙、验证码或更高级的行为验证；这些不在本次
   需求范围内。
