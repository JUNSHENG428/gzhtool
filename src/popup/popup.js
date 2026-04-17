const statusElement = document.querySelector("#status");

document.querySelector("#captureAndOpen").addEventListener("click", async () => {
  await runAction(
    { type: "PREPARE_SOURCE_AND_OPEN_WORKSPACE" },
    "已打开编辑台，准备抓取当前页面。"
  );
});

document.querySelector("#openWorkspace").addEventListener("click", async () => {
  await runAction({ type: "OPEN_WORKSPACE", autoCapture: false }, "已打开编辑台。");
});

document.querySelector("#openOptions").addEventListener("click", async () => {
  await chrome.runtime.openOptionsPage();
  window.close();
});

document.querySelector("#openWelcome").addEventListener("click", async () => {
  await openInternalPage("src/pages/welcome.html");
});

document.querySelector("#openHotTopics").addEventListener("click", async () => {
  await openInternalPage("src/pages/hot-topics.html");
});

document.querySelector("#openHelp").addEventListener("click", async () => {
  await openInternalPage("src/pages/help.html");
});

async function runAction(message, successText) {
  setStatus("处理中...", "info");
  const response = await chrome.runtime.sendMessage(message);
  if (!response?.ok) {
    setStatus(response?.error || "执行失败。", "error");
    return;
  }

  setStatus(successText, "success");
  window.close();
}

let statusFadeTimer = null;

function setStatus(message, type = "info") {
  clearTimeout(statusFadeTimer);

  const validTypes = new Set(["info", "success", "warning", "error"]);
  const safeType = validTypes.has(type) ? type : "info";

  statusElement.textContent = message;
  statusElement.setAttribute("data-status-type", safeType);
  statusElement.classList.remove("is-faded");

  const durationMs = safeType === "error" ? 8000 : 4000;

  statusFadeTimer = setTimeout(() => {
    statusElement.classList.add("is-faded");
  }, durationMs);
}

async function openInternalPage(path) {
  await chrome.tabs.create({ url: chrome.runtime.getURL(path) });
  window.close();
}
