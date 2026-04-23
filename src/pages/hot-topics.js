import { formatRuntimeError, escapeHtml } from "../shared/utils.js";

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

  const response = await chrome.runtime.sendMessage({
    type: "FETCH_HOT_TOPICS",
    payload: { source, forceRefresh }
  });

  if (!response?.ok) {
    const friendly = formatRuntimeError(response?.error, "加载失败。");
    hotStatus.textContent = friendly;
    hotContent.innerHTML = `<p class="hot-notice">${escapeHtml(friendly)}</p>`;
    return;
  }

  const data = response.data;
  hotStatus.textContent = "";

  const time = data.fetchedAt ? new Date(data.fetchedAt).toLocaleString("zh-CN") : "";
  const backendLabel = formatBackend(data.backend);
  hotMeta.textContent = [
    data.label && `${data.label}`,
    data.detail,
    backendLabel && `源：${backendLabel}`,
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

  hotContent.innerHTML = `<div class="hot-list">${rows}</div>${
    data.notice ? `<p class="hot-notice">${escapeHtml(data.notice)}</p>` : ""
  }`;

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
          const res = await chrome.runtime.sendMessage({
            type: "SCRAPE_BACKGROUND_AND_IMPORT",
            payload: { url }
          });
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
            throw new Error(formatRuntimeError(res?.error, "拉取失败。"));
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
            note.textContent = `❗ ${reason}（可点「打开」后用扩展面板手动抓取，或换一条试试）`;
            itemEl.querySelector("div")?.appendChild(note);
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
  if (backend === "dailyhot") return "DailyHotApi";
  if (backend === "newsnow") return "NewsNow（备用）";
  if (backend === "direct") return "官方接口直连";
  if (backend === "reddit") return "Reddit 直连";
  if (backend === "portal") return "门户引导";
  if (backend === "rss") return "RSS 直连";
  return "";
}

void loadSource(activeSource);

