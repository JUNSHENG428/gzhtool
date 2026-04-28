/**
 * AI 服务商预设清单。
 *
 * 所有预设都按 OpenAI Chat Completions 协议透传 —— `requestRewrite` /
 * `runHumanizePass` / `topic-planner` 共用一份 fetcher，预设只负责把 baseUrl 与
 * 推荐模型清单填好，避免新手去翻每家文档抄 endpoint。
 *
 * 新加服务商只需要：
 *   1. 在下方 PROVIDER_PRESETS 数组里追加一项；
 *   2. 如果该家走原生协议（如 Anthropic /v1/messages、Gemini /generateContent），
 *      暂时不能在这里加 —— 先在 ai.js 做协议适配再回来登记。
 */

export const PROVIDER_PRESETS = [
  {
    key: "openai",
    name: "OpenAI",
    baseUrl: "https://api.openai.com/v1/chat/completions",
    models: [
      { id: "gpt-4.1-mini", label: "gpt-4.1-mini（性价比首选）" },
      { id: "gpt-4o-mini", label: "gpt-4o-mini" },
      { id: "gpt-4.1", label: "gpt-4.1（更强但更贵）" },
      { id: "gpt-4o", label: "gpt-4o" }
    ],
    apiKeyUrl: "https://platform.openai.com/api-keys",
    apiKeyHint: "去 OpenAI 后台生成，sk- 开头。需要美国信用卡，国内卡多数被拒。"
  },
  {
    key: "openrouter",
    name: "OpenRouter（聚合多家模型）",
    baseUrl: "https://openrouter.ai/api/v1/chat/completions",
    models: [
      { id: "openai/gpt-4o-mini", label: "openai/gpt-4o-mini" },
      { id: "anthropic/claude-3.5-sonnet", label: "anthropic/claude-3.5-sonnet" },
      { id: "deepseek/deepseek-chat", label: "deepseek/deepseek-chat" },
      { id: "google/gemini-2.0-flash-001", label: "google/gemini-2.0-flash-001" }
    ],
    apiKeyUrl: "https://openrouter.ai/keys",
    apiKeyHint: "OpenRouter 支持国内信用卡和 Apple Pay，一个 key 用所有家模型。"
  },
  {
    key: "deepseek",
    name: "DeepSeek（深度求索）",
    baseUrl: "https://api.deepseek.com/v1/chat/completions",
    // 2026-04 起 deepseek-v4-flash / deepseek-v4-pro 是新名，
    // 旧的 deepseek-chat / deepseek-reasoner 将在 2026-07-24 弃用 —— 把 v4 放前面，
    // 旧名留作兼容备选给还没迁移的代理网关。
    models: [
      { id: "deepseek-v4-flash", label: "deepseek-v4-flash（快、便宜，新名）" },
      { id: "deepseek-v4-pro", label: "deepseek-v4-pro（强，新名）" },
      { id: "deepseek-chat", label: "deepseek-chat（旧名，2026-07-24 弃用）" },
      { id: "deepseek-reasoner", label: "deepseek-reasoner（旧名，思维链）" }
    ],
    apiKeyUrl: "https://platform.deepseek.com/api_keys",
    apiKeyHint: "国内便宜首选，官网直接支付宝充值。"
  },
  {
    key: "kimi",
    name: "月之暗面 Kimi（Moonshot）",
    baseUrl: "https://api.moonshot.cn/v1/chat/completions",
    models: [
      { id: "kimi-k2.6", label: "kimi-k2.6（最新主力）" },
      { id: "moonshot-v1-8k", label: "moonshot-v1-8k" },
      { id: "moonshot-v1-32k", label: "moonshot-v1-32k" },
      { id: "moonshot-v1-128k", label: "moonshot-v1-128k（长文）" }
    ],
    apiKeyUrl: "https://platform.moonshot.cn/console/api-keys",
    apiKeyHint: "Moonshot 开放平台申请，中文长文本表现强。"
  },
  {
    key: "qwen",
    name: "通义千问 Qwen（阿里 DashScope）",
    // DashScope 的 OpenAI 兼容模式，端点是 /compatible-mode/v1/chat/completions。
    // 用原生 /v1/services/aigc/text-generation/generation 不兼容 OpenAI 格式，不要混。
    baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions",
    models: [
      { id: "qwen-plus", label: "qwen-plus（性价比）" },
      { id: "qwen-turbo", label: "qwen-turbo（最便宜）" },
      { id: "qwen-max", label: "qwen-max（旗舰）" },
      { id: "qwen3-32b", label: "qwen3-32b" },
      { id: "qwen3-235b-a22b", label: "qwen3-235b-a22b（最强）" }
    ],
    apiKeyUrl: "https://bailian.console.aliyun.com/?apiKey=1",
    apiKeyHint: "阿里云百炼控制台领 key，新用户有免费额度。"
  },
  {
    key: "minimax",
    name: "MiniMax（海螺）",
    // MiniMax 的 OpenAI 兼容端点不在标准 /v1/chat/completions 路径下。
    baseUrl: "https://api.minimax.chat/v1/text/chatcompletion_v2",
    models: [
      { id: "abab6.5s-chat", label: "abab6.5s-chat（快速）" },
      { id: "abab6.5-chat", label: "abab6.5-chat" },
      { id: "MiniMax-Text-01", label: "MiniMax-Text-01（旗舰）" }
    ],
    apiKeyUrl:
      "https://platform.minimaxi.com/user-center/basic-information/interface-key",
    apiKeyHint: "MiniMax 开放平台领 key，注意填的是「接口密钥」不是「Group ID」。"
  },
  {
    key: "zhipu",
    name: "智谱 GLM",
    baseUrl: "https://open.bigmodel.cn/api/paas/v4/chat/completions",
    models: [
      { id: "glm-4-flash", label: "glm-4-flash（免费档位）" },
      { id: "glm-4-plus", label: "glm-4-plus（旗舰）" },
      { id: "glm-4-air", label: "glm-4-air" },
      { id: "glm-4-long", label: "glm-4-long（长文）" }
    ],
    apiKeyUrl: "https://bigmodel.cn/usercenter/apikeys",
    apiKeyHint: "智谱开放平台领 key，glm-4-flash 当前免费可白嫖。"
  },
  {
    key: "custom",
    name: "自定义 / OpenAI 兼容",
    baseUrl: "",
    models: [],
    apiKeyUrl: "",
    apiKeyHint:
      "任何兼容 OpenAI chat completions 协议的服务都可以填（自部署 vLLM、Ollama、Azure、第三方代理等）。"
  }
];

export const DEFAULT_PROVIDER_KEY = "openai";
export const CUSTOM_PROVIDER_KEY = "custom";

function normalizeBaseUrl(value) {
  const raw = String(value || "").trim();
  if (!raw) return "";
  try {
    const url = new URL(raw);
    // 标准化：去 trailing slash，host 全小写；保留 path/query 让多版本端点能区分
    // （如 dashscope 的 compatible-mode 与原生 services 路径）。
    const host = url.host.toLowerCase();
    let path = url.pathname.replace(/\/+$/, "");
    return `${url.protocol}//${host}${path}${url.search}`;
  } catch {
    return raw.toLowerCase().replace(/\/+$/, "");
  }
}

export function findProviderByBaseUrl(baseUrl) {
  const target = normalizeBaseUrl(baseUrl);
  if (!target) return null;
  return (
    PROVIDER_PRESETS.find(
      (p) => p.key !== CUSTOM_PROVIDER_KEY && normalizeBaseUrl(p.baseUrl) === target
    ) || null
  );
}

export function getProviderByKey(key) {
  return PROVIDER_PRESETS.find((p) => p.key === key) || null;
}
