# 真机验证清单（commit `c3ce6a1` 及之前所有 mp 助手 / 我的文风 改动）

> 本文档对应 2026-04-29 期间一系列扩展端改动（commit `5aaae32` → `0f0abbc` → `c3ce6a1`），需要用户手动操作 Chrome 验证。每一条都给出**期望行为**，对不上时反馈给我。

## 准备

1. `chrome://extensions` → 找到「润笔」→ 点重载
2. **关掉所有 mp 后台 tab + 工作台 tab**（content script 不随扩展重载更新已打开 tab，硬约束）
3. 重新打开扩展设置页（chrome-extension://.../src/options/options.html）

---

## A · v0.1 浮球基础（commit `5aaae32`）

| # | 操作 | 期望 |
|---|---|---|
| A1 | 设置页打开「公众号编辑页悬浮助手」toggle | 弹 onboarding modal（5 条要点 + 「我了解，启用助手」按钮） |
| A2 | 点「我了解」 | modal 关闭，toggle 维持 ON 状态 |
| A3 | 打开 mp 后台 → 进图文编辑页 | 右下角出现圆形浮球 |
| A4 | 浮球点击 | 展开 dock 面板（含「📥 从润笔取最新草稿」按钮 + 复制 HTML / 关闭等） |
| A5 | dock 上点关闭 | dock 折叠回浮球（不真正销毁，下次点浮球还能展开） |
| A6 | 拖浮球到左下角 → 关 mp tab → 重开 | 浮球在左下角（位置持久化） |
| A7 | 右键浮球 → 选「在公众号后台永久隐藏」 | 浮球消失 + 设置页 toggle 自动回到 OFF |

## B · v0.2 三件套（commit `0f0abbc`）

### B1 多草稿选择器

1. 工作台抓 / AI 改写 2 篇文章（articleBundle 里 2 篇）
2. mp 后台浮球点开 dock → 应有 select 下拉列出 2 篇（带标题 + 字数 + profile 名）
3. 切换 select → 应自动重新拉取那篇 → 标题/正文写入

### B2 Profile 联动

1. 设置页加 2 个公众号 profile：「主号」、「营销号」
2. 工作台编辑台的「发布账号」选「主号」 → 改写一篇
3. mp 后台**手动切到**营销号 → 浮球点开 dock → 应有橙色 banner 警告「mp 后台账号≠草稿目标账号」+ pull 按钮 disabled
4. mp 后台切回主号 → banner 消失 + pull 按钮可点

### B3 后台静默 workspace

1. **关掉**所有润笔工作台 tab
2. mp 后台浮球点击展开 dock → 点「拉草稿」
3. 应在 1-2 秒内透明完成（**不夺焦**到新开的 workspace tab，跑完应没有遗留 workspace tab）
4. 关 tab 后查 chrome 任务栏 → 不应留下额外 workspace tab

## C · 「我的文风」完整 onboarding（commit `c3ce6a1`）

### C1 基础 CRUD

1. 设置页 → 「我的文风」分区 → 点「+ 添加新样本」 → editor 展开
2. 粘贴 1500+ 字的代表作 → 填标题 → 点「保存并提取指纹」
3. 状态应依次：「已保存原文，正在调 LLM 提取指纹…」→「已保存并提取指纹」→ 自动关 editor
4. 列表应出现该样本，标记「✓ 指纹已提取」
5. 点「启用」 → 列表出现「· 已启用」绿字标记
6. 点「编辑」 → editor 展开预填 raw + title
7. 点「删除」 → 列表移除（如该项是 active，自动停用）

### C2 入口 1：从历史草稿导入

1. 工作台至少抓过 / 改写过 1 篇（让 `__draft_history` 非空）
2. 设置页 → 「我的文风」 → 点「📜 从历史草稿导入」
3. 弹 modal 列出历史草稿（含标题 + 时间 + 200 字预览）
4. 多选 1-3 篇 → 点「填入文风编辑器」
5. editor 展开，textarea 应被填入选中草稿的标题+正文（用 `---` 分隔）+ 标题自动填「从历史草稿导入（N 篇）」
6. 点「保存并提取指纹」走完整流程

### C3 入口 2：从公众号 URL 抓取

1. 设置页 → 「我的文风」 → 点「🔗 抓公众号 URL」
2. 弹 prompt 输入框 → 粘一篇你写过的公众号文章 URL（如 `https://mp.weixin.qq.com/s/xxxxx`）
3. 第一次会弹 Chrome 原生权限请求（host permission）→ 点「允许」
4. 状态条「正在抓取原文…」 → 等 3-5s
5. editor 展开，textarea 填入抓到的段落（用空行分隔）+ 标题自动填「抓取自：xxx」
6. 点「保存并提取指纹」走完整流程

### C4 失败兜底

1. 「我的文风」编辑器粘文本 → 删空 settings.apiKey → 保存
2. 应：「已保存原文。指纹提取需要授权 AI 接口域名（已跳过）」或类似 LLM 失败提示，**raw 已存住**（列表显示「⚠ 指纹未提取」）
3. 设置页填回 apiKey → 列表点该样本「编辑」 → 重新点保存 → 这次指纹提取应成功

---

## 报告 bug 模板

跑过有问题时贴这些信息：

```
- 哪条用例失败：A3 / B1 / C2 etc
- 浏览器：Chrome 版本（chrome://version 顶部）
- 操作步骤：点了什么、看到了什么
- console 红色错误（mp tab / workspace tab / 设置页 三个 console 都看一下）
- screenshot 加分
```
