# Phase 6 · Device 反伪造体系设计 sketch

> **状态**：Draft（设计阶段，未进入实施）
> **作者**：39th 续³ Batch 5 · 2026-05-07
> **关联缺陷**：Top 22 #1（Critical · Architectural）
> **预期 scope**：1.5–2 个 session（D1 迁移 + Worker 双轨 + 扩展改造 + 灰度）
> **决策点**：本文末尾「§6 推荐方案」+ 「§7 实施路径」需用户 review 后再起实施 PR

---

## §1 现状（Strategy B · 39th 续）

```
扩展端 (chrome.storage.local)
   └─ device.fingerprint = crypto.randomUUID()       ← 一次性生成，永不更换
   └─ device.label       = "Chrome on macOS"         ← 用户可见的"机器名"
        ↓
   每次 verify 上报 { key, deviceFingerprint, deviceLabel }
        ↓
Worker (POST /api/license/verify)
   └─ 写 device_activations(id=sha256(key:fp), license_key, device_fingerprint, ...)
   └─ 老 fp 再 verify 只 UPDATE last_seen，不卡限额
   └─ 新 fp INSERT 时检查 COUNT(*) >= DEVICE_LIMITS[plan] → 撞顶 403
        ↓
D1 device_activations
   └─ id (sha256(key:fp))   ← 主键，便于 O(1) 查询
   └─ device_fingerprint    ← 客户端原始 UUID 字符串（明文存储）
```

**已有防护**：
- 硬限：`DEVICE_LIMITS = {free:1, monthly:3, yearly:10}`（Phase 2.7）
- 软告警：5min 滑窗 distinct fingerprint > limit+2 → `verify_log("multi_device_burst")` + 邮件（Phase 4.4）
- 自动清理：cron 每小时跑，删 90 天未活跃的 fingerprint（39th 续）

---

## §2 攻击模型

| 编号 | 场景 | 现有挡得住吗？ | 实际成本 |
|---|---|---|---|
| **T1** | 单攻击者「轮换重用」license：用满 10 台后，主动 unbind 旧的、激活新的 | ❌ device_limit 不挡 | 改 1 行扩展代码 + 自动化脚本 |
| **T2** | License 转售/共享：N 个真用户各自激活 | ✅ device_limit 硬卡（前提是没人主动 unbind） | 撞顶后第 N+1 个 403 |
| **T3** | 单攻击者并发激活：100 个不同 fingerprint 同时 verify | ✅ device_limit 硬卡到 10（yearly），multi_device_burst 5min 内 >12 软告警 | 攻击者只能拿到 10 个 active 槽位 |
| **T4** | 攻击者直接调 API：脚本绕过扩展，POST /api/license/verify 任意 fingerprint | ❌ Worker 不能区分「真扩展」vs「脚本」 | 拿到 license key + 调 curl |
| **T5** | 攻击者修改扩展源码：不存 fingerprint，每次现生成 | ❌ 行为等同 T1 自动化版本 | 改 1 行扩展代码 |

**核心结论**：当前体系挡得住 T2/T3（依赖 device_limit + burst），挡不住 T1/T4/T5（fingerprint 完全由客户端控制）。

---

## §3 设计目标

| 目标 | 现状 | Phase 6 期望 |
|---|---|---|
| fingerprint 不可任意伪造 | ❌ 客户端 randomUUID | ✅ 服务端签发 + HMAC |
| 旧用户向后兼容 | — | ✅ 不锁出现有用户，灰度切换 |
| 不引入新依赖 | Web Crypto / D1 / KV | ✅ 继续 Web Crypto / D1 / KV |
| 不增加主链路延迟 | verify ~50ms | ✅ ≤ +20ms（HMAC 验签 ~1ms） |
| 不破坏隐私承诺 | 仅记 UA hint，无完整 UA | ✅ 不引入 cross-site fingerprinting |
| 攻击成本 | 改 1 行代码（接近 0） | ✅ 提高到「改源码 + 维护重放攻击 + 绕过 rate limit」 |

---

## §4 候选方案对比

### 方案 A · HMAC challenge / 设备激活握手

扩展生成 keypair（Ed25519）→ POST publicKey + nonce → server sign device_certificate → 扩展存 cert + private key → 后续 verify 用 cert + sign 一个 challenge。

| | 评估 |
|---|---|
| 安全性 | ⭐⭐⭐⭐ 攻击者必须能让 server 完成 sign 流程 |
| 复杂度 | ⭐⭐⭐⭐ 需 keypair + cert 管理 + revocation list |
| 兼容性 | ⭐⭐ Web Crypto 支持 Ed25519 但 Chrome MV3 SW 端要确认 |
| 主链路延迟 | ⭐⭐ 每次 verify 多一次 sign+verify，~5ms |
| **结论** | 过度工程化。Server 仍然没办法分辨「同一攻击者请求 100 次签证」vs「100 个真用户」 |

### 方案 B · 浏览器/操作系统级标识绑定

`chrome.identity.getProfileUserInfo()` + `chrome.system.cpu.getInfo()` + `chrome.system.memory.getInfo()` 取多源 hash。

| | 评估 |
|---|---|
| 安全性 | ⭐⭐ 仍能被 Frida / 改源码绕过 |
| 复杂度 | ⭐⭐⭐ Chrome.identity 需要 OAuth client_id 配置 |
| 兼容性 | ⭐ Linux 没有 chrome.identity；要新 permission（隐私扣分） |
| 隐私 | ⭐ 跨多源系统标识 = 强 fingerprinting，CWS 审核风险 |
| **结论** | 隐私成本远超安全收益。**不采用** |

### 方案 C · Server-side issued device_token

用户激活时**只发 challenge，不发 fingerprint** → server 生成 `device_token = HMAC(license_key | uuid | iat, DEVICE_TOKEN_SECRET)` → 扩展存 token → 后续 verify 上报 token。

| | 评估 |
|---|---|
| 安全性 | ⭐⭐⭐⭐ 攻击者不能任意伪造 token（必须有 SECRET）；只能通过 server 签发，受 rate limit 制约 |
| 复杂度 | ⭐⭐⭐ HMAC 签发 + 双轨过渡逻辑 |
| 兼容性 | ⭐⭐⭐⭐ Web Crypto HMAC 老牌 API，全平台稳定 |
| 主链路延迟 | ⭐⭐⭐⭐⭐ HMAC 验签 ~1ms |
| 隐私 | ⭐⭐⭐⭐⭐ 服务端签的不可逆 token，不暴露设备标识 |
| **结论** | **核心方案。** 把信任边界从 client-side 推到 server-side rate limit |

### 方案 D · Anomaly detection（不动 fingerprint，强化风控）

接受 fingerprint 是软标识，重点放服务端：IP 跨国跳跃 / UA 不匹配 / 时间窗口异常 / 行为评分。

| | 评估 |
|---|---|
| 安全性 | ⭐⭐⭐ 挡得住懒攻击者，挡不住有耐心的 |
| 复杂度 | ⭐⭐ 在现有 multi_device_burst 基础上扩展 |
| 兼容性 | ⭐⭐⭐⭐⭐ 完全不动客户端 |
| **结论** | **辅助方案。** 与 C 配合，作为最后一道软网 |

---

## §5 推荐方案：C + D 组合

### 5.1 数据流

```
首次激活（扩展端 license bind 之后第一次 verify）
   扩展 → POST /api/license/verify { key, deviceLabel }
                                    （不再发 deviceFingerprint）
        ↓
   Worker:
      1. 验证 license（同现有逻辑）
      2. 检查 device_limit（同现有，但用 token 计数）
      3. 生成 device_token:
            uuid = randomUUID()
            iat  = Date.now()
            payload = `${key}|${uuid}|${iat}`
            sig = hmacSha256Hex(env.DEVICE_TOKEN_SECRET, payload)
            token = base64url(payload) + "." + sig
      4. INSERT device_activations(id=sha256(token), license_key, token_hash, ...)
        ↓
   Worker → { ok:true, deviceToken: "...", ...other }

后续 verify
   扩展 → POST /api/license/verify { key, deviceToken }
        ↓
   Worker:
      1. 拆 token = base64url payload + sig
      2. 验 sig === hmacSha256Hex(SECRET, payload)
      3. 拆 payload → { tokenKey, uuid, iat }
      4. 校验 tokenKey === body.key（防 token 跨 license 重用）
      5. 查 device_activations WHERE id=sha256(token)
      6. 存在 → UPDATE last_seen，返 ok
         不存在 → 软告警 + 拒绝（token 在但不在 active set）
```

### 5.2 D1 schema 增量

```sql
-- migrations/004_device_token.sql
ALTER TABLE device_activations ADD COLUMN token_hash      TEXT;
ALTER TABLE device_activations ADD COLUMN token_issued_at INTEGER;
ALTER TABLE device_activations ADD COLUMN token_version   INTEGER DEFAULT 1;

CREATE INDEX IF NOT EXISTS idx_dev_token_hash ON device_activations(token_hash);

-- 旧的 device_fingerprint 列保留（不 NOT NULL，新行可为空）
-- 双轨期间：旧扩展继续走 fingerprint 路径，新扩展走 token 路径
```

### 5.3 双轨 verify 逻辑

```
verify 入口:
  if (body.deviceToken) {
    → token 路径（新扩展 ≥ v0.4.0）
  } else if (body.deviceFingerprint) {
    → fingerprint 路径（旧扩展 < v0.4.0，沿用现有逻辑）
  } else {
    → 首次激活路径（扩展首次连上，server 签 token，返给扩展）
  }
```

### 5.4 兼容性策略

| 场景 | 行为 |
|---|---|
| 新装扩展（v0.4.0+） | 第一次 verify 不传 fingerprint/token → server 签 token → 后续都走 token 路径 |
| 旧扩展升级（v0.3.x → v0.4.0） | 第一次新版 verify 仍带旧 fingerprint → server 检测到「fingerprint 已在 device_activations」→ 升级该行：写入 token_hash + 把 token 返给扩展 → 下次 verify 自动走 token 路径 |
| 旧扩展持续不升级 | 沿用 fingerprint 路径不影响。但攻击面仍开。**6 个月后**强制要求升级（旧路径返 403 reason="please_upgrade"） |
| 用户重装扩展 | chrome.storage 清空 → 行为同「新装扩展」→ 拿新 token，旧 token 在 device_activations 里继续到 90 天 prune 期或用户主动 unbind |

### 5.5 KV / Secret 配置

```toml
# wrangler.toml
[vars]
DEVICE_TOKEN_VERSION = "1"

# wrangler secret put DEVICE_TOKEN_SECRET
# 长度 ≥ 32 字节随机 hex（与 JWT_SECRET 同纲领）
```

**SECRET 轮换**：增量 token_version 字段（1 → 2），新签 token 用 v2 secret，旧 v1 token 在过渡期仍受信。强制下线时 INVALIDATE WHERE token_version < 2。

---

## §6 风险与未解决问题

### 6.1 已知不解决的问题

- ❌ **设备物理唯一性**：服务端无法保证「这个 token 只在 1 台机器上用」。攻击者拿 1 个有效 token 后可以复制到 N 台机器。这是 OS 层 / TPM / 浏览器绑定才能解决的问题，超出 Web Crypto 能力。
- ❌ **首次激活伪造**：T4（直接调 API）攻击成本仅从「改扩展」降到「写脚本」，本质上没拦死。但 server 现在有 rate limit + IP geolocation 可加严。

### 6.2 新引入的风险

| 风险 | 严重度 | 缓解 |
|---|---|---|
| DEVICE_TOKEN_SECRET 泄露 | 🔴 Critical | 轮换流程 + token_version；secret 永远不日志/不 commit |
| Token 复制到多设备（合法用户分享） | 🟡 Medium | multi_device_burst 仍有效检测；burst 阈值降低（限 token 重用） |
| 旧 fingerprint 路径长尾 | 🟡 Medium | 6 个月后强制升级 + dashboard 显眼提示 |
| D1 alter table 锁表 | 🟢 Low | ADD COLUMN 在 SQLite 是 metadata-only 操作（D1 ≤1 秒） |

### 6.3 灰度 + 监控

- Stage 1：D1 schema migration（生产 maintenance window 5 分钟）
- Stage 2：Worker 双轨上线，但**首次激活仍签 fingerprint**（feature flag 关闭 token 签发）
- Stage 3：开启 token 签发（feature flag），10% 新用户 → 50% → 100%
- Stage 4：Dashboard `/api/me` 增加字段 `device_path: "token"|"fingerprint"`，监控比例
- Stage 5：fingerprint 路径下线（提前 4 周浏览器/邮件公告）

---

## §7 实施路径（按 session 切分）

### Session 1（半天）· 基础设施

- [ ] D1 migration `004_device_token.sql`
- [ ] `wrangler secret put DEVICE_TOKEN_SECRET`
- [ ] worker.js 加 `signDeviceToken(env, key)` + `verifyDeviceToken(env, token)` 两个 helper
- [ ] smoke 加 8 case：sign/verify 往返 + tampered token + cross-license token + expired token

### Session 2（1 天）· verify 双轨改造

- [ ] `handleLicenseVerify` 加 token 路径分支
- [ ] 旧 fingerprint 路径升级逻辑（首次 token 返回 + 写 token_hash 列）
- [ ] device_activations 改用 token_hash 计数（fingerprint 路径继续用旧 id）
- [ ] smoke 加 12 case：双轨切换 / 升级 / 用户重装 / token 重用拒绝

### Session 3（半天）· 扩展端改造

- [ ] `src/shared/license.js#getDeviceFingerprint` → `getDeviceCredential()` 返 token 或 fingerprint 二选一
- [ ] `service-worker.js` license verify 调用点改造
- [ ] options/popup dashboard 设备列表区分「token 设备」「老 fingerprint 设备」
- [ ] check:ext 加 4 件设备列表 UI 检查

### Session 4（半天）· 灰度 + 监控

- [ ] feature flag `ENABLE_DEVICE_TOKEN` 在 wrangler.toml
- [ ] dashboard 加 device_path 字段
- [ ] memory-bank 沉淀「Phase 6 灰度状态」段
- [ ] 公告草稿（changelog + dashboard 通知）

### Session 5（1 天）· 全量切换 + 旧路径下线

- [ ] 全量开启 token 签发
- [ ] 6 个月窗口期监控
- [ ] fingerprint 路径下线 + 强制升级提示

---

## §8 决策点（用户 review 锚点）

读完本文后请明确：

1. **方案选择**：是否采纳「C + D 组合」？还是更轻量的「仅 D（不动 fingerprint）」？
2. **DEVICE_TOKEN_SECRET 轮换策略**：是否接受 token_version 字段方案？
3. **旧扩展长尾**：6 个月强制升级是否合适？还是 12 个月更稳？
4. **优先级**：是否值得在当前 session 后立即开 Session 1？还是先做 UX 项（账户安全卡 / admin dashboard）？

---

## §9 关联材料

- `docs/PHASE1_REPORT.md` — Phase 1 实施报告（参考格式）
- `server/abuse/detectors.js` — 现有 multi_device_burst 检测器
- `server/abuse/thresholds.js` — DEVICE_LIMITS 常量
- `memory-bank/progress.md` — 反例约定第 N 条沉淀位置（Phase 6 上线后追加）
- 攻击模型对照：[OWASP API Security Top 10 · API2:2023 Broken Authentication](https://owasp.org/API-Security/editions/2023/en/0xa2-broken-authentication/)

---

> **Next**：用户 review §6+§7+§8 → 确认方案 → 开 Session 1 PR
