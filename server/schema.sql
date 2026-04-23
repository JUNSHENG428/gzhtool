-- =====================================================================
-- 公众号改写排版台 · 授权系统 D1 数据库初始化
-- =====================================================================
-- 部署：
--   wrangler d1 execute gzh-license --file=./server/schema.sql        # 远程
--   wrangler d1 execute gzh-license --local --file=./server/schema.sql # 本地
--
-- 设计要点：
--   · users 只存最小信息（邮箱 + 密码 hash），不冗余 plan 字段，
--     plan/到期时间一律以 license_keys 为准，避免双写不一致。
--   · 一个用户可以拥有多张 license_keys（续费会新发一张）。
--   · device_activations 预留设备数限制（先建表，业务里暂时不卡）。
--   · verify_log 用作风控，写入策略由 worker 控制（默认只记失败）。
--   · 所有时间戳用 INTEGER（unix ms），方便 JS 端 Date.parse 直接处理，
--     避免 SQLite 的 datetime 字符串和 Worker 时区互坑。
-- =====================================================================

PRAGMA foreign_keys = ON;

-- ---------- users ----------
CREATE TABLE IF NOT EXISTS users (
  id              TEXT PRIMARY KEY,
  email           TEXT NOT NULL,                 -- 小写存储，已在 worker 端 toLowerCase
  password_hash   TEXT NOT NULL,                 -- PBKDF2-SHA256 base64
  password_salt   TEXT NOT NULL,                 -- 16 字节 salt base64
  created_at      INTEGER NOT NULL,
  last_login_at   INTEGER
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_users_email ON users(email);

-- ---------- license_keys ----------
CREATE TABLE IF NOT EXISTS license_keys (
  key                  TEXT PRIMARY KEY,         -- GZHT-XXXX-XXXX-XXXX
  user_id              TEXT,                     -- NULL = 已生成但还没绑定到任何用户（兑换码模式）
  plan                 TEXT NOT NULL DEFAULT 'pro',
  status               TEXT NOT NULL DEFAULT 'active', -- active / revoked / expired
  expires_at           INTEGER,                  -- NULL = 永久有效
  ls_order_id          TEXT,                     -- Lemon Squeezy order id
  ls_subscription_id   TEXT,                     -- LS subscription id（订阅制时）
  ls_license_id        TEXT,                     -- LS 自带 license id（如果直接用 LS license）
  ls_customer_email    TEXT,                     -- LS 付款邮箱（用于回填账号绑定）
  created_at           INTEGER NOT NULL,
  updated_at           INTEGER NOT NULL,
  FOREIGN KEY (user_id) REFERENCES users(id)
);
CREATE INDEX IF NOT EXISTS idx_license_user        ON license_keys(user_id);
CREATE INDEX IF NOT EXISTS idx_license_ls_order    ON license_keys(ls_order_id);
CREATE INDEX IF NOT EXISTS idx_license_ls_sub      ON license_keys(ls_subscription_id);
CREATE INDEX IF NOT EXISTS idx_license_ls_email    ON license_keys(ls_customer_email);

-- ---------- device_activations（预留） ----------
CREATE TABLE IF NOT EXISTS device_activations (
  id                   TEXT PRIMARY KEY,
  license_key          TEXT NOT NULL,
  device_fingerprint   TEXT NOT NULL,            -- 插件端用 chrome.runtime.id + 一段随机 = 稳定指纹
  device_label         TEXT,                     -- 让用户能在 dashboard 看出是哪台机器
  activated_at         INTEGER NOT NULL,
  last_seen_at         INTEGER NOT NULL,
  FOREIGN KEY (license_key) REFERENCES license_keys(key)
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_dev_key_fp ON device_activations(license_key, device_fingerprint);

-- ---------- verify_log（风控） ----------
CREATE TABLE IF NOT EXISTS verify_log (
  id                   INTEGER PRIMARY KEY AUTOINCREMENT,
  license_key          TEXT,
  ip                   TEXT,
  user_agent           TEXT,
  result               TEXT NOT NULL,            -- ok / invalid / expired / rate_limited / not_found
  detail               TEXT,
  created_at           INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_verify_key  ON verify_log(license_key);
CREATE INDEX IF NOT EXISTS idx_verify_time ON verify_log(created_at);

-- ---------- password_resets ----------
-- 忘记密码流程：服务端只存 sha256(token)，URL 上传明文 token；
-- 即使 D1 被泄也无法反推出有效 reset 链接。
CREATE TABLE IF NOT EXISTS password_resets (
  token_hash    TEXT PRIMARY KEY,                -- sha256(token) hex
  user_id       TEXT NOT NULL,
  email         TEXT NOT NULL,                   -- 冗余一份，便于审计
  created_at    INTEGER NOT NULL,
  expires_at    INTEGER NOT NULL,                -- 通常 created_at + 30min
  used_at       INTEGER,                         -- 已使用过的链接不能再用
  FOREIGN KEY (user_id) REFERENCES users(id)
);
CREATE INDEX IF NOT EXISTS idx_pwreset_user    ON password_resets(user_id);
CREATE INDEX IF NOT EXISTS idx_pwreset_expires ON password_resets(expires_at);

-- ---------- webhook_events（Lemon Squeezy 幂等） ----------
-- LS webhook 不保证只送一次，必须做幂等。这里以 event_id 为去重键。
CREATE TABLE IF NOT EXISTS webhook_events (
  event_id      TEXT PRIMARY KEY,                -- LS X-Event-Id
  event_name    TEXT NOT NULL,                   -- order_created / subscription_created / ...
  raw           TEXT NOT NULL,                   -- 原始 payload，便于排查
  processed_at  INTEGER NOT NULL
);
