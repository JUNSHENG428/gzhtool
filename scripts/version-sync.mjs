#!/usr/bin/env node
/**
 * 以 manifest.json 的 version 为唯一真源，写回 package.json 的 version 字段。
 */
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");

const manifest = JSON.parse(fs.readFileSync(path.join(root, "manifest.json"), "utf8"));
const ver = String(manifest.version || "").trim();
if (!/^\d+\.\d+\.\d+/.test(ver)) {
  console.error("manifest.json 的 version 格式异常:", ver);
  process.exit(1);
}

const pkgPath = path.join(root, "package.json");
const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8"));
if (pkg.version === ver) {
  console.log("package.json 已与 manifest 同步:", ver);
  process.exit(0);
}
pkg.version = ver;
fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + "\n", "utf8");
console.log("已更新 package.json version →", ver);
