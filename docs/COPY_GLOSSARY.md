# 文案术语对照表（COPY_GLOSSARY）

> **这是用户可见文案的 SSOT（单一真源）**。任何 UI / 营销页 / 弹窗 / hint 出现左列的内部术语，
> 一律替换为右列的用户文案。新增功能命名先查此表再写文案；改名时同步更新此表 + grep 全仓。
>
> 建立于 43rd session（设置页重塑 Batch 3）。配套约定见 `memory-bank/progress.md` 反例 #18
> （跨多界面文案改造维护「N 处对齐清单」）。

## 一、功能名（内部名 → 用户名）

| 内部术语 / 旧文案 | 用户文案（SSOT） | 备注 |
|---|---|---|
| DrissionPage / DrissionPage 增强抓取 | **本地增强抓取** | 桌面助手承载；"DrissionPage"只允许出现在指向 GitHub 的链接文本与开发文档 |
| voice samples / voiceMimic / 文风样本注入 | **文风模拟**（区块名「我的文风」） | 年费专享（`ai.voiceMimic`） |
| humanize pass / 二次 pass / deAiBoost | **「去 AI 味」二次润色** | 会员功能（月费/年费，`ai.deAiBoost`） |
| lint / lint 分数 / lint 命中 | **AI 痕迹检测（得分）** | 本地运行，不联网 |
| 主 pass / pass1 | **基础改写** | |
| BYOK / bring your own key | **自定义 API Key（用我自己的 Key）** | 年费独享（`ai.bringYourOwnKey`） |
| platform / 平台代理 | **润笔平台 AI** | 默认模式，免费可用 |
| platformTier / tier | **模型档位**（经济/标准/旗舰） | |
| SSE / streaming | **流式响应（实时看到生成进度）** | |
| floating ball / Floating Helper | **悬浮助手（浮球）** | |
| task center | **后台任务中心** | |
| fingerprint（voice） | **风格指纹** | 已是用户文案，保留 |
| profiles / wechatProfiles | **多账号管理 / 公众号账号** | |
| helper / drission helper | **桌面助手（润笔桌面助手）** | |
| dashboard | **总览** | workspace 视图名 |
| workspace | **编辑台 / 工作台** | 两者混用中，倾向「编辑台」 |

## 二、套餐与闸门话术

| 场景 | 标准话术 |
|---|---|
| 年费专享标 | 金色 `.section-tag.yearly`「年费专享」 |
| 会员功能标（月费即可） | `.section-tag`「会员功能」 |
| 多账号上限 | 「免费版 / 月费版可绑定 1 个公众号；年费会员可绑 5 个」 |
| 升级 CTA | 「查看年费会员」/「查看会员方案」（不再写「查看 Pro 会员」） |
| Pro 字样 | **逐步退场**：仅 license.js 内部 plan 枚举 `pro`（历史 SKU，按年费对待）保留 |

## 三、禁止出现在用户文案里的内部字段名

`aiSourceMode` · `platformTier` · `humanize_intensity` · `compliance_custom_words` ·
`useVoiceSample` · `humanizePassAllowed` · `wechatProfiles` · `rawText` ·
`X-Platform-Tier-Downgraded` · `JWT` · `SSE` · `React/Shadow DOM` · `worker`

> 例外：**高级模式下的开发者向参数**允许保留 API 标准名（`top_p` / `frequency_penalty` /
> `presence_penalty` / `send_ignore_reprint` / `freepublish/submit` / `tag_id` / 微信错误码
> 40164 等）——这些名字本身就是用户要去对照官方文档的检索词，翻译反而有害。

## 四、文案风格基线

- hint 模板：「**什么时候改** / **填错的后果**」两段式（已全页采用，新增字段沿用）
- 计量单位：平台 AI 配额统一用 **token**（与 pricing 页对齐，不写"字符量"）
- 不写开发 session 编号、commit 引用进用户文案
- 长解释优先折叠进 `<details class="field-help">`，正文一句话说清
