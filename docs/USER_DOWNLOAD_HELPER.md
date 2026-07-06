# 安装润笔桌面助手（DrissionPage 增强抓取）

只有想用 **DrissionPage 增强抓取** 的 Pro 用户需要装这个。普通抓取不需要。

> 这是「润笔」浏览器扩展的配套桌面小程序。它在你电脑上跑一个本地服务，让扩展可以借助 DrissionPage 抓取动态加载/有反爬的网页。

---

## 一分钟安装（推荐）

### macOS

1. 打开 GitHub Release：<https://github.com/JUNSHENG428/gzhtool/releases?q=helper-v&expanded=true>
2. 下载 **`Runbi-Helper-mac-arm64.zip`**（Apple Silicon，M1/M2/M3/M4）
   - 不确定自己是哪种 mac？左上角  → 关于本机 → 看「芯片」一栏；2020 年以后买的 mac 几乎都是 Apple Silicon。
   - 用 Intel mac？首发暂未提供 Intel 包（GitHub Intel runner 排队过长），可以 [开 issue](https://github.com/JUNSHENG428/gzhtool/issues) 留言，我们会按需求决定要不要补 `Runbi-Helper-mac-x86_64.zip`。
3. 双击解压，把 `Runbi Helper.app` 拖到 `应用程序` 文件夹
4. **第一次打开必须右键**：
   - 在 Finder 里右键 `Runbi Helper.app` → **打开**
   - 系统弹窗"无法验证开发者" → 点 **打开** / **仍要打开**
   - 之后双击就能直接开了
5. 看到状态灯变绿、显示 `运行中 · http://127.0.0.1:7788` 就 OK

> **为什么要右键？** 因为我们暂时还没买 Apple 开发者证书，macOS 默认会拦未签名 app。这一步只需要做一次。

### Windows

1. 打开同样的 Release 页面
2. 下载 `Runbi-Helper-win-x64.zip`
3. 解压到任意位置（比如 `C:\Tools\RunbiHelper`）
4. 双击 `Runbi Helper.exe`
5. **第一次打开 SmartScreen 会拦截**：
   - 弹窗「Windows 已保护你的电脑」 → 点 **更多信息** → 点 **仍要运行**
   - 之后再打开就不会拦了
6. 看到状态灯变绿就 OK

---

## 让浏览器扩展用上它

1. 在桌面助手窗口里点 **复制 helper 地址**
   - 默认会带上一段类似 `?token=…` 的鉴权参数，例如：
     `http://127.0.0.1:7788/?token=ab12cd…`
   - 这个 token 是为了**防止本机别的程序偷偷调用 helper**，请把整段地址都复制走
2. 打开浏览器扩展的「设置」页
3. 找到「DrissionPage 增强抓取」一栏，把整段地址粘进 **helper 地址** 输入框
   - 扩展会自动把 token 拆出来加密保存，输入框里只会保留 `http://127.0.0.1:7788/`
   - 提示行显示 ✅ 表示 token 已识别成功
4. 勾选「启用 DrissionPage 增强抓取」
5. 点 **测试增强抓取服务**，看到「连接成功」就完成

之后在编辑台、热点页抓取网页时，扩展会优先走 DrissionPage 通道；helper 不可达时自动回退到内置抓取，不会卡死。

> **token 为什么重要？**helper 在 127.0.0.1 上开了 HTTP 服务，理论上同一台机器里任意应用都能访问。token 鉴权能保证只有"知道密码"的浏览器扩展才能调用 `/scrape`，避免被其它程序当作 SSRF 中转跳板。

---

## 常见问题

### Q1：开机要每次手动启动桌面助手吗？

是的，目前需要。后续版本会加「开机自启动」开关。

如果你想现在就让它开机自启：
- mac：把 `Runbi Helper.app` 拖到 `系统设置 → 通用 → 登录项` 里
- win：在桌面助手的安装目录上右键 `Runbi Helper.exe` → 创建快捷方式 → 把快捷方式放到 `shell:startup` 文件夹里

### Q2：报"端口已被占用"怎么办？

在桌面助手窗口里把端口改成别的（比如 7798），重启 helper，然后回扩展设置页同步把地址改成新端口。

### Q3：报"无法启动 Chromium"？

DrissionPage 需要你电脑上已经装了 Chrome 浏览器。下载并安装 Chrome：<https://www.google.com/chrome/>。

### Q4：抓取还是失败？

打开桌面助手 → 点「打开日志目录」→ 把最新的 `helper.log` 发给客服。

### Q5：怎么升级？

- 桌面助手启动时会**自动检查更新**，发现新版会弹窗引导下载
- 也可以在窗口里点「检查更新」手动查
- 升级 = 关掉旧版 → 下载新版 zip → 替换旧文件 → 启动

### Q6：会偷偷上传我的数据吗？

不会。
- 桌面助手只在 `127.0.0.1` 上开服务，**外网访问不到**
- 只接受来自浏览器扩展的请求
- 默认开启 **token 鉴权**：没拿到 token 的本机程序也调不到 `/scrape`
- 默认 **拒绝抓取本机/内网地址**（`127.0.0.1`、`10.0.0.0/8`、`192.168.0.0/16` 等），避免被当成 SSRF 跳板
- 抓取的内容直接传给浏览器扩展，不走任何第三方服务器
- 每次抓取成功后会在**你自己的电脑**上留一份 Markdown 存档（`~/Documents/Runbi/Inbox/`，
  Windows 为 `文档\Runbi\Inbox\`），方便留档检索；不需要可以直接删文件，它不会上传到任何地方
- 源代码完全开源，可以审：[查看 helper_app 源码](../desktop/helper_app/)

### Q8：扩展报「helper token 不匹配」怎么办？

通常是因为你在桌面助手 GUI 里点过「重置 token」，但忘了在扩展里更新地址。

修复办法：
1. 在桌面助手窗口里点 **复制 helper 地址**（拿到带新 token 的完整地址）
2. 打开浏览器扩展的「设置」页 → 把整段地址粘到 **helper 地址** 输入框
3. 点 **保存**，再点 **测试增强抓取服务**

### Q9：我想让 helper 抓本机的某个调试页面（比如 `http://localhost:3000`）

默认是禁止的（防 SSRF）。如果你确认要这么做：
```bash
# mac:
"/Applications/Runbi Helper.app/Contents/MacOS/Runbi Helper" --no-gui --allow-private-hosts
```
或者在桌面助手 GUI 启动参数区勾选「允许抓取本机/内网地址」。

### Q7：能用 Edge / 360 浏览器吗？

DrissionPage 默认会去找 Chrome。如果你只装了别的 Chromium 内核浏览器（比如 Edge），先打开桌面助手的命令行模式：

```bash
# mac:
"/Applications/Runbi Helper.app/Contents/MacOS/Runbi Helper" --no-gui --browser-path "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge"
```

或者直接装一份 Chrome（最省事）。

---

## 卸载

- mac：把 `应用程序` 里的 `Runbi Helper.app` 拖到废纸篓
- win：删掉解压目录即可

附加日志清理（可选）：
- mac：`~/Library/Logs/Runbi Helper`
- win：`%LOCALAPPDATA%\Runbi Helper\Logs`
