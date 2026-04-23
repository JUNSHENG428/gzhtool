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

  const BOILERPLATE_RE =
    /comment|comments?-list|disqus|sidebar|widget|related|recommend|share|social|breadcrumb|toolbar|advert|ad-|ads-|promo|subscribe|newsletter|footer|header-nav|reading-list|toc-|table-of|author-bio|meta-info|hentry-meta|post-tags|post-categories|next-prev|pagination|wp-block-latest|outbrain|taboola|prevnext/i;

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

  function extractSelectionFromPage() {
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

  function extractArticleFromPage(options) {
    const raw = Boolean(options && options.raw);
    const candidates = raw
      ? [document.body]
      : [
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

    // 用一个 helper 统一推图片并去重
    function pushImage({ src, alt, caption }) {
      if (!src) return null;
      const key = normalizeUrlKey(src);
      let imageIndex = imageIndexByUrl.get(key);
      if (!imageIndex) {
        imageIndex = images.length + 1;
        images.push({
          src,
          alt: normalizeText(alt || ""),
          caption: normalizeText(caption || "")
        });
        imageIndexByUrl.set(key, imageIndex);
      }
      const data = images[imageIndex - 1];
      return { type: "image", index: imageIndex, src, alt: data.alt, caption: data.caption };
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
            if (!src || src.startsWith("data:") || isTinyTrackingUrl(src)) {
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

          const text = normalizeText(node.textContent || "");
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
        const text = normalizeText(currentNode.textContent || "");
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
        if (!src || src.startsWith("data:") || isTinyTrackingUrl(src)) return;
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
      const text = normalizeText(li.textContent || "");
      if (text) items.push(text);
    });
    if (items.length === 0) return null;
    return { type: "list", ordered, items };
  }

  function extractTableBlock(tableNode) {
    const headerCells = Array.from(tableNode.querySelectorAll(":scope > thead > tr > th")).map(
      (th) => normalizeText(th.textContent || "")
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
        headers = firstRowCells.map((th) => normalizeText(th.textContent || ""));
        bodyRows = bodyRows.slice(1);
      }
    }

    bodyRows.forEach((tr) => {
      const cells = Array.from(tr.children).map((td) => normalizeText(td.textContent || ""));
      if (cells.some((cell) => cell)) rows.push(cells);
    });

    if (headers.length === 0 && rows.length === 0) return null;
    return { type: "table", headers, rows };
  }

  function extractFigureBlock(figureNode, pushImage) {
    const img = figureNode.querySelector("img");
    if (!img) return null;
    const src = resolveImageSrc(img);
    if (!src || src.startsWith("data:") || isTinyTrackingUrl(src)) return null;
    if (looksLikeTinyImage(img)) return null;
    const captionEl = figureNode.querySelector("figcaption");
    const caption = captionEl ? normalizeText(captionEl.textContent || "") : "";
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
        if (!src || src.startsWith("data:") || isTinyTrackingUrl(src)) return;
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
    return normalizeText(clone.innerText || clone.textContent || "");
  }

  function minTextLenForTag(tagName) {
    if (/^H[1-6]$/.test(tagName)) return 2;
    if (tagName === "BLOCKQUOTE") return 6;
    if (tagName === "P") return 12;
    return 14;
  }

  function isTinyTrackingUrl(url) {
    return /1x1|pixel|tracking|spacer|blank\.gif|beacon|loading\.gif|loading\.svg/i.test(url);
  }

  function looksLikeTinyImage(img) {
    const w = img.naturalWidth || Number(img.getAttribute("width")) || 0;
    const h = img.naturalHeight || Number(img.getAttribute("height")) || 0;
    if (w > 0 && h > 0 && w < 80 && h < 80) return true;
    const cls = (img.getAttribute("class") || "").toLowerCase();
    if (/avatar|emoji|icon|logo-small|qrcode|qr-code|share-icon/.test(cls)) return true;
    return false;
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
    let current = node.parentElement;
    while (current && current !== stopNode) {
      const cls = `${current.getAttribute("class") || ""} ${current.id || ""}`;
      const role = current.getAttribute("role") || "";
      if (BOILERPLATE_RE.test(cls) || role === "complementary" || role === "navigation") {
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
