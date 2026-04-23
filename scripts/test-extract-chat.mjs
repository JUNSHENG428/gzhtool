#!/usr/bin/env node
/**
 * 单测：extractChatContent 对主流厂商 chat completion 响应的解析。
 * 在用户报「接口已连通但返回内容为空」时新增，避免再次回归。
 *
 * 覆盖：OpenAI 标准、OpenAI o1（reasoning_content）、Claude 直连、
 *      智谱 GLM（标准结构）、Kimi、文心 ernie-bot（result）、
 *      通义 dashscope（output.text）、推理模型 max_tokens 用尽空 content。
 */

import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "..");

const { extractChatContent } = await import(resolve(ROOT, "src/shared/ai.js"));

let pass = 0;
let fail = 0;
function check(name, actual, expected) {
  const ok = actual === expected || (expected instanceof RegExp && expected.test(actual));
  if (ok) {
    console.log(`  ✓ ${name}`);
    pass += 1;
  } else {
    console.log(`  ✗ ${name}`);
    console.log(`    期望: ${JSON.stringify(expected)}`);
    console.log(`    实际: ${JSON.stringify(actual)}`);
    fail += 1;
  }
}

console.log("extractChatContent · 厂商兼容性");

// 1. OpenAI 标准
check("OpenAI 标准 string content",
  extractChatContent({ choices: [{ message: { content: "hello" } }] }),
  "hello");

// 2. OpenAI 多模态 array content
check("OpenAI 多模态 array content",
  extractChatContent({ choices: [{ message: { content: [{ type: "text", text: "hi" }, { type: "text", text: " world" }] } }] }),
  "hi world");

// 3. OpenAI o1 / DeepSeek R1：content 空 + reasoning_content 有
check("o1 推理：content 空回退到 reasoning_content",
  extractChatContent({ choices: [{ message: { content: "", reasoning_content: "因为 1+1=2" } }] }),
  "因为 1+1=2");

// 4. Anthropic 直连
check("Anthropic content[0].text",
  extractChatContent({ content: [{ type: "text", text: "Hello from Claude" }] }),
  "Hello from Claude");

// 5. 文心 ernie-bot v1：result 字段
check("文心 ernie-bot result 字段",
  extractChatContent({ result: "百度回答" }),
  "百度回答");

// 6. 通义千问 dashscope：output.text
check("通义 dashscope output.text",
  extractChatContent({ output: { text: "通义回答" } }),
  "通义回答");

// 7. 通义新版：output.choices[0].message.content
check("通义 dashscope output.choices",
  extractChatContent({ output: { choices: [{ message: { content: "通义新版" } }] } }),
  "通义新版");

// 8. 流式 delta（兜底）
check("流式 delta.content",
  extractChatContent({ choices: [{ delta: { content: "stream chunk" } }] }),
  "stream chunk");

// 9. choice.text（旧版 completions 风格被代理兼容）
check("choice.text 旧风格",
  extractChatContent({ choices: [{ text: "old completion" }] }),
  "old completion");

// 10. 致命情况：完全为空 → 返回 ""
check("空响应返回空串",
  extractChatContent({ choices: [{ message: { content: "" } }] }),
  "");
check("null 响应返回空串",
  extractChatContent(null),
  "");

// 11. 推理模型 max_tokens 用尽：content 空，没 reasoning_content，但 finish_reason=length
//     这种情况拿不到内容是预期行为（应该让用户看到诊断）
check("推理模型 token 耗尽 → 拿不到内容（这种就该拿不到，让诊断介入）",
  extractChatContent({ choices: [{ message: { content: "" }, finish_reason: "length" }] }),
  "");

console.log(`\n  共 ${pass + fail} 项 · 通过 ${pass} · 失败 ${fail}\n`);
process.exit(fail > 0 ? 1 : 0);
