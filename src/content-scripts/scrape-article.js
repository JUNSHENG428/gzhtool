/**
 * 注入到目标网页隔离环境，供 chrome.scripting.executeScript({ files }) 加载。
 * 导出 window.__gzhRunFullCapture：先滚动展开懒加载内容，再抽取正文与图片。
 */
(function registerGzhScraper() {
  if (typeof window.__gzhRunFullCapture === "function") {
    return;
  }

  const BOILERPLATE_RE =
    /comment|comments|sidebar|widget|related|recommend|share|social|breadcrumb|toolbar|advert|ad-|ads-|promo|subscribe|newsletter|footer-nav|header-nav|reading-list|toc-|table-of|author-bio|meta-info/i;

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
    "TEMPLATE"
  ]);

  const BLOCK_TAGS = new Set([
    "H1",
    "H2",
    "H3",
    "H4",
    "H5",
    "H6",
    "P",
    "BLOCKQUOTE",
    "LI",
    "PRE",
    "IMG",
    "FIGCAPTION",
    "TD",
    "TH"
  ]);

  const ROOT_SELECTORS = [
    "article",
    "main",
    "[role='main']",
    "[role='article']",
    ".article",
    ".article-content",
    ".post-content",
    ".entry-content",
    ".post__content",
    ".s-content",
    ".note-content",
    ".rich_media_content",
    ".rich_media_area_primary_inner",
    "#js_content",
    "#article-content",
    ".markdown-body",
    ".article__body"
  ];

  window.__gzhRunFullCapture = async function runFullCapture() {
    await expandLazyContent();
    return extractArticleFromPage();
  };

  async function expandLazyContent() {
    const budgetMs = 4000;
    const started = Date.now();
    let lastH = 0;
    let stable = 0;

    while (Date.now() - started < budgetMs) {
      const h = document.documentElement.scrollHeight;
      window.scrollBy(0, Math.min(window.innerHeight * 0.88, 900));
      await sleep(130);
      if (h === lastH) {
        stable += 1;
        if (stable >= 4) {
          break;
        }
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
    } catch (_) {}

    await sleep(120);
  }

  function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  function extractArticleFromPage() {
    const candidates = [
      ...ROOT_SELECTORS.flatMap((selector) => {
        try {
          return Array.from(document.querySelectorAll(selector));
        } catch {
          return [];
        }
      }),
      document.body
    ].filter(Boolean);

    const root = pickBestRoot(candidates);
    const images = [];
    const imageIndexByUrl = new Map();
    const textSeen = new Set();
    const blocks = [];

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
          if (hasBoilerplateAncestor(node, root)) {
            return NodeFilter.FILTER_REJECT;
          }
          if (node.tagName === "IMG") {
            const src = resolveImageSrc(node);
            if (!src || src.startsWith("data:") || isTinyTrackingUrl(src)) {
              return NodeFilter.FILTER_SKIP;
            }
            return NodeFilter.FILTER_ACCEPT;
          }

          if (node.tagName === "FIGCAPTION") {
            const t = normalizeText(node.textContent || "");
            if (t.length < 4) {
              return NodeFilter.FILTER_SKIP;
            }
            return NodeFilter.FILTER_ACCEPT;
          }

          if (node.tagName === "TD" || node.tagName === "TH") {
            const t = normalizeText(node.textContent || "");
            if (t.length < 20) {
              return NodeFilter.FILTER_SKIP;
            }
            return NodeFilter.FILTER_ACCEPT;
          }

          if (node.tagName === "CODE" && node.closest("pre")) {
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
      if (currentNode.tagName === "IMG") {
        const src = resolveImageSrc(currentNode);
        if (!src) {
          currentNode = walker.nextNode();
          continue;
        }

        let imageIndex = imageIndexByUrl.get(normalizeUrlKey(src));
        if (!imageIndex) {
          imageIndex = images.length + 1;
          const image = {
            src,
            alt: normalizeText(currentNode.getAttribute("alt") || ""),
            caption: normalizeText(
              currentNode.closest("figure")?.querySelector("figcaption")?.textContent || ""
            )
          };
          images.push(image);
          imageIndexByUrl.set(normalizeUrlKey(src), imageIndex);
        }

        const imgData = images[imageIndex - 1];
        blocks.push({
          type: "image",
          index: imageIndex,
          src,
          alt: imgData?.alt || "",
          caption: imgData?.caption || ""
        });
      } else {
        const text = normalizeText(currentNode.textContent || "");
        blocks.push({
          type: mapTagToBlockType(currentNode.tagName),
          text
        });
      }

      currentNode = walker.nextNode();
    }

    appendMissingImagesInOrder(root, blocks, images, imageIndexByUrl);

    let plainText = blocks
      .filter((block) => block.type !== "image")
      .map((block) => block.text)
      .join("\n\n");

    const textBlockCount = blocks.filter((block) => block.type !== "image").length;
    const fallbackProbe = buildFallbackPlainText(root);
    if (
      plainText.length < 200 &&
      textBlockCount < 4 &&
      fallbackProbe.length > plainText.length + 80
    ) {
      const fallback = fallbackProbe;
      blocks.length = 0;
      images.length = 0;
      imageIndexByUrl.clear();
      textSeen.clear();
      const chunks = fallback.split(/\n{2,}/).map((c) => normalizeText(c)).filter((t) => t.length > 15);
      if (chunks.length > 0) {
        chunks.forEach((t) => blocks.push({ type: "paragraph", text: t }));
      } else if (fallback.length > 40) {
        blocks.push({ type: "paragraph", text: fallback.slice(0, 60000) });
      }
      root.querySelectorAll("img").forEach((img) => {
        const src = resolveImageSrc(img);
        if (!src || src.startsWith("data:") || isTinyTrackingUrl(src)) {
          return;
        }
        if (hasSkippedAncestor(img, root) || hasBoilerplateAncestor(img, root)) {
          return;
        }
        let imageIndex = imageIndexByUrl.get(normalizeUrlKey(src));
        if (!imageIndex) {
          imageIndex = images.length + 1;
          images.push({
            src,
            alt: normalizeText(img.getAttribute("alt") || ""),
            caption: normalizeText(
              img.closest("figure")?.querySelector("figcaption")?.textContent || ""
            )
          });
          imageIndexByUrl.set(normalizeUrlKey(src), imageIndex);
        }
        blocks.push({
          type: "image",
          index: imageIndex,
          src,
          alt: images[imageIndex - 1]?.alt || "",
          caption: images[imageIndex - 1]?.caption || ""
        });
      });
      plainText = blocks
        .filter((block) => block.type !== "image")
        .map((block) => block.text)
        .join("\n\n");
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
        document.querySelector("meta[property='og:site_name']")?.getAttribute("content") || "",
      extractedAt: new Date().toISOString(),
      wordCount: plainText.length,
      blocks,
      images
    };
  }

  function appendMissingImagesInOrder(root, blocks, images, imageIndexByUrl) {
    const seenInBlocks = new Set(
      blocks.filter((b) => b.type === "image").map((b) => normalizeUrlKey(b.src))
    );

    try {
      const list = root.querySelectorAll("img");
      list.forEach((img) => {
        const src = resolveImageSrc(img);
        if (!src || src.startsWith("data:") || isTinyTrackingUrl(src)) {
          return;
        }
        if (hasSkippedAncestor(img, root) || hasBoilerplateAncestor(img, root)) {
          return;
        }
        const key = normalizeUrlKey(src);
        if (seenInBlocks.has(key)) {
          return;
        }

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
    clone.querySelectorAll("script, style, noscript, svg, iframe, nav, footer, form").forEach((el) => {
      try {
        el.remove();
      } catch (_) {}
    });
    return normalizeText(clone.innerText || clone.textContent || "");
  }

  function minTextLenForTag(tagName) {
    if (/^H[1-6]$/.test(tagName)) {
      return 2;
    }
    if (tagName === "LI") {
      return 4;
    }
    if (tagName === "BLOCKQUOTE" || tagName === "PRE") {
      return 8;
    }
    if (tagName === "TD" || tagName === "TH") {
      return 20;
    }
    return 14;
  }

  function isTinyTrackingUrl(url) {
    return /1x1|pixel|tracking|spacer|blank\.gif|beacon/i.test(url);
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
      if (!node || node.tagName === "HTML") {
        continue;
      }
      const text = normalizeText(node.innerText || "");
      const paragraphs = node.querySelectorAll("p").length;
      const imagesCount = node.querySelectorAll("img").length;
      const linksCount = node.querySelectorAll("a").length;
      const score = text.length + paragraphs * 160 + imagesCount * 48 - linksCount * 10;

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
      if (SKIP_TAGS.has(current.tagName)) {
        return true;
      }
      current = current.parentElement;
    }
    return false;
  }

  function hasBoilerplateAncestor(node, stopNode) {
    let current = node.parentElement;
    while (current && current !== stopNode) {
      const cls = (current.getAttribute("class") || "") + " " + (current.id || "");
      const role = current.getAttribute("role") || "";
      if (BOILERPLATE_RE.test(cls) || role === "complementary" || role === "navigation") {
        return true;
      }
      current = current.parentElement;
    }
    return false;
  }

  function resolveImageSrc(node) {
    if (!node || node.tagName !== "IMG") {
      return "";
    }

    const candidates = [
      node.currentSrc,
      node.getAttribute("src"),
      node.getAttribute("data-src"),
      node.getAttribute("data-lazy-src"),
      node.getAttribute("data-original"),
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
      if (!s || s.startsWith("data:")) {
        continue;
      }
      try {
        return new URL(s.split(/\s+/)[0], location.href).toString();
      } catch {
        continue;
      }
    }

    return "";
  }

  function pickFirstSrcFromSrcset(srcset) {
    if (!srcset || !String(srcset).trim()) {
      return "";
    }
    const first = String(srcset)
      .split(",")
      .map((part) => part.trim().split(/\s+/)[0])
      .filter(Boolean)[0];
    return first || "";
  }

  function normalizeText(value) {
    return String(value || "")
      .replace(/\u00a0/g, " ")
      .replace(/\s+/g, " ")
      .trim();
  }

  function mapTagToBlockType(tagName) {
    switch (tagName) {
      case "H1":
      case "H2":
      case "H3":
      case "H4":
      case "H5":
      case "H6":
        return "heading";
      case "BLOCKQUOTE":
        return "quote";
      case "LI":
        return "listItem";
      case "PRE":
      case "TD":
      case "TH":
        return "paragraph";
      default:
        return "paragraph";
    }
  }
})();
