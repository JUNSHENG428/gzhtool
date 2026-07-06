-- =====================================================================
-- 润笔 · 授权系统 D1 数据库初始化
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
  password_hash   TEXT NOT NULL,                 -- PBKDF2-SHA256 base64；OAuth-only 用户存 dummy 值
  password_salt   TEXT NOT NULL,                 -- 16 字节 salt base64；OAuth-only 用户存 dummy 值
  google_sub      TEXT,                          -- Google ID Token 的 sub 字段（已绑 Google 时填）
  oauth_provider  TEXT,                          -- 'google' / 'github' / NULL=邮箱密码
  created_at      INTEGER NOT NULL,
  last_login_at   INTEGER,
  token_epoch     INTEGER NOT NULL DEFAULT 0   -- JWT 吊销纪元；改密/重置时 bump 使旧 token 失效（见 005_token_epoch.sql）
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_users_email          ON users(email);
CREATE UNIQUE INDEX IF NOT EXISTS idx_users_google_sub     ON users(google_sub);
CREATE INDEX        IF NOT EXISTS idx_users_oauth_provider ON users(oauth_provider);

-- ---------- license_keys ----------
CREATE TABLE IF NOT EXISTS license_keys (
  key                  TEXT PRIMARY KEY,         -- GZHT-XXXX-XXXX-XXXX
  user_id              TEXT,                     -- NULL = 已生成但还没绑定到任何用户（兑换码模式）
  plan                 TEXT NOT NULL DEFAULT 'pro',
  status               TEXT NOT NULL DEFAULT 'active', -- active / revoked / expired
  expires_at           INTEGER,                  -- 单位 ms。webhook 会把上限封到 now + 365d（虎皮椒协议 3.12）
  ls_order_id          TEXT,                     -- Lemon Squeezy order id
  ls_subscription_id   TEXT,                     -- LS subscription id（订阅制时）
  ls_license_id        TEXT,                     -- LS 自带 license id（如果直接用 LS license）
  ls_customer_email    TEXT,                     -- LS 付款邮箱（用于回填账号绑定）
  source               TEXT NOT NULL DEFAULT 'lemon', -- 'lemon' / 'hupijiao' / 'manual'
  created_at           INTEGER NOT NULL,
  updated_at           INTEGER NOT NULL,
  FOREIGN KEY (user_id) REFERENCES users(id)
);
CREATE INDEX IF NOT EXISTS idx_license_user        ON license_keys(user_id);
CREATE INDEX IF NOT EXISTS idx_license_ls_order    ON license_keys(ls_order_id);
CREATE INDEX IF NOT EXISTS idx_license_ls_sub      ON license_keys(ls_subscription_id);
CREATE INDEX IF NOT EXISTS idx_license_ls_email    ON license_keys(ls_customer_email);
CREATE INDEX IF NOT EXISTS idx_license_source      ON license_keys(source);

-- ---------- orders（虎皮椒等第三方支付订单流水） ----------
-- 详见 server/migrations/002_orders.sql
CREATE TABLE IF NOT EXISTS orders (
  id                       INTEGER PRIMARY KEY AUTOINCREMENT,
  trade_order_id           TEXT NOT NULL UNIQUE,
  user_id                  TEXT NOT NULL,
  user_email               TEXT,
  plan_code                TEXT NOT NULL,
  total_fee                REAL NOT NULL,
  days                     INTEGER NOT NULL,
  status                   TEXT NOT NULL DEFAULT 'pending',
  source                   TEXT NOT NULL DEFAULT 'hupijiao',
  hupijiao_open_order_id   TEXT,
  hupijiao_transaction_id  TEXT,
  pay_url                  TEXT,
  pay_qrcode               TEXT,
  granted_license_key      TEXT,
  notify_payload           TEXT,
  created_at               INTEGER NOT NULL,
  paid_at                  INTEGER,
  FOREIGN KEY (user_id) REFERENCES users(id)
);
CREATE INDEX IF NOT EXISTS idx_orders_user    ON orders(user_id);
CREATE INDEX IF NOT EXISTS idx_orders_status  ON orders(status);
CREATE INDEX IF NOT EXISTS idx_orders_created ON orders(created_at);

-- ---------- device_activations（预留） ----------
CREATE TABLE IF NOT EXISTS device_activations (
  id                   TEXT PRIMARY KEY,
  license_key          TEXT NOT NULL,
  device_fingerprint   TEXT NOT NULL,            -- 客户端 crypto.randomUUID() 一次性生成存 chrome.storage
  device_label         TEXT,                     -- 让用户能在 dashboard 看出是哪台机器（"Chrome on macOS"）
  user_agent_hint      TEXT,                     -- 39th 续 · 浏览器+版本+OS 粗粒度（"Chrome 147 · macOS 10.15.7"）
                                                 -- 不存完整 UA：避免 cross-site fingerprinting + 隐私承诺
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

-- ---------- llm_usage（平台 LLM 代理 · 月度聚合用量） ----------
-- 详见 server/migrations/003_llm_usage.sql（此处回填保证新环境按 schema.sql
-- 一键建库即可跑通平台 AI 计量链路；生产库已由 003 迁移建出）
CREATE TABLE IF NOT EXISTS llm_usage (
  user_id              TEXT NOT NULL,                -- users.id
  yyyymm               TEXT NOT NULL,                -- "2026-04" 自然月
  prompt_tokens        INTEGER NOT NULL DEFAULT 0,
  completion_tokens    INTEGER NOT NULL DEFAULT 0,
  call_count           INTEGER NOT NULL DEFAULT 0,
  last_call_at         INTEGER,                      -- unix ms
  PRIMARY KEY (user_id, yyyymm),
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_llm_usage_yyyymm ON llm_usage(yyyymm);

-- ---------- llm_audit_log（平台 LLM 代理 · 逐次调用流水） ----------
-- 不存任何 prompt / completion 文本、用户 IP、user agent；90 天后由 cron 清理
CREATE TABLE IF NOT EXISTS llm_audit_log (
  id                   INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id              TEXT NOT NULL,                -- users.id
  ts                   INTEGER NOT NULL,             -- unix ms
  model                TEXT,                         -- 实际调的上游 model 名
  tier                 TEXT,                         -- economy / standard / flagship
  upstream             TEXT,                         -- openai / deepseek / ...
  prompt_tokens        INTEGER DEFAULT 0,
  completion_tokens    INTEGER DEFAULT 0,
  duration_ms          INTEGER,
  status               TEXT NOT NULL,                -- ok / error / rate_limited / quota_exceeded / upstream_down / suspicious_spike
  error_code           TEXT,
  fallback_from        TEXT
);
CREATE INDEX IF NOT EXISTS idx_llm_audit_user_ts   ON llm_audit_log(user_id, ts DESC);
CREATE INDEX IF NOT EXISTS idx_llm_audit_ts        ON llm_audit_log(ts DESC);
CREATE INDEX IF NOT EXISTS idx_llm_audit_status    ON llm_audit_log(status);
