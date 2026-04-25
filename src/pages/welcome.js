/**
 * welcome.js
 * ----------------------------------------------------------------
 * 欢迎页 onboarding 4 步任务清单：
 *   - 用 shared/onboarding.js 拉一份快照
 *   - 渲染状态（completed / skipped / pending）
 *   - 处理"稍后再说" / 步骤主按钮 / hero CTA
 *
 * 与 workspace 的首次弹层 / popup 的会员卡共用同一份数据源，避免状态漂移。
 */

import {
  getOnboardingSnapshot,
  markStepSkipped,
  resetSkips,
  subscribeOnboarding
} from "../shared/onboarding.js";

const runtimeAvailable = Boolean(globalThis.chrome?.runtime?.id);

const els = {
  list: document.querySelector("#onboardingSteps"),
  progressChip: document.querySelector("#onboardingProgressChip")
};

bindHeroActions();
void hydrate();

if (runtimeAvailable) {
  subscribeOnboarding(() => void hydrate());
}

async function hydrate() {
  if (!els.list) return;

  let snap;
  try {
    snap = await getOnboardingSnapshot();
  } catch (err) {
    console.warn("[welcome] onboarding snapshot failed", err);
    return;
  }

  renderProgress(snap);
  renderSteps(snap);
  renderOptional(snap);
}

function renderProgress(snap) {
  if (!els.progressChip) return;
  if (snap.allDone) {
    els.progressChip.textContent = "已全部完成 · 直接去编辑台开写";
    els.progressChip.dataset.tone = "success";
    return;
  }
  const total = snap.steps.length;
  const done = snap.completedCount;
  const remain = snap.pendingCount;
  els.progressChip.textContent = `完成 ${done} / ${total} · 还差 ${remain} 步`;
  els.progressChip.dataset.tone = done >= 1 ? "info" : "neutral";
}

function renderSteps(snap) {
  els.list.innerHTML = "";
  snap.steps.forEach((step, idx) => {
    const li = document.createElement("li");
    li.className = "onboarding-step";
    li.dataset.stepId = step.id;
    li.dataset.status = step.status;

    const num = document.createElement("span");
    num.className = "onboarding-step-num";
    if (step.status === "completed") {
      num.innerHTML = '<svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true"><path fill="currentColor" d="M9 16.2 4.8 12l-1.4 1.4L9 19 21 7l-1.4-1.4Z"/></svg>';
    } else if (step.status === "skipped") {
      num.textContent = "—";
    } else {
      num.textContent = String(idx + 1);
    }

    const body = document.createElement("div");
    body.className = "onboarding-step-body";

    const titleRow = document.createElement("div");
    titleRow.className = "onboarding-step-title-row";

    const title = document.createElement("p");
    title.className = "onboarding-step-title";
    title.textContent = step.title;

    const badge = document.createElement("span");
    badge.className = "onboarding-step-badge";
    badge.dataset.status = step.status;
    badge.textContent = labelForStatus(step.status, step.skippable);

    titleRow.append(title, badge);

    const desc = document.createElement("p");
    desc.className = "onboarding-step-desc muted";
    desc.textContent = step.desc;

    body.append(titleRow, desc);

    const actions = document.createElement("div");
    actions.className = "onboarding-step-actions";

    if (step.status !== "completed") {
      const cta = document.createElement("button");
      cta.type = "button";
      cta.className = "primary";
      cta.textContent = step.primaryCta?.label || "开始";
      cta.disabled = !runtimeAvailable;
      cta.addEventListener("click", () => handleStepAction(step.primaryCta?.action, step));
      actions.appendChild(cta);

      if (step.skippable && step.status !== "skipped") {
        const skip = document.createElement("button");
        skip.type = "button";
        skip.className = "ghost";
        skip.textContent = "稍后再说";
        skip.disabled = !runtimeAvailable;
        skip.addEventListener("click", async () => {
          await markStepSkipped(step.id);
          await hydrate();
        });
        actions.appendChild(skip);
      }
    } else {
      const tag = document.createElement("span");
      tag.className = "muted";
      tag.textContent = "✓ 已完成";
      actions.appendChild(tag);
    }

    body.appendChild(actions);
    li.append(num, body);
    els.list.appendChild(li);
  });

  if (snap.allDone) {
    const li = document.createElement("li");
    li.className = "onboarding-all-done";
    li.innerHTML = `
      <p class="onboarding-step-title">全部 4 步已经走通 ✓</p>
      <p class="muted">下次直接进编辑台或工作台就行；可以来这里查看进度，也可以重置清单。</p>
    `;
    const reset = document.createElement("button");
    reset.type = "button";
    reset.className = "ghost";
    reset.textContent = "重置上手清单";
    reset.disabled = !runtimeAvailable;
    reset.addEventListener("click", async () => {
      await resetSkips();
      await hydrate();
    });
    li.appendChild(reset);
    els.list.appendChild(li);
  }
}

function renderOptional(snap) {
  const hint = document.querySelector("#onboardingWechatHint");
  if (!hint) return;
  const wechat = snap.optionalChecks?.wechatBound;
  if (wechat?.status === "completed") {
    hint.textContent = "已绑定公众号，可以在编辑台直接「推草稿」或「立即发布」。";
  }
}

function labelForStatus(status, skippable) {
  if (status === "completed") return "已完成";
  if (status === "skipped") return "已跳过";
  if (skippable) return "可跳过";
  return "未完成";
}

function bindHeroActions() {
  document.querySelectorAll("[data-action]").forEach((btn) => {
    btn.addEventListener("click", () => {
      if (!runtimeAvailable) return;
      handleStepAction(btn.dataset.action);
    });
  });
}

async function handleStepAction(action, step) {
  if (!runtimeAvailable) return;
  switch (action) {
    case "start-trial": {
      // 主 CTA：直接打开工作台并触发抓当前页（autocapture=1）
      await chrome.tabs.create({
        url: chrome.runtime.getURL("src/workspace/workspace.html?autocapture=1")
      });
      return;
    }
    case "open-workspace": {
      await chrome.tabs.create({
        url: chrome.runtime.getURL("src/workspace/workspace.html")
      });
      return;
    }
    case "open-options":
    case "open-options-wechat": {
      // 两个动作都打开设置页；wechat 变体追加 hash 锚点
      const path =
        action === "open-options-wechat"
          ? "src/options/options.html#wechatSection"
          : "src/options/options.html";
      try {
        await chrome.tabs.create({ url: chrome.runtime.getURL(path) });
      } catch {
        await chrome.runtime.openOptionsPage();
      }
      return;
    }
    case "open-publish": {
      await chrome.tabs.create({
        url: chrome.runtime.getURL("src/workspace/workspace.html#publish")
      });
      return;
    }
    case "popup-capture": {
      // 没法直接触发 popup；引导用户打开 popup 自己点
      await chrome.tabs.create({
        url: chrome.runtime.getURL("src/workspace/workspace.html?autocapture=1")
      });
      return;
    }
    default: {
      // 兼容未知 action：走 step 的 fallback（如果有）
      if (step?.primaryCta?.fallbackUrl) {
        await chrome.tabs.create({ url: step.primaryCta.fallbackUrl });
      }
    }
  }
}
