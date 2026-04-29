#!/usr/bin/env node
/**
 * 对 src/ 与 scripts/ 下业务脚本做语法检查。
 *
 * 历史问题：旧版本对 src/ 下 ES Module 文件使用 `node --check FILE`，
 * 而当文件没有 import/export 顶层语句时 Node 会按 CommonJS 解析，
 * 形如 `console.log("a"\u201Cb\u201C);` 这类「中文双引号未转义」的错误
 * 反而能侥幸过 CJS parser，等到浏览器加载才报 SyntaxError。
 *
 * 现在的策略：
 *   - src/**           → 强制按 ESM 校验：`node --input-type=module --check < FILE`
 *   - scripts/**.mjs   → 同样按 ESM 校验
 *   - scripts/**.js    → 按 CommonJS 校验
 */
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { spawnSync } from "child_process";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");

function walkJs(dir, out = []) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const ent of entries) {
    const p = path.join(dir, ent.name);
    if (ent.isDirectory()) {
      if (ent.name === "node_modules" || ent.name === ".git" || ent.name === "vendor") continue;
      walkJs(p, out);
    } else if (ent.name.endsWith(".js") || ent.name.endsWith(".mjs")) {
      out.push(p);
    }
  }
  return out;
}

function pickMode(absPath) {
  const rel = path.relative(root, absPath);
  if (rel.startsWith(`src${path.sep}`)) return "module";
  // 站点的 JS 全是 ES Module（用 <script type="module"> 加载）
  if (rel.startsWith(`site${path.sep}`)) return "module";
  // Cloudflare Worker 入口也是 ESM（export default { fetch }）
  if (rel.startsWith(`server${path.sep}`)) return "module";
  if (rel.startsWith(`scripts${path.sep}`)) {
    return absPath.endsWith(".mjs") ? "module" : "commonjs";
  }
  return absPath.endsWith(".mjs") ? "module" : "commonjs";
}

function checkFile(absPath, mode) {
  const source = fs.readFileSync(absPath, "utf8");
  // 用 stdin 喂源码，强制 Node 按指定 mode 解析，避免 CJS 兜底带来的假阳性。
  const result = spawnSync(
    process.execPath,
    [`--input-type=${mode}`, "--check"],
    { input: source, encoding: "utf8" }
  );
  if (result.status === 0) return { ok: true };
  return {
    ok: false,
    stderr: (result.stderr || result.stdout || "").trim()
  };
}

const files = ["src", "scripts", "server", "site"]
  .map((d) => walkJs(path.join(root, d)))
  .flat();

const failures = [];
for (const file of files) {
  const mode = pickMode(file);
  const result = checkFile(file, mode);
  if (result.ok) {
    process.stdout.write(".");
    continue;
  }
  failures.push({ file, mode, stderr: result.stderr });
  process.stdout.write("F");
}

console.log(`\n已检查 ${files.length} 个文件`);

if (failures.length > 0) {
  console.error(`\n发现 ${failures.length} 个语法错误：`);
  for (const f of failures) {
    const rel = path.relative(root, f.file);
    console.error(`\n[${f.mode}] ${rel}`);
    if (f.stderr) {
      const cleaned = f.stderr
        .split("\n")
        .filter((line) => !line.includes("Node.js v"))
        .join("\n");
      console.error(cleaned);
    }
  }
  process.exit(1);
}

// ────────────────────────────────────────────────────────────────────────
// MV3 service worker 守卫：禁止 SW 可达代码用动态 `await import()`。
//
// 背景：MV3 service worker 按 HTML 规范完全禁用动态 import()
// (https://github.com/w3c/ServiceWorker/issues/1356)，运行时直接抛
// "import() is disallowed on ServiceWorkerGlobalScope by the HTML specification"。
// 仓库历史踩过 2 次（service-worker.js wechat-browser-bridge / license.js
// usage-stats），node --check 完全检测不出（语法合法），smoke 跑在 Node
// 也不会触发。这条静态扫描就是补这块测试缺口。
//
// 扫描范围：SW 直接代码（src/background/）+ SW 间接 import 的共享代码
// （src/shared/）+ 内容脚本（src/content-scripts/，虽然不是 SW 但同样
// 浏览器侧加载、避免 future regression）。
//
// 例外：src/options/ src/workspace/ src/popup/ src/pages/ 是 extension page
// 上下文，里面 await import() 是合法常用模式（懒加载 dialog/preview），
// **不扫**。
// ────────────────────────────────────────────────────────────────────────

const SW_DIRS = [
  path.join(root, "src", "background"),
  path.join(root, "src", "shared"),
  path.join(root, "src", "content-scripts")
];

// 匹配真实的动态 import 语法。`bar.foo.import` 这种字段名不会匹配，因为
// 紧跟 import 后必须是 `(`（可能带空白）。静态 `import { ... } from "..."`
// 没有左括号紧跟 import 关键字（中间是 `{`），不会被误判。
const DYN_IMPORT_RE = /(?:\bawait\s+import\s*\(|[=(,]\s*import\s*\(|\breturn\s+import\s*\(|\bimport\s*\([^)]+\)\s*\.\s*then\b)/;

const swFiles = SW_DIRS.flatMap((d) => walkJs(d));
const swViolations = [];
for (const file of swFiles) {
  const lines = fs.readFileSync(file, "utf8").split("\n");
  lines.forEach((line, idx) => {
    // 跳过注释里的 import() 字面量（避免说明性文字被误报，如本守卫文档块）。
    // 简单粗暴：行首到 // 之前 + /* */ 内容都剥掉再检查。多行注释跨行场景
    // 极少（项目里一般是顶部 JSDoc 块），不做完整 AST 解析。
    const stripped = line
      .replace(/\/\/.*$/, "")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/^\s*\*\s.*$/, ""); // JSDoc 行
    if (DYN_IMPORT_RE.test(stripped)) {
      swViolations.push({ file, line: idx + 1, text: line.trim() });
    }
  });
}

if (swViolations.length > 0) {
  console.error(
    `\n发现 ${swViolations.length} 处 SW 可达代码用了动态 import()：`
  );
  console.error(
    "  MV3 service worker 按 HTML 规范禁用 import()，运行时必抛"
  );
  console.error(
    '  "import() is disallowed on ServiceWorkerGlobalScope"。'
  );
  console.error(
    "  改成顶部静态 `import { x } from \"...\"`。"
  );
  for (const v of swViolations) {
    const rel = path.relative(root, v.file);
    console.error(`\n  ${rel}:${v.line}`);
    console.error(`    ${v.text}`);
  }
  console.error(
    "\n例外：src/options/ src/workspace/ src/popup/ src/pages/ 是 page 上下文，" +
      "里面 await import() 合法（不在本扫描范围）。"
  );
  process.exit(1);
}

console.log(
  `SW 动态 import 守卫：${swFiles.length} 个 SW 可达文件，0 处违规 ✓`
);
