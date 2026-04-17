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
  if (!runtimeOk) {
    return;
  }
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
    const msg =
      typeof response?.error === "object" && response.error?.message ?
        response.error.message
      : typeof response?.error === "string" ?
        response.error
      : "加载失败。";
    hotStatus.textContent = msg;
    return;
  }

  const data = response.data;
  hotStatus.textContent = "";

  const time = data.fetchedAt ? new Date(data.fetchedAt).toLocaleString("zh-CN") : "";
  hotMeta.textContent = [data.label && `${data.label}`, data.detail, time && `更新：${time}`]
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
      return `
      <article class="hot-item">
        <div>
          <p class="hot-item-title">
            <span class="hot-item-index">${idx}</span>
            <a href="${escapeAttr(item.url)}" target="_blank" rel="noreferrer noopener">${escapeHtml(
              item.title
            )}</a>
          </p>
          ${item.subtitle ? `<p class="hot-item-sub">${escapeHtml(item.subtitle)}</p>` : ""}
        </div>
        <div class="hot-item-actions">
          <button type="button" class="primary ghost" data-action="express" data-url="${escapeAttr(item.url)}">📥 一键入库</button>
          <button type="button" class="ghost" data-action="card" data-url="${escapeAttr(item.url)}">分享截屏</button>
          <div style="display:flex;gap:6px">
            <button type="button" class="ghost" style="flex:1" data-action="open" data-url="${escapeAttr(item.url)}">打开</button>
            <button type="button" class="ghost" style="flex:1" data-action="copy" data-url="${escapeAttr(item.url)}">复制链</button>
          </div>
        </div>
      </article>`;
    })
    .join("");

  hotContent.innerHTML = `<div class="hot-list">${rows}</div>${
    data.notice ? `<p class="hot-notice">${escapeHtml(data.notice)}</p>` : ""
  }`;

  hotContent.querySelectorAll("button[data-action]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const url = btn.getAttribute("data-url");
      if (!url) {
        return;
      }
      
      const action = btn.dataset.action;
      
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

      if (action === "express") {
        const originalText = btn.innerHTML;
        btn.innerHTML = "📡 拉取中...";
        btn.disabled = true;
        try {
          const res = await chrome.runtime.sendMessage({
            type: "SCRAPE_BACKGROUND_AND_IMPORT",
            payload: { url }
          });
          if (res?.ok && res.data) {
            showToast("拉取成功，正在打开排版台...", "success");
            setTimeout(() => {
              chrome.tabs.create({ url: chrome.runtime.getURL("src/workspace/workspace.html") });
              btn.innerHTML = "✅ 成功";
            }, 600);
          } else {
            throw new Error((res?.error && res.error.message) ? res.error.message : "拉取失败。");
          }
        } catch (e) {
          showToast(e.message || "后台抓取失败，建议在此页面点「打开」后尝试标准抓取。");
          btn.innerHTML = originalText;
          btn.disabled = false;
        }
        return;
      }

      if (action === "card") {
        const itemObj = items.find(i => i.url === url);
        if (itemObj) {
          await drawShareCard(itemObj, data.label || "热点捕捉器");
        }
        return;
      }
    });
  });
}

function showToast(msg) {
  hotStatus.textContent = msg;
  setTimeout(() => {
    if (hotStatus.textContent === msg) hotStatus.textContent = "";
  }, 3500);
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
            经由 公众号改写排版台 获取
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
    
    // Fill white background just in case
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, 600, 300);
    ctx.drawImage(img, 0, 0, 600, 300);
    
    const pngBlob = await new Promise(resolve => canvas.toBlob(resolve, "image/png"));
    
    await navigator.clipboard.write([
      new ClipboardItem({ "image/png": pngBlob })
    ]);
    
    URL.revokeObjectURL(url);
    showToast("🎉 卡片已生成并成功复制到剪贴板，可直接粘贴！");
  } catch (error) {
    showToast("生成卡片失败，由于浏览器安全限制可能无法直接写入剪贴板。");
  }
}

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function escapeAttr(s) {
  return escapeHtml(s).replace(/'/g, "&#39;");
}

void loadSource(activeSource);
