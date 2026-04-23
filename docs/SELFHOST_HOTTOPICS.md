# 热点接口自托部署指南

公共服务（`api-hot.imsyy.top` / `newsnow.busiyi.world` / `rsshub.app`）每天被
全网爬取，被各大目标站限流是常态。**自己部署一份只服务你自己**，5 分钟搞定，
完全免费，从此告别"热点接口又挂了"。

本指南覆盖三种方案：
- **方案 1：Vercel 一键部署 DailyHotApi**（最推荐，5 分钟，免费）
- **方案 2：本地 / VPS Docker 跑 DailyHotApi**（30 秒，需要一台服务器）
- **方案 3：自托 RSSHub**（覆盖 X / 小红书 / 公众号，半小时）

---

## 方案 1：Vercel 一键部署 DailyHotApi（推荐）

### 步骤

1. 打开 [DailyHotApi 的 Vercel 部署页](https://vercel.com/new/clone?repository-url=https%3A%2F%2Fgithub.com%2Fimsyy%2FDailyHotApi&project-name=daily-hot-api&repository-name=daily-hot-api)
2. 用 GitHub 账号登录 Vercel（没有就现注册，免费）
3. 直接点 **Deploy**，全部用默认配置
4. 等待 1-2 分钟构建完成，拿到一个形如 `https://daily-hot-api-xxx.vercel.app` 的地址
5. 打开扩展的 **设置 → 热点接口**，把这个地址填到 "DailyHotApi 地址" 输入框
   - 末尾的 `/` 加不加都行，扩展会自动规范化
6. 点 **「测试 DailyHotApi 连接」**，看到绿色 "OK" 就成功了

### 为什么推荐这个

- **完全免费**：Vercel 个人版每月 100 GB 带宽，单用户用 1% 都不到
- **零运维**：上游代码更新你不用动，重新点一下 Deploy 即可
- **专属配额**：只服务你自己（最多再带几个朋友），不会被陌生人爬虫挤爆
- **HTTPS 自动配好**：直接拿来扩展用，不用配证书

### 配额上限和注意事项

- Vercel Hobby Plan：100 GB / 月带宽，100 万次 / 月 Edge 函数调用
- DailyHotApi 单次响应大约 5-30 KB，按一天刷 100 次算每月用不到 100 MB
- 如果你免费分发给社区使用并且流量超了，Vercel 会暂停（不会扣费），到下个月恢复

### 升级版：Cloudflare Workers 部署（更稳）

DailyHotApi 也支持部署到 Cloudflare Workers，配额更宽松（每天 10 万次免费请求）：

```bash
git clone https://github.com/imsyy/DailyHotApi.git
cd DailyHotApi
npm install -g wrangler
wrangler deploy
```

部署完后地址形如 `https://daily-hot-api.your-subdomain.workers.dev`，
按方案 1 第 5 步填进设置页即可。

---

## 方案 2：本地 / VPS Docker 部署

适合：已经有一台 VPS 或者愿意让本机 24h 开机的玩家。

### 一行命令

```bash
docker run -d \
  --name daily-hot-api \
  -p 6688:6688 \
  --restart unless-stopped \
  imsyy/dailyhot-api:latest
```

- 本机访问：填 `http://localhost:6688/` 到设置页
- VPS 部署：用反向代理（Caddy / Nginx）套一层 HTTPS，填 `https://hot.your-domain.com/`
- 内网穿透（家里机器对外）：用 Cloudflare Tunnel 免费，几行命令搞定

### Caddy 反代示例（搭 HTTPS 最省心）

```caddy
hot.your-domain.com {
  reverse_proxy localhost:6688
}
```

启动 Caddy 后自动签 HTTPS 证书，访问 `https://hot.your-domain.com/zhihu` 就能拿到知乎热榜数据。

---

## 方案 3：自托 RSSHub（覆盖 X / 小红书 / 微信公众号）

DailyHotApi 不支持的源（X 趋势、小红书、抖音用户更新、微信公众号）走 RSSHub。

### Docker 部署

```bash
docker run -d \
  --name rsshub \
  -p 1200:1200 \
  --restart unless-stopped \
  -e CACHE_EXPIRE=600 \
  diygod/rsshub
```

- 默认地址 `http://localhost:1200`
- 部署到 VPS 后填进扩展的 **设置 → 抓取增强 → RSSHub Base URL**
- 可访问的路由：[RSSHub 文档](https://docs.rsshub.app/)，比如：
  - X 用户时间线：`/twitter/user/elonmusk`
  - 小红书用户笔记：`/xiaohongshu/user/{user_id}`
  - 微信公众号文章：`/wechat/ce/{biz_id}`（需要 wechat2rss 反代）
  - 知乎用户回答：`/zhihu/people/answers/{user_id}`

### 注意

- RSSHub 不少路由依赖第三方反代（`/twitter/*` 默认走 nitter，会有路由失效风险）
- 国内 VPS 部分网站需要配代理（环境变量 `PROXY_URI`）
- 自托 RSSHub 才能稳定覆盖那些公共实例已经挂掉的路由（比如 X、小红书）

---

## 接入扩展后能验证什么

1. **设置 → 热点接口** 页面有「测试连接」按钮，绿色 OK 表示后端可达且能取到数据
2. 任何后端**连续 3 次失败会自动冷却 10 分钟**，期间不会再硬试它，避免请求轰炸
3. 命中后会写入 chrome.storage.local 缓存（TTL 12 分钟），SW 重启不丢
4. 公共服务挂了你完全不受影响 —— 你的 base URL 是独占的

---

## 常见问题

**Q：我能用别人公开的 DailyHotApi 地址吗？**
A：技术上可以，但别人随时可能下线、限流、改路由。**5 分钟自托一份是最稳的方案。**

**Q：Vercel 在国内能访问吗？**
A：直连可以，CDN 节点在亚洲。如果你有国内用户分发需求，建议部 Cloudflare Workers。

**Q：每月真的不会扣钱吗？**
A：Vercel Hobby Plan 没有信用卡也能用。超出免费额度时会暂停服务（项目不会被删），不会自动扣费。Cloudflare Workers 同理。

**Q：自托后扩展性能会变差吗？**
A：相反 —— 因为后端是你独占的，没有公共服务的限流和排队，第一次拉取通常 200ms 内返回，比公共服务的 1-3s 快 10 倍以上。
