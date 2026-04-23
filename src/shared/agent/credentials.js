/**
 * Agent 凭据托管：完全基于浏览器自身 cookie，不存账号密码、不模拟登录。
 *
 * 设计要点：
 *   1. 只通过 chrome.cookies API 检测「关键 cookie 是否存在」，不读取 value
 *   2. 缺登录时给出登录 URL，由前端引导用户开新 tab 自己登录
 *   3. 隐藏 tab 抓取时浏览器会自动带 cookie，不需要手工注入 header
 */

export const PLATFORM_COOKIE_RULES = Object.freeze({
  xhs: {
    id: "xhs",
    name: "小红书",
    homeUrl: "https://www.xiaohongshu.com/explore",
    loginUrl: "https://www.xiaohongshu.com/explore",
    domains: ["xiaohongshu.com", ".xiaohongshu.com", ".www.xiaohongshu.com"],
    // 至少满足一组才认为已登录
    requiredAny: [["web_session"], ["webId", "xsecappid"]]
  },
  x: {
    id: "x",
    name: "X (Twitter)",
    homeUrl: "https://x.com/home",
    loginUrl: "https://x.com/i/flow/login",
    domains: [".x.com", "x.com", ".twitter.com", "twitter.com"],
    requiredAny: [["auth_token"], ["ct0"]]
  },
  reddit: {
    id: "reddit",
    name: "Reddit",
    homeUrl: "https://www.reddit.com/",
    loginUrl: "https://www.reddit.com/login/",
    domains: [".reddit.com", "reddit.com"],
    requiredAny: [["reddit_session"], ["token_v2"], ["edgebucket"]]
  },
  zhihu: {
    id: "zhihu",
    name: "知乎",
    homeUrl: "https://www.zhihu.com",
    loginUrl: "https://www.zhihu.com/signin",
    domains: [".zhihu.com", "zhihu.com"],
    requiredAny: [["z_c0"], ["_zap", "d_c0"]]
  }
});

export const PLATFORM_IDS = Object.freeze(Object.keys(PLATFORM_COOKIE_RULES));

/**
 * 读取一个域下所有 cookie 名（不读 value），用于判断关键 cookie 是否齐全。
 * 用 chrome.cookies.getAll 可能返回 0 个，需要兜底。
 */
async function listCookieNamesForDomains(domains) {
  if (!chrome?.cookies?.getAll) return new Set();
  const names = new Set();
  for (const domain of domains) {
    try {
      const cookies = await chrome.cookies.getAll({ domain });
      for (const cookie of cookies || []) {
        if (cookie?.name) names.add(cookie.name);
      }
    } catch {
      // 单个域读取失败不影响其它域
    }
  }
  return names;
}

/**
 * 查询单个平台的登录状态。返回结构：
 *   {
 *     platformId, name, loggedIn, missing: [],
 *     matchedGroup: ["web_session"] | null,
 *     loginUrl, homeUrl
 *   }
 */
export async function getPlatformCookieStatus(platformId) {
  const rule = PLATFORM_COOKIE_RULES[platformId];
  if (!rule) {
    return {
      platformId,
      name: platformId,
      loggedIn: false,
      missing: ["未知平台"],
      matchedGroup: null,
      loginUrl: "",
      homeUrl: ""
    };
  }

  const cookieNames = await listCookieNamesForDomains(rule.domains);

  let matchedGroup = null;
  let missing = [];

  for (const group of rule.requiredAny) {
    const lacking = group.filter((name) => !cookieNames.has(name));
    if (lacking.length === 0) {
      matchedGroup = group;
      missing = [];
      break;
    }
    if (missing.length === 0 || lacking.length < missing.length) {
      missing = lacking;
    }
  }

  return {
    platformId: rule.id,
    name: rule.name,
    loggedIn: Boolean(matchedGroup),
    missing,
    matchedGroup,
    loginUrl: rule.loginUrl,
    homeUrl: rule.homeUrl
  };
}

/**
 * 批量查询多个平台的登录状态。
 */
export async function getPlatformCookieStatuses(platformIds = PLATFORM_IDS) {
  const ids = Array.isArray(platformIds) && platformIds.length > 0 ? platformIds : PLATFORM_IDS;
  const statuses = await Promise.all(ids.map((id) => getPlatformCookieStatus(id)));
  return statuses;
}

/**
 * 打开平台登录页（让用户在浏览器里手工登录）。
 */
export async function openPlatformLoginTab(platformId) {
  const rule = PLATFORM_COOKIE_RULES[platformId];
  if (!rule) {
    throw new Error("未知平台");
  }
  if (!chrome?.tabs?.create) {
    throw new Error("当前环境不支持打开新标签页");
  }
  const tab = await chrome.tabs.create({ url: rule.loginUrl });
  return { tabId: tab?.id || null, url: rule.loginUrl };
}
