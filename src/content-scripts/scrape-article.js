/**
 * 注入到目标网页隔离环境，供 chrome.scripting.executeScript({ files }) 加载。
 * 导出 window.__gzhRunFullCapture：先滚动展开懒加载内容，再抽取正文与图片。
 *
 * 输出 block 类型：
 *  - heading   { type, level, text }
 *  - paragraph { type, text }
 *  - quote     { type, text }
 *  - list      { type, ordered, items: [text...] }
 *  - code      { type, language, text }
 *  - table     { type, headers: [...], rows: [[...]] }
 *  - image     { type, index, src, alt, caption }
 */
(function registerGzhScraper() {
  if (typeof window.__gzhRunFullCapture === "function") {
    return;
  }

  // share/social 必须用词边界：GitHub CSS modules 常见 SharedPageLayout /
  // SharedMarkdownContent，裸写 share 会把整篇 README 当噪声滤掉。
  const BOILERPLATE_RE =
    /comment|comments?-list|disqus|sidebar|widget|related|recommend|\bshare\b|\bsocial\b|breadcrumb|toolbar|advert|ad-|ads-|promo|subscribe|newsletter|footer|header-nav|reading-list|toc-|table-of|author-bio|meta-info|hentry-meta|post-tags|post-categories|next-prev|pagination|wp-block-latest|outbrain|taboola|prevnext|paywall|signup|cta-block|popup-overlay|modal-backdrop|cookie-banner|consent-banner|notification-bar|trending-list|popular-list|more-from|read-next|continue-reading|see-also|reaction-bar|engagement-bar|byline-block|tip-jar|membership-cta|mailing-list/i;

  /**
   * 域名特化提取规则（38th 续 7）：通用 ROOT_SELECTORS 在大型 SPA 站点上经常
   * 选错根（命中 article 但内部全是骨架占位 / 命中 main 但混了大量推荐位）。
   * 这里给热门站点配优先级最高的精准 selector，命中它们时直接用，跳过通用打分。
   *
   * 维护方式：每个 hostname 配一个或多个 selector pattern；以"内容容器选择器
   * 优先 → 兜底通用 article" 的顺序排列。新加站点只往 SITE_RULES 里追加，
   * 不要修改通用 ROOT_SELECTORS / BOILERPLATE_RE。
   */
  const SITE_RULES = [
    {
      // perplexity AI discover / search 答案页
      hostMatch: /(^|\.)perplexity\.ai$/i,
      rootSelectors: [
        "main [data-testid='answer']",
        "main .prose",
        "[class*='AnswerSection']",
        "[class*='answer-content']"
      ],
      // 排除右侧 sources 列表 + 相关问题 + 后续追问输入
      extraBoilerplate: /sources-list|related-questions|follow-up|search-bar|user-input/i
    },
    {
      // substack 文章页
      hostMatch: /(^|\.)substack\.com$/i,
      rootSelectors: [
        ".post-content",
        ".body.markup",
        "article .available-content"
      ],
      extraBoilerplate: /subscribe-widget|share-dialog|comment-list|button-wrapper|topbar|tip-jar|paid-only/i
    },
    {
      // medium 文章页
      hostMatch: /(^|\.)medium\.com$/i,
      rootSelectors: [
        "article section",
        "article",
        "[data-testid='storyContent']",
        "[class*='postArticle']"
      ],
      extraBoilerplate: /follow-button|clap-button|response-list|recommended-list|membership-pitch/i
    },
    {
      // 知乎答案 / 文章
      hostMatch: /(^|\.)zhihu\.com$/i,
      rootSelectors: [
        ".RichContent-inner",
        ".Post-RichTextContainer",
        ".AnswerCard .RichContent",
        "article .Post-RichText"
      ],
      extraBoilerplate: /AnswerActions|VoteButton|CommentItem|RelatedAnswers|Reward|Sticky|App-Banner/i
    },
    {
      // 微信公众号文章（与现有 ROOT_SELECTORS rich_media_content 一致，但加强 boilerplate）
      hostMatch: /(^|\.)mp\.weixin\.qq\.com$/i,
      rootSelectors: [
        "#js_content",
        ".rich_media_content",
        ".rich_media_area_primary_inner"
      ],
      extraBoilerplate: /js_pc_qr_code|reward_qrcode|share_notice|follow_widget|profile_inner/i
    },
    {
      // 36 氪
      hostMatch: /(^|\.)36kr\.com$/i,
      rootSelectors: [".article-content", "article"],
      extraBoilerplate: /related-articles|hot-articles|tag-list|action-bar/i
    },
    {
      // 简书
      hostMatch: /(^|\.)jianshu\.com$/i,
      rootSelectors: ["article", "._gp-ck", ".ouvJEz"],
      extraBoilerplate: /note-bottom|recommended-notes|signup-modal/i
    },
    {
      // GitHub README / blob：正文在 article.markdown-body；外层常有
      // SharedPageLayout / SharedMarkdownContent（CSS modules），若 root 落到
      // body/main，旧 BOILERPLATE 的 share 子串会把块全滤光。
      hostMatch: /(^|\.)github\.com$/i,
      rootSelectors: [
        "article.markdown-body",
        ".markdown-body",
        "#readme article",
        "#readme"
      ],
      extraBoilerplate: /LayoutHeader|AppHeader|prc-Dialog|react-file-name|Box-header|js-repo-nav/i
    }
  ];

  function getSiteRule() {
    const host = (location.hostname || "").toLowerCase();
    if (!host) return null;
    return SITE_RULES.find((rule) => rule.hostMatch.test(host)) || null;
  }

  const SKIP_TAGS = new Set([
    "NAV",
    "HEADER",
    "FOOTER",
    "ASIDE",
    "FORM",
    "BUTTON",
    "SCRIPT",
    "STYLE",
    "NOSCRIPT",
    "SVG",
    "CANVAS",
    "IFRAME",
    "TEMPLATE",
    "DIALOG"
  ]);

  // 走 TreeWalker 时只接受这些块级节点；OL/UL/TABLE/PRE 整个当一个块处理
  const BLOCK_TAGS = new Set([
    "H1",
    "H2",
    "H3",
    "H4",
    "H5",
    "H6",
    "P",
    "BLOCKQUOTE",
    "PRE",
    "OL",
    "UL",
    "TABLE",
    "FIGURE",
    "IMG",
    "FIGCAPTION"
  ]);

  const ROOT_SELECTORS = [
    "article",
    "main",
    "[role='main']",
    "[role='article']",
    ".article",
    ".article-content",
    ".article-body",
    ".article__body",
    ".post-content",
    ".post-body",
    ".entry-content",
    ".post__content",
    ".content-article",
    ".s-content",
    ".note-content",
    ".rich_media_content",
    ".rich_media_area_primary_inner",
    "#js_content",
    "#article-content",
    ".markdown-body",
    ".markdown",
    ".prose",
    ".typo",
    ".content_area",
    ".znc",
    ".richtext"
  ];

  // 模块二用：本次 extractArticleFromPage 调用范围内的候选遮罩层列表。
  // 挂在 IIFE 作用域而不是逐层传参，是因为 getVisibleText / extractListBlock /
  // extractTableBlock / extractFigureBlock 这些辅助函数调用点很多，逐个改签名
  // 收益不大；同一次抓取内不会有并发调用，模块级变量足够安全。
  let activeOverlayCandidates = [];

  /**
   * 反爬 CSS 隐藏元素识别（移植自 boss直聘JD净化提取/jd_extractor.py 的实战
   * 经验）：命中 display:none / visibility:hidden / font-size≈0 / opacity≈0 /
   * 定位到可视区域外的绝对定位元素，判定为"人眼看不到、只用来塞垂圾字符
   * 干扰爬虫"的节点。
   */
  function isVisibleForCapture(el) {
    if (!el || el.nodeType !== 1) return true;
    let style;
    try {
      style = window.getComputedStyle(el);
    } catch (_) {
      return true;
    }
    if (!style) return true;
    if (style.display === "none") return false;
    if (style.visibility === "hidden" || style.visibility === "collapse") return false;
    const fontSize = parseFloat(style.fontSize);
    if (!Number.isNaN(fontSize) && fontSize <= 1) return false;
    const opacity = parseFloat(style.opacity);
    if (!Number.isNaN(opacity) && opacity <= 0.05) return false;
    if (style.position === "absolute" || style.position === "fixed") {
      let rect = null;
      try {
        rect = el.getBoundingClientRect();
      } catch (_) {}
      if (rect && (rect.width > 0 || rect.height > 0)) {
        if (rect.right < -50 || rect.bottom < -50) return false;
        const vw = window.innerWidth || document.documentElement.clientWidth || 0;
        if (rect.left > vw + 2000 || rect.top > 20000) return false;
      }
    }
    return true;
  }

  /**
   * 取代直接用 .textContent —— 跳过夹在段落/标题/列表项/表格单元格内部的
   * CSS 隐藏干扰节点（比如 <span style="display:none">kanzhun</span>），
   * 以及被 z-index 遮罩盖住的"假"文字层（模块二），只拼接真正参与渲染、
   * 视觉上最终可见的文字。命中率极低时开销可忽略：绝大多数块内部既没有
   * 隐藏子节点也没有重叠遮罩，TreeWalker 会直接原样走完，`activeOverlayCandidates`
   * 为空数组时 `isVisuallyMaskedByOverlay` 直接短路。
   *
   * z-index 遮罩要在这一层（逐个祖先元素）判断而不是整块判断，是因为真实
   * 场景里遮罩通常只盖住段落里的一小段（比如一句话中间的薪资数字），
   * 拿整段的包围盒去和遮罩比重叠面积会算不出有意义的比例。
   */
  function getVisibleText(blockEl) {
    if (!blockEl) return "";
    const hiddenCache = new Map();
    function ancestorHidden(startEl) {
      let current = startEl;
      while (current) {
        if (hiddenCache.has(current)) {
          if (hiddenCache.get(current)) return true;
        } else {
          const hidden =
            !isVisibleForCapture(current) ||
            (activeOverlayCandidates.length > 0 &&
              isVisuallyMaskedByOverlay(current, activeOverlayCandidates));
          hiddenCache.set(current, hidden);
          if (hidden) return true;
        }
        if (current === blockEl) break;
        current = current.parentElement;
      }
      return false;
    }

    let out = "";
    const walker = document.createTreeWalker(blockEl, NodeFilter.SHOW_TEXT, {
      acceptNode(textNode) {
        return ancestorHidden(textNode.parentElement)
          ? NodeFilter.FILTER_SKIP
          : NodeFilter.FILTER_ACCEPT;
      }
    });
    let node = walker.nextNode();
    while (node) {
      out += node.nodeValue;
      node = walker.nextNode();
    }
    return out;
  }

  /**
   * z-index 遮罩识别（移植自 boss直聘JD净化提取 的实战经验）：只收集"定位
   * （absolute/fixed）+ 自带文字内容"的元素作候选遮罩层。
   *
   * 为什么只看"自带文字"的：当前抓取是直接读 DOM textContent，不是模拟
   * 鼠标选中/复制，所以"遮罩层本身没有文字、纯粹用来劫持选中"这种最常见
   * 的反爬手法天然不受影响（真实文字该在哪还在哪）。唯一会污染结果的是
   * "遮罩层自己也带假文字"这种更激进的变体——此时视觉上遮罩才是最终显示
   * 的那一层，底下真实文字理应被抑制。这个函数只在整个 root 里跑一次，
   * 绝大多数正常网站结果是空数组，后续判断直接短路。
   */
  function findOverlayMaskCandidates(root) {
    const candidates = [];
    let all;
    try {
      all = root.querySelectorAll("*");
    } catch (_) {
      return candidates;
    }
    for (const el of all) {
      let style;
      try {
        style = window.getComputedStyle(el);
      } catch (_) {
        continue;
      }
      if (style.position !== "absolute" && style.position !== "fixed") continue;
      const text = (el.textContent || "").trim();
      if (!text) continue;
      let rect = null;
      try {
        rect = el.getBoundingClientRect();
      } catch (_) {}
      if (!rect || rect.width <= 0 || rect.height <= 0) continue;
      candidates.push({ el, rect });
    }
    return candidates;
  }

  function bboxOverlapRatio(rectA, rectB) {
    const left = Math.max(rectA.left, rectB.left);
    const right = Math.min(rectA.right, rectB.right);
    const top = Math.max(rectA.top, rectB.top);
    const bottom = Math.min(rectA.bottom, rectB.bottom);
    if (right <= left || bottom <= top) return 0;
    const overlapArea = (right - left) * (bottom - top);
    const areaA = rectA.width * rectA.height;
    if (areaA <= 0) return 0;
    return overlapArea / areaA;
  }

  /**
   * 只有候选遮罩列表非空时才会被调用；先用廉价的 bbox 重叠比例预筛，
   * 重叠比例达阈值才对该点做一次 elementFromPoint 精确确认最终视觉最上层
   * 到底是谁——把最贵的那一步压缩到极少数真正可能重叠的块上。
   */
  function isVisuallyMaskedByOverlay(node, overlayCandidates) {
    let rect = null;
    try {
      rect = node.getBoundingClientRect();
    } catch (_) {}
    if (!rect || rect.width <= 0 || rect.height <= 0) return false;

    const vw = window.innerWidth || document.documentElement.clientWidth || 0;
    const vh = window.innerHeight || document.documentElement.clientHeight || 0;

    for (const candidate of overlayCandidates) {
      const overlayEl = candidate.el;
      if (overlayEl === node || overlayEl.contains(node) || node.contains(overlayEl)) continue;
      if (bboxOverlapRatio(rect, candidate.rect) < 0.6) continue;

      const cx = Math.min(Math.max(rect.left + rect.width / 2, 0), vw - 1);
      const cy = Math.min(Math.max(rect.top + rect.height / 2, 0), vh - 1);
      if (cx < 0 || cy < 0 || cx >= vw || cy >= vh) continue;

      let topEl = null;
      try {
        topEl = document.elementFromPoint(cx, cy);
      } catch (_) {}
      if (!topEl || topEl === node || node.contains(topEl) || topEl.contains(node)) continue;
      if (topEl === overlayEl || overlayEl.contains(topEl)) {
        return true;
      }
    }
    return false;
  }

  // ── 模块三：自定义字体反爬还原（浏览器端 canvas 版，移植自
  // boss直聘JD净化提取/jd_extractor.py 的字形位图哈希比对思路）──
  //
  // 与 Python 版的关键差异：content script 跑在真实浏览器里，字体已经被
  // 页面自己加载并渲染给用户看过了——不需要下载字体文件、不需要 fonttools
  // 解析 glyph，只要用 <canvas> 把"可疑字符"用页面声明的字体画出来，和
  // "候选真实字符"用系统字体画出来的位图做哈希比对即可。

  const PUA_CHAR_RE = /[\uE000-\uF8FF]/;
  const FONT_HASH_SIZE = 24;
  const FONT_RENDER_SIZE = 96;
  const FONT_MATCH_THRESHOLD = 60;
  const FONT_CANDIDATE_CHARS = "0123456789.,%+-·/年月日周天时分~";
  const FONT_MAPPING_CACHE_TTL_MS = 24 * 60 * 60 * 1000;
  const fontMappingMemoryCache = new Map();

  function collectPuaCharsFromBlocks(blocks) {
    const chars = new Set();
    for (const block of blocks) {
      for (const text of blockTextFields(block)) {
        for (const ch of text) {
          if (PUA_CHAR_RE.test(ch)) chars.add(ch);
        }
      }
    }
    return chars;
  }

  function blockTextFields(block) {
    const fields = [];
    if (typeof block.text === "string") fields.push(block.text);
    if (Array.isArray(block.items)) fields.push(...block.items);
    if (Array.isArray(block.headers)) fields.push(...block.headers);
    if (Array.isArray(block.rows)) {
      for (const row of block.rows) fields.push(...row);
    }
    if (typeof block.caption === "string") fields.push(block.caption);
    return fields;
  }

  // 找出这个 PUA 字符实际是被哪个 font-family 渲染出来的——扫一遍 root 的
  // 文本节点，命中即返回，不需要遍历全部（PUA 字符极少见，通常一两次
  // 命中就够）。
  function resolveFontFamilyForChar(root, ch) {
    try {
      const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, null);
      let node = walker.nextNode();
      while (node) {
        if (node.nodeValue && node.nodeValue.indexOf(ch) !== -1) {
          const parent = node.parentElement;
          if (parent) {
            const style = window.getComputedStyle(parent);
            const family = (style.fontFamily || "").split(",")[0].trim().replace(/^["']|["']$/g, "");
            if (family) return family;
          }
        }
        node = walker.nextNode();
      }
    } catch (_) {}
    return "";
  }

  function dHashFromCanvas(sourceCanvas) {
    try {
      const hashSize = FONT_HASH_SIZE;
      const small = document.createElement("canvas");
      small.width = hashSize + 1;
      small.height = hashSize;
      const sctx = small.getContext("2d", { willReadFrequently: true });
      sctx.drawImage(sourceCanvas, 0, 0, FONT_RENDER_SIZE, FONT_RENDER_SIZE, 0, 0, hashSize + 1, hashSize);
      const data = sctx.getImageData(0, 0, hashSize + 1, hashSize).data;
      const gray = [];
      for (let i = 0; i < data.length; i += 4) {
        gray.push((data[i] + data[i + 1] + data[i + 2]) / 3);
      }
      const bits = [];
      for (let row = 0; row < hashSize; row++) {
        const offset = row * (hashSize + 1);
        for (let col = 0; col < hashSize; col++) {
          bits.push(gray[offset + col] > gray[offset + col + 1]);
        }
      }
      return bits;
    } catch (_) {
      return null;
    }
  }

  function renderGlyphHash(ch, fontFamilyCss) {
    try {
      const canvas = document.createElement("canvas");
      canvas.width = FONT_RENDER_SIZE;
      canvas.height = FONT_RENDER_SIZE;
      const ctx = canvas.getContext("2d", { willReadFrequently: true });
      ctx.fillStyle = "#fff";
      ctx.fillRect(0, 0, FONT_RENDER_SIZE, FONT_RENDER_SIZE);
      ctx.fillStyle = "#000";
      ctx.textBaseline = "middle";
      ctx.textAlign = "center";
      ctx.font = Math.round(FONT_RENDER_SIZE * 0.7) + "px " + fontFamilyCss;
      ctx.fillText(ch, FONT_RENDER_SIZE / 2, FONT_RENDER_SIZE / 2);
      return dHashFromCanvas(canvas);
    } catch (_) {
      return null;
    }
  }

  function hammingDistance(a, b) {
    let dist = 0;
    for (let i = 0; i < a.length; i++) {
      if (a[i] !== b[i]) dist++;
    }
    return dist;
  }

  // 只对传入的 puaChars 建映射（不是整份字体的 cmap）——我们只关心真的在
  // 这次抓取里出现过的编码点，天然避免了"字体里顺带带了普通字母的字形也
  // 被误判"这类问题（不需要像 Python 版那样特别限制只处理 PUA 编码点，
  // 因为这里从一开始就只喂 PUA 字符进来）。
  function buildFontMappingForFamily(fontFamily, puaChars) {
    const refHashes = [];
    for (const ch of FONT_CANDIDATE_CHARS) {
      const hash = renderGlyphHash(ch, "sans-serif");
      if (hash) refHashes.push({ ch, hash });
    }
    if (refHashes.length === 0) return {};

    const safeFamily = String(fontFamily || "").replace(/["'\\]/g, "");
    const fontFamilyCss = (safeFamily ? `"${safeFamily}", ` : "") + "sans-serif";

    const mapping = {};
    for (const puaChar of puaChars) {
      const glyphHash = renderGlyphHash(puaChar, fontFamilyCss);
      if (!glyphHash) continue;
      let bestChar = null;
      let bestDist = Infinity;
      for (const ref of refHashes) {
        const dist = hammingDistance(glyphHash, ref.hash);
        if (dist < bestDist) {
          bestDist = dist;
          bestChar = ref.ch;
        }
      }
      if (bestChar !== null && bestDist <= FONT_MATCH_THRESHOLD) {
        mapping[puaChar] = bestChar;
      }
    }
    return mapping;
  }

  function hasChromeSessionStorage() {
    try {
      return Boolean(
        typeof chrome !== "undefined" &&
          chrome.storage &&
          chrome.storage.session &&
          typeof chrome.storage.session.get === "function"
      );
    } catch (_) {
      return false;
    }
  }

  // 缓存优先查内存（同一次 content script 生命周期内最快），
  // chrome.storage.session 作为跨 tab/跨 capture 的最佳努力缓存——
  // DrissionPage 通道跑在纯页面上下文，没有 chrome.* API，这里全部
  // try/catch 兜底，拿不到就退化成"这次现算、不跨 capture 复用"。
  async function readFontMappingCache(cacheKey) {
    const mem = fontMappingMemoryCache.get(cacheKey);
    if (mem && Date.now() - mem.ts < FONT_MAPPING_CACHE_TTL_MS) return mem.mapping;
    if (!hasChromeSessionStorage()) return null;
    try {
      const storageKey = "gzhFontMap:" + cacheKey;
      const result = await chrome.storage.session.get(storageKey);
      const entry = result && result[storageKey];
      if (entry && Date.now() - entry.ts < FONT_MAPPING_CACHE_TTL_MS) {
        fontMappingMemoryCache.set(cacheKey, entry);
        return entry.mapping;
      }
    } catch (_) {}
    return null;
  }

  async function writeFontMappingCache(cacheKey, mapping) {
    const entry = { ts: Date.now(), mapping };
    fontMappingMemoryCache.set(cacheKey, entry);
    if (!hasChromeSessionStorage()) return;
    try {
      const storageKey = "gzhFontMap:" + cacheKey;
      await chrome.storage.session.set({ [storageKey]: entry });
    } catch (_) {}
  }

  function applyFontMappingToBlocks(blocks, mapping) {
    const replace = (text) => {
      if (typeof text !== "string" || !text) return text;
      let out = "";
      for (const ch of text) {
        out += mapping[ch] || ch;
      }
      return out;
    };
    for (const block of blocks) {
      if (typeof block.text === "string") block.text = replace(block.text);
      if (Array.isArray(block.items)) block.items = block.items.map(replace);
      if (Array.isArray(block.headers)) block.headers = block.headers.map(replace);
      if (Array.isArray(block.rows)) {
        block.rows = block.rows.map((row) => row.map(replace));
      }
      if (typeof block.caption === "string") block.caption = replace(block.caption);
    }
  }

  /**
   * 模块三主入口：先扫一次 blocks 里是否出现 Unicode 私有使用区编码点——
   * 绝大多数正常网页扫不到，直接原地返回，零开销。只有真的命中时才继续
   * 按 font-family 分组、建映射、缓存、替换。
   */
  async function restoreObfuscatedFontChars(root, blocks) {
    const puaChars = collectPuaCharsFromBlocks(blocks);
    if (puaChars.size === 0) return;

    const charsByFamily = new Map();
    for (const ch of puaChars) {
      const family = resolveFontFamilyForChar(root, ch) || "unknown";
      if (!charsByFamily.has(family)) charsByFamily.set(family, new Set());
      charsByFamily.get(family).add(ch);
    }

    const fullMapping = {};
    for (const [family, chars] of charsByFamily) {
      const cacheKey = family + "@" + location.hostname;
      let mapping = (await readFontMappingCache(cacheKey)) || {};
      const missing = new Set();
      for (const ch of chars) {
        if (!(ch in mapping)) missing.add(ch);
      }
      if (missing.size > 0) {
        const extra = buildFontMappingForFamily(family, missing);
        mapping = Object.assign({}, mapping, extra);
        await writeFontMappingCache(cacheKey, mapping);
      }
      Object.assign(fullMapping, mapping);
    }

    if (Object.keys(fullMapping).length === 0) return;
    applyFontMappingToBlocks(blocks, fullMapping);
  }

  window.__gzhRunFullCapture = async function runFullCapture(options) {
    const mode = (options && options.mode) || "readable";
    if (mode === "selection") {
      return extractSelectionFromPage();
    }
    await expandLazyContent();
    if (mode === "raw") {
      return extractArticleFromPage({ raw: true });
    }
    return extractArticleFromPage();
  };

  async function extractSelectionFromPage() {
    const sel = window.getSelection ? window.getSelection() : null;
    const raw = sel ? String(sel.toString() || "") : "";
    const text = normalizeText(raw);
    const blocks = [];
    if (text) {
      const chunks = raw
        .split(/\n{2,}/)
        .map((chunk) => normalizeText(chunk))
        .filter((chunk) => chunk.length >= 2);
      if (chunks.length > 0) {
        chunks.forEach((chunk) => blocks.push({ type: "paragraph", text: chunk }));
      } else {
        blocks.push({ type: "paragraph", text });
      }
    }
    // 字体反爬还原（模块三）：选中文字一样可能夹带自定义字体加密的编码点，
    // 复用同一套 canvas 位图哈希还原逻辑，root 用 document.body 兜底。
    await restoreObfuscatedFontChars(document.body, blocks);
    return {
      url: location.href,
      title:
        document.querySelector("meta[property='og:title']")?.getAttribute("content") ||
        document.title ||
        "",
      description: "",
      siteName:
        document.querySelector("meta[property='og:site_name']")?.getAttribute("content") || "",
      extractedAt: new Date().toISOString(),
      wordCount: text.length,
      blocks,
      images: [],
      captureMode: "selection"
    };
  }

  async function expandLazyContent() {
    const budgetMs = 4500;
    const started = Date.now();
    let lastH = 0;
    let stable = 0;

    while (Date.now() - started < budgetMs) {
      const h = document.documentElement.scrollHeight;
      window.scrollBy(0, Math.min(window.innerHeight * 0.88, 900));
      await sleep(130);
      if (h === lastH) {
        stable += 1;
        if (stable >= 4) break;
      } else {
        stable = 0;
        lastH = h;
      }
    }

    for (let i = 0; i < 10; i++) {
      window.scrollBy(0, window.innerHeight * 0.92);
      await sleep(95);
    }

    window.scrollTo(0, 0);
    await sleep(220);

    try {
      document.querySelectorAll("img[loading='lazy']").forEach((img) => {
        img.loading = "eager";
      });
      // picture/source 的 lazy 属性也尽量摸一遍
      document.querySelectorAll("img[data-src],img[data-original],img[data-lazy-src]").forEach((img) => {
        const real = resolveImageSrc(img);
        if (real && img.getAttribute("src") !== real) {
          try {
            img.setAttribute("src", real);
          } catch (_) {}
        }
      });
    } catch (_) {}

    await sleep(120);
  }

  function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  async function extractArticleFromPage(options) {
    const raw = Boolean(options && options.raw);

    // 域名特化规则优先（38th 续 7）：当前 host 命中 SITE_RULES 时，
    // 优先尝试它的 rootSelectors（精准锁定主内容容器，避开通用打分误判）。
    // 命中且非 raw 模式才用 —— raw 模式用户主动选了"全页面"。
    const siteRule = raw ? null : getSiteRule();
    const siteCandidates = siteRule
      ? siteRule.rootSelectors.flatMap((selector) => {
          try {
            return Array.from(document.querySelectorAll(selector));
          } catch {
            return [];
          }
        })
      : [];

    const candidates = raw
      ? [document.body]
      : [
          ...siteCandidates,
          ...ROOT_SELECTORS.flatMap((selector) => {
            try {
              return Array.from(document.querySelectorAll(selector));
            } catch {
              return [];
            }
          }),
          document.body
        ].filter(Boolean);

    const root = raw ? document.body : pickBestRoot(candidates);
    const images = [];
    const imageIndexByUrl = new Map();
    const textSeen = new Set();
    const blocks = [];

    // z-index 遮罩识别（移植自 boss直聘JD净化提取 的实战经验）：先做一次性
    // 全量扫描找"定位 + 自带文字"的候选遮罩层。绝大多数正常网站扫描结果
    // 是空数组，后面每个节点的判断直接短路，零额外开销；只有真的存在这类
    // 候选遮罩时，才对与它 bbox 重叠的节点做一次精确的 elementFromPoint 确认。
    activeOverlayCandidates = findOverlayMaskCandidates(root);

    // 用一个 helper 统一推图片并去重（38th 续 8 加强：装饰 URL 过滤 + 同图多 size 归并）
    function pushImage({ src, alt, caption }) {
      if (!src) return null;
      // 装饰 URL 跳过（/icons/ /badges/ /emoji/ 等路径模式）
      if (looksLikeDecorativeUrl(src)) return null;
      // 用 stripSizeParamsFromUrl 作 dedup key，让同一张图的不同 size variant 归并
      const key = stripSizeParamsFromUrl(src);
      let imageIndex = imageIndexByUrl.get(key);
      if (!imageIndex) {
        imageIndex = images.length + 1;
        images.push({
          src,
          alt: normalizeText(alt || ""),
          caption: normalizeText(caption || "")
        });
        imageIndexByUrl.set(key, imageIndex);
      } else {
        // 已有同图：保留尺寸最大版本（用 src 长度做粗粒度判断 —— 通常带 ?w=1200 比 ?w=200 长）
        // 同时合并 alt/caption（取更长的非空版本）
        const existing = images[imageIndex - 1];
        if ((src || "").length > (existing.src || "").length) {
          existing.src = src;
        }
        const newAlt = normalizeText(alt || "");
        if (newAlt && newAlt.length > (existing.alt || "").length) {
          existing.alt = newAlt;
        }
        const newCaption = normalizeText(caption || "");
        if (newCaption && newCaption.length > (existing.caption || "").length) {
          existing.caption = newCaption;
        }
      }
      const data = images[imageIndex - 1];
      return { type: "image", index: imageIndex, src: data.src, alt: data.alt, caption: data.caption };
    }

    const walker = document.createTreeWalker(
      root,
      NodeFilter.SHOW_ELEMENT,
      {
        acceptNode(node) {
          if (!BLOCK_TAGS.has(node.tagName)) {
            return NodeFilter.FILTER_SKIP;
          }
          if (hasSkippedAncestor(node, root)) {
            return NodeFilter.FILTER_REJECT;
          }
          if (!raw && hasBoilerplateAncestor(node, root)) {
            return NodeFilter.FILTER_REJECT;
          }
          if (!isVisibleForCapture(node)) {
            return NodeFilter.FILTER_REJECT;
          }
          // z-index 遮罩判断放在 getVisibleText 里逐祖先元素检查（见下），
          // 而不是在这里对整块做一次粗判——真实场景里遮罩通常只盖住块内
          // 一小段（比如一句话中间的薪资数字），对整块包围盒算重叠比例
          // 会得出没有意义的比例，还会错误地把一整块都判定成"被遮罩"。

          // OL/UL/TABLE/PRE/FIGURE 当作整块，跳过其内部的 P/H/IMG 子节点
          if (
            node.tagName === "OL" ||
            node.tagName === "UL" ||
            node.tagName === "TABLE" ||
            node.tagName === "PRE" ||
            node.tagName === "FIGURE"
          ) {
            // 排除被嵌套在更大 OL/UL/TABLE/PRE/FIGURE 里的「子级」（避免重复）
            if (insideAncestorBlock(node, root)) {
              return NodeFilter.FILTER_REJECT;
            }
            return NodeFilter.FILTER_ACCEPT;
          }

          if (node.tagName === "IMG") {
            // 已在 figure 里的图，由 figure 统一处理
            if (node.closest("figure")) {
              return NodeFilter.FILTER_SKIP;
            }
            const src = resolveImageSrc(node);
            if (!src || src.startsWith("data:") || isTinyTrackingUrl(src) || looksLikeDecorativeUrl(src)) {
              return NodeFilter.FILTER_SKIP;
            }
            if (looksLikeTinyImage(node)) {
              return NodeFilter.FILTER_SKIP;
            }
            return NodeFilter.FILTER_ACCEPT;
          }

          if (node.tagName === "FIGCAPTION") {
            // figure 里已经处理过 figcaption；独立 figcaption 一般是噪声
            return NodeFilter.FILTER_SKIP;
          }

          // 段落 / heading / blockquote
          // 跳过包在 OL/UL/TABLE/PRE/FIGURE 里的 P / H 等
          if (insideAncestorBlock(node, root)) {
            return NodeFilter.FILTER_SKIP;
          }

          const text = normalizeText(getVisibleText(node));
          const minLen = minTextLenForTag(node.tagName);
          if (text.length < minLen) {
            return NodeFilter.FILTER_SKIP;
          }
          if (textSeen.has(text)) {
            return NodeFilter.FILTER_SKIP;
          }
          textSeen.add(text);

          return NodeFilter.FILTER_ACCEPT;
        }
      }
    );

    let currentNode = walker.nextNode();
    while (currentNode) {
      const tag = currentNode.tagName;

      if (tag === "PRE") {
        const codeBlock = extractCodeBlock(currentNode);
        if (codeBlock) blocks.push(codeBlock);
      } else if (tag === "OL" || tag === "UL") {
        const listBlock = extractListBlock(currentNode);
        if (listBlock) blocks.push(listBlock);
      } else if (tag === "TABLE") {
        const tableBlock = extractTableBlock(currentNode);
        if (tableBlock) blocks.push(tableBlock);
      } else if (tag === "FIGURE") {
        const figureBlock = extractFigureBlock(currentNode, pushImage);
        if (figureBlock) blocks.push(figureBlock);
      } else if (tag === "IMG") {
        const src = resolveImageSrc(currentNode);
        if (src) {
          const block = pushImage({
            src,
            alt: currentNode.getAttribute("alt") || "",
            caption: ""
          });
          if (block) blocks.push(block);
        }
      } else {
        const text = normalizeText(getVisibleText(currentNode));
        if (text) {
          blocks.push(buildTextBlock(currentNode.tagName, text));
        }
      }

      currentNode = walker.nextNode();
    }

    appendMissingImagesInOrder(root, blocks, images, imageIndexByUrl);

    let plainText = blocksToPlainText(blocks);

    const textBlockCount = blocks.filter((block) => block.type !== "image").length;
    const fallbackProbe = buildFallbackPlainText(root);
    if (
      plainText.length < 200 &&
      textBlockCount < 4 &&
      fallbackProbe.length > plainText.length + 80
    ) {
      blocks.length = 0;
      images.length = 0;
      imageIndexByUrl.clear();
      textSeen.clear();
      const chunks = fallbackProbe
        .split(/\n{2,}/)
        .map((c) => normalizeText(c))
        .filter((t) => t.length > 15);
      if (chunks.length > 0) {
        chunks.forEach((t) => blocks.push({ type: "paragraph", text: t }));
      } else if (fallbackProbe.length > 40) {
        blocks.push({ type: "paragraph", text: fallbackProbe.slice(0, 60000) });
      }
      root.querySelectorAll("img").forEach((img) => {
        const src = resolveImageSrc(img);
        if (!src || src.startsWith("data:") || isTinyTrackingUrl(src) || looksLikeDecorativeUrl(src)) return;
        if (hasSkippedAncestor(img, root) || hasBoilerplateAncestor(img, root)) return;
        if (looksLikeTinyImage(img)) return;
        const block = pushImage({
          src,
          alt: img.getAttribute("alt") || "",
          caption: img.closest("figure")?.querySelector("figcaption")?.textContent || ""
        });
        if (block) blocks.push(block);
      });
      plainText = blocksToPlainText(blocks);
    }

    // 字体反爬还原（模块三）：只有 plainText 里真的出现私有使用区编码点
    // 才会做任何额外工作，绝大多数正常网页直接原地返回，零开销。
    await restoreObfuscatedFontChars(root, blocks);

    return {
      url: location.href,
      title:
        document.querySelector("meta[property='og:title']")?.getAttribute("content") ||
        document.title ||
        "",
      description:
        document.querySelector("meta[name='description']")?.getAttribute("content") ||
        document.querySelector("meta[property='og:description']")?.getAttribute("content") ||
        "",
      siteName:
        document.querySelector("meta[property='og:site_name']")?.getAttribute("content") ||
        document.querySelector("meta[name='application-name']")?.getAttribute("content") ||
        "",
      author: extractAuthor(),
      extractedAt: new Date().toISOString(),
      wordCount: plainText.length,
      blocks,
      images,
      captureMode: raw ? "raw" : "readable"
    };
  }

  // ── 作者抽取 ──
  // 顺序：JSON-LD（schema.org/Article 规范，少数派/NYT/华尔街日报等都用）
  //   → meta 标签（最常见的 OG/twitter）
  //   → DOM 中文站专属 selector（知乎专栏、36kr、虎嗅、微信公众号、新榜...）
  // 任一拿到非空就返回；都拿不到才返回 ""
  function extractAuthor() {
    const cleaned = (s) =>
      String(s || "")
        .replace(/^\s*by[\s:：]+/i, "")
        .replace(/[\u200b\u00a0]/g, "")
        .replace(/\s+/g, " ")
        .trim()
        .slice(0, 60);

    // 1. JSON-LD 解析
    const ldScripts = document.querySelectorAll("script[type='application/ld+json']");
    for (const script of ldScripts) {
      try {
        const raw = script.textContent || "";
        if (!raw.includes("author")) continue;
        const data = JSON.parse(raw);
        const candidates = Array.isArray(data) ? data : [data];
        for (const node of candidates) {
          if (!node || typeof node !== "object") continue;
          const author = node.author;
          if (!author) continue;
          const name = Array.isArray(author)
            ? author.map((a) => (typeof a === "string" ? a : a?.name)).filter(Boolean).join("、")
            : (typeof author === "string" ? author : author?.name);
          if (name) return cleaned(name);
        }
      } catch {}
    }

    // 2. meta 标签
    const metaName =
      document.querySelector("meta[name='author']")?.getAttribute("content") ||
      document.querySelector("meta[property='article:author']")?.getAttribute("content") ||
      document.querySelector("meta[name='twitter:creator']")?.getAttribute("content") ||
      document.querySelector("meta[name='byl']")?.getAttribute("content") || // NYT byline
      "";
    if (metaName && !/^https?:/i.test(metaName)) return cleaned(metaName);

    // 3. 中文站常见 selector（按命中概率排）
    const DOM_SELECTORS = [
      "#js_name",                                      // 微信公众号正文
      ".rich_media_meta_nickname",                     // 微信备用
      ".AuthorInfo .UserLink-link",                    // 知乎专栏
      ".AuthorInfo-name",                              // 知乎专栏备用
      ".article-author-name", ".author-info-name",     // 36kr
      ".author-name",                                  // 通用
      ".byline-name", ".byline__name", ".byline a",    // 英文新闻站
      ".post-author a", ".post-author",                // WP 主题
      ".entry-author-name", ".entry-author",
      ".article__author", ".article-author",
      "[itemprop='author'] [itemprop='name']",
      "[itemprop='author']",
      "[rel='author']",
      ".ss__user-card__nickname",                      // 少数派 DOM 兜底
      ".author-card .nickname",                        // 虎嗅
      ".article-meta .author"                          // 通用兜底
    ];
    for (const sel of DOM_SELECTORS) {
      try {
        const el = document.querySelector(sel);
        const text = (el?.textContent || el?.getAttribute?.("content") || "").trim();
        if (text && text.length <= 60) return cleaned(text);
      } catch {}
    }

    return "";
  }

  // ── 块提取器 ──

  function extractCodeBlock(preNode) {
    const codeNode = preNode.querySelector("code") || preNode;
    let language = "";
    const cls = (codeNode.getAttribute("class") || preNode.getAttribute("class") || "").trim();
    const m =
      cls.match(/(?:^|\s)(?:language|lang)-([\w+\-#.]+)/i) ||
      cls.match(/(?:^|\s)(?:hljs|prism)-([\w+\-#.]+)/i) ||
      cls.match(/(?:^|\s)(\w[\w+\-#.]*)/);
    if (m) language = m[1].toLowerCase();
    if (language === "highlight" || language === "code" || language === "hljs") language = "";

    // 用 textContent 保留原始换行；剔除行号常见模式（开头每行 N |）
    let text = codeNode.textContent || "";
    text = text.replace(/\u00a0/g, " ");
    text = text.replace(/\r\n?/g, "\n");
    if (/^\s*\d+\s*\|/m.test(text)) {
      text = text.replace(/^\s*\d+\s*\|\s?/gm, "");
    }
    text = text.replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
    if (!text) return null;
    return { type: "code", language, text };
  }

  function extractListBlock(listNode) {
    const ordered = listNode.tagName === "OL";
    const items = [];
    listNode.querySelectorAll(":scope > li").forEach((li) => {
      if (!isVisibleForCapture(li)) return;
      const text = normalizeText(getVisibleText(li));
      if (text) items.push(text);
    });
    if (items.length === 0) return null;
    return { type: "list", ordered, items };
  }

  function extractTableBlock(tableNode) {
    const headerCells = Array.from(tableNode.querySelectorAll(":scope > thead > tr > th")).map(
      (th) => normalizeText(getVisibleText(th))
    );
    let headers = headerCells;
    const rows = [];

    let bodyRows = Array.from(tableNode.querySelectorAll(":scope > tbody > tr"));
    if (bodyRows.length === 0) {
      bodyRows = Array.from(tableNode.querySelectorAll(":scope > tr"));
    }

    if (headers.length === 0 && bodyRows.length > 0) {
      const firstRowCells = Array.from(bodyRows[0].children);
      const allTh = firstRowCells.every((c) => c.tagName === "TH");
      if (allTh) {
        headers = firstRowCells.map((th) => normalizeText(getVisibleText(th)));
        bodyRows = bodyRows.slice(1);
      }
    }

    bodyRows.forEach((tr) => {
      const cells = Array.from(tr.children).map((td) => normalizeText(getVisibleText(td)));
      if (cells.some((cell) => cell)) rows.push(cells);
    });

    if (headers.length === 0 && rows.length === 0) return null;
    return { type: "table", headers, rows };
  }

  function extractFigureBlock(figureNode, pushImage) {
    const img = figureNode.querySelector("img");
    if (!img) return null;
    const src = resolveImageSrc(img);
    if (!src || src.startsWith("data:") || isTinyTrackingUrl(src) || looksLikeDecorativeUrl(src)) return null;
    if (looksLikeTinyImage(img)) return null;
    const captionEl = figureNode.querySelector("figcaption");
    const caption = captionEl ? normalizeText(getVisibleText(captionEl)) : "";
    return pushImage({ src, alt: img.getAttribute("alt") || "", caption });
  }

  function buildTextBlock(tagName, text) {
    if (/^H([1-6])$/.test(tagName)) {
      const level = Number(RegExp.$1);
      return { type: "heading", level, text };
    }
    if (tagName === "BLOCKQUOTE") {
      return { type: "quote", text };
    }
    return { type: "paragraph", text };
  }

  function blocksToPlainText(blocks) {
    return blocks
      .filter((block) => block.type !== "image")
      .map((block) => {
        if (block.type === "list") return block.items.join("\n");
        if (block.type === "table") {
          const rows = [];
          if (block.headers?.length) rows.push(block.headers.join(" | "));
          for (const row of block.rows) rows.push(row.join(" | "));
          return rows.join("\n");
        }
        if (block.type === "code") return block.text;
        return block.text || "";
      })
      .join("\n\n");
  }

  function appendMissingImagesInOrder(root, blocks, images, imageIndexByUrl) {
    const seenInBlocks = new Set(
      blocks.filter((b) => b.type === "image").map((b) => normalizeUrlKey(b.src))
    );

    try {
      const list = root.querySelectorAll("img");
      list.forEach((img) => {
        const src = resolveImageSrc(img);
        if (!src || src.startsWith("data:") || isTinyTrackingUrl(src) || looksLikeDecorativeUrl(src)) return;
        if (hasSkippedAncestor(img, root) || hasBoilerplateAncestor(img, root)) return;
        if (looksLikeTinyImage(img)) return;
        const key = normalizeUrlKey(src);
        if (seenInBlocks.has(key)) return;

        let imageIndex = imageIndexByUrl.get(key);
        if (!imageIndex) {
          imageIndex = images.length + 1;
          images.push({
            src,
            alt: normalizeText(img.getAttribute("alt") || ""),
            caption: normalizeText(
              img.closest("figure")?.querySelector("figcaption")?.textContent || ""
            )
          });
          imageIndexByUrl.set(key, imageIndex);
        }

        blocks.push({
          type: "image",
          index: imageIndex,
          src,
          alt: images[imageIndex - 1]?.alt || "",
          caption: images[imageIndex - 1]?.caption || ""
        });
        seenInBlocks.add(key);
      });
    } catch (_) {}
  }

  function buildFallbackPlainText(root) {
    const clone = root.cloneNode(true);
    clone
      .querySelectorAll("script, style, noscript, svg, iframe, nav, footer, form")
      .forEach((el) => {
        try {
          el.remove();
        } catch (_) {}
      });
    // 保留换行：调用方用 \n{2,} 切段。若这里 normalizeText 压成单行，
    // fallback 永远只能产出 1 个超长 paragraph（GitHub 等站点会踩）。
    return String(clone.innerText || clone.textContent || "")
      .replace(/\u00a0/g, " ")
      .replace(/[ \t]+\n/g, "\n")
      .replace(/\n{3,}/g, "\n\n")
      .trim();
  }

  function minTextLenForTag(tagName) {
    if (/^H[1-6]$/.test(tagName)) return 2;
    if (tagName === "BLOCKQUOTE") return 6;
    if (tagName === "P") return 12;
    return 14;
  }

  function isTinyTrackingUrl(url) {
    return /1x1|pixel|tracking|spacer|blank\.gif|beacon|loading\.gif|loading\.svg|gtm\.js|googletagmanager/i.test(url);
  }

  /**
   * 判断 URL 路径里的"图标/徽章/装饰"特征（38th 续 8 加强）。
   * 例如：/static/icons/share.svg / /assets/badge-pro.png / /emoji/laugh.gif
   * 这类即使尺寸 > 80px 也不该作为正文图片入库（多半是装饰元素）。
   */
  function looksLikeDecorativeUrl(url) {
    if (!url) return false;
    const u = String(url).toLowerCase();
    return /\/(icons?|badges?|emoji|emojis|emoticons?|stickers?|reactions?|share-buttons?|social-icons?|logo-small|sponsor-logos?)\//.test(u);
  }

  function looksLikeTinyImage(img) {
    const w = img.naturalWidth || Number(img.getAttribute("width")) || 0;
    const h = img.naturalHeight || Number(img.getAttribute("height")) || 0;
    // 80px 阈值之外，再加 100x100 这一档作为"明显的图标尺寸"判定
    if (w > 0 && h > 0 && w < 80 && h < 80) return true;
    if (w > 0 && h > 0 && w <= 100 && h <= 100 && Math.abs(w - h) < 8) return true; // 接近正方形的小图 = 图标/头像
    const cls = (img.getAttribute("class") || "").toLowerCase();
    // 加强 class 黑名单：reaction-icon / social-icon / badge / sponsor-logo / sticker
    if (/avatar|emoji|emoticon|sticker|icon|logo-small|logo-mini|qrcode|qr-code|share-icon|reaction|badge|sponsor-logo|app-store-badge|gp-badge|app-icon/.test(cls)) return true;
    // alt 噪声过滤：alt 内容像 CTA / 装饰描述时，多半不是正文图
    const alt = (img.getAttribute("alt") || "").trim().toLowerCase();
    if (/^(点击|click|share|分享|转发|关注|follow|subscribe|订阅|二维码|qr code|logo|图标|icon|emoji|表情|广告)/.test(alt)) return true;
    return false;
  }

  /**
   * 同 URL 的不同 size variant 归并（38th 续 8）：很多站点对同一图输出多种尺寸
   * （如 https://cdn.x.com/img.jpg?w=200&h=200 vs ?w=1200&h=800），URL 不同
   * 但本质是同一张图。把 size/quality query 参数剥掉作为去重 key，正文里
   * 只保留尺寸最大那张。
   */
  function stripSizeParamsFromUrl(url) {
    try {
      const u = new URL(url, location.href);
      // 常见 size/quality query 参数：w/h/width/height/size/quality/q/dpr/fm/format/auto
      const sizeRe = /^(w|h|width|height|size|quality|q|dpr|fm|format|auto|ssl|c_fill|c_fit|c_scale)$/i;
      const keys = Array.from(u.searchParams.keys());
      keys.forEach((k) => { if (sizeRe.test(k)) u.searchParams.delete(k); });
      // 路径里 -200x200. 这种命名约定剥掉
      u.pathname = u.pathname.replace(/-\d{2,4}x\d{2,4}(?=\.[a-z]{2,5}$)/i, "");
      u.hash = "";
      return u.toString();
    } catch {
      return url;
    }
  }

  function normalizeUrlKey(url) {
    try {
      const u = new URL(url, location.href);
      u.hash = "";
      return u.toString();
    } catch {
      return url;
    }
  }

  function pickBestRoot(nodes) {
    let bestNode = document.body;
    let bestScore = -Infinity;

    for (const node of nodes) {
      if (!node || node.tagName === "HTML") continue;
      const text = normalizeText(node.innerText || "");
      const paragraphs = node.querySelectorAll("p").length;
      const headings = node.querySelectorAll("h1,h2,h3,h4").length;
      const imagesCount = node.querySelectorAll("img").length;
      const linksCount = node.querySelectorAll("a").length;
      const linkText = Array.from(node.querySelectorAll("a"))
        .map((a) => (a.textContent || "").length)
        .reduce((sum, len) => sum + len, 0);
      const linkDensity = text.length > 0 ? linkText / text.length : 0;

      // 链接密度太高的（>0.6）一般是导航 / 索引
      const score =
        text.length +
        paragraphs * 160 +
        headings * 220 +
        imagesCount * 48 -
        linksCount * 8 -
        Math.round(linkDensity * 1500);

      if (score > bestScore) {
        bestScore = score;
        bestNode = node;
      }
    }

    return bestNode || document.body;
  }

  function hasSkippedAncestor(node, stopNode) {
    let current = node.parentElement;
    while (current && current !== stopNode) {
      if (SKIP_TAGS.has(current.tagName)) return true;
      current = current.parentElement;
    }
    return false;
  }

  function hasBoilerplateAncestor(node, stopNode) {
    // 站点特化的 extraBoilerplate（38th 续 7）：在通用 BOILERPLATE_RE 之外
    // 加上当前 host 的额外噪声 className 模式（如 substack 的 subscribe-widget）
    const siteRule = getSiteRule();
    const extraRe = siteRule?.extraBoilerplate || null;

    let current = node.parentElement;
    while (current && current !== stopNode) {
      const cls = `${current.getAttribute("class") || ""} ${current.id || ""}`;
      const role = current.getAttribute("role") || "";
      if (
        BOILERPLATE_RE.test(cls) ||
        (extraRe && extraRe.test(cls)) ||
        role === "complementary" ||
        role === "navigation"
      ) {
        return true;
      }
      current = current.parentElement;
    }
    return false;
  }

  function insideAncestorBlock(node, stopNode) {
    let current = node.parentElement;
    while (current && current !== stopNode) {
      if (
        current.tagName === "OL" ||
        current.tagName === "UL" ||
        current.tagName === "TABLE" ||
        current.tagName === "PRE" ||
        current.tagName === "FIGURE"
      ) {
        return true;
      }
      current = current.parentElement;
    }
    return false;
  }

  function resolveImageSrc(node) {
    if (!node || node.tagName !== "IMG") return "";

    // 优先看 picture/source srcset
    const picture = node.closest("picture");
    if (picture) {
      const sources = Array.from(picture.querySelectorAll("source[srcset]"));
      for (const s of sources) {
        const first = pickFirstSrcFromSrcset(s.getAttribute("srcset") || "");
        if (first) {
          try {
            return new URL(first, location.href).toString();
          } catch (_) {}
        }
      }
    }

    const candidates = [
      node.currentSrc,
      node.getAttribute("src"),
      node.getAttribute("data-src"),
      node.getAttribute("data-lazy-src"),
      node.getAttribute("data-original"),
      node.getAttribute("data-actualsrc"),
      node.getAttribute("data-url"),
      node.getAttribute("data-ks-lazyload"),
      node.getAttribute("data-lazyload"),
      pickFirstSrcFromSrcset(node.getAttribute("srcset")),
      node.getAttribute("data-srcset")
        ? pickFirstSrcFromSrcset(node.getAttribute("data-srcset"))
        : ""
    ].filter(Boolean);

    for (const raw of candidates) {
      const s = String(raw).trim();
      if (!s || s.startsWith("data:")) continue;
      try {
        return new URL(s.split(/\s+/)[0], location.href).toString();
      } catch {
        continue;
      }
    }

    return "";
  }

  function pickFirstSrcFromSrcset(srcset) {
    if (!srcset || !String(srcset).trim()) return "";
    // 取最大 width 的那张（更高清）
    const items = String(srcset)
      .split(",")
      .map((part) => {
        const s = part.trim();
        const m = s.match(/^(\S+)\s+(\d+(?:\.\d+)?)([wx])$/);
        if (m) return { url: m[1], size: Number(m[2]), unit: m[3] };
        return { url: s.split(/\s+/)[0] || "", size: 0, unit: "x" };
      })
      .filter((item) => item.url);
    if (items.length === 0) return "";
    items.sort((a, b) => b.size - a.size);
    return items[0].url || "";
  }

  function normalizeText(value) {
    return String(value || "")
      .replace(/\u00a0/g, " ")
      .replace(/\s+/g, " ")
      .trim();
  }
})();
