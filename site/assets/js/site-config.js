/**
 * site-config.js — 站点全局可配置项
 * --------------------------------------------------------------
 * 这个文件是「上线时唯一需要改的地方」。把品牌、后端域名、支付链接、
 * 客服邮箱等所有"和环境绑定"的字符串都放这里，避免散落在各个 .html / .js 中。
 *
 * 用法：
 *   - 各页面直接 import { SITE_CONFIG, BRAND } from "./site-config.js" 即可读
 *   - api.js 仍然优先读 <meta name="api-base">，没有 meta 才会被这里 SITE_BASE 覆盖
 */

/** 品牌核心表达资产 —— 全站唯一来源，改这里就够了 */
export const BRAND = {
  /** 中文品牌名 */
  NAME_ZH: "润笔",
  /** 英文品牌名 / 公司名 */
  NAME_EN: "DocuEarn",
  /** 品类定义 */
  CATEGORY: "公众号创作者的得力助手",
  /** 主 Slogan（首屏大字） */
  SLOGAN_HERO: "笔下生花，花下生金",
  /** 情绪承诺（副标 / footer） */
  PROMISE: "让你多一份安稳",
  /** 完整品牌句（公众号简介 / OG description） */
  FULL: "润笔 · 公众号创作者的得力助手，笔下生花，花下生金，让你多一份安稳。",
  /** 一句话价值（投流 / 名片） */
  ONE_LINER: "润笔，让你多一份安稳",
  /** 商务 BP 开篇句 */
  BIZ_INTRO:
    "润笔（DocuEarn）是一款面向公众号创作者的得力助手，帮助每一位普通人用文字挣到稳定的外快。"
};

export const SITE_CONFIG = {
  /** 当前站点自身域名 */
  SITE_BASE:
    (typeof location !== "undefined" && location.origin) ||
    "https://docuearn.com",

  /** Cloudflare Worker 的对外完整 URL；同时被 api.js 读取（meta 优先级更高） */
  WORKER_BASE: "https://api.docuearn.com",

  /** 支付链接占位（Paddle 接入后替换；变量名仍叫 LEMON_LINKS 避免大改 site.js） */
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
  SUPPORT_EMAIL: "hello@docuearn.com",

  /**
   * Google OAuth 2.0 Web Client ID
   * --------------------------------------------------------------
   * 在 https://console.cloud.google.com/apis/credentials 新建一个
   * "OAuth 2.0 Client ID" → 类型选 "Web application"，把当前域名
   * （如 https://docuearn.com）填到 "Authorized JavaScript origins"，
   * 拿到的 client id 形如 "1234567890-abc.apps.googleusercontent.com"。
   *
   * - 留空 → 登录页不显示 Google 按钮（对用户完全透明，老的邮箱密码登录不受影响）。
   * - 填入正确值 → 登录/注册页面显示 "使用 Google 继续" 按钮。
   *
   * 详细 step-by-step：见 docs/GOOGLE_OAUTH_SETUP.md
   */
  GOOGLE_CLIENT_ID: ""
};
