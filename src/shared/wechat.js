import { cleanInvisibleChars } from "./wechat-html.js";

// ---------------------------------------------------------------------------
// 微信公众号 API 端点
// ---------------------------------------------------------------------------
// 不再硬编码 https://api.weixin.qq.com，而是统一走 buildWechatApiUrl(settings, path)：
//   - settings.wechatApiBase 为空 → 走官方 api.weixin.qq.com（默认行为，向后兼容）
//   - settings.wechatApiBase 非空 → 拼到自定义 base 之上（例如阿里云 FC 代理域名）
// 这样在用户家用动态 IP 进不了官方白名单时，可以一行配置切到 FC 代理。
// 详见 aliyun-fc/wechat-api-proxy/README.md。

const DEFAULT_WECHAT_API_HOST = "https://api.weixin.qq.com";

/**
 * 收集 publish payload 里所有需要 host permission 的远端图片 URL。
 * 前后端共用：前端在 click handler 里调它做用户手势 grant；后端兜底再 contains 一次。
 * 不返回 wechatApiBase（那个由 settings 直接读，不在 payload 里）。
 */
export function collectPublishRemoteUrls(payload) {
  const urls = [];
  const articles = Array.isArray(payload?.articles) ? payload.articles : [];
  for (const article of articles) {
    if (article?.cover?.src) urls.push(article.cover.src);
    if (Array.isArray(article?.inlineImages)) {
      article.inlineImages.forEach((image) => {
        if (image?.src) urls.push(image.src);
      });
    }
  }
  return urls;
}

const WECHAT_PATHS = {
  token: "/cgi-bin/token",
  uploadArticleImage: "/cgi-bin/media/uploadimg",
  addMaterial: "/cgi-bin/material/add_material",
  addDraft: "/cgi-bin/draft/add",
  submitPublish: "/cgi-bin/freepublish/submit",
  getPublishStatus: "/cgi-bin/freepublish/get",
  massSendAll: "/cgi-bin/message/mass/sendall",
  tagsGet: "/cgi-bin/tags/get"
};

/**
 * 构造一个微信 cgi-bin 接口的完整 URL。
 *
 * @param {object} settings - 用户设置（读 wechatApiBase）；可传 {} 表示走官方
 * @param {string} path     - 以 "/cgi-bin/..." 开头的路径
 * @returns {URL}           - 已 new URL() 好的对象，调用方继续 .searchParams.set()
 *
 * 边界处理：
 *  - 用户的 base 末尾带不带 "/" 都允许，统一去掉
 *  - 用户写成 "https://xxx/cgi-bin/" 这种"已含前缀"的会自动去前缀，避免拼成
 *    "https://xxx/cgi-bin/cgi-bin/token"
 *  - 任何解析失败都退回官方域名，确保不会因为配置笔误把所有发布请求打挂
 */
export function buildWechatApiUrl(settings, path) {
  const userBase = String(settings?.wechatApiBase || "").trim();
  const cleanPath = String(path || "").startsWith("/") ? path : `/${path || ""}`;

  if (!userBase) {
    return new URL(`${DEFAULT_WECHAT_API_HOST}${cleanPath}`);
  }
  try {
    let normalized = userBase.replace(/\/+$/, "");
    // 用户写成 ".../cgi-bin" 时去掉，避免拼成 "/cgi-bin/cgi-bin/..."
    if (cleanPath.startsWith("/cgi-bin/") && /\/cgi-bin$/.test(normalized)) {
      normalized = normalized.replace(/\/cgi-bin$/, "");
    }
    return new URL(`${normalized}${cleanPath}`);
  } catch {
    return new URL(`${DEFAULT_WECHAT_API_HOST}${cleanPath}`);
  }
}

const COMPATIBLE_IMAGE_TYPES = new Set([
  "image/jpeg",
  "image/png",
  "image/gif",
  "image/bmp"
]);

// 公众号文档：素材接口正文图 ≤ 1MB，永久素材封面 ≤ 2MB。
// 我们留一点余量，避免边界值被服务器算作超限。
const MAX_INLINE_IMAGE_BYTES = 1024 * 1024; // 1MB
const MAX_COVER_IMAGE_BYTES = 2 * 1024 * 1024; // 2MB

const STATUS_TEXT = {
  0: "发布成功",
  1: "发布中",
  2: "原创校验失败",
  3: "常规失败",
  4: "平台审核不通过",
  5: "发布成功后被用户删除",
  6: "发布成功后被系统封禁"
};

/**
 * 公众号常见错误码 → 用户能看懂的中文 + 错误分类。
 *
 * category:
 *   "auth"       AppID/AppSecret 错误
 *   "token"      access_token 失效
 *   "permission" 账号类型不够 / 接口未授权（不是凭证错）
 *   "ip"         IP 白名单
 *   "image"      图片格式/文件名/MIME 不被接受
 *   "draft"      草稿/字段相关
 *   "quota"      限频/限额
 *   "internal"   微信侧异常
 *   "unknown"    未识别
 */
const WECHAT_ERROR_CATALOG = {
  40001: {
    category: "token",
    message: "access_token 已失效（40001）。请稍后重试，或在设置里『测试公众号连接』确认凭证。"
  },
  40005: {
    category: "image",
    message:
      "公众号不接受该图片（40005：不合法的媒体文件类型）。请把图片转为 jpg/png/gif/bmp，并保证文件名带正确后缀。"
  },
  // 40007 = 「invalid media_id」。微信对 add_draft / mass/sendall / freepublish/submit
  // 等接口的 media_id 校验非常严格，下列 4 类是已知的所有触发原因：
  //   1) 上游封面上传 silently 失败 → thumb_media_id 实际是空字符串（本仓库历史 silent
  //      failure 链：见 `publishToWechat` 封面 try/catch 已修），微信对空 media_id 返 40007
  //   2) 临时素材 media_id 已过期（微信临时素材只有 3 天有效，但本仓库一直用永久素材
  //      `material/add_material`，所以这条路径不会触发——除非有人未来误改）
  //   3) 跨账号 media_id 复用：上传用了账号 A 的 access_token、调用 add_draft 时用了
  //      账号 B 的 access_token（典型场景：用户配了 wechatApiBase 反代，但反代里走了
  //      不同账号的 token 缓存）
  //   4) access_token 在上传与 add_draft 之间发生了刷新（极罕见，仅多设备并发时）
  // 用户能直接复制反馈给客服的就是 errmsg 里 hint=[xxxx] 那段——`buildWechatError`
  // 会专门提取并挂到 `err.detectedMediaIdHint`，让上层 UI 能直接 surface。
  40007: {
    category: "draft",
    message:
      "公众号拒绝了草稿里的封面或图片素材 ID（40007：invalid media_id）。\n" +
      "最常见原因：① 封面上传环节 silently 失败、传给草稿接口的是空 media_id；" +
      "② 你切换过公众号账号但仍引用了上一个账号的素材 ID；③ 微信 API 代理（aliyun-fc 等）的 access_token 缓存乱了。\n" +
      "建议处置：回到「发布」面板，点「📷 上传本地封面」或「✨ 一键生成占位封面」重新生成一张封面后重试；问题仍在请把 hint 后面的诊断码连同截图发给客服。"
  },
  40013: {
    category: "auth",
    message: "AppID 无效（40013）。请到公众号后台『开发 → 基本配置』确认 AppID。"
  },
  40097: {
    category: "image",
    message: "图片字段不合法（40097）。请检查图片是否为公众号支持的格式。"
  },
  40113: {
    category: "image",
    message:
      "公众号不支持的多媒体文件类型（40113）。请把图片转为 jpg/png/gif/bmp 后再上传。"
  },
  40125: {
    category: "auth",
    message: "AppSecret 无效（40125）。请到公众号后台『开发 → 基本配置』重新获取 Secret。"
  },
  40164: {
    category: "ip",
    message:
      "IP 白名单未通过（40164）：当前出口 IP 不在公众号后台『IP 白名单』里。请把当前公网 IP 加进去后重试。"
  },
  41001: {
    category: "token",
    message: "缺少 access_token（41001）。"
  },
  42001: {
    category: "token",
    message: "access_token 已过期（42001），系统会自动重试。"
  },
  45009: {
    category: "quota",
    message: "接口调用超出当日限额（45009）。请稍后再试。"
  },
  45166: {
    category: "draft",
    message: "草稿字段不完整（45166）。请检查标题、封面、正文是否齐全。"
  },
  48001: {
    category: "permission",
    message:
      "公众号接口未授权（48001）。通常意味着当前账号类型（如订阅号 / 未认证号）" +
      "不具备草稿或发布接口权限——这不是 AppID/AppSecret 错，而是账号权限问题。" +
      "请到公众号后台确认是否为『已认证服务号』并开通了对应接口。"
  },
  53400: {
    category: "permission",
    message: "该接口仅允许已认证服务号调用（53400）。"
  },
  61450: {
    category: "internal",
    message: "公众号接口内部错误（61450），请稍后重试。"
  },
  88000: {
    category: "quota",
    message: "群发次数超过限制（88000）。"
  }
};

export async function publishToWechat(settings, payload) {
  validateSettings(settings);
  validatePublishPayload(payload);

  const accessToken = await getAccessToken(settings);
  const preparedArticles = [];
  let totalImageCount = 0;

  const allFailedImages = [];

  for (const [index, article] of payload.articles.entries()) {
    const { replacements, failedImages } = await uploadInlineImages(settings, accessToken, article.inlineImages || []);
    // workspace 端已经做过 DOM 级 sanitize；这里再用纯字符串层的清洗
    // 兜一道（去 BOM / 零宽 / 控制字符 / NFC），避免 service worker 内任何
    // 拼接环节再次引入不可见字符导致草稿乱码。
    const replacedHtml = applyImageReplacements(article.html, replacements);
    const contentHtml = cleanInvisibleChars(replacedHtml);

    if (failedImages.length > 0) {
      for (const fail of failedImages) {
        fail.articleIndex = index + 1;
      }
      allFailedImages.push(...failedImages);
    }

    if (contentHtml.length > 20000) {
      throw new Error(
        `第 ${index + 1} 篇正文 HTML 长度 ${contentHtml.length} 超过公众号草稿接口 2 万字符上限，` +
          "建议拆分章节或精简内联样式后再重试。"
      );
    }

    let coverMediaId = "";
    let coverFilename = article?.cover?.filename || `cover-${index + 1}.png`;
    try {
      if (!article?.cover?.src) {
        throw new Error(
          `第 ${index + 1} 篇没有封面图源。请到「发布」面板上传或一键生成占位封面后重试。`
        );
      }
      const coverBlob = await fetchImageBlob(article.cover.src);
      const coverCompatibleBlob = await ensureCompatibleImageBlob(coverBlob, {
        sourceUrl: article.cover.src,
        maxBytes: MAX_COVER_IMAGE_BYTES,
        kind: "cover"
      });
      coverFilename = normalizeFilename(coverFilename, coverCompatibleBlob.type);
      coverMediaId = await uploadPermanentImage(
        settings,
        accessToken,
        coverCompatibleBlob,
        coverFilename
      );
    } catch (error) {
      // 封面失败必须立即抛错——不能像 inline 图那样降级吞掉。
      // 历史 silent failure 链（已修）：catch 把错塞进 allFailedImages 但 coverMediaId 留为空字符串
      // → 继续走到下面的 createDraft → `thumb_media_id: ""` 直接撞微信 errcode=40007 (invalid media_id)
      // → 用户只看到「invalid media_id」通用文案，根本不知道根因是封面没传上去。
      // inline 图允许降级是因为正文少一两张图仍然能成稿；封面没传上去 add_draft 必然 40007，
      // 让流程往下走只是用一条更模糊的报错盖住一条更清晰的报错，纯属 anti-pattern。
      const failureDetail = {
        type: "cover",
        src: article?.cover?.src || "",
        filename: coverFilename,
        mime: error?.detectedMime || "",
        articleIndex: index + 1,
        errcode: error?.errcode || 0,
        rid: error?.rid || "",
        category: error?.category || "image",
        error: error?.userMessage || error.message || "封面上传失败"
      };
      const baseDetail = error?.userMessage || error?.message || "封面上传失败";
      const enriched = new Error(
        `第 ${index + 1} 篇封面图上传失败，无法继续创建草稿：${baseDetail}\n` +
          `请回到「发布」面板换一张封面（推荐 ≤2MB 的 jpg/png）或点「✨ 一键生成占位封面」后重试。`
      );
      enriched.category = "image";
      enriched.errcode = error?.errcode || 0;
      enriched.rid = error?.rid || "";
      enriched.userMessage = enriched.message;
      enriched.failedCover = failureDetail;
      throw enriched;
    }

    totalImageCount += Object.keys(replacements).length;
    preparedArticles.push({
      ...article.meta,
      contentHtml,
      thumbMediaId: coverMediaId
    });
  }

  // 双重防御：理论上走到这里 thumbMediaId 都已是非空的、合法的永久素材 ID。
  // 但万一未来有人改了上面的 control flow（比如把封面 catch 改回降级），这里再卡一道，
  // 避免用户撞上语义模糊的 40007 invalid media_id。
  for (const [i, art] of preparedArticles.entries()) {
    if (!art.thumbMediaId || typeof art.thumbMediaId !== "string") {
      throw new Error(
        `第 ${i + 1} 篇内部错误：thumb_media_id 为空，无法调用公众号草稿接口（这通常意味着上面的封面上传链路有 bug）。`
      );
    }
  }

  const draftMediaId = await createDraft(settings, accessToken, preparedArticles);

  if (payload.publishMode === "publish") {
    // 群发策略（P1.2）：
    //   - sendStrategy === "all" 或 "tag" → 走 mass/sendall（让认证服务号文章进列表）
    //   - 其余（含未传 / "none"）→ 走 freepublish/submit（旧行为，仅认证号能用，不进列表）
    const sendStrategy = String(payload.sendStrategy || settings.wechatSendStrategy || "none");
    if (sendStrategy === "all" || sendStrategy === "tag") {
      const sendTagId = Number(
        payload.sendTagId !== undefined ? payload.sendTagId : settings.wechatSendTagId
      );
      const ignoreReprintCheck = Boolean(
        payload.sendIgnoreReprint !== undefined
          ? payload.sendIgnoreReprint
          : settings.wechatSendIgnoreReprint
      );

      const massResult = await massSendArticle(settings, accessToken, draftMediaId, {
        strategy: sendStrategy,
        tagId: sendTagId,
        ignoreReprintCheck
      });
      return {
        draftMediaId,
        publishId: "",
        massSendMsgId: massResult.msgId || "",
        massSendDataId: massResult.msgDataId || "",
        sendStrategy,
        sendTagId: sendStrategy === "tag" ? sendTagId : 0,
        articleCount: preparedArticles.length,
        imageCount: totalImageCount,
        mode: "publish",
        failedImages: allFailedImages
      };
    }

    const publishId = await submitPublish(settings, accessToken, draftMediaId);
    return {
      draftMediaId,
      publishId,
      sendStrategy: "none",
      articleCount: preparedArticles.length,
      imageCount: totalImageCount,
      mode: "publish",
      failedImages: allFailedImages
    };
  }

  return {
    draftMediaId,
    articleCount: preparedArticles.length,
    imageCount: totalImageCount,
    mode: "draft",
    failedImages: allFailedImages
  };
}

export async function queryPublishStatus(settings, publishId) {
  validateSettings(settings);
  if (!publishId) {
    throw new Error("缺少 publish_id。");
  }

  const accessToken = await getAccessToken(settings);
  return getPublishStatus(settings, accessToken, publishId);
}

export async function testWechatConnection({ appId, appSecret, wechatApiBase = "", timeoutMs = 12000 }) {
  const targetAppId = String(appId || "").trim();
  const targetAppSecret = String(appSecret || "").trim();

  if (!targetAppId) {
    return {
      ok: false,
      latencyMs: 0,
      error: "请先填写公众号 AppID。"
    };
  }

  if (!targetAppSecret) {
    return {
      ok: false,
      latencyMs: 0,
      error: "请先填写公众号 AppSecret。"
    };
  }

  // 测试连接也走 wechatApiBase（如果填了），便于"配完代理 → 一键测通"
  const url = buildWechatApiUrl({ wechatApiBase }, WECHAT_PATHS.token);
  url.searchParams.set("grant_type", "client_credential");
  url.searchParams.set("appid", targetAppId);
  url.searchParams.set("secret", targetAppSecret);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const startedAt = Date.now();

  try {
    const response = await fetch(url.toString(), {
      signal: controller.signal
    });
    const payload = await response.json().catch(() => ({}));
    const latencyMs = Date.now() - startedAt;

    if (!response.ok || payload?.errcode) {
      const known = WECHAT_ERROR_CATALOG[payload?.errcode];
      return {
        ok: false,
        latencyMs,
        error: mapWechatConnectionError(payload, response.status),
        errcode: Number(payload?.errcode || 0),
        category: known?.category || "unknown",
        rid: payload?.rid || ""
      };
    }

    if (!payload.access_token) {
      return {
        ok: false,
        latencyMs,
        error: "验证失败，公众号接口没有返回 access token。",
        errcode: 0,
        category: "unknown",
        rid: ""
      };
    }

    return {
      ok: true,
      latencyMs,
      error: "",
      errcode: 0,
      category: "ok",
      rid: "",
      // 强提示：测试连接只能说明 access_token 拿得到，
      // 不能保证 add_draft / freepublish 等接口也有权限（典型如 48001）。
      note:
        "已成功获取 access_token。注意：本测试只能验证 AppID/AppSecret + IP 白名单，" +
        "并不能验证草稿/发布接口是否对当前账号开放。"
    };
  } catch (error) {
    return {
      ok: false,
      latencyMs: Date.now() - startedAt,
      error: mapWechatRuntimeError(error),
      errcode: 0,
      category: error?.name === "AbortError" ? "timeout" : "network",
      rid: ""
    };
  } finally {
    clearTimeout(timer);
  }
}

function validateSettings(settings) {
  if (!settings.wechatAppId?.trim()) {
    throw new Error("请先在设置页填写公众号 AppID。");
  }
  if (!settings.wechatAppSecret?.trim()) {
    throw new Error("请先在设置页填写公众号 AppSecret。");
  }
}

function validatePublishPayload(payload) {
  if (!Array.isArray(payload?.articles) || payload.articles.length === 0) {
    throw new Error("至少需要一篇文章才能推送到公众号。");
  }

  if (payload.articles.length > 8) {
    throw new Error("公众号多图文最多支持 8 篇文章。");
  }

  for (const [index, article] of payload.articles.entries()) {
    if (!article?.meta?.title?.trim()) {
      throw new Error(`第 ${index + 1} 篇没有填写标题。`);
    }
    if (!article?.html?.trim()) {
      throw new Error(`第 ${index + 1} 篇正文为空。`);
    }
    if (!article?.cover?.src) {
      throw new Error(
        `第 ${index + 1} 篇还没有封面图。请回到工作台「发布」面板，` +
          `用「📷 上传本地封面」或「✨ 一键生成占位封面」补一张后再试。`
      );
    }
  }
}

async function getAccessToken(settings) {
  const url = buildWechatApiUrl(settings, WECHAT_PATHS.token);
  url.searchParams.set("grant_type", "client_credential");
  url.searchParams.set("appid", settings.wechatAppId.trim());
  url.searchParams.set("secret", settings.wechatAppSecret.trim());

  const response = await fetch(url.toString());
  const payload = await response.json().catch(() => ({}));
  ensureWechatOk(response, payload, "获取 access token 失败");

  if (!payload.access_token) {
    throw new Error("公众号接口没有返回 access token。");
  }

  return payload.access_token;
}

async function uploadInlineImages(settings, accessToken, inlineImages) {
  const replacements = {};
  const failedImages = [];

  for (const image of inlineImages) {
    let finalFilename = image.filename || "inline.png";
    let detectedMime = "";
    try {
      const blob = await fetchImageBlob(image.src);
      detectedMime = blob.type;
      const compatibleBlob = await ensureCompatibleImageBlob(blob, {
        sourceUrl: image.src,
        maxBytes: MAX_INLINE_IMAGE_BYTES,
        kind: "inline"
      });
      detectedMime = compatibleBlob.type;
      finalFilename = normalizeFilename(finalFilename, compatibleBlob.type);
      const uploadedUrl = await uploadArticleImage(
        settings,
        accessToken,
        compatibleBlob,
        finalFilename
      );
      replacements[image.token] = uploadedUrl;
    } catch (error) {
      failedImages.push({
        type: "inline",
        src: image.src,
        filename: finalFilename,
        mime: error?.detectedMime || detectedMime || "",
        token: image.token,
        errcode: error?.errcode || 0,
        rid: error?.rid || "",
        category: error?.category || "image",
        error: error?.userMessage || error.message || "上传失败"
      });
    }
  }

  return { replacements, failedImages };
}

async function uploadArticleImage(settings, accessToken, blob, filename) {
  const url = buildWechatApiUrl(settings, WECHAT_PATHS.uploadArticleImage);
  url.searchParams.set("access_token", accessToken);

  const formData = new FormData();
  formData.append("media", blob, normalizeFilename(filename, blob.type));

  const response = await fetch(url.toString(), {
    method: "POST",
    body: formData
  });
  const payload = await response.json().catch(() => ({}));
  ensureWechatOk(response, payload, "上传正文图片失败");

  if (!payload.url) {
    throw new Error("公众号图片上传成功，但没有返回图片 URL。");
  }

  return payload.url;
}

async function uploadPermanentImage(settings, accessToken, blob, filename) {
  const url = buildWechatApiUrl(settings, WECHAT_PATHS.addMaterial);
  url.searchParams.set("access_token", accessToken);
  url.searchParams.set("type", "image");

  const formData = new FormData();
  formData.append("media", blob, normalizeFilename(filename, blob.type));

  const response = await fetch(url.toString(), {
    method: "POST",
    body: formData
  });
  const payload = await response.json().catch(() => ({}));
  ensureWechatOk(response, payload, "上传封面素材失败");

  if (!payload.media_id) {
    throw new Error("封面素材上传成功，但没有返回 media_id。");
  }

  return payload.media_id;
}

async function createDraft(settings, accessToken, articles) {
  const url = buildWechatApiUrl(settings, WECHAT_PATHS.addDraft);
  url.searchParams.set("access_token", accessToken);

  const response = await fetch(url.toString(), {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      articles: articles.map((article) => ({
        title: article.title.trim(),
        author: String(article.author || "").trim(),
        digest: String(article.digest || "").trim(),
        content: article.contentHtml,
        content_source_url: String(article.contentSourceUrl || "").trim(),
        thumb_media_id: article.thumbMediaId,
        need_open_comment: article.needOpenComment ? 1 : 0,
        only_fans_can_comment: article.onlyFansCanComment ? 1 : 0
      }))
    })
  });
  const payload = await response.json().catch(() => ({}));
  ensureWechatOk(response, payload, "创建公众号草稿失败");

  if (!payload.media_id) {
    throw new Error("草稿创建成功，但没有返回草稿 media_id。");
  }

  return payload.media_id;
}

async function submitPublish(settings, accessToken, mediaId) {
  const url = buildWechatApiUrl(settings, WECHAT_PATHS.submitPublish);
  url.searchParams.set("access_token", accessToken);

  const response = await fetch(url.toString(), {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      media_id: mediaId
    })
  });
  const payload = await response.json().catch(() => ({}));
  ensureWechatOk(response, payload, "提交公众号发布失败");

  if (!payload.publish_id) {
    throw new Error("发布请求已提交，但没有返回 publish_id。");
  }

  return payload.publish_id;
}

async function getPublishStatus(settings, accessToken, publishId) {
  const url = buildWechatApiUrl(settings, WECHAT_PATHS.getPublishStatus);
  url.searchParams.set("access_token", accessToken);

  const response = await fetch(url.toString(), {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      publish_id: Number(publishId)
    })
  });
  const payload = await response.json().catch(() => ({}));
  ensureWechatOk(response, payload, "查询公众号发布状态失败");

  return normalizePublishStatus(payload);
}

// ---------------------------------------------------------------------------
// P1.2 · 群发接口（让认证服务号文章进公众号文章列表）
// ---------------------------------------------------------------------------
// 公众号「自动发布到列表」的官方姿势：
//   1) 先 add_draft 拿到 draft media_id（已有，复用 createDraft）
//   2) 再调 mass/sendall 用 mpnews + media_id 群发
//      - is_to_all=true     → 全员，**每月最多 4 次**，会真正进入用户对话框
//      - is_to_all=false    → 必须指定 tag_id（用户标签 ID），不计入 4 次/月
// 仅认证服务号（type=2 service + 已认证）可用，订阅号 / 未认证号会回 48001/53400。
//
// 上层 publishToWechat 负责把 sendStrategy 翻译成 options 调进来：
//   { strategy: "all" | "tag", tagId: number, ignoreReprintCheck: boolean }

/**
 * 调用 message/mass/sendall 发送 mpnews。
 *
 * @returns {{ msgId: string, msgDataId: string }}
 *   - msgId      公众号侧的群发任务 ID（数字，但官方文档里以 number 返回，这里统一字符串方便序列化到本地缓存）
 *   - msgDataId  群发的图文消息 ID，可用于后续删除/查询
 */
export async function massSendArticle(settings, accessToken, mediaId, options = {}) {
  if (!mediaId) {
    throw new Error("massSendArticle: 缺少 draft media_id。");
  }

  const strategy = options.strategy === "all" ? "all" : "tag";
  const tagId = Number(options.tagId || 0);

  if (strategy === "tag" && !(tagId > 0)) {
    throw new Error(
      "群发到指定标签时必须填写有效的 tag_id（>0）。请到公众号后台『用户管理 → 标签管理』确认标签 ID。"
    );
  }

  const body = {
    filter:
      strategy === "all"
        ? { is_to_all: true }
        : { is_to_all: false, tag_id: tagId },
    mpnews: { media_id: mediaId },
    msgtype: "mpnews",
    send_ignore_reprint: options.ignoreReprintCheck ? 1 : 0
  };

  const url = buildWechatApiUrl(settings, WECHAT_PATHS.massSendAll);
  url.searchParams.set("access_token", accessToken);

  const response = await fetch(url.toString(), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body)
  });
  const payload = await response.json().catch(() => ({}));
  ensureWechatOk(response, payload, "公众号群发失败");

  return {
    msgId: payload.msg_id !== undefined ? String(payload.msg_id) : "",
    msgDataId: payload.msg_data_id !== undefined ? String(payload.msg_data_id) : ""
  };
}

/**
 * 列出公众号下所有用户标签，用于发布面板的"群发到标签"下拉填充。
 *
 * 返回：[{ id, name, count }]
 *
 * 任何 errcode 都会被翻译成带分类的 Error 抛出（含 requiresVerifiedAccount=true 的情形），
 * 上层可以直接 try/catch 后展示给用户。
 */
export async function listUserTags(settings) {
  validateSettings(settings);
  const accessToken = await getAccessToken(settings);

  const url = buildWechatApiUrl(settings, WECHAT_PATHS.tagsGet);
  url.searchParams.set("access_token", accessToken);

  const response = await fetch(url.toString());
  const payload = await response.json().catch(() => ({}));
  ensureWechatOk(response, payload, "拉取用户标签失败");

  return Array.isArray(payload?.tags)
    ? payload.tags.map((tag) => ({
        id: Number(tag.id),
        name: String(tag.name || ""),
        count: Number(tag.count || 0)
      }))
    : [];
}

async function fetchImageBlob(src) {
  const response = await fetch(src, {
    method: "GET",
    cache: "no-store"
  });

  if (!response.ok) {
    const err = new Error(`下载图片失败（HTTP ${response.status}）：${src}`);
    err.category = "image";
    throw err;
  }

  const rawBlob = await response.blob();
  // 优先级：response Content-Type → 已有 blob.type → URL 后缀 → magic bytes
  const headerType = (response.headers.get("Content-Type") || "")
    .split(";")[0]
    .trim()
    .toLowerCase();
  const urlType = guessMimeFromUrl(src);
  const magicType = await sniffMagicBytes(rawBlob);
  const finalType =
    pickImageMime(headerType) ||
    pickImageMime(rawBlob.type) ||
    pickImageMime(urlType) ||
    magicType ||
    "application/octet-stream";

  if (finalType !== rawBlob.type) {
    return new Blob([await rawBlob.arrayBuffer()], { type: finalType });
  }
  return rawBlob;
}

/**
 * 拿到 blob 后，确保最终交给微信 upload 接口的 blob 是 jpg/png/gif/bmp，
 * 并且体积不超过对应接口的硬上限：
 *   - 正文图（uploadimg）≤ 1MB
 *   - 封面（add_material）≤ 2MB
 *
 * 选项：
 *   sourceUrl  原始 URL，用于报错时回显
 *   maxBytes   硬上限（封面 / 正文）
 *   kind       "inline" | "cover"，用在错误信息里
 */
async function ensureCompatibleImageBlob(blob, options = {}) {
  const { sourceUrl = "", maxBytes = MAX_INLINE_IMAGE_BYTES, kind = "inline" } =
    options;

  if (!blob || blob.size === 0) {
    const err = new Error(
      `${kind === "cover" ? "封面" : "正文图片"}下载结果为空：${sourceUrl}`
    );
    err.category = "image";
    err.detectedMime = blob?.type || "";
    throw err;
  }

  let working = blob;

  // 不是图片类型 → 一律拒绝（避免把 HTML 错误页当成图上传）
  if (!String(working.type || "").startsWith("image/")) {
    const err = new Error(
      `${kind === "cover" ? "封面" : "正文图片"}不是图片格式（推断 MIME=${
        working.type || "未知"
      }）：${sourceUrl}`
    );
    err.category = "image";
    err.detectedMime = working.type || "";
    throw err;
  }

  // 兼容类型直接放行
  let needConvert = !COMPATIBLE_IMAGE_TYPES.has(working.type);

  // 即使是兼容类型，超过体积上限也必须重编码压缩
  if (!needConvert && working.size > maxBytes) {
    needConvert = true;
  }

  if (needConvert) {
    working = await convertImageBlob(working, {
      sourceUrl,
      kind,
      maxBytes
    });
  }

  if (working.size > maxBytes) {
    const err = new Error(
      `${kind === "cover" ? "封面" : "正文图片"}转码后仍超过 ${(
        maxBytes /
        1024 /
        1024
      ).toFixed(1)}MB（实际 ${(working.size / 1024 / 1024).toFixed(
        2
      )}MB）：${sourceUrl}`
    );
    err.category = "image";
    err.detectedMime = working.type;
    throw err;
  }

  return working;
}

/**
 * 用 OffscreenCanvas 把不兼容图片（webp/avif/svg/未知）转成 png 或 jpeg。
 * 体积优先策略：
 *   1) 先尝试 image/png；
 *   2) png 太大就降级到 image/jpeg(0.92→0.8→0.7) 直到不超过 maxBytes；
 *   3) jpeg 0.7 还超就抛错（让上层走 failedImages 反馈）。
 */
async function convertImageBlob(blob, { sourceUrl, kind, maxBytes }) {
  if (
    typeof OffscreenCanvas === "undefined" ||
    typeof createImageBitmap === "undefined"
  ) {
    // 浏览器环境拿不到 canvas（极罕见，比如老的 Safari Worker 环境），
    // 直接告诉用户公众号不接受当前格式。
    const err = new Error(
      `当前环境无法转码 ${blob.type}，公众号仅接受 jpg/png/gif/bmp：${sourceUrl}`
    );
    err.category = "image";
    err.detectedMime = blob.type;
    throw err;
  }

  let imageBitmap;
  try {
    imageBitmap = await createImageBitmap(blob);
  } catch (error) {
    // SVG / 损坏的 webp 经常在这里 throw
    const err = new Error(
      `图片解码失败（${blob.type}），可能是 SVG 或损坏文件：${sourceUrl}`
    );
    err.category = "image";
    err.detectedMime = blob.type;
    err.cause = error;
    throw err;
  }

  const canvas = new OffscreenCanvas(imageBitmap.width, imageBitmap.height);
  const context = canvas.getContext("2d");
  context.drawImage(imageBitmap, 0, 0);

  // 第一步：png（无损）
  const png = await canvas.convertToBlob({ type: "image/png" });
  if (png.size <= maxBytes) {
    imageBitmap.close?.();
    return png;
  }

  // 第二步：jpeg 多档质量降级
  for (const quality of [0.92, 0.85, 0.78, 0.7]) {
    const jpeg = await canvas.convertToBlob({
      type: "image/jpeg",
      quality
    });
    if (jpeg.size <= maxBytes) {
      imageBitmap.close?.();
      return jpeg;
    }
  }

  imageBitmap.close?.();

  // 全部尝试都还超限 → 让上层用统一错误格式反馈
  const err = new Error(
    `图片体积过大且无法压缩到 ${(maxBytes / 1024 / 1024).toFixed(
      1
    )}MB 以内（${kind === "cover" ? "封面" : "正文图"}）：${sourceUrl}`
  );
  err.category = "image";
  err.detectedMime = blob.type;
  throw err;
}

/** 把 chrome / oss 里常见的可疑 type 转成统一小写 image/* 字符串。 */
function pickImageMime(value) {
  const v = String(value || "").trim().toLowerCase();
  if (!v) return "";
  if (
    v === "image/jpeg" ||
    v === "image/png" ||
    v === "image/gif" ||
    v === "image/bmp" ||
    v === "image/webp" ||
    v === "image/avif" ||
    v === "image/svg+xml"
  ) {
    return v;
  }
  if (v === "image/jpg") return "image/jpeg";
  if (v.startsWith("image/")) return v; // 未识别的 image/*，保留以便走转码
  return "";
}

function guessMimeFromUrl(url) {
  try {
    const u = new URL(url, "https://docuearn.com");
    const ext = (u.pathname.match(/\.([a-z0-9]+)$/i)?.[1] || "").toLowerCase();
    switch (ext) {
      case "jpg":
      case "jpeg":
        return "image/jpeg";
      case "png":
        return "image/png";
      case "gif":
        return "image/gif";
      case "bmp":
        return "image/bmp";
      case "webp":
        return "image/webp";
      case "avif":
        return "image/avif";
      case "svg":
        return "image/svg+xml";
      default:
        return "";
    }
  } catch {
    return "";
  }
}

/**
 * 真·magic bytes 嗅探。只读前 12 字节，避免大图也读完整文件。
 * 覆盖 jpeg / png / gif / bmp / webp / avif（heif）/ svg。
 */
async function sniffMagicBytes(blob) {
  try {
    const head = await blob.slice(0, 16).arrayBuffer();
    const bytes = new Uint8Array(head);
    if (bytes.length < 4) return "";

    if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff)
      return "image/jpeg";
    if (
      bytes[0] === 0x89 &&
      bytes[1] === 0x50 &&
      bytes[2] === 0x4e &&
      bytes[3] === 0x47
    )
      return "image/png";
    if (bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46)
      return "image/gif";
    if (bytes[0] === 0x42 && bytes[1] === 0x4d) return "image/bmp";
    // RIFF....WEBP
    if (
      bytes[0] === 0x52 &&
      bytes[1] === 0x49 &&
      bytes[2] === 0x46 &&
      bytes[3] === 0x46 &&
      bytes[8] === 0x57 &&
      bytes[9] === 0x45 &&
      bytes[10] === 0x42 &&
      bytes[11] === 0x50
    )
      return "image/webp";
    // ftypavif / ftypheic / ftypmif1
    if (
      bytes[4] === 0x66 &&
      bytes[5] === 0x74 &&
      bytes[6] === 0x79 &&
      bytes[7] === 0x70
    ) {
      const brand = String.fromCharCode(bytes[8], bytes[9], bytes[10], bytes[11]);
      if (brand === "avif" || brand === "avis") return "image/avif";
      if (brand === "heic" || brand === "heix" || brand === "mif1")
        return "image/heic";
    }
    // SVG（XML 文本，简单 sniff）
    const head8 = new TextDecoder("utf-8", { fatal: false }).decode(bytes);
    if (/^\s*(<\?xml|<svg)/i.test(head8)) return "image/svg+xml";

    return "";
  } catch {
    return "";
  }
}

function applyImageReplacements(html, imageMap) {
  let nextHtml = html;
  for (const [token, url] of Object.entries(imageMap)) {
    nextHtml = nextHtml.split(token).join(url);
  }
  return nextHtml;
}

function normalizePublishStatus(payload) {
  const publishStatus = Number(payload.publish_status);
  const statusText = STATUS_TEXT[publishStatus] || `未知状态(${publishStatus})`;

  return {
    publishId: payload.publish_id,
    publishStatus,
    statusText,
    articleId: payload.article_id || "",
    articleUrls: Array.isArray(payload.article_detail?.item)
      ? payload.article_detail.item.map((item) => ({
          index: Number(item.idx || 0),
          articleUrl: item.article_url || ""
        }))
      : [],
    failIndex: Array.isArray(payload.fail_idx) ? payload.fail_idx : [],
    isTerminal: publishStatus !== 1
  };
}

/**
 * 把公众号 errcode/errmsg 翻译成 UI 友好错误。
 * 抛出的 Error 上挂了 errcode / rid / category / errmsg / userMessage，
 * 上层（UI、日志）都可以读到原始诊断信息。
 */
function ensureWechatOk(response, payload, fallback) {
  if (response.ok && !payload?.errcode) {
    return;
  }
  throw buildWechatError(payload, response, fallback);
}

export function buildWechatError(payload, response, fallback) {
  const errcode = Number(payload?.errcode || 0);
  const rid = payload?.rid || response?.headers?.get?.("x-request-id") || "";
  const known = WECHAT_ERROR_CATALOG[errcode];

  let category = known?.category || "unknown";
  let userMessage = known?.message || "";

  // 微信会把 image 相关的细节塞在 errmsg 文本里（例如 "unsupported file type hint"）
  const lowerErrmsg = String(payload?.errmsg || "").toLowerCase();
  if (!userMessage) {
    if (/unsupported file type|invalid file type|invalid media file/.test(lowerErrmsg)) {
      category = "image";
      userMessage =
        "公众号不接受该图片（unsupported file type）。请把图片转为 jpg/png/gif/bmp 后再上传，并保证文件名带正确后缀。";
    } else if (/invalid (appid|secret)|invalid credential/.test(lowerErrmsg)) {
      category = "auth";
      userMessage = "公众号凭证错误，请检查 AppID/AppSecret。";
    } else if (response && response.status === 401) {
      category = "auth";
      userMessage = "公众号凭证无效（HTTP 401）。请检查 AppID/AppSecret。";
    } else if (response && response.status === 403) {
      category = "permission";
      userMessage = "公众号接口被拒（HTTP 403）。可能是权限或 IP 白名单问题。";
    }
  }

  // errcode=40164 时，微信 errmsg 形如 "invalid ip xx.xx.xx.xx ipv6 ::ffff:xx.xx.xx.xx, not in whitelist"，
  // 把当前真实出口 IP 也带上——这正是用户唯一需要的、能直接复制粘贴到白名单的关键信息。
  // 老版本只用了 catalog 静态文案，把这个 IP 完全吞掉了，用户只能盲找。
  const detectedIp = errcode === 40164 ? extractWechatIpFromErrmsg(payload?.errmsg) : "";
  if (detectedIp) {
    userMessage =
      `IP 白名单未通过（40164）：当前出口 IP 是 ${detectedIp}，` +
      `不在公众号后台『开发 → 基本配置 → IP 白名单』里。\n` +
      `请把 ${detectedIp} 复制后加到白名单（动态 IP 用户建议改用『微信 API 代理地址』，详见设置页）。`;
  }

  // errcode=40007 时，微信 errmsg 形如 "invalid media_id hint: [fbk5ma021425-1] rid: 69ed8aad..."。
  // hint 里的诊断码 fbk5ma021425-1 是微信内部 trace，业务侧无法解，但客服侧能查；
  // 把它单独挂出来，让 UI / 错误日志 / 工单复现链都能直接读，而不必再从 message 字符串里二次 regex。
  // 同 40164 IP 透传模式（详见 memory-bank ninth session 里关于「errmsg 关键诊断信息必须挂字段透传」的硬约束）。
  const detectedMediaIdHint =
    errcode === 40007 ? extractWechatMediaIdHintFromErrmsg(payload?.errmsg) : "";
  if (detectedMediaIdHint && userMessage) {
    userMessage = `${userMessage}\n微信侧诊断码：${detectedMediaIdHint}（反馈给客服可以查到具体哪条素材记录）。`;
  }

  const baseMessage = userMessage || `${fallback}：${payload?.errmsg || "未知错误"}`;
  const diagnostics = [
    errcode ? `errcode=${errcode}` : "",
    payload?.errmsg ? `errmsg=${payload.errmsg}` : "",
    rid ? `rid=${rid}` : "",
    !errcode && response?.status ? `http=${response.status}` : ""
  ]
    .filter(Boolean)
    .join(" · ");

  const fullMessage = diagnostics ? `${baseMessage}\n${diagnostics}` : baseMessage;

  const err = new Error(fullMessage);
  err.errcode = errcode;
  err.rid = rid;
  err.category = category;
  err.errmsg = payload?.errmsg || "";
  err.userMessage = baseMessage;
  err.httpStatus = response?.status || 0;
  // P1.1 · 2025-07 起未认证账号失去 draft/add 权限。专门给前端一个布尔旗标，
  // 让 popup/workspace 可以弹"复制 HTML 手动粘贴"的兜底 modal，
  // 而不必在前端再 hardcode 一份 errcode 列表。
  err.requiresVerifiedAccount = errcode === 48001 || errcode === 53400;
  // 40164 专用：让上层（service-worker / UI）能直接读出口 IP，
  // 未来想加「一键复制 IP」按钮也只需读这一个字段。
  if (detectedIp) err.detectedIp = detectedIp;
  // 40007 专用：让上层（service-worker / UI / 客服工单）都能直接读到 hint 内的诊断码，
  // 而不必再从 message 字符串里 regex 二次解析。
  if (detectedMediaIdHint) err.detectedMediaIdHint = detectedMediaIdHint;
  return err;
}

/**
 * 从微信 errcode=40164 的 errmsg 里提取出口 IP。
 *
 * 微信实际 errmsg 形态（已踩坑确认，见 aliyun-fc/wechat-api-proxy/README.md）：
 *   "invalid ip 1.2.3.4, not in whitelist hint: [xxxx]"
 *   "invalid ip 240e:abcd:1234::1, not in whitelist"
 *   "invalid ip 1.2.3.4 ipv6 ::ffff:1.2.3.4, not in whitelist"  ← 双栈机器
 *
 * 返回空字符串表示无法解析，调用方需要回落到通用文案。
 *
 * @param {string} errmsg
 * @returns {string}
 */
export function extractWechatIpFromErrmsg(errmsg) {
  const text = String(errmsg || "");
  if (!text) return "";
  // ipv4 优先：用户更熟悉、更易复制粘贴；同时避开 ::ffff:1.2.3.4 这种 ipv4-mapped ipv6 形式
  // 直接抽到外层 ipv4 数字段（最常见的家用宽带/办公网都是 ipv4）。
  const ipv4 = text.match(
    /\b(?:25[0-5]|2[0-4]\d|[01]?\d?\d)(?:\.(?:25[0-5]|2[0-4]\d|[01]?\d?\d)){3}\b/
  );
  if (ipv4) return ipv4[0];
  // ipv6：第一段 hex + 至少 2 个 ":[hex]{0,4}"（{0,4} 允许 :: 缩写形成空段，
  // 比如 "240e:abcd:1234::1" 里的 ":" 本身可被 ":[hex]{0,4}" 中 hex 取 0 个匹配）。
  // 不能用 \b 边界——\b 是字母数字与非字母数字的分界，:: 会让 \b 在中间断掉，匹配不到完整地址。
  const ipv6 = text.match(/[0-9a-fA-F]{1,4}(?::[0-9a-fA-F]{0,4}){2,7}/);
  if (ipv6) return ipv6[0].replace(/^::ffff:/i, "");
  return "";
}

/**
 * 从微信 errcode=40007 的 errmsg 里提取 hint 诊断码。
 *
 * 微信实际 errmsg 形态（从用户工单 + 公众号 add_draft 接口实测确认）：
 *   "invalid media_id hint: [fbk5ma021425-1] rid: 69ed8aad-06b2948c-21cc5eea"
 *   "invalid media_id hint: [a1b2c3d4-5] rid: ..."
 *
 * hint 里的诊断码（如 `fbk5ma021425-1`）是微信内部 trace，业务侧无法直接解，
 * 但客服 / 微信工单提交时凭这个码能精确定位到具体素材记录。
 *
 * 返回空字符串表示无法解析；调用方应回落到通用文案。
 *
 * @param {string} errmsg
 * @returns {string}
 */
export function extractWechatMediaIdHintFromErrmsg(errmsg) {
  const text = String(errmsg || "");
  if (!text) return "";
  // hint 标准形态："hint: [xxxx]"，xxxx 由字母 / 数字 / 下划线 / 连字符组成
  // 不限定大小写、不强制 hint 必须紧跟 invalid media_id（微信偶尔在 hint 前插不同短语）
  const match = text.match(/hint\s*:\s*\[([\w-]+)\]/i);
  return match ? match[1] : "";
}

function mapWechatConnectionError(payload, status) {
  // 优先走 catalog；catalog 里没有的 errcode 兜底用 status code 解释。
  if (payload?.errcode) {
    const known = WECHAT_ERROR_CATALOG[payload.errcode];
    if (known) {
      return `${known.message}（errmsg=${payload.errmsg || "无"}）`;
    }
    return payload?.errmsg
      ? `微信返回 errcode=${payload.errcode}，errmsg=${payload.errmsg}`
      : `微信返回未知错误码 ${payload.errcode}`;
  }

  if (status === 401 || status === 403) {
    return "公众号凭证无效，请检查 AppID 和 AppSecret。";
  }

  if (status === 404) {
    return "微信验证接口地址异常，请稍后再试。";
  }

  return payload?.errmsg || `微信接口返回错误，状态码 ${status}。`;
}

function mapWechatRuntimeError(error) {
  if (error?.name === "AbortError") {
    return "请求超时，请检查网络或微信接口状态。";
  }

  const message = String(error?.message || "");
  if (/failed to fetch|networkerror|load failed/i.test(message)) {
    return "微信接口不可达，请检查网络连接。";
  }

  return message || "验证失败，请稍后再试。";
}

/**
 * 公众号 upload 接口对 filename 后缀很敏感（不匹配 blob.type 时会返回 40005 / 40113），
 * 所以这里强制：先剥掉所有原后缀，再按真实 mimeType 加唯一正确的后缀。
 *
 * 这能解决：
 *   - 原 src 是 .webp/.avif/.svg 但已被我们转码成 png/jpeg
 *   - 原 src 没有后缀（动态路由 / 加密资源）
 *   - 原 src 后缀是 .jfif / .jpe / .jpg 但 blob.type 实际为 image/jpeg
 */
function normalizeFilename(filename, mimeType) {
  const stem = String(filename || "image")
    .replace(/\.[a-z0-9]+$/i, "")
    .replace(/[^\w\u4e00-\u9fa5-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64) || "image";

  const ext = extensionForMime(mimeType);
  return `${stem}.${ext}`;
}

function extensionForMime(mimeType) {
  switch (String(mimeType || "").toLowerCase()) {
    case "image/jpeg":
    case "image/jpg":
      return "jpg";
    case "image/gif":
      return "gif";
    case "image/bmp":
      return "bmp";
    case "image/png":
    default:
      return "png";
  }
}
