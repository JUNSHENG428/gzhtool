/**
 * server/email/security-alert.js · 39th 续³ #9 · 从 worker.js 抽出
 *
 * Phase 4 防滥用三件套的安全告警邮件被动通知 helper。从 worker.js 抽到独立模块的目的：
 *   - worker.js 之前 ~3300 行，邮件模板 + 节流逻辑 + Resend 调用 200+ 行混在一起
 *   - 单独成模块后：① smoke 单测可直接 import 而不必 import 整个 worker；
 *     ② 未来加新邮件 type（如付费失败 / 订阅过期提醒）时模块边界清晰
 *
 * 触发条件 / 节流设计 / 失败模式枚举详见各 helper 内部注释。
 *
 * 与 worker.js 的边界：
 *   - 本模块只导出 helper，不绑定路由
 *   - 所有 env / KV / DB 由调用方传入（与 server/llm/upstream.js 同 pattern）
 *   - 不引用 worker.js 任何符号（避免循环依赖）
 *
 * 与 server/llm/upstream.js 同 pattern：
 *   - 永不抛错（外层包 ctx.waitUntil 期间崩溃不能影响主响应）
 *   - 所有失败用 status 字符串返回让调用方记日志
 */

// ============================================================
// 何时触发：
//   - token_spike (Phase 4.3)：5min 滑窗 token 用量超阈值
//   - multi_device_burst (Phase 4.4)：5min 滑窗 distinct 设备数超阈值
//   - device_limit_exceeded (Phase 2.7)：尝试激活 N+1 台设备被硬卡
//
// 节流：按 type 差异化（39th 续³ #6 修订）
//   - device_limit_exceeded 7 天 1 封——攻击者可故意撞 device_limit 用作账号枚举信号
//     （已知合法 license + 假 fingerprint 触发 → 真主人收到邮件确认账号有效），缩低频次
//   - token_spike / multi_device_burst 24 小时 1 封——这两类自然触发频次低，且邮件价值高
//   - KV `security_email:{userId}:{type}:{bucketId}` bucket 按 type 不同：
//     · 7-day: bucketId = `week-${Math.floor(now / (7d ms))}`
//     · 24h:   bucketId = YYYY-MM-DD UTC
//
// 邮件内容设计：
//   1. 明确发生了什么（具体数据）
//   2. 「如果是你本人」的免责说明放最显眼位置（避免吓到用户）
//   3. 「如果不是你本人」的下一步行动链接（修改密码 / 解绑设备 / 联系 support）
//   4. 强调每天最多 1 封同类型邮件（解释为什么没看到更多）
//
// 失败模式（永不抛错，外层包 ctx.waitUntil）：
//   "skipped"         - RESEND_API_KEY / userId 缺失
//   "throttled"       - 已发过同类邮件
//   "no_email"        - users.email 查询为空
//   "lookup_failed"   - D1 查询异常
//   "failed"          - Resend API 错误
//   "sent"            - 成功发出
// ============================================================

export async function sendSecurityAlertEmail(env, { userId, type, details }) {
  if (!env.RESEND_API_KEY || !userId) return "skipped";

  // 节流预检（39th 续² · review 反馈）：先 get 不 put——Resend 失败时不写节流标，下次告警可重试
  // 写节流标移到下面 Resend 200 成功之后，确保只有真正发出的邮件才占用节流槽位
  let throttleKey = null;
  if (env.RATE_LIMIT_KV) {
    const isWeekly = type === "device_limit_exceeded";
    const bucketId = isWeekly
      ? `week-${Math.floor(Date.now() / (86400 * 7 * 1000))}` // 7 天滑窗
      : new Date().toISOString().slice(0, 10);                 // YYYY-MM-DD UTC 每日
    throttleKey = `security_email:${userId}:${type}:${bucketId}`;
    const seen = await env.RATE_LIMIT_KV.get(throttleKey);
    if (seen) return "throttled";
  }

  // 取邮箱（OAuth-only 用户也有邮箱，所以 users 表查询就够）
  let email = "";
  try {
    const user = await env.DB.prepare("SELECT email FROM users WHERE id = ?")
      .bind(userId)
      .first();
    email = String(user?.email || "");
  } catch (err) {
    console.warn("[security-email] lookup user failed", err?.message || err);
    return "lookup_failed";
  }
  if (!email) {
    // pre-bind license 等场景：用户绑定缺失时跳过邮件，记录方便监控（防滥用观察盲区）
    console.log(`[security-email] skip: no_email userId=${userId} type=${type}`);
    return "no_email";
  }

  const content = buildSecurityAlertContent(type, details || {}, env);
  if (!content) {
    console.warn(`[security-email] unknown type=${type}`);
    return "skipped";
  }

  const fromEmail = env.RESET_EMAIL_FROM || "no-reply@docuearn.com";
  console.log(`[security-email] sending type=${type} to=${email}`);
  try {
    const resp = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${env.RESEND_API_KEY}`
      },
      body: JSON.stringify({
        from: fromEmail,
        to: [email],
        subject: content.subject,
        text: content.text
      })
    });
    if (!resp.ok) {
      const body = await resp.text().catch(() => "");
      console.error(
        `[security-email] Resend FAILED type=${type} status=${resp.status} body=${body.slice(0, 500)}`
      );
      // 不写节流标——失败时下次告警可重试（review 反馈：避免 24h 内 Resend 短暂故障导致用户彻底收不到）
      return "failed";
    }
    console.log(`[security-email] Resend ok type=${type}`);
    // TTL 按 type 差异化（与 throttleKey bucketId 保持窗口一致）
    //   - device_limit_exceeded 8 天 TTL（7d 窗口 + 1d 容错）
    //   - 其他类型 48h TTL（24h 窗口 + 24h 容错）
    if (throttleKey) {
      const isWeekly = type === "device_limit_exceeded";
      const ttl = isWeekly ? 86400 * 8 : 86400 * 2;
      await env.RATE_LIMIT_KV.put(throttleKey, "1", { expirationTtl: ttl });
    }
    return "sent";
  } catch (err) {
    console.error(
      `[security-email] Resend network error type=${type}:`,
      err?.message || err
    );
    // 同上：不写节流标
    return "failed";
  }
}

/**
 * 构建三种告警类型的邮件内容（subject + text）。
 * text 形式（非 HTML）—— 与 sendResetEmail 同风格，所有邮件客户端都能渲染。
 *
 * 入参 type ∈ ["token_spike", "multi_device_burst", "device_limit_exceeded"]；
 * 其它 type 返 null 让调用方跳过。
 */
export function buildSecurityAlertContent(type, details, env) {
  const site = env.SITE_URL || "https://docuearn.com";
  const ts = new Date().toISOString();
  const planLabel = (plan) =>
    plan === "yearly"
      ? "年费"
      : plan === "monthly"
        ? "月费"
        : plan === "pro"
          ? "Pro"
          : "免费";

  if (type === "token_spike") {
    const cumulative = Number(details.cumulative) || 0;
    const threshold = Number(details.threshold) || 0;
    const plan = String(details.plan || "free");
    return {
      subject: "润笔 · 检测到 AI 用量异常",
      text: `你好，

我们刚才检测到你的润笔账号在 5 分钟内消耗了大量 AI token：
- 时间：${ts} UTC
- 数量：${cumulative} token（超过${planLabel(plan)}套餐 ${threshold} 阈值）

如果是你本人正在批量改写文章，可以忽略本邮件——这只是常规观察，账号本身一切正常。

如果不是你本人操作（账号可能被盗用 / 凭据泄露）：
1. 立即修改密码：${site}/dashboard
2. 解绑所有设备（强制其它设备重新登录）
3. 邮件 support@docuearn.com 申请人工核查

为避免邮件洪水，每类异常每天最多发 1 封。

— 润笔 DocuEarn
让你多一份安稳`
    };
  }

  if (type === "multi_device_burst") {
    const uniques = Number(details.uniques) || 0;
    const threshold = Number(details.threshold) || 0;
    const plan = String(details.plan || "free");
    const keyTail = String(details.licenseKey || "").slice(-4);
    return {
      subject: "润笔 · 检测到多设备并发激活",
      text: `你好，

我们刚才检测到你的润笔 license 在 5 分钟内有大量不同设备激活：
- 时间：${ts} UTC
- 数量：${uniques} 台 distinct 设备（超过${planLabel(plan)}套餐 ${threshold} 阈值）
- License：····-${keyTail}

如果是你本人在多台机器上同步登录（例如新换电脑 / 手机），可以忽略本邮件——设备会自动记录到列表里。

如果不是你本人操作（license 可能被多人共用）：
1. 立即修改密码：${site}/dashboard
2. 在「我的设备」一键清理 30 天未活跃 / 解绑陌生设备
3. 邮件 support@docuearn.com 申请人工核查

为避免邮件洪水，每类异常每天最多发 1 封。

— 润笔 DocuEarn
让你多一份安稳`
    };
  }

  if (type === "device_limit_exceeded") {
    const activated = Number(details.activated) || 0;
    const limit = Number(details.limit) || 0;
    const plan = String(details.plan || "free");
    const keyTail = String(details.licenseKey || "").slice(-4);
    return {
      subject: "润笔 · 检测到设备激活上限",
      text: `你好，

我们刚才有人尝试用你的润笔 license 激活新设备，触发了套餐上限：
- 时间：${ts} UTC
- 已激活：${activated} 台（${planLabel(plan)}套餐上限 ${limit} 台）
- License：····-${keyTail}

如果是你本人换机 / 重装系统，登录控制台清理一台旧设备即可释放配额：
${site}/dashboard

如果不是你本人（陌生设备尝试激活）：
1. 立即修改密码：${site}/dashboard
2. 邮件 support@docuearn.com 申请人工核查

为避免邮件洪水 + 防滥用（攻击者可故意触发本告警以枚举账号），device_limit 类邮件每 7 天最多发 1 封。

— 润笔 DocuEarn
让你多一份安稳`
    };
  }

  return null;
}
