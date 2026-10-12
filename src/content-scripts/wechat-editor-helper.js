(() => {
  const HELPER_ID = "wechat-editor-sync-helper";
  const FLOATING_BALL_ID = "wechat-editor-sync-floating-ball"; // 旧 ID 保留，向后兼容代码引用
  const STRIP_ID = "wechat-editor-sync-strip"; // v0.3 多球侧边栏外层容器
  const STRIP_POPOVER_ID = "wechat-editor-sync-strip-popover"; // 多草稿弹层 / context menu 共用 ID
  const STRIP_TOAST_ID = "wechat-editor-sync-toast"; // 拉草稿后短暂状态反馈
  const FLOATING_BALL_MENU_ID = "wechat-editor-sync-floating-ball-menu"; // 兼容旧 ID
  // v0.4 设计：主次球大小区分（核心拉草稿球 vs 次要跳转球）
  const BALL_PRIMARY_SIZE = 48;
  const BALL_SECONDARY_SIZE = 40;
  const BALL_GAP = 6;
  const BALL_LABEL_H = 14; // 每球下方 emoji 标签占高（让用户一眼看懂每个球干什么）
  // strip 总尺寸：(1*48 + 4*40) 球 + 5 个标签 + gap + padding，主球宽决定外宽
  const STRIP_WIDTH = BALL_PRIMARY_SIZE + 16;
  const STRIP_HEIGHT =
    BALL_PRIMARY_SIZE + 4 * BALL_SECONDARY_SIZE + 5 * BALL_LABEL_H + 4 * BALL_GAP + 12;
  const FLOATING_BALL_SIZE = STRIP_WIDTH; // 兼容 storage onChanged 老引用

  // v0.4 设计 token（hardcode in content-script，不靠 page :root，避免被 mp 后台 CSS 覆盖）
  // 与 src/pages/design-tokens.css 一致：墨绿 brand + 暖纸 cream + 暖橙 accent
  const TOKEN = {
    brand: "#173722",
    brandHover: "#1f4a2e",
    accent: "#b8722e",
    cream: "#f7f5ef",
    creamMuted: "#f6f4ee",
    surfaceElevated: "#fffdf8",
    ink: "#1a2620",
    inkSecondary: "#3d4f45",
    softInk: "#5a6b62",
    line: "#d4cfc3",
    lineStrong: "#c4bdb0",
    shadowMd: "0 12px 32px rgba(32,40,29,0.10),0 0 0 1px rgba(28,38,32,0.06)",
    shadowLg: "0 20px 48px rgba(28,36,30,0.14)",
    fontSans: '"DM Sans","PingFang SC","Hiragino Sans GB","Microsoft YaHei",sans-serif',
    fontSerif: '"Noto Serif SC","Source Han Serif SC","Songti SC","SimSun",serif',
    easeOut: "cubic-bezier(0.22,1,0.36,1)",
    easeSpring: "cubic-bezier(0.34,1.56,0.64,1)"
  };
  const STATE = {
    payload: null,
    result: null,
    floatingBallEnabled: false,
    floatingBallPosition: null,
    // 38th 续 14：上次同步记录（用户报"无法感知是哪一片草稿推送过来了"）。
    // importArticle 成功后写入，给 toast / 顶部常驻 banner / 浮球 tooltip 三层视觉反馈用。
    // 字段：title / articleId / bundleIndex / bundleTotal / bodyChars / syncedAt（毫秒）
    lastSyncRecord: null,
    lastSyncBannerDismissedAt: 0  // 用户手动关 banner 后 30 分钟内不再自动弹
  };
  const SYNC_BANNER_ID = "wechat-editor-sync-banner";
  const SYNC_BANNER_DISMISS_COOLDOWN_MS = 30 * 60 * 1000;
  // 模块级保存 banner 的 60s 刷新定时器：重渲染 / 移除前必须 clearInterval，
  // 否则旧 banner 被 remove 后定时器仍在 detached 节点上跑，长生命周期 mp 编辑页会累积僵尸定时器。
  let syncBannerTimer = null;
  // 「最后一公里」防丢（浏览器模式不代点保存是合规底线，只能提醒）：
  // 写入成功后 banner 常驻「尚未保存」警示，检测到公众号保存成功提示后才转「已保存」。
  // syncBannerRefresh 持有当前 banner 的重绘函数，保存探测命中后立即刷新状态行。
  let syncBannerRefresh = null;
  let mpDraftSaveState = ""; // "" 无待保存内容 / "unsaved" 已写入未保存 / "saved" 已检测到保存动作
  let saveWatchInstalled = false;
  // 39th 续³ Batch 9：草稿箱列表页的 pending banner（"已收到推送但当前不是新建图文页"引导）
  const PENDING_PULL_BANNER_ID = "wechat-pending-pull-banner";

  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    // Push 前账号比对探针（wechat-browser-bridge.js 写入前调用）：
    // 复用浮球 PULL 的 readCurrentMpAccountName 启发式，读不到返回空串由 bridge 端 fail-open。
    if (message.type === "READ_MP_ACCOUNT_NAME") {
      sendResponse({ ok: true, account: readCurrentMpAccountName() });
      return false;
    }

    // 后台任务（改写/深度去味）完成 → 浮球拉草稿球亮红点徽标（task-registry 主动推送）
    if (message.type === "RUNBI_DRAFT_READY") {
      showDraftReadyBadge(message.payload || {});
      return false;
    }

    if (message.type !== "IMPORT_ARTICLE_TO_WECHAT_EDITOR") {
      return false;
    }

    importArticle(message.payload)
      .then((result) => sendResponse({ ok: true, ...result }))
      .catch((error) => sendResponse({ ok: false, error: error.message || "同步失败。" }));

    return true;
  });

  let pendingImport = null;
  let importBusy = false;
  let latestBackup = null;
  let helperTabId = null;
  let saveObserver = null;
  let writtenImport = null;

  function notifyImportResult(status, message) {
    const isSaveStatus = ["save-unconfirmed", "saved", "unsaved", "restored"].includes(status);
    const snapshot = isSaveStatus ? writtenImport : { payload: STATE.payload, result: STATE.result };
    const payload = snapshot?.payload;
    if (!payload?.transferId) return;
    const result = { ...(snapshot.result || {}), status, message, transferId: payload.transferId };
    if (STATE.payload?.transferId === payload.transferId) STATE.result = result;
    chrome.runtime.sendMessage({ type: "WECHAT_IMPORT_RESULT", payload: result }).catch(() => {});
  }

  function accountProblem(payload) {
    const expected = normalizeText(payload.profile?.targetProfileName || payload.meta?.profileLabel || "");
    const actual = normalizeText(readCurrentMpAccountName());
    return { expected, actual, mismatch: Boolean(expected && actual && expected !== actual) };
  }

  function showImportConfirmation(payload) {
    const existing = document.getElementById("runbi-import-confirm");
    if (existing?.dataset.transferId === payload.transferId) return;
    existing?.remove();
    pendingImport = payload;
    const account = accountProblem(payload);
    const surface = findEditorSurface();
    const hasContent = Boolean(normalizeText(surface?.node?.textContent || "") || surface?.node?.querySelector("img") || fieldValue(findTitleField()));
    const text = new DOMParser().parseFromString(payload.html, "text/html").body.textContent || "";
    const dialog = document.createElement("dialog");
    dialog.id = "runbi-import-confirm";
    dialog.dataset.transferId = payload.transferId || "";
    dialog.setAttribute("aria-labelledby", "runbi-import-heading");
    dialog.style.cssText = `width:min(480px,calc(100vw - 40px));max-height:80vh;overflow:auto;border:1px solid ${TOKEN.line};border-radius:14px;padding:24px;background:${TOKEN.cream};color:${TOKEN.ink};font:14px/1.7 ${TOKEN.fontSans};box-shadow:${TOKEN.shadowLg};`;
    dialog.innerHTML = `
      <h2 id="runbi-import-heading" style="font-size:19px;margin:0 0 12px">确认导入润笔稿件</h2>
      <strong>${escapeHtml(payload.meta.title)}</strong>
      <p>目标账号：${escapeHtml(account.expected || "未指定，请核对当前账号")}<br>当前账号：${escapeHtml(account.actual || "未能读取，请人工核对")}</p>
      <p>${payload.bundle?.total > 1 ? `第 ${Number(payload.bundle.index)} / ${Number(payload.bundle.total)} 篇 · ` : ""}${text.trim().length} 字 · 本次只导入这一篇</p>
      <p style="padding:10px;background:white;border-radius:6px">${escapeHtml(text.trim().slice(0, 160))}${text.trim().length > 160 ? "…" : ""}</p>
      <p data-import-warning style="color:#a44b17">${account.mismatch ? "账号不一致，请先切换到目标公众号或在润笔修改目标账号。" : hasContent ? "当前编辑器已有内容。更新前会保存恢复副本；也可以另建一篇。" : "确认后写入标题和正文；封面及保存草稿由你在公众号完成。"}</p>
      ${!account.actual || !account.expected ? '<label style="display:block;margin-bottom:12px"><input type="checkbox" data-import-account-check> 我已核对当前公众号账号</label>' : ""}
      <div style="display:flex;gap:8px;flex-wrap:wrap">
        <button type="button" data-import-confirm style="${buttonStyle()}" ${account.mismatch ? "disabled" : ""}>${hasContent ? "更新当前篇（先备份）" : "确认导入"}</button>
        ${hasContent ? `<button type="button" data-import-new style="${buttonStyle()}">另建一篇</button>` : ""}
        <button type="button" data-import-cancel style="${buttonStyle("#68756b")}">取消</button>
      </div>`;
    const cancel = () => {
      if (importBusy) return;
      pendingImport = null;
      dialog.remove();
      notifyImportResult("cancelled", "已取消导入，公众号内容未更改。");
    };
    dialog.querySelector("[data-import-cancel]").addEventListener("click", cancel);
    dialog.addEventListener("cancel", event => { event.preventDefault(); cancel(); });
    dialog.querySelector("[data-import-new]")?.addEventListener("click", async () => {
      if (importBusy) return;
      importBusy = true;
      dialog.querySelectorAll("button").forEach(btn => { btn.disabled = true; });
      try {
        const response = await chrome.runtime.sendMessage({ type: "WECHAT_IMPORT_NEW_PAGE", payload: { transferId: payload.transferId } });
        if (!response?.ok) throw new Error(response?.error?.message || response?.error || "新建编辑页失败");
        pendingImport = null; dialog.remove();
      } catch (err) {
        dialog.querySelector("[data-import-warning]").textContent = err.message;
        dialog.querySelectorAll("button").forEach(btn => { btn.disabled = false; });
        dialog.querySelector("[data-import-confirm]").disabled = account.mismatch;
      } finally { importBusy = false; }
    });
    dialog.querySelector("[data-import-confirm]").addEventListener("click", async () => {
      if (importBusy || pendingImport !== payload) return;
      const warning = dialog.querySelector("[data-import-warning]");
      const check = dialog.querySelector("[data-import-account-check]");
      const currentAccount = accountProblem(payload);
      if (currentAccount.mismatch || currentAccount.actual !== account.actual) {
        warning.textContent = "账号状态已变化，请取消并重新确认目标公众号。"; return;
      }
      if (check && !check.checked) { warning.textContent = "请先核对当前公众号并勾选确认。"; return; }
      importBusy = true;
      dialog.querySelectorAll("button").forEach(btn => { btn.disabled = true; });
      try {
        const editor = findEditorSurface();
        if (!isEditorPage() || !editor) throw new Error("编辑页状态已变化，请重新打开新建图文。");
        const backup = { html: editor.node.innerHTML, meta: readEditorMeta(), account: currentAccount.actual, createdAt: Date.now() };
        await chrome.storage.local.set({ ["runbiWechatBackup:" + payload.destinationTabId]: backup });
        latestBackup = backup;
        const result = await writeArticle(payload, editor);
        pendingImport = null; dialog.remove();
        renderHelperDock(result);
        notifyImportResult(result.status, result.message);
      } catch (err) {
        warning.textContent = `导入未完成：${err.message}。可取消后重试。`;
        dialog.querySelectorAll("button").forEach(btn => { btn.disabled = false; });
      } finally { importBusy = false; }
    });
    document.documentElement.appendChild(dialog);
    dialog.showModal();
    dialog.querySelector("[data-import-cancel]").focus();
  }

  function fieldValue(node) { return node ? String(node.value ?? node.textContent ?? "") : ""; }
  function readEditorMeta() {
    return { title: fieldValue(findTitleField()), digest: fieldValue(findDigestField()), author: fieldValue(findAuthorField()), contentSourceUrl: fieldValue(findSourceField()) };
  }

  function settleEditor() {
    return new Promise(resolve => {
      const timer = setTimeout(resolve, 750);
      requestAnimationFrame(() => requestAnimationFrame(() => { clearTimeout(timer); resolve(); }));
    });
  }

  async function restoreBeforeImport() {
    if (!latestBackup || importBusy) return;
    const account = normalizeText(readCurrentMpAccountName());
    if (latestBackup.account && latestBackup.account !== account) { renderToast("当前账号与恢复副本不一致，请切回原账号。", "error"); return; }
    if (!window.confirm(`恢复导入前的《${latestBackup.meta.title || "未命名稿件"}》？当前编辑内容将被替换。`)) return;
    const surface = findEditorSurface();
    if (!surface) return;
    importBusy = true;
    try {
      for (const [key, find] of [["title",findTitleField],["digest",findDigestField],["author",findAuthorField],["contentSourceUrl",findSourceField]]) setFieldValue(find(), latestBackup.meta[key]);
      setEditorHtml(surface, latestBackup.html);
      await settleEditor();
      const expected = new DOMParser().parseFromString(sanitizeHtml(latestBackup.html), "text/html").body;
      const compact = text => String(text || "").replace(/\s+/g, "");
      if (compact(surface.node.textContent) !== compact(expected.textContent) || surface.node.querySelectorAll("img").length !== expected.querySelectorAll("img").length || JSON.stringify(readEditorMeta()) !== JSON.stringify(latestBackup.meta)) {
        throw new Error("恢复结果不完整，请检查编辑器");
      }
      mpDraftSaveState = "unsaved";
      saveObserver?.disconnect();
      document.getElementById(SYNC_BANNER_ID)?.remove();
      clearInterval(syncBannerTimer); syncBannerRefresh = null;
      notifyImportResult("restored", "已恢复导入前内容，请检查后手动保存。");
      renderHelperDock(STATE.result);
      renderToast("已恢复导入前内容，请检查后手动保存。", "success");
    } catch (err) { renderToast(err.message, "error"); }
    finally { importBusy = false; }
  }

  async function announceReady() {
    try {
      const response = await chrome.runtime.sendMessage({ type: "WECHAT_HELPER_READY" });
      helperTabId = response?.tabId;
      if (helperTabId) latestBackup = (await chrome.storage.local.get("runbiWechatBackup:" + helperTabId))["runbiWechatBackup:" + helperTabId] || latestBackup;
    } catch {}
  }
  void announceReady();
  // 等真实正文区挂载后续接，不能靠 tab complete 或固定延迟猜测。
  if (isEditorPage() && !findEditorSurface()) {
    const readyObserver = new MutationObserver(() => {
      if (findEditorSurface()) { readyObserver.disconnect(); void announceReady(); }
    });
    readyObserver.observe(document.documentElement, { subtree: true, childList: true });
    setTimeout(() => readyObserver.disconnect(), 60000);
  }

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
      // Phase 2.2 起：useReactFloatingBall=true 时把控制权让给 React bundle，
      // 不再由 vanilla 这边渲染 strip（避免双 strip 重叠）。
      // 切换 flag 时移除当前 vanilla strip，让 React 那边自己接管渲染。
      if (Boolean(next.useReactFloatingBall)) {
        removeFloatingBallAndMenu();
        STATE.floatingBallEnabled = Boolean(next.floatingBallEnabled);
        STATE.floatingBallPosition = next.floatingBallPosition || null;
        return;
      }
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
      // Phase 2.2 feature flag：要走 React 浮球时 vanilla 直接退出渲染逻辑，
      // 但仍保留 IMPORT_ARTICLE_TO_WECHAT_EDITOR 监听 + window.__runbi_mp_helper 暴露
      // （这两块是业务核心，与 strip UI 无关，必须永远在线）。
      // 直接读 chrome.storage.local 不走 SW round trip：避免 SW 冷启延迟，
      // 让 vanilla / React 几乎同时决定要不要渲染。
      const got = await chrome.storage.local.get("wechatWriterSettings");
      const settings = got["wechatWriterSettings"] || {};
      if (settings.useReactFloatingBall) {
        return; // React bundle 接管 UI 渲染
      }
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

  // ────────── v0.3 多球侧边栏 ──────────
  // 现有 v0.1/v0.2 的单球 + 展开 dock 模式被升级为 5 球常驻侧边栏：
  //   [📥 拉草稿] [📂 工作台] [🔥 热点] [⚙️ 设置] [❓ 帮助]
  //
  // - 1 号球（拉草稿）配 Profile 状态点（绿/红/灰），不匹配时 disabled
  // - 多草稿场景 1 号球 click → 弹左侧 popover 选篇；单草稿 click → 直接 PULL
  // - 2-5 号球 click → chrome.tabs.create 跳对应扩展页
  // - 整组拖拽（拖任一球都拖整组），位置持久化
  // - 任一球右键 → context menu「永久隐藏 / 重置位置」
  // - 拉草稿成功后右下角 toast 5s 自动消失（不再用 dock 折叠态）

  function renderFloatingBall() {
    // 兼容入口名：保留旧 renderFloatingBall 不改 storage.onChanged 调用方
    renderFloatingBallStrip();
  }

  // ── 「有新草稿可拉」徽标（RUNBI_DRAFT_READY，task-registry 任务完成推送）──
  // 状态驱动而不是直接 DOM append：refreshPullBallStatus 会整体重建 strip.innerHTML，
  // 徽标必须从 draftReadyInfo 渲染出来才能在刷新后存活。
  let draftReadyInfo = null; // null = 无提示；{ articleTitle } = 徽标亮

  function showDraftReadyBadge(info) {
    if (!STATE.floatingBallEnabled) return;
    draftReadyInfo = info || {};
    const strip = document.getElementById(STRIP_ID);
    if (strip) refreshPullBallStatus(strip);
  }

  function clearDraftReadyBadge() {
    if (!draftReadyInfo) return;
    draftReadyInfo = null;
    const strip = document.getElementById(STRIP_ID);
    if (strip) refreshPullBallStatus(strip);
  }

  function renderFloatingBallStrip() {
    ensureStripStyles(); // <style> 注入一次（hover/grab/reduced-motion 守卫等需要 :hover 选择器，inline style 做不到）
    let strip = document.getElementById(STRIP_ID);
    if (!strip) {
      strip = document.createElement("div");
      strip.id = STRIP_ID;
      strip.style.cssText = stripWrapperStyle();
      strip.innerHTML = stripBallsHtml();
      document.documentElement.appendChild(strip);
      attachStripEvents(strip);
      // 进场：5 球错落滑入（translateX(-5px)→0 + opacity 0→1，stagger 50ms × index）
      // 整条 strip 立刻渲染（不再整体 scale），让节奏感来自球之间的依次到位
      const balls = strip.querySelectorAll("button[data-strip-action]");
      balls.forEach((ball) => {
        ball.style.opacity = "0";
        ball.style.transform = "translateX(-5px)";
      });
      requestAnimationFrame(() => {
        balls.forEach((ball, index) => {
          ball.style.transitionDelay = `${index * 50}ms`;
          ball.style.opacity = "1";
          ball.style.transform = "translateX(0)";
        });
        // 入场最长 ~450ms（4*50ms stagger + 250ms transition），500ms 后清掉
        // transition-delay，避免后续 hover/active 反馈被 stagger 残值卡住
        setTimeout(() => {
          balls.forEach((ball) => {
            ball.style.transitionDelay = "0ms";
          });
        }, 500);
      });
    } else {
      // 已存在：只更新 1 号球的 Profile 状态点（其它球内容不变）
      refreshPullBallStatus(strip);
    }
    applyStripPosition(strip);
    strip.style.display = "flex";
  }

  let _stripStylesInjected = false;
  function ensureStripStyles() {
    if (_stripStylesInjected) return;
    const style = document.createElement("style");
    style.id = "wechat-editor-sync-strip-styles";
    // hover/active/focus 状态 + reduced-motion 守卫。content script 元素挂在
    // documentElement 下与 mp 后台共享样式表作用域，但用我们的 ID 前缀作 selector
    // 避免污染宿主页（mp 后台 CSS 也不会用到 rb-strip- 这种自定义前缀）。
    style.textContent = `
      #${STRIP_ID}:active { cursor: grabbing; }
      #${STRIP_ID} .rb-ball-cell {
        display: flex;
        flex-direction: column;
        align-items: center;
        gap: 2px;
      }
      #${STRIP_ID} .rb-ball-emoji {
        font-size: 20px;
        line-height: 1;
        font-family: "Apple Color Emoji","Segoe UI Emoji","Noto Color Emoji",sans-serif;
      }
      #${STRIP_ID} .rb-ball-label {
        font-size: 10px;
        line-height: 1;
        font-weight: 600;
        color: ${TOKEN.inkSecondary};
        font-family: ${TOKEN.fontSans};
        white-space: nowrap;
        pointer-events: none;
        letter-spacing: 0.2px;
      }
      #${STRIP_ID} .rb-ball-badge {
        position: absolute;
        top: -2px;
        left: -2px;
        width: 10px;
        height: 10px;
        border-radius: 50%;
        background: #e5484d;
        border: 2px solid #fff;
        box-shadow: 0 0 0 1px rgba(28,38,32,0.10);
        pointer-events: none;
      }
      #${STRIP_ID} button[data-strip-action]:hover {
        transform: scale(1.08);
        box-shadow: ${TOKEN.shadowLg};
      }
      #${STRIP_ID} button[data-strip-action="pull"]:hover {
        background: ${TOKEN.brandHover};
      }
      #${STRIP_ID} button[data-strip-action="pull"][disabled]:hover {
        transform: none;
        background: ${TOKEN.brand};
        box-shadow: 0 6px 16px rgba(23,55,34,0.24),inset 0 1px 0 rgba(255,253,248,0.08);
      }
      #${STRIP_ID} button[data-strip-action]:not([data-strip-action="pull"]):hover {
        border-color: ${TOKEN.brand};
        color: ${TOKEN.brandHover};
      }
      #${STRIP_ID} button[data-strip-action]:focus-visible {
        outline: 2px solid ${TOKEN.accent};
        outline-offset: 3px;
      }
      #${STRIP_ID} button[data-strip-action]:active {
        transform: scale(0.96);
      }
      @keyframes rb-toast-in {
        from { opacity: 0; transform: translate(-50%, 12px); }
        to   { opacity: 1; transform: translate(-50%, 0); }
      }
      @media (prefers-reduced-motion: reduce) {
        #${STRIP_ID},
        #${STRIP_ID} button[data-strip-action] {
          transition: none !important;
          animation: none !important;
        }
        #${STRIP_ID} button[data-strip-action]:hover {
          transform: none;
        }
      }
    `;
    document.documentElement.appendChild(style);
    _stripStylesInjected = true;
  }

  function stripWrapperStyle() {
    return [
      "position:fixed",
      "right:18px",
      "bottom:18px",
      `width:${STRIP_WIDTH}px`,
      "padding:6px",
      "z-index:2147483646",
      "display:flex",
      "flex-direction:column",
      "align-items:center",
      `gap:${BALL_GAP}px`,
      `background:${TOKEN.cream}`,
      "border-radius:28px", // 与项目 --radius-xl 一致
      `border:1px solid ${TOKEN.line}`,
      `box-shadow:${TOKEN.shadowMd}`,
      `font-family:${TOKEN.fontSans}`,
      "user-select:none",
      "cursor:grab",
      `transition:box-shadow 220ms ${TOKEN.easeOut},transform 220ms ${TOKEN.easeOut},opacity 220ms ${TOKEN.easeOut}`,
      "opacity:1",
      "transform:scale(1)"
    ].join(";");
  }

  // 单球样式。
  //   - 主球：墨绿底 + 暖米色衬线字
  //   - 次球：暖米底 + 墨绿衬线字 + 1px 边
  //   - hover/active 用 inline event listener 控制 transform & box-shadow
  function ballStyle({ primary = false, disabled = false } = {}) {
    const size = primary ? BALL_PRIMARY_SIZE : BALL_SECONDARY_SIZE;
    const fontSize = primary ? "20px" : "16px";
    return [
      `width:${size}px`,
      `height:${size}px`,
      "border-radius:50%",
      primary
        ? `background:${TOKEN.brand};border:1px solid ${TOKEN.brand};color:${TOKEN.cream}`
        : `background:${TOKEN.surfaceElevated};border:1px solid ${TOKEN.line};color:${TOKEN.brand}`,
      `font-family:${TOKEN.fontSerif}`,
      "font-weight:700",
      `font-size:${fontSize}`,
      "line-height:1",
      "letter-spacing:0",
      disabled ? "cursor:not-allowed;opacity:0.42" : "cursor:pointer;opacity:1",
      "display:flex",
      "align-items:center",
      "justify-content:center",
      "position:relative",
      "padding:0",
      "outline:0",
      primary
        ? `box-shadow:0 6px 16px rgba(23,55,34,0.24),inset 0 1px 0 rgba(255,253,248,0.08)`
        : "box-shadow:0 1px 2px rgba(28,38,32,0.04)",
      // transform/opacity 用 250ms ease-out 给入场 stagger 用；hover 的 scale(1.08)
      // 也走同一条曲线（牺牲了原 easeSpring 的微回弹换取入场节奏，v0.4.1 取舍）
      `transition:transform 250ms ${TOKEN.easeOut},opacity 250ms ${TOKEN.easeOut},box-shadow 220ms ${TOKEN.easeOut},background 180ms ${TOKEN.easeOut},border-color 180ms ${TOKEN.easeOut},color 180ms ${TOKEN.easeOut}`
    ].join(";");
  }

  /** Profile 匹配状态点：右上角小圆点。绿=匹配 / 红=不匹配 / 灰=未关联 / 空=未拉过草稿 */
  function profileDotHtml() {
    const drafts = Array.isArray(STATE.payload?.drafts) ? STATE.payload.drafts : [];
    const profile = STATE.payload?.profile || null;
    const targetName = String(profile?.targetProfileName || "").trim();
    if (!targetName && drafts.length === 0) return ""; // 还没拉过 / 无 profile 关联，不显点
    const mpAccount = readCurrentMpAccountName();
    // 状态点配色与项目语言对齐：用项目暖橙作 warning（替代纯红 #ef4444）；
    // 绿色用项目 brand 派生的鲜绿（视觉舒适、和墨绿主球协调）；灰色用 muted 暖灰
    let color = TOKEN.softInk;
    let title = "草稿未关联具体公众号";
    if (targetName) {
      if (!mpAccount) {
        color = TOKEN.softInk;
        title = `草稿目标：${targetName}（未读到 mp 当前账号，按理由放行）`;
      } else if (
        targetName === mpAccount ||
        targetName.includes(mpAccount) ||
        mpAccount.includes(targetName)
      ) {
        color = "#5fa56b"; // 和谐绿（比 #22c55e 更接近项目植物感）
        title = `账号匹配：${mpAccount}`;
      } else {
        color = TOKEN.accent; // 项目暖橙警示色，比红色更"刊头"
        title = `不匹配 · mp 当前是 ${mpAccount}，草稿目标是 ${targetName}`;
      }
    }
    return `<span class="rb-profile-dot" title="${escapeHtml(title)}" style="position:absolute;top:1px;right:1px;width:10px;height:10px;border-radius:50%;background:${color};border:2px solid ${TOKEN.cream};box-shadow:0 0 0 1px rgba(28,38,32,0.10);pointer-events:none;"></span>`;
  }

  /** 1 号球 disabled 条件：① !isEditorPage（列表页）② Profile 不匹配（防写错号）*/
  function isPullDisabled() { return importBusy; }

  function stripBallsHtml() {
    const pullDisabled = isPullDisabled();
    const drafts = Array.isArray(STATE.payload?.drafts) ? STATE.payload.drafts : [];
    // 38th 续 14：tooltip 末尾追加"上次同步"信息（hover 浮球能看到）
    const lastSync = STATE.lastSyncRecord;
    const lastSyncSuffix = lastSync
      ? `\n上次同步：《${lastSync.title}》· ${formatAgo(lastSync.syncedAt)}`
      : "";
    // 徽标亮时 tooltip 先说「有什么新东西」，比通用说明更有行动力
    const draftReadyPrefix =
      draftReadyInfo && !pullDisabled
        ? `🔴 润笔有新草稿可拉${
            String(draftReadyInfo.articleTitle || "").trim()
              ? `：《${String(draftReadyInfo.articleTitle).trim()}》`
              : ""
          }，点击核对并导入\n`
        : "";
    const pullTooltip = draftReadyPrefix + (!isEditorPage()
      ? "打开新建图文并导入润笔稿件"
      : pullDisabled
        ? "正在准备稿件，请稍候"
        : drafts.length > 1
          ? `从润笔工作台取草稿（${drafts.length} 篇可选）`
          : "从润笔工作台取当前激活草稿到 mp 编辑器") + lastSyncSuffix;
    // 5 球：emoji 图标 + 球下小字标签（旧版单字「取/编/热/设/问」太抽象，新人看不懂）。
    //   📥 取草稿（主动作）/ ✍️ 编辑台 / 🔥 热点 / ⚙️ 设置 / ❓ 帮助
    const cell = (action, emoji, label, tooltip, opts = {}) =>
      `<div class="rb-ball-cell">
        <button data-strip-action="${action}" type="button" tabindex="0" aria-label="${escapeHtml(tooltip)}" title="${escapeHtml(tooltip)}" style="${ballStyle(opts)}">
          <span class="rb-ball-emoji" aria-hidden="true">${emoji}</span>${opts.primary ? profileDotHtml() : ""}${opts.primary && draftReadyInfo ? '<span class="rb-ball-badge" aria-hidden="true"></span>' : ""}
        </button>
        <span class="rb-ball-label">${label}</span>
      </div>`;
    return [
      cell("pull", "📥", "导入稿件", pullTooltip, { primary: true, disabled: pullDisabled }),
      cell("open-workspace", "✍️", "编辑台", "打开润笔工作台（写 / 改 / 排版）"),
      cell("open-hot", "🔥", "热点", "热点抓题（找选题）"),
      cell("open-options", "⚙️", "设置", "打开设置"),
      cell("open-help", "❓", "帮助", "帮助与教程")
    ].join("");
  }

  /** 重渲染 1 号球（profile 状态变化、drafts 数变化时复用） */
  function refreshPullBallStatus(strip) {
    const newHtml = stripBallsHtml();
    if (strip.innerHTML !== newHtml) {
      strip.innerHTML = newHtml;
      attachStripBallClicks(strip);
    }
  }

  function attachStripEvents(strip) {
    // ── 拖拽：整组 strip 一起拖 ──
    let dragInfo = null;
    strip.addEventListener("mousedown", (event) => {
      if (event.button !== 0) return;
      // 只允许从「球之间的 strip 背景」或球自身拖；点击球本身也开启拖检测，
      // moved < 4px 的算 click 不算 drag（在 mouseup 里区分）
      const rect = strip.getBoundingClientRect();
      dragInfo = {
        startX: event.clientX,
        startY: event.clientY,
        stripX: rect.left,
        stripY: rect.top,
        moved: false,
        target: event.target
      };
    });
    window.addEventListener("mousemove", (event) => {
      if (!dragInfo) return;
      const dx = event.clientX - dragInfo.startX;
      const dy = event.clientY - dragInfo.startY;
      if (!dragInfo.moved && Math.hypot(dx, dy) < 4) return;
      dragInfo.moved = true;
      const x = clamp(dragInfo.stripX + dx, 0, window.innerWidth - STRIP_WIDTH);
      const y = clamp(dragInfo.stripY + dy, 0, window.innerHeight - STRIP_HEIGHT);
      strip.style.left = `${x}px`;
      strip.style.top = `${y}px`;
      strip.style.right = "auto";
      strip.style.bottom = "auto";
    });
    window.addEventListener("mouseup", () => {
      if (!dragInfo) return;
      const moved = dragInfo.moved;
      if (moved) {
        const rect = strip.getBoundingClientRect();
        chrome.runtime
          .sendMessage({
            type: "SAVE_FLOATING_BALL_POSITION",
            payload: { x: rect.left, y: rect.top }
          })
          .catch(() => {});
        // 拖拽后短期抑制 click（避免 mouseup 后浏览器自动 click 误触发）
        strip.dataset.justDragged = "1";
        setTimeout(() => delete strip.dataset.justDragged, 150);
      }
      dragInfo = null;
    });

    // ── 球 click 委托 ──
    attachStripBallClicks(strip);

    // ── 任一球右键 context menu ──
    strip.addEventListener("contextmenu", (event) => {
      event.preventDefault();
      renderStripContextMenu(event.clientX, event.clientY);
    });

    // ── 键盘可达性：上下方向键在球间移动焦点；Enter/Space 已是 button 默认 ──
    strip.addEventListener("keydown", (event) => {
      if (event.key !== "ArrowUp" && event.key !== "ArrowDown") return;
      const buttons = Array.from(strip.querySelectorAll("button[data-strip-action]"));
      const idx = buttons.indexOf(document.activeElement);
      if (idx < 0) return;
      event.preventDefault();
      const next =
        event.key === "ArrowDown"
          ? (idx + 1) % buttons.length
          : (idx - 1 + buttons.length) % buttons.length;
      buttons[next]?.focus();
    });
  }

  function attachStripBallClicks(strip) {
    strip.addEventListener("click", async (event) => {
      if (strip.dataset.justDragged) return; // 拖拽误触发的 click
      const button = event.target.closest("[data-strip-action]");
      if (!button) return;
      event.preventDefault();
      const action = button.dataset.stripAction;

      if (action === "pull") {
        if (isPullDisabled()) return;
        clearDraftReadyBadge(); // 用户已响应「有新草稿」提示
        const drafts = Array.isArray(STATE.payload?.drafts) ? STATE.payload.drafts : [];
        if (drafts.length > 1) {
          renderDraftPickerPopover(button);
        } else {
          await triggerPull("");
        }
        return;
      }
      // 4 个跳转球用 SW 中转 chrome.tabs.create —— content script 本身**没有**
      // chrome.tabs API（v0.3 初版误用 chrome.tabs?.create 实际为 false 走 window.open
      // fallback 被 Chrome ERR_BLOCKED_BY_CLIENT 拒绝）。SW 端 OPEN_EXTENSION_PAGE
      // handler 只接受白名单 path，防止滥用。
      const pathByAction = {
        "open-workspace": "src/workspace/workspace.html",
        "open-hot": "src/pages/hot-topics.html",
        "open-options": "src/options/options.html",
        "open-help": "src/pages/help.html"
      };
      const targetPath = pathByAction[action];
      if (targetPath) {
        chrome.runtime
          .sendMessage({ type: "OPEN_EXTENSION_PAGE", payload: { path: targetPath } })
          .catch((err) => {
            renderToast(`打开失败：${err?.message || "未知错误"}`, "error");
          });
      }
    });
  }

  /** 多草稿场景 1 号球 click 时弹出的 popover（在 strip 左侧） */
  function renderDraftPickerPopover(anchorBall) {
    document.getElementById(STRIP_POPOVER_ID)?.remove();
    const drafts = Array.isArray(STATE.payload?.drafts) ? STATE.payload.drafts : [];
    if (drafts.length === 0) return;

    const rect = anchorBall.getBoundingClientRect();
    const popover = document.createElement("div");
    popover.id = STRIP_POPOVER_ID;
    popover.style.cssText = [
      "position:fixed",
      `top:${rect.top}px`,
      `right:${window.innerWidth - rect.left + 10}px`,
      "min-width:280px",
      "max-width:360px",
      "max-height:60vh",
      "overflow-y:auto",
      "z-index:2147483647",
      `background:${TOKEN.surfaceElevated}`,
      `color:${TOKEN.ink}`,
      "border-radius:16px", // --radius-md
      `border:1px solid ${TOKEN.line}`,
      "padding:10px 0",
      `box-shadow:${TOKEN.shadowLg}`,
      `font-family:${TOKEN.fontSans}`,
      "font-size:13px",
      `animation:rb-toast-in 200ms ${TOKEN.easeOut}`
    ].join(";");
    popover.innerHTML = `
      <div style="padding:6px 14px 8px;font-size:12px;color:${TOKEN.softInk};border-bottom:1px solid ${TOKEN.line};margin-bottom:4px;">
        共 ${drafts.length} 篇，选一篇取到 mp 编辑器：
      </div>
      ${drafts
        .map(
          (d) => `
        <div data-draft-id="${escapeHtml(d.id)}" style="padding:9px 14px;cursor:pointer;line-height:1.55;border-radius:8px;margin:0 6px;${d.selected ? `background:${TOKEN.brandSoft || "rgba(23,55,34,0.08)"};` : ""}transition:background 150ms ${TOKEN.easeOut};">
          <div style="font-weight:600;font-size:13px;color:${TOKEN.ink};">${escapeHtml(d.title.slice(0, 28))}${d.title.length > 28 ? "…" : ""}</div>
          <div style="font-size:11px;color:${TOKEN.softInk};margin-top:2px;">
            ${d.wordCount} 字${d.targetProfileName ? ` · 目标账号「${escapeHtml(d.targetProfileName)}」` : ""}${d.selected ? " · 当前激活" : ""}
          </div>
        </div>
      `
        )
        .join("")}
    `;
    document.documentElement.appendChild(popover);

    popover.querySelectorAll("[data-draft-id]").forEach((row) => {
      row.addEventListener("mouseenter", () => (row.style.background = "rgba(23,55,34,0.06)"));
      row.addEventListener("mouseleave", () => {
        const isSelected = row.dataset.draftId === STATE.payload?.selectedArticleId;
        row.style.background = isSelected ? "rgba(23,55,34,0.08)" : "";
      });
      row.addEventListener("click", async () => {
        const articleId = row.dataset.draftId;
        popover.remove();
        await triggerPull(articleId);
      });
    });

    // 点 popover 外部关闭
    setTimeout(() => {
      const onOuterClick = (e) => {
        if (!popover.contains(e.target)) {
          popover.remove();
          document.removeEventListener("mousedown", onOuterClick);
        }
      };
      document.addEventListener("mousedown", onOuterClick);
    }, 0);
  }

  async function triggerPull(articleId) {
    renderToast("正在从润笔拉草稿…", "loading");
    let resp;
    try {
      resp = await chrome.runtime.sendMessage({
        type: "PULL_DRAFT_TO_MP_EDITOR",
        payload: articleId ? { articleId } : {}
      });
    } catch (err) {
      renderToast(`拉草稿失败：${err?.message || "未知错误"}`, "error");
      return;
    }
    if (!resp?.ok) {
      renderToast(resp?.error || "拉草稿失败。", "error");
      return;
    }
    renderToast(resp.data?.message || "稿件已准备好，请在公众号页面确认导入。", "info");
    // strip 也刷新一下（drafts / profile 可能变了）
    const strip = document.getElementById(STRIP_ID);
    if (strip) refreshPullBallStatus(strip);
  }

  /** 底部居中短暂 toast（5 秒自动消失，error 8 秒，loading 不自动关）。
   *  视觉与项目 design tokens 对齐：墨绿（success）/ 暖橙（error）/ 暗墨（loading/info）+ cream 文字 + 衬线字体。 */
  function renderToast(text, kind = "info") {
    ensureStripStyles(); // 复用 strip 那次注入的 keyframes
    document.getElementById(STRIP_TOAST_ID)?.remove();
    const toast = document.createElement("div");
    toast.id = STRIP_TOAST_ID;
    const bg =
      kind === "success"
        ? TOKEN.brand
        : kind === "error"
          ? "#a8443a" // popup.css --danger 对齐
          : "#2a3530"; // info / loading：暖暗
    toast.style.cssText = [
      "position:fixed",
      "left:50%",
      "transform:translate(-50%,0)",
      "bottom:28px",
      "max-width:520px",
      "padding:12px 20px",
      `background:${bg}`,
      `color:${TOKEN.cream}`,
      "border-radius:14px", // --radius-md
      "z-index:2147483647",
      `font-family:${TOKEN.fontSans}`,
      "font-size:13px",
      "line-height:1.65",
      `box-shadow:${TOKEN.shadowLg}`,
      `animation:rb-toast-in 220ms ${TOKEN.easeOut}`
    ].join(";");
    toast.textContent = text;
    document.documentElement.appendChild(toast);
    if (kind !== "loading") {
      // 38th 续 14：success toast 8s（之前 5s）让用户来得及读篇名 +
      // hover 时取消计时（用户读完再走开才消失）
      const timeoutMs = kind === "error" ? 8000 : 8000;
      let timer = setTimeout(() => toast.remove(), timeoutMs);
      toast.addEventListener("mouseenter", () => clearTimeout(timer));
      toast.addEventListener("mouseleave", () => {
        timer = setTimeout(() => toast.remove(), 2000);
      });
    }
  }

  // ─── 38th 续 14：mp 编辑器顶部常驻同步 banner ────────────────────────────
  /** 拉草稿成功后在 mp 编辑器顶部注入一个 fixed-positioned 常驻 banner，让用户
   *  事后也能看清"刚才同步过来的是哪一篇 / 字数 / 多久前同步"。
   *  - [📂 查看在润笔] 按钮：打开 workspace#layout 切到该 article
   *  - [×] 关闭：记 STATE.lastSyncBannerDismissedAt，30 分钟内不再自动弹
   *  - 时间用 setInterval 每分钟更新"X 分钟前"显示
   */
  /**
   * 39th 续³ Batch 9 · 草稿箱列表页 pending pull banner
   *
   * 触发：浮球 PULL 流程到达 mp tab 但 isEditor:false（用户停在 list_card / 素材库 /
   *      管理后台等非「新建图文」编辑页）。importArticle 早返回不写入字段，但 payload
   *      已抵达——用户感知不到"草稿已经推过来了"，会以为推送失败或在 Q 自己。
   *
   * 文案规则：
   *   1. 明确告诉用户「已检测到推送 · 文章名 · 字数」让他放心
   *   2. 解释为什么没自动写入（"当前是草稿箱列表页"）
   *   3. 给一条 actionable 引导（"请点右上角『新的创作』新建图文页"）
   *   4. 加「重新拉一次」按钮：用户切完页后想重发 PULL 时不用回 mp 浮球点
   *
   * 视觉：暖橙 accent 边线 warning 风格，区分于成功 banner 的墨绿 brand
   */
  function renderPendingPullBanner(payload) {
    document.getElementById(PENDING_PULL_BANNER_ID)?.remove();
    document.getElementById(SYNC_BANNER_ID)?.remove(); // 与成功 banner 互斥
    if (!payload) return;
    const title = String(payload.meta?.title || "").trim() || "未命名";
    const bodyChars = Number(payload?.bundle?.bodyChars || 0);
    const charsHint = bodyChars > 0 ? ` · ${bodyChars} 字` : "";

    const banner = document.createElement("div");
    banner.id = PENDING_PULL_BANNER_ID;
    banner.style.cssText = [
      "position:fixed",
      "top:12px",
      "left:50%",
      "transform:translateX(-50%)",
      "z-index:2147483646",
      "max-width:680px",
      "padding:12px 16px",
      `background:${TOKEN.surfaceElevated}`,
      `color:${TOKEN.ink}`,
      `border:1px solid ${TOKEN.line}`,
      `border-left:3px solid ${TOKEN.accent}`,
      "border-radius:10px",
      `box-shadow:${TOKEN.shadowMd}`,
      `font-family:${TOKEN.fontSans}`,
      "font-size:12px",
      "line-height:1.6",
      "display:flex",
      "align-items:flex-start",
      "gap:12px",
      `animation:rb-toast-in 240ms ${TOKEN.easeOut}`
    ].join(";");

    banner.innerHTML = `
      <span style="font-size:16px;flex:none;">📥</span>
      <span style="flex:1;min-width:0;">
        <strong style="color:${TOKEN.accent};">已检测到新推送的草稿：《${escapeHtmlAttr(title)}》${escapeHtmlAttr(charsHint)}</strong>
        <br />
        <span style="color:${TOKEN.inkSecondary};">稿件已保留，尚未写入。请先登录公众号，再打开新建图文；进入编辑器后会继续显示导入确认。</span>
      </span>
      <button type="button" data-pending-action="retry" style="flex:none;padding:5px 12px;border:1px solid ${TOKEN.accent};background:${TOKEN.accent};color:${TOKEN.cream};border-radius:6px;cursor:pointer;font-size:11px;font-weight:600;">打开新建图文</button>
      <button type="button" data-pending-action="close" aria-label="关闭" style="flex:none;width:22px;height:22px;border:none;background:transparent;color:${TOKEN.softInk};font-size:16px;line-height:1;cursor:pointer;border-radius:4px;">×</button>
    `;

    banner.querySelector('[data-pending-action="retry"]')?.addEventListener("click", () => {
      chrome.runtime.sendMessage({ type: "WECHAT_IMPORT_NEW_PAGE", payload: { transferId: payload.transferId } }).then(response => {
        if (response?.ok) banner.remove();
        else renderToast(response?.error?.message || "请先登录公众号后重试。", "error");
      }).catch(() => renderToast("请先登录公众号后重试。", "error"));
    });
    banner.querySelector('[data-pending-action="close"]')?.addEventListener("click", () => {
      banner.remove();
      notifyImportResult("cancelled", "已取消导入，公众号内容未更改。");
    });

    document.body.appendChild(banner);
  }

  /**
   * 保存按钮只进入待确认状态；新的公众号成功提示才能确认保存。
   */
  function beginUnsavedSaveWatch() {
    mpDraftSaveState = "unsaved";
    if (saveWatchInstalled) return;
    saveWatchInstalled = true;
    document.addEventListener(
      "click",
      (ev) => {
        if (!["unsaved", "save-unconfirmed"].includes(mpDraftSaveState)) return;
        const btn =
          ev.target instanceof Element
            ? ev.target.closest("button, a, [role='button'], .weui-desktop-btn")
            : null;
        const text = normalizeText(btn?.textContent || "");
        // 长文本说明命中的是段落/链接而不是操作按钮，忽略
        if (!text || text.length > 12) return;
        if (/保存/.test(text) && !btn?.closest("#" + HELPER_ID + ",#" + SYNC_BANNER_ID + ",#runbi-import-confirm")) {
          mpDraftSaveState = "save-unconfirmed";
          if (typeof syncBannerRefresh === "function") syncBannerRefresh();
          notifyImportResult("save-unconfirmed", "已点击保存，尚未确认公众号保存成功。");
          watchSaveFeedback();
        }
      },
      true
    );
  }

  function watchSaveFeedback() {
    saveObserver?.disconnect();
    const seen = new Set(document.querySelectorAll("[role=status],[role=alert],.weui-desktop-toast"));
    saveObserver = new MutationObserver(records => {
      if (mpDraftSaveState !== "save-unconfirmed") return;
      const changed = new Set(records.flatMap(r => [r.target, ...r.addedNodes]));
      for (const node of document.querySelectorAll("[role=status],[role=alert],.weui-desktop-toast")) {
        if (seen.has(node) && ![...changed].some(el => node === el || node.contains(el))) continue;
        if (!node.getClientRects().length || node.closest("#" + HELPER_ID + ",#" + SYNC_BANNER_ID)) continue;
        const text = normalizeText(node.textContent || "");
        if (/^(?:保存成功[！!。]?|已保存)$/.test(text)) {
          mpDraftSaveState = "saved"; saveObserver.disconnect();
          syncBannerRefresh?.(); notifyImportResult("saved", "已检测到公众号保存成功提示。"); return;
        }
      }
    });
    saveObserver.observe(document.documentElement, { childList: true, subtree: true, characterData: true });
    const currentObserver = saveObserver;
    setTimeout(() => currentObserver.disconnect(), 30000);
  }
  document.addEventListener("input", event => {
    if (importBusy || !mpDraftSaveState || event.target?.closest?.("#" + HELPER_ID + ",#runbi-import-confirm")) return;
    const target = findEditorSurface();
    if (target?.node.contains(event.target) || [findTitleField(),findDigestField(),findAuthorField(),findSourceField()].includes(event.target)) {
      mpDraftSaveState = "unsaved"; saveObserver?.disconnect(); syncBannerRefresh?.();
      notifyImportResult("unsaved", "内容已修改，需重新保存。");
    }
  }, true);

  function renderSyncBanner(record) {
    // 清掉上一个 banner 的刷新定时器，避免泄漏到 detached 节点
    if (syncBannerTimer) {
      clearInterval(syncBannerTimer);
      syncBannerTimer = null;
    }
    syncBannerRefresh = null;
    document.getElementById(SYNC_BANNER_ID)?.remove();
    document.getElementById(PENDING_PULL_BANNER_ID)?.remove(); // 与 pending banner 互斥
    if (!record) return;

    const banner = document.createElement("div");
    banner.id = SYNC_BANNER_ID;
    banner.style.cssText = [
      "position:fixed",
      "top:12px",
      "left:50%",
      "transform:translateX(-50%)",
      "z-index:2147483646", // 低于 toast 一档（toast 用 max int），避免叠层异常
      "max-width:640px",
      "padding:10px 16px",
      `background:${TOKEN.surfaceElevated}`,
      `color:${TOKEN.ink}`,
      `border:1px solid ${TOKEN.line}`,
      `border-left:3px solid ${TOKEN.brand}`,
      "border-radius:10px",
      `box-shadow:${TOKEN.shadowMd}`,
      `font-family:${TOKEN.fontSans}`,
      "font-size:12px",
      "line-height:1.6",
      "display:flex",
      "align-items:center",
      "gap:12px",
      `animation:rb-toast-in 240ms ${TOKEN.easeOut}`
    ].join(";");

    const updateAgo = () => {
      const ago = Math.max(0, Math.round((Date.now() - record.syncedAt) / 60000));
      const agoText = ago === 0 ? "刚刚" : `${ago} 分钟前`;
      const bundleHint = record.bundleTotal > 1
        ? ` · 第 ${record.bundleIndex}/${record.bundleTotal} 篇`
        : "";
      const charsHint = record.bodyChars > 0 ? ` · ${record.bodyChars} 字` : "";
      const saveLine =
        mpDraftSaveState === "unsaved"
          ? `<br /><span style="color:#c77700;">⚠️ 内容已写入但<strong>尚未保存</strong>——请点编辑器右上方「保存为草稿」，直接关页会丢失。</span>`
          : mpDraftSaveState === "saved"
            ? `<br /><span style="color:${TOKEN.brand};">✓ 已检测到公众号保存成功提示。</span>`
            : mpDraftSaveState === "save-unconfirmed"
              ? `<br /><span style="color:#c77700;">已点击保存，结果待确认；请以公众号的保存成功提示为准。</span>`
            : "";
      banner.innerHTML = `
        <span style="font-size:14px;">📥</span>
        <span style="flex:1;min-width:0;">
          <strong style="color:${TOKEN.brand};">${STATE.result?.status === "partial" ? "部分写入" : "已写入"}《${escapeHtmlAttr(record.title)}》</strong>
          <span style="color:${TOKEN.inkSecondary};">来自润笔${bundleHint}${charsHint} · ${agoText}</span>${saveLine}
        </span>
        <button type="button" data-banner-action="restore" style="flex:none;padding:4px 10px;cursor:pointer">恢复导入前内容</button>
        <button type="button" data-banner-action="goto" style="flex:none;padding:4px 10px;border:1px solid ${TOKEN.line};background:transparent;color:${TOKEN.brand};border-radius:6px;cursor:pointer;font-size:11px;">📂 查看在润笔</button>
        <button type="button" data-banner-action="close" aria-label="关闭" style="flex:none;width:22px;height:22px;border:none;background:transparent;color:${TOKEN.softInk};font-size:16px;line-height:1;cursor:pointer;border-radius:4px;">×</button>
      `;
      banner.querySelector('[data-banner-action="restore"]')?.addEventListener("click", () => void restoreBeforeImport());
      // 重新绑定事件（innerHTML 替换会清掉之前的 listener）
      banner.querySelector('[data-banner-action="goto"]')?.addEventListener("click", () => {
        chrome.runtime.sendMessage({
          type: "OPEN_EXTENSION_PAGE",
          payload: {
            path: "src/workspace/workspace.html",
            hash: "layout",
            articleId: record.articleId
          }
        }).catch(() => {});
      });
      banner.querySelector('[data-banner-action="close"]')?.addEventListener("click", () => {
        STATE.lastSyncBannerDismissedAt = Date.now();
        if (syncBannerTimer) {
          clearInterval(syncBannerTimer);
          syncBannerTimer = null;
        }
        syncBannerRefresh = null;
        banner.remove();
      });
    };
    updateAgo();
    syncBannerTimer = setInterval(updateAgo, 60000);
    syncBannerRefresh = updateAgo;

    document.documentElement.appendChild(banner);
  }

  /** 把毫秒时间戳格式化成"X 分钟前"的人类可读相对时间（38th 续 14） */
  function formatAgo(ts) {
    const ms = Date.now() - Number(ts || 0);
    if (!Number.isFinite(ms) || ms < 0) return "";
    const min = Math.floor(ms / 60000);
    if (min < 1) return "刚刚";
    if (min < 60) return `${min} 分钟前`;
    const hours = Math.floor(min / 60);
    if (hours < 24) return `${hours} 小时前`;
    return `${Math.floor(hours / 24)} 天前`;
  }

  function escapeHtmlAttr(s) {
    return String(s ?? "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  function applyStripPosition(strip) {
    if (!strip) return;
    const pos = STATE.floatingBallPosition;
    if (pos && Number.isFinite(pos.x) && Number.isFinite(pos.y)) {
      const x = clamp(pos.x, 0, window.innerWidth - STRIP_WIDTH);
      const y = clamp(pos.y, 0, window.innerHeight - STRIP_HEIGHT);
      strip.style.left = `${x}px`;
      strip.style.top = `${y}px`;
      strip.style.right = "auto";
      strip.style.bottom = "auto";
    } else {
      strip.style.left = "auto";
      strip.style.top = "auto";
      strip.style.right = "18px";
      strip.style.bottom = "18px";
    }
  }

  /** 兼容 storage onChanged listener 老引用（applyFloatingBallPosition / removeFloatingBallAndMenu）*/
  function applyFloatingBallPosition() {
    applyStripPosition(document.getElementById(STRIP_ID));
  }

  function removeFloatingBallAndMenu() {
    document.getElementById(STRIP_ID)?.remove();
    document.getElementById(STRIP_POPOVER_ID)?.remove();
    document.getElementById(STRIP_TOAST_ID)?.remove();
    document.getElementById(FLOATING_BALL_ID)?.remove(); // 兼容老 ID
    document.getElementById(FLOATING_BALL_MENU_ID)?.remove();
  }

  /** strip 任一球右键的 context menu。两个动作：永久隐藏 / 重置位置 */
  function renderStripContextMenu(x, y) {
    document.getElementById(STRIP_POPOVER_ID)?.remove();
    const menu = document.createElement("div");
    menu.id = STRIP_POPOVER_ID;
    menu.style.cssText = [
      "position:fixed",
      `left:${Math.min(x, window.innerWidth - 230)}px`,
      `top:${Math.min(y, window.innerHeight - 110)}px`,
      "width:220px",
      "z-index:2147483647",
      `background:${TOKEN.surfaceElevated}`,
      `color:${TOKEN.ink}`,
      "border-radius:14px",
      `border:1px solid ${TOKEN.line}`,
      "padding:6px 0",
      `box-shadow:${TOKEN.shadowLg}`,
      `font-family:${TOKEN.fontSans}`,
      "font-size:13px",
      `animation:rb-toast-in 180ms ${TOKEN.easeOut}`
    ].join(";");
    menu.innerHTML = `
      <div data-menu-action="reset-position" style="padding:9px 14px;cursor:pointer;line-height:1.5;transition:background 150ms;" onmouseenter="this.style.background='rgba(23,55,34,0.06)'" onmouseleave="this.style.background=''">
        重置位置（回到右下角）
      </div>
      <div style="height:1px;background:${TOKEN.line};margin:2px 0;"></div>
      <div data-menu-action="disable" style="padding:9px 14px;cursor:pointer;line-height:1.5;color:${TOKEN.accent};transition:background 150ms;" onmouseenter="this.style.background='rgba(184,114,46,0.08)'" onmouseleave="this.style.background=''">
        在公众号后台永久隐藏<br />
        <span style="font-size:11px;color:${TOKEN.softInk};">去扩展设置页可重新启用</span>
      </div>
    `;
    document.documentElement.appendChild(menu);
    const close = () => menu.remove();
    menu
      .querySelector("[data-menu-action='reset-position']")
      ?.addEventListener("click", () => {
        chrome.runtime
          .sendMessage({ type: "SAVE_FLOATING_BALL_POSITION", payload: { x: NaN, y: NaN } })
          .catch(() => {});
        const strip = document.getElementById(STRIP_ID);
        if (strip) {
          strip.style.left = "auto";
          strip.style.top = "auto";
          strip.style.right = "18px";
          strip.style.bottom = "18px";
        }
        STATE.floatingBallPosition = null;
        close();
      });
    menu.querySelector("[data-menu-action='disable']")?.addEventListener("click", () => {
      chrome.runtime.sendMessage({ type: "DISABLE_FLOATING_BALL" }).catch(() => {});
      removeFloatingBallAndMenu();
    });
    setTimeout(() => {
      const onOuterClick = (e) => {
        if (!menu.contains(e.target)) {
          close();
          document.removeEventListener("mousedown", onOuterClick);
        }
      };
      document.addEventListener("mousedown", onOuterClick);
    }, 0);
  }

  /** 兼容旧 expandDockFromFloatingBall 调用（已无 dock 折叠态，仅在测试 / 极端老路径触发） */
  function expandDockFromFloatingBall() {
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
    if (importBusy) return { status: "awaiting-confirmation", message: "正在处理上一篇稿件，请稍候。" };
    if (STATE.payload?.transferId !== payload.transferId) STATE.result = null;
    STATE.payload = payload;
    if (!isEditorPage()) {
      renderPendingPullBanner(payload);
      return { status: "awaiting-editor", isEditor: false, message: "稿件已保留，请登录并进入新建图文后继续导入。" };
    }
    const editor = findEditorSurface() || await waitForEditorSurface(2500);
    if (!editor) {
      renderPendingPullBanner(payload);
      return { status: "awaiting-editor", isEditor: true, message: "等待图文正文编辑区加载；稿件已保留。" };
    }
    document.getElementById(PENDING_PULL_BANNER_ID)?.remove();
    showImportConfirmation(payload);
    return { status: "awaiting-confirmation", isEditor: true, message: "请在公众号页面核对稿件和账号，再确认导入。" };
  }

  async function writeArticle(payload, editorSurface) {
    const result = { isEditor: true, pageUrl: location.origin + location.pathname, transferId: payload.transferId };
    result.titleWritten = setFieldValue(findTitleField(), payload.meta?.title || "");
    result.digestWritten = setFieldValue(findDigestField(), payload.meta?.digest || "");
    result.authorWritten = setFieldValue(findAuthorField(), payload.meta?.author || "");
    result.sourceUrlWritten = setFieldValue(
      findSourceField(),
      payload.meta?.contentSourceUrl || ""
    );
    result.bodyWritten = setEditorHtml(editorSurface, payload.html || "");
    // 留给编辑器两次渲染提交，再回读完整正文，防止 DOM 写入被编辑器模型回滚。
    await settleEditor();
    const desired = new DOMParser().parseFromString(sanitizeHtml(payload.html || ""), "text/html");
    const compact = text => String(text || "").replace(/\s+/g, "");
    result.bodyWritten = result.bodyWritten && compact(editorSurface.node.textContent) === compact(desired.body.textContent);
    result.imageCount = editorSurface.node.querySelectorAll("img").length;
    result.expectedImageCount = desired.querySelectorAll("img").length;
    result.imagesWritten = result.imageCount === result.expectedImageCount;
    const actualMeta = readEditorMeta();
    for (const [key, writtenKey] of [["title", "titleWritten"], ["digest", "digestWritten"], ["author", "authorWritten"], ["contentSourceUrl", "sourceUrlWritten"]]) {
      result[writtenKey] = result[writtenKey] && actualMeta[key] === String(payload.meta?.[key] || "");
    }

    result.status = result.bodyWritten && result.titleWritten && result.imagesWritten && result.digestWritten && result.authorWritten && result.sourceUrlWritten ? "written" : "partial";
    result.message = result.status === "written"
      ? "标题与正文已写入，尚未保存。请核对图片与封面后，在公众号手动保存草稿。"
      : "部分内容未能完整写入，请检查标题、正文和图片；可恢复导入前内容。";
    STATE.result = result;
    writtenImport = { payload, result };

    // 38th 续 14：写入 lastSyncRecord 给后续 toast / banner / 浮球 tooltip 三层视觉反馈
    // 39th 续³ Batch 8：PULL 通道（用户主动点浮球）每次强制显示 banner，跳过 30min cooldown——
    // cooldown 只对老的"自动同步"通道有意义；浮球 PULL 是用户**主动操作**且**容易拉错篇**
    // （若 workspace currentArticleIndex 与「发布」页勾选篇不同步会拉到错的 bundle[0]），
    // 必须每次都让用户看到"当前是哪篇"反馈，否则用户在 mp 编辑器里看到的内容跟期望不符
    // 时不自知就直接保存草稿了（Bug 报告: 推送的是旧草稿没自动更新）。
    if (result.bodyWritten || result.titleWritten) {
      STATE.lastSyncRecord = {
        title: String(payload.meta?.title || "").trim() || "未命名",
        articleId: String(payload?.bundle?.articleId || payload?.selectedArticleId || ""),
        bundleIndex: Number(payload?.bundle?.index || 1),
        bundleTotal: Number(payload?.bundle?.total || 1),
        bodyChars: Number(payload?.bundle?.bodyChars || 0),
        syncedAt: Number(payload?.bundle?.syncedAt || Date.now())
      };
      // 强制重置 dismissedAt 让 banner 必现
      STATE.lastSyncBannerDismissedAt = 0;
      // 每次写入都重置为「尚未保存」并确保保存动作探测在监听
      beginUnsavedSaveWatch();
      renderSyncBanner(STATE.lastSyncRecord);
    }
    renderHelperDock(result);
    return result;
  }

  function isEditorPage() {
    const url = new URL(location.href);
    return url.origin === "https://mp.weixin.qq.com" && url.pathname === "/cgi-bin/appmsg" &&
      (["edit", "add"].includes(url.searchParams.get("action")) || /^media\/appmsg_edit(?:_v\d+)?$/.test(url.searchParams.get("t") || ""));
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

  // 等编辑器正文区出现（异步挂载场景）：MutationObserver 监听 DOM 变化，
  // 每次变化重查 findEditorSurface；命中即 resolve；超时返回 null（调用方给引导）。
  function waitForEditorSurface(timeoutMs = 2500) {
    return new Promise((resolve) => {
      const immediate = findEditorSurface();
      if (immediate) return resolve(immediate);
      let done = false;
      const finish = (val) => {
        if (done) return;
        done = true;
        try {
          obs.disconnect();
        } catch {}
        clearTimeout(timer);
        resolve(val);
      };
      const obs = new MutationObserver(() => {
        const found = findEditorSurface();
        if (found) finish(found);
      });
      try {
        obs.observe(document.documentElement, { childList: true, subtree: true });
      } catch {
        return resolve(null);
      }
      const timer = setTimeout(() => finish(null), Math.max(300, timeoutMs));
    });
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
    if (!node) {
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
    if (!target?.node || typeof html !== "string") {
      return false;
    }

    const node = target.node;
    const doc = target.doc;
    const win = doc.defaultView || window;
    const safeHtml = sanitizeHtml(html);

    // —— 关键修复（连续导入第二、三篇时编辑器停留在第一篇的根因）——
    // 旧逻辑：回退路径 ②③ 的触发条件是「编辑器内容 < 20 字」（≈ 编辑器为空）。
    // 第一篇导入后编辑器已有内容，第二篇再导入时合成 paste（路径 ①）常被 ProseMirror
    // 忽略（合成 ClipboardEvent 不是 isTrusted），而 ②③ 因「编辑器非空」被跳过，
    // 于是新内容永远写不进去，必须关掉重开（清空编辑器）才行。
    // 新逻辑：判定改为「这一次有没有把『新内容』真的写进去」，而不是「编辑器是否为空」，
    // 让每次导入都强制替换为当前选中的文章。
    const beforeHtml = node.innerHTML;
    const desired = new DOMParser().parseFromString(safeHtml, "text/html");
    const compact = text => String(text || "").replace(/\s+/g, "");
    const wroteNewContent = () => (node.innerHTML !== beforeHtml || beforeHtml === safeHtml) && compact(node.textContent) === compact(desired.body.textContent) &&
      node.querySelectorAll("img").length === desired.querySelectorAll("img").length &&
      (safeHtml === "" ? node.innerHTML === "" : node.innerHTML !== "");
    const selectAll = () => {
      const range = doc.createRange();
      range.selectNodeContents(node);
      const selection = win.getSelection();
      selection.removeAllRanges(); selection.addRange(range);
    };

    try {
      node.focus();

      // ① 优先走 paste 事件（技术规范 §2.3 路径 B）：mp 编辑器是 ProseMirror，
      //    直改 innerHTML / execCommand 可能在下一次事务被回滚或样式丢失；派发带
      //    text/html 的合成 paste，让 ProseMirror 用自身粘贴管线解析入库，样式更稳。
      //    先全选，让 paste 替换整篇而不是追加。
      try {
        if (typeof win.DataTransfer === "function" && typeof win.ClipboardEvent === "function") {
          selectAll();
          const dt = new win.DataTransfer();
          dt.setData("text/html", safeHtml);
          const pasteEvent = new win.ClipboardEvent("paste", {
            bubbles: true,
            cancelable: true,
            clipboardData: dt
          });
          node.dispatchEvent(pasteEvent);
        }
      } catch {
        // 合成 paste 不被接受时静默回退到下面的 execCommand / innerHTML
      }

      // ② 回退：execCommand insertHTML —— 触发条件改为「新内容还没写进去」，
      //    而不是「编辑器为空」，否则第二篇导入时会被跳过（连续导入 bug 的根因）。
      if (!wroteNewContent() && doc.execCommand) {
        try {
          selectAll();
          doc.execCommand("insertHTML", false, safeHtml);
        } catch {}
      }

      // ③ 最后兜底：直接 innerHTML 整篇替换（前两条都没把新内容写进去）
      if (!wroteNewContent()) {
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
        "display:block",
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

    // 每次渲染都强制 reset display：dock 折叠按钮会设 display:none，第二次浮球
    // 展开时 dock 已存在不会走上面的 cssText 创建分支，display:none 会残留 →
    // 浮球点击后 expandDockFromFloatingBall 把浮球 hide，dock 仍 hidden →
    // 用户看到"浮球点击后什么都没了"（用户报告的 bug）。
    dock.style.display = "block";

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
      ? "打开新建图文并导入润笔稿件"
      : !profileMatches
        ? "正在准备稿件，请稍候"
        : "从润笔工作台拉这一篇到 mp 编辑器";
    // v0.3 strip 已经接管「拉草稿」入口，dock 内不再画 pull 按钮（避免重复）
    const pullLabel = drafts.length > 1 ? "📥 拉这一篇" : "📥 从润笔取最新草稿";
    const pullButton = ""; // strip 替代

    dock.innerHTML = `
      <div style="display:grid;gap:8px;">
        <strong style="font-size:15px;">${escapeHtml(heading)}</strong>
        <p style="margin:0;line-height:1.65;color:#d6e0d5;">${escapeHtml(result.message || "等待同步结果")}</p>
        <div style="font-size:12px;line-height:1.7;color:#b9c7bb;" ${["written", "partial"].includes(result.status) ? "" : "hidden"}>
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
          <button data-helper-action="copy" style="${buttonStyle()}">复制公众号正文</button>
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
            message: resp?.error || "同步失败，请确认润笔工作台已打开并选好文章后重试。"
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
          message: "正文已复制到剪贴板。请在公众号编辑器的正文区点一下，然后 Ctrl+V 粘贴。"
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
        ? "文章已同步到公众号编辑器。请按下方清单完成最后 3 步即可保存草稿。"
        : "文章已同步到公众号编辑器。请检查正文和右侧设置项是否正确。";
    }
    if (result.titleWritten && !result.bodyWritten) {
      return "标题已同步，但正文未成功写入。请点右侧「复制正文」按钮后手动粘贴到编辑器。";
    }
    return "自动同步未完全成功。请点右侧「复制正文」按钮后手动粘贴。";
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

  // ────────── React 浮球 bridge（Phase 2.2 起）──────────
  // 把 vanilla 这边几个**纯读 / 复用**的函数挂到 window，让 React bundle
  // （同 manifest content_scripts entry，共享 isolated world）能复用，
  // 不必把整套 mp 后台 DOM 启发式重写一遍 TS 版本。
  //
  // freeze 防止 React 端误改；不暴露任何写操作。
  // 字段契约见 src/content-scripts/floating-ball/types.ts 的 declare global window。
  if (typeof window !== "undefined" && !window.__runbi_mp_helper) {
    Object.defineProperty(window, "__runbi_mp_helper", {
      value: Object.freeze({
        readCurrentMpAccountName: () => {
          try {
            return readCurrentMpAccountName() || "";
          } catch {
            return "";
          }
        },
        isEditorPage: () => {
          try {
            return Boolean(isEditorPage());
          } catch {
            return false;
          }
        },
        renderHelperDock: (result) => {
          try {
            renderHelperDock(result);
          } catch {
            // 反馈面板渲染失败不应阻断业务，吞掉
          }
        }
      }),
      writable: false,
      configurable: false,
      enumerable: false
    });
  }
})();
