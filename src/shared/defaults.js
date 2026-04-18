export const STORAGE_KEYS = {
  settings: "wechatWriterSettings",
  session: "wechatWriterSession",
  draftHistory: "__draft_history"
};

export const DEFAULT_SETTINGS = {
  productName: "公众号改写排版台",
  operatorName: "",
  supportEmail: "",
  officialSiteUrl: "",
  apiBaseUrl: "https://api.openai.com/v1/chat/completions",
  apiKey: "",
  model: "gpt-4.1-mini",
  temperature: 0.8,
  defaultAudience: "关注商业、效率和 AI 工具的公众号读者",
  defaultTone: "专业、可信、像有判断的编辑在写",
  defaultLength: "medium",
  defaultAngle: "提炼观点，重组结构，保留事实",
  defaultCta: "在结尾给出一个可执行的行动建议",
  wechatAppId: "",
  wechatAppSecret: "",
  wechatDefaultAuthor: "",
  wechatDefaultSourceUrl: "",
  wechatDefaultPublishMode: "draft",
  wechatDefaultOpenComment: false,
  wechatDefaultOnlyFansCanComment: false,
  wechatProfiles: [],
  activeWechatProfileIndex: -1,
  rsshubBaseUrl: "https://rsshub.app"
};

export const DEFAULT_ARTICLE_META = {
  title: "",
  subtitle: "",
  lead: "",
  cta: "",
  author: "",
  digest: "",
  contentSourceUrl: "",
  coverImageIndex: 0,
  titleOptions: [],
  keywords: [],
  needOpenComment: false,
  onlyFansCanComment: false,
  publishMode: "draft"
};

export const MAX_WECHAT_ARTICLES = 8;
export const WECHAT_WEB_EDITOR_URL = "https://mp.weixin.qq.com/cgi-bin/appmsg";

export const DEFAULT_SESSION = {
  lastSourceTabId: null,
  lastSourceTitle: "",
  lastSourceUrl: "",
  lastCapture: null,
  lastDraft: null,
  articleBundle: [],
  currentArticleIndex: 0,
  lastBodyHtml: "",
  lastArticleMeta: DEFAULT_ARTICLE_META,
  lastTheme: "editorial-green",
  lastPublishResult: null,
  lastWebSyncResult: null,
  selectedImageIndex: 0
};

export const LENGTH_LABELS = {
  short: "800-1200 字",
  medium: "1200-1800 字",
  long: "1800-2600 字"
};

export const THEME_PRESETS = {
  "editorial-green": {
    label: "新叶专栏",
    root:
      "font-family:'IBM Plex Sans','PingFang SC','Hiragino Sans GB',sans-serif;color:#203127;line-height:1.9;font-size:16px;background:#fffdf7;padding:32px 24px;border:1px solid #d7dbc8;border-radius:24px;",
    h1:
      "font-family:'Source Han Serif SC','Noto Serif SC',serif;font-size:34px;line-height:1.25;color:#18351f;margin:0 0 14px;font-weight:700;letter-spacing:0.02em;",
    subtitle:
      "font-size:15px;line-height:1.8;color:#5f6e61;margin:0 0 20px;padding-bottom:18px;border-bottom:1px solid #d7dbc8;",
    lead:
      "font-size:18px;line-height:1.95;color:#233528;background:#f3f5ea;border-left:4px solid #6b8f71;padding:16px 18px;border-radius:14px;margin:0 0 22px;",
    h2:
      "font-family:'Source Han Serif SC','Noto Serif SC',serif;font-size:25px;line-height:1.45;color:#173722;margin:34px 0 14px;padding-left:14px;border-left:5px solid #6b8f71;",
    h3:
      "font-size:19px;line-height:1.6;color:#284136;margin:24px 0 12px;font-weight:700;",
    p: "margin:0 0 16px;color:#243328;",
    blockquote:
      "margin:22px 0;padding:18px 22px;background:#f3f5ea;border-radius:16px;color:#2d4535;border:1px solid #d7dbc8;",
    list: "margin:0 0 18px 0;padding-left:1.35em;color:#243328;",
    li: "margin:0 0 10px;",
    figure:
      "margin:28px 0;padding:14px;background:#f8f6ef;border:1px solid #e5dfcf;border-radius:18px;",
    image:
      "display:block;width:100%;border-radius:12px;object-fit:cover;max-height:460px;background:#edf1e4;",
    figcaption:
      "margin-top:10px;font-size:13px;color:#7a745f;text-align:center;line-height:1.7;",
    hr: "border:none;border-top:1px solid #d7dbc8;margin:26px 0;",
    strong: "color:#173722;font-weight:700;",
    cta:
      "margin-top:30px;padding:18px 20px;background:#18351f;color:#f6f5ef;border-radius:18px;"
  },
  "modern-amber": {
    label: "琥珀简报",
    root:
      "font-family:'IBM Plex Sans','PingFang SC','Hiragino Sans GB',sans-serif;color:#28211b;line-height:1.85;font-size:16px;background:#fffaf2;padding:32px 24px;border:1px solid #eadcc7;border-radius:24px;",
    h1:
      "font-family:'Source Han Serif SC','Noto Serif SC',serif;font-size:34px;line-height:1.24;color:#2f2214;margin:0 0 14px;font-weight:700;",
    subtitle:
      "font-size:15px;line-height:1.8;color:#7d6a58;margin:0 0 20px;padding-bottom:18px;border-bottom:1px solid #eadcc7;",
    lead:
      "font-size:18px;line-height:1.95;color:#38281c;background:#fff1dd;border-left:4px solid #cf8c43;padding:16px 18px;border-radius:14px;margin:0 0 22px;",
    h2:
      "font-family:'Source Han Serif SC','Noto Serif SC',serif;font-size:25px;line-height:1.45;color:#2c2118;margin:34px 0 14px;padding-bottom:8px;border-bottom:2px solid #cf8c43;",
    h3:
      "font-size:19px;line-height:1.6;color:#5b3f23;margin:24px 0 12px;font-weight:700;",
    p: "margin:0 0 16px;color:#2b231d;",
    blockquote:
      "margin:22px 0;padding:18px 22px;background:#fff1dd;border-radius:16px;color:#563d29;border:1px solid #eadcc7;",
    list: "margin:0 0 18px 0;padding-left:1.35em;color:#2b231d;",
    li: "margin:0 0 10px;",
    figure:
      "margin:28px 0;padding:14px;background:#fff7eb;border:1px solid #eadcc7;border-radius:18px;",
    image:
      "display:block;width:100%;border-radius:12px;object-fit:cover;max-height:460px;background:#f5ecde;",
    figcaption:
      "margin-top:10px;font-size:13px;color:#90745c;text-align:center;line-height:1.7;",
    hr: "border:none;border-top:1px solid #eadcc7;margin:26px 0;",
    strong: "color:#5b3f23;font-weight:700;",
    cta:
      "margin-top:30px;padding:18px 20px;background:#4b3119;color:#fff9f0;border-radius:18px;"
  },
  "tech-blue": {
    label: "深海观察",
    root:
      "font-family:'IBM Plex Sans','PingFang SC','Hiragino Sans GB',sans-serif;color:#12253d;line-height:1.85;font-size:16px;background:#f8fbff;padding:32px 24px;border:1px solid #d7e4f2;border-radius:24px;",
    h1:
      "font-family:'Source Han Serif SC','Noto Serif SC',serif;font-size:34px;line-height:1.24;color:#10253f;margin:0 0 14px;font-weight:700;",
    subtitle:
      "font-size:15px;line-height:1.8;color:#5f7892;margin:0 0 20px;padding-bottom:18px;border-bottom:1px solid #d7e4f2;",
    lead:
      "font-size:18px;line-height:1.95;color:#16314d;background:#eef6ff;border-left:4px solid #4f83c2;padding:16px 18px;border-radius:14px;margin:0 0 22px;",
    h2:
      "font-family:'Source Han Serif SC','Noto Serif SC',serif;font-size:25px;line-height:1.45;color:#0f2944;margin:34px 0 14px;padding-left:14px;border-left:5px solid #4f83c2;",
    h3:
      "font-size:19px;line-height:1.6;color:#274b74;margin:24px 0 12px;font-weight:700;",
    p: "margin:0 0 16px;color:#12253d;",
    blockquote:
      "margin:22px 0;padding:18px 22px;background:#eef6ff;border-radius:16px;color:#1c3b5d;border:1px solid #d7e4f2;",
    list: "margin:0 0 18px 0;padding-left:1.35em;color:#12253d;",
    li: "margin:0 0 10px;",
    figure:
      "margin:28px 0;padding:14px;background:#f3f8fe;border:1px solid #d7e4f2;border-radius:18px;",
    image:
      "display:block;width:100%;border-radius:12px;object-fit:cover;max-height:460px;background:#dbe7f2;",
    figcaption:
      "margin-top:10px;font-size:13px;color:#6482a4;text-align:center;line-height:1.7;",
    hr: "border:none;border-top:1px solid #d7e4f2;margin:26px 0;",
    strong: "color:#0f2944;font-weight:700;",
    cta:
      "margin-top:30px;padding:18px 20px;background:#10253f;color:#f5fbff;border-radius:18px;"
  }
};
