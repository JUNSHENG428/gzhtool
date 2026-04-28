(() => {
  const HELPER_ID = "wechat-editor-sync-helper";
  const STATE = {
    payload: null,
    result: null
  };

  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message.type !== "IMPORT_ARTICLE_TO_WECHAT_EDITOR") {
      return false;
    }

    importArticle(message.payload)
      .then((result) => sendResponse({ ok: true, ...result }))
      .catch((error) => sendResponse({ ok: false, error: error.message || "同步失败。" }));

    return true;
  });

  async function importArticle(payload) {
    STATE.payload = payload;
    const result = {
      pageUrl: location.href,
      isEditor: isEditorPage(),
      titleWritten: false,
      digestWritten: false,
      authorWritten: false,
      sourceUrlWritten: false,
      bodyWritten: false,
      message: ""
    };

    if (!result.isEditor) {
      result.message = "当前不是公众号图文编辑页。请先登录并进入新建图文页后重试。";
      renderHelperDock(result);
      return result;
    }

    result.titleWritten = setFieldValue(findTitleField(), payload.meta?.title || "");
    result.digestWritten = setFieldValue(findDigestField(), payload.meta?.digest || "");
    result.authorWritten = setFieldValue(findAuthorField(), payload.meta?.author || "");
    result.sourceUrlWritten = setFieldValue(
      findSourceField(),
      payload.meta?.contentSourceUrl || ""
    );

    const editorSurface = findEditorSurface();
    if (editorSurface) {
      result.bodyWritten = setEditorHtml(editorSurface, payload.html || "");
    }

    result.message = buildResultMessage(result);
    STATE.result = result;
    renderHelperDock(result);
    return result;
  }

  function isEditorPage() {
    return /\/cgi-bin\/appmsg/i.test(location.href);
  }

  function findTitleField() {
    return findFirst([
      "input[placeholder*='标题']",
      "textarea[placeholder*='标题']",
      ".js_title_input",
      "[contenteditable='true'][data-placeholder*='标题']",
      // mp 后台 2025-Q4 改版后偶尔出现的 input 名：title / appmsg_title
      "input[name='title']",
      "input[id*='title' i]"
    ]);
  }

  function findDigestField() {
    return findFirst([
      "textarea[placeholder*='摘要']",
      "input[placeholder*='摘要']",
      "textarea[maxlength='120']",
      // 改版兜底：摘要节点也可能用「描述」placeholder
      "textarea[placeholder*='描述']",
      "textarea[name*='digest' i]"
    ]);
  }

  function findAuthorField() {
    return findFirst([
      "input[placeholder*='作者']",
      "input[name*='author']",
      "input[id*='author']"
    ]);
  }

  function findSourceField() {
    return findFirst([
      "input[placeholder*='原文']",
      "input[placeholder*='来源']",
      "input[name*='source']",
      // 一些版本里这是 url-link 字段
      "input[placeholder*='链接']",
      "input[name*='source_url' i]"
    ]);
  }

  function findEditorSurface() {
    const pageTarget = pickEditorTarget(document);
    if (pageTarget) {
      return pageTarget;
    }

    for (const frame of document.querySelectorAll("iframe")) {
      try {
        const frameDoc = frame.contentDocument;
        if (!frameDoc) {
          continue;
        }
        const target = pickEditorTarget(frameDoc);
        if (target) {
          return target;
        }
      } catch {}
    }

    return null;
  }

  function pickEditorTarget(doc) {
    const candidates = [
      ...doc.querySelectorAll("[contenteditable='true']"),
      ...doc.querySelectorAll(".ql-editor"),
      ...doc.querySelectorAll(".ProseMirror"),
      ...doc.querySelectorAll("body[contenteditable='true']")
    ].filter((node) => !node.closest?.(`#${HELPER_ID}`));

    let best = null;
    let bestScore = -1;

    for (const node of candidates) {
      const text = normalizeText(node.textContent || "");
      const rect = node.getBoundingClientRect?.() || { width: 0, height: 0 };
      const area = rect.width * rect.height;
      const score = area + text.length * 8;
      if (score > bestScore) {
        bestScore = score;
        best = node;
      }
    }

    if (!best) {
      return null;
    }

    return {
      node: best,
      doc
    };
  }

  function setFieldValue(node, value) {
    if (!node || !value) {
      return false;
    }

    if (node instanceof HTMLInputElement || node instanceof HTMLTextAreaElement) {
      node.focus();
      node.value = value;
      node.dispatchEvent(new Event("input", { bubbles: true }));
      node.dispatchEvent(new Event("change", { bubbles: true }));
      return true;
    }

    if (node.isContentEditable) {
      node.focus();
      node.textContent = value;
      node.dispatchEvent(new Event("input", { bubbles: true }));
      return true;
    }

    return false;
  }

  function setEditorHtml(target, html) {
    if (!target?.node || !html) {
      return false;
    }

    const node = target.node;
    const doc = target.doc;
    const safeHtml = sanitizeHtml(html);

    try {
      node.focus();
      if (doc.execCommand) {
        try {
          doc.execCommand("selectAll", false);
          doc.execCommand("insertHTML", false, safeHtml);
        } catch {}
      }

      if (normalizeText(node.innerHTML || "").length < 20) {
        node.innerHTML = safeHtml;
      }

      node.dispatchEvent(new Event("input", { bubbles: true }));
      node.dispatchEvent(new Event("keyup", { bubbles: true }));
      node.dispatchEvent(new Event("change", { bubbles: true }));
      return true;
    } catch {
      return false;
    }
  }

  function sanitizeHtml(html) {
    if (!html || typeof html !== "string") return "";
    const parser = new DOMParser();
    const doc = parser.parseFromString(html, "text/html");

    const allowedTags = new Set([
      "html", "head", "body", "div", "span", "p", "br", "hr",
      "h1", "h2", "h3", "h4", "h5", "h6",
      "ul", "ol", "li", "dl", "dt", "dd",
      "strong", "em", "b", "i", "u", "s", "strike", "sub", "sup", "mark",
      "blockquote", "pre", "code", "a", "img", "figure", "figcaption",
      "table", "thead", "tbody", "tfoot", "tr", "th", "td", "caption", "colgroup", "col"
    ]);

    const dangerousTagsToDrop = new Set([
      "script", "style", "iframe", "object", "embed", "form", "input", "textarea", 
      "meta", "base", "svg", "math", "applet", "link", "template", "noscript"
    ]);

    const allowedAttributes = new Set([
      "href", "src", "alt", "title", "class", "style", "width", "height", "target", "rel",
      "rowspan", "colspan", "start", "type"
    ]);

    doc.querySelectorAll("*").forEach((el) => {
      const tagName = el.tagName.toLowerCase();

      if (!allowedTags.has(tagName)) {
        if (dangerousTagsToDrop.has(tagName)) {
          el.remove();
          return;
        }
        const docFrag = document.createDocumentFragment();
        while (el.firstChild) {
          docFrag.appendChild(el.firstChild);
        }
        el.replaceWith(docFrag);
        return;
      }

      for (const attr of [...el.attributes]) {
        const name = attr.name.toLowerCase();
        if (!allowedAttributes.has(name) && !name.startsWith("data-")) {
          el.removeAttribute(attr.name);
        }
      }

      if (tagName === "a") {
        const href = el.getAttribute("href");
        if (href) {
          const trimmed = href.trim().toLowerCase();
          if (!trimmed.startsWith("http://") && !trimmed.startsWith("https://") && !trimmed.startsWith("#")) {
            el.removeAttribute("href");
          }
        }
      }

      if (tagName === "img") {
        const src = el.getAttribute("src");
        if (src) {
          const trimmed = src.trim().toLowerCase();
          if (trimmed.startsWith("javascript:") || trimmed.startsWith("vbscript:") || trimmed.startsWith("data:text/html")) {
            el.removeAttribute("src");
          }
        }
      }
    });

    return doc.body.innerHTML;
  }

  function renderHelperDock(result) {
    let dock = document.getElementById(HELPER_ID);
    if (!dock) {
      dock = document.createElement("section");
      dock.id = HELPER_ID;
      dock.style.cssText = [
        "position:fixed",
        "right:18px",
        "bottom:18px",
        "width:320px",
        "z-index:2147483647",
        "background:rgba(25,32,27,0.96)",
        "color:#f4f8f2",
        "border-radius:18px",
        "padding:14px",
        "box-shadow:0 18px 36px rgba(0,0,0,0.28)",
        "font-family:IBM Plex Sans,PingFang SC,Hiragino Sans GB,sans-serif"
      ].join(";");
      document.documentElement.appendChild(dock);
    }

    const isBrowserMode = STATE.payload?.meta?.publishMode === "browser";
    const browserModeChecklist = isBrowserMode
      ? `<div style="margin-top:4px;padding:10px 12px;background:rgba(214,255,68,0.08);border:1px solid rgba(214,255,68,0.35);border-radius:10px;font-size:12px;line-height:1.7;color:#e8f4cf;">
          <div style="font-weight:700;margin-bottom:4px;">接下来需要你手动完成：</div>
          ① 检查标题/正文是否完整<br />
          ② 在 mp 后台「封面」处上传封面图<br />
          ③ 点右上角「保存为草稿」按钮
        </div>`
      : "";
    const heading = isBrowserMode
      ? "浏览器登录模式 · 编辑器助手"
      : "公众号网页编辑器助手";

    dock.innerHTML = `
      <div style="display:grid;gap:8px;">
        <strong style="font-size:15px;">${escapeHtml(heading)}</strong>
        <p style="margin:0;line-height:1.65;color:#d6e0d5;">${escapeHtml(result.message || "等待同步结果")}</p>
        <div style="font-size:12px;line-height:1.7;color:#b9c7bb;">
          标题：${result.titleWritten ? "已写入" : "未写入"}<br />
          摘要：${result.digestWritten ? "已写入" : "未写入"}<br />
          正文：${result.bodyWritten ? "已写入" : "未写入"}
        </div>
        ${browserModeChecklist}
        <div style="display:flex;gap:8px;flex-wrap:wrap;">
          <button data-helper-action="retry" style="${buttonStyle()}">重试导入</button>
          <button data-helper-action="copy" style="${buttonStyle()}">复制正文 HTML</button>
          <button data-helper-action="close" style="${buttonStyle("#3f4f43")}">关闭</button>
        </div>
      </div>
    `;

    dock.querySelector("[data-helper-action='retry']")?.addEventListener("click", async () => {
      if (!STATE.payload) {
        return;
      }
      const next = await importArticle(STATE.payload);
      renderHelperDock(next);
    });

    dock.querySelector("[data-helper-action='copy']")?.addEventListener("click", async () => {
      if (!STATE.payload?.html) {
        return;
      }
      try {
        await navigator.clipboard.writeText(STATE.payload.html);
        const next = {
          ...(STATE.result || result),
          message: "正文 HTML 已复制。若自动导入失败，请点击正文编辑区后手动粘贴。"
        };
        STATE.result = next;
        renderHelperDock(next);
      } catch {
        const next = {
          ...(STATE.result || result),
          message: "复制失败，请检查浏览器剪贴板权限。"
        };
        STATE.result = next;
        renderHelperDock(next);
      }
    });

    dock.querySelector("[data-helper-action='close']")?.addEventListener("click", () => {
      dock.remove();
    });
  }

  function buildResultMessage(result) {
    const isBrowserMode = STATE.payload?.meta?.publishMode === "browser";
    if (!result.isEditor) {
      return "当前不是公众号图文编辑页。请先登录并打开图文编辑器。";
    }
    if (result.titleWritten && result.bodyWritten) {
      return isBrowserMode
        ? "已写入公众号编辑器。请按下方清单完成最后 3 步即可保存草稿。"
        : "已尝试把当前篇写入网页编辑器。请检查正文和右侧设置项。";
    }
    if (result.titleWritten && !result.bodyWritten) {
      return "标题已写入，但没有找到稳定的正文编辑区。可以直接点「复制正文 HTML」后手动粘贴。";
    }
    return "自动同步未完全成功。可以用右侧按钮复制正文 HTML 手动粘贴。";
  }

  function findFirst(selectors) {
    for (const selector of selectors) {
      const node = document.querySelector(selector);
      if (node) {
        return node;
      }
    }
    return null;
  }

  function buttonStyle(background = "#173722") {
    return [
      "border:none",
      "border-radius:10px",
      `background:${background}`,
      "color:#f4f8f2",
      "padding:8px 10px",
      "font:inherit",
      "cursor:pointer"
    ].join(";");
  }

  function normalizeText(value) {
    return value.replace(/\s+/g, " ").trim();
  }

  function escapeHtml(value) {
    return String(value || "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }
})();
