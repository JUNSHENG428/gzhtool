import assert from "node:assert/strict";
import { test, before, after } from "node:test";
import { createHash, createHmac, generateKeyPairSync, sign, webcrypto } from "node:crypto";
import { readFileSync } from "node:fs";
import worker from "../server/worker.js";
import { createSqliteD1 } from "./test-helpers/sqlite-d1.mjs";
import { createMockKv } from "./test-helpers/mock-cf-bindings.mjs";
import { createSessionWriter, isTrustedSessionSender } from "../src/background/session-store.js";
import { DEFAULT_SESSION, STORAGE_KEYS } from "../src/shared/defaults.js";

if (!globalThis.crypto) globalThis.crypto = webcrypto;
const originalFetch = globalThis.fetch;
before(() => { globalThis.fetch = async () => { throw new Error("Regression tests must not access the network"); }; });
after(() => { globalThis.fetch = originalFetch; });

const keys = generateKeyPairSync("rsa", { modulusLength: 2048 });
const jwk = { ...keys.publicKey.export({ format: "jwk" }), kid: "regression-key" };
const secret = "regression-only-secret";
const email = "owner@example.test";
const password = "Original-Password-123";
function fixture(t, options) {
  const DB = createSqliteD1(options);
  t.after(() => DB.close());
  const kv = createMockKv();
  kv._store.set("google:jwks:v3", JSON.stringify({ keys: [jwk] }));
  return { DB, RATE_LIMIT_KV: kv, JWT_SECRET: secret, HUPIJIAO_APP_SECRET: secret,
    LS_WEBHOOK_SECRET: secret, GOOGLE_CLIENT_ID: "regression-client" };
}
async function post(env, path, body, headers = {}) {
  return worker.fetch(new Request(`https://regression.invalid${path}`, {
    method: "POST", headers: { "Content-Type": "application/json", ...headers },
    body: typeof body === "string" ? body : JSON.stringify(body)
  }), env, { waitUntil() {} });
}
async function register(env) {
  const res = await post(env, "/api/register", { email, password });
  assert.equal(res.status, 200); return res.json();
}
function googleCredential(overrides = {}) {
  const header = Buffer.from(JSON.stringify({ alg: "RS256", kid: jwk.kid })).toString("base64url");
  const payload = Buffer.from(JSON.stringify({ iss: "https://accounts.google.com", aud: "regression-client",
    sub: "google-owner", email, email_verified: true, exp: Math.floor(Date.now() / 1000) + 3600, ...overrides })).toString("base64url");
  const data = `${header}.${payload}`;
  return `${data}.${sign("RSA-SHA256", Buffer.from(data), keys.privateKey).toString("base64url")}`;
}
async function unboundLicense(env, key = "unbound-key") {
  await env.DB.prepare(`INSERT INTO license_keys (key, plan, status, ls_customer_email, created_at, updated_at)
    VALUES (?, 'yearly', 'active', ?, ?, ?)`).bind(key, email, Date.now(), Date.now()).run();
}
async function resetToken(env, userId, expiresAt = Date.now() + 60000) {
  const token = "regression-mailbox-token";
  await env.DB.prepare(`INSERT INTO password_resets (token_hash, user_id, email, created_at, expires_at)
    VALUES (?, ?, ?, ?, ?)`).bind(createHash("sha256").update(token).digest("hex"), userId, email, Date.now(), expiresAt).run();
  return token;
}

test("注册不能仅凭邮箱认领已有付费授权", async t => {
  const env = fixture(t); await unboundLicense(env);
  const data = await register(env);
  assert.equal(data.user.emailVerified, false);
  assert.equal((await env.DB.prepare("SELECT user_id FROM license_keys").first()).user_id, null);
});

test("Lemon 回调不能把付费授权绑定到未验证邮箱账号", async t => {
  const env = fixture(t); await register(env);
  const body = JSON.stringify({ data: { id: "lemon-order", attributes: { user_email: email } } });
  const res = await post(env, "/api/webhook/lemon", body, {
    "X-Signature": createHmac("sha256", secret).update(body).digest("hex"),
    "X-Event-Name": "order_created", "X-Event-Id": "lemon-event"
  });
  assert.equal(res.status, 200);
  assert.equal((await env.DB.prepare("SELECT user_id FROM license_keys").first()).user_id, null);
});

test("Google 已验证的新账号可以认领邮箱权益", async t => {
  const env = fixture(t); await unboundLicense(env);
  const res = await post(env, "/api/auth/google", { credential: googleCredential() });
  assert.equal(res.status, 200); const data = await res.json();
  assert.equal(data.user.emailVerified, true);
  assert.equal((await env.DB.prepare("SELECT user_id FROM license_keys").first()).user_id, data.user.id);
});

test("Google 不自动合并抢先注册的未验证密码账号", async t => {
  const env = fixture(t); await register(env); await unboundLicense(env);
  const res = await post(env, "/api/auth/google", { credential: googleCredential() });
  assert.equal(res.status, 409);
  assert.equal((await res.json()).reason, "email_verification_required");
  assert.equal((await env.DB.prepare("SELECT google_sub FROM users").first()).google_sub, null);
  assert.equal((await env.DB.prepare("SELECT user_id FROM license_keys").first()).user_id, null);
});

test("旧版已自动关联但未验证的密码账号也必须先验证邮箱", async t => {
  const env = fixture(t); await register(env);
  await env.DB.prepare("UPDATE users SET google_sub = 'google-owner'").run();
  assert.equal((await post(env, "/api/auth/google", { credential: googleCredential() })).status, 409);
});

test("邮件重置确认归属、认领权益、废除旧密码和旧会话，再允许 Google 关联", async t => {
  const env = fixture(t); const old = await register(env); await unboundLicense(env);
  const token = await resetToken(env, old.user.id);
  const res = await post(env, "/api/auth/reset", { token, newPassword: "Mailbox-Owner-Password" });
  assert.equal(res.status, 200);
  assert.equal((await env.DB.prepare("SELECT user_id FROM license_keys").first()).user_id, old.user.id);
  assert.equal((await post(env, "/api/login", { email, password })).status, 401);
  const me = await worker.fetch(new Request("https://regression.invalid/api/me", {
    headers: { Authorization: `Bearer ${old.token}` }
  }), env, {});
  assert.equal(me.status, 401);
  assert.equal((await post(env, "/api/auth/google", { credential: googleCredential() })).status, 200);
  assert.equal((await post(env, "/api/auth/reset", { token, newPassword: password })).status, 400);
});

test("过期邮件 token 不会验证邮箱或认领授权", async t => {
  const env = fixture(t); const user = await register(env); await unboundLicense(env);
  const token = await resetToken(env, user.user.id, Date.now() - 1000);
  assert.equal((await post(env, "/api/auth/reset", { token, newPassword: password })).status, 400);
  assert.equal((await env.DB.prepare("SELECT email_verified_at FROM users").first()).email_verified_at, null);
});

test("并发消费同一邮件 token 只有一个重置成功", async t => {
  const env = fixture(t); const user = await register(env);
  const token = await resetToken(env, user.user.id);
  const responses = await Promise.all(["Mailbox-Password-A", "Mailbox-Password-B"].map(newPassword =>
    post(env, "/api/auth/reset", { token, newPassword })));
  assert.deepEqual(responses.map(r => r.status).sort(), [200, 400]);
});

test("邮箱验证迁移只回填 OAuth-only 账号", async t => {
  const schema = readFileSync(new URL("../server/schema.sql", import.meta.url), "utf8")
    .replace(/^.*email_verified_at INTEGER.*\n/m, "");
  const env = fixture(t, { schema });
  for (const [id, salt] of [["oauth", "oauth:google"], ["linked", "cGFzc3dvcmQ="]]) {
    await env.DB.prepare(`INSERT INTO users (id,email,password_hash,password_salt,oauth_provider,created_at)
      VALUES (?,?, 'hash', ?, 'google', 123)`).bind(id, `${id}@example.test`, salt).run();
  }
  env.DB.exec(readFileSync(new URL("../server/migrations/006_email_verification.sql", import.meta.url), "utf8"));
  const rows = (await env.DB.prepare("SELECT id,email_verified_at FROM users ORDER BY id").all()).results;
  assert.deepEqual(rows, [{id:"linked",email_verified_at:null},{id:"oauth",email_verified_at:123}]);
});

async function paymentFixture(t) {
  const env = fixture(t);
  await env.DB.prepare(`INSERT INTO users (id,email,password_hash,password_salt,created_at)
    VALUES ('buyer', ?, 'hash', 'salt', ?)`).bind(email, Date.now()).run();
  await addOrder(env, "order-1");
  return env;
}
async function addOrder(env, id) {
  await env.DB.prepare(`INSERT INTO orders (trade_order_id,user_id,user_email,plan_code,total_fee,days,created_at)
    VALUES (?, 'buyer', ?, 'monthly', 9.9, 30, ?)`).bind(id, email, Date.now()).run();
}
function paymentBody(overrides = {}) {
  const params = { trade_order_id: "order-1", status: "OD", total_fee: "9.90", nonce_str: "same-nonce", ...overrides };
  for (const key of Object.keys(params)) if (params[key] === undefined) delete params[key];
  params.hash = createHash("md5").update(Object.keys(params).filter(k => k !== "hash" && params[k] !== "")
    .sort().map(k => `${k}=${params[k]}`).join("&") + secret).digest("hex");
  return new URLSearchParams(params).toString();
}
const notify = (env, body = paymentBody()) => post(env, "/api/payment/hupijiao/notify", body,
  { "Content-Type": "application/x-www-form-urlencoded" });

test("合法支付回调原样重试成功且不重复延长授权", async t => {
  const env = await paymentFixture(t);
  assert.equal((await notify(env)).status, 200);
  const before = await env.DB.prepare("SELECT * FROM license_keys").first();
  assert.equal((await notify(env)).status, 200);
  assert.deepEqual(await env.DB.prepare("SELECT * FROM license_keys").first(), before);
  assert.equal(env.RATE_LIMIT_KV._store.has("hpj:nonce:same-nonce"), false);
});

for (const failAfter of [1, 2, 3]) {
  test(`发货事务第 ${failAfter} 步后故障全部回滚，同 nonce 重试可恢复`, async t => {
    const env = await paymentFixture(t); env.DB.failNextBatchAfter = failAfter;
    assert.equal((await notify(env)).status, 500);
    const order = await env.DB.prepare("SELECT status,granted_license_key FROM orders").first();
    assert.deepEqual(order, {status:"pending",granted_license_key:null});
    assert.equal((await env.DB.prepare("SELECT COUNT(*) AS n FROM license_keys").first()).n, 0);
    assert.equal((await notify(env)).status, 200);
    assert.equal((await env.DB.prepare("SELECT status FROM orders").first()).status, "paid");
  });
}

test("同一订单并发回调只发放一次", async t => {
  const env = await paymentFixture(t);
  const responses = await Promise.all([notify(env), notify(env), notify(env)]);
  assert.ok(responses.every(r => r.status === 200));
  const rows = (await env.DB.prepare("SELECT expires_at FROM license_keys").all()).results;
  assert.equal(rows.length, 1);
  assert.ok(Math.abs(rows[0].expires_at - Date.now() - 30 * 86400000) < 10000);
});

test("同一买家两笔并发订单不会丢失一次续期", async t => {
  const env = await paymentFixture(t); await addOrder(env, "order-2");
  const responses = await Promise.all([notify(env), notify(env, paymentBody({trade_order_id:"order-2"}))]);
  assert.ok(responses.every(r => r.status === 200));
  const rows = (await env.DB.prepare("SELECT expires_at FROM license_keys").all()).results;
  assert.equal(rows.length, 1);
  assert.ok(Math.abs(rows[0].expires_at - Date.now() - 60 * 86400000) < 10000);
});

test("无效签名不会污染后续合法回调的 nonce", async t => {
  const env = await paymentFixture(t);
  const invalid = new URLSearchParams(paymentBody()); invalid.set("hash", "invalid");
  assert.equal((await notify(env, invalid.toString())).status, 401);
  assert.equal((await notify(env)).status, 200);
});

test("无效金额或缺少支付密钥不能发货", async t => {
  const env = await paymentFixture(t);
  for (const total_fee of ["NaN", "9.9junk", "9.89", "-9.9", ""]) {
    assert.equal((await notify(env, paymentBody({total_fee}))).status, 400);
  }
  delete env.HUPIJIAO_APP_SECRET;
  assert.equal((await notify(env)).status, 503);
  assert.equal((await env.DB.prepare("SELECT COUNT(*) AS n FROM license_keys").first()).n, 0);
});

for (const status of ["CD", "RD", "UD", "RS", "REFUND"]) {
  test(`已支付订单接收 ${status}，重复退款及晚到支付不会重新发货`, async t => {
    const env = await paymentFixture(t); await notify(env);
    const license = await env.DB.prepare("SELECT * FROM license_keys").first();
    const refund = paymentBody({status});
    assert.equal((await notify(env, refund)).status, 200);
    assert.equal((await env.DB.prepare("SELECT status FROM orders").first()).status, "refunded");
    assert.equal((await notify(env, refund)).status, 200);
    assert.equal((await notify(env)).status, 200);
    assert.equal((await env.DB.prepare("SELECT status FROM orders").first()).status, "refunded");
    assert.deepEqual(await env.DB.prepare("SELECT * FROM license_keys").first(), license);
  });
}

test("历史 paid 但缺少发货记录的订单不能被假报为发货成功", async t => {
  const env = await paymentFixture(t);
  await env.DB.prepare("UPDATE orders SET status = 'paid'").run();
  assert.equal((await notify(env)).status, 503);
});

test("沿用合法退款通知不强制带金额的契约", async t => {
  const env = await paymentFixture(t); await notify(env);
  assert.equal((await notify(env, paymentBody({status:"RD",total_fee:undefined}))).status, 200);
  assert.equal((await env.DB.prepare("SELECT status FROM orders").first()).status, "refunded");
});

function sessionArea() {
  let state = { [STORAGE_KEYS.session]: { lastTheme: "existing" } };
  return {
    failNext: false,
    async get() { return structuredClone(state); },
    async set(patch) {
      if (this.failNext) { this.failNext = false; throw new Error("storage unavailable"); }
      state = { ...state, ...structuredClone(patch) };
    },
    value() { return state[STORAGE_KEYS.session]; }
  };
}

test("后台与两个独立页面并发保存均保留各自字段", async t => {
  const area = sessionArea(); const writer = createSessionWriter(area);
  const oldChrome = globalThis.chrome; t.after(() => { globalThis.chrome = oldChrome; });
  const messages = [];
  globalThis.chrome = { runtime: { sendMessage(message, callback) {
    messages.push(message);
    writer(message.patch).then(data => callback({ok:true,data}));
  } } };
  // Different module instances stand for separate extension-page JS realms.
  const page1 = await import(`../src/shared/storage.js?page=1`);
  const page2 = await import(`../src/shared/storage.js?page=2`);
  await Promise.all([
    writer({lastDraft:{title:"rewrite"}}),
    page1.saveSession({lastBodyHtml:"edited body"}),
    page2.saveSession({selectedImageIndex:3})
  ]);
  assert.deepEqual(area.value().lastDraft, {title:"rewrite"});
  assert.equal(area.value().lastBodyHtml, "edited body");
  assert.equal(area.value().selectedImageIndex, 3);
  assert.equal(area.value().lastTheme, "existing");
  assert.equal(messages.length, 2);
  assert.ok(messages.every(m => m.type === "SAVE_SESSION"));
});

test("会话写入失败向调用方报错，后续队列继续工作", async () => {
  const area = sessionArea(); const writer = createSessionWriter(area); area.failNext = true;
  await assert.rejects(writer({lastBodyHtml:"failed"}), /storage unavailable/);
  await writer({lastDraft:{title:"recovered"}});
  assert.equal(area.value().lastBodyHtml, DEFAULT_SESSION.lastBodyHtml);
  assert.equal(area.value().lastDraft.title, "recovered");
});

test("排队中的 patch 使用调用时快照", async () => {
  const area = sessionArea(); const writer = createSessionWriter(area);
  const patch = {lastDraft:{title:"original"}};
  const pending = writer(patch); patch.lastDraft.title = "mutated";
  await pending; assert.equal(area.value().lastDraft.title, "original");
});

test("会话写入拒绝网页 content script 和其他扩展来源", () => {
  const runtime = {id:"our-extension",getURL:path=>`chrome-extension://our-extension/${path}`};
  assert.equal(isTrustedSessionSender({id:runtime.id,url:runtime.getURL("src/workspace/workspace.html")},runtime),true);
  for (const sender of [{id:runtime.id,url:"https://docuearn.com/"},
    {id:"other",url:runtime.getURL("x")},{id:runtime.id,url:"chrome-extension://our-extension.evil/"},{}]) {
    assert.equal(isTrustedSessionSender(sender,runtime),false);
  }
});
