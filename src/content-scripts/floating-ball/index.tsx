/**
 * 润笔 mp 浮球 React bundle 入口
 *
 * 加载策略：
 *   1. 注入位置：mp.weixin.qq.com（同 wechat-editor-helper.js 一条 manifest entry，
 *      共享 isolated world，能读到 vanilla 在 IIFE 末尾挂的 window.__runbi_mp_helper）
 *   2. Feature flag：仅在 settings.useReactFloatingBall === true 且
 *      settings.floatingBallEnabled === true 时真正渲染；否则 early return 让
 *      vanilla strip 接管
 *   3. Shadow Root 隔离：mp 后台 CSS 不会污染浮球（mp 编辑器是 React 写的，
 *      cascade 比一般站复杂，必须用 Shadow Root 锁住作用域）
 *   4. settings 变更监听：feature flag 跨 tab 切换时自动 mount/unmount
 */
import { createRoot, type Root } from "react-dom/client";
import { FloatingBall } from "./FloatingBall";
import {
  getFloatingBallSettings,
  watchFloatingBallSettings
} from "./lib/storage";

const HOST_ID = "runbi-react-floating-ball-host";

let mounted = false;
let root: Root | null = null;
let host: HTMLElement | null = null;

function mount(): void {
  if (mounted) return;
  host = document.createElement("div");
  host.id = HOST_ID;
  // 不参与文档流，只是 Shadow Root 的载体
  host.style.cssText = "all:initial;position:relative;z-index:auto;";
  document.documentElement.appendChild(host);
  const shadow = host.attachShadow({ mode: "open" });
  const mountPoint = document.createElement("div");
  shadow.appendChild(mountPoint);
  root = createRoot(mountPoint);
  root.render(<FloatingBall />);
  mounted = true;
}

function unmount(): void {
  if (!mounted) return;
  try {
    root?.unmount();
  } catch {
    // unmount 失败不应阻断，吞掉
  }
  if (host?.parentNode) {
    host.parentNode.removeChild(host);
  }
  root = null;
  host = null;
  mounted = false;
}

async function bootstrap(): Promise<void> {
  // 等 DOM 就绪。content script run_at: document_idle 通常已经过 DOMContentLoaded，
  // 但保险起见检查一次。
  if (document.readyState === "loading") {
    await new Promise<void>((resolve) =>
      document.addEventListener("DOMContentLoaded", () => resolve(), { once: true })
    );
  }

  const initial = await getFloatingBallSettings();
  if (initial.useReactFloatingBall && initial.floatingBallEnabled) {
    mount();
  }

  // 跨 tab 同步：options 切换 useReactFloatingBall / 用户拖到设置启用浮球时，
  // 当前 mp tab 自动 mount/unmount。
  watchFloatingBallSettings((next) => {
    const should = next.useReactFloatingBall && next.floatingBallEnabled;
    if (should && !mounted) mount();
    else if (!should && mounted) unmount();
  });
}

// content script 在 isolated world 顶层执行；不是 module，没有 main()。
// 用 promise 链跑起来，错误吞到 console 不影响 vanilla helper。
bootstrap().catch((err) => {
  console.warn("[runbi react ball] bootstrap failed:", err);
});
