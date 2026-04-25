// =====================================================================
// support@docuearn.com 自动回复 Worker
// =====================================================================
//
// 触发：Cloudflare Email Routing 把 support@docuearn.com 的来信转交本 Worker。
// 行为：
//   1. 自循环防护：发件人若是本身配置的 FROM_ADDR，直接 return（防止 Resend 发出去
//      的回复又被路由进来形成无限循环）。
//   2. 生成工单号 DOC-YYYYMMDD-NNNN（NNNN 是 1000-9999 的随机数），便于后续在 Gmail
//      标签 / Plain / Crisp 等系统里串联同一会话。
//   3. message.forward(env.FORWARD_TO) 把原邮件转给运营 Gmail 兜底人工回复。
//   4. 调 Resend API 发自动回复，主题 "[DOC-...] 已收到你的反馈 · Re: <原主题>"，
//      正文同时发 HTML + 纯文本（防垃圾邮件评分 + 老邮件客户端兼容）。
//      In-Reply-To / References 头沿用原邮件的 Message-ID，让会话在 Gmail 里串成一组。
//
// 必需 env（在 Cloudflare Workers Settings → Variables and Secrets 配）：
//   - FORWARD_TO       (Plain text)  : 接收转发的运营 Gmail，如 ops@gmail.com
//                                      ⚠️ 必须先在 Cloudflare → Email Routing →
//                                      Destination addresses 添加并完成验证邮件链接，
//                                      否则 message.forward() 会抛 "destination
//                                      address not verified"。
//   - FROM_ADDR        (Plain text)  : 自动回复的发件地址，固定 support@docuearn.com
//   - WECHAT_ID        (Plain text)  : 客服微信号（自动回复正文里的早期用户快速通道）
//   - RESEND_API_KEY   (Secret)      : Resend API Key (re_xxx...)
//                                      生成后必须把 docuearn.com 在 Resend 验证 DNS。
//
// 部署：
//   cd server/email-worker
//   npx wrangler deploy
//   然后 Cloudflare → Email Routing → Routes → support@docuearn.com 的 Action
//   改为 Send to a Worker → 选 support-autoreply。
//
// 历史：详见 memory-bank/activeContext.md 2026-04-24 sixth session "support@docuearn.com
//   自动回复全链路上线"。本文件首次入库 2026-04-25。
// =====================================================================

const FAQ_URL = "https://docuearn.com/faq";
const DOCS_URL = "https://docuearn.com/docs";
const CHANGELOG_URL = "https://docuearn.com/changelog";

export default {
  /**
   * @param {ForwardableEmailMessage} message
   * @param {{ FORWARD_TO: string; FROM_ADDR: string; WECHAT_ID: string; RESEND_API_KEY: string }} env
   * @param {ExecutionContext} ctx
   */
  async email(message, env, ctx) {
    if (!env.FROM_ADDR || !env.FORWARD_TO || !env.RESEND_API_KEY) {
      console.error("[autoreply] missing required env (FROM_ADDR/FORWARD_TO/RESEND_API_KEY)");
      return;
    }

    if (message.from === env.FROM_ADDR) {
      console.log(`[autoreply] skip self-loop from=${message.from}`);
      return;
    }

    const ticketId = generateTicketId();
    const originalSubject = message.headers.get("subject") || "(无主题)";
    const messageId = message.headers.get("message-id") || "";
    const fromAddr = message.from;
    const wechatId = env.WECHAT_ID || "（暂未配置）";

    try {
      await message.forward(env.FORWARD_TO);
    } catch (err) {
      console.error(
        `[autoreply] forward failed ticket=${ticketId} to=${env.FORWARD_TO} err=${err && err.message ? err.message : err}`,
      );
    }

    try {
      const resp = await fetch("https://api.resend.com/emails", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${env.RESEND_API_KEY}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          from: `Docuearn 支持 <${env.FROM_ADDR}>`,
          to: fromAddr,
          subject: `[${ticketId}] 已收到你的反馈 · Re: ${originalSubject}`,
          html: buildAutoReplyHtml(ticketId, wechatId),
          text: buildAutoReplyText(ticketId, wechatId),
          headers: messageId
            ? {
                "In-Reply-To": messageId,
                References: messageId,
              }
            : undefined,
        }),
      });

      const bodyPreview = (await resp.text()).slice(0, 500);
      if (!resp.ok) {
        console.error(
          `[autoreply] failed ticket=${ticketId} status=${resp.status} body=${bodyPreview}`,
        );
      } else {
        console.log(`[autoreply] sent ticket=${ticketId} to=${fromAddr}`);
      }
    } catch (err) {
      console.error(
        `[autoreply] resend network error ticket=${ticketId} err=${err && err.message ? err.message : err}`,
      );
    }
  },
};

function generateTicketId() {
  const now = new Date();
  const yyyy = now.getUTCFullYear();
  const mm = String(now.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(now.getUTCDate()).padStart(2, "0");
  const nnnn = Math.floor(Math.random() * 9000 + 1000);
  return `DOC-${yyyy}${mm}${dd}-${nnnn}`;
}

function buildAutoReplyText(ticketId, wechatId) {
  return `你好 👋

我们已经收到你的邮件，工单号 [${ticketId}]，会在 24 小时内（北京时间工作日）人工回复。
回信时请保留主题里的工单号，方便我们对上记录。

━━━━━━━━━━━━━━━━━━━━

📚 在等回复之前，先看一眼这些可能直接帮到你：
• 常见问题 FAQ：${FAQ_URL}
• 使用文档：${DOCS_URL}
• 更新日志：${CHANGELOG_URL}

━━━━━━━━━━━━━━━━━━━━

🎯 为了一次性解决，请在回信里补充：
1. 插件版本号（chrome://extensions/ → Docuearn → 版本号）
2. Chrome 版本（chrome://version/ → 第一行）
3. 操作系统（Windows 11 / macOS 14 / ...）
4. 复现步骤 + 截图 / 录屏
5. 浏览器 Console 报错（F12 → Console）
6. 购买时使用的邮箱（订单类问题必填）

━━━━━━━━━━━━━━━━━━━━

⚡ 早期用户快速通道
紧急 bug / 订单问题，加微信 ${wechatId}（备注「Docuearn + 邮箱」）

—— Docuearn 团队
工单号：${ticketId}`;
}

function buildAutoReplyHtml(ticketId, wechatId) {
  return `<!DOCTYPE html><html><body style="font-family:-apple-system,BlinkMacSystemFont,'PingFang SC','Helvetica Neue',sans-serif;max-width:600px;margin:0 auto;padding:24px;color:#1a1a1a;line-height:1.6">
<p>你好 👋</p>
<p>我们已经收到你的邮件，工单号 <strong style="background:#fef3c7;padding:2px 8px;border-radius:4px">${ticketId}</strong>，会在 <strong>24 小时内</strong>（北京时间工作日）人工回复。</p>
<p style="color:#666;font-size:14px">回信时请保留主题里的工单号，方便我们对上记录。</p>

<hr style="border:none;border-top:1px solid #eee;margin:24px 0">

<h3 style="margin:0 0 12px">📚 在等回复之前，看看这些</h3>
<ul style="padding-left:20px;margin:0">
  <li><a href="${FAQ_URL}" style="color:#2563eb">常见问题 FAQ</a></li>
  <li><a href="${DOCS_URL}" style="color:#2563eb">使用文档</a></li>
  <li><a href="${CHANGELOG_URL}" style="color:#2563eb">更新日志</a></li>
</ul>

<hr style="border:none;border-top:1px solid #eee;margin:24px 0">

<h3 style="margin:0 0 12px">🎯 请在回信里补充以下信息</h3>
<ol style="padding-left:20px;margin:0">
  <li><strong>插件版本号</strong>（chrome://extensions/ → Docuearn → 版本号）</li>
  <li><strong>Chrome 版本</strong>（chrome://version/ → 第一行）</li>
  <li><strong>操作系统</strong>（Windows 11 / macOS 14 / ...）</li>
  <li><strong>复现步骤 + 截图 / 录屏</strong>（直接拖进回信）</li>
  <li><strong>浏览器 Console 报错</strong>（F12 → Console）</li>
  <li><strong>购买时使用的邮箱</strong>（订单类问题必填）</li>
</ol>

<hr style="border:none;border-top:1px solid #eee;margin:24px 0">

<div style="background:#f0f9ff;border-left:3px solid #0ea5e9;padding:12px 16px;border-radius:4px">
  <p style="margin:0"><strong>⚡ 早期用户快速通道</strong></p>
  <p style="margin:4px 0 0;font-size:14px">紧急 bug / 订单问题，加微信 <code style="background:#fff;padding:2px 6px;border-radius:3px">${wechatId}</code>（备注「Docuearn + 邮箱」）</p>
</div>

<p style="color:#999;font-size:13px;margin-top:32px">—— Docuearn 团队<br>工单号：${ticketId}</p>
</body></html>`;
}
