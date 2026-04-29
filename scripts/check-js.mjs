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
      // 跳过 esbuild 出的浮球 React bundle —— minified IIFE，node --check 会因
      // 保留字使用（如 React 内部对象的 in 关键字）报假阳性。
      // 源文件 floating-ball/*.tsx 通过 npm run build:floating-ball + tsc 校验。
      if (ent.name === "floating-ball.bundle.js") continue;
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
