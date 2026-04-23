#!/usr/bin/env node
/**
 * scripts/build-zip.mjs
 * ----------------------------------------------------------------
 * 把 Chrome 扩展打包成 Chrome Web Store 可上传的 .zip。
 *
 * 输入：仓库根目录（manifest.json + src/ + icons）
 * 输出：dist/runbi-vX.Y.Z.zip
 *
 * 严格白名单 —— 只打包以下文件：
 *   - manifest.json
 *   - src/        (排除 .DS_Store、source PNG 原件等)
 *   - LICENSE     (如有)
 *
 * 显式排除：
 *   - .venv/        (Python 虚拟环境)
 *   - node_modules/ (npm 依赖，开发用)
 *   - .git/         (版本控制)
 *   - .cursor/ .vscode/ .idea/  (编辑器配置)
 *   - .DS_Store / Thumbs.db
 *   - docs/ scripts/ server/ site/   (开发文档与后端代码)
 *   - claude_design_system_prompt.md  (内部设计文档)
 *   - .github/ .gitignore .env*
 *   - icons/icon-source*.png (原始素材，与 16/32/48/128 重复且体积大)
 *
 * 用法：
 *   npm run build:zip
 *
 * 退出码：
 *   0 = 成功
 *   1 = manifest 丢失或版本号错误
 *   2 = 找不到 zip 命令（macOS / Linux 自带；Windows 用户请装 7zip）
 */

import { execSync, spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, rmSync, existsSync, cpSync, statSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");
const DIST = join(ROOT, "dist");
const STAGE = join(DIST, "_stage");

// ----- 1. 读 manifest，决定输出文件名 -----
const manifestPath = join(ROOT, "manifest.json");
if (!existsSync(manifestPath)) {
  console.error("[build-zip] 找不到 manifest.json");
  process.exit(1);
}
const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
const version = manifest.version;
if (!/^\d+\.\d+\.\d+$/.test(version || "")) {
  console.error(`[build-zip] manifest.version 不合法：${version}`);
  process.exit(1);
}
const zipName = `runbi-v${version}.zip`;
const zipPath = join(DIST, zipName);

console.log(`[build-zip] 准备打包 ${manifest.name} v${version}`);

// ----- 2. 清理旧产物 -----
if (existsSync(zipPath)) rmSync(zipPath);
if (existsSync(STAGE)) rmSync(STAGE, { recursive: true, force: true });
mkdirSync(STAGE, { recursive: true });

// ----- 3. 复制白名单文件到 stage -----
//    这里走 cp -R，而不是 zip 的 -x 排除规则，因为白名单方式更安全：
//    新增的开发目录默认不会被意外打包进去。

const WHITELIST = [
  "manifest.json",
  "src",
  "LICENSE",
  "LICENSE.md"
];

for (const item of WHITELIST) {
  const src = join(ROOT, item);
  if (!existsSync(src)) continue;
  const dst = join(STAGE, item);
  cpSync(src, dst, {
    recursive: true,
    filter: (path) => {
      const lower = path.toLowerCase();
      // 排除规则
      if (lower.endsWith(".ds_store")) return false;
      if (lower.endsWith("thumbs.db")) return false;
      if (lower.includes("/__pycache__/")) return false;
      if (lower.endsWith(".pyc")) return false;
      // 排除原始 source PNG（保留 16/32/48/128 即可）
      if (/\/icon-source[^/]*\.png$/i.test(path)) return false;
      // 排除任何 .map（生产不需要 source map）
      if (lower.endsWith(".map")) return false;
      return true;
    }
  });
}

// ----- 4. 校验 stage 里有 manifest 与 4 个图标 -----
const requiredIcons = [
  "src/icons/icon16.png",
  "src/icons/icon32.png",
  "src/icons/icon48.png",
  "src/icons/icon128.png"
];
for (const ic of requiredIcons) {
  if (!existsSync(join(STAGE, ic))) {
    console.error(`[build-zip] 缺少图标：${ic}`);
    process.exit(1);
  }
}

// ----- 5. 打 zip -----
//   优先用 zip 命令；macOS / Linux 默认有；Windows 上请用 PowerShell Compress-Archive
const zipBin = whichSync("zip");
if (zipBin) {
  // -r 递归 -X 不存 mac 的 extra fields -9 最高压缩
  const result = spawnSync(zipBin, ["-r", "-X", "-9", zipPath, "."], {
    cwd: STAGE,
    stdio: "inherit"
  });
  if (result.status !== 0) {
    console.error("[build-zip] zip 命令失败");
    process.exit(2);
  }
} else {
  // PowerShell fallback (Windows)
  console.warn("[build-zip] 未找到 zip，尝试 PowerShell Compress-Archive…");
  const psBin = whichSync("pwsh") || whichSync("powershell");
  if (!psBin) {
    console.error("[build-zip] 找不到 zip / pwsh / powershell，请手动安装 zip 工具");
    process.exit(2);
  }
  const cmd = `Compress-Archive -Path "${STAGE}\\*" -DestinationPath "${zipPath}" -Force`;
  const result = spawnSync(psBin, ["-NoProfile", "-Command", cmd], { stdio: "inherit" });
  if (result.status !== 0) process.exit(2);
}

// ----- 6. 报告体积 -----
const bytes = statSync(zipPath).size;
const kb = (bytes / 1024).toFixed(1);
const mb = (bytes / 1024 / 1024).toFixed(2);
console.log(`[build-zip] 成功 → ${zipPath}`);
console.log(`[build-zip] 大小 ${bytes < 1024 * 1024 ? `${kb} KB` : `${mb} MB`}`);
console.log(`[build-zip] 上传到 https://chrome.google.com/webstore/devconsole/`);

// ----- 7. 清理 stage（保留 dist/）-----
rmSync(STAGE, { recursive: true, force: true });

// ===========================================
function whichSync(cmd) {
  try {
    const out = execSync(
      process.platform === "win32" ? `where ${cmd}` : `command -v ${cmd}`,
      { stdio: ["ignore", "pipe", "ignore"] }
    )
      .toString()
      .trim()
      .split("\n")[0];
    return out || null;
  } catch {
    return null;
  }
}
