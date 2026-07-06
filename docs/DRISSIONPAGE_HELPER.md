# DrissionPage 增强抓取

Chrome 扩展本身只能在当前标签页里注入 JS 抓取网页，遇到更重的动态页面、长时间懒加载、局部反爬时，容易拿不到正文。这个项目现在支持一个**可选的本地 DrissionPage helper** 作为增强抓取通道。

## 什么时候该开

- 页面要滚动很多次才出正文
- 文章图片是滚动后才补出来的
- 站点对扩展注入抓取不稳定，但普通 Chromium 自动化还能打开
- 你要抓热点页打开的新链接，想让它先在后台多跑一层动态加载

注意：

- 「只抓选中文字」模式仍然走扩展内置抓取，不走 DrissionPage。
- 默认 helper 会启动一套独立 Chromium；如果目标网页依赖你的登录态，请改用接管本机浏览器或指定用户目录。

## 本地启动

先确认已安装 DrissionPage：

```bash
pip install DrissionPage
```

然后在仓库根目录启动 helper：

```bash
python3 scripts/drissionpage_helper.py
```

默认监听 `http://127.0.0.1:7788`，设置页里填同一个地址即可。

## 常用启动方式

默认 headless：

```bash
python3 scripts/drissionpage_helper.py --port 7788
```

需要看见浏览器窗口排查页面：

```bash
python3 scripts/drissionpage_helper.py --no-headless
```

需要复用指定用户目录：

```bash
python3 scripts/drissionpage_helper.py --user-data-path /path/to/chrome-profile --no-headless
```

需要接管你自己手动开的 Chrome（先用远程调试端口启动）：

```bash
python3 scripts/drissionpage_helper.py --browser-address 127.0.0.1:9222 --no-headless
```

## 设置页怎么填

1. 打开扩展设置页
2. 在「增强抓取（DrissionPage）」里勾选启用
3. helper 地址填 `http://127.0.0.1:7788`
4. 点「测试增强抓取服务」
5. 成功后再去编辑台抓网页

建议保留“helper 失败时自动回退到扩展内置抓取”，这样本地服务没启动时不会卡死抓取流程。

## 接口

- `GET /health`：检查 helper 是否可用
- `POST /scrape`

请求体示例：

```json
{
  "url": "https://example.com/article",
  "captureMode": "readable",
  "timeoutMs": 30000
}
```

返回的 `data` 与扩展内置抓取结构保持一致，额外会附带 `captureEngine: "drissionpage"`。

## 已知限制（记录在案，当前判定为可接受，不改行为）

以下两点是 `is_target_host_allowed`（`desktop/helper_app/server.py`）SSRF 防御的已知缺口，
评估结论：有 token 鉴权 + CORS 白名单双层兜底，且 helper 只监听 127.0.0.1，实际可利用面
需要「本机已被恶意程序控制」为前提——此时攻击者已有更直接的手段，故不为此增加复杂度。

1. **DNS 解析失败放行**：域名走 `socket.getaddrinfo` 解析失败（`gaierror`）时选择放行而非阻断。
   阻断会把「临时 DNS 故障」误判成安全事件，导致正常公网抓取大面积失败；放行的代价是
   攻击者可用「先解析失败、后解析到内网」的域名绕过。缓解：/scrape 需 token 才能调用。
2. **TOCTOU 窗口（校验与使用之间的 DNS rebinding）**：安全检查阶段解析到公网 IP，
   浏览器实际发起请求时同一域名可能已被改指向内网 IP。彻底修复需要在浏览器网络层
   固定 IP（DrissionPage 不暴露该能力）。缓解同上：token 鉴权 + CORS 白名单 + 默认拒绝
   已知内网字面量。

若未来 helper 支持代理层出口（自控 socket 连接），再回头收紧这两条。
