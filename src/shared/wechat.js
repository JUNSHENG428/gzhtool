const TOKEN_URL = "https://api.weixin.qq.com/cgi-bin/token";
const UPLOAD_ARTICLE_IMAGE_URL = "https://api.weixin.qq.com/cgi-bin/media/uploadimg";
const ADD_MATERIAL_URL = "https://api.weixin.qq.com/cgi-bin/material/add_material";
const ADD_DRAFT_URL = "https://api.weixin.qq.com/cgi-bin/draft/add";
const SUBMIT_PUBLISH_URL = "https://api.weixin.qq.com/cgi-bin/freepublish/submit";
const GET_PUBLISH_STATUS_URL = "https://api.weixin.qq.com/cgi-bin/freepublish/get";

const COMPATIBLE_IMAGE_TYPES = new Set([
  "image/jpeg",
  "image/png",
  "image/gif",
  "image/bmp"
]);

const STATUS_TEXT = {
  0: "发布成功",
  1: "发布中",
  2: "原创校验失败",
  3: "常规失败",
  4: "平台审核不通过",
  5: "发布成功后被用户删除",
  6: "发布成功后被系统封禁"
};

export async function publishToWechat(settings, payload) {
  validateSettings(settings);
  validatePublishPayload(payload);

  const accessToken = await getAccessToken(settings);
  const preparedArticles = [];
  let totalImageCount = 0;

  const allFailedImages = [];

  for (const [index, article] of payload.articles.entries()) {
    const { replacements, failedImages } = await uploadInlineImages(accessToken, article.inlineImages || []);
    const contentHtml = applyImageReplacements(article.html, replacements);

    if (failedImages.length > 0) {
      for (const fail of failedImages) {
        fail.articleIndex = index + 1;
      }
      allFailedImages.push(...failedImages);
    }

    if (contentHtml.length > 20000) {
      throw new Error(`第 ${index + 1} 篇正文 HTML 超过公众号接口 2 万字符限制。`);
    }

    let coverMediaId = "";
    try {
      const coverBlob = await fetchImageBlob(article.cover.src);
      const coverCompatibleBlob = await ensureCompatibleImageBlob(coverBlob);
      coverMediaId = await uploadPermanentImage(
        accessToken,
        coverCompatibleBlob,
        article.cover.filename || `cover-${index + 1}.png`
      );
    } catch (error) {
      allFailedImages.push({
        type: "cover",
        src: article.cover.src,
        filename: article.cover.filename || `cover-${index + 1}.png`,
        articleIndex: index + 1,
        error: error.message || "封面上传失败"
      });
    }

    totalImageCount += Object.keys(replacements).length;
    preparedArticles.push({
      ...article.meta,
      contentHtml,
      thumbMediaId: coverMediaId
    });
  }

  const draftMediaId = await createDraft(accessToken, preparedArticles);

  if (payload.publishMode === "publish") {
    const publishId = await submitPublish(accessToken, draftMediaId);
    return {
      draftMediaId,
      publishId,
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
  return getPublishStatus(accessToken, publishId);
}

export async function testWechatConnection({ appId, appSecret, timeoutMs = 12000 }) {
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

  const url = new URL(TOKEN_URL);
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
      return {
        ok: false,
        latencyMs,
        error: mapWechatConnectionError(payload, response.status)
      };
    }

    if (!payload.access_token) {
      return {
        ok: false,
        latencyMs,
        error: "验证失败，公众号接口没有返回 access token。"
      };
    }

    return {
      ok: true,
      latencyMs,
      error: ""
    };
  } catch (error) {
    return {
      ok: false,
      latencyMs: Date.now() - startedAt,
      error: mapWechatRuntimeError(error)
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
      throw new Error(`第 ${index + 1} 篇还没有封面图。`);
    }
  }
}

async function getAccessToken(settings) {
  const url = new URL(TOKEN_URL);
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

async function uploadInlineImages(accessToken, inlineImages) {
  const replacements = {};
  const failedImages = [];

  for (const image of inlineImages) {
    try {
      const blob = await fetchImageBlob(image.src);
      const compatibleBlob = await ensureCompatibleImageBlob(blob);
      const uploadedUrl = await uploadArticleImage(
        accessToken,
        compatibleBlob,
        image.filename || "inline.png"
      );
      replacements[image.token] = uploadedUrl;
    } catch (error) {
      failedImages.push({
        type: "inline",
        src: image.src,
        filename: image.filename || "inline.png",
        token: image.token,
        error: error.message || "上传失败"
      });
    }
  }

  return { replacements, failedImages };
}

async function uploadArticleImage(accessToken, blob, filename) {
  const url = new URL(UPLOAD_ARTICLE_IMAGE_URL);
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

async function uploadPermanentImage(accessToken, blob, filename) {
  const url = new URL(ADD_MATERIAL_URL);
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

async function createDraft(accessToken, articles) {
  const url = new URL(ADD_DRAFT_URL);
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

async function submitPublish(accessToken, mediaId) {
  const url = new URL(SUBMIT_PUBLISH_URL);
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

async function getPublishStatus(accessToken, publishId) {
  const url = new URL(GET_PUBLISH_STATUS_URL);
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

async function fetchImageBlob(src) {
  const response = await fetch(src, {
    method: "GET",
    cache: "no-store"
  });

  if (!response.ok) {
    throw new Error(`下载图片失败：${src}`);
  }

  return response.blob();
}

async function ensureCompatibleImageBlob(blob) {
  if (COMPATIBLE_IMAGE_TYPES.has(blob.type)) {
    return blob;
  }

  if (!blob.type.startsWith("image/")) {
    throw new Error(`公众号不支持的素材类型：${blob.type || "未知类型"}`);
  }

  if (typeof OffscreenCanvas === "undefined" || typeof createImageBitmap === "undefined") {
    return blob;
  }

  const imageBitmap = await createImageBitmap(blob);
  const canvas = new OffscreenCanvas(imageBitmap.width, imageBitmap.height);
  const context = canvas.getContext("2d");
  context.drawImage(imageBitmap, 0, 0);
  const converted = await canvas.convertToBlob({
    type: "image/png",
    quality: 0.92
  });
  imageBitmap.close?.();
  return converted;
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

function ensureWechatOk(response, payload, fallback) {
  if (response.ok && !payload?.errcode) {
    return;
  }

  let message = payload?.errmsg || fallback;
  if (payload?.errcode === 40164) {
    message += "。公众号接口可能开启了 IP 白名单，请把当前出口 IP 加到公众号后台。";
  }

  throw new Error(message);
}

function mapWechatConnectionError(payload, status) {
  if (payload?.errcode === 40013) {
    return "AppID 无效，请检查公众号 AppID。";
  }

  if (payload?.errcode === 40125) {
    return "AppSecret 无效，请检查公众号 AppSecret。";
  }

  if (payload?.errcode === 40164) {
    return "验证失败：公众号后台开启了 IP 白名单，请先把当前出口 IP 加入开发配置。";
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

function normalizeFilename(filename, mimeType) {
  const safeName = String(filename || "image")
    .replace(/[^\w.\u4e00-\u9fa5-]+/g, "-")
    .replace(/-+/g, "-");

  if (/\.[a-z0-9]+$/i.test(safeName)) {
    return safeName;
  }

  if (mimeType === "image/jpeg") return `${safeName}.jpg`;
  if (mimeType === "image/gif") return `${safeName}.gif`;
  if (mimeType === "image/bmp") return `${safeName}.bmp`;
  return `${safeName}.png`;
}
