#!/usr/bin/env bash
# 本机 mac 构建脚本：双击得到 dist/Runbi Helper.app + Runbi-Helper-mac-{arch}.zip
# 用法:
#   bash desktop/build/build_mac.sh           # 本机当前架构（arm64 或 x86_64）
#   ARCH=arm64 bash desktop/build/build_mac.sh
#   ARCH=universal2 bash desktop/build/build_mac.sh   # 通用包（前提：Python 也是 universal2）
#
# 前置:
#   python3 -m venv .venv
#   source .venv/bin/activate
#   pip install -r desktop/requirements.txt

set -euo pipefail

cd "$(dirname "$0")/../.."  # 切到仓库根

# —— 基本检查 —— #
if ! command -v pyinstaller >/dev/null 2>&1; then
  echo "✗ 未安装 pyinstaller。请先 pip install -r desktop/requirements.txt" >&2
  exit 1
fi

ARCH="${ARCH:-$(uname -m)}"
echo "→ 构建架构: ${ARCH}"
echo "→ Python: $(python3 --version)"
echo "→ PyInstaller: $(pyinstaller --version)"

# —— 清理上次产物 —— #
rm -rf build dist
mkdir -p dist

# —— 调用 PyInstaller —— #
# 通过环境变量把 target_arch 传给 spec（spec 里读取 PYINSTALLER_TARGET_ARCH）
TARGET_ARCH="${ARCH}" \
pyinstaller desktop/build/runbi-helper.spec --noconfirm --clean

if [[ ! -d "dist/Runbi Helper.app" ]]; then
  echo "✗ 找不到 dist/Runbi Helper.app，构建失败。" >&2
  exit 2
fi

# —— 自我冒烟：起一次打包后的 helper，用 /version 接口确认服务可用 —— #
# 不要用 `( ... & ) | head` 这种写法：detach 进程后 head 拿到 EOF 会立刻退出，
# 但 helper 进程会变成孤儿，pkill 又不一定能匹配上含空格的可执行名，导致脚本悬挂。
APP_BIN="dist/Runbi Helper.app/Contents/MacOS/Runbi Helper"
SMOKE_PORT="${SMOKE_PORT:-17799}"
if [[ -x "${APP_BIN}" ]]; then
  echo "→ 冒烟：以 --no-gui 启动 helper（端口 ${SMOKE_PORT}）"
  "${APP_BIN}" --no-gui --port "${SMOKE_PORT}" >/tmp/runbi-helper-smoke.log 2>&1 &
  SMOKE_PID=$!
  trap 'kill -TERM '"${SMOKE_PID}"' 2>/dev/null || true' EXIT
  # 给 helper 最多 8 秒启动
  for i in 1 2 3 4 5 6 7 8; do
    if curl -sf "http://127.0.0.1:${SMOKE_PORT}/version" >/dev/null 2>&1; then
      echo "  OK  /version 响应正常（用时 ${i}s）"
      break
    fi
    sleep 1
  done
  if ! curl -sf "http://127.0.0.1:${SMOKE_PORT}/version" >/dev/null 2>&1; then
    echo "  ✗ 冒烟失败：helper 没起来。日志：" >&2
    cat /tmp/runbi-helper-smoke.log >&2 || true
    kill -KILL "${SMOKE_PID}" 2>/dev/null || true
    exit 3
  fi
  kill -TERM "${SMOKE_PID}" 2>/dev/null || true
  # 等最多 3 秒优雅退出
  for i in 1 2 3; do
    if ! kill -0 "${SMOKE_PID}" 2>/dev/null; then break; fi
    sleep 1
  done
  kill -KILL "${SMOKE_PID}" 2>/dev/null || true
  trap - EXIT
fi

# —— 打 zip 给用户下载 —— #
OUT="dist/Runbi-Helper-mac-${ARCH}.zip"
( cd dist && zip -qry "Runbi-Helper-mac-${ARCH}.zip" "Runbi Helper.app" )

echo "✓ 完成: ${OUT}"
echo "  大小: $(du -sh "${OUT}" | cut -f1)"
echo ""
echo "用户首次打开提示（未签名）: 右键 → 打开 → 仍要打开"
echo "如果你要做正式签名 + 公证，看 desktop/README.md 的 \"签名与公证\" 一节。"
