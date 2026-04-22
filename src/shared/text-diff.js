/**
 * 将两段 HTML 转为纯文本后做行级 + 词/字级 LCS diff，生成左右栏可插入 DOM 的 HTML。
 * 仅用于展示，不包含业务逻辑。
 */

/**
 * @param {string} beforeHtml
 * @param {string} afterHtml
 * @returns {{ leftHtml: string, rightHtml: string }}
 */
export function diffHtml(beforeHtml, afterHtml) {
  const beforeText = htmlToPlainText(beforeHtml);
  const afterText = htmlToPlainText(afterHtml);
  const linesA = beforeText.split("\n");
  const linesB = afterText.split("\n");

  const maxLines = 800;
  const truncA = linesA.length > maxLines ? linesA.slice(0, maxLines) : linesA;
  const truncB = linesB.length > maxLines ? linesB.slice(0, maxLines) : linesB;

  const raw = lineLcsOps(truncA, truncB);
  const simp = simplifyLineOps(raw);

  const leftRows = [];
  const rightRows = [];

  for (const op of simp) {
    if (op.type === "eq") {
      const e = esc(op.line);
      leftRows.push(rowWrap(e));
      rightRows.push(rowWrap(e));
    } else if (op.type === "del") {
      leftRows.push(rowWrap(`<span class="diff-line-del">${esc(op.line)}</span>`));
      rightRows.push(rowWrap(emptyCell()));
    } else if (op.type === "ins") {
      leftRows.push(rowWrap(emptyCell()));
      rightRows.push(rowWrap(`<span class="diff-line-ins">${esc(op.line)}</span>`));
    } else if (op.type === "rep") {
      const { left, right } = diffTwoLines(op.a, op.b);
      leftRows.push(rowWrap(left));
      rightRows.push(rowWrap(right));
    }
  }

  if (linesA.length > maxLines || linesB.length > maxLines) {
    const note = esc(`（仅对比前 ${maxLines} 行）`);
    leftRows.push(rowWrap(`<span class="diff-trunc-note">${note}</span>`));
    rightRows.push(rowWrap(`<span class="diff-trunc-note">${note}</span>`));
  }

  return {
    leftHtml: leftRows.join(""),
    rightHtml: rightRows.join("")
  };
}

function htmlToPlainText(html) {
  const wrap = `<div class="diff-text-root">${html || ""}</div>`;
  const doc = new DOMParser().parseFromString(wrap, "text/html");
  const root = doc.body.querySelector(".diff-text-root");
  const t = root?.innerText ?? "";
  return String(t).replace(/\r\n/g, "\n");
}

function esc(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function rowWrap(inner) {
  return `<div class="diff-row">${inner}</div>`;
}

function emptyCell() {
  return '<span class="diff-row-gap">&nbsp;</span>';
}

/** @returns {{ type: 'eq'|'del'|'ins', line?: string }[]} */
function lineLcsOps(linesA, linesB) {
  const a = linesA;
  const b = linesB;
  const m = a.length;
  const n = b.length;
  const dp = Array.from({ length: m + 1 }, () => Array(n + 1).fill(0));
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      if (a[i - 1] === b[j - 1]) dp[i][j] = dp[i - 1][j - 1] + 1;
      else dp[i][j] = Math.max(dp[i - 1][j], dp[i][j - 1]);
    }
  }
  const ops = [];
  let i = m;
  let j = n;
  while (i > 0 || j > 0) {
    if (i > 0 && j > 0 && a[i - 1] === b[j - 1]) {
      ops.unshift({ type: "eq", line: a[i - 1] });
      i--;
      j--;
    } else if (j > 0 && (i === 0 || dp[i][j - 1] >= dp[i - 1][j])) {
      ops.unshift({ type: "ins", line: b[j - 1] });
      j--;
    } else {
      ops.unshift({ type: "del", line: a[i - 1] });
      i--;
    }
  }
  return ops;
}

function simplifyLineOps(ops) {
  const out = [];
  let i = 0;
  while (i < ops.length) {
    const cur = ops[i];
    const next = ops[i + 1];
    if (cur.type === "del" && next?.type === "ins") {
      out.push({ type: "rep", a: cur.line, b: next.line });
      i += 2;
    } else {
      out.push(cur);
      i += 1;
    }
  }
  return out;
}

/**
 * @param {string[]} a
 * @param {string[]} b
 */
function lcsOperations(a, b) {
  const m = a.length;
  const n = b.length;
  const dp = Array.from({ length: m + 1 }, () => Array(n + 1).fill(0));
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      if (a[i - 1] === b[j - 1]) dp[i][j] = dp[i - 1][j - 1] + 1;
      else dp[i][j] = Math.max(dp[i - 1][j], dp[i][j - 1]);
    }
  }
  const ops = [];
  let i = m;
  let j = n;
  while (i > 0 || j > 0) {
    if (i > 0 && j > 0 && a[i - 1] === b[j - 1]) {
      ops.unshift({ type: "eq", v: a[i - 1] });
      i--;
      j--;
    } else if (j > 0 && (i === 0 || dp[i][j - 1] >= dp[i - 1][j])) {
      ops.unshift({ type: "ins", v: b[j - 1] });
      j--;
    } else {
      ops.unshift({ type: "del", v: a[i - 1] });
      i--;
    }
  }
  return ops;
}

function tokenArray(s) {
  if (!s) return [];
  if (/^\s*$/.test(s)) return [s];
  if (/\s/.test(s)) {
    const out = [];
    const re = /[\u4e00-\u9fff]|\S+|\s+/g;
    let m;
    while ((m = re.exec(s)) !== null) out.push(m[0]);
    return out;
  }
  return [...s];
}

function renderTokenOps(ops) {
  let left = "";
  let right = "";
  let idx = 0;
  while (idx < ops.length) {
    const op = ops[idx];
    if (op.type === "eq") {
      const t = esc(op.v);
      left += t;
      right += t;
      idx++;
    } else if (op.type === "del" && ops[idx + 1]?.type === "ins") {
      left += `<span class="diff-w-del">${esc(op.v)}</span>`;
      right += `<span class="diff-w-mod">${esc(ops[idx + 1].v)}</span>`;
      idx += 2;
    } else if (op.type === "del") {
      left += `<span class="diff-w-del">${esc(op.v)}</span>`;
      idx++;
    } else {
      right += `<span class="diff-w-ins">${esc(op.v)}</span>`;
      idx++;
    }
  }
  return { left, right };
}

function diffTwoLines(a, b) {
  const maxUnit = 400;
  if (a.length <= maxUnit && b.length <= maxUnit && a.length * b.length < 180000) {
    const ach = [...a];
    const bch = [...b];
    const cops = lcsOperations(ach, bch);
    return renderTokenOps(cops);
  }
  const wa = tokenArray(a);
  const wb = tokenArray(b);
  const wops = lcsOperations(wa, wb);
  return renderTokenOps(wops);
}
