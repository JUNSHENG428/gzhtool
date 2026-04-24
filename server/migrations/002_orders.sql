-- =====================================================================
-- 002_orders.sql · 虎皮椒（HuPiJiao）支付通路
-- =====================================================================
-- 部署：
--   wrangler d1 execute gzh-license --remote --file=./server/migrations/002_orders.sql
--   wrangler d1 execute gzh-license --local  --file=./server/migrations/002_orders.sql
--
-- 设计要点：
--   · orders 是「商户订单 + 第三方回调流水」的聚合表，不存任何敏感支付凭证。
--   · trade_order_id 是商户订单号，必须全局唯一（虎皮椒只允许 数字字母_-*）。
--   · status 机器状态：pending → paid（success）/ failed / refunded。
--   · notify_payload 存原始回调 JSON，便于审计 + 客诉排查。
--   · 给 license_keys 加 source 字段，区分 'lemon' / 'hupijiao' / 'manual'，
--     旧数据默认 'lemon' 不影响读写；新发的 hupijiao license 走新分支。
-- =====================================================================

-- ---------- license_keys: 加 source 字段（兼容老数据）----------
-- D1 (SQLite) ALTER TABLE 加列默认空值即可，不影响既有行
ALTER TABLE license_keys ADD COLUMN source TEXT NOT NULL DEFAULT 'lemon';
CREATE INDEX IF NOT EXISTS idx_license_source ON license_keys(source);

-- ---------- orders ----------
CREATE TABLE IF NOT EXISTS orders (
  id                       INTEGER PRIMARY KEY AUTOINCREMENT,
  trade_order_id           TEXT NOT NULL UNIQUE,        -- 商户订单号（GZHO_xxx）
  user_id                  TEXT NOT NULL,               -- users.id
  user_email               TEXT,                        -- 冗余便于查询
  plan_code                TEXT NOT NULL,               -- 'monthly' / 'yearly'
  total_fee                REAL NOT NULL,               -- 元
  days                     INTEGER NOT NULL,            -- 该套餐对应的会员天数
  status                   TEXT NOT NULL DEFAULT 'pending', -- pending / paid / refunded / failed
  source                   TEXT NOT NULL DEFAULT 'hupijiao',
  hupijiao_open_order_id   TEXT,                        -- 虎皮椒侧 open_order_id
  hupijiao_transaction_id  TEXT,                        -- 微信支付侧 transaction_id
  pay_url                  TEXT,                        -- 拉起支付时的手机端 url
  pay_qrcode               TEXT,                        -- url_qrcode（PC 扫码）
  granted_license_key      TEXT,                        -- paid 后写入对应 license_keys.key
  notify_payload           TEXT,                        -- 回调原始数据存档
  created_at               INTEGER NOT NULL,            -- ms
  paid_at                  INTEGER,                     -- ms
  FOREIGN KEY (user_id) REFERENCES users(id)
);
CREATE INDEX IF NOT EXISTS idx_orders_user    ON orders(user_id);
CREATE INDEX IF NOT EXISTS idx_orders_status  ON orders(status);
CREATE INDEX IF NOT EXISTS idx_orders_created ON orders(created_at);
