# 润笔 DocuEarn · AI 协作索引

> 这个文件是 AI（Claude Code / Cursor / Cline 等）每次启动 session 时**自动注入 context** 的压缩索引。
> 项目级详情**按需 Read** `memory-bank/*.md`，不要全量加载（会爆 context）。
> 写入纪律见底部。

---

## 5 件最重要的事

1. **四段式架构**：Chrome MV3 扩展（`src/`） + Cloudflare Worker（`server/worker.js` 单文件）+ 静态官网（`site/`） + 桌面助手 Runbi Helper（`desktop/`，PyInstaller 打 .app/.exe）
2. **当前版本 0.3.2**（manifest.json 是版本号唯一真源；`npm run version:sync` 同步到 package.json）
3. **License 反向 gating 模型**：Free 1 设备 / Monthly 3 设备 / Yearly 10 设备 + 🔓 自定义 API Key 仅年费独享（详细配额见下方表）
4. **Worker 已在 production**：`https://api.docuearn.com` · 最新 Version `d443df79`（2026-05-04）
5. **不要碰**：用户 AI key / wechat AppSecret / License key 永远不写 memory-bank、commit msg、log 输出

---

## 当前焦点（更新于 2026-05-07）

39th session plan 文件已 100% 完结。**最近 16 commit 全 push origin/main**（最新 `e3f42da`）。
最近一次工作：装 Addy Osmani agent-skills（21 skills + 7 commands + 3 agents）+ Phase 4 review 反馈 Top 3 修订。

待办候选（无优先级）：
- 处理 review 中等问题（KV race 注释 / device_limit 邮件 7 天 1 封 / set length cap 注释挑明）
- 把 `buildSecurityAlertContent` + 阈值常量重构到 `server/security/*.js`（worker.js 瘦身）
- 用户侧「我的账户安全」dashboard 卡片（与告警邮件互补）
- admin dashboard 监控 audit_log + verify_log 异常聚合

---

## License / SKU 配额（14 处对齐清单的 source of truth）

| | Free | Monthly ¥29 | Yearly ¥288 |
|---|---|---|---|
| 平台 AI · 经济档（DeepSeek V4 Flash） | 30 次/月 | ✓ | ✓ |
| 平台 AI · 标准档（DeepSeek V4 Pro） | ❌ | 5M token/月 | ✓ |
| 平台 AI · 旗舰档（GPT-4o） | ❌ | ❌ | 20M token/月 |
| 自定义 API Key（BYOK） | ❌ | ❌ | ✅ 独享 |
| 设备同时激活上限 | 1 | 3 | 10 |
| 多公众号绑定 | 1 | 5 | 5 |

调阈值时记得同步**这 14 处**：扩展端 5（`license.js` PAID_FEATURES.plans / `providers.js` platform / `ai.js` requestRewriteViaPlatform / `options.html` radio + tier / `popup.html`）+ 后端 4（`router.js` MODEL_TIERS+PLAN_QUOTA / `worker.js` derivePlanForLlm + DEVICE_LIMITS / `upstream.js` callUpstreamWithFallback / `003_llm_usage.sql`）+ 网站 5（pricing 三卡 / privacy §2-§4 / dashboard 用量卡 / index hero / faq+terms+changelog+docs）。

---

## 关键反例约定（最常踩，按频次排）

| # | 一句话规避 | 详情 |
|---|---|---|
| 1 | bootstrap 顺序需要 query param 时**优先 inline `URLSearchParams.get`**——const + 后续使用必踩 TDZ | `progress.md` 第 1 条强化 / 38th 续 14 |
| 2 | options.js `saveForm` 有 required 校验拦截——加/改 AI 字段时**必须 change 即时 saveSettings** 解耦 | `MEMORY.md` reference_options_saveform_required_block |
| 3 | MV3 service worker **禁用 `await import()`**——顶部静态 import 唯一合法 | `MEMORY.md` reference_mv3_sw_no_dynamic_import |
| 13 | 按钮防抖必须放 click handler，**不能放被调用的函数体**——否则 retry / task center / 自动引导链路全被 guard | `progress.md` 第 13 条 / 38th 续 2 |
| 14 | 加新机制后**列出所有同语义入口清单**写到 commit msg——下次 review 锚点 | `progress.md` 第 14 条 |
| 15 | 异步 task 模式下所有 send-out（同步/发布）入口**必须先检查 in-flight 状态** | `progress.md` 第 15 条 |
| 16 | 第三方 contenteditable 编辑器（mp 等）的 `insertHTML` 是**独立 sanitize 层**——同 HTML 在 cgi-bin 通过不代表 contenteditable 通过 | `progress.md` 第 16 条 |
| 17 | 付费功能 schema 演进：plans-based 与 tier-based **并存共生**，不删旧 schema | `progress.md` 第 17 条 |
| 18 | **跨多界面文案改造维护「N 处对齐清单」** 写 commit msg 末尾防漂移 | `progress.md` 第 18 条 |
| 19 | 部署 checklist 给用户的命令**绝对不能用 zsh 行内 `#` 注释**——用 `--` SQL 风格或多行 docstring | `progress.md` 第 19 条（已踩 2 次） |
| 20 | plan/SKU schema 演进**不要硬编码默认值**——必须接受参数 + 显式归一化 | `progress.md` 第 20 条 |
| 21 | **流式响应路径不要做 fallback 链**——半途切上游会产生错位 JSON | `progress.md` 第 21 条 |

完整 21 条见 `memory-bank/progress.md`「反例约定第 N 条」搜索。

---

## 验证 SOP（每次落地必跑）

```sh
# 三件套
node scripts/smoke.mjs        # 46 case：router 28 + upstream 6 + worker phase 4 12
npm run check:ext             # 40 件 UI / section 锚点 / 路由 检查
node --check <file>           # 触改的 .js / .mjs 单文件 syntax check（不需要 npm 也能跑）
```

```sh
# 上游契约（手动，需要 JWT）
curl https://api.docuearn.com/api/health
curl -H "Authorization: Bearer $JWT" https://api.docuearn.com/api/llm/usage
```

```sh
# 部署
cd server && wrangler deploy                                        # worker 部署
git push origin main                                                # 网站走 Cloudflare Pages auto-deploy
wrangler d1 execute gzh-license --remote --file=./migrations/X.sql  # D1 schema 迁移
wrangler secret put OPENAI_API_KEY                                  # 注入私密变量
```

---

## 详情去哪查

| 想知道 | 去哪查 |
|---|---|
| 项目定位 / 范围 | `memory-bank/projectbrief.md` |
| 为什么存在 / UX 目标 | `memory-bank/productContext.md` |
| 技术栈 / 运行时 / 版本 | `memory-bank/techContext.md` |
| 架构模式 / 模块关系 / SOP | `memory-bank/systemPatterns.md` |
| 当前焦点 / 跨 session 记忆 / 决策归档 | `memory-bank/activeContext.md` 顶部 |
| 历史 session（按日期） | `memory-bank/activeContext.md` 中段（2026-04 起，append-only） |
| 已完成功能清单 + 反例约定 21 条 | `memory-bank/progress.md` |
| 4 phase 实施 plan | `.claude/plans/iridescent-sprouting-moore.md` |
| Plan / Skill 系统 | `~/.claude/skills/`（含 21 addy skills + 4 项目 skills） |

---

## 写入 memory-bank 的纪律（AI 必读）

- **只增不减**：activeContext.md / progress.md 是 append-only 工作日志，**不是状态快照**
- **当前焦点段可整段替换**；session 历史段**永不删除**，只增不减
- **决策被推翻**：旧决策加 ~~strikethrough~~ + 备注「✅ 已决：XXX，见 YYYY-MM-DD」，**不删行**
- **反例发现**：编号递增追加到 `progress.md`「反例约定第 N 条」格式：踩坑场景 / 错误模式 / 正确做法 / 防再踩判定原则
- **session 启动**：必读本 `CLAUDE.md` + `activeContext.md` 顶部「当前工作焦点」段，**不要全文加载** memory-bank
- **session 完成**：用户喊「记录到 memory-bank」时按以上规则更新

膨胀治理：`activeContext.md` 已 4400+ 行，下次满 60 天 session 详情时切到 `archive/YYYY-MM.md`。

---

## 常用命令速查

```sh
npm run dev                     # 扩展开发模式（watch + 自动 reload）
npm run check:js                # JS/MJS 语法检查
npm run check:ext               # UI / 路由检查（40 件）
npm run test:smoke              # 46 case 冒烟
npm run version:sync            # manifest.json → package.json
cd server && wrangler dev       # worker 本地起
cd desktop && python build.py   # 桌面助手打包（需 python.org Python，非 Homebrew）
```

---

> **写入说明**：本文件应保持 ~150 行。增加内容时请优先放进 `memory-bank/` 对应文件，本索引只放最高优先级的 5-7 条。修改时记录在本文件底部「修订历史」段。

## 修订历史
- 2026-05-07 初版（39th session 收尾后建立，sediment 反例约定 21 条 + 14 处对齐清单 + 验证 SOP 三件套）
