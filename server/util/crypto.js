/**
 * server/util/crypto.js · 39th 续³ #9 第二步 · 从 worker.js 抽出
 *
 * Web Crypto 薄封装。当前只导出 sha256Hex（其它 hmacSha256 / hmacSha256Hex
 * 仍留在 worker.js 内部，因为只有 JWT / 离线信任签名两个调用点不构成跨模块复用）。
 *
 * 抽出动机：
 *   - sha256Hex 在 worker.js + abuse/detectors.js（fingerprint hash）+
 *     未来可能的 audit 模块都会用，先抽出避免循环依赖
 *   - 与其它 server/util/* 风格一致（纯函数、无副作用、无 env 依赖）
 *   - smoke 不直接测此函数（链路里走 detectors / requireAuth 间接覆盖）
 *
 * 调用方：worker.js（多处 token hash + email lookup 等）/ server/abuse/detectors.js
 */

// SHA-256 摘要 → 64 字符小写 16 进制字符串。
// 用途：① fingerprint hash（multi-device burst 不在 KV 存可逆设备身份）；
//      ② token hash（refresh / reset token 不存原文）；
//      ③ email hash（防滥用日志去标识）等。
export async function sha256Hex(message) {
  const buf = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(message)
  );
  return Array.from(new Uint8Array(buf))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}
