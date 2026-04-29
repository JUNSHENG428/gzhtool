(() => {
  const HELPER_ID = "wechat-editor-sync-helper";
  const FLOATING_BALL_ID = "wechat-editor-sync-floating-ball";
  const FLOATING_BALL_MENU_ID = "wechat-editor-sync-floating-ball-menu";
  const FLOATING_BALL_SIZE = 56;
  const STATE = {
    payload: null,
    result: null,
    floatingBallEnabled: false,
    floatingBallPosition: null
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

  // ────────── 公众号编辑页悬浮助手（v0.1，twenty-ninth session）──────────
  // 初始化：问 SW 当前 floatingBallEnabled + 位置，决定是否注入浮球。
  // 监听 storage.onChanged 同步 toggle / 位置变化。
  void initFloatingBall();
  if (chrome?.storage?.onChanged) {
    chrome.storage.onChanged.addListener((changes, areaName) => {
      if (areaName !== "local") return;
      // settings 主对象用同一个 storage key 保存，任何字段变化都会触发；
      // 这里只需要在 floatingBallEnabled / floatingBallPosition 变化时刷新 UI。
      const settingsChange = changes["wechatWriterSettings"];
      if (!settingsChange) return;
      const next = settingsChange.newValue || {};
      const prevEnabled = STATE.floatingBallEnabled;
      const nextEnabled = Boolean(next.floatingBallEnabled);
      STATE.floatingBallEnabled = nextEnabled;
      STATE.floatingBallPosition = next.floatingBallPosition || null;
      if (nextEnabled && !prevEnabled) {
        renderFloatingBall();
      } else if (!nextEnabled && prevEnabled) {
        removeFloatingBallAndMenu();
        // 用户禁用浮球时也顺手把 dock 收掉（避免遗留 UI 元素）
        const dock = document.getElementById(HELPER_ID);
        if (dock) dock.style.display = "none";
      } else if (nextEnabled) {
        // 仅位置变化时只更新坐标
        const ball = document.getElementById(FLOATING_BALL_ID);
        applyFloatingBallPosition(ball);
      }
    });
  }

  async function initFloatingBall() {
    try {
      const resp = await chrome.runtime.sendMessage({ type: "GET_FLOATING_BALL_STATE" });
      const data = resp?.data || {};
      STATE.floatingBallEnabled = Boolean(data.enabled);
      STATE.floatingBallPosition = data.position || null;
      if (STATE.floatingBallEnabled) {
        renderFloatingBall();
      }
    } catch {
      // SW 暂不可达（首次加载偶发），降级为不显示浮球；下次 storage 变化会再渲染
    }
  }

  function renderFloatingBall() {
    let ball = document.getElementById(FLOATING_BALL_ID);
    if (!ball) {
      ball = document.createElement("button");
      ball.id = FLOATING_BALL_ID;
      ball.type = "button";
      ball.title = "润笔助手 · 点击展开 / 拖拽移动 / 右键关闭";
      ball.setAttribute("aria-label", "润笔助手");
      ball.style.cssText = floatingBallStyle();
      ball.textContent = "📥";
      // 用 documentElement 而非 body 挂载，避免被 mp 后台 body 替换/重渲染时丢失
      document.documentElement.appendChild(ball);

      // click 事件：注意要与 drag 区分（drag 时不触发 click）
      let dragInfo = null;
      ball.addEventListener("mousedown", (event) => {
        if (event.button !== 0) return;
        const rect = ball.getBoundingClientRect();
        dragInfo = {
          startX: event.clientX,
          startY: event.clientY,
          ballX: rect.left,
          ballY: rect.top,
          moved: false
        };
        event.preventDefault();
      });
      window.addEventListener("mousemove", (event) => {
        if (!dragInfo) return;
        const dx = event.clientX - dragInfo.startX;
        const dy = event.clientY - dragInfo.startY;
        if (!dragInfo.moved && Math.hypot(dx, dy) < 4) return; // 4px 阈值过滤抖动
        dragInfo.moved = true;
        const x = clamp(dragInfo.ballX + dx, 0, window.innerWidth - FLOATING_BALL_SIZE);
        const y = clamp(dragInfo.ballY + dy, 0, window.innerHeight - FLOATING_BALL_SIZE);
        ball.style.left = `${x}px`;
        ball.style.top = `${y}px`;
        ball.style.right = "auto";
        ball.style.bottom = "auto";
      });
      window.addEventListener("mouseup", () => {
        if (!dragInfo) return;
        const moved = dragInfo.moved;
        if (moved) {
          const rect = ball.getBoundingClientRect();
          chrome.runtime
            .sendMessage({
              type: "SAVE_FLOATING_BALL_POSITION",
              payload: { x: rect.left, y: rect.top }
            })
            .catch(() => {});
        }
        dragInfo = null;
        // 拖拽后立即触发的 click 抑制：标记一个短期 flag
        if (moved) {
          ball.dataset.justDragged = "1";
          setTimeout(() => delete ball.dataset.justDragged, 150);
        }
      });

      ball.addEventListener("click", (event) => {
        if (ball.dataset.justDragged) return; // 拖拽误触发的 click
        event.preventDefault();
        expandDockFromFloatingBall();
      });

      ball.addEventListener("contextmenu", (event) => {
        event.preventDefault();
        renderFloatingBallContextMenu(event.clientX, event.clientY);
      });
    }
    applyFloatingBallPosition(ball);
    ball.style.display = "flex";
  }

  function applyFloatingBallPosition(ball) {
    if (!ball) return;
    const pos = STATE.floatingBallPosition;
    if (pos && Number.isFinite(pos.x) && Number.isFinite(pos.y)) {
      const x = clamp(pos.x, 0, window.innerWidth - FLOATING_BALL_SIZE);
      const y = clamp(pos.y, 0, window.innerHeight - FLOATING_BALL_SIZE);
      ball.style.left = `${x}px`;
      ball.style.top = `${y}px`;
      ball.style.right = "auto";
      ball.style.bottom = "auto";
    } else {
      ball.style.left = "auto";
      ball.style.top = "auto";
      ball.style.right = "18px";
      ball.style.bottom = "18px";
    }
  }

  function removeFloatingBallAndMenu() {
    document.getElementById(FLOATING_BALL_ID)?.remove();
    document.getElementById(FLOATING_BALL_MENU_ID)?.remove();
  }

  function renderFloatingBallContextMenu(x, y) {
    document.getElementById(FLOATING_BALL_MENU_ID)?.remove();
    const menu = document.createElement("div");
    menu.id = FLOATING_BALL_MENU_ID;
    menu.style.cssText = [
      "position:fixed",
      `left:${Math.min(x, window.innerWidth - 220)}px`,
      `top:${Math.min(y, window.innerHeight - 60)}px`,
      "width:200px",
      "z-index:2147483647",
      "background:#1f2228",
      "color:#f4f8f2",
      "border-radius:10px",
      "padding:6px 0",
      "box-shadow:0 8px 20px rgba(0,0,0,0.35)",
      "font:13px IBM Plex Sans,PingFang SC,sans-serif"
    ].join(";");
    menu.innerHTML = `
      <div data-menu-action="disable" style="padding:9px 14px;cursor:pointer;line-height:1.5;">
        在公众号后台永久隐藏<br />
        <span style="font-size:11px;color:#9aa3a8;">去扩展设置页可重新启用</span>
      </div>
    `;
    document.documentElement.appendChild(menu);
    const close = () => menu.remove();
    menu.querySelector("[data-menu-action='disable']")?.addEventListener("click", () => {
      chrome.runtime.sendMessage({ type: "DISABLE_FLOATING_BALL" }).catch(() => {});
      removeFloatingBallAndMenu();
    });
    // 点击 menu 外部关闭
    setTimeout(() => {
      document.addEventListener("mousedown", close, { once: true });
    }, 0);
  }

  function expandDockFromFloatingBall() {
    // 先 hide 浮球（dock 占据右下角空间）
    const ball = document.getElementById(FLOATING_BALL_ID);
    if (ball) ball.style.display = "none";
    // 复用 renderHelperDock，以 STATE.result 兜底（首次展开 STATE.result 为空）
    const baseResult = STATE.result || {
      pageUrl: location.href,
      isEditor: isEditorPage(),
      titleWritten: false,
      digestWritten: false,
      authorWritten: false,
      sourceUrlWritten: false,
      bodyWritten: false,
      message: ""
    };
    renderHelperDock(baseResult);
  }

  function clamp(value, min, max) {
    return Math.min(Math.max(value, min), max);
  }

  /**
   * 读 mp 后台导航栏上的「当前账号名」。启发式扫常见 selector + 文本特征：
   *   - .weui-desktop-account__nickname 老版导航栏右上角
   *   - .account-name / .nickname / [class*="nickname"]
   *   - 兜底：扫所有可见文本含「账号」「公众号」字样的小元素
   * 返 trim 后的字符串，找不到返空字符串。失败不抛错（profile 比对降级为不比对）。
   */
  function readCurrentMpAccountName() {
    const selectors = [
      ".weui-desktop-account__nickname",
      ".js_account_nickname",
      ".account_nickname",
      "[class*='nickname']",
      "[class*='account__name']",
      "[class*='accountName']"
    ];
    for (const sel of selectors) {
      try {
        const node = document.querySelector(sel);
        const text = normalizeText(node?.textContent || "");
        if (text && text.length <= 32) return text;
      } catch {}
    }
    return "";
  }

  function floatingBallStyle() {
    return [
      "position:fixed",
      "right:18px",
      "bottom:18px",
      `width:${FLOATING_BALL_SIZE}px`,
      `height:${FLOATING_BALL_SIZE}px`,
      "border-radius:50%",
      "border:none",
      "background:linear-gradient(135deg,#173722 0%,#2a5840 100%)",
      "color:#f4f8f2",
      "font-size:24px",
      "z-index:2147483646",
      "box-shadow:0 12px 24px rgba(0,0,0,0.28)",
      "cursor:pointer",
      "display:flex",
      "align-items:center",
      "justify-content:center",
      "transition:transform 120ms ease",
      "user-select:none"
    ].join(";");
  }

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

    // Safety net：必须先找到编辑器正文区（contenteditable / .ql-editor / .ProseMirror）
    // 才允许往字段里写东西。否则会出现「URL 看着像编辑页但 DOM 是列表/搜索框」的
    // 噩梦场景：findTitleField 匹配到列表的「搜索标题」输入框，把文章标题塞进搜索框。
    // isEditorPage URL 检测 + 这道 surface 检测，**双重防线**才稳。
    const editorSurface = findEditorSurface();
    if (!editorSurface) {
      result.message =
        "当前页面没有图文正文编辑区。请确认已经打开公众号「新建图文」编辑页（不是草稿箱列表 / 管理后台）后重试。";
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
    result.bodyWritten = setEditorHtml(editorSurface, payload.html || "");

    result.message = buildResultMessage(result);
    STATE.result = result;
    renderHelperDock(result);
    return result;
  }

  function isEditorPage() {
    // 必须是"真正在写图文"的 URL，不只是含 /cgi-bin/appmsg。
    // mp 后台许多列表/管理页（草稿箱、群发记录、数据中心）URL 里都有 /cgi-bin/appmsg
    // 但 query 是 action=list / action=manage 等，**不**是编辑页。
    // 编辑器实际 URL 形如：
    //   /cgi-bin/appmsg?t=media/appmsg_edit_v2&action=edit&...
    //   /cgi-bin/appmsg?...&action=add&...
    // 与 wechat-browser-bridge.js MP_EDITOR_PATH_RE 保持一致；改这里要同步改那边。
    return /\/cgi-bin\/appmsg.*?(?:action=(?:edit|add)|t=media\/appmsg_edit)/i.test(
      location.href
    );
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

    // article / section 必须在白名单：composeArticleBodyHtml + decorateHtmlForTheme
    // 把整篇文章包在 `<article style="background:...; color:...; padding:...">` 里
    // 承载主题（墨绿底 / 牛皮纸 / wired-neon 黑底等）；如果 sanitizer 把 article unwrap，
    // 主题背景 / padding / 字体一起丢失，pasted 到 mp 编辑器只剩零散段落（用户报告
    // "丢失了排版框架，没有了背景颜色"的根因）。
    // 这里与 src/shared/wechat-html.js 的 sanitizer（API 模式专用、sixteenth session
    // 已加 article/section）保持一致；改这里要同步那边。
    const allowedTags = new Set([
      "html", "head", "body", "article", "section",
      "div", "span", "p", "br", "hr",
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

    // ── 「📥 从润笔取最新草稿」区域（v0.2: 多草稿选择器 + Profile 联动）──
    // 1. 多草稿 select：STATE.payload.drafts 由 SW PULL 转发时 merge 进 payload，
    //    用户切 select 后重新 PULL 那篇（articleId 透传给 SW → workspace BUILD）。
    // 2. Profile 联动：草稿 meta.targetProfileIndex 对应的 profile.name 跟 mp 后台
    //    导航栏当前账号名做匹配，不一致时显示橙色 banner + pull 按钮 disabled
    //    防止把"为账号 A 写的稿"推进账号 B 的编辑器。
    const drafts = Array.isArray(STATE.payload?.drafts) ? STATE.payload.drafts : [];
    const selectedDraftId = STATE.payload?.selectedArticleId || drafts.find((d) => d.selected)?.id || "";
    const draftSelect =
      STATE.floatingBallEnabled && drafts.length > 1
        ? `<label style="display:flex;align-items:center;gap:6px;font-size:12px;color:#b9c7bb;">
             <span>选哪篇：</span>
             <select data-helper-action="draft-picker" style="flex:1;padding:5px 8px;border-radius:6px;border:1px solid #3f4f43;background:#101713;color:#f4f8f2;">
               ${drafts
                 .map(
                   (d) =>
                     `<option value="${escapeHtml(d.id)}" ${d.id === selectedDraftId ? "selected" : ""}>${escapeHtml(d.title.slice(0, 20))}${d.targetProfileName ? `（${escapeHtml(d.targetProfileName)}）` : ""} · ${d.wordCount}字</option>`
                 )
                 .join("")}
             </select>
           </label>`
        : "";

    // Profile 比对：targetProfileName 非空 + mp 后台读到当前账号名 + 不匹配 → banner + 禁用 pull
    const draftProfile = STATE.payload?.profile || null;
    const targetProfileName = String(draftProfile?.targetProfileName || "").trim();
    const mpAccountName = STATE.floatingBallEnabled && targetProfileName ? readCurrentMpAccountName() : "";
    // 模糊匹配：互相 includes（草稿 profile 名可能写成"主号"，mp 显示"主号-认证"等长名）
    const profileMatches =
      !targetProfileName ||
      !mpAccountName ||
      targetProfileName === mpAccountName ||
      targetProfileName.includes(mpAccountName) ||
      mpAccountName.includes(targetProfileName);
    const profileWarning =
      STATE.floatingBallEnabled && targetProfileName && mpAccountName && !profileMatches
        ? `<div style="margin-top:4px;padding:8px 10px;background:rgba(255,176,55,0.12);border:1px solid rgba(255,176,55,0.45);border-radius:8px;font-size:12px;line-height:1.6;color:#ffe2a8;">
             ⚠️ 当前 mp 后台账号：「${escapeHtml(mpAccountName)}」<br />
             这篇草稿是为「${escapeHtml(targetProfileName)}」写的，写错号会引起串号。<br />
             <strong>请先切到正确账号，或在润笔工作台改「发布账号」。</strong>
           </div>`
        : "";

    // pull 按钮 disabled 条件：① 不在编辑页；② profile 不匹配（防写错号）。
    const pullDisabled = !result.isEditor || (STATE.floatingBallEnabled && targetProfileName && mpAccountName && !profileMatches);
    const pullDisabledAttr = pullDisabled ? "disabled" : "";
    const pullDisabledStyle = pullDisabled ? "opacity:0.5;cursor:not-allowed;" : "";
    const pullTooltip = !result.isEditor
      ? "不在 mp 编辑页，无法写入"
      : !profileMatches
        ? "mp 后台账号与草稿目标账号不一致，已禁用以防写错号"
        : "从润笔工作台拉这一篇到 mp 编辑器";
    const pullLabel = drafts.length > 1 ? "📥 拉这一篇" : "📥 从润笔取最新草稿";
    const pullButton = STATE.floatingBallEnabled
      ? `<button data-helper-action="pull" ${pullDisabledAttr} title="${escapeHtml(pullTooltip)}" style="${buttonStyle("#1f6f4a")};${pullDisabledStyle}">${pullLabel}</button>`
      : "";

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
        ${draftSelect}
        ${profileWarning}
        <div style="display:flex;gap:8px;flex-wrap:wrap;">
          ${pullButton}
          <button data-helper-action="retry" style="${buttonStyle()}">重试导入</button>
          <button data-helper-action="copy" style="${buttonStyle()}">复制正文 HTML</button>
          <button data-helper-action="close" style="${buttonStyle("#3f4f43")}">关闭</button>
        </div>
      </div>
    `;

    // 多草稿 select 切换 → 重新 PULL 选中那篇（articleId 透传给 SW → workspace BUILD）
    dock.querySelector("[data-helper-action='draft-picker']")?.addEventListener("change", async (event) => {
      const articleId = event.target?.value || "";
      const pullBtn = dock.querySelector("[data-helper-action='pull']");
      if (pullBtn) {
        pullBtn.disabled = true;
        pullBtn.textContent = "切换中…";
      }
      try {
        const resp = await chrome.runtime.sendMessage({
          type: "PULL_DRAFT_TO_MP_EDITOR",
          payload: { articleId }
        });
        if (!resp?.ok) {
          const next = {
            ...(STATE.result || result),
            message: resp?.error || "切换草稿失败。"
          };
          STATE.result = next;
          renderHelperDock(next);
        }
        // ok 路径走 IMPORT_ARTICLE_TO_WECHAT_EDITOR 自动 renderHelperDock
      } catch (error) {
        const next = {
          ...(STATE.result || result),
          message: `切换草稿失败：${error?.message || "未知错误"}`
        };
        STATE.result = next;
        renderHelperDock(next);
      }
    });

    dock.querySelector("[data-helper-action='pull']")?.addEventListener("click", async () => {
      // 反馈即时性：先把状态切到 loading（用户体验：浮球 PULL 不快，约 1-3s）
      const pullBtn = dock.querySelector("[data-helper-action='pull']");
      if (pullBtn) {
        pullBtn.disabled = true;
        pullBtn.textContent = "拉取中…";
      }
      try {
        const resp = await chrome.runtime.sendMessage({ type: "PULL_DRAFT_TO_MP_EDITOR" });
        if (!resp?.ok) {
          // 把后端拼好的友好错误文案直接显示给用户
          const next = {
            ...(STATE.result || result),
            message: resp?.error || "从润笔拉草稿失败，请检查工作台是否已打开。"
          };
          STATE.result = next;
          renderHelperDock(next);
          return;
        }
        // SW 已经把 IMPORT_ARTICLE_TO_WECHAT_EDITOR 发给本 tab，
        // onMessage listener 会收到并调用 importArticle → renderHelperDock，
        // 这里不重复渲染。
      } catch (error) {
        const next = {
          ...(STATE.result || result),
          message: `拉草稿失败：${error?.message || "未知错误"}`
        };
        STATE.result = next;
        renderHelperDock(next);
      }
    });

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
      // 浮球启用时：关闭 dock = 折叠回浮球（保留 STATE.result，下次点浮球展开继续看）
      // 浮球未启用时：保留旧行为，dock 直接销毁（浏览器登录模式 push 完事后状态板的语义）
      if (STATE.floatingBallEnabled) {
        dock.style.display = "none";
        const ball = document.getElementById(FLOATING_BALL_ID);
        if (ball) {
          ball.style.display = "flex";
        } else {
          // 浮球被某种原因丢失（DOM 重渲染等）→ 重新渲染一次
          renderFloatingBall();
        }
      } else {
        dock.remove();
      }
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
