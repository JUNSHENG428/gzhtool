# 第三方库（供扩展页直接 `import` / 脚本标签加载）

与 `node_modules` 解耦：发布包（`npm run build:zip`）只含 `src/`，故将运行时所依赖的浏览器端文件同步到此目录。

| 目录 | 来源包 | 用途 |
|------|--------|------|
| `marked/marked.esm.js` | `marked` | Markdown → HTML |
| `mammoth/mammoth.browser.min.js` | `mammoth` | .docx → HTML |
| `pdfjs/pdf.mjs` + `pdf.worker.mjs` | `pdfjs-dist` | PDF 文本抽取 |

升级依赖后请执行：`npm run vendor:sync`（从 `node_modules` 再复制一遍）。
