/**
 * server/abuse/detectors.js · 39th 续³ #9 第二步 · 从 worker.js 抽出
 *
 * Phase 4 防滥用 detector 三件套：
 *   - detectAndLogTokenSpike       · Phase 4.3 · 5min 滑窗 token 暴涨告警
 *   - detectAndLogMultiDeviceBurst · Phase 4.4 · 5min 滑窗跨设备并发突发
 *   - （IP 注册限速已直接走 rateLimit + MAX_REGISTRATIONS_PER_IP_PER_DAY，
 *     不需要独立 detector，所以本模块只有 2 个函数）
 *
 * 抽出动机（worker.js 瘦身第二步）：
 *   - 两函数共 ~140 行 + 详尽 race condition 注释，混在 worker.js 中段难维护
 *   - 单独成模块后 smoke 单测可独立 import；
 *   - 与 server/email/security-alert.js 同 pattern：env 由调用方注入，永不抛错
 *
 * 失败语义：
 *   - 任何 KV / D1 / fetch 失败 → console.warn 吞掉，**不**阻塞主链路
 *   - 防滥用属于「nice-to-have observability」，告警漏发好过主链路阻塞
 *
 * 与 worker.js 边界：
 *   - 本模块只导出两个 detector，不绑定路由
 *   - 配置常量从 ./thresholds.js 导入（TOKEN_SPIKE_THRESHOLDS / deviceConcurrentThreshold）
 *   - 工具函数 sha256Hex 从 ../util/crypto.js 导入
 *   - 邮件告警 sendSecurityAlertEmail 从 ../email/security-alert.js 导入
 *   - 不引用 worker.js 任何符号（避免循环依赖）
 */

import { TOKEN_SPIKE_THRESHOLDS, deviceConcurrentThreshold } from "./thresholds.js";
import { sha256Hex } from "../util/crypto.js";
import { sendSecurityAlertEmail } from "../email/security-alert.js";

// 39th 续 · Phase 4.3 · 检测并记录 token 暴涨（audit_log 软告警，不阻塞 LLM 调用）
//
// 工作原理：
//   - KV bucket 按 (user_id, 5min epoch) 分；每次成功 LLM 调用累计 token 数
//   - 单个 5min 窗口内累计超 plan-specific 阈值 → audit_log 写 status="suspicious_spike"
//     error_code 字段记入 "{plan}_{cumulative}_{threshold}" 让运维 grep 出真凶
//   - 同一 5 分钟窗口内只触发一次告警（KV 标记 spike_logged:1），避免 audit_log 暴涨
//   - failed-silent：KV / D1 任何写失败都吞掉，不阻塞主链路（防滥用是 nice-to-have observability）
//
// 39th 续³ Phase 5 加固 · 已知 race condition（注释挑明 trade-off）：
//   - KV 没有原子 INCR，sum 累计走 `get + put` 双步，并发请求间窗口内可丢更新
//   - 实测影响：5min 窗口内并发 N 个请求 → 累计值可能低估 ~10%（少计 1-2 个 token 数）
//   - 为什么可接受：① token spike 阈值远超平均（7 倍 spike 才告警），少计 30% 也不影响
//     告警触发；② 软告警语义（不阻塞调用、不通知用户、运维 grep）允许 ±10% 误差
//   - 为什么不修：① KV INCR 不存在；② 改 D1 行级锁会让每次 recordUsage 多 1 次 D1 写
//     拖累 LLM 调用主链路；③ 真打掉攻击者的是配额硬卡（checkQuota），spike 告警仅为观察
//   - 若未来要严格计数（合规审计场景），用 D1 表 + COMMIT 事务替代 KV
//
// 调用方：handleLlmChat 成功路径 + handleLlmStream flush（统一计入流式调用）
export async function detectAndLogTokenSpike(env, userId, plan, tokensThisCall) {
  if (!env.RATE_LIMIT_KV || !env.DB) return;
  const total = Number(tokensThisCall) || 0;
  if (total <= 0) return;
  try {
    const fiveMinEpoch = Math.floor(Date.now() / 300_000);
    const sumKey = `token_spike:sum:${userId}:${fiveMinEpoch}`;
    const flagKey = `token_spike:flag:${userId}:${fiveMinEpoch}`;
    const stored = await env.RATE_LIMIT_KV.get(sumKey);
    const cumulative = (Number(stored) || 0) + total;
    await env.RATE_LIMIT_KV.put(sumKey, String(cumulative), { expirationTtl: 600 });

    const threshold = TOKEN_SPIKE_THRESHOLDS[plan] || TOKEN_SPIKE_THRESHOLDS.free;
    if (cumulative <= threshold) return;

    // 撞阈值：检查是否已经为本窗口写过告警
    const alreadyFlagged = await env.RATE_LIMIT_KV.get(flagKey);
    if (alreadyFlagged) return;
    await env.RATE_LIMIT_KV.put(flagKey, "1", { expirationTtl: 600 });

    // 写 audit_log 软告警条（运维可 grep）
    await env.DB.prepare(
      `INSERT INTO llm_audit_log
         (user_id, ts, model, tier, upstream, prompt_tokens, completion_tokens, status, error_code)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
      .bind(
        userId,
        Date.now(),
        null,
        null,
        null,
        0,
        0,
        "suspicious_spike",
        `${plan}_5min_${cumulative}_threshold_${threshold}`
      )
      .run();

    // 39th 续 · 给用户发安全告警邮件（节流：每类型每日 1 封，KV 把控）
    await sendSecurityAlertEmail(env, {
      userId,
      type: "token_spike",
      details: { plan, cumulative, threshold }
    });
  } catch (err) {
    console.warn("[abuse] detectAndLogTokenSpike failed", err?.message || err);
  }
}

// 39th 续 · Phase 4.4 · 检测并记录 license 跨设备并发突发（verify_log 软告警，不阻塞）
//
// 工作原理：
//   - KV bucket 按 (license_key, 5min epoch) 分；每次 verify 成功后 sha256 fingerprint 加入 set
//     （JSON 数组 + 去重；hash 而非明文 fingerprint，KV 不存可逆设备身份）
//   - 同一 5 分钟窗口内 distinct fingerprint 数超过阈值（deviceLimit + 2）→ verify_log 写 multi_device_burst
//   - 同一窗口内只触发一次告警（KV 标记 burst_logged:1，避免每次 verify 都写日志）
//   - failed-silent：KV / D1 任一写失败都吞掉，不阻塞主链路
//
// 39th 续³ Phase 5 加固 · 已知 race condition（注释挑明）：
//   - set 并发 `get + JSON.parse + push + JSON.stringify + put` 多步非原子
//   - 5min 窗口内若 N 个 verify 同时发起，可能丢失 1-2 个 fingerprint（B 读到 null 用 [] 起步，
//     而 A 已 put 了 [a]；最终 B put [b] 覆盖 → set 实际只剩 [b]）
//   - 实测影响：阈值附近偶发漏告警（实际 13 fingerprint 但 set 长度看到 11）
//   - 为什么可接受：① "license 卖给多人同时用"是持续性场景，下个 5min 窗口仍会撞，最终告警
//     触发只是延迟一两个窗口；② 软告警不阻塞用户；③ device_limit 硬卡已挡 license 总数
//
// 与 Phase 2.7 device_limit 区别：
//   - device_limit 是总数硬卡（INSERT 时 count >= limit 直接 403）
//   - multi_device_burst 是并发软告警（5 分钟内 distinct fingerprints 异常突发）
//   - 两者目标不同：limit 防"狂加 100 台设备"；burst 防"license 被卖给多人同时用"
//
// 调用方：handleLicenseVerify 成功路径（writeVerifyLog "ok" 之后）
// userId 入参用于撞顶时自动给用户发安全告警邮件（节流后台 KV 把控）
export async function detectAndLogMultiDeviceBurst(env, licenseKey, userId, fingerprint, plan, ip, ua) {
  if (!env.RATE_LIMIT_KV || !env.DB || !fingerprint || !licenseKey) return;
  try {
    const fingerprintHash = await sha256Hex(fingerprint);
    const fpShort = fingerprintHash.slice(0, 12); // 12 字符已够分辨同 5min 内 N 设备
    const fiveMinEpoch = Math.floor(Date.now() / 300_000);
    const setKey = `concurrent_dev:set:${licenseKey}:${fiveMinEpoch}`;
    const flagKey = `concurrent_dev:flag:${licenseKey}:${fiveMinEpoch}`;

    const stored = await env.RATE_LIMIT_KV.get(setKey);
    let set;
    try {
      set = stored ? JSON.parse(stored) : [];
    } catch {
      set = [];
    }
    if (!Array.isArray(set)) set = [];
    if (!set.includes(fpShort)) {
      set.push(fpShort);
      // 卡 set 长度避免 KV value 暴涨（极端情况下若有人 1000 个 fingerprint 全打过来）
      if (set.length > 50) set.length = 50;
      await env.RATE_LIMIT_KV.put(setKey, JSON.stringify(set), { expirationTtl: 600 });
    }

    const threshold = deviceConcurrentThreshold(plan);
    if (set.length <= threshold) return;

    // 撞阈值：检查窗口内是否已经写过告警
    const alreadyFlagged = await env.RATE_LIMIT_KV.get(flagKey);
    if (alreadyFlagged) return;
    await env.RATE_LIMIT_KV.put(flagKey, "1", { expirationTtl: 600 });

    // 写 verify_log 软告警条；result="multi_device_burst" 让运维 grep 出真凶
    await env.DB.prepare(
      `INSERT INTO verify_log (license_key, ip, user_agent, result, detail, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`
    )
      .bind(
        licenseKey,
        ip || "unknown",
        (ua || "").slice(0, 256),
        "multi_device_burst",
        `plan=${plan} uniques=${set.length} threshold=${threshold} window=5min`.slice(0, 256),
        Date.now()
      )
      .run();

    // 39th 续 · 给 license 持有者发安全告警邮件（userId 可能为空——未绑定 license）
    if (userId) {
      await sendSecurityAlertEmail(env, {
        userId,
        type: "multi_device_burst",
        details: {
          plan,
          uniques: set.length,
          threshold,
          licenseKey
        }
      });
    }
  } catch (err) {
    console.warn("[abuse] detectAndLogMultiDeviceBurst failed", err?.message || err);
  }
}
