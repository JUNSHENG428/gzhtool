# 润笔桌面助手 · 打包与发布（开发者文档）

这个目录是把 `scripts/drissionpage_helper.py` 重新封装成**带 GUI 的可双击桌面 app** 的全部源码、构建脚本和 CI。

普通用户不需要关心这里——他们只需要从 GitHub Release 下载 `Runbi-Helper-mac-*.zip` 或 `Runbi-Helper-win-x64.zip`。用户向文档见 `docs/USER_DOWNLOAD_HELPER.md`。

---

## 目录结构

```
desktop/
├── README.md                       本文档
├── requirements.txt                运行时 + 构建期 Python 依赖
├── helper_app/                     Python 主程序源码（被 PyInstaller 打包）
│   ├── __init__.py
│   ├── __main__.py                 入口（python -m helper_app 也走这里）
│   ├── config.py                   产品名、bundle id、默认端口、资源路径解析
│   ├── version.py                  桌面助手版本号（独立于浏览器扩展）
│   ├── server.py                   HTTP helper + DrissionRuntime 核心逻辑
│   ├── gui.py                      Tkinter 极简 GUI
│   └── updater.py                  GitHub Release API 检查更新
├── build/
│   ├── runbi-helper.spec           PyInstaller spec（mac + win 通用）
│   ├── build_mac.sh                本机 mac 构建脚本
│   └── build_win.bat               本机 win 构建脚本
└── assets/
    ├── icon.icns                   mac app 图标（先空缺，PyInstaller 会用默认）
    ├── icon.ico                    win exe 图标
    └── icon-sources/               1024x1024 png 源
```

---

## 本机开发

```bash
# 在仓库根
python3 -m venv .venv
source .venv/bin/activate
pip install -r desktop/requirements.txt

# 直接跑 GUI（Python 解释器模式）
python3 -m desktop.helper_app

# 或者跑老版本命令行（与 0.4.0 之前完全一致）
python3 scripts/drissionpage_helper.py --port 7788
```

代码改完，**不需要重新打包**也能验证 GUI；打包是为了发给用户。

---

## 本机打包

### macOS

```bash
bash desktop/build/build_mac.sh
# 产物：
#   dist/Runbi Helper.app
#   dist/Runbi-Helper-mac-arm64.zip   （或 x86_64，看你本机）
```

如果你想同时出 arm64 + x86_64：在两台 mac（或 GitHub Actions）上分别跑。
**通用包（universal2）需要 Python 本身是 universal2 编译的**，homebrew 默认不是，建议直接靠 CI 出两个独立包即可。

### Windows

```cmd
desktop\build\build_win.bat
REM 产物：
REM   dist\Runbi Helper\Runbi Helper.exe
REM   dist\Runbi-Helper-win-x64.zip
```

---

## CI 自动构建

`.github/workflows/build-helper.yml` 已经配置好。触发方式：

- **正式发版**：打 tag `helper-vX.Y.Z` 并 push，自动构建 mac arm64 / mac x86_64 / win x64 三个产物，**自动发布 GitHub Release**。
- **手动调试**：在 Actions 页面点 "Run workflow"，会构建但不发 Release。

发版前的 checklist：
1. 改 `desktop/helper_app/version.py` 的 `__version__`
2. 改 `desktop/build/runbi-helper.spec` 里 BUNDLE 的 `version` / `CFBundleShortVersionString`（mac）
3. commit & push
4. `git tag helper-v0.1.0 && git push --tags`
5. GitHub Actions 跑完会自动出 Release，链接形如 `https://github.com/<owner>/<repo>/releases/tag/helper-v0.1.0`
6. 用户开启 helper 时会自动检查更新（5 秒超时），有新版会弹引导

---

## 签名与公证

### macOS（先不做）

- 不签名 → 用户首次打开时被 Gatekeeper 拦，要 **右键 → 打开 → 仍要打开**。
- 要做正式签名 + 公证：
  1. 申请 Apple Developer 账号（$99/年）
  2. 在 Keychain 里装 "Developer ID Application" 证书
  3. 在 spec 文件里设置 `codesign_identity="Developer ID Application: 你的名字 (TEAMID)"`
  4. 包打完后跑 `xcrun notarytool submit dist/Runbi-Helper-mac-arm64.zip --apple-id ... --team-id ... --password ... --wait`
  5. 公证完后跑 `xcrun stapler staple dist/Runbi\ Helper.app`
  6. 重新打 zip

### Windows（先不做）

- 不签名 → 用户首次打开时 SmartScreen 拦截，要 **更多信息 → 仍要运行**。
- 开源项目可申请免费证书：[SignPath.io](https://about.signpath.io/product/open-source) / Microsoft Trusted Signing
- 商业证书：Sectigo / DigiCert，~$200/年

---

## 常见坑

### 1. 打包后启动报"找不到抓取脚本"

`src/content-scripts/scrape-article.js` 没被打进 app。检查 spec 文件里 `datas` 是否带上这个文件。`config.scrape_script_path()` 会自动在 `sys._MEIPASS` 下找。

### 2. 打包后 `import DrissionPage` 报 ModuleNotFoundError

PyInstaller 静态分析漏掉了 DrissionPage 的子模块。spec 里已经用 `collect_submodules("DrissionPage")` 兜底；如果新版 DrissionPage 仍漏，加 `hiddenimports = ["DrissionPage.xxx", ...]`。

### 3. mac 跑起来红色感叹号、闪退

通常是 quarantine 标志。先排查：
- 是不是没用 `--clean` 重新打？老 cache 有问题
- 是不是把 zip 传到别的机器，`xattr -dr com.apple.quarantine "Runbi Helper.app"` 试试

### 4. Chromium 装在哪？

DrissionPage 第一次跑 `Chromium(options)` 时会提示用户系统是否已经有可用的 Chrome / Chromium 路径。**桌面助手不内置浏览器**，依赖用户系统已有的 Chrome（这也是为啥包体积只有 ~50MB 而不是 200MB）。如果用户系统没装 Chrome，启动时会报错并引导。

> 如果以后想"开箱即用、不依赖系统 Chrome"，需要把 Chromium 也打进 app（包体会涨到 ~200MB），目前不做。

### 5. tag 推了但 Release 没生成

检查 Actions 权限：仓库 Settings → Actions → General → Workflow permissions → 选 "Read and write permissions"。

---

## 版本号管理

`desktop/helper_app/version.py`、`desktop/build/runbi-helper.spec`、`git tag`、`docs/USER_DOWNLOAD_HELPER.md` 里 `latest` 应保持一致。后续可以加个 `desktop/build/bump_version.py` 自动同步，目前手动改。
