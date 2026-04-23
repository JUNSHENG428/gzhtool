/**
 * site-config.js — 站点全局可配置项
 * --------------------------------------------------------------
 * 这个文件是「上线时唯一需要改的地方」。把后端域名、Lemon Squeezy 链接、
 * 客服邮箱等所有"和环境绑定"的字符串都放这里，避免散落在各个 .html / .js 中。
 *
 * 用法：
 *   - 各页面直接 import { SITE_CONFIG } from "./site-config.js" 即可读
 *   - api.js 仍然优先读 <meta name="api-base">，没有 meta 才会被这里 SITE_BASE 覆盖
 *
 * 部署清单（生产前必须改）：
 *   1) WORKER_BASE   → 你的 Cloudflare Worker 完整域名
 *   2) LEMON_LINKS   → Lemon Squeezy 后台 Variant 的 checkout URL
 *   3) SUPPORT_EMAIL → 客服 / 反馈邮箱
 */

export const SITE_CONFIG = {
  /** 当前站点自身域名（用于 success / cancel URL 回流；也写死在 worker 的 SITE_BASE 环境变量） */
  SITE_BASE:
    (typeof location !== "undefined" && location.origin) ||
    "https://gzh.example.com",

  /** Cloudflare Worker 的对外完整 URL；同时被 api.js 读取（meta 优先级更高） */
  WORKER_BASE: "https://gzh-license.workers.dev",

  /** Lemon Squeezy checkout 链接；按 variant 维度对应到 [data-checkout="xxx"] 按钮 */
  LEMON_LINKS: {
    monthly: "https://yourstore.lemonsqueezy.com/buy/REPLACE-ME-MONTHLY",
    yearly: "https://yourstore.lemonsqueezy.com/buy/REPLACE-ME-YEARLY"
  },

  /** Lemon Squeezy 自带的 overlay checkout（弹窗内付款），开了无需跳出页面 */
  LEMON_USE_OVERLAY: true,

  /** 支付完成 / 取消后回到的页面（dashboard 会读 ?from=checkout 弹 toast） */
  CHECKOUT_SUCCESS_URL: "/dashboard.html?from=checkout&result=success",
  CHECKOUT_CANCEL_URL: "/pricing.html?from=checkout&result=cancel",

  /** 客服 / 反馈邮箱 */
  SUPPORT_EMAIL: "hello@example.com"
};
