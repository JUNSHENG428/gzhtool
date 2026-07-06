# 热点接口自托部署指南

公共服务（`hot.inkgold.info` / `rsshub.app`）每天被全网爬取，被各大目标站
限流是常态。**自己部署一份只服务你自己**，5 分钟搞定，完全免费，从此告别
"热点接口又挂了"。

> 2026-04-25 起本扩展的热点接口策略：**主用 NewsNow + 兜底 RSSHub**。
> 之前的 DailyHotApi 公共 demo 长期 530，已整体退役（含仓库里的反代子项目）。

本指南覆盖两种方案：

- **方案 1：Cloudflare Pages 一键部署 NewsNow**（最推荐，5 分钟，免费，主链路）
- **方案 2：Docker 自托 RSSHub**（兜底主力，覆盖 30+ 中文热榜源 + X / 小红书 / 微信公众号）

两个方案可以**只部署 1 个**，也可以**两个都部**——都部署的话「双独立后端」抗
单点失败能力最强：NewsNow 上游被反爬时自动 fallback 到你自己的 RSSHub，反之
亦然。

---

## 方案 1：Cloudflare Pages 一键部署 NewsNow（推荐）

### 步骤

1. Fork [NewsNow 仓库](https://github.com/ourongxing/newsnow) 到自己的 GitHub
2. 打开 [Cloudflare Pages](https://dash.cloudflare.com/?to=/:account/pages/new) →
   "Connect to Git" → 选刚 fork 的仓库
3. 构建配置（仓库自带 `wrangler.toml`，按它默认即可）：
   - Build command: `npm run build`
   - Build output directory: `dist`
   - 框架预设：`None` 或 `Nuxt.js`（仓库 README 里有最新指引）
4. 点 **Save and Deploy**，等待 1-3 分钟构建完成，拿到一个形如
   `https://newsnow-xxx.pages.dev` 的地址
5. 打开扩展的 **设置 → 热点接口**，把这个地址填到 "NewsNow 地址" 输入框
   - 末尾的 `/` 加不加都行，扩展会自动规范化
6. 点 **「测试 NewsNow 连接」**，看到绿色 "OK · 共 N 条数据" 就成功了

### 为什么推荐这个

- **完全免费**：Cloudflare Pages 个人版无带宽限制，每天 10 万次免费 Functions 调用
- **零运维**：上游代码更新时点一下 "Retry deployment" 即可，全自动
- **专属配额**：只服务你自己（最多再带几个朋友），不会被陌生人爬虫挤爆
- **HTTPS 自动配好**：直接拿来扩展用，不用配证书
- **国内访问友好**：Cloudflare 边缘节点全球覆盖，国内国外都稳

### 配额上限和注意事项

- Cloudflare Pages Free Plan：每天 10 万次 Functions 调用，单次响应不限大小
- NewsNow 单次响应大约 5-30 KB，按一天刷 100 次算每月用不到 100 MB
- 如果你免费分发给社区使用并且流量超了，Cloudflare 会暂停（不会扣费），到下个月恢复

---

## 方案 2：Docker 自托 RSSHub（兜底主力）

适合：希望覆盖更多源（X / 小红书 / 微信公众号 / NewsNow 不支持的小众站），
或者已经有一台 VPS 的玩家。

### 一行命令

```bash
docker run -d \
  --name rsshub \
  -p 1200:1200 \
  --restart unless-stopped \
  -e CACHE_EXPIRE=600 \
  diygod/rsshub
```

- 本机访问：填 `http://localhost:1200/` 到扩展的 **设置 → 抓取增强 → RSSHub Base URL**
- VPS 部署：用反向代理（Caddy / Nginx）套一层 HTTPS，填 `https://rss.your-domain.com/`
- 内网穿透：用 Cloudflare Tunnel 免费，几行命令搞定

### Caddy 反代示例（搭 HTTPS 最省心）

```caddy
rss.your-domain.com {
  reverse_proxy localhost:1200
}
```

启动 Caddy 后自动签 HTTPS 证书，访问 `https://rss.your-domain.com/zhihu/hot`
就能拿到知乎热榜的 RSS 输出（旧版路由 `/zhihu/hotlist` 已被 RSSHub 移除）。

### docker-compose 版（更易管理）

```yaml
version: "3"
services:
  rsshub:
    image: diygod/rsshub:latest
    container_name: rsshub
    ports:
      - "1200:1200"
    environment:
      - CACHE_EXPIRE=600
    restart: unless-stopped
```

### 扩展端如何用 RSSHub 兜底

扩展启动时优先走 NewsNow，**任意源 NewsNow 失败或返回空**就自动 fallback
到你配置的 RSSHub `${rsshubBaseUrl}${meta.rsshub}` 路径。各源对应的 RSSHub
路径在 `src/shared/hot-topics.js` 的 `HOT_SOURCE_META` 里，目前覆盖：

| 类别 | 已映射 RSSHub 路由 |
|---|---|
| 综合 | 知乎 / 微博 / 百度 / 头条 / 虎扑 / 澎湃 / 腾讯新闻 / 网易 / 微信读书 / 贴吧 |
| 科技开发 | 少数派 / 掘金 / 酷安 / IT之家 / 36氪 / V2EX / GitHub Trending / HN / Product Hunt / HelloGitHub / NodeSeek / CSDN / 虎嗅 |
| 财经 | 华尔街见闻 / 雪球 |
| 视频 | B站热搜 / 抖音 / 豆瓣电影 / 豆瓣小组 / AcFun |
| 国际 | 联合早报 |

### 注意

- RSSHub 个别路由依赖第三方反代（如 `/twitter/*` 默认走 nitter，会有失效风险）
- 国内 VPS 部分路由需要配代理（环境变量 `PROXY_URI`）
- 自托 RSSHub 才能稳定覆盖那些公共实例已经挂掉的路由（比如 X、小红书）
- 个别源（贴吧、抖音、虎嗅）的 RSSHub 路由稳定性较差，遇到问题可在
  `HOT_SOURCE_META` 里把对应源的 `rsshub` 字段去掉，让它退化为
  「单 NewsNow 无兜底」状态，**不阻塞主流程**

---

## 接入扩展后能验证什么

1. **设置 → 热点接口** 页面有「测试 NewsNow 连接」按钮，绿色 OK 表示后端可达
2. 任何后端**连续 3 次失败会自动冷却 10 分钟**，期间不会再硬试它，避免请求轰炸
3. 命中后会写入 `chrome.storage.local` 缓存（TTL 12 分钟），SW 重启不丢
4. 公共服务挂了你完全不受影响 —— 你的 base URL 是独占的

---

## 常见问题

**Q：我能用别人公开的 NewsNow / RSSHub 地址吗？**
A：技术上可以，但别人随时可能下线、限流、改路由。**5 分钟自托一份是最稳的方案。**

**Q：Cloudflare Pages 在国内能访问吗？**
A：直连可以，CDN 节点在亚洲。如果有国内大流量需求，建议同时部一份阿里云
Serverless 或腾讯云函数。

**Q：每月真的不会扣钱吗？**
A：Cloudflare Pages 个人版没有信用卡也能用。超出免费额度时会暂停服务（项目
不会被删），不会自动扣费。

**Q：兜底 RSSHub 路由失效了怎么办？**
A：RSSHub 上游路由偶尔会因目标站点改版失效。可以在 `src/shared/hot-topics.js`
的 `HOT_SOURCE_META` 里改对应源的 `rsshub` 字段（参考 [RSSHub 文档](https://docs.rsshub.app/)），
或在仓库 issue 反馈给我们。

**Q：为什么不再用 DailyHotApi？**
A：公共 demo `api-hot.imsyy.top` 长期 530，自部署需要单独维护一个 Node.js
服务，且与 NewsNow 功能高度重叠。2026-04-25 起整体退役，仓库里的反代
Worker 子项目（`cloudflare/hot-topics-proxy`）也一并删除。RSSHub 作为兜底
主力的优势：① 覆盖源更广 ② 输出标准 RSS 2.0，复用扩展现有 RSS 解析器
零格式适配 ③ 自部署同样 5 分钟内搞定。

**Q：自托后扩展性能会变差吗？**
A：相反 —— 因为后端是你独占的，没有公共服务的限流和排队，第一次拉取通常
200ms 内返回，比公共服务的 1-3s 快 10 倍以上。
