/**
 * 润笔砚台 mp 浮球 React bundle 入口
 *
 * Phase 2.1 hello-world 阶段：仅验证 esbuild + TSX + React 工具链跑通。
 * 这个文件**还未挂进 manifest content_scripts**，构建产物 bundle 不会被加载。
 *
 * Phase 2.2 起：
 *   - 检查 settings.useReactFloatingBall 决定是否真渲染
 *   - 创建 Shadow Root + ReactDOM.createRoot + 挂 <FloatingBall />
 *   - 接 SW 消息（PULL / OPEN_EXTENSION_PAGE / 等）
 */
import { createRoot } from "react-dom/client";

function HelloFloatingBall() {
  return (
    <div
      style={{
        position: "fixed",
        right: "20px",
        top: "120px",
        zIndex: 2147483646,
        padding: "8px 14px",
        background: "#173722",
        color: "#f0d4b0",
        borderRadius: "999px",
        fontFamily:
          '"Noto Serif SC","Source Han Serif SC","Songti SC","SimSun",serif',
        fontWeight: 700,
        fontSize: "12px",
        boxShadow: "0 6px 16px rgba(23,55,34,0.24)",
        userSelect: "none",
        pointerEvents: "none"
      }}
    >
      砚 · React Bundle Phase 2.1 OK
    </div>
  );
}

// Phase 2.1 阶段未挂 manifest，下面的代码不会被执行；保留作为 Phase 2.2 模板。
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const __bootstrap = () => {
  const host = document.createElement("div");
  host.id = "runbi-floating-ball-host";
  document.documentElement.appendChild(host);
  const shadow = host.attachShadow({ mode: "open" });
  const mountPoint = document.createElement("div");
  shadow.appendChild(mountPoint);
  const root = createRoot(mountPoint);
  root.render(<HelloFloatingBall />);
};

// 暂不调 __bootstrap()。Phase 2.2 起根据 feature flag 决定是否调。
void __bootstrap;
