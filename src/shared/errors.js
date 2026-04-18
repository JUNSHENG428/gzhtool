/**
 * 统一错误码定义与分类函数。
 * background handler 的 catch 块通过 classifyError() 把原始 Error 转为结构化对象，
 * 返回 { code, message, retryable } 供前端展示。
 *
 * 分类策略：stage（上下文阶段）+ error 细节联合匹配。
 * stage 先锁定候选大类，error.message 再做细分，避免关键词交叉误判。
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
  [ErrorCode.UNKNOWN]:
    "操作失败，请稍后再试。"
};

/**
 * 合法的 stage 取值，每个 stage 映射到一组候选 ErrorCode。
 * classifyError 先通过 stage 缩小候选范围，再根据 error 细节做精确匹配。
 */
const STAGE_CANDIDATES = {
  "scrape":           [ErrorCode.SCRAPE_NO_CONTENT, ErrorCode.NETWORK_TIMEOUT],
  "rewrite":          [ErrorCode.API_AUTH_FAILED, ErrorCode.API_RATE_LIMITED, ErrorCode.API_BAD_RESPONSE, ErrorCode.NETWORK_TIMEOUT],
  "publish":          [ErrorCode.WECHAT_IP_NOT_WHITELISTED, ErrorCode.WECHAT_MEDIA_TOO_LARGE, ErrorCode.WECHAT_INVALID_SECRET, ErrorCode.IMAGE_DOWNLOAD_FAILED, ErrorCode.IMAGE_UPLOAD_FAILED, ErrorCode.NETWORK_TIMEOUT],
  "image-download":   [ErrorCode.IMAGE_DOWNLOAD_FAILED, ErrorCode.NETWORK_TIMEOUT],
  "image-upload":     [ErrorCode.IMAGE_UPLOAD_FAILED, ErrorCode.WECHAT_MEDIA_TOO_LARGE, ErrorCode.NETWORK_TIMEOUT],
  "sync-web-editor":  [ErrorCode.NETWORK_TIMEOUT],
  "test-ai":          [ErrorCode.API_AUTH_FAILED, ErrorCode.API_RATE_LIMITED, ErrorCode.API_BAD_RESPONSE, ErrorCode.NETWORK_TIMEOUT],
  "test-wechat":      [ErrorCode.WECHAT_IP_NOT_WHITELISTED, ErrorCode.WECHAT_INVALID_SECRET, ErrorCode.NETWORK_TIMEOUT]
};

/**
 * 将原始 Error 按上下文阶段(stage) + 错误特征联合分类为结构化错误对象。
 *
 * @param {Error}  error   - 原始异常
 * @param {{ stage?: string }} [context] - 上下文，stage 表示操作阶段
 * @returns {{ code: string, message: string, retryable: boolean }}
 */
export function classifyError(error, context) {
  const msg = String(error?.message || "").toLowerCase();
  const name = String(error?.name || "");
  const stage = context?.stage || "";

  // ── 第一轮：与 stage 无关的高优先级通用规则 ──

  // 网络超时 / 不可达 — 任何 stage 都需要最先识别
  if (
    name === "AbortError" ||
    /abort/i.test(msg) ||
    /timeout|timed?\s?out|超时/i.test(msg)
  ) {
    return make(ErrorCode.NETWORK_TIMEOUT, true);
  }
  if (/failed to fetch|networkerror|load failed|网络/i.test(msg) && !/下载|上传/i.test(msg)) {
    return make(ErrorCode.NETWORK_TIMEOUT, true);
  }

  // ── 第二轮：stage 限定的精确匹配 ──

  // --- image-download：直接锁定，无须判断关键字 ---
  if (stage === "image-download") {
    return make(ErrorCode.IMAGE_DOWNLOAD_FAILED, true);
  }

  // --- image-upload ---
  if (stage === "image-upload") {
    if (/media.*(size|大小)|file\s*size|素材.*(超|太大)|too\s*large/i.test(msg)) {
      return make(ErrorCode.WECHAT_MEDIA_TOO_LARGE, false);
    }
    return make(ErrorCode.IMAGE_UPLOAD_FAILED, true);
  }

  // --- scrape ---
  if (stage === "scrape") {
    if (/没有返回可用内容|没有找到可抓取|抓取失败|正文为空|no\s*content/i.test(msg)) {
      return make(ErrorCode.SCRAPE_NO_CONTENT, false);
    }
    // 抓取阶段的网络不可达在上方已匹配；其余统一归到 SCRAPE_NO_CONTENT
    return make(ErrorCode.SCRAPE_NO_CONTENT, false);
  }

  // --- rewrite / test-ai ---
  if (stage === "rewrite" || stage === "test-ai") {
    return classifyAiError(msg);
  }

  // --- publish ---
  if (stage === "publish") {
    return classifyPublishError(msg);
  }

  // --- test-wechat ---
  if (stage === "test-wechat") {
    return classifyWechatError(msg);
  }

  // --- sync-web-editor ---
  if (stage === "sync-web-editor") {
    // 同步到网页编辑器的错误比较单一，大多是通讯失败
    return make(ErrorCode.NETWORK_TIMEOUT, true);
  }

  // ── 第三轮：无 stage 时的纯关键字 Fallback（兼容旧代码） ──
  const fallback = classifyByKeywordOnly(msg);
  if (fallback) {
    return fallback;
  }

  // ── 未匹配：保留原始中文消息（如果有的话），否则用通用提示 ──
  return {
    code: ErrorCode.UNKNOWN,
    message: hasChinese(error?.message) ? error.message : USER_MESSAGES[ErrorCode.UNKNOWN],
    retryable: false
  };
}

// ── AI 相关子分类 ──

function classifyAiError(msg) {
  // HTTP status 识别
  if (/\b401\b|\b403\b/i.test(msg) || /密钥|api\s*key|auth|credential|invalid.*key/i.test(msg)) {
    return make(ErrorCode.API_AUTH_FAILED, false);
  }
  if (/\b429\b|rate.?limit|too many|频繁|额度/i.test(msg)) {
    return make(ErrorCode.API_RATE_LIMITED, true);
  }
  // 404 / 5xx → bad response
  if (/\b404\b|\b5\d{2}\b|bad.?response|服务.*不可用|接口.*返回.*错误|接口.*异常/i.test(msg)) {
    return make(ErrorCode.API_BAD_RESPONSE, true);
  }
  return make(ErrorCode.API_BAD_RESPONSE, true);
}

// ── 发布相关子分类 ──

function classifyPublishError(msg) {
  // 微信 IP 白名单
  if (/40164|ip\s*白名单|ip\s*whitelist|not\s*in\s*whitelist/i.test(msg)) {
    return make(ErrorCode.WECHAT_IP_NOT_WHITELISTED, false);
  }
  // 微信 AppID/AppSecret 无效
  if (/40013|40125|appsecret|invalid\s*secret/i.test(msg)) {
    return make(ErrorCode.WECHAT_INVALID_SECRET, false);
  }
  // 素材太大
  if (/media.*(size|大小)|file\s*size|素材.*(超|太大)|too\s*large/i.test(msg)) {
    return make(ErrorCode.WECHAT_MEDIA_TOO_LARGE, false);
  }
  // 图片上传失败（发布过程中的图片失败默认归 upload）
  if (/上传|upload/i.test(msg)) {
    return make(ErrorCode.IMAGE_UPLOAD_FAILED, true);
  }
  // 图片下载失败（发布流程中先下载再上传，需要根据关键字区分）
  if (/下载|download/i.test(msg)) {
    return make(ErrorCode.IMAGE_DOWNLOAD_FAILED, true);
  }
  // HTTP status
  if (/\b401\b|\b403\b/i.test(msg)) {
    return make(ErrorCode.WECHAT_INVALID_SECRET, false);
  }
  if (/\b429\b|rate.?limit/i.test(msg)) {
    return make(ErrorCode.API_RATE_LIMITED, true);
  }
  if (/\b404\b|\b5\d{2}\b/i.test(msg)) {
    return make(ErrorCode.API_BAD_RESPONSE, true);
  }
  return make(ErrorCode.UNKNOWN, true);
}

// ── 微信连接测试子分类 ──

function classifyWechatError(msg) {
  if (/40164|ip\s*白名单|ip\s*whitelist|not\s*in\s*whitelist/i.test(msg)) {
    return make(ErrorCode.WECHAT_IP_NOT_WHITELISTED, false);
  }
  if (/40013|40125|appid|appsecret|invalid\s*secret/i.test(msg)) {
    return make(ErrorCode.WECHAT_INVALID_SECRET, false);
  }
  return make(ErrorCode.WECHAT_INVALID_SECRET, false);
}

// ── 无 stage 的纯关键字 Fallback（兼容旧调用） ──

function classifyByKeywordOnly(msg) {
  if (/40164|ip\s*白名单/i.test(msg)) {
    return make(ErrorCode.WECHAT_IP_NOT_WHITELISTED, false);
  }
  if (/40013|40125|appsecret|invalid\s*secret/i.test(msg)) {
    return make(ErrorCode.WECHAT_INVALID_SECRET, false);
  }
  if (/media.*(size|大小)|too\s*large|素材.*(超|太大)/i.test(msg)) {
    return make(ErrorCode.WECHAT_MEDIA_TOO_LARGE, false);
  }
  // 注意：无 stage 时"下载"优先于"上传"，因为下载通常发生在上传之前
  if (/下载.*图片|download.*image|图片.*下载/i.test(msg)) {
    return make(ErrorCode.IMAGE_DOWNLOAD_FAILED, true);
  }
  if (/上传.*图片|upload.*image|图片.*上传|上传.*素材/i.test(msg)) {
    return make(ErrorCode.IMAGE_UPLOAD_FAILED, true);
  }
  if (/\b429\b|rate.?limit|too many|频繁|额度/i.test(msg)) {
    return make(ErrorCode.API_RATE_LIMITED, true);
  }
  if (/没有返回可用内容|抓取失败|正文为空|no\s*content/i.test(msg)) {
    return make(ErrorCode.SCRAPE_NO_CONTENT, false);
  }
  return null; // 不匹配 → 让上层走 UNKNOWN
}

// ── 内部工具 ──

function make(code, retryable) {
  return {
    code,
    message: USER_MESSAGES[code] || USER_MESSAGES[ErrorCode.UNKNOWN],
    retryable
  };
}

function hasChinese(text) {
  return typeof text === "string" && /[\u4e00-\u9fa5]/.test(text);
}

// ── 单元自测 ──
// 在 service-worker 环境中 import.meta 存在，但 import.meta.main 不会为 true，
// 因此这段只在直接运行该文件时执行（如 node --experimental-vm-modules 等）。

if (typeof globalThis.__RUN_ERROR_SELF_TEST__ !== "undefined") {
  (function runSelfTests() {
    const assert = (cond, label) => {
      if (!cond) throw new Error(`[SELF-TEST FAIL] ${label}`);
      console.log(`  ✅ ${label}`);
    };

    console.log("── errors.js 自测开始 ──");

    // Case 1: image-download stage 应正确归到 IMAGE_DOWNLOAD_FAILED，即使消息含 "fail"
    const r1 = classifyError(new Error("fetch image fail"), { stage: "image-download" });
    assert(r1.code === ErrorCode.IMAGE_DOWNLOAD_FAILED, "Case 1: image-download + 'fail' → IMAGE_DOWNLOAD_FAILED");

    // Case 2: image-upload stage 不应串到 IMAGE_DOWNLOAD_FAILED
    const r2 = classifyError(new Error("upload fail"), { stage: "image-upload" });
    assert(r2.code === ErrorCode.IMAGE_UPLOAD_FAILED, "Case 2: image-upload + 'fail' → IMAGE_UPLOAD_FAILED");

    // Case 3: 401 in rewrite stage → API_AUTH_FAILED
    const r3 = classifyError(new Error("AI 接口返回错误，状态码 401"), { stage: "rewrite" });
    assert(r3.code === ErrorCode.API_AUTH_FAILED, "Case 3: rewrite + 401 → API_AUTH_FAILED");

    // Case 4: 404 in rewrite stage → API_BAD_RESPONSE
    const r4 = classifyError(new Error("AI 接口返回错误，状态码 404"), { stage: "rewrite" });
    assert(r4.code === ErrorCode.API_BAD_RESPONSE, "Case 4: rewrite + 404 → API_BAD_RESPONSE");

    // Case 5: 429 in rewrite stage → API_RATE_LIMITED
    const r5 = classifyError(new Error("429 rate limit"), { stage: "rewrite" });
    assert(r5.code === ErrorCode.API_RATE_LIMITED, "Case 5: rewrite + 429 → API_RATE_LIMITED");

    // Case 6: publish stage with "下载" → IMAGE_DOWNLOAD_FAILED (不串到 UPLOAD)
    const r6 = classifyError(new Error("下载图片失败"), { stage: "publish" });
    assert(r6.code === ErrorCode.IMAGE_DOWNLOAD_FAILED, "Case 6: publish + '下载' → IMAGE_DOWNLOAD_FAILED");

    // Case 7: timeout 不分 stage
    const r7 = classifyError(new Error("request timed out"), { stage: "publish" });
    assert(r7.code === ErrorCode.NETWORK_TIMEOUT, "Case 7: timeout → NETWORK_TIMEOUT (any stage)");

    console.log("── errors.js 自测全部通过 ──");
  })();
}
