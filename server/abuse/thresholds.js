/**
 * server/abuse/thresholds.js · 39th 续³ #9 第二步 · 从 worker.js 抽出
 *
 * Phase 4 防滥用 hardcoded 配置常量。worker.js 拆分第二步，把 abuse 域配置集中：
 *   - MAX_REGISTRATIONS_PER_IP_PER_DAY · 单 IP 24h 注册数硬限（Phase 4.2）
 *   - TOKEN_SPIKE_THRESHOLDS · 5min 滑窗 token 暴涨告警阈值（Phase 4.3）
 *   - DEVICE_LIMITS · 每张 license 最多设备数（Phase 2.7 Strategy B）
 *   - deviceConcurrentThreshold · 跨设备 burst 告警阈值（Phase 4.4）
 *   - PLAN_RANK · plan 升档比较（issueProLicense 只升不降）
 *
 * 设计要点：
 *   - 纯 config，无运行时副作用
 *   - 与 server/llm/router.js MODEL_TIERS / PLAN_QUOTA / PLAN_RPM 同一阶层（Phase 1+2 配置）
 *   - 调用方：worker.js / server/abuse/detectors.js / smoke.mjs（mock 测）
 */

// 39th 续 · Phase 4 防滥用 · 单 IP 24 小时内最多注册次数
// 5 次的选择理由：覆盖家庭 / 小公司 NAT 后多人合理共享场景，挡住批量薅账号脚本
// 撞顶返 429 + 友好提示「同 IP 24 小时内已注册 X 次，请明日再试 / 不同网络重试 / 联系 support」
export const MAX_REGISTRATIONS_PER_IP_PER_DAY = 5;

// 39th 续 · Phase 4.3 · token 暴涨告警阈值（5 分钟滑窗内累计 token 超此值 → audit warn）
// 基线推导：plan 月度 cap / 30 天 / 24 小时 ≈ 每小时合理用量；5 分钟阈值 = 每小时基线的 4 倍
//   - Free 30 次/月 ≈ 1 次/天，单次经济档可达 1K token；阈值 5000 ≈ 5 次/5min（正常用户连续点 1-2 篇文章
//     完全够用，5 次内不触发；脚本批量调用才会撞）
//   - Monthly 5M token/月 ≈ 167K/天 ≈ 7K/小时 → 5 分钟 50K = 7 倍 spike
//   - Yearly 20M token/月 ≈ 667K/天 ≈ 28K/小时 → 5 分钟 200K = 7 倍 spike
// 仅 audit_log 写 warn 条不阻塞调用——false positive 风险高于真实滥用，先观察再决定是否硬卡
//
// Free 1000 → 5000 的修订（review 反馈）：经济档单次改写 200-1000 token，正常用户改写 1 篇就可能触发
// 1000 阈值。提到 5000 后正常用户连改 5 篇才命中，仍能挡住自动化脚本批量调用（一秒数十请求）。
export const TOKEN_SPIKE_THRESHOLDS = Object.freeze({
  free: 5_000,
  monthly: 50_000,
  yearly: 200_000
});

// 39th 续 · Phase 2.7 Strategy B · 每张 license 最多设备数（plan 区分）
// Free 1 / Monthly 3 / Yearly 10。pro 老 SKU 向后兼容映射 yearly（10 台）。
// 调用方：handleLicenseVerify（hard cap 撞顶 403）+ deviceConcurrentThreshold（soft burst）+
//        loadUserLicenseSummary（暴露给 dashboard 渲染配额角标）
export const DEVICE_LIMITS = Object.freeze({
  free: 1,
  monthly: 3,
  yearly: 10
});

// 39th 续 · Phase 4.4 · 同 license 跨设备并发突发检测（5 分钟滑窗内 distinct fingerprint 数）
// 阈值 = DEVICE_LIMITS[plan] + 2（容忍合理 burst：用户重启浏览器 / 切换 chrome profile 重新激活）
// 单 license 5min 内出现 distinct fingerprints > deviceLimit + 2 → verify_log 写 multi_device_burst
// 这通常是「license 被多人共享 / 转售」的信号——单设备的行为不会触发此阈值
export function deviceConcurrentThreshold(plan) {
  const base = DEVICE_LIMITS[plan] ?? DEVICE_LIMITS.free;
  return base + 2;
}

// 39th 续 · plan rank 用于"只升档不降档"逻辑（issueProLicense + loadUserLicenseSummary）
// pro 是历史 SKU（虎皮椒早期 + Lemon Squeezy），向后兼容为最高级别；
// monthly < yearly 的差异由 derivePlanForLlm / devicePlanFromLicenseRow 真实生效
// （export 是为 smoke 单测可见性，CF Worker 只用 default export 不影响 runtime）
export const PLAN_RANK = Object.freeze({ free: 0, monthly: 1, yearly: 2, pro: 3 });
