-- =====================================================================
-- 润笔 · 2026-04-23 迁移：加 Google OAuth 支持
-- =====================================================================
-- 部署：
--   wrangler d1 execute gzh-license --file=./server/migrations/2026-04-23-add-google-oauth.sql        # 远程
--   wrangler d1 execute gzh-license --local --file=./server/migrations/2026-04-23-add-google-oauth.sql # 本地
--
-- 设计要点：
--   1. 新增 google_sub：Google 用户的唯一 ID（payload.sub）。一个 google_sub
--      只能绑一个 users.id。
--   2. 新增 oauth_provider：'google' / 'github' / NULL（NULL = 传统邮箱密码注册）。
--      Worker 端用它做"账号登录方式"判定，比如邮箱密码登录看到 oauth-only 账号，
--      会返回友好提示「请用 Google 登录」。
--   3. password_hash / password_salt 仍是 NOT NULL（D1/SQLite 改 column 约束很麻烦），
--      OAuth-only 账号在创建时存随机 dummy 值即可，永远不会被密码登录路径用到。
--   4. UNIQUE INDEX on google_sub：SQLite 中多个 NULL 视为不同值，所以这里是
--      "至多一个非空 google_sub 对应一行用户"——刚好就是我们要的语义。
-- =====================================================================

ALTER TABLE users ADD COLUMN google_sub TEXT;
ALTER TABLE users ADD COLUMN oauth_provider TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS idx_users_google_sub ON users(google_sub);
CREATE INDEX IF NOT EXISTS idx_users_oauth_provider ON users(oauth_provider);
