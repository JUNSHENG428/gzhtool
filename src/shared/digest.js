/** 自动摘要优先保留完整句子；无句界时明确标示摘录被截短。 */
export function createReadableDigest(value, maxLength = 120) {
  const text = String(value || "").replace(/\s+/g, " ").trim();
  if (text.length <= maxLength) return text;
  const prefix = text.slice(0, maxLength);
  // 英文句点须跟空白或文末，避免把 4.12、域名中的点当成句界。
  const endings = [...text.matchAll(/[。！？!?][”’」』）)]*|\.(?:["')]*)(?=\s|$)/g)]
    .map((match) => match.index + match[0].length)
    .filter((end) => end <= maxLength);
  if (endings.length) return text.slice(0, endings.at(-1));
  // 不静默生成半句，也不编造一个原文没有的总结。
  return [...prefix.slice(0, maxLength - 1)].filter((char) => !/^[\uD800-\uDBFF]$/.test(char)).join("").trimEnd() + "…";
}
