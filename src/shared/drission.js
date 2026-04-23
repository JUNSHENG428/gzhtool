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

export { normalizeDrissionCaptureMode };

export function normalizeDrissionHelperUrl(value) {
  let raw = String(value || "").trim();
  if (!raw) {
    return "";
  }

  if (!/^[a-z]+:\/\//i.test(raw)) {
    raw = `http://${raw}`;
  }

  try {
    const url = new URL(raw);
    url.hash = "";
    if (!url.pathname || url.pathname === "/") {
      url.pathname = "/";
    } else {
      url.pathname = url.pathname.replace(/\/+$/, "") + "/";
    }
    return url.toString();
  } catch {
    return "";
  }
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
  const baseUrl = normalizeDrissionHelperUrl(payload.helperUrl || payload.drissionHelperUrl);
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
      signal: controller.signal
    });
    const latencyMs = Date.now() - startedAt;
    const payload = await response.json().catch(() => ({}));

    if (!response.ok || payload?.ok === false) {
      return createFailure(
        mapDrissionHttpError(response.status, payload),
        latencyMs,
        payload?.drissionVersion || ""
      );
    }

    return {
      ok: true,
      latencyMs,
      helperVersion: payload?.helperVersion || "",
      drissionVersion: payload?.drissionVersion || "",
      browserMode: payload?.browserMode || "",
      error: ""
    };
  } catch (error) {
    return createFailure(mapDrissionRuntimeError(error), Date.now() - startedAt);
  } finally {
    clearTimeout(timer);
  }
}

export async function requestDrissionCapture(settings, payload = {}) {
  const baseUrl = normalizeDrissionHelperUrl(settings?.drissionHelperUrl);
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
    throw new Error("DrissionPage 增强抓取不支持“只抓选中文字”，该模式会自动使用扩展内置抓取。");
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(buildDrissionEndpoint(baseUrl, "scrape"), {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
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
      throw new Error(mapDrissionHttpError(response.status, parsed));
    }

    const capture = parsed?.data;
    if (!capture || !Array.isArray(capture.blocks) || capture.blocks.length === 0) {
      throw new Error("DrissionPage 返回为空，请确认页面可公开访问且正文已经加载完成。");
    }

    capture.captureEngine = "drissionpage";
    capture.captureEngineLabel = "DrissionPage 增强抓取";
    capture.captureMode = captureMode;
    capture.captureLatencyMs = Number(parsed?.latencyMs || 0);
    return capture;
  } catch (error) {
    throw new Error(mapDrissionRuntimeError(error));
  } finally {
    clearTimeout(timer);
  }
}

function buildDrissionEndpoint(baseUrl, pathName) {
  return new URL(pathName, baseUrl).toString();
}

function createFailure(error, latencyMs = 0, drissionVersion = "") {
  return {
    ok: false,
    latencyMs,
    helperVersion: "",
    drissionVersion,
    browserMode: "",
    error
  };
}

function mapDrissionHttpError(status, payload) {
  const message = String(payload?.error || payload?.message || "").trim();
  if (status === 400) {
    return message || "请求参数不完整，请检查 helper 地址和目标网址。";
  }
  if (status === 404) {
    return "helper 地址不对，请确认填写的是服务根地址，而不是不存在的接口路径。";
  }
  if (status === 408 || status === 504) {
    return "本地 DrissionPage helper 响应超时，请稍后再试。";
  }
  if (status >= 500) {
    return message || "本地 DrissionPage helper 执行失败，请检查终端日志。";
  }
  return message || `本地 DrissionPage helper 返回错误（${status}）。`;
}

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
