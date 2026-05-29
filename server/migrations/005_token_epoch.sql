-- 005_token_epoch.sql · JWT 吊销支持（安全审查 #4）
--
-- 背景：JWT HS256 7 天有效，此前改密 / 重置密码 / 解绑设备都不会让已签发的旧 token 失效。
-- 安全告警邮件指引用户「立即改密自救」，但被盗 JWT 改密后仍可用满 7 天 —— 事故响应失效。
--
-- 方案：users 加 token_epoch（秒级时间戳）。签发 JWT 时把当前 token_epoch 写进 claims.te；
-- requireAuth 校验 claims.te >= users.token_epoch，改密 / 重置时 bump token_epoch = now，
-- 使所有旧 token 立即失效。
--
-- 默认 0：未 bump 过的账号 + 历史旧 token（无 te 字段，按 0 处理）都能通过校验，向后兼容。
--
-- 部署：
--   wrangler d1 execute gzh-license --local  --file=./migrations/005_token_epoch.sql
--   wrangler d1 execute gzh-license --remote --file=./migrations/005_token_epoch.sql

ALTER TABLE users ADD COLUMN token_epoch INTEGER NOT NULL DEFAULT 0;
