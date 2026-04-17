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
      "[contenteditable='true'][data-placeholder*='标题']"
    ]);
  }

  function findDigestField() {
    return findFirst([
      "textarea[placeholder*='摘要']",
      "input[placeholder*='摘要']",
      "textarea[maxlength='120']"
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
      "input[name*='source']"
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

    try {
      node.focus();
      if (doc.execCommand) {
        try {
          doc.execCommand("selectAll", false);
          doc.execCommand("insertHTML", false, html);
        } catch {}
      }

      if (normalizeText(node.innerHTML || "").length < 20) {
        node.innerHTML = html;
      }

      node.dispatchEvent(new Event("input", { bubbles: true }));
      node.dispatchEvent(new Event("keyup", { bubbles: true }));
      node.dispatchEvent(new Event("change", { bubbles: true }));
      return true;
    } catch {
      return false;
    }
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

    dock.innerHTML = `
      <div style="display:grid;gap:8px;">
        <strong style="font-size:15px;">公众号网页编辑器助手</strong>
        <p style="margin:0;line-height:1.65;color:#d6e0d5;">${escapeHtml(result.message || "等待同步结果")}</p>
        <div style="font-size:12px;line-height:1.7;color:#b9c7bb;">
          标题：${result.titleWritten ? "已写入" : "未写入"}<br />
          摘要：${result.digestWritten ? "已写入" : "未写入"}<br />
          正文：${result.bodyWritten ? "已写入" : "未写入"}
        </div>
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
    if (!result.isEditor) {
      return "当前不是公众号图文编辑页。请先登录并打开图文编辑器。";
    }
    if (result.titleWritten && result.bodyWritten) {
      return "已尝试把当前篇写入网页编辑器。请检查正文和右侧设置项。";
    }
    if (result.titleWritten && !result.bodyWritten) {
      return "标题已写入，但没有找到稳定的正文编辑区。可以直接点“复制正文 HTML”后手动粘贴。";
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
