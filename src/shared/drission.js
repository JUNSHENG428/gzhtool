// ESM 注意：必须在顶部用 import-as-alias 创建一个本地绑定，
//   import { normalizeCaptureMode as normalizeDrissionCaptureMode } from "./utils.js";
// 老写法 `import { normalizeCaptureMode }` + `export { normalizeCaptureMode as normalizeDrissionCaptureMode }`
// 是 ESM 的 re-export 形式，**不会**在当前模块作用域里创建一个叫
// normalizeDrissionCaptureMode 的本地变量，导致下面任何函数体里直接调用
// 它都会抛 `ReferenceError: normalizeDrissionCaptureMode is not defined`。
// 这个 bug 只在用户「开启 DrissionPage 增强抓取」时才会被触发，所以
// 默认配置的回归测试一直没暴露——参见 scripts/smoke.mjs 里的对应单测。
import { normalizeCaptureMode as normalizeDrissionCaptureMode } from "./utils.js";

const DEFAULT_TIMEOUT_MS = 30000;
// 与 desktop/helper_app/server.py 的 HELPER_TOKEN_HEADER 保持一致
export const HELPER_TOKEN_HEADER = "X-Runbi-Helper-Token";

export { normalizeDrissionCaptureMode };

/**
 * 把用户粘贴的 helper 地址拆成 { url, token }。
 * 兼容 3 种粘贴形式：
 *   1. http://127.0.0.1:7788/             （老格式，无 token）
 *   2. http://127.0.0.1:7788/?token=abc   （GUI 复制按钮的新格式）
 *   3. 127.0.0.1:7788                     （省略协议）
 *
 * 拆 token 的目的：避免把 token 当成 URL 一部分发出去（fetch path 里带 ?token
 * 在某些场景会被代理日志记录），统一通过 X-Runbi-Helper-Token header 传输。
 *
 * 解析失败返回 { url: "", token: "" }。
 */
export function parseDrissionHelperInput(value) {
  let raw = String(value || "").trim();
  if (!raw) {
    return { url: "", token: "" };
  }

  if (!/^[a-z]+:\/\//i.test(raw)) {
    raw = `http://${raw}`;
  }

  let url;
  try {
    url = new URL(raw);
  } catch {
    return { url: "", token: "" };
  }

  let token = "";
  // 同时兼容 token / auth_token 两种 query 名称（与 helper handler 一致）
  for (const key of ["token", "auth_token"]) {
    const value = url.searchParams.get(key);
    if (value && !token) {
      token = value.trim();
    }
    url.searchParams.delete(key);
  }

  url.hash = "";
  if (!url.pathname || url.pathname === "/") {
    url.pathname = "/";
  } else {
    url.pathname = url.pathname.replace(/\/+$/, "") + "/";
  }

  return { url: url.toString(), token };
}

export function normalizeDrissionHelperUrl(value) {
  return parseDrissionHelperInput(value).url;
}

export function normalizeDrissionHelperToken(value) {
  const raw = String(value || "").trim();
  // token 只允许 base32/hex 风格的字符；防止粘贴时夹带了空格 / 引号 / 中文标点
  if (!/^[A-Za-z0-9._\-]+$/.test(raw)) {
    return "";
  }
  return raw;
}

function buildAuthHeaders(token) {
  const safe = normalizeDrissionHelperToken(token);
  return safe ? { [HELPER_TOKEN_HEADER]: safe } : {};
}

export function normalizeDrissionTimeoutMs(value, fallback = DEFAULT_TIMEOUT_MS) {
  const n = Number(value);
  if (!Number.isFinite(n)) {
    return fallback;
  }
  return Math.max(5000, Math.min(Math.round(n), 120000));
}

export function canUseDrissionCapture(settings, captureMode = "readable") {
  return Boolean(settings?.drissionEnabled) &&
    Boolean(normalizeDrissionHelperUrl(settings?.drissionHelperUrl)) &&
    normalizeDrissionCaptureMode(captureMode) !== "selection";
}

export async function testDrissionConnection(payload = {}) {
  // 同时支持「URL 与 token 分开传」和「直接传含 ?token= 的整段地址」
  const parsed = parseDrissionHelperInput(payload.helperUrl || payload.drissionHelperUrl);
  const baseUrl = parsed.url;
  const token = normalizeDrissionHelperToken(payload.helperToken || payload.drissionHelperToken || parsed.token);
  const timeoutMs = normalizeDrissionTimeoutMs(payload.timeoutMs ?? payload.drissionTimeoutMs);

  if (!baseUrl) {
    return createFailure("请先填写本地 DrissionPage helper 地址。");
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const startedAt = Date.now();

  try {
    const response = await fetch(buildDrissionEndpoint(baseUrl, "health"), {
      method: "GET",
      headers: buildAuthHeaders(token),
      signal: controller.signal
    });
    const latencyMs = Date.now() - startedAt;
    const payload = await response.json().catch(() => ({}));

    if (!response.ok || payload?.ok === false) {
      return createFailure(
        mapDrissionHttpError(response.status, payload),
        latencyMs,
        payload?.drissionVersion || "",
        String(payload?.errorCode || "")
      );
    }

    // helper 已经开了 token 鉴权但用户连接里没 token：在 health 阶段提前给提示
    if (payload?.requireToken && !token) {
      return createFailure(
        "本地 helper 已开启 token 鉴权。请到桌面助手 GUI 点「复制 helper 地址」，再粘贴回这里。",
        latencyMs,
        payload?.drissionVersion || "",
        "MISSING_TOKEN"
      );
    }

    return {
      ok: true,
      latencyMs,
      helperVersion: payload?.helperVersion || "",
      drissionVersion: payload?.drissionVersion || "",
      browserMode: payload?.browserMode || "",
      requireToken: Boolean(payload?.requireToken),
      allowPrivateHosts: Boolean(payload?.allowPrivateHosts),
      tokenConfigured: Boolean(token),
      supportedErrorCodes: Array.isArray(payload?.errorCodes) ? payload.errorCodes : [],
      errorCode: "",
      error: ""
    };
  } catch (error) {
    return createFailure(mapDrissionRuntimeError(error), Date.now() - startedAt);
  } finally {
    clearTimeout(timer);
  }
}

export async function requestDrissionCapture(settings, payload = {}) {
  const parsed = parseDrissionHelperInput(settings?.drissionHelperUrl);
  const baseUrl = parsed.url;
  // settings.drissionHelperToken 优先；如果用户只贴了带 ?token=… 的整段 URL，
  // 拆出来的 token 也能兜底（兼容用户没在 options.js 里走 saveSettings 的边角场景）
  const token = normalizeDrissionHelperToken(settings?.drissionHelperToken || parsed.token);
  const timeoutMs = normalizeDrissionTimeoutMs(payload.timeoutMs ?? settings?.drissionTimeoutMs);
  const targetUrl = String(payload.url || "").trim();
  const captureMode = normalizeDrissionCaptureMode(payload.captureMode);

  if (!baseUrl) {
    throw new Error("本地 DrissionPage helper 地址为空，请先到设置页填写。");
  }
  if (!/^https?:\/\//i.test(targetUrl)) {
    throw new Error("DrissionPage 增强抓取只支持 http/https 网页。");
  }
  if (captureMode === "selection") {
    throw new Error("DrissionPage 增强抓取不支持“抓取选中文字”，该模式会自动使用扩展内置抓取。");
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(buildDrissionEndpoint(baseUrl, "scrape"), {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...buildAuthHeaders(token)
      },
      body: JSON.stringify({
        url: targetUrl,
        captureMode,
        timeoutMs,
        sourceTitle: String(payload.sourceTitle || "")
      }),
      signal: controller.signal
    });

    const parsed = await response.json().catch(() => ({}));
    if (!response.ok || parsed?.ok === false) {
      const code = String(parsed?.errorCode || "");
      const err = new Error(mapDrissionHttpError(response.status, parsed));
      err.helperErrorCode = code;
      err.helperHttpStatus = response.status;
      throw err;
    }

    const capture = parsed?.data;
    if (!capture || !Array.isArray(capture.blocks) || capture.blocks.length === 0) {
      const err = new Error(
        HELPER_ERROR_HINTS.SCRAPE_EMPTY
          || "DrissionPage 返回为空，请确认页面可公开访问且正文已经加载完成。"
      );
      err.helperErrorCode = "SCRAPE_EMPTY";
      throw err;
    }

    capture.captureEngine = "drissionpage";
    capture.captureEngineLabel = "DrissionPage 增强抓取";
    capture.captureMode = captureMode;
    capture.captureLatencyMs = Number(parsed?.latencyMs || 0);
    return capture;
  } catch (error) {
    // 保留 helperErrorCode：上层 try/catch 仍能根据 code 做差异化提示。
    if (error?.helperErrorCode) throw error;
    const wrapped = new Error(mapDrissionRuntimeError(error));
    wrapped.helperErrorCode = error?.name === "AbortError" ? "SCRAPE_TIMEOUT" : "";
    throw wrapped;
  } finally {
    clearTimeout(timer);
  }
}

function buildDrissionEndpoint(baseUrl, pathName) {
  return new URL(pathName, baseUrl).toString();
}

function createFailure(error, latencyMs = 0, drissionVersion = "", errorCode = "") {
  return {
    ok: false,
    latencyMs,
    helperVersion: "",
    drissionVersion,
    browserMode: "",
    errorCode,
    error
  };
}

// 与 desktop/helper_app/server.py 的 SUPPORTED_ERROR_CODES 对应。
// 每个 code 对应一个面向用户的兜底文案，server 返回的 message 优先；message 缺失时
// 用这里的默认文案，避免「Internal Server Error」这种没法行动的提示。
const HELPER_ERROR_HINTS = {
  MISSING_TOKEN:
    "本地 helper 已开启 token 鉴权但请求里没带 token。请到桌面助手 GUI 重新复制 helper 地址，再粘到扩展设置页。",
  INVALID_TOKEN:
    "helper token 不匹配，可能已被重置。请到桌面助手 GUI 重新复制 helper 地址，再粘到扩展设置页。",
  PRIVATE_HOST_BLOCKED:
    "目标地址属于本机/内网/保留段，已被 helper 默认拦截。如需放开请用 --allow-private-hosts 启动。",
  INVALID_REQUEST: "请求参数不完整，请检查 helper 地址和目标网址。",
  INVALID_JSON: "helper 收到的请求体不是合法 JSON，请重启扩展再试。",
  NOT_FOUND: "helper 地址不对，请确认填写的是服务根地址，而不是某个不存在的接口路径。",
  INTERNAL_ERROR: "本地 DrissionPage helper 执行失败，请打开桌面助手「一键自检」查看日志。",
  DRISSION_NOT_AVAILABLE:
    "本地 helper 未安装 DrissionPage 库，请在桌面助手运行 `pip install DrissionPage` 后重启。",
  BROWSER_LAUNCH_FAILED:
    "本地 helper 启动 Chrome 失败，请确认已安装 Chrome 并允许 DrissionPage 调用，或在桌面助手「一键自检」里查看具体路径。",
  SCRAPE_FAILED: "本地 helper 在抓取脚本注入阶段失败，请稍后重试或更换抓取模式。",
  SCRAPE_EMPTY:
    "本地 helper 没拿到正文内容，可能页面需要登录、有反爬或加载较慢。可在桌面助手 GUI 把模式切到 selection 后重试。",
  SCRAPE_TIMEOUT: "本地 DrissionPage helper 抓取超时，请稍后再试或调大超时时间。",
  LOGIN_REQUIRED: "目标页面需要登录，请先在 helper 浏览器里登录后再抓。"
};

function helperHint(code, message) {
  if (message) return message;
  return HELPER_ERROR_HINTS[code] || "";
}

function mapDrissionHttpError(status, payload) {
  const message = String(payload?.error || payload?.message || "").trim();
  const code = String(payload?.errorCode || "").trim();

  // 401 / 403 / 404 / 504 这些状态码本身就有明确语义，先按 status 兜底；
  // 同时优先用 errorCode 给出针对性提示，server message 优先级最高。
  if (status === 401) {
    return helperHint(code, message)
      || "本地 helper 拒绝了未鉴权的请求。请到设置页重新粘贴含 token 的 helper 地址。";
  }
  if (status === 403) {
    return helperHint(code, message) || "本地 helper 拒绝了这次请求。";
  }
  if (status === 400) {
    return helperHint(code, message) || "请求参数不完整，请检查 helper 地址和目标网址。";
  }
  if (status === 404) {
    return helperHint(code, message)
      || "helper 地址不对，请确认填写的是服务根地址，而不是不存在的接口路径。";
  }
  if (status === 408 || status === 504) {
    return helperHint(code, message)
      || "本地 DrissionPage helper 响应超时，请稍后再试或调大超时时间。";
  }
  if (status >= 500) {
    return helperHint(code, message)
      || "本地 DrissionPage helper 执行失败，请打开桌面助手「一键自检」查看日志。";
  }
  return helperHint(code, message) || `本地 DrissionPage helper 返回错误（${status}）。`;
}

export { HELPER_ERROR_HINTS };

function mapDrissionRuntimeError(error) {
  const message = String(error?.message || "");

  if (error?.name === "AbortError") {
    return "本地 DrissionPage helper 连接超时，请确认服务正在运行并且浏览器能正常打开页面。";
  }
  if (/helper 地址不对|本地 drissionpage helper/i.test(message)) {
    return message;
  }
  if (/invalid url/i.test(message)) {
    return "本地 DrissionPage helper 地址格式不正确。";
  }
  if (/failed to fetch|networkerror|load failed/i.test(message)) {
    return "本地 DrissionPage helper 不可达，请确认已启动服务，并检查设置里的地址和端口。";
  }
  return message || "DrissionPage 增强抓取失败，请检查本地 helper 状态。";
}
