# 微信公众号 API 反向代理（阿里云函数计算 FC）

> 解决 IP 白名单 errcode=40164 的最低成本方案。  
> 适配本扩展的「设置 → 公众号 → 微信 API 自定义 base」字段。

## 为什么要这个

微信公众号后台「开发 → 基本配置 → IP 白名单」要求**调 `cgi-bin/*` 的客户端公网 IP 必须在白名单内**。
绝大多数家庭宽带、地铁/咖啡店 Wi-Fi、公司 NAT 都是动态出口，五分钟一变，没法手动维护，
直接报：

```json
{ "errcode": 40164, "errmsg": "invalid ip xx.xx.xx.xx, not in whitelist" }
```

把请求经阿里云函数计算（FC）反代一下，FC 的出口 IP 段是阿里云**固定段**，
**一次性把段加白**就够了，所有 `cgi-bin/*` 接口立刻通。

## 部署（Serverless Devs CLI）

> 如果还没装 CLI：`npm i -g @serverless-devs/s`

1. 把阿里云 AK 配进 CLI（只需第一次）：

   ```bash
   s config add --AccessKeyID XXX --AccessKeySecret XXX --AccountID XXX -a default
   ```

2. 在本目录执行：

   ```bash
   s deploy -y
   ```

3. 控制台输出的 `url:` 一行就是网关 URL，形如：

   ```
   https://gzh-wechat-api-proxy-xxxxxxxxxx.cn-hangzhou.fcapp.run
   ```

4. 把它填进扩展「设置 → 公众号 → 微信 API 自定义 base」，点「测试连通性」。
   返回 `true` 即接通。

## 把阿里云 FC 出口 IP 段加白

1. 阿里云控制台 → 函数计算 → 你部署的服务 → 出口 IP 列表，复制所有 CIDR。
2. 公众号后台 → 开发 → 基本配置 → 公众号开发信息 → IP 白名单，**逐条添加**。

   - 公众号 IP 白名单的 UI 不接受 CIDR，要把 `192.168.0.0/24` 展开成单 IP；
     阿里云出口段一般是 `/24` 或更大，可以用脚本展开后批量贴进去。
   - 不想展开就直接把段里**实际看到的几个 IP**先加；FC 出口轮换面比较窄，
     扩展运行后看到 40164 报错里带的 IP 再追加即可。

## 安全

默认是 `authType: anonymous`，**任何拿到 URL 的人都能调你的 FC，进而代理到你公众号 API**。
不想公开请二选一：

- **静态 token（最快）**：在 `s.yaml` 把 `PROXY_TOKEN` 设成一串随机串，
  在扩展那边配代理 URL 时，扩展会自动透传这个 header（`X-Proxy-Token`）；
  注：本扩展暂未做 UI 输入 header 的 surface，需要手动改 `src/shared/wechat.js` 加 header。
- **API 网关鉴权**：把 FC 套到阿里云 API 网关下，启用 IP 限制 / API Key / JWT。

## 接口契约

- 仅放行 `/cgi-bin/*` 路径，其他路径一律 404。
- method / body / query 全部透传到 `https://api.weixin.qq.com`。
- response 完整 mirror（status / headers / body）。

## 成本估算

按一次 HTTP 调用 ~30ms / 256MB 算，FC 月免费额度 100 万次 + 40 万 GB·s 远超个人/小团队公众号自动化使用量，**正常不会出账单**。

## 常见坑

- 部署完调用 401 / 503：CLI 默认 region `cn-hangzhou`，如果你的公众号设了 IP 白名单只允许某个 region 的段，需在 `s.yaml` 改 region。
- `errcode 40164` 仍然报：白名单里加的是阿里云**反代**的出口 IP，不是你本机 IP。`s logs` 看 FC 实际出口报错里带的 IP，按需追加。
- 想完全自运维不依赖云函数：把 `index.js` 跑到自己 VPS（带固定 IP）上即可，无需改扩展逻辑。
