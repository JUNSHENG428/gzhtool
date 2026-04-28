# 润笔 · 上线前自检清单

> 目标：在提交 Chrome Web Store 之前，把"好用、实用、高效"三件事一项一项验。
>
> 三个状态格：✅ 通过　❌ 不通过　🔧 已修复　⏳ 待验
>
> 每条标签：
> - 🤖 **机测** — 我（AI）用脚本/Playwright 自动跑，结果填在「实测」列
> - 👤 **手测** — 你需要在真实浏览器里点一遍，结果填在「实测」列
> - 🔀 **混合** — 我跑大部分，你补真凭证那一段

---

## 0 · 准备工作（一次性）

### 0.1 安装扩展为「未打包」模式

```bash
# 1. 当前目录就是扩展根目录（manifest.json 所在）
pwd  # → /Users/junshengma/Desktop/gzh

# 2. 打开 chrome://extensions
# 3. 右上角打开「开发者模式」
# 4. 点「加载已解压的扩展程序」
# 5. 选这个目录（gzh/），不要选 dist/zip 包
# 6. 记下分配到的 Extension ID（后面到处要用）
```

### 0.2 打开三个调试窗口

| 窗口 | 入口 | 用途 |
|---|---|---|
| Service Worker | chrome://extensions → 找到「润笔」→ 点击「Service Worker」 | 看 background 报错 |
| Popup | 工具栏图标右键 → "检查弹出内容" | 看 popup 报错 |
| Workspace | `chrome-extension://<ID>/src/workspace/workspace.html` 打开后 F12 | 看 workspace 报错 |

### 0.3 准备测试 fixtures

```bash
# 列出所有可用 fixture
node scripts/dev-fixtures.mjs

# 给我「fake Pro 状态」（这样不用真买 Pro 也能测全部 Pro 功能）
node scripts/dev-fixtures.mjs as-pro
# → 把输出的 chrome.storage.local.set(...) 整段粘到任一扩展页 DevTools Console

# 想回归全新用户：
node scripts/dev-fixtures.mjs reset

# 给一段假抓取结果跳过真抓取：
node scripts/dev-fixtures.mjs fake-source

# 给 5 篇假草稿测 dashboard 列表：
node scripts/dev-fixtures.mjs fake-history

# 测大文本性能：
node scripts/dev-fixtures.mjs big-source
```

---

## 1 · 安装与启动【冒烟】

| # | 检查项 | 标签 | 期望 | 实测 |
|---|---|---|---|---|
| 1.1 | manifest 解析无报错 | 🤖 | chrome://extensions 不出现红色"错误" | |
| 1.2 | Service Worker 启动后无 console error | 🤖 | SW 控制台干净 | |
| 1.3 | 4 个尺寸的图标都能加载（16/32/48/128） | 🤖 | 工具栏图标清晰 | |
| 1.4 | 安装后自动打开 welcome.html | 👤 | 第一次安装弹欢迎页 | |
| 1.5 | 工具栏图标 hover 显示完整名称 | 👤 | "润笔 · 公众号创作者的得力助手" | |

**机测命令**：

```bash
npm run test:smoke              # 现有冒烟（manifest/HTML/JS 语法/纯函数）
npm run check:js                # 全量 JS 语法
node scripts/cws-mcheck.mjs     # 待我写：Playwright 加载扩展验启动（见 §A）
```

---

## 2 · Popup（工具栏弹窗）

| # | 检查项 | 标签 | 期望 |
|---|---|---|---|
| 2.1 | 三个 Tab（写作/热点/我的）都能切 | 🤖 | aria-selected 切换正确 |
| 2.2 | 当前页卡片显示正确网页标题 | 👤 | 在任一网页打开 popup，标题正确 |
| 2.3 | "抓取当前页"按钮点击后能跳到编辑台 | 👤 | 编辑台显示该网页内容 |
| 2.4 | 三种抓取模式（选中/正文/原样）按钮可用 | 👤 | 三个模式互斥渲染 |
| 2.5 | 热点 Tab 自动加载第一批热点 | 🔀 | 列表渲染、点击能在新标签页打开 |
| 2.6 | "刷新热点"按钮工作 | 👤 | 列表刷新 |
| 2.7 | "我的" Tab 的 license pill 显示当前状态 | 🤖 | free 显示"免费版"、Pro 显示"Pro 会员" |
| 2.8 | "AI 接口"卡显示模型名称、Key 状态 | 👤 | 配置后显示模型，未配置显示"待设置" |
| 2.9 | 三个快捷链接（设置/欢迎页/工作台）都能跳 | 🤖 | 跳到对应 chrome-extension URL |

---

## 3 · Options（设置页）

> 10 个 section（侧栏 quicknav 锚点）：上手 / AI / 改写 / Prompt / 直连 / 多账号 / DrissionPage / 热点 / 会员激活 / 数据

| # | 检查项 | 标签 | 期望 |
|---|---|---|---|
| 3.1 | 侧栏锚点点击后页面平滑滚动到对应区 | 🤖 | scrollTop 改变 |
| 3.2 | AI 接口 Tab 能保存（OpenAI / Claude / 国产）配置 | 🔀 | reload 后值还在 |
| 3.3 | "测试 AI 连接" 按钮调用真实 API（用你的 Key） | 👤 | 显示 "✓ 模型可用 · 推理 N ms" |
| 3.4 | 品牌信息（公众号名 / 作者 / Slogan）能保存 | 🤖 | reload 后值还在 |
| 3.5 | 改写偏好（角色 / 字数 / 禁词）能保存 | 🤖 | reload 后值还在 |
| 3.6 | Prompt 模板列表渲染 | 🤖 | 5 个 preset + custom 区 |
| 3.7 | 创建自定义 Prompt 模板 | 👤 | 新增条目持久化 |
| 3.8 | **AI 模板生成器**（Pro）：未激活时点击触发 upgrade modal | 🤖 | 弹"Pro 专享"对话框 |
| 3.9 | **AI 模板生成器**（fake-pro 后）：7 题问卷可填可生成 | 🔀 | 生成后 Prompt 列表多一条 |
| 3.10 | 多公众号管理：免费 ≤2 个、Pro 无限 | 🤖 | 第 3 个被闸门拦下 |
| 3.11 | DrissionPage helper 配置能填，"测试连接"按钮工作 | 👤 | 填对 URL 后显示 "/health 200" |
| 3.12 | 热点信息源开关 12 个都能切 | 🤖 | 开关状态持久化 |
| 3.13 | 会员激活：未登录时显示"注册/登录" | 🤖 | 显示登录 form |
| 3.14 | 会员激活：fake-pro 后显示 user / key / 设备 / 到期 | 🤖 | 显示 dev@docuearn.com |
| 3.15 | 数据导出：按钮点击下载 JSON | 🤖 | download 触发 |
| 3.16 | 全清数据：二次确认 + 清空 storage | 🤖 | confirm 后 storage 空 |

---

## 4 · Workspace（工作台 · 6 个视图）

> hash 路由：#dashboard / #capture / #layout / #publish / #hot / #member

| # | 检查项 | 标签 | 期望 |
|---|---|---|---|
| 4.1 | 默认 hash 是 #dashboard，左侧 nav active 项正确 | 🤖 | nav-item.active 是「工作台」 |
| 4.2 | 6 个 hash 切换都能正确显示对应 view | 🤖 | data-view[data-active=true] 唯一 |
| 4.3 | dashboard 卡片显示真实统计（草稿/账号/今日改写/本月发布） | 🔀 | 数字与 storage 对应 |
| 4.4 | dashboard "最近草稿"列表点击恢复编辑 | 👤 | 跳到 #layout 并预填 |
| 4.5 | capture 页面：粘贴 URL → 抓取按钮工作 | 👤 | 进度反馈 + 完成后显示结果 |
| 4.6 | layout 页面 6 套母版预览渲染（New Yorker/Wired/Monocle/Vogue/Kinfolk/Paper） | 🤖 | 6 个 .preview 都有内容 |
| 4.7 | layout 页面切换母版后右侧渲染立即更新 | 🤖 | innerHTML 变化 |
| 4.8 | layout 页面 AI 改写按钮触发流式（mock 也行） | 🔀 | 文本一段段出 |
| 4.9 | layout 页面字数校验：超出范围会自动重写 | 🤖 | mock 一次太短的 → 触发 retry |
| 4.10 | publish 页面识别"已登录的公众号"列表 | 👤 | 至少识别到 1 个 |
| 4.11 | publish 页面多账号 checkbox 可勾选 | 🤖 | state 跟随 |
| 4.12 | publish "推到 N 个账号草稿箱"按钮工作 | 👤 | 显示成功 toast，公众号后台能看到草稿 |
| 4.13 | hot 页面与 hot-topics.html 显示一致 | 🤖 | 列表非空 |
| 4.14 | member 页面 4 个卡正确渲染（hero/quota/features/actions） | 🤖 | 节点齐全、license 状态正确 |
| 4.15 | member 页面 license 状态变化时实时更新（subscribe） | 🤖 | 在 SW 改 license → member 自动重渲 |

---

## 5 · 内容采集（5 个站点 + 通用）

| # | 站点 | 标签 | 期望 |
|---|---|---|---|
| 5.1 | 知乎答案 | 👤 | 标题 / 作者 / 正文 / 点赞数都能拿 |
| 5.2 | 知乎专栏文章 | 👤 | 同上 |
| 5.3 | X (Twitter) 单条推文 | 👤 | 文本 / 作者 / 时间 |
| 5.4 | X 推文串（thread） | 👤 | 多条按顺序合并 |
| 5.5 | 小红书笔记 | 👤 | 标题 / 正文 / 标签 / 图片链接 |
| 5.6 | Reddit 帖子 | 👤 | 标题 / 正文 / 顶部高赞回复 |
| 5.7 | 通用网页（任意博客） | 👤 | 调 article extractor，正文识别准确 |
| 5.8 | 网页右下角浮窗在 5 个站点都出现 | 👤 | 浮窗按钮可见、可点 |
| 5.9 | 抓取被网站反爬拦截时给友好提示 | 👤 | 不是裸 stack trace |
| 5.10 | DrissionPage 模式（Pro）：本地 helper 抓取成功 | 👤 | 需要本地装 DrissionPage helper |

**针对每个站点统一验证**：
- [ ] 标题能识别
- [ ] 作者能识别
- [ ] 正文段落顺序正确
- [ ] 内嵌图片 URL 能拿到
- [ ] 链接能跳回原文
- [ ] 数据进编辑台后渲染无乱码

---

## 6 · AI 改写

| # | 检查项 | 标签 | 期望 |
|---|---|---|---|
| 6.1 | 流式改写：文字一段段出 | 🔀 | 不是一次性弹出 |
| 6.2 | 改写完字数在范围内 | 🔀 | 用 mock LLM 反复触发字数验证 |
| 6.3 | 改写超时（如 60s 无响应）有错误提示 | 🤖 | 用 mock 模拟超时 |
| 6.4 | OpenAI / Claude / DeepSeek / 智谱 / Moonshot 都能跑 | 👤 | 你测能拿到 key 的几个 |
| 6.5 | API key 错误时显示明确错误（不是 401 裸码） | 🤖 | mock 401 |
| 6.6 | 角色 / 字数 / 禁词 的指令在 prompt 里出现 | 🤖 | 拦截 fetch，验 body |
| 6.7 | "禁词"在改写结果里 0 出现 | 👤 | 设禁词后真改一篇 |
| 6.8 | 免费版每天 5 次改写上限被 quota 拦 | 🤖 | 第 6 次 触发 modal |
| 6.9 | Pro 版无限次 | 🤖 | fake-pro 后跑 10 次都通过 |

---

## 7 · 排版（6 套母版 + AI 模板生成器）

| # | 检查项 | 标签 | 期望 |
|---|---|---|---|
| 7.1 | 6 套母版渲染都不报错 | 🤖 | 6 个 iframe/preview 节点都有 innerHTML |
| 7.2 | 切换母版时 inline style 变化（公众号需要 inline） | 🤖 | DOM 中 style 属性 |
| 7.3 | 公众号 CSS 雷区清洗（position:absolute → relative 等） | ✅🤖 | smoke 已覆盖 |
| 7.4 | 复制到剪贴板的 HTML 在公众号编辑器粘贴样式不丢 | 👤 | 真拿到公众号 |
| 7.5 | 大文本（10k 字）渲染不卡 | 🤖 | big-source fixture，渲染 < 500ms |
| 7.6 | AI 模板生成器：7 题问卷 UI 完整 | 🤖 | 7 个 question card |
| 7.7 | AI 模板生成器：填完生成的 Prompt JSON 通过 schema 校验 | ✅🤖 | smoke 已覆盖 |
| 7.8 | 生成后的模板能在 layout 页面用 | 🔀 | 用 fake LLM 生成，进 layout 试 |

---

## 8 · 推送公众号

| # | 检查项 | 标签 | 期望 |
|---|---|---|---|
| 8.1 | 检测到已登录的公众号 | 👤 | publish 页 list 非空 |
| 8.2 | 多个账号可同时勾选 | 🤖 | state 跟随 |
| 8.3 | 单账号推草稿成功 | 👤 | 公众号后台能看到 |
| 8.4 | 多账号一次推草稿成功 | 👤 | 全部账号后台都能看到 |
| 8.5 | 推送失败时显示明确错误（不是裸 stack） | 👤 | 把账号登出再推一次试 |
| 8.6 | 草稿里的封面 / 摘要 / 作者 / 原创设置都正确 | 👤 | 公众号后台逐项核对 |
| 8.7 | 草稿里的图片能正常显示（不是 hotlink 失效） | 👤 | 图片预览看得到 |
| 8.8 | 推送过程中 UI 有进度反馈 | 👤 | 不是黑屏等 |

---

## 9 · 热点

| # | 检查项 | 标签 | 期望 |
|---|---|---|---|
| 9.1 | hot-topics 页面 12 个 source 都能渲染 tab | 🤖 | tab 数量正确 |
| 9.2 | 默认热源数据能拉到 | 🔀 | 至少 3 个 source 列表非空 |
| 9.3 | 缓存：15 分钟内重复打开不再打 API | 🤖 | mock fetch 计数 |
| 9.4 | 点击单条跳到原文 | 🤖 | window.open(url) |
| 9.5 | "送进编辑台"按钮：跳到 #capture 并预填 URL | 👤 | 一键送进 |
| 9.6 | 热源 API 挂掉时降级到下一个 source | 🤖 | mock 503 |
| 9.7 | Pro 高级热源（hot.advancedSources）：免费版隐藏/灰、Pro 解锁 | 🤖 | 视觉差异 |

---

## 10 · AI 智能选题（Topic Planner · Pro）

| # | 检查项 | 标签 | 期望 |
|---|---|---|---|
| 10.1 | 未激活 Pro 时点击「AI 智能选题」：显示升级/试用提示 | 🤖 | upgrade modal 或免费 1 次 |
| 10.2 | fake-pro 后：8 道画像题可填写、保存、回填 | 🤖 | DOM 完整 + storage 同步 |
| 10.3 | 生成候选：算法过滤 + AI 选题总监返回推荐卡 | 🔀 | mock 热点 + mock LLM |
| 10.4 | 推荐卡「确认抓取改写 / 仅入库 / 用提纲开稿 / 换角度」闭环 | 🔀 | workspace import 正常 |
| 10.5 | reroll 不编造 itemId，候选必须来自 candidatePool | 🤖 | parseTopicDirectorOutput 白名单校验 |

---

## 11 · 会员系统

| # | 检查项 | 标签 | 期望 |
|---|---|---|---|
| 11.1 | 注册流程：邮箱+密码 → 跳到 dashboard | 👤 | 真走一次 docuearn.com |
| 11.2 | 登录流程：复用同邮箱 → 拿到 token | 👤 | options 显示 user.email |
| 11.3 | License 激活：粘 key → 联网验证 → Pro 解锁 | 👤 | 需要真 key（你说没有 → 这条用 fake-pro 替代） |
| 11.4 | License 过期：到期后自动降级 | 🤖 | 改 fixture expiresAt = 过去时间 |
| 11.5 | License 7 天 stale：超期未联网验证降级 | 🤖 | 改 verifiedAt = 8 天前 |
| 11.6 | 设备指纹：首次生成、永不更换 | 🤖 | 反复 reload 看 fingerprint 不变 |
| 11.7 | 设备解绑：从 dashboard 解绑后本地 license 清空 | 👤 | 真走 |
| 11.8 | 退出登录：清空 token + license | 🤖 | storage 检查 |
| 11.9 | License pill 在 popup / options / workspace 三处显示一致 | 🤖 | 三处文案一致 |

---

## 12 · 快捷键

| # | 快捷键 | 期望 | 实测 |
|---|---|---|---|
| 12.1 | Alt+Shift+Y | 打开弹窗 | |
| 12.2 | Alt+Shift+C | 抓取当前页 + 打开编辑台 | |
| 12.3 | Alt+Shift+W | 直接打开编辑台 | |
| 12.4 | Alt+Shift+H | 打开热点捕捉器 | |
| 12.5 | (手动绑) open_options | 打开设置页 | |

---

## 13 · 性能 / 健壮性 / 边界

| # | 检查项 | 标签 | 期望 |
|---|---|---|---|
| 13.1 | Chrome 114（manifest minimum）能加载 | 👤 | 用旧 Chrome 试 |
| 13.2 | Service Worker 重启后 license / settings 不丢 | 🤖 | chrome.runtime.reload() 后重新读 |
| 13.3 | Service Worker 30s 自动休眠 → 触发动作能唤醒 | 🤖 | 等 30s 后点 popup |
| 13.4 | 大文本（10k 字）改写流式渲染不卡 | 🤖 | big-source fixture |
| 13.5 | 多账号 4 个并发推送不雪崩 | 👤 | 真推 |
| 13.6 | 抓取超时（30s）触发 fallback 提示 | 🤖 | mock 超时 |
| 13.7 | 网络断开时所有按钮给离线提示，不裸报 | 🤖 | offline mode |
| 13.8 | 反复刷新 workspace 不内存泄漏 | 🤖 | task manager 监控 |
| 13.9 | 切换 hash 100 次无 listener 累积 | 🤖 | DevTools event listeners |

---

## 14 · 文案 / UX 一致性

| # | 检查项 | 标签 | 期望 |
|---|---|---|---|
| 14.1 | 全站统一品牌名 "润笔 · DocuEarn" | 🤖 | 全文 grep 不出现旧名 |
| 14.2 | 错误提示都说"人话"（不是 NetworkError 裸码） | 👤 | 全流程跑一遍体感 |
| 14.3 | upgrade modal 文案不"销售感太强" | 👤 | 体感 |
| 14.4 | 所有按钮都有 aria-label 或可读文字 | 🤖 | a11y 扫描 |
| 14.5 | 图标全部 14×14 / 16×16 一致，不出现尺寸混搭 | 🤖 | grep size attr |
| 14.6 | 所有 link 离开扩展前提示（避免误跳） | 👤 | 体感 |

---

## 15 · 隐私 / 安全 / 合规

| # | 检查项 | 标签 | 期望 |
|---|---|---|---|
| 15.1 | 固定外部域名在 host_permissions；动态 URL 在 optional_host_permissions 前有运行时申请 | 🤖 | grep fetch URL + `ensureOptionalHostPermission` |
| 15.2 | 不声明 cookies 权限、不读取平台 cookie | 🤖 | 源码不应出现 cookies API 业务调用 |
| 15.3 | API key 不发到我们的服务器 | 🤖 | grep fetch 路径，确保 key 只发到用户配置端点 |
| 15.4 | License 激活时只上传 email + license + 设备指纹 | 🤖 | 拦截 /api/license/verify body |
| 15.5 | 推送公众号用浏览器原生登录态，不上传账号密码 | 🤖 | grep wechat.js |
| 15.6 | 所有静态页（privacy/terms/help/welcome）链接不死 | 🤖 | broken link check |
| 15.7 | manifest 描述不含"赚钱/挣外快"等敏感词 | ✅🤖 | smoke 已覆盖 |
| 15.8 | CSP 没有 'unsafe-eval'、没有外部 script src | 🤖 | grep manifest |

---

## 附录 A · 我（AI）会跑的机测脚本清单

```bash
npm run test:smoke              # 现有：纯函数 + manifest
npm run check:js                # 现有：全量 JS 语法
npm run capture:cws             # 现有：商店素材
node scripts/check-extension.mjs  # 新写：Playwright 加载扩展验启动
node scripts/check-routes.mjs     # 新写：所有 hash / popup tab / options section 渲染
node scripts/check-features.mjs   # 新写：fake-pro + mock LLM 跑 6 个核心 Pro 流程
node scripts/check-perf.mjs       # 新写：大文本渲染 / SW 重启 / listener 累积
```

---

## 附录 B · 当前已知未做项

| 项 | 影响 | 优先级 |
|---|---|---|
| 你没 Pro 账号 → 真激活流程只能用 fake-pro 替代 | 中 | 上线前我帮你 worker 端开一个测试账号 |
| DrissionPage helper 默认未启动 → 5.10 跳过 | 低 | 文档已说明，留给真用户 |
| 旧版 Chrome（< 114）不能加载 | 已知 | manifest minimum_chrome_version=114 已声明 |

---

## 提交 CWS 之前的强阻塞清单

- [ ] §1 全部通过
- [ ] §6 AI 改写至少能用 1 个真模型跑通
- [ ] §8 推送公众号能成功 1 个账号
- [ ] §15 隐私 / 安全全部通过
- [ ] §11 会员系统至少能注册 + 登录（License 激活可用 fake-pro 替代）
- [ ] 所有 ❌ 都修成 🔧

只要上面任一条没打勾，就不要点 CWS 提交。
