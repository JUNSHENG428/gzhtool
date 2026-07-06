# AGENTS.md

## Runbi E2E Contract

Project: Chrome MV3 extension “润笔 runbi”.

The extension is loaded unpacked from the repository root. Do not load `dist/` as the extension root.

Mandatory pre-step before browser E2E:

```bash
npm run build:floating-ball
```

The floating-ball bundle is generated. Testing without rebuilding can validate stale UI.

## Browser Rules

- Use Playwright `launchPersistentContext`.
- Set `headless: false`.
- Load the extension with:
  - `--disable-extensions-except=<repo root>`
  - `--load-extension=<repo root>`
- Get the extension ID from the MV3 service worker URL. Never hardcode it.
- Use clean user data for first-user tests. Do not reuse storage state across scenarios unless the scenario explicitly tests login persistence.
- Do not use `waitForTimeout` in E2E specs. Wait on DOM, task state, service worker messages, navigation, or storage changes.

## Core Slice: Capture To Rewrite

Current executable spec:

```bash
npx playwright test tests/e2e/scrape-ai-rewrite.spec.ts --workers=1 --reporter=list
```

This spec:

- Opens a local Playwright-fulfilled article fixture on a manifest-authorized host.
- Runs `scrape-article.js` in a real browser tab through the extension background path.
- Asserts title, author, URL, text blocks, body text, and images are non-empty.
- Opens `workspace.html?import=1#layout` and asserts title/body/preview import.
- Mocks OpenAI, DeepSeek, and DashScope in the MV3 service worker `fetch`.
- Waits for rewrite completion through task-center state and visible DOM output.
- Saves screenshots and metrics in `dist/e2e-observations/`.

## Fake-Pass Guards

Every E2E slice must explicitly protect against:

- Stale floating-ball bundle: run `npm run build:floating-ball`.
- Sleeping service worker or dropped messages: wait for explicit events/state, not time.
- Empty capture passing: use `.not.toBeEmpty()` or stronger length assertions for title/body/images.
- WeChat editor injection race: wait for editor-ready signals before asserting draft fields.
- Real AI calls: mock OpenAI, DeepSeek, DashScope, and platform LLM endpoints.

## Next Required Slices

Add separate specs under `tests/e2e/` for:

- Login/Auth: popup first launch → DocuEarn login + Google OAuth handoff → storage state persistence.
- Formatting: imported/rewrite content → theme/layout assertions.
- WeChat draft push: `wechat-editor-helper.js` writes to mp.weixin.qq.com editor → record `.webm`.

Each slice must update:

- `docs/E2E_CORE_FUNCTIONAL_REPORT.md` or a slice-specific functional report.
- `docs/E2E_COPY_ISSUES.md`.
- `docs/E2E_UX_OPTIMIZATION_REPORT.md`.
