# TODO

> 本文件记录"暂不修但需要保留视野"的待办事项。
> 与 [memory-bank/progress.md](memory-bank/progress.md) 「待开发或待决策」段相互补充：
> - progress.md 是项目维度的产品 / 功能路线
> - 本文件是工程维度的代码债 / 性能 / 边界场景

## P3 性能优化（条件触发再做）

- **Workspace hash 路由 100 次切换 5.9s** —— `npm run check:features [6] perf` 持续告警，已知 baseline 4.1s（[progress.md:166](memory-bank/progress.md)），还在 4-7s 区间浮动。改造方向：① applyRoute 合并 DOM 写；② IntersectionObserver 替代 hashchange 全量重渲染。预估 2-4h，等真用户反馈卡顿再投。
- **`server/worker.js` 单文件持续增长**（1.5K+ 行） —— 拆成 `auth/license/webhook/oauth/cron` 子模块。预估 4-6h。

## P3 边界场景（暂不修）

- **多 workspace tab 并发打开时 TASK_LIST_CHANGED 双重 apply** —— 用户开 2 个 workspace tab，task done 时两个 tab 都收 broadcast → 各自调 onTaskDone → applyRewriteTaskResult 各自把 result 写一次（articleBundle 是 storage 共享的，覆盖等效但调用 `saveCurrentDraftRecord` 会写 2 次 history）。修法：tab 间用 BroadcastChannel 选举一个 leader 处理 onTaskDone，但增加复杂度。等用户反馈再做。
- **抓取模式切换被 1s debounce 阻挡** —— 用户先点"原样抓取"再立即点"提取主体"，第二个模式不生效。但抓取模式切换通过右键菜单触发，不是按钮连点的常见路径，可接受。
- **chrome 重启后跨重启续跑改写** —— SW lifetime 不可控，改写 fetch 已 detached，无法续跑。stale running task 启动时清理为 failed，由用户重试。这是结构性约束，不修。

## P3 鉴权 / 安全（不紧迫）

- **`requireAuth` 401 错误分类拆分** —— 当前一句话同时覆盖 token 过期 / 格式非法 / signature mismatch / 缺失 Authorization header，排查成本高。改造时下游 UI 也要联动判断。预估 2-3h。
- **JWT 主动撤销机制** —— 当前唯一撤销手段是 `wrangler secret put JWT_SECRET` 全员踢下线（核武器）。需要 jti + KV 黑名单 + verifyJwt 加一次 KV 查询。预估 3-4h。

## P3 文档 / 工具（机会成本低）

- **`package.json` 加 `"type": "module"`** —— 当前 node 启动 ai.js 会输出 `MODULE_TYPELESS_PACKAGE_JSON` warning（ESM 解析慢一点）。但加 type:module 会影响所有 .js 文件的默认解析模式，可能引发 chrome 扩展加载副作用。等触发性能问题再修。

## 已完成（仅供参考，不影响本文件）

参见 [memory-bank/progress.md 已完成能力段](memory-bank/progress.md)。
