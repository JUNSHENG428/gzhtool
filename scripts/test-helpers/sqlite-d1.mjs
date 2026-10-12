import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

// Exercise actual SQL and transaction rollback, rather than matching SQL text.
// Python's bundled SQLite keeps these tests compatible with Node 18+.
const runner = String.raw`
import json, sqlite3, sys
request = json.load(sys.stdin)
db = sqlite3.connect(sys.argv[1], timeout=10)
db.row_factory = sqlite3.Row
db.execute("PRAGMA foreign_keys = ON")
try:
    if "script" in request:
        db.executescript(request["script"])
        result = []
    else:
        db.execute("BEGIN IMMEDIATE")
        result = []
        for index, statement in enumerate(request["statements"]):
            before = db.total_changes
            cursor = db.execute(statement["sql"], statement.get("args", []))
            rows = [dict(row) for row in cursor.fetchall()] if cursor.description else []
            result.append({"success": True, "meta": {"changes": db.total_changes - before}, "results": rows})
            if request.get("failAfter") == index + 1:
                raise RuntimeError("injected transaction failure")
        db.commit()
    print(json.dumps({"ok": True, "result": result}))
except Exception as error:
    db.rollback()
    print(json.dumps({"ok": False, "error": str(error)}))
finally:
    db.close()
`;

export function createSqliteD1({ schema = readFileSync(new URL("../../server/schema.sql", import.meta.url), "utf8") } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "runbi-regression-"));
  const path = join(dir, "test.sqlite");
  function execute(payload) {
    const result = spawnSync("python3", ["-c", runner, path], {
      input: JSON.stringify(payload), encoding: "utf8", maxBuffer: 4 * 1024 * 1024
    });
    if (result.error || result.status !== 0) throw result.error || new Error(result.stderr);
    const data = JSON.parse(result.stdout);
    if (!data.ok) throw new Error(data.error);
    return data.result;
  }
  const db = {
    failNextBatchAfter: 0,
    prepare(sql) {
      const make = (args) => ({
        sql, args,
        bind(...values) { return make(values); },
        async all() { return execute({ statements: [{ sql, args }] })[0]; },
        async run() { return this.all(); },
        async first(column) {
          const row = (await this.all()).results[0] || null;
          return column && row ? row[column] : row;
        }
      });
      return make([]);
    },
    async batch(statements) {
      const failAfter = db.failNextBatchAfter;
      db.failNextBatchAfter = 0;
      return execute({ statements: statements.map(({ sql, args }) => ({ sql, args })), failAfter });
    },
    exec(script) { return execute({ script }); },
    close() { rmSync(dir, { recursive: true, force: true }); }
  };
  try { db.exec(schema); } catch (error) { db.close(); throw error; }
  return db;
}
