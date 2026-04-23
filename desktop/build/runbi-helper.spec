# -*- mode: python ; coding: utf-8 -*-
"""PyInstaller spec：跨平台通用。

mac 用法:
    pyinstaller desktop/build/runbi-helper.spec --noconfirm --clean
    → 产物在 dist/Runbi Helper.app

win 用法:
    pyinstaller desktop/build/runbi-helper.spec --noconfirm --clean
    → 产物在 dist/Runbi Helper/Runbi Helper.exe

打包要点:
1. 必须把仓库根的 src/content-scripts/scrape-article.js 一起打进去，
   否则 helper 运行时会抛 "找不到抓取脚本"。
2. mac 必须显式 BUNDLE，不然只生成一个命令行可执行文件，没法双击。
3. DrissionPage 的子模块靠 collect_submodules() 自动收集，不要手动列。
"""

import os
import sys
from pathlib import Path

from PyInstaller.utils.hooks import collect_submodules, collect_data_files

# PyInstaller 在 exec() spec 文件时不会注入 __file__，但会注入全局变量 SPECPATH
# （= spec 文件所在的绝对目录）。所以这里必须用 SPECPATH 而不是 __file__。
# 这个 spec 位于 desktop/build/，仓库根 = parents[1]
HERE = Path(SPECPATH).resolve()  # noqa: F821 - SPECPATH 由 PyInstaller 注入
PROJECT_ROOT = HERE.parents[1]
DESKTOP_DIR = PROJECT_ROOT / "desktop"
APP_DIR = DESKTOP_DIR / "helper_app"
ASSETS_DIR = DESKTOP_DIR / "assets"
ENTRY_SCRIPT = DESKTOP_DIR / "runbi_helper.py"  # 入口壳，避免 helper_app/__main__.py 相对导入问题

# —— 跨平台 icon 选择 —— #
# 找不到图标文件时优雅降级为 None（PyInstaller 会用系统默认图标）。
# 这让首次打包不需要先准备 icns/ico 也能跑通。
if sys.platform == "darwin":
    candidate = ASSETS_DIR / "icon.icns"
elif sys.platform == "win32":
    candidate = ASSETS_DIR / "icon.ico"
else:
    candidate = None
icon_path = str(candidate) if candidate and candidate.exists() else None
if candidate and not candidate.exists():
    # 这里必须用纯 ASCII：Windows runner 的 cmd 默认 codepage 是 cp1252/cp936，
    # 写非 ASCII 字符到 stdout 会抛 UnicodeEncodeError 让整个 PyInstaller 挂掉。
    sys.stderr.write(
        f"WARN: icon file not found at {candidate}, falling back to system default. "
        "Drop an icns (mac) / ico (win) into desktop/assets/ to override.\n"
    )

# —— 资源文件（PyInstaller 解压后会落到 sys._MEIPASS 下 src/content-scripts/...） —— #
datas = [
    (
        str(PROJECT_ROOT / "src" / "content-scripts" / "scrape-article.js"),
        "src/content-scripts",
    ),
]

# —— DrissionPage 全部子模块要打进去（不然 PyInstaller 静态分析漏 import） —— #
hiddenimports = collect_submodules("DrissionPage")
# DrissionPage 自带的资源文件（settings yaml 等）
datas += collect_data_files("DrissionPage")


a = Analysis(
    [str(ENTRY_SCRIPT)],
    # pathex 同时包含仓库根（让 src/content-scripts/... 资源寻址能 work）和
    # desktop/（让 `import helper_app` 找到包）
    pathex=[str(PROJECT_ROOT), str(DESKTOP_DIR)],
    binaries=[],
    datas=datas,
    hiddenimports=hiddenimports,
    hookspath=[],
    hooksconfig={},
    runtime_hooks=[],
    excludes=[
        # 减小包体积：明确排除一些用不到的大依赖
        "matplotlib",
        "scipy",
        "PIL.ImageTk",  # tkinter 用不到 PIL
        "test",
        "tests",
    ],
    noarchive=False,
)

pyz = PYZ(a.pure)

exe = EXE(
    pyz,
    a.scripts,
    [],
    exclude_binaries=True,
    name="Runbi Helper",
    debug=False,
    bootloader_ignore_signals=False,
    strip=False,
    upx=False,
    console=False,  # GUI 模式：不弹黑色控制台
    disable_windowed_traceback=False,
    argv_emulation=False,
    target_arch=None,  # 由 build_mac.sh 通过环境变量控制 arm64/x86_64
    codesign_identity=None,
    entitlements_file=None,
    icon=icon_path,
)

coll = COLLECT(
    exe,
    a.binaries,
    a.datas,
    strip=False,
    upx=False,
    upx_exclude=[],
    name="Runbi Helper",
)

# —— mac 必须包成 .app bundle 才能双击 —— #
if sys.platform == "darwin":
    app = BUNDLE(
        coll,
        name="Runbi Helper.app",
        icon=icon_path,
        bundle_identifier="com.docuearn.helper",
        version="0.1.0",
        info_plist={
            "CFBundleName": "Runbi Helper",
            "CFBundleDisplayName": "润笔助手",
            "CFBundleShortVersionString": "0.1.0",
            "CFBundleVersion": "0.1.0",
            "NSHighResolutionCapable": True,
            # 不需要后台权限，明确声明 LSUIElement=False，让 dock 显示图标
            "LSUIElement": False,
            # 最低系统版本（DrissionPage 拉的 Chromium 一般要 macOS 10.13+）
            "LSMinimumSystemVersion": "10.13.0",
            # 让 macOS 知道这是个英文 app（避免某些场景下乱码）
            "CFBundleDevelopmentRegion": "en",
        },
    )
