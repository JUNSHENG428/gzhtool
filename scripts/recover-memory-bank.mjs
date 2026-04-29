#!/usr/bin/env node
/**
 * 从 ~/.claude/projects/ 下已关闭 worktree 的会话 jsonl 中 reconstruct
 * memory-bank/ 文件的最终状态，与主目录 memory-bank/ 对比，输出 diff
 * 与回收报告到 memory-bank/.recovered-from-worktrees/。
 *
 * 用法：
 *   node scripts/recover-memory-bank.mjs            # 跑回收，写产物
 *   node scripts/recover-memory-bank.mjs --dry-run  # 只打印摘要不写文件
 *   node scripts/recover-memory-bank.mjs --help
 */
import fs from "fs";
import path from "path";
import os from "os";
import { fileURLToPath } from "url";
import { spawnSync } from "child_process";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");
const HOME = os.homedir();

const args = process.argv.slice(2);
if (args.includes("--help") || args.includes("-h")) {
  console.log(`recover-memory-bank.mjs

从已关闭 worktree 的 Claude Code 会话 jsonl 重建 memory-bank/ 最终状态。

Flags:
  --dry-run   只打印摘要，不写产物文件
  --help, -h  显示本帮助
`);
  process.exit(0);
}
const DRY_RUN = args.includes("--dry-run");

const WORKTREE_SESSION_DIRS = [
  {
    label: "thirsty-davinci-845733",
    dir: path.join(
      HOME,
      ".claude/projects/-Users-junshengma-Desktop-gzh--claude-worktrees-thirsty-davinci-845733",
    ),
  },
  {
    label: "confident-black-8a38ed",
    dir: path.join(
      HOME,
      ".claude/projects/-Users-junshengma-Desktop-gzh--claude-worktrees-confident-black-8a38ed",
    ),
  },
];

const MAIN_MEMORY_BANK = path.join(root, "memory-bank");
const OUT_DIR = path.join(MAIN_MEMORY_BANK, ".recovered-from-worktrees");

/**
 * 列出某 session 目录下所有 jsonl，按 mtime 升序。
 */
function listJsonlsByMtime(dir) {
  if (!fs.existsSync(dir)) return [];
  const ents = fs
    .readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isFile() && e.name.endsWith(".jsonl"))
    .map((e) => {
      const p = path.join(dir, e.name);
      return { path: p, mtime: fs.statSync(p).mtimeMs };
    });
  ents.sort((a, b) => a.mtime - b.mtime);
  return ents.map((e) => e.path);
}

/**
 * 解析 jsonl，按时间戳合并，提取
 *   { timestamp, name: 'Write'|'Edit', input: {...} }
 * 仅保留 input.file_path 含 '/memory-bank/' 的 tool_use（避免误中
 * ~/.claude/plans/memory-bank-*.md 这种 plan 文件名）。
 *
 * sidechain：Claude Code 子代理的 tool_use 会被复制到多个 jsonl，按 c.id 去重。
 *
 * 关联 tool_result 看 is_error，但脚本不依赖 ok=true —— 即使没 result（被
 * 中断 / sidechain 截断）也保留事件，让状态机自己用 old_string 校验。
 */
function extractMemoryBankToolUses(jsonlPaths) {
  /** @type {Map<string, { ts, name, input, jsonl, ok? }>} dedupe by tool_use.id */
  const byId = new Map();
  /** key=tool_use_id → list of jsonl basenames it appeared in (for diag) */
  const seenIn = new Map();

  for (const p of jsonlPaths) {
    const base = path.basename(p);
    const lines = fs.readFileSync(p, "utf8").split("\n");
    for (const raw of lines) {
      if (!raw.trim()) continue;
      let row;
      try {
        row = JSON.parse(raw);
      } catch {
        continue;
      }
      const ts = row.timestamp || "";
      const msg = row.message;
      if (!msg || typeof msg !== "object") continue;
      const content = Array.isArray(msg.content) ? msg.content : [];

      if (row.type === "assistant") {
        for (const c of content) {
          if (
            c &&
            c.type === "tool_use" &&
            (c.name === "Write" || c.name === "Edit") &&
            c.input &&
            typeof c.input.file_path === "string" &&
            c.input.file_path.includes("/memory-bank/")
          ) {
            if (!byId.has(c.id)) {
              byId.set(c.id, {
                ts,
                name: c.name,
                input: c.input,
                jsonl: base,
              });
            }
            const list = seenIn.get(c.id) || [];
            list.push(base);
            seenIn.set(c.id, list);
          }
        }
      } else if (row.type === "user") {
        for (const c of content) {
          if (c && c.type === "tool_result" && byId.has(c.tool_use_id)) {
            const ev = byId.get(c.tool_use_id);
            // 只要任一 jsonl 报告成功就算成功（sidechain 复制）
            if (ev.ok !== true) ev.ok = !c.is_error;
          }
        }
      }
    }
  }

  const events = Array.from(byId.values());
  events.sort((a, b) => (a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : 0));
  return events;
}

/**
 * 状态机：以**主目录现有 memory-bank 文件**为 base，按 events 顺序 replay
 * worktree 上的 Write/Edit 操作。
 *
 * 这等价于「把 worktree 上做过的所有改动叠加到主目录现状之上」。如果 worktree
 * 上某 Edit 当时已被合并回主目录，那么主目录里 old_string 已被 new_string 替
 * 换，Edit replay 时找不到 old_string → already-applied（skip）。如果该 Edit
 * 还没合并，主目录里仍含 old_string，Edit replay 成功 → 把丢失的改动补上。
 *
 * 返回 Map<absolutePath, { content, applied, alreadyApplied, conflicts }>
 *   - applied: 成功 replay 的 edits 数（= worktree 上有但主目录缺的改动数）
 *   - alreadyApplied: old_string 找不到但情况合理（多半已合并）
 *   - conflicts: 真正异常情况（比如 input 字段缺失）
 */
function buildFinalStates(events, mainBankDir) {
  /** @type {Map<string, string>} */
  const state = new Map();
  /** @type {Map<string, { applied: number, alreadyApplied: number, conflicts: any[] }>} */
  const stats = new Map();

  function ensure(fp) {
    if (!state.has(fp)) {
      const basename = path.basename(fp);
      const mainPath = path.join(mainBankDir, basename);
      const base = fs.existsSync(mainPath)
        ? fs.readFileSync(mainPath, "utf8")
        : "";
      state.set(fp, base);
    }
    if (!stats.has(fp)) {
      stats.set(fp, { applied: 0, alreadyApplied: 0, conflicts: [] });
    }
  }

  events.forEach((ev, idx) => {
    const fp = ev.input.file_path;
    ensure(fp);
    const st = stats.get(fp);

    if (ev.name === "Write") {
      // Write 是全量覆盖，无视当前 base —— 这通常出现在新建文件时
      state.set(fp, ev.input.content ?? "");
      st.applied += 1;
      return;
    }

    if (ev.name === "Edit") {
      const cur = state.get(fp);
      const { old_string, new_string, replace_all } = ev.input;
      if (typeof old_string !== "string" || typeof new_string !== "string") {
        st.conflicts.push({
          idx,
          reason: "missing old_string/new_string",
          jsonl: ev.jsonl,
          ts: ev.ts,
        });
        return;
      }
      // 「插入型 Edit」识别：new_string 包含 old_string + 新内容（典型的
      // append/insert pattern）。如果 base 里已经存在完整 new_string，说明
      // 此 edit 已经被合并到主目录了，再 replay 会重复插入 → 跳过。
      const isInsertionEdit =
        new_string.length > old_string.length &&
        new_string.includes(old_string);
      if (isInsertionEdit && cur.includes(new_string)) {
        st.alreadyApplied += 1;
        return;
      }
      if (replace_all) {
        if (!cur.includes(old_string)) {
          st.alreadyApplied += 1;
          return;
        }
        state.set(fp, cur.split(old_string).join(new_string));
        st.applied += 1;
        return;
      }
      const i = cur.indexOf(old_string);
      if (i < 0) {
        st.alreadyApplied += 1;
        return;
      }
      state.set(fp, cur.slice(0, i) + new_string + cur.slice(i + old_string.length));
      st.applied += 1;
    }
  });

  /** @type {Map<string, { content: string, applied: number, alreadyApplied: number, conflicts: any[] }>} */
  const out = new Map();
  for (const [fp, content] of state.entries()) {
    const s = stats.get(fp);
    out.set(fp, { content, ...s });
  }
  return out;
}

function ensureDir(p) {
  fs.mkdirSync(p, { recursive: true });
}

function writeIfChanged(p, content) {
  if (DRY_RUN) return false;
  ensureDir(path.dirname(p));
  fs.writeFileSync(p, content);
  return true;
}

function unifiedDiff(aPath, bPath) {
  // git diff --no-index 输出比 diff -u 美观，且不抛非零
  const r = spawnSync(
    "git",
    ["--no-pager", "diff", "--no-index", "--no-color", "--", aPath, bPath],
    { encoding: "utf8" },
  );
  // git diff 在有差异时退出码 1，纯输出还是要保留
  return (r.stdout || "") + (r.stderr ? `\n[stderr] ${r.stderr}` : "");
}

function lineCount(s) {
  if (!s) return 0;
  // 末行无换行不重复计数
  return s.endsWith("\n") ? s.split("\n").length - 1 : s.split("\n").length;
}

// ===== main =====

if (!fs.existsSync(MAIN_MEMORY_BANK)) {
  console.error(`FAIL: 主目录 memory-bank 不存在: ${MAIN_MEMORY_BANK}`);
  process.exit(1);
}

const reportSections = [];

reportSections.push(`# memory-bank Worktree 回收报告

- 生成时间：${new Date().toISOString()}
- 生成脚本：[scripts/recover-memory-bank.mjs](../../scripts/recover-memory-bank.mjs)
- 模式：${DRY_RUN ? "**dry-run**（未写文件）" : "正式回收"}
- 主目录 memory-bank：\`${path.relative(root, MAIN_MEMORY_BANK)}\`

## 事故源
\`memory-bank/\` 在 [.gitignore](../../.gitignore) 第 36 行被显式忽略，
worktree 是 git 物理隔离的工作树，每个 worktree 自己一份 memory-bank/。
worktree 关闭并删除物理目录后，该目录里 memory-bank/ 内容仅靠人手动 cp
回主目录才能保住，无 git 链路兜底。本报告即从两个已关闭 worktree 的
Claude Code 会话 jsonl 反查它们删除前 memory-bank/ 各文件最终状态。

## 复发预防
1. **临收尾必检**：在 worktree 切回主线前 \`diff -r memory-bank ../主目录/memory-bank\`，
   差异提交决定（合并 / 主线优先 / 拍板）。
2. 若觉得手工脆弱，可考虑把 \`memory-bank/\` 加进 git（去 .gitignore 那一行），
   代价是 commit 历史会被这些日志污染、PR diff 噪声变大。本次保留现状。
3. 跨 worktree 多人/多 Claude 协作时，建议在 PR 描述里明确写"本 PR 涉及 memory-bank
   改动 N 处"，给 reviewer 提示。

---
`);

for (const wt of WORKTREE_SESSION_DIRS) {
  const jsonls = listJsonlsByMtime(wt.dir);
  console.log(`\n[${wt.label}] ${jsonls.length} jsonl 文件`);

  if (jsonls.length === 0) {
    reportSections.push(`## ${wt.label}\n\n_session 目录不存在或为空_\n`);
    continue;
  }

  const events = extractMemoryBankToolUses(jsonls);
  console.log(`  提取 ${events.length} 个 memory-bank 工具调用（已按 id 去重）`);

  const states = buildFinalStates(events, MAIN_MEMORY_BANK);
  console.log(`  涉及 ${states.size} 个 memory-bank 文件`);

  const wtOutDir = path.join(OUT_DIR, wt.label);
  if (!DRY_RUN) ensureDir(wtOutDir);

  /** @type {string[]} */
  const wtSection = [`## ${wt.label}`, ""];
  wtSection.push(`- session 目录：\`${path.relative(HOME, wt.dir)}\``);
  wtSection.push(`- jsonl 数：${jsonls.length}`);
  wtSection.push(`- memory-bank 工具调用：${events.length}`);
  wtSection.push(`- reconstruct 文件数：${states.size}`);
  wtSection.push("");
  wtSection.push(
    "| 文件 | worktree 后行数 | 主目录现行数 | replay 应用 | 已合并 | conflict | 解读 |",
  );
  wtSection.push("|---|---:|---:|---:|---:|---:|---|");

  const entries = Array.from(states.entries()).sort(([a], [b]) =>
    a.localeCompare(b),
  );

  for (const [fp, { content, applied, alreadyApplied, conflicts }] of entries) {
    const basename = path.basename(fp);
    const wtFinal = path.join(wtOutDir, `${basename}.worktree-final.md`);
    const wtDiff = path.join(wtOutDir, `${basename}.diff`);

    const mainPath = path.join(MAIN_MEMORY_BANK, basename);
    const mainExists = fs.existsSync(mainPath);
    const mainContent = mainExists ? fs.readFileSync(mainPath, "utf8") : "";
    const mainLines = lineCount(mainContent);
    const wtLines = lineCount(content);

    let interp;
    if (!mainExists) {
      interp = "**主目录无此文件**——worktree 新建过";
    } else if (applied === 0 && alreadyApplied > 0 && content === mainContent) {
      interp = "全部已合并 ✓";
    } else if (applied > 0) {
      interp = `**${applied} 处改动主目录还没有**——看 .diff 决定合并`;
    } else {
      interp = "无 replay 输入";
    }

    wtSection.push(
      `| \`${basename}\` | ${wtLines || "—"} | ${mainExists ? mainLines : "—"} | ${applied} | ${alreadyApplied} | ${conflicts.length} | ${interp} |`,
    );

    if (content !== null && content !== undefined) {
      writeIfChanged(wtFinal, content);
      if (mainExists) {
        const diffOut = unifiedDiff(mainPath, wtFinal);
        writeIfChanged(wtDiff, diffOut);
      }
    }

    if (conflicts.length > 0) {
      wtSection.push("");
      wtSection.push(`<details><summary>${basename} conflict 明细</summary>\n`);
      wtSection.push("```");
      for (const cf of conflicts.slice(0, 20)) {
        wtSection.push(`[#${cf.idx}] ${cf.ts} ${cf.jsonl}: ${cf.reason}`);
      }
      if (conflicts.length > 20) {
        wtSection.push(`... 还有 ${conflicts.length - 20} 条 ...`);
      }
      wtSection.push("```");
      wtSection.push("</details>");
    }
  }

  wtSection.push("");
  reportSections.push(wtSection.join("\n"));
}

reportSections.push(`---

## 下一步（人工拍板）

1. 看每个 worktree 段下表格里**主目录现行数 < worktree 最终行数**的文件 ——
   差量大概率是丢失的 append-only 历史段落。
2. 打开 \`<basename>.diff\` 文件直接看 git diff 输出。
3. 主目录缺、worktree 有的部分（diff 里 \`+\` 行）按 append-only 原则合并回主目录。
4. 主目录有、worktree 没的部分（diff 里 \`-\` 行）保持主目录优先（worktree 旧）。
5. 不确定的段落人工裁决，本报告不自动写回主目录。
`);

const reportPath = path.join(OUT_DIR, "RECOVERY_NOTES.md");
const reportContent = reportSections.join("\n");

if (DRY_RUN) {
  console.log("\n=== DRY-RUN: RECOVERY_NOTES.md 摘要 ===");
  // 只打印每个 wt 的表格段，避免刷屏
  console.log(reportContent.slice(0, 4000));
  if (reportContent.length > 4000) console.log(`\n... 截断（共 ${reportContent.length} 字符）...`);
} else {
  ensureDir(OUT_DIR);
  fs.writeFileSync(reportPath, reportContent);
  console.log(`\n✓ 写入 ${path.relative(root, reportPath)}`);
  console.log(`✓ 输出目录 ${path.relative(root, OUT_DIR)}/`);
}
