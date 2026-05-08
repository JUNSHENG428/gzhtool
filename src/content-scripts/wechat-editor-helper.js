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
  // strip 总尺寸：1*48 + 4*40 + 4*6 + 12 padding = 244px 高，主球宽决定外宽
  const STRIP_WIDTH = BALL_PRIMARY_SIZE + 12;
  const STRIP_HEIGHT =
    BALL_PRIMARY_SIZE + 4 * BALL_SECONDARY_SIZE + 4 * BALL_GAP + 12;
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
  function isPullDisabled() {
    if (!isEditorPage()) return true;
    const profile = STATE.payload?.profile || null;
    const targetName = String(profile?.targetProfileName || "").trim();
    if (!targetName) return false; // 没关联 profile = 不强制比对
    const mpAccount = readCurrentMpAccountName();
    if (!mpAccount) return false; // 没读到 mp 账号 = fail-open 放行
    return !(
      targetName === mpAccount ||
      targetName.includes(mpAccount) ||
      mpAccount.includes(targetName)
    );
  }

  function stripBallsHtml() {
    const pullDisabled = isPullDisabled();
    const drafts = Array.isArray(STATE.payload?.drafts) ? STATE.payload.drafts : [];
    // 38th 续 14：tooltip 末尾追加"上次同步"信息（hover 浮球能看到）
    const lastSync = STATE.lastSyncRecord;
    const lastSyncSuffix = lastSync
      ? `\n上次同步：《${lastSync.title}》· ${formatAgo(lastSync.syncedAt)}`
      : "";
    const pullTooltip = (!isEditorPage()
      ? "不在 mp 编辑页，无法写入"
      : pullDisabled
        ? "mp 后台账号与草稿目标账号不一致，已禁用以防写错号"
        : drafts.length > 1
          ? `从润笔工作台取草稿（${drafts.length} 篇可选）`
          : "从润笔工作台取当前激活草稿到 mp 编辑器") + lastSyncSuffix;
    // 5 球字符（衬线 700）：
    //   取（拉草稿，主动作）/ 编（工作台 编辑台）/ 热（热点）/ 设（设置）/ 问（帮助）
    return `
      <button data-strip-action="pull" type="button" tabindex="0" aria-label="${escapeHtml(pullTooltip)}" title="${escapeHtml(pullTooltip)}" style="${ballStyle({ primary: true, disabled: pullDisabled })}">
        取
        ${profileDotHtml()}
      </button>
      <button data-strip-action="open-workspace" type="button" tabindex="0" aria-label="打开润笔工作台" title="打开润笔工作台" style="${ballStyle()}">编</button>
      <button data-strip-action="open-hot" type="button" tabindex="0" aria-label="热点抓题" title="热点抓题" style="${ballStyle()}">热</button>
      <button data-strip-action="open-options" type="button" tabindex="0" aria-label="打开设置" title="打开设置" style="${ballStyle()}">设</button>
      <button data-strip-action="open-help" type="button" tabindex="0" aria-label="帮助与教程" title="帮助与教程" style="${ballStyle()}">问</button>
    `;
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
    // ok 路径走 IMPORT_ARTICLE_TO_WECHAT_EDITOR → importArticle → 写入 STATE.lastSyncRecord
    // 38th 续 14：toast 文案带篇名 / 第 N/M 篇 / 字数（之前只说"已写入 mp 编辑器"用户不知道是哪篇）
    const rec = STATE.lastSyncRecord;
    if (rec) {
      const bundleHint = rec.bundleTotal > 1 ? `第 ${rec.bundleIndex}/${rec.bundleTotal} 篇 · ` : "";
      const charsHint = rec.bodyChars > 0 ? `${rec.bodyChars} 字 · ` : "";
      renderToast(
        `已同步《${rec.title}》到 mp 编辑器（${bundleHint}${charsHint}下一步：手动上传封面 + 点保存草稿）`,
        "success"
      );
    } else {
      renderToast("已写入 mp 编辑器。请按合规步骤手动 ① 上传封面 ② 点保存草稿。", "success");
    }
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
  function renderSyncBanner(record) {
    document.getElementById(SYNC_BANNER_ID)?.remove();
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
      banner.innerHTML = `
        <span style="font-size:14px;">📥</span>
        <span style="flex:1;min-width:0;">
          <strong style="color:${TOKEN.brand};">已同步《${escapeHtmlAttr(record.title)}》</strong>
          <span style="color:${TOKEN.inkSecondary};">来自润笔${bundleHint}${charsHint} · ${agoText}</span>
        </span>
        <button type="button" data-banner-action="goto" style="flex:none;padding:4px 10px;border:1px solid ${TOKEN.line};background:transparent;color:${TOKEN.brand};border-radius:6px;cursor:pointer;font-size:11px;">📂 查看在润笔</button>
        <button type="button" data-banner-action="close" aria-label="关闭" style="flex:none;width:22px;height:22px;border:none;background:transparent;color:${TOKEN.softInk};font-size:16px;line-height:1;cursor:pointer;border-radius:4px;">×</button>
      `;
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
        clearInterval(timer);
        banner.remove();
      });
    };
    updateAgo();
    const timer = setInterval(updateAgo, 60000);

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
      renderSyncBanner(STATE.lastSyncRecord);
    }
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
      ? "不在 mp 编辑页，无法写入"
      : !profileMatches
        ? "mp 后台账号与草稿目标账号不一致，已禁用以防写错号"
        : "从润笔工作台拉这一篇到 mp 编辑器";
    // v0.3 strip 已经接管「拉草稿」入口，dock 内不再画 pull 按钮（避免重复）
    const pullLabel = drafts.length > 1 ? "📥 拉这一篇" : "📥 从润笔取最新草稿";
    const pullButton = ""; // strip 替代

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
