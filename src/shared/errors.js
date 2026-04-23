/**
 * 统一错误码定义与分类函数。
 * background handler 的 catch 块通过 classifyError() 把原始 Error 转为结构化对象，
 * 返回 { code, message, retryable } 供前端展示。
 */

export const ErrorCode = Object.freeze({
  NETWORK_TIMEOUT: "NETWORK_TIMEOUT",
  API_AUTH_FAILED: "API_AUTH_FAILED",
  API_RATE_LIMITED: "API_RATE_LIMITED",
  API_BAD_RESPONSE: "API_BAD_RESPONSE",
  WECHAT_IP_NOT_WHITELISTED: "WECHAT_IP_NOT_WHITELISTED",
  WECHAT_MEDIA_TOO_LARGE: "WECHAT_MEDIA_TOO_LARGE",
  WECHAT_INVALID_SECRET: "WECHAT_INVALID_SECRET",
  IMAGE_DOWNLOAD_FAILED: "IMAGE_DOWNLOAD_FAILED",
  IMAGE_UPLOAD_FAILED: "IMAGE_UPLOAD_FAILED",
  SCRAPE_NO_CONTENT: "SCRAPE_NO_CONTENT",
  SCRAPE_HOST_BLOCKED: "SCRAPE_HOST_BLOCKED",
  SCRAPE_TAB_FAILED: "SCRAPE_TAB_FAILED",
  UNKNOWN: "UNKNOWN"
});

/**
 * 每种错误码对应的中文用户提示。
 * 前端直接展示 message，不再让用户看到底层英文报错。
 */
const USER_MESSAGES = {
  [ErrorCode.NETWORK_TIMEOUT]:
    "网络请求超时，请检查网络连接后重试。",
  [ErrorCode.API_AUTH_FAILED]:
    "AI 接口认证失败，请检查设置页的 API Key 是否正确。",
  [ErrorCode.API_RATE_LIMITED]:
    "请求过于频繁或账户额度不足，请稍后再试。",
  [ErrorCode.API_BAD_RESPONSE]:
    "AI 接口返回异常，请检查接口地址和模型名称是否正确。",
  [ErrorCode.WECHAT_IP_NOT_WHITELISTED]:
    "公众号后台开启了 IP 白名单限制，请把当前出口 IP 加入公众号「开发 → 基本配置 → IP 白名单」。",
  [ErrorCode.WECHAT_MEDIA_TOO_LARGE]:
    "素材文件超过公众号大小限制，请压缩图片后再试。",
  [ErrorCode.WECHAT_INVALID_SECRET]:
    "公众号 AppID 或 AppSecret 无效，请检查设置页的凭证信息。",
  [ErrorCode.IMAGE_DOWNLOAD_FAILED]:
    "图片下载失败，原站可能设置了防盗链或图片链接已失效。",
  [ErrorCode.IMAGE_UPLOAD_FAILED]:
    "图片上传到公众号失败，请确认图片格式（JPG/PNG）和大小符合要求。",
  [ErrorCode.SCRAPE_NO_CONTENT]:
    "没有抓取到有效内容，请确认页面已完全加载且不需要登录。",
  [ErrorCode.SCRAPE_HOST_BLOCKED]:
    "扩展无法访问该网站（可能是浏览器内部页、扩展页，或站点用了 file://、chrome:// 协议）。请换一条原文链接试试。",
  [ErrorCode.SCRAPE_TAB_FAILED]:
    "后台抓取标签页时出错，可能是页面跳转被中断或被反爬关闭。请打开原文后用扩展面板手动抓取。",
  [ErrorCode.UNKNOWN]:
    "操作失败，请稍后再试。"
};

/**
 * 将原始 Error 按上下文分类为结构化错误对象。
 *
 * @param {Error}  error   - 原始异常
 * @param {string} [context] - 上下文提示："ai" | "wechat" | "scrape" | "image" | 其他
 * @returns {{ code: string, message: string, retryable: boolean }}
 */
export function classifyError(error, context) {
  const rawMessage = String(error?.message || "").trim();
  const msg = rawMessage.toLowerCase();
  const name = String(error?.name || "");

  // ── Chrome 扩展系统报错（host 权限不够 / 不能在内部页执行脚本）──
  // 典型："Cannot access contents of url 'chrome://...'. Extension manifest must request permission..."
  //       "Cannot access a chrome:// URL"
  //       "The extensions gallery cannot be scripted."
  if (
    /cannot access (?:contents of url|a chrome|the page|the extensions)/i.test(rawMessage) ||
    /extension manifest must request permission/i.test(rawMessage) ||
    /cannot be scripted/i.test(rawMessage) ||
    /this page cannot be scripted/i.test(rawMessage)
  ) {
    return make(ErrorCode.SCRAPE_HOST_BLOCKED, false);
  }

  // ── Chrome tabs/scripting 的常见运行时错误（标签页关掉、跨域脚本注入失败、SW 被回收等）──
  // 典型："No tab with id"、"The tab was closed."、"Frame with ID 0 was removed."
  //       "An unexpected error occurred"
  if (
    /no tab with id|tab was closed|frame .*was removed|frame .*not found/i.test(rawMessage) ||
    /could not establish connection|receiving end does not exist/i.test(rawMessage)
  ) {
    return makeWithDetail(
      ErrorCode.SCRAPE_TAB_FAILED,
      false,
      rawMessage
    );
  }

  // ── 网络超时 ──
  if (
    name === "AbortError" ||
    /abort/i.test(msg) ||
    /timeout|timed?\s?out|超时/i.test(msg)
  ) {
    return make(ErrorCode.NETWORK_TIMEOUT, true);
  }

  // ── 通用网络不可达 ──
  if (/failed to fetch|networkerror|load failed|网络/i.test(msg) && !/下载|上传/i.test(msg)) {
    return make(ErrorCode.NETWORK_TIMEOUT, true);
  }

  // ── 微信 IP 白名单（errcode 40164）──
  if (/40164|ip\s*白名单|ip\s*whitelist|not\s*in\s*whitelist/i.test(msg)) {
    return make(ErrorCode.WECHAT_IP_NOT_WHITELISTED, false);
  }

  // ── 微信 AppID/AppSecret 无效（errcode 40013 / 40125）──
  if (/40013|40125|appid|appsecret|invalid\s*secret/i.test(msg) && /公众号|微信|wechat/i.test(msg + (context || ""))) {
    return make(ErrorCode.WECHAT_INVALID_SECRET, false);
  }

  // ── 微信素材太大 ──
  if (/media.*(size|大小)|file\s*size|素材.*(超|太大)|too\s*large/i.test(msg)) {
    return make(ErrorCode.WECHAT_MEDIA_TOO_LARGE, false);
  }

  // ── 图片下载失败 ──
  if (/下载图片|download.*image|download.*fail|图片.*失败.*下载/i.test(msg)) {
    return make(ErrorCode.IMAGE_DOWNLOAD_FAILED, true);
  }

  // ── 图片上传失败 ──
  if (/上传.*图片|上传.*素材|upload.*(image|media|fail)|图片.*上传/i.test(msg)) {
    return make(ErrorCode.IMAGE_UPLOAD_FAILED, true);
  }

  // ── AI 认证失败 ──
  if (/密钥|api\s*key|auth|401|403|credential|invalid.*key/i.test(msg) && context === "ai") {
    return make(ErrorCode.API_AUTH_FAILED, false);
  }

  // ── AI 限流 ──
  if (/429|rate.?limit|too many|频繁|额度/i.test(msg)) {
    return make(ErrorCode.API_RATE_LIMITED, true);
  }

  // ── AI 接口异常 ──
  if (/5\d{2}|bad.?response|服务.*不可用|接口.*返回.*错误|接口.*异常/i.test(msg) && context === "ai") {
    return make(ErrorCode.API_BAD_RESPONSE, true);
  }

  // ── 抓取无内容 ──
  if (
    /没有返回可用内容|没有找到可抓取|抓取失败|正文为空|no\s*content/i.test(msg)
  ) {
    return make(ErrorCode.SCRAPE_NO_CONTENT, false);
  }

  // ── 未匹配 ──
  // 旧版逻辑：英文错误一律塞 fallback "操作失败，请稍后再试"，等于把底层
  // 报错信息全部吞掉，用户和开发者都没法定位（典型坑：service-worker 抛
  // chrome.scripting.executeScript 的英文错，前端只看到通用 fallback）。
  //
  // 新版策略：
  //   - 中文错误 → 直接透传（已经够友好了）
  //   - 英文错误且有内容 → 加中文前缀包装，让用户至少能看到底层细节
  //                       （比纯通用 fallback 强一万倍，复制给客服也能定位）
  //   - 完全没 message → 用通用 fallback
  if (!rawMessage) {
    return make(ErrorCode.UNKNOWN, false);
  }
  if (hasChinese(rawMessage)) {
    return {
      code: ErrorCode.UNKNOWN,
      message: rawMessage,
      retryable: false
    };
  }
  return {
    code: ErrorCode.UNKNOWN,
    // 把英文报错截短显示，避免单条 toast 过长
    message: `操作失败：${truncate(rawMessage, 200)}`,
    retryable: false
  };
}

// ── 内部工具 ──

function make(code, retryable) {
  return {
    code,
    message: USER_MESSAGES[code] || USER_MESSAGES[ErrorCode.UNKNOWN],
    retryable
  };
}

/**
 * 同 make，但把原始底层报错附在用户提示后面，方便用户/客服定位。
 * 用于"能给出友好提示但又想保留 raw error"的情况，比如标签页跨域注入失败：
 *   "后台抓取标签页时出错... · No tab with id 1234"
 */
function makeWithDetail(code, retryable, rawDetail) {
  const base = USER_MESSAGES[code] || USER_MESSAGES[ErrorCode.UNKNOWN];
  const detail = truncate(String(rawDetail || "").trim(), 160);
  return {
    code,
    message: detail ? `${base} · ${detail}` : base,
    retryable
  };
}

function truncate(text, max) {
  if (!text) return "";
  if (text.length <= max) return text;
  return text.slice(0, max - 1) + "…";
}

function hasChinese(text) {
  return typeof text === "string" && /[\u4e00-\u9fa5]/.test(text);
}
