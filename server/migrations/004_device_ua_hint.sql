-- =====================================================================
-- 004_device_ua_hint.sql · 39th session 续 · 优化设备指纹追踪 Strategy B
-- =====================================================================
-- 部署（zsh 行内 # 不识别，每条命令独立一行）：
--   先本地（在 server/ 目录下执行）：
--     wrangler d1 execute gzh-license --local --file=./migrations/004_device_ua_hint.sql
--   再远程（生产）：
--     wrangler d1 execute gzh-license --remote --file=./migrations/004_device_ua_hint.sql
--
-- 设计要点：
--   · device_activations 加 user_agent_hint 列保存 "Chrome 147 · macOS 10.15.7"
--     这种粒度（浏览器名+主版本号 + OS 家族），用来在 dashboard 让用户区分
--     "7 台 fingerprint 是 7 台真设备，还是同一台多次重置后的累积"
--   · 不存完整 UA（避免 cross-site fingerprinting + 满足 docuearn.com privacy.html
--     不收集追踪信号的承诺）；只存浏览器名+版本+OS 这种粗粒度信息
--   · 老行（004 部署前已存在的）user_agent_hint 默认 NULL，dashboard UI 兜底渲染 "—"；
--     用户下次激活时 worker 会 ON CONFLICT UPDATE 把 hint 补上
--   · 不需要任何索引——hint 字段只用于 SELECT 显示，不参与查询过滤
-- =====================================================================

ALTER TABLE device_activations ADD COLUMN user_agent_hint TEXT;

-- ---------- 验证（可选） ----------
-- 部署后跑：
--   wrangler d1 execute gzh-license --remote --command \
--     "SELECT name FROM pragma_table_info('device_activations') WHERE name='user_agent_hint'"
-- 期望输出 1 行：user_agent_hint
