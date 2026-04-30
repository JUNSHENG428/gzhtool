# 阶段 1 · 全面 Bug 和阻塞点扫描报告

**生成时间**：2026-04-30
**项目**：runbi 0.3.2（润笔 DocuEarn · MV3 扩展）

---

## 自动化扫描结果

| 工具 | 结果 |
|---|---|
| `npm run check:js`（语法 + SW 动态 import 守卫） | ✅ 77 文件 / SW 守卫 33-0 |
| `npm test`（smoke + extract-chat） | ✅ 12/12 |
| `npm run check:ext`（结构契约） | ✅ 40 / 0 / 0 |
| `npm run check:features`（功能契约） | ✅ 29 / **1!** / 0 |
| `grep TODO/FIXME/XXX/HACK` | 仅 license placeholder + vendor pdfjs，**无真实技术债** |
| 硬编码密钥扫描 | ✅ 未发现 sk-/pk-/eyJ |
| innerHTML XSS 扫描 | ✅ 全部走 escapeHtml/escapeAttr |
| `hidden` + `display:flex` 反例扫描 | ✅ 已知问题已修，无新案例 |

`! 1` 是历史 P2 perf baseline：[progress.md:166](memory-bank/progress.md) 已记录"Workspace hash 路由渲染性能优化：100 次切换约 4.1s"，本次实测 5926ms 同区间，**非本次回归**。

---

## P0 阻塞级（必修）

**0 个**。无程序崩溃 / 数据丢失 / 安全漏洞 / 主流程断裂。

近期 33rd-34th session 的真机回报 5 件套都已修完（关闭按钮 / hidden display / dedup / GET_TASK_RESULT / capture→rewrite cancel）。

## P1 体验级（必修）

**3 个**：

1. **rewrite 失败时 task chip / toast 没有 [重试] 按钮** — 用户必须切回 layout 路由重新点改写按钮，体验不佳。建议失败 toast 提供 [重试] 直接重发任务。
2. **capture 自动取消 rewrite 时缺归因提示** — 老 rewrite 被自动取消后只在 task center 显示"已取消"，用户不知道原因（"我没点取消啊"）。建议触发 cancel 时弹 toast 明确告知"因抓取新内容，原改写已自动取消，可重新发起"。
3. **task-center 折叠气泡 0 任务时仍占 56px 视觉空间** — 用户没用过任务中心时，右下角始终一个圆形气泡略干扰。已有 `opacity: 0.6` 半透明，但视觉上还是占空间。建议 0 任务时进一步缩小（如 40px + 透明度更低），有任务时恢复 56px 显眼。

## P2 代码质量

**0 个本次扫描需要处理的**。代码组织已合理，重复度低。

## P3 建议级（仅记录，不修）

记入 [TODO.md](../TODO.md)：

- Workspace hash 路由 100 次切换 5.9s（已知 P2 perf）—— 切换路径有待性能优化（[progress.md 已列](memory-bank/progress.md)）
- `server/worker.js` 单文件 1.5K+ 行可拆 auth/license/webhook/oauth 子模块
- `requireAuth` 401 错误分类拆分（当前一句话覆盖 4 类原因）
- JWT 主动撤销机制（jti + KV 黑名单）
- 多 workspace tab 并发打开时，TASK_LIST_CHANGED 推到所有 tab，每个 tab 的 task-center 各自 onTaskDone 可能造成 double-apply（边界场景，本轮不修）
- `node --trace-warnings` 提示：`package.json` 缺 `"type": "module"` 让 ai.js 解析慢（但 SW MV3 用的是显式 import 路径，加 type:module 风险高，跳过）

---

## 阶段 2 修复计划

| ID | 类型 | 描述 | 预估行数 | 文件 |
|---|---|---|---|---|
| F1 | P1 | rewrite 失败 toast 加 [重试] 按钮 | ~50 | [workspace-task-center.js](src/workspace/workspace-task-center.js) |
| F2 | P1 | capture 自动 cancel rewrite 时弹 toast 归因 | ~30 | [task-registry.js](src/background/task-registry.js) + [workspace-task-center.js](src/workspace/workspace-task-center.js) |
| F3 | P1 | 0 任务时气泡更不显眼 | ~10 | [workspace-task-center.css](src/workspace/workspace-task-center.css) |

总计 ~90 行，1 个 commit 内可完成（< 300 行约束满足）。
