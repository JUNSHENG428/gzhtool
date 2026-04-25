/**
 * 微信公众号 API 反向代理（阿里云函数计算 FC 3.0 / Node.js 18+）
 * ────────────────────────────────────────────────────────────────────────
 * 为什么要这个东西：
 *   微信公众号后台「开发 → 基本配置 → IP 白名单」要求**每个调 cgi-bin/* 的客户端
 *   都必须把出口公网 IP 加进白名单**。绝大多数家用宽带、地铁、咖啡店 Wi-Fi 都是
 *   动态出口 IP，五分钟换一次，没法手工维护——直接报 errcode=40164。
 *
 *   解决思路：把扩展请求发到 FC，FC 出口 IP 段是阿里云固定段，**一次性把段加白**
 *   就够了，所有 cgi-bin/* 接口立刻通。
 *
 *
 * 部署方式（最简，用 s.yaml + Serverless Devs CLI）：
 *
 *   $ npm i -g @serverless-devs/s
 *   $ s config add --AccessKeyID xxx --AccessKeySecret xxx --AccountID xxx -a default
 *   $ s deploy -y          # 在本目录执行
 *
 *   部署完会拿到一个 https://xxxx.cn-hangzhou.fcapp.run 的网关 URL，
 *   把它填进扩展「设置 → 公众号 → 微信 API 自定义 base」即可。
 *
 *
 * 安全：
 *   FC 默认对 https 网关签发**公开**触发器（任何人知道 URL 都能调）。
 *   如果你介意，可在 s.yaml 里把 authType 改成 anonymous → custom 并实现签名校验，
 *   或者用阿里云 API 网关把这个 FC 套一层鉴权。本模板默认走 anonymous + 一个
 *   静态 X-Proxy-Token header（环境变量配置），属于"够用就行"级。
 *
 *
 * 接口契约：
 *   - 路径透传：扩展请求 https://your-fc/cgi-bin/token?xxx，
 *     代理转发到 https://api.weixin.qq.com/cgi-bin/token?xxx
 *   - method / body / query 全部透传
 *   - response 直接 mirror，包括微信侧的 status code 和 JSON
 *
 *   - 仅放行 /cgi-bin/* 下的路径。其他路径返回 404，避免被人当通用代理用。
 */

"use strict";

const https = require("https");
const { URL } = require("url");

const UPSTREAM_HOST = "api.weixin.qq.com";
const ALLOWED_PATH_PREFIX = "/cgi-bin/";

// 可选：如果设了 PROXY_TOKEN，就要求请求方在 header 里带 X-Proxy-Token: <值>，否则 401。
const PROXY_TOKEN = process.env.PROXY_TOKEN || "";

/**
 * @param {import('@fc/runtime').FCHttpRequest} req
 * @param {import('@fc/runtime').FCHttpResponse} res
 */
exports.handler = async function handler(req, res) {
  try {
    const path = req.path || req.url || "/";
    if (!path.startsWith(ALLOWED_PATH_PREFIX)) {
      return _send(res, 404, { errcode: 40404, errmsg: "proxy: only /cgi-bin/* is allowed" });
    }

    if (PROXY_TOKEN) {
      const incoming = String(req.headers?.["x-proxy-token"] || "").trim();
      if (incoming !== PROXY_TOKEN) {
        return _send(res, 401, { errcode: 40001, errmsg: "proxy: invalid X-Proxy-Token" });
      }
    }

    // 透传 query string
    const queryString = req.queries
      ? "?" +
        Object.entries(req.queries)
          .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
          .join("&")
      : req.url?.includes("?")
      ? req.url.slice(req.url.indexOf("?"))
      : "";

    const upstreamUrl = `https://${UPSTREAM_HOST}${path}${queryString}`;
    const method = (req.method || "GET").toUpperCase();
    const body = await _readBody(req);

    const upstreamResp = await _proxy(upstreamUrl, method, body, req.headers || {});
    res.setStatusCode(upstreamResp.status);

    // 把上游响应头透回去（去掉 host / content-length，让 FC 自动算）
    const skip = new Set(["host", "content-length", "transfer-encoding", "connection"]);
    for (const [k, v] of Object.entries(upstreamResp.headers || {})) {
      if (!skip.has(String(k).toLowerCase())) res.setHeader(k, v);
    }
    res.send(upstreamResp.body);
  } catch (err) {
    _send(res, 500, {
      errcode: -1,
      errmsg: `proxy fatal: ${err?.message || String(err)}`
    });
  }
};

function _proxy(url, method, body, headers) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const passHeaders = {};
    for (const [k, v] of Object.entries(headers || {})) {
      const key = String(k).toLowerCase();
      if (
        key === "host" ||
        key === "x-proxy-token" ||
        key === "x-forwarded-for" ||
        key === "x-real-ip" ||
        key.startsWith("x-fc-")
      )
        continue;
      passHeaders[k] = v;
    }
    if (body && body.length && !passHeaders["content-length"]) {
      passHeaders["content-length"] = Buffer.byteLength(body);
    }

    const reqOpts = {
      hostname: u.hostname,
      port: 443,
      path: u.pathname + u.search,
      method,
      headers: passHeaders,
      timeout: 30000
    };

    const req = https.request(reqOpts, (resp) => {
      const chunks = [];
      resp.on("data", (c) => chunks.push(c));
      resp.on("end", () => {
        resolve({
          status: resp.statusCode || 502,
          headers: resp.headers,
          body: Buffer.concat(chunks)
        });
      });
    });
    req.on("error", reject);
    req.on("timeout", () => req.destroy(new Error("upstream timeout")));
    if (body && body.length) req.write(body);
    req.end();
  });
}

function _readBody(req) {
  return new Promise((resolve, reject) => {
    if (req.body) {
      // FC 3.0 已经把 body 读成 Buffer/string
      if (Buffer.isBuffer(req.body)) return resolve(req.body);
      if (typeof req.body === "string") return resolve(Buffer.from(req.body));
      try {
        return resolve(Buffer.from(JSON.stringify(req.body)));
      } catch (err) {
        return reject(err);
      }
    }
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

function _send(res, status, jsonBody) {
  res.setStatusCode(status);
  res.setHeader("content-type", "application/json; charset=utf-8");
  res.send(JSON.stringify(jsonBody));
}
