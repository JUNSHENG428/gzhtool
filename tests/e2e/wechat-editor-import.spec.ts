import { test, expect, openExtensionPage, sendRuntimeMessage, getExtensionStorage, setExtensionStorage, installServiceWorkerAiMock } from './fixtures/extension';
import type { Page } from 'playwright/test';
import fs from 'node:fs/promises';
import path from 'node:path';
import { repoRoot } from './fixtures/extension';

const editorUrl = 'https://mp.weixin.qq.com/cgi-bin/appmsg?action=edit&token=123';
const oldBody = '原有正文必须保留，取消导入不能把这段文字覆盖。';
const newBody = '这是导入的完整正文。第一段说明具体情况，第二段保留明确结论，不应只写入开头。';
const draft = (account = '测试公众号') => ({
  meta: { title: '确认导入的第二篇', author: '', digest: '准确的摘要', contentSourceUrl: '' },
  html: `<h2>清楚的标题</h2><p>${newBody}</p><img src="https://techcrunch.com/runbi-fixtures/cover.jpg" alt="示例图片">`,
  profile: { targetProfileName: account }, selectedArticleId: 'article-b',
  bundle: { articleId: 'article-b', index: 2, total: 3, bodyChars: newBody.length, syncedAt: Date.now() }
});
function fixture(account = '测试公众号') {
  return `<!doctype html><meta charset="utf-8"><title>公众号本地编辑器 fixture</title>
  <style>body{font:16px sans-serif;padding:110px 70px 50px;margin:0} input,textarea{display:block;margin:8px;width:500px} #body{width:760px;min-height:280px;border:1px solid #aaa;padding:20px} button{padding:10px;margin:10px}</style>
  <div class="weui-desktop-account__nickname">${account}</div>
  <input placeholder="标题" value="原有标题"><input placeholder="作者" value="原作者"><textarea placeholder="摘要">原摘要</textarea><input placeholder="原文链接" value="https://example.test/original">
  <div id="body" contenteditable="true"><p>${oldBody}</p></div>
  <button id="save">保存为草稿</button><button id="success">模拟成功提示</button>
  <script>
  document.querySelector('#save').onclick=()=>{let e=document.createElement('div');e.setAttribute('role','alert');e.textContent='保存失败，请重试';document.body.appendChild(e)};
  document.querySelector('#success').onclick=()=>{let e=document.createElement('div');e.setAttribute('role','status');e.textContent='保存成功';document.body.appendChild(e)};
  </script>`;
}
async function setup(extension: any, account = '测试公众号') {
  await installServiceWorkerAiMock(extension, { choices: [{ message: { content: 'unused' } }] });
  // 此切片不访问任何真实后端，包括授权、公众号接口和模型接口。
  await extension.serviceWorker.evaluate(() => {
    globalThis.fetch = async () => new Response(JSON.stringify({ error: 'fixture: no network' }), { status: 503, headers: { 'content-type': 'application/json' } });
  });
  await extension.context.route('https://mp.weixin.qq.com/**', (route: any) => route.fulfill({ contentType: 'text/html', body: fixture(account) }));
  const control = await openExtensionPage(extension, 'src/pages/permissions.html');
  await setExtensionStorage(control, { wechatWriterSettings: { floatingBallEnabled: true } });
  const page = await extension.context.newPage();
  await page.goto(editorUrl);
  await expect(page.locator('#body')).toContainText(oldBody);
  return { control, page };
}
async function stage(control: Page, payload = draft()) {
  const result = await sendRuntimeMessage(control, { type: 'SYNC_TO_WECHAT_WEB_EDITOR', payload });
  expect(result.ok, JSON.stringify(result)).toBe(true);
  expect(result.data.bodyWritten).toBe(false);
  return result.data;
}
async function status(control: Page, tabId: number) {
  return (await getExtensionStorage(control, ['runbiWechatReceipt:' + tabId]))['runbiWechatReceipt:' + tabId]?.status;
}

test('确认导入、完整回读、保存状态及恢复副本', async ({ extension }) => {
  const { control, page } = await setup(extension);
  const receipt = await stage(control);
  const dialog = page.locator('#runbi-import-confirm');
  await expect(dialog).toBeVisible();
  await expect(dialog).toContainText('确认导入的第二篇');
  await expect(dialog).toContainText('第 2 / 3 篇');
  await expect(dialog).toContainText('当前账号：测试公众号');
  const screenshots = path.join(repoRoot, 'dist/e2e-observations');
  await fs.mkdir(screenshots, { recursive: true });
  await page.screenshot({ path: path.join(screenshots, 'wechat-import-confirm.png'), fullPage: true });
  await expect(page.locator('#body')).toContainText(oldBody);
  await dialog.locator('[data-import-confirm]').click();
  await expect(dialog).toBeHidden();
  await expect(page.locator('input[placeholder="标题"]')).toHaveValue('确认导入的第二篇');
  await expect(page.locator('#body')).toHaveText('清楚的标题' + newBody);
  await expect(page.locator('#body img')).toHaveCount(1);
  await expect(page.locator('input[placeholder="作者"]')).toHaveValue('');
  await expect(page.locator('input[placeholder="原文链接"]')).toHaveValue('');
  await expect.poll(() => status(control, receipt.tabId)).toBe('written');
  const banner = page.locator('#wechat-editor-sync-banner');
  await expect(banner).toContainText('尚未保存');
  await page.locator('#save').click();
  await expect(page.getByRole('alert')).toHaveText('保存失败，请重试');
  await expect.poll(() => status(control, receipt.tabId)).toBe('save-unconfirmed');
  await expect(banner).not.toContainText('已检测到公众号保存成功');
  await page.locator('#success').click();
  await expect.poll(() => status(control, receipt.tabId)).toBe('saved');
  await page.locator('#body').fill('手动修改后的内容');
  await expect.poll(() => status(control, receipt.tabId)).toBe('unsaved');
  page.once('dialog', d => d.accept());
  await banner.locator('[data-banner-action="restore"]').click();
  await expect(page.locator('#body')).toHaveText(oldBody);
  await expect(page.locator('input[placeholder="标题"]')).toHaveValue('原有标题');
  await expect(page.locator('input[placeholder="作者"]')).toHaveValue('原作者');
  await expect.poll(() => status(control, receipt.tabId)).toBe('restored');
  const dir = path.join(repoRoot, 'dist/e2e-observations'); await fs.mkdir(dir, { recursive: true });
  await page.screenshot({ path: path.join(dir, 'wechat-import-restored.png'), fullPage: true });
});

test('取消和账号不匹配均不覆盖原文，未知账号需人工核对', async ({ extension }) => {
  const { control, page } = await setup(extension);
  const first = await stage(control, draft('另一公众号'));
  const dialog = page.locator('#runbi-import-confirm');
  await expect(dialog).toContainText('账号不一致');
  await expect(dialog.locator('[data-import-confirm]')).toBeDisabled();
  await dialog.locator('[data-import-cancel]').click();
  await expect.poll(() => status(control, first.tabId)).toBe('cancelled');
  await expect(page.locator('#body')).toHaveText(oldBody);
  await stage(control, draft(''));
  await dialog.locator('[data-import-confirm]').click();
  await expect(dialog).toContainText('请先核对当前公众号');
  await expect(page.locator('#body')).toHaveText(oldBody);
  await dialog.locator('[data-import-account-check]').check();
  await dialog.locator('[data-import-confirm]').click();
  await expect(page.locator('#body')).toContainText(newBody);
});

test('待确认稿件刷新后续接且保持选定篇，重复点击不另建任务', async ({ extension }) => {
  const { control, page } = await setup(extension);
  const first = await stage(control);
  await expect(page.locator('#runbi-import-confirm')).toBeVisible();
  const second = await stage(control);
  expect(second.transferId).toBe(first.transferId);
  await page.reload();
  await expect(page.locator('#runbi-import-confirm')).toContainText('确认导入的第二篇');
  await expect(page.locator('#body')).toHaveText(oldBody);
  const stored = (await getExtensionStorage(control, ['runbiWechatImport:' + first.tabId]))['runbiWechatImport:' + first.tabId];
  expect(stored.payload.selectedArticleId).toBe('article-b');
  expect(stored.transferId).toBe(first.transferId);
  await page.locator('[data-import-cancel]').click();
  await expect.poll(() => status(control, first.tabId)).toBe('cancelled');
});

test('工作台切篇不串稿，导入读取最新控件；草稿按钮不受旧发布模式影响', async ({ extension }) => {
  const { control, page } = await setup(extension);
  const { fakeYearlyLicense } = await import('./fixtures/extension');
  const license = fakeYearlyLicense();
  await setExtensionStorage(control, {
    wechatWriterLicense: license,
    wechatWriterLicenseAuth: { token: 'dev-fake-token', user: license.user, issuedAt: Date.now() },
    wechatWriterSettings: { wechatProfiles: [{ name: '测试公众号', mode: 'api', appId: 'fixture', appSecret: 'fixture' }] },
    wechatWriterSession: {
      lastCapture: { title: '素材', url: 'https://techcrunch.com/runbi-fixtures/local-article', text: '素材正文', images: [{ src: 'https://techcrunch.com/runbi-fixtures/cover.jpg' }], blocks: [] },
      articleBundle: [
        { id: 'article-a', meta: { title: '第一篇原题', author: '', digest: '第一篇摘要', targetProfileIndex: 0, coverImageIndex: 1 }, bodyHtml: '<p>第一篇原文</p>' },
        { id: 'article-b', meta: { title: '第二篇原题', author: '', digest: '第二篇摘要', publishEnabled: false, targetProfileIndex: 0, coverImageIndex: 1 }, bodyHtml: '<p>第二篇原文</p>' }
      ], currentArticleIndex: 0, lastTheme: 'editorial-green'
    }
  });
  const workspace = await openExtensionPage(extension, 'src/workspace/workspace.html#layout');
  await expect(workspace.locator('#titleInput')).toHaveValue('第一篇原题');
  // 不触发 input 事件，验证导入和切篇会主动收取 DOM 最新值，而非依赖防抖保存。
  await workspace.evaluate(() => {
    (document.querySelector('#titleInput') as HTMLInputElement).value = '第一篇最新标题';
    document.querySelector('#editor')!.innerHTML = '<p>第一篇尚未触发自动保存的正文</p>';
    location.hash = 'publish';
  });
  await workspace.locator('[data-publish-toggle][data-index="1"]').check();
  const bundle = await workspace.evaluate(async () => {
    const { state } = await import(chrome.runtime.getURL('src/workspace/workspace-state.js'));
    return state.articleBundle;
  });
  expect(bundle[0].meta.title).toBe('第一篇最新标题');
  expect(bundle[0].bodyHtml).toContain('尚未触发自动保存');
  expect(bundle[1].meta.title).toBe('第二篇原题');
  await workspace.evaluate(() => {
    (document.querySelector('#titleInput') as HTMLInputElement).value = '第二篇最新标题';
    document.querySelector('#editor')!.innerHTML = '<p>第二篇最新正文，必须送出这一版。</p>';
  });
  await workspace.locator('#syncWebEditorButton').click();
  await expect(page.locator('#runbi-import-confirm')).toContainText('第二篇最新标题');
  await expect(page.locator('#runbi-import-confirm')).toContainText('第二篇最新正文');
  await page.locator('[data-import-cancel]').click();
  await expect(workspace.locator('#webEditorSyncResult')).toContainText('已取消导入');
  await workspace.evaluate(() => {
    const original = chrome.runtime.sendMessage.bind(chrome.runtime);
    (window as any).__sentDraftModes = [];
    chrome.runtime.sendMessage = ((message: any, ...args: any[]) => {
      if (message.type === 'PUBLISH_TO_WECHAT') {
        (window as any).__sentDraftModes.push(message.payload.publishMode);
        return Promise.resolve({ ok: true, data: { draftMediaId: 'fixture-draft' } });
      }
      return (original as any)(message, ...args);
    }) as any;
    (document.querySelector('#publishModeSelect') as HTMLSelectElement).value = 'publish';
  });
  await workspace.locator('#publishCurrentButton').click();
  await expect.poll(() => workspace.evaluate(() => (window as any).__sentDraftModes)).toEqual(['draft']);
  await expect(workspace.locator('#publishConfirmModal')).toBeHidden();
  await workspace.evaluate(async () => {
    const { publishBundle } = await import(chrome.runtime.getURL('src/workspace/workspace-publish.js'));
    await publishBundle('publish');
  });
  await expect(workspace.locator('#publishConfirmModal')).toBeVisible();
  expect(await workspace.evaluate(() => (window as any).__sentDraftModes)).toEqual(['draft']);
  await workspace.locator('#cancelPublishConfirmButton').click();
});

test('编辑器异步回滚不误报完整写入，仍保留恢复副本', async ({ extension }) => {
  const { control, page } = await setup(extension);
  const receipt = await stage(control);
  // 模拟真实富文本编辑器：DOM 注入后被其内部模型回滚。
  await page.evaluate(() => {
    document.querySelector('#body')!.addEventListener('input', () => {
      queueMicrotask(() => { document.querySelector('#body')!.innerHTML = '<p>被编辑器截断</p>'; });
    });
  });
  await page.locator('[data-import-confirm]').click();
  await expect.poll(() => status(control, receipt.tabId)).toBe('partial');
  await expect(page.locator('#wechat-editor-sync-helper')).toContainText('部分内容未能完整写入');
  const saved = (await getExtensionStorage(control, ['runbiWechatBackup:' + receipt.tabId]))['runbiWechatBackup:' + receipt.tabId];
  expect(saved.html).toContain(oldBody);
});

for (const useReactFloatingBall of [true, false]) {
  test(`草稿列表页浮球可导入，自动选择已打开的编辑页（React=${useReactFloatingBall}）`, async ({ extension }) => {
    const { control, page } = await setup(extension);
    const { fakeYearlyLicense } = await import('./fixtures/extension');
    const license = fakeYearlyLicense();
    await setExtensionStorage(control, {
      wechatWriterLicense: license,
      wechatWriterLicenseAuth: { token: 'dev-fake-token', user: license.user, issuedAt: Date.now() },
      wechatWriterSettings: { floatingBallEnabled: true, useReactFloatingBall },
      wechatWriterSession: { articleBundle: [{ id: 'float-draft', meta: { title: '从列表页导入的稿件' }, bodyHtml: '<p>浮球导入必须带上正文。</p>' }], currentArticleIndex: 0 }
    });
    const workspace = await openExtensionPage(extension, 'src/workspace/workspace.html#layout');
    await expect(workspace.locator('#titleInput')).toHaveValue('从列表页导入的稿件');
    const listing = await extension.context.newPage();
    await listing.goto('https://mp.weixin.qq.com/cgi-bin/appmsg?action=list_card&token=123');
    const button = listing.getByRole('button', { name: '打开新建图文并导入润笔稿件', exact: true });
    await expect(button).toBeEnabled();
    await button.click();
    await expect(page.locator('#runbi-import-confirm')).toContainText('从列表页导入的稿件');
    await expect(page.locator('#body')).toHaveText(oldBody);
    expect(listing.url()).toContain('action=list_card');
    await page.locator('[data-import-cancel]').click();
  });
}

test('另建一篇将待导入稿件移到新页，原编辑页不变', async ({ extension }) => {
  const { control, page } = await setup(extension);
  // Chrome 的扩展发起导航不受 Playwright route 拦截。仅替换导航起点，
  // 仍由真实 bridge 建 tab/持久化任务；随后在同一 tab 加载本地编辑器 fixture。
  await extension.serviceWorker.evaluate(() => {
    const create = chrome.tabs.create.bind(chrome.tabs);
    chrome.tabs.create = (async (options: any) => {
      (globalThis as any).__newEditorUrl = options.url;
      return create({ ...options, url: 'about:blank' });
    }) as any;
  });
  const first = await stage(control);
  const newPageReady = extension.context.waitForEvent('page');
  await page.locator('[data-import-new]').click();
  const another = await newPageReady;
  const requestedUrl = await extension.serviceWorker.evaluate(() => (globalThis as any).__newEditorUrl);
  expect(requestedUrl).toContain('isNew=1');
  await another.goto(requestedUrl);
  await expect(another.locator('#runbi-import-confirm')).toContainText('确认导入的第二篇');
  await expect(page.locator('#runbi-import-confirm')).toBeHidden();
  await expect(page.locator('#body')).toHaveText(oldBody);
  expect(another.url()).toContain('isNew=1');
  await expect.poll(async () => (await getExtensionStorage(control, ['runbiWechatImport:' + first.tabId]))['runbiWechatImport:' + first.tabId]).toBeUndefined();
  await another.locator('[data-import-cancel]').click();
});
