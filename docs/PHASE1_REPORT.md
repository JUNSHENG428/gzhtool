# Phase 1 自动化机测报告 + Phase 2 手测清单

> 跑完了所有不依赖真凭证的自动化检查，给你一份一目了然的总结。
>
> **总成绩**：共 63 项检查 / 60 ✓ / 3 ⚠️ / 0 ❌
>
> 没有阻塞性 bug，所有警告都是产品/UX 议题，不是功能问题。

---

## ✅ 已自动验证通过的（60 项）

| 维度 | 项数 | 关键结论 |
|---|---|---|
| 扩展加载 + Service Worker | 2 | SW 启动无报错，extension ID 拿得到 |
| 16 个静态页面加载 + console | 16 | popup / options / 9 个 workspace 路由 / 5 个独立页全部干净 |
| Workspace 7 个 hash 路由 | 8 | dashboard / capture / layout / publish / hot / agent / member 切换正确，console 干净 |
| Options 12 个 section | 12 | 所有 quicknav 锚点存在 |
| Popup 3 个 tab 切换 | 3 | 写作 / 热点 / 我的 都能切 |
| Member 页 4 个核心卡 | 4 | hero / quota / features / actions 都渲染 |
| 排版主题 | 3 | 11 套主题全部能选、能渲染、console 干净 |
| AI 模板生成器（Pro 闸门） | 5 | free 弹升级框 / fake-pro 后弹 6 题问卷 + 7 张主题卡 |
| License pill 一致性 | 4 | popup / options / workspace 三处文案都是「免费版」 |
| 全站品牌名一致性 | 5 | 5 个静态页都不出现旧名 |
| 100 次 hash 切换 console | 1 | 切换过程无报错 |
| Smoke（manifest / 65 个 JS / 7 个单元） | 16 | 全部通过 |

---

## ⚠️ 待你拍板的 3 个产品/UX 议题

### W1 · 默认 novice 模式下，"AI 模板生成器"按钮被藏起来了

**事实**：

- Options 页 `prompt-template-card` section 上有 `data-advanced="true"`
- 默认进 options 是 novice 模式（body 上有 `data-novice-mode="on"`），CSS 把所有 advanced section 折叠
- 用户必须先手动切到「专家模式」才能看到「AI 生成模板」按钮
- 但 AI 模板生成器是你的 Pro 主要卖点之一

**取舍**：

| 选项 | 利 | 弊 |
|---|---|---|
| A. 默认露出（移除 prompt-template-card 的 data-advanced） | Pro 卖点曝光 +++ | novice 模式信息密度变高 |
| B. 在 novice 模式专门给「AI 生成模板」一个 promo 入口卡 | 既保持极简又凸显卖点 | 多写一段 UI |
| C. 维持现状 | 简洁 | Pro 转化率受影响 |

**我建议 B**：在 quick-start 卡下面加一张"AI 生成模板"宣传卡（带 PRO 标），点击直接打开问卷或弹升级框。

---

### W2 · 排版主题数和宣传不符（11 套 vs 6 套）

**事实**：

- `THEME_PRESETS` 里有 11 个 theme：5 个早期主题（editorial-green / modern-amber / minimal-mono / warm-rose / tech-blue）+ 6 个后加的杂志母版（editorial-newyorker / kinfolk-quiet / wired-neon / monocle-soft / vogue-didone / paper-zine）
- `MAGAZINE_THEMES` 数组里只有 6+1（含润笔默认）
- 商店素材、CWS 截图、定价页都说"6 套杂志级母版"
- 用户在 layout 页 `<select>` 里看到 11 个，其中 5 个老主题视觉跟新母版严重不一致

**取舍**：

| 选项 | 利 | 弊 |
|---|---|---|
| A. 删掉 5 个老主题，保留 6+1 | 与宣传一致；视觉聚焦 | 已有用户在用老主题的草稿可能错乱 |
| B. 把 5 个老主题归到「经典」分组，6 个新母版放「杂志级」分组 | 渐进式 | UI 多一层选择 |
| C. 保留 11 套但宣传改成"11 套排版主题，含 6 套杂志级母版" | 不动代码 | 减弱"杂志级"卖点 |

**我建议 A 或 B**。你选 A 我帮你删；选 B 我帮你改 `<select>` 改成 `<optgroup>`。

---

### W3 · 100 次 hash 切换耗时 4.1s（平均 41ms/次）

**事实**：

- 不是 bug 也不影响真实使用（用户绝不会疯狂切 100 次）
- 但 41ms/次 偏慢，理想 < 20ms
- 主要时间花在每次切换都重新调 render 函数

**取舍**：可以不做。要做就在 `workspace-router.js` 里加 view 级别缓存，已渲染过的 view 切回时跳过 render。**优先级低**。

---

## 🤖 我跑过的自动化命令

```bash
# 单元 + 纯函数
npm run test:smoke           # ✓ 通过

# 真扩展加载 + 全量页面/路由
npm run check:ext            # ✓ 45/0/0

# Pro 闸门 + 6 套渲染 + 文案一致性
npm run check:features       # ✓ 18/2/0

# 一键全跑
npm run check:all
```

报告写在 `dist/check-reports/check-extension.md` 和 `check-features.md`。

---

# Phase 2 · 你的手测清单（按优先级排序）

> 用 fake-pro fixture 解锁所有 Pro 功能再跑这套，不需要真买 Pro。
>
> ```bash
> # 注入 fake-pro（粘到任一扩展页 DevTools Console）
> node scripts/dev-fixtures.mjs as-pro
> ```

## 🔥 P0 · 必须验过才能上线（3 项）

### P0-1 · AI 改写主流程（用你的 OpenAI 或 Claude key）

1. 在任意网页（建议知乎一篇答案）点工具栏图标 → "抓取当前页"
2. 编辑台 layout 页面应自动出现抓取结果
3. 选一个 prompt 模板，点"AI 改写当前篇"
4. **预期**：
   - 文字流式逐段出（不是一次弹出）
   - 完成后字数在配置范围
   - 没有 stack trace 弹窗
5. 切换 6 套杂志母版（newyorker / kinfolk / wired / monocle / vogue / paper），每个都看预览
6. **预期**：每套预览样式明显不一样、不出现错位 / 黑底白字混乱 / 字号失控

> 如果改写失败：把 console 里的报错截图给我，我现场修。

---

### P0-2 · 推到公众号草稿箱（用你已登录的公众号 Chrome）

1. 改写完成后切到 `#publish`
2. **预期**：底部"已识别公众号"列表至少出现 1 个
3. 勾选账号，点"推到 N 个账号草稿箱"
4. **预期**：进度反馈 + 成功 toast + 公众号后台真的能看到草稿
5. 草稿里检查：标题 / 摘要 / 作者 / 封面 / 段落 / 图片 / 链接 都正确
6. 把账号登出再推一次
7. **预期**：弹"账号未登录"友好提示（不是裸 stack）

> 如果识别不到账号：去 `mp.weixin.qq.com` 登一次再回来。识别到但推不上去：把 SW 控制台的网络请求截图给我。

---

### P0-3 · 全 5 个站点抓取试一遍

每个站点至少抓 1 篇，验证：

| 站点 | 测试链接示例 | 预期 |
|---|---|---|
| 知乎答案 | `https://www.zhihu.com/question/.../answer/...` | 标题 + 作者 + 正文段落 + 图片 |
| 知乎专栏 | `https://zhuanlan.zhihu.com/p/...` | 同上 |
| X 单条 | `https://x.com/.../status/...` | 文本 + 作者 + 时间 |
| X 串 | thread | 多条按顺序 |
| 小红书 | `https://www.xiaohongshu.com/explore/...` | 标题 + 正文 + 标签 + 图片 |
| Reddit | `https://www.reddit.com/r/.../comments/...` | 标题 + 帖子 + 顶部高赞回复 |
| 通用 | 任意博客 | 正文识别准确 |

> 任一站点抓不下来：告诉我站点 + 链接，我去看 content script 里的 selector 是不是该升级了。

---

## 🟡 P1 · 强烈建议（4 项）

### P1-1 · 反复抓取/改写/推送循环不卡

1. 连续做 3 篇文章的"抓 → 改 → 推"
2. **预期**：第 3 篇和第 1 篇一样快，浏览器不卡

### P1-2 · 关闭再打开 workspace，已编辑的草稿能恢复

1. 改了一半的草稿
2. 关掉 workspace tab
3. 重新打开 `#dashboard`
4. **预期**："最近草稿"列表里能看到，点击可恢复

### P1-3 · Service Worker 重启不丢数据

1. 改写到一半（触发了 license / settings 加载）
2. 在 `chrome://extensions` 找到"润笔"，点"刷新（重新加载）"
3. 回到 workspace 继续操作
4. **预期**：不报错、license 状态、设置都还在

### P1-4 · 热点功能：12 个源点一遍

1. 打开 popup → 热点 tab → 点"全部"
2. 切换 12 个 source（知乎 / 微博 / B 站 / X / Reddit / V2EX / GitHub / 36kr / 少数派 / IT之家 / 虎嗅 / 其他）
3. **预期**：每个 source 都能拉到列表，单条点击能在新标签页打开

---

## 🟢 P2 · 锦上添花（4 项）

### P2-1 · AI 选题代笔 Agent（先注入 fake-pro）

1. 用 `dev-fixtures as-pro` 解锁
2. 打开 `#agent` 视图
3. 勾选 1-2 个平台（知乎 + X，需要你已登录的）
4. 跑一次
5. **预期**：进度反馈 + 任务历史里出现这次任务

### P2-2 · 多账号闸门（free 上限 2 个）

1. `dev-fixtures reset`
2. options → 公众号管理 → 添加 3 个账号
3. **预期**：第 3 个被弹"免费版最多 2 个"框

### P2-3 · 字数 quota 闸门（free 每天 5 次）

1. `dev-fixtures reset`
2. 在 layout 页连续点 6 次"AI 改写"
3. **预期**：第 6 次弹"今日免费额度已用完"

### P2-4 · 隐私页 / 帮助页 / 欢迎页内容核对

1. 打开 popup → 我的 → 欢迎页 / 帮助
2. **预期**：文案准确、无错别字、所有外链能跳

---

## 📋 反馈方式

跑完上面任一项遇到问题：

1. **截图**：报错框 + DevTools console（重要！）
2. **复现步骤**：先做了什么 → 然后做了什么 → 期望什么 → 实际什么
3. 一次性发我：哪几条 ✅、哪几条 ❌

我会按你反馈的优先级现场修。

---

## ⏱ 预计耗时

| 等级 | 耗时 |
|---|---|
| P0 全部跑完 | 约 60 min |
| P0 + P1 | 约 2 h |
| P0 + P1 + P2 | 约 3-4 h |

我建议你：**先跑 P0 三项**（这是 CWS 上线的硬阻塞），跑完告诉我结果，我立刻修任何 ❌；P1 / P2 后续再来。
