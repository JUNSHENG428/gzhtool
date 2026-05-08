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
# 39th 续³ Batch 13：增强清理。原 rm -rf 在 macOS 偶发遇到 .app 被 Finder/
# Spotlight/quicklook 索引或上次 helper 进程未完全退出，报 "Directory not empty"。
# 修法：① 先 pkill 残留 helper 进程；② rm -rf 失败时 sleep 1 自动重试一次；
# ③ 仍失败给用户清晰的错误指引而非崩溃退出。
pkill -f "Runbi Helper.app/Contents/MacOS/Runbi Helper" 2>/dev/null || true
rm -rf build dist 2>/dev/null || true
if [[ -d dist || -d build ]]; then
  echo "→ 首次清理未完成，等 1s 后重试（Finder/Spotlight 释放索引锁）"
  sleep 1
  rm -rf build dist 2>/dev/null || true
fi
if [[ -d dist || -d build ]]; then
  echo "✗ 清理 dist/build 仍然失败。可能原因：" >&2
  echo "  1. 仍有 Runbi Helper 进程在运行 → pkill -f 'Runbi Helper'" >&2
  echo "  2. Finder 中已打开 dist/ 窗口 → 关闭 Finder 中此目录窗口" >&2
  echo "  3. 文件权限问题 → ls -la@ dist build 看 ACL/xattr" >&2
  echo "  手动清理后重试：rm -rf build dist && bash $0" >&2
  exit 1
fi
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
