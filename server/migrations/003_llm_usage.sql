-- =====================================================================
-- 003_llm_usage.sql · 平台 LLM 代理 · 月度用量 + 调用审计
-- =====================================================================
-- 部署（注意：zsh 不支持行内 # 注释，每条命令独立一行）：
--   先本地（在 server/ 目录下执行）：
--     wrangler d1 execute gzh-license --local --file=./migrations/003_llm_usage.sql
--   再远程（生产）：
--     wrangler d1 execute gzh-license --remote --file=./migrations/003_llm_usage.sql
--
-- 设计要点（详见 .claude/plans/iridescent-sprouting-moore.md "Phase 1.1 D1 schema"）：
--   · 39th session 起开始为月费/Free 用户提供平台 LLM 代理服务，年费用户保留
--     "使用自己 API Key" 路径不计费。两表只服务平台代理路径，自配 Key 路径
--     不写入任何记录（隐私底线：不接触用户内容）。
--   · llm_usage 是用户维度的"当月聚合用量"：每次调用 INCREMENT 字段，主键
--     (user_id, yyyymm) 让月度统计 / 配额检查零索引扫描即可定位。
--     yyyymm 用 "2026-04" 格式（自然月日历，与虎皮椒订阅周期对齐）。
--   · llm_audit_log 是"逐次调用流水"：用于成本核算 / 异常检测 / 客诉排查。
--     **不存任何文章正文 / prompt 内容**——只记 token 数 + 模型 + 错误码 +
--     上游服务商。隐私政策已声明"不存储正文，不用作训练"。
--   · last_call_at 用于"用户最近活跃度"分析 + 告警阈值（同一用户高频调用
--     可能滥用）。
--   · status 机器枚举：ok / error / rate_limited / quota_exceeded / upstream_down。
--   · upstream 字段：openai / deepseek / claude / kimi / gemini / qwen / glm（与
--     src/shared/providers.js 8 家服务商命名对齐，添加新上游时同步两边）。
-- =====================================================================

-- ---------- llm_usage：月度聚合 ----------
CREATE TABLE IF NOT EXISTS llm_usage (
  user_id              TEXT NOT NULL,                -- users.id
  yyyymm               TEXT NOT NULL,                -- "2026-04" 自然月
  prompt_tokens        INTEGER NOT NULL DEFAULT 0,
  completion_tokens    INTEGER NOT NULL DEFAULT 0,
  call_count           INTEGER NOT NULL DEFAULT 0,
  last_call_at         INTEGER,                      -- unix ms
  -- 字段冗余便于跨月报表查询，不参与配额判定
  -- error_count / rate_limit_count 不在此表（去 audit_log 聚合即可）
  PRIMARY KEY (user_id, yyyymm),
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_llm_usage_yyyymm ON llm_usage(yyyymm);
-- 全局月度成本报表用：SELECT yyyymm, SUM(prompt_tokens+completion_tokens)
-- FROM llm_usage GROUP BY yyyymm

-- ---------- llm_audit_log：逐次调用流水 ----------
CREATE TABLE IF NOT EXISTS llm_audit_log (
  id                   INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id              TEXT NOT NULL,                -- users.id
  ts                   INTEGER NOT NULL,             -- unix ms 精确到毫秒
  model                TEXT,                         -- 实际调的上游 model 名（"deepseek-v4-flash"）
  tier                 TEXT,                         -- economy / standard / flagship（前端请求档位）
  upstream             TEXT,                         -- openai / deepseek / claude / kimi
  prompt_tokens        INTEGER DEFAULT 0,
  completion_tokens    INTEGER DEFAULT 0,
  duration_ms          INTEGER,                      -- 调用耗时
  status               TEXT NOT NULL,                -- ok / error / rate_limited / quota_exceeded / upstream_down
  error_code           TEXT,                         -- 错误时的诊断码：upstream_5xx / quota_exceeded / etc
  fallback_from        TEXT                          -- 如发生 fallback，记原本要调的 upstream
  -- 注意：**不**存任何 prompt / completion 文本、用户 IP、user agent，避免
  -- 隐私 / 合规风险。只记数值化的 metadata 和错误诊断码。
);

CREATE INDEX IF NOT EXISTS idx_llm_audit_user_ts   ON llm_audit_log(user_id, ts DESC);
-- 用户最近调用查询：SELECT * FROM llm_audit_log WHERE user_id=? ORDER BY ts DESC LIMIT 50
CREATE INDEX IF NOT EXISTS idx_llm_audit_ts        ON llm_audit_log(ts DESC);
-- 全局成本报表用：SELECT model, SUM(prompt_tokens+completion_tokens), COUNT(*)
-- FROM llm_audit_log WHERE ts > ? GROUP BY model
CREATE INDEX IF NOT EXISTS idx_llm_audit_status    ON llm_audit_log(status);
-- 错误率监控：SELECT status, COUNT(*) FROM llm_audit_log WHERE ts > ? GROUP BY status

-- ---------- 数据保留策略（应用层） ----------
-- llm_audit_log 会快速增长（每月 N×10K 行）。Cloudflare Worker 加 cron 每月清理
-- 90 天前的记录（对照 server/worker.js scheduled handler，与虎皮椒退款 sync
-- cron 共用 trigger）。SQL 不做自动 TTL，由 worker.js 维护。

-- ---------- 验证（可选） ----------
-- 部署后跑一遍快速 sanity check：
--   wrangler d1 execute gzh-license --remote --command \
--     "SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'llm_%'"
-- 期望输出：llm_audit_log / llm_usage 两行。
