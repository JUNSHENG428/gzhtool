import { formatRuntimeError, escapeHtml } from "../shared/utils.js";
import { ensureHostPermissionFromGesture } from "../shared/host-permissions.js";
import {
  getPromptTemplates,
  getActiveTemplateId,
  setActiveTemplateId,
  getSettings
} from "../shared/storage.js";

/* ============== 单平台浏览 ============== */

const hotContent = document.querySelector("#hotContent");
const hotMeta = document.querySelector("#hotMeta");
const hotStatus = document.querySelector("#hotStatus");
const refreshBtn = document.querySelector("#refreshHot");
const filterInput = document.querySelector("#hotFilterInput");

const runtimeOk = Boolean(globalThis.chrome?.runtime?.id);

document.querySelectorAll(".hot-sources-container [data-source]").forEach((btn) => {
  btn.addEventListener("click", () => selectSource(btn.dataset.source));
});

refreshBtn.addEventListener("click", () => {
  const current = document.querySelector('.hot-sources-container [aria-selected="true"]');
  void loadSource(current?.dataset.source || "zhihu", true);
});

filterInput?.addEventListener("input", (e) => {
  const val = e.target.value.trim().toLowerCase();
  document.querySelectorAll(".hot-item").forEach((el) => {
    const text = el.textContent.toLowerCase();
    el.style.display = text.includes(val) ? "" : "none";
  });
});

document.querySelector("[data-open-workspace]")?.addEventListener("click", (e) => {
  e.preventDefault();
  if (!runtimeOk) return;
  chrome.tabs.create({ url: chrome.runtime.getURL("src/workspace/workspace.html") });
});

let activeSource = "zhihu";

function selectSource(source) {
  activeSource = source;
  document.querySelectorAll(".hot-sources-container [data-source]").forEach((b) => {
    const on = b.dataset.source === source;
    b.setAttribute("aria-selected", on ? "true" : "false");
  });
  void loadSource(source);
}

async function loadSource(source, forceRefresh = false) {
  if (!runtimeOk) {
    hotContent.innerHTML =
      '<p class="hot-notice">请在 Chrome 扩展环境中打开本页以拉取热点。</p>';
    return;
  }

  hotStatus.textContent = "正在拉取…";
  hotContent.innerHTML = "";
  hotMeta.textContent = "";
  if (filterInput) filterInput.value = "";

  // 用户配了自托 newsnow base 时，必须在 click 用户手势里同步申请 origin —— 否则
  // SW 端 ensureOptionalHostPermission 会抛 "must be called during a user gesture"。
  // 默认源的 origin 在固定 host_permissions 里，传空 URL 会被 helper 短路返回 true。
  const settings = await getSettings();
  const customBase = settings?.hotTopicsNewsnowBase || "";
  if (customBase) {
    const permitted = await ensureHostPermissionFromGesture(customBase, "热点接口");
    if (!permitted) {
      hotStatus.textContent = "需要授权访问该热点接口域名，请允许后再试。";
      hotContent.innerHTML = `<p class="hot-notice">需要授权访问该热点接口域名，请允许后再试。</p>`;
      return;
    }
  }

  const response = await chrome.runtime.sendMessage({
    type: "FETCH_HOT_TOPICS",
    payload: { source, forceRefresh }
  });

  if (!response?.ok) {
    const err = response?.error;
    if (err?.code === "HOT_TOPICS") {
      // 结构化错误卡片：状态栏只留一句话，细节与操作按钮都在卡片里，
      // 避免同一大段文案在 status + content 里重复出现两遍。
      hotStatus.textContent = "这次没拉到数据，可在下方选择重试或换源。";
      renderFetchError(source, err);
    } else {
      const friendly = formatRuntimeError(err, "加载失败。");
      hotStatus.textContent = friendly;
      hotContent.innerHTML = `<p class="hot-notice">${escapeHtml(friendly)}</p>`;
    }
    return;
  }

  const data = response.data;
  hotStatus.textContent = "";

  const time = data.fetchedAt ? new Date(data.fetchedAt).toLocaleString("zh-CN") : "";
  const backendLabel = formatBackend(data.backend);
  hotMeta.textContent = [
    data.label && `${data.label}`,
    data.detail,
    data.stale ? "⏳ 缓存兜底" : backendLabel && `源：${backendLabel}`,
    time && `更新：${time}`
  ]
    .filter(Boolean)
    .join(" · ");

  if (data.mode === "portal") {
    renderPortal(data);
    return;
  }

  renderList(data);
}

function renderPortal(data) {
  const p = data.portal;
  if (!p) {
    hotContent.innerHTML = "<p>暂无数据。</p>";
    return;
  }

  hotContent.innerHTML = `
    <div class="hot-portal">
      <h3>${escapeHtml(p.title)}</h3>
      <p>${escapeHtml(p.description)}</p>
      <button type="button" class="primary" id="openPortalUrl">${escapeHtml(p.buttonLabel || "打开")}</button>
    </div>
    ${data.notice ? `<p class="hot-notice">${escapeHtml(data.notice)}</p>` : ""}
  `;

  document.querySelector("#openPortalUrl")?.addEventListener("click", () => {
    chrome.tabs.create({ url: p.url });
  });
}

// 拉取失败时的可操作错误卡片：一句结论 + 每个后端一行明细 + 建议 + 动作按钮。
// 目标是让用户「看得懂 + 有事可做」，而不是面对一大段技术文案。
function renderFetchError(source, err) {
  const label = err.label || "该来源";
  const lines = Array.isArray(err.errors) ? err.errors.filter(Boolean) : [];
  const advice = err.advice || (lines.length === 0 ? err.message || "" : "");

  // 换源建议：从「较稳定」池子里挑 2 个非当前源
  const alternates = [
    { id: "weibo", label: "微博热搜" },
    { id: "github", label: "GitHub 趋势" },
    { id: "36kr", label: "36氪快讯" }
  ]
    .filter((s) => s.id !== source)
    .slice(0, 2);

  hotContent.innerHTML = `
    <div class="hot-error-card" role="alert">
      <p class="hot-error-title">⚠️ 「${escapeHtml(label)}」这一次没拉到数据</p>
      ${
        lines.length
          ? `<ul class="hot-error-detail">${lines
              .map((l) => `<li>${escapeHtml(l)}</li>`)
              .join("")}</ul>`
          : ""
      }
      ${advice ? `<p class="hot-error-advice">${escapeHtml(advice)}</p>` : ""}
      <div class="hot-error-actions">
        <button type="button" class="primary" data-err-act="retry">🔄 强制刷新重试</button>
        ${alternates
          .map(
            (s) =>
              `<button type="button" class="ghost" data-err-act="switch" data-source="${escapeAttr(
                s.id
              )}">换到 ${escapeHtml(s.label)}</button>`
          )
          .join("")}
        <button type="button" class="ghost" data-err-act="settings">打开「热点接口」设置</button>
      </div>
    </div>`;

  hotContent.querySelector('[data-err-act="retry"]')?.addEventListener("click", () => {
    void loadSource(source, true);
  });
  hotContent.querySelectorAll('[data-err-act="switch"]').forEach((btn) => {
    btn.addEventListener("click", () => selectSource(btn.dataset.source));
  });
  hotContent.querySelector('[data-err-act="settings"]')?.addEventListener("click", () => {
    chrome.tabs.create({
      url: chrome.runtime.getURL("src/options/options.html#opt-anchor-hot")
    });
  });
}

function renderList(data) {
  const items = data.items || [];
  if (items.length === 0) {
    hotContent.innerHTML = `<p class="hot-notice">${escapeHtml(
      data.notice || "暂无条目。"
    )}</p>`;
    return;
  }

  const rows = items
    .map((item, index) => {
      const idx = index + 1;
      const hasUrl = typeof item.url === "string" && item.url.trim().length > 0;
      const safeUrl = hasUrl ? escapeAttr(item.url) : "";
      // 没有 url 的条目（多数是榜单纯文本/付费墙）只展示标题，不挂死按钮
      const titleHtml = hasUrl
        ? `<a href="${safeUrl}" target="_blank" rel="noreferrer noopener">${escapeHtml(item.title)}</a>`
        : `<span class="hot-item-title-text">${escapeHtml(item.title)}</span>`;
      const disabledAttr = hasUrl ? "" : ' disabled aria-disabled="true" title="该条目没有可访问的原文链接"';
      return `
      <article class="hot-item">
        <div>
          <p class="hot-item-title">
            <span class="hot-item-index">${idx}</span>
            ${titleHtml}
          </p>
          ${item.subtitle ? `<p class="hot-item-sub">${escapeHtml(item.subtitle)}</p>` : ""}
          ${hasUrl ? "" : '<p class="hot-item-sub" style="color:#a87548">⚠️ 该条目没有原文链接，无法一键入库</p>'}
        </div>
        <div class="hot-item-actions">
          <button type="button" class="primary" data-action="express-rewrite" data-url="${safeUrl}"${disabledAttr} title="抓取原文 + 自动 AI 改写一步到位（需要 Pro 或 AI 已配置）">✨ 抓取并改写</button>
          <button type="button" class="primary ghost" data-action="express" data-url="${safeUrl}"${disabledAttr}>📥 仅入库</button>
          <button type="button" class="ghost" data-action="card" data-url="${safeUrl}">分享截屏</button>
          <div style="display:flex;gap:6px">
            <button type="button" class="ghost" style="flex:1" data-action="open" data-url="${safeUrl}"${disabledAttr}>打开</button>
            <button type="button" class="ghost" style="flex:1" data-action="copy" data-url="${safeUrl}"${disabledAttr}>复制链</button>
          </div>
        </div>
      </article>`;
    })
    .join("");

  // 缓存兜底的提示必须放在列表上方，用户第一眼就要知道「这不是实时数据」
  const noticeHtml = data.notice
    ? `<p class="hot-notice${data.stale ? " hot-notice--stale" : ""}">${escapeHtml(data.notice)}</p>`
    : "";
  hotContent.innerHTML = data.stale
    ? `${noticeHtml}<div class="hot-list">${rows}</div>`
    : `<div class="hot-list">${rows}</div>${noticeHtml}`;

  bindItemActions(hotContent, items, data.label || "热点捕捉器");
}

function bindItemActions(container, items, sourceLabel) {
  container.querySelectorAll("button[data-action]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      if (btn.disabled) return;
      const url = btn.getAttribute("data-url");
      const action = btn.dataset.action;
      if (!url) {
        if (action === "card") {
          // 截图卡片不需要 url
        } else {
          showToast("该条目没有原文链接，跳过该操作。");
          return;
        }
      }

      if (action === "open") {
        chrome.tabs.create({ url });
        return;
      }
      if (action === "copy") {
        try {
          await navigator.clipboard.writeText(url);
          showToast("已复制链接。");
        } catch {
          showToast("复制失败，请手动复制。");
        }
        return;
      }
      if (action === "express" || action === "express-rewrite") {
        const autoRewrite = action === "express-rewrite";
        const originalText = btn.innerHTML;
        const itemEl = btn.closest(".hot-item");
        // 清掉这个条目上一次留下的失败提示（如有）
        itemEl?.querySelector(".hot-item-error")?.remove();
        itemEl?.classList.remove("is-error");

        btn.innerHTML = autoRewrite ? "📡 拉取 + 排队改写..." : "📡 拉取中...";
        btn.disabled = true;
        try {
          // 必须在 click handler 还在用户手势上下文时同步申请 origin 权限 ——
          // 否则 SW 端的 ensureOptionalHostPermission 会抛 "must be called during a user gesture"。
          const permitted = await ensureHostPermissionFromGesture(url, "抓取并改写");
          if (!permitted) {
            btn.innerHTML = originalText;
            btn.disabled = false;
            showToast("需要授权访问该网页才能抓取，请在弹窗里点「允许」后再试。");
            return;
          }
          // 兜底超时：service-worker 极端情况会被 Chrome 回收，sendMessage 会一直 hang。
          // 加 35 秒超时（比 background 内部 15s waitForTabComplete + 5s buffer 略宽），
          // 超时后给出明确文案，避免出现"按下去几分钟没反应"。
          const res = await sendMessageWithTimeout(
            { type: "SCRAPE_BACKGROUND_AND_IMPORT", payload: { url } },
            35_000
          );
          if (res?.ok && res.data) {
            const targetUrl =
              chrome.runtime.getURL("src/workspace/workspace.html") +
              (autoRewrite ? "?import=1&autoRewrite=1" : "?import=1");
            showToast(
              autoRewrite
                ? "拉取成功，正在打开排版台并排队 AI 改写..."
                : "拉取成功，正在打开排版台..."
            );
            setTimeout(() => {
              chrome.tabs.create({ url: targetUrl });
              btn.innerHTML = "✅ 成功";
            }, 600);
          } else {
            throw new Error(formatRuntimeError(res?.error, "拉取失败：后台无响应。"));
          }
        } catch (e) {
          // 同时在 toolbar 顶部给个 toast、按钮上变红、条目下方留一行 inline 错误，
          // 三层提示叠加让用户绝对不会"按下去没反应"。
          const reason = e.message || "后台抓取失败";
          showToast(reason);
          btn.innerHTML = "❌ 失败 · 重试";
          btn.disabled = false;
          btn.classList.add("is-error");
          if (itemEl) {
            itemEl.classList.add("is-error");
            const note = document.createElement("p");
            note.className = "hot-item-sub hot-item-error";
            // 失败原因 + 可执行的兜底建议（打开原文 → 用扩展面板抓 / 换一条 / 复制错误）。
            note.textContent = `❗ ${reason}`;
            const tip = document.createElement("p");
            tip.className = "hot-item-sub";
            tip.style.opacity = "0.7";
            tip.textContent = "可点「打开」后用扩展面板手动抓取，或换一条试试。";
            const containerDiv = itemEl.querySelector("div");
            containerDiv?.appendChild(note);
            containerDiv?.appendChild(tip);
          }
          // 几秒后把按钮文字恢复，但保留 is-error 样式与 inline 提示，
          // 让用户既能看见上次失败，也能再点一次重试
          setTimeout(() => {
            if (btn.innerHTML.includes("失败")) {
              btn.innerHTML = originalText;
            }
          }, 5000);
        }
        return;
      }
      if (action === "card") {
        const itemObj = items.find((i) => i.url === url);
        if (itemObj) await drawShareCard(itemObj, sourceLabel);
        return;
      }
    });
  });
}

function showToast(msg, durationMs) {
  hotStatus.textContent = msg;
  // 错误信息（包含❌/失败/错误等关键字）默认停留更久；普通成功提示 3.5s
  const isErr = /❌|失败|错误|抓取失败|拉取失败|超时|无法/.test(msg);
  const ttl = durationMs ?? (isErr ? 7000 : 3500);
  setTimeout(() => {
    if (hotStatus.textContent === msg) hotStatus.textContent = "";
  }, ttl);
}

/**
 * sendMessage 加超时兜底。
 * MV3 service worker 可能被回收，此时 sendMessage 在某些边界情况下会一直 hang
 * （Chrome 自身的 bug，比较罕见但用户体感很差）。统一加一个超时上限，超时后
 * 抛友好错误，给用户兜底建议。
 */
function sendMessageWithTimeout(message, timeoutMs) {
  return new Promise((resolve, reject) => {
    let done = false;
    const timer = setTimeout(() => {
      if (done) return;
      done = true;
      reject(
        new Error(
          `等待后台响应超时（${Math.round(timeoutMs / 1000)} 秒）。` +
            "可能是该网页加载非常慢、或扩展后台需要重启。请打开原文后用扩展面板手动抓取。"
        )
      );
    }, timeoutMs);

    chrome.runtime.sendMessage(message, (resp) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      const lastErr = chrome.runtime?.lastError;
      if (lastErr) {
        reject(new Error(`扩展通信失败：${lastErr.message || "lastError"}`));
        return;
      }
      resolve(resp);
    });
  });
}

async function drawShareCard(item, sourceLabel) {
  showToast("正在生成卡片...");
  const svgMarkup = `
    <svg xmlns="http://www.w3.org/2000/svg" width="600" height="300">
      <foreignObject width="100%" height="100%">
        <div xmlns="http://www.w3.org/1999/xhtml" style="font-family: system-ui, sans-serif; height: 100%; box-sizing: border-box; padding: 24px; background: linear-gradient(135deg, #fffdf8, #f5f0e3); color: #2c2720; border-radius: 12px; display: flex; flex-direction: column; justify-content: center; position: relative;">
          <h2 style="font-size: 26px; line-height: 1.4; margin: 0 0 12px; font-weight: 700; color: #1a1612;">
            ${escapeHtml(item.title)}
          </h2>
          <p style="font-size: 16px; margin: 0; color: #5c4f3d; opacity: 0.8;">
            ${escapeHtml(item.subtitle || sourceLabel)}
          </p>
          <div style="position: absolute; bottom: 20px; right: 24px; font-size: 12px; font-weight: bold; color: #b56b24; opacity: 0.6;">
            经由 润笔 获取
          </div>
        </div>
      </foreignObject>
    </svg>
  `;

  try {
    const blob = new Blob([svgMarkup], { type: "image/svg+xml;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const img = new Image();
    await new Promise((resolve, reject) => {
      img.onload = resolve;
      img.onerror = reject;
      img.src = url;
    });

    const canvas = document.createElement("canvas");
    canvas.width = 600;
    canvas.height = 300;
    const ctx = canvas.getContext("2d");
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, 600, 300);
    ctx.drawImage(img, 0, 0, 600, 300);

    const pngBlob = await new Promise((resolve) =>
      canvas.toBlob(resolve, "image/png")
    );

    await navigator.clipboard.write([
      new ClipboardItem({ "image/png": pngBlob })
    ]);
    URL.revokeObjectURL(url);
    showToast("🎉 卡片已生成并成功复制到剪贴板，可直接粘贴！");
  } catch (error) {
    showToast("生成卡片失败，由于浏览器安全限制可能无法直接写入剪贴板。");
  }
}

function escapeAttr(s) {
  return escapeHtml(s).replace(/'/g, "&#39;");
}

function formatBackend(backend) {
  if (backend === "newsnow") return "NewsNow";
  if (backend === "rsshub") return "RSSHub 兜底";
  if (backend === "direct") return "官方接口直连";
  if (backend === "reddit") return "Reddit 直连";
  if (backend === "portal") return "门户引导";
  if (backend === "rss") return "RSS 直连";
  return "";
}

void loadSource(activeSource);
void initRewriteTemplateBar();

/* ============== 改写模板可见性 chip ============== */

/**
 * 在热点页顶部展示「点 抓取并改写 时会用这个模板」chip。
 * 解决用户经常忘了选模板就直接点 ✨ 抓取并改写 → workspace 用上一次的随机模板
 * → 浪费 AI 配额这个体感最差的踩坑。
 *
 * 行为：
 *  - 加载已有 prompt templates + 当前 activeId
 *  - activeId 为空 / 不在列表里时自动选第一项并回写 storage（避免后台 service-worker
 *    走兜底路径返回不可控模板）
 *  - 切换 select 立刻写回 storage，options/workspace 下次打开会自动同步
 *  - 监听 chrome.storage.onChanged 同步 options/workspace 那边的改动
 *  - 「管理模板」链接兜底打开 options page
 */
async function initRewriteTemplateBar() {
  const select = document.querySelector("#hotRewriteTemplateSelect");
  const bar = document.querySelector('[data-el="rewriteTemplateBar"]');
  const manageLink = bar?.querySelector('[data-act="manage-templates"]');
  if (!select || !bar) return;

  if (!runtimeOk) {
    bar.hidden = true;
    return;
  }

  manageLink?.addEventListener("click", (e) => {
    e.preventDefault();
    if (typeof chrome.runtime.openOptionsPage === "function") {
      chrome.runtime.openOptionsPage();
    } else {
      chrome.tabs.create({ url: chrome.runtime.getURL("src/pages/options.html") });
    }
  });

  let templates = [];

  async function refresh({ forceWriteFirst = true } = {}) {
    try {
      const [tpls, activeId] = await Promise.all([
        getPromptTemplates(),
        getActiveTemplateId()
      ]);
      templates = Array.isArray(tpls) ? tpls : [];

      if (templates.length === 0) {
        select.innerHTML = `<option value="">（暂无模板，请先到「管理模板」新建）</option>`;
        select.disabled = true;
        select.dataset.activeId = "";
        return;
      }

      select.disabled = false;
      const known = new Set(templates.map((t) => t.id));
      let nextActive = activeId;
      if (!nextActive || !known.has(nextActive)) {
        nextActive = templates[0].id;
        if (forceWriteFirst) {
          await setActiveTemplateId(nextActive);
        }
      }

      select.innerHTML = templates
        .map((t) => {
          const label = `${t.icon || "📝"} ${t.name || "未命名模板"}`;
          return `<option value="${escapeAttr(t.id)}">${escapeHtml(label)}</option>`;
        })
        .join("");
      select.value = nextActive;
      select.dataset.activeId = nextActive;
    } catch (err) {
      console.warn("[hot-topics] 加载改写模板列表失败：", err);
      select.innerHTML = `<option value="">（模板列表加载失败）</option>`;
      select.disabled = true;
    }
  }

  select.addEventListener("change", async () => {
    const value = select.value;
    if (!value) return;
    try {
      await setActiveTemplateId(value);
      select.dataset.activeId = value;
      const picked = templates.find((t) => t.id === value);
      const label = picked?.name || "新模板";
      showToast(`下次「抓取并改写」将使用：${label}`);
    } catch (err) {
      console.warn("[hot-topics] 切换默认模板失败：", err);
      showToast("切换默认模板失败，请稍后重试。");
    }
  });

  // options/workspace 改了模板或 activeId，这里同步刷新；不再重复回写 storage
  // 避免环式 onChanged 触发。
  if (chrome.storage?.onChanged?.addListener) {
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== "local") return;
      if (
        Object.prototype.hasOwnProperty.call(changes, "wechatWriterActiveTemplateId") ||
        Object.prototype.hasOwnProperty.call(changes, "wechatWriterPromptTemplates")
      ) {
        void refresh({ forceWriteFirst: false });
      }
    });
  }

  await refresh();
}

