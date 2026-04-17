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
          <button type="button" class="ghost" data-action="open" data-url="${escapeAttr(item.url)}">打开</button>
          <button type="button" class="ghost" data-action="copy" data-url="${escapeAttr(item.url)}">复制链接</button>
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
      if (btn.dataset.action === "open") {
        chrome.tabs.create({ url });
        return;
      }
      try {
        await navigator.clipboard.writeText(url);
        hotStatus.textContent = "已复制链接。";
        setTimeout(() => {
          hotStatus.textContent = "";
        }, 2000);
      } catch {
        hotStatus.textContent = "复制失败，请手动复制。";
      }
    });
  });
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
