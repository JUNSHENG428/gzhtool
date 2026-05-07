/**
 * Cloudflare Workers env binding 的最简内存 mock，给 smoke 单测用。
 *
 * 三个 mock：
 *   - createMockKv()   · KVNamespace API（get / put / delete + _store + _calls + _reset）
 *   - createMockDb()   · D1Database API（prepare(sql).bind(...).first/.run/.all + _calls + _setResponse + _reset）
 *   - mockFetch()      · 替换 globalThis.fetch + _calls + _setNextResponse + _restore
 *
 * 设计要点：
 *   - 不实现 TTL 行为（mock 只验状态机正确性，不验过期清理）
 *   - 不实现 KV list / D1 transaction（worker 当前不用）
 *   - 所有方法是 async（与真实 API 保持一致），同步返回值就是 Promise
 *
 * 用法：
 *   const kv = createMockKv();
 *   const db = createMockDb();
 *   const env = { RATE_LIMIT_KV: kv, DB: db, RESEND_API_KEY: "fake" };
 *   await someHelper(env, ...);
 *   assert(kv._store.get("expected_key") === "1");
 *   assert(db._calls[0].sql.includes("INSERT INTO ..."));
 */

// ========== KV mock ==========
export function createMockKv() {
  const store = new Map();
  const calls = [];
  return {
    async get(key) {
      calls.push({ method: "get", key });
      return store.has(key) ? store.get(key) : null;
    },
    async put(key, value, options) {
      calls.push({ method: "put", key, value, options });
      store.set(key, value);
    },
    async delete(key) {
      calls.push({ method: "delete", key });
      store.delete(key);
    },
    _store: store,
    _calls: calls,
    _reset() {
      store.clear();
      calls.length = 0;
    }
  };
}

// ========== D1 mock ==========
export function createMockDb() {
  const calls = [];
  const responses = new Map(); // key: sql + "|" + JSON.stringify(args)

  function makeBound(sql, args) {
    const lookupKey = `${sql}|${JSON.stringify(args)}`;
    return {
      async first() {
        return responses.get(lookupKey) ?? null;
      },
      async run() {
        return responses.get(lookupKey) ?? { meta: { changes: 1 } };
      },
      async all() {
        return responses.get(lookupKey) ?? { results: [] };
      }
    };
  }

  return {
    prepare(sql) {
      return {
        bind(...args) {
          calls.push({ sql, args });
          return makeBound(sql, args);
        }
      };
    },
    _calls: calls,
    _setResponse(sql, args, response) {
      responses.set(`${sql}|${JSON.stringify(args)}`, response);
    },
    _reset() {
      calls.length = 0;
      responses.clear();
    }
  };
}

// ========== fetch mock ==========
// 替换 globalThis.fetch，记录调用并返回预设响应。
// 调用 _restore() 恢复原 fetch。
export function mockFetch() {
  const original = globalThis.fetch;
  const calls = [];
  let nextResponse = { ok: true, status: 200, body: "{}" };

  globalThis.fetch = async function mockedFetch(url, options) {
    calls.push({ url: String(url), options });
    return {
      ok: nextResponse.ok,
      status: nextResponse.status,
      async text() {
        return nextResponse.body;
      },
      async json() {
        try {
          return JSON.parse(nextResponse.body);
        } catch {
          return null;
        }
      }
    };
  };

  return {
    calls,
    _setNextResponse({ ok = true, status = 200, body = "{}" }) {
      nextResponse = { ok, status, body };
    },
    _restore() {
      globalThis.fetch = original;
    }
  };
}
