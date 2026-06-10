# 反例约定（沉淀清单）

> 项目历史踩过的坑，沉淀成"以后不要再走"的硬约定。详细原因 / 触发场景 / 修法见 [progress.md](./progress.md)「已踩坑 / 已沉淀的反例约定」段或同日 [activeContext.md](./activeContext.md)「📚 决策时间线」段。
>
> **写入纪律**：append-only，编号递增；同编号出现 N 次 = 强化沉淀（同模式再踩，加判定原则）。
>
> **使用建议**：AI 启动 session 时若 progress.md 太大不便全读，先扫这份清单（~80 行）建立 reflex pattern；具体一条触发时按编号回 progress.md 查详细案例。

---

## 主反例约定（编号 1-37，progress.md 显式编号）

| # | 一句话规避 | 关键词 | 首次沉淀 | 强化次数 |
|---|---|---|---|---|
| 1 | **bootstrap 顺序需要 query param 时优先 inline `URLSearchParams.get`，不要 const + 后续使用** | TDZ / Options 页 / focus_article 路由 | 2026-04-23 13th | 2 (38th 续 14) |
| 2 | **CI 不要加回 macOS-13 (Intel) runner**（pyinstaller 不兼容） | desktop / CI matrix | 2026-04-23 | — |
| 3 | **CSS `pointer-events:none` 祖先 + `auto` 子级 → 所有 grandchild button 必须显式 `auto`** | task-center toast / event 委托 | 2026-04-30 34th | — |
| 4 | **后台 task registry 不要做"同 article + 同 type 自动 cancel 老 task" dedup**（违反用户意图，用 UI debounce 代替） | task-registry / 连点 | 2026-04-30 34th | — |
| 5 | **按钮防抖优先 UI 层（click handler），不要放数据层（task / DB / message）** | rewrite/capture button | 2026-04-30 35th | 2 (38th 续 2) |
| 6 | **大 feature 落地允许单 commit 偏离 < 300 行硬约束**（拆开会让中间 commit broken state） | 队列模式 / 任务中心 | 2026-04-30 35th | — |
| 7 | **license 签发必须走 `parseLemonRenewsAt`，强制 365d 硬上限** | webhook / 续期 | 2026-04-25 | — |
| 8 | **跨入口流程的数据落点必须区分用户语义**（按钮抓取 = 换内容；后台批量入库 = 开新工作单元） | importCurrentSourceToArticle / `_hasMeaningfulArticle` | 2026-04-30 36th | — |
| 9 | **「整体恢复」与「单篇追加」是两种独立用户语义，UI 入口必须分开** | history drawer / picker modal | 2026-04-30 37th | — |
| 10 | **多通道功能 UI 必须按当前选中通道做 mode-aware 主次切换**（不能硬编码让用户判断） | publish 面板 browser/api 模式 | 2026-04-30 38th | — |
| 11 | **危险 / 不可逆操作必须二次确认**（撤不回的操作前必须 modal 拦一道） | 立即发布 / 全员群发 / 删除 | 2026-04-30 38th 续 | — |
| 12 | **多操作并列 UI 必须有视觉层次**（≥3 按钮平排时按用途分组 + 分隔线） | publish-actions primary/secondary | 2026-04-30 38th 续 | — |
| 13 | **按钮防抖必须放在 click handler，不能放在被调用函数体内** | retry button / autoRewrite 引导 | 2026-04-30 38th 续 2 | (强化 #5) |
| 14 | **加新机制后必须 grep 所有同语义入口逐一检查同步**（commit msg 末尾贴入口清单） | in-flight 守卫 / cross-type cancel / `_disabled` filter | 2026-04-30 38th 续 5 / 13 | 3 |
| 15 | **异步 task 模式下所有 send-out 入口必须先检查 in-flight task 状态**（同步/发布前 LIST_TASKS 检查） | publishBundle / syncCurrentToWebEditor / 浮球 PULL | 2026-04-30 38th 续 11 | — |
| 16 | **第三方 contenteditable 编辑器（mp 等）的 `insertHTML` 是独立 sanitize 层**——同 HTML 在 cgi-bin 通过不代表 contenteditable 通过 | mp 编辑器 / prepareHtmlForWechat | 2026-04-30 38th 续 12 | — |
| 17 | **付费功能 schema 演进：plans-based 与 tier-based 并存共生，不删旧 schema** | PAID_FEATURES.plans / tier 字段 | 2026-05-02 39th | — |
| 18 | **跨多界面文案改造维护「N 处对齐清单」 写 commit msg 末尾防漂移** | pricing / privacy / dashboard / faq / docs | 2026-05-03 39th 续 | — |
| 19 | **部署 checklist 给用户的命令绝对不能用 zsh 行内 `#` 注释**（用 SQL 风格 `--` 或多行 docstring） | wrangler 命令 / migration sql | 2026-05-04 39th 续 | 2 (踩 2 次) |
| 20 | **plan / SKU schema 演进不要硬编码默认值**——必须接受参数 + 显式归一化（`planCode \|\| 'pro'`） | issueProLicense / virtual SKU | 2026-05-04 39th 续 | — |
| 21 | **流式响应路径不要做 fallback 链**——半途切换上游会产生错位 JSON | /api/llm/stream / 流式 SSE | 2026-05-04 39th 续 | — |
| 22 | **gitignore dir-level + file-level 例外组合失效**——`dir/` ignore + `!dir/file` 例外不生效（git 不递归进 ignored dir）；必须改 `dir/*` + `dir/.*` + `!dir/file` | .gitignore / memory-bank/reflexes.md | 2026-05-07 39th 续³ | — |
| 23 | **客户端生成的 fingerprint / UUID 永远是软标识**——不能作为 anti-abuse 唯一信任锚；攻击者改一行扩展代码即可任意伪造。设备唯一性 = client-side trust + server-side rate limit + anomaly detection 三层联防，**信任边界永远在 server 一侧** | device fingerprint / Phase 6 sketch | 2026-05-07 39th 续³ Batch 5 | — |
| 24 | **转发用户 body 给计费上游的路径必须白名单/钳制放大类参数**（删 `n`/`best_of`/`logit_bias`，按 plan 钳 `max_tokens`）——配额按次数/token 计与单次 n/max_tokens 无关，`{...body}` 直传 = 财务 DoS | LLM 代理 / upstream.js sanitizeForwardBody | 2026-05-29 40th | — |
| 25 | **`plan` 字段「verify→saveLicenseRecord→evaluateLicense→各闸门」4 处任一写 `=== "pro" ? : "free"` 都会让月费/年费全链路降级**——归一化集中到 `isPaidPlan`，新增付费档必 grep 全仓 `=== "pro"` | license plan 塌缩 / SKU | 2026-05-29 40th | (强化 #20) |
| 26 | **长 TTL 的 JWT 必须有 server 侧吊销位**（用户表 epoch + claims.te + verify 比对 + 敏感操作 bump）——否则改密/重置后被盗 token 存活满 TTL，"改密自救"失效 | JWT / token_epoch / 改密重置 | 2026-05-29 40th | — |
| 27 | **D1/SQL 限额"先 COUNT 再 INSERT"非原子，并发可绕过硬上限**——必须 `INSERT...SELECT...WHERE (SELECT COUNT...)<limit` + 检 `meta.changes` | device_activations / 配额硬卡 | 2026-05-29 40th | — |
| 28 | **第三方/抓取来源 URL 进 `<a href>` 必须 protocol allowlist（仅 http(s)）**——`escapeHtml`/`escapeAttr` 只防属性闭合，挡不住 `javascript:` scheme（扩展页点击执行脚本）；用 `utils.safeHttpUrl` | href XSS / 选题卡 / 抓取链接 | 2026-05-29 40th | — |
| 29 | **`withRetry` 类重试必须按 `error.code` 跳过不可重试错误**（鉴权/配额/套餐闸门）——否则平台计费路径下重试会二次扣额度 | withRetry / 平台 LLM 计费 | 2026-05-29 40th | — |
| 30 | **`try { switch }` 内的 `break`/`return` 退出 switch 不触发该 try 的 catch/finally**——已注册的副作用资源（task / 锁 / timer）必须在每个提前退出分支显式清理 | task registry 泄漏 / 闸门 break | 2026-05-29 40th | — |
| 31 | **去 AI 味「替换字典」用固定映射会反噬**——把一个 AI 词机械换成另一个可识别 AI 词（"与此同时"→"差不多同期"）。替换映射给多选 + prompt 要求每处变化；固定产物泛滥后进黑名单 | humanize-rules / AI_VOCAB_REPLACEMENTS | 2026-05-29 41st | — |
| 32 | **注入第三方富文本编辑器（mp ProseMirror）优先合成 `paste`（ClipboardEvent+text/html）**走其自身粘贴管线；`innerHTML`/`execCommand insertHTML` 可能被回滚或丢样式；但保留三级兜底不删可用路径（写入与否用 innerHTML 长度判定） | mp 注入 / setEditorHtml | 2026-05-29 41st | (关联 #16) |
| 33 | **后台"找一个同类扩展 tab 干活"不能盲取 `tabs.query()[0]`**（最老 tab，状态陈旧）——按 `lastAccessed` 取最近聚焦 tab，否则多开 tab 时状态串篇（"同步的是上一篇"） | runFloatingBallPull / 多 tab | 2026-05-29 41st | — |
| 34 | **新增 `PAID_FEATURES` 付费功能 key 必须同步 `server/worker.js` `PAID_FEATURE_KEYS`**——否则「PAID_FEATURE 前后端对齐」smoke 单测 FAIL（客户端 plans 闸门是软的，server 的 key 列表是 SSOT）。同理改任何「N 处对齐清单」项要 grep 全套 | PAID_FEATURES / ai.quoteCards / 前后端对齐 | 2026-05-31 42nd | (关联 #14/#18) |
| 35 | **写第三方 contenteditable 编辑器的 fallback 判定要看「新内容是否写进去」，不能看「编辑器是否为空」**——`setEditorHtml` 旧逻辑用 `innerHTML.length<20`（≈编辑器空）才触发 execCommand/innerHTML 兜底；第一篇导入后编辑器非空，第二篇起合成 paste 被 ProseMirror 忽略（非 isTrusted）而兜底被跳过→永远停在第一篇，必须关 tab 重开才行。改判定为「期望内容的文本指纹是否已出现在编辑器里」+ selectAll 强制整篇替换 | setEditorHtml / mp 连续导入 | 2026-06-03 42nd | (修正 #32 的「长度判定") |
| 36 | **多 mode 共用的 UI 控件（按钮/输入）做校验时必须按当前 mode 分流，不能只走默认 mode 路径**——「测试连接」按钮在平台/BYOK 两面板**之外**共用，旧逻辑无脑走 BYOK 三件套校验，平台模式下 apiKey 为空被 `请先填写 API Key` 拦死，让免费用户误以为平台 AI 用不了。修法：点击时读当前 `aiSourceMode` 传给后台，`testAiConnection` 顶部 `if(mode==="platform")` 分流到 JWT 鉴权的 `/api/llm/usage` 测试。判定原则：加/改任何「被多入口或多状态复用」的控件逻辑时，先列出它服务的所有 mode/状态，逐一确认分支，别让默认分支吃掉其它 mode。**06-10 补强实证（同 bug 两轮才修干净）**：06-04 只修了测试连接 1 处，用户再报「还是要填 Key」——又揪出 4 处「只认 apiKey」入口：`hasUsableAiConfig` 改写前置闸门（真正拦截器）/ workspace aiPill / popup AI 卡 / modal 文案。**修 mode 相关校验时第一动作就是 `grep apiKey`（或对应判定字段）全仓列清单**，不要修一处交差 | options.js testAiConnection + workspace-rewrite hasUsableAiConfig / 平台 vs BYOK | 2026-06-04 42nd + 2026-06-10 43rd | (关联 #14 同语义入口清单) |
| 37 | **HTML 里加表单控件必须同步接 hydrate/save 链，且「留空=不下发」字段要做空串保全**——options.html 里 `topP`/`frequencyPenalty`/`presencePenalty`/`humanizeEnabled`/`humanizeIntensity` 5 个控件存在了多个 session 但从未进 options.js `fields` 字典：用户改了不报错也不生效（defaults 兜底值一直在用），是最难被发现的"幽灵设置"。接入时还有第二坑：saveForm 通用循环对 `type=number` 做 `Number(field.value)`，空串变 0——把「留空=用服务端默认」语义变成「显式下发 0」（top_p=0 会彻底改变采样行为）。修法：保存末尾对这类字段空值改回 `""`（下游 `numberOrNull` 跳过空串）。判定原则：加控件的 PR 必须三件套齐活——HTML 控件 + fields/hydrate 接线 + 保存语义检查（特别是「空=不发」类）；review 时 grep 控件 id 在 JS 里出现次数，0 次 = 幽灵设置 | options fields 字典 / topP 空串保全 / 幽灵设置 | 2026-06-10 43rd 续 | — |

---

## 模式约定（progress.md 未显式编号但同样硬约定）

按主题分组。命中时按对应 progress.md 段查详细修法。

### 工程实践

- **Options 页删 HTML 不能只删 HTML**——必须同步删 `fields` 字典 + listener + check:ext sectionKeys 断言（[2026-04-26 18th](./progress.md)）
- **Options 页运营品牌元信息（产品名/客服邮箱/官网 URL）写死在 defaults，不进 UI**——字段主人是「运营方」就不进 options（[2026-04-25 13th](./progress.md)）
- **AI 自动产出的辅助字段（subtitle / 自动 og: 提取）不进 UI 编辑入口**——AI 自动写 + UI 让用户改 = 死结（[2026-04-26 15th](./progress.md)）
- **字段长度类约束三处必须同步**：`WECHAT_FIELD_LIMITS` 常量 + HTML hint 文案 + `validateCurrentArticleForPublish`（[2026-04-26 15th](./progress.md)）
- **跨多模块共享的规则常量必须 SSOT**——抽 `shared/<domain>-rules.js`（如 humanize-rules）（[2026-04-26 17th](./progress.md)）
- **chrome.storage.local 大对象（>5KB 或数量>10）走独立 storage key**——voice-samples / draft-history / templates（[2026-04-26 17th](./progress.md)）
- **D1 增量迁移与全新初始化的边界**：`schema.sql` 已含某列后，**全新库不要再单独跑对应增量迁移**（会 `duplicate column`）；增量迁移（如 `005_token_epoch.sql`）只对「已存在的旧库」补列。local dev 库没建表时跑迁移报 `no such table` 属预期（先灌 schema.sql 再补迁移）（[2026-05-29 40th](./progress.md)）

### MV3 / Service Worker

- **MV3 service worker 禁用 `await import()`**——顶部静态 import 唯一合法（[reference](../~/.claude/projects/-Users-junshengma-Desktop-gzh/memory/reference_mv3_sw_no_dynamic_import.md)）
- **MV3 service worker 禁用 DOMParser / window / document**——剥 HTML 用 `humanize-checker.stripHtmlTags` regex 版（[2026-04-26 17th](./progress.md)）
- **MV3 `chrome.permissions.request` 必须挂 user gesture**——popup 间接链路（4-5 跳）也要在第一个 click handler 同步发起（[2026-04-30 38th 续 3](./progress.md)）
- **content script 没有 `chrome.tabs` API**——想开 tab / query 必须 sendMessage 让 SW 代办（[reference](../~/.claude/projects/-Users-junshengma-Desktop-gzh/memory/reference_content_script_no_chrome_tabs.md)）
- **扩展代码改动可能没生效的两个陷阱**：① content script 不随扩展 reload 更新；② worktree 改动不进主目录 Chrome 加载的扩展（[reference](../~/.claude/projects/-Users-junshengma-Desktop-gzh/memory/reference_extension_reload_pitfalls.md)）

### HTTP / 错误码契约

- **HTTP 401 仅留给 JWT 失效**——已认证路径下业务校验失败用 400/403/422（[2026-04-29 24th](./progress.md)）
- **下游模糊错盖住上游精确错 = silent failure 反模式**——catch 后不能完整恢复必须 throw enriched Error（[2026-04-26 14th](./progress.md)）
- **外部 API 类辅助函数必须返回 status，不能 void**——邮件 / SMS / 对象存储等隐藏调用网络的函数（[2026-04-29 24th](./progress.md)）
- **DEBUG_\* 开关在敏感泄露场景必须双因子**（`DEBUG_RESET=1` + `ENVIRONMENT=development`）（[2026-04-29 24th](./progress.md)）
- **必要凭证未配置时必须前端早拦截**——不能让流程跑到 SW / 远端撞底层错（user gesture / 401 / NaN）；用 modal + 直达 CTA（[2026-04-29 25th + 27th](./progress.md)）
- **PRO 增值功能失败必须不阻断主链路**——`check*Access()` 返 `{ok, reason}` 不抛错；调用方 try/catch（[2026-04-26 17th](./progress.md)）

### 微信公众号特有

- **mp 编辑器命中策略**：URL 必须含 `action=edit|add`；DOM 必须有 contenteditable；双 sanitizer 同步（[reference](../~/.claude/projects/-Users-junshengma-Desktop-gzh/memory/reference_mp_editor_selectors.md)）
- **新加微信 errcode 翻译必须照「IP 透传 5 件套」契约**：catalog + extract + buildWechatError + classifyError + SW 透传 detectedXxx（[2026-04-26 14th](./progress.md)）
- **publishMode 命名约定**：`profile.mode`("api"/"browser") vs `payload.publishMode`("draft"/"publish") 不要混（[reference](../~/.claude/projects/-Users-junshengma-Desktop-gzh/memory/reference_publish_mode_naming.md)）
- **浏览器登录模式是 C 端默认通道**——排查发布失败先看 `profile.mode` 决定方向（[reference](../~/.claude/projects/-Users-junshengma-Desktop-gzh/memory/project_browser_login_mode.md)）

### LLM / API

- **OpenAI 兼容 optional 数值参数空字符串 ≠ 0**——`top_p / freq_penalty / presence_penalty` 留空 = 不下发；UI 接受空串、storage 保留 `""`、ai.js `numberOrNull` 转 null（[2026-04-26 17th](./progress.md)）
- **推理模型采样字段被拒**：kimi-k2.x / o-series / R1 / Claude thinking 拒 `temperature` 等参数；空 content 看 `reasoning_content`（[reference](../~/.claude/projects/-Users-junshengma-Desktop-gzh/memory/reference_reasoning_models_compat.md)）
- **DeepSeek 当前可用模型名**：v4-flash / v4-pro 是新名；`deepseek-chat / -reasoner` 2026-07-24 弃用（[reference](../~/.claude/projects/-Users-junshengma-Desktop-gzh/memory/reference_deepseek_models.md)）

### 网站 / 部署

- **改 `site/` 下任何 JS 后必须 bump HTML script `?v=YYYYMMDDx` cache buster**（[2026-04-26](./progress.md)）
- **「前端轮询 + 后端 webhook」流程必须配「我已完成 XXX，立即查询」主动按钮**（[2026-04-26](./progress.md)）
- **broadcast payload 体积优化时前端必须配显式 GET_xxx 兜底拉取**——TASK_LIST_CHANGED 剔 `result` 字段配 GET_TASK_RESULT（[2026-04-30 34th](./progress.md)）
- **HTML5 `hidden` + 非默认 display 必须显式 `[hidden] {display:none}`**（UA 样式优先级最低被业务覆盖）（[2026-04-25 / 2026-04-30 34th](./progress.md)）
- **popup 不能只在打开时读 settings**——派生状态（AI 模型 / 会员）必须监听 `chrome.storage.onChanged`（[2026-04-26 18th](./progress.md)）

### 凭据 / 隐私

- **不要肉眼抄虎皮椒 AppID/AppSecret**——必须从控制台「点复制按钮」（手抄过两次都错过尾部 1-2 字符）（[2026-04-26](./progress.md)）
- **Resend DKIM CNAME 在 Cloudflare DNS 必须改成灰云（DNS only）**——橙云会让 Resend 验证永远失败（[2026-04-24](./progress.md)）
- **OAuth provider 的 `password_salt` 必须存成 `oauth:<provider>` 形式**（让 `isUsablePasswordHash` 能识别；如 `oauth:google` / `oauth:github`）（[2026-04-24](./progress.md)）
- **Worker 调外部 HTTP API 必须默认带「请求出参 + 响应入参」双 log**（[2026-04-26](./progress.md)）
- **「用户输入文本会出本机走 HTTP」UI 必须显式声明**——voice-samples 提取指纹 / topic-planner 等（[2026-04-26 17th](./progress.md)）
- **给用户/客服的 curl 模板禁用 `<xxx>` 尖括号占位符**——shell 解释会撞 redirect（[2026-04-24](./progress.md)）
- **演示/测试涉及 JWT 时优先用浏览器 Console fetch**，避免 token 落剪贴板/shell history/截图（[2026-04-24](./progress.md)）

### Memory / 元数据

- **主目录可能有前一任 Claude 没合并的脏工作**——push/merge 前先 `git status` 主目录（[feedback](../~/.claude/projects/-Users-junshengma-Desktop-gzh/memory/feedback_main_dir_stale_claude_work.md)）
- **worktree 关闭前必同步 memory-bank**——memory-bank/ 不在 git，worktree 删了就丢；`scripts/recover-memory-bank.mjs` 兜底（[feedback](../~/.claude/projects/-Users-junshengma-Desktop-gzh/memory/feedback_worktree_memory_bank_sync.md)）
- **设置页字段文案统一模式**：主标题用结果导向、英文术语降副标题、field-hint 必答"何时改 + 填错怎样"（[feedback](../~/.claude/projects/-Users-junshengma-Desktop-gzh/memory/feedback_options_field_copy_pattern.md)）
- **options.js saveForm required 拦截**——加 / 改 AI 字段时必须 change 即时 saveSettings 解耦（[reference](../~/.claude/projects/-Users-junshengma-Desktop-gzh/memory/reference_options_saveform_required_block.md)）
- **task-registry 不要做同 article dedup**——后台任务 registry 不能因为"同 articleId+同 type"自动取消老 task（[feedback](../~/.claude/projects/-Users-junshengma-Desktop-gzh/memory/feedback_task_registry_no_dedup.md)）

### 姊妹项目

- **润笔砚台姊妹项目**（`~/Desktop/runbi-inkstone/`）是独立 WXT+React+Tailwind 扩展——改 gzh 浮球/tokens 时记得它存在，两份分别维护（[reference](../~/.claude/projects/-Users-junshengma-Desktop-gzh/memory/project_runbi_inkstone_sibling.md)）

---

## 维护说明

- **新增反例约定时**：先在 [progress.md](./progress.md) 末尾详细写一段（含触发场景 / 错误模式 / 修法 / 判定原则），然后回本文件加一行表格条目 + 链接日期
- **强化沉淀**：同问题再踩时不增编号，原编号「强化次数」+1，progress.md 段落里追加「再踩日期 + 多走的判断」
- **跨编号关联**：如 #5 (UI 防抖) 强化为 #13 (click handler) — 两条都保留，互相 link
- **过期废弃**：旧约定已被新模式取代时，加「⚠️ 已过期：被 #N 替代」备注，**不要删行**
- **本文件长度警戒线 ≤ 200 行**：超过说明该把细则二级分组拆到独立 `reflexes/<topic>.md`（如 `reflexes/mv3.md` / `reflexes/wechat.md`）

## 修订历史

- 2026-05-07 初版（39th session 收尾后建立，从 progress.md 整理 21 条主反例约定 + 30+ 条模式约定，建立编号体系）
- 2026-05-29 40th session：新增主反例约定第 24-30 条（LLM 参数钳制 / plan 塌缩链路 / JWT 吊销 / D1 限额原子 / href 协议 allowlist / withRetry 不可重试码 / try-switch break 不触发 catch）+ 工程实践加「D1 增量迁移边界」
- 2026-05-29 41st session：新增第 31-33 条（替换字典反噬 / mp ProseMirror paste 注入 / 多 tab 委托取最近聚焦 tab）
- 2026-05-31 42nd session：新增第 34 条（新增 PAID_FEATURES key 必须同步 worker.js PAID_FEATURE_KEYS，前后端对齐 smoke 强制）
- 2026-06-03 42nd session 续：新增第 35 条（contenteditable 写入 fallback 判定看「新内容是否写进去」而非「编辑器是否为空」，修正 #32；连续导入第二篇读旧内容根因）
- 2026-06-04 42nd session 续²：新增第 36 条（多 mode 共用 UI 控件校验必须按当前 mode 分流——平台 AI「测试连接」误报「请先填写 API Key」根因）
- 2026-06-10 43rd session：第 36 条补强实证——同 bug 两轮才修干净，又揪出 4 处「只认 apiKey」入口（hasUsableAiConfig 改写闸门 / aiPill / popup 卡 / modal 文案）；判定原则升级为「修 mode 相关校验第一动作 grep 判定字段全仓列清单」。另：defaults.js aiSourceMode 默认 byok→platform（未上架无老用户包袱）
