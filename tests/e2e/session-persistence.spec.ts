import {
  test, expect, openExtensionPage, getExtensionStorage, setExtensionStorage, installServiceWorkerAiMock
} from "./fixtures/extension";

test("两个扩展页面并发保存会话，改写和编辑内容均保留", async ({ extension }) => {
  await installServiceWorkerAiMock(extension, { choices: [{ message: { content: "unused" } }] });
  // Static extension pages avoid unrelated workspace autosaves during this test.
  const page1 = await openExtensionPage(extension, "src/pages/permissions.html");
  const page2 = await openExtensionPage(extension, "src/pages/privacy.html");
  await setExtensionStorage(page1, { wechatWriterSession: { lastTheme: "existing-theme" } });
  for (let iteration = 0; iteration < 12; iteration++) {
    await Promise.all([
      page1.evaluate(async i => {
        const storage = await import(chrome.runtime.getURL("src/shared/storage.js"));
        return storage.saveSession({ lastDraft: { title: `rewrite-${i}` } });
      }, iteration),
      page2.evaluate(async i => {
        const storage = await import(chrome.runtime.getURL("src/shared/storage.js"));
        return storage.saveSession({ lastBodyHtml: `<p>edit-${i}</p>` });
      }, iteration)
    ]);
    const saved = (await getExtensionStorage(page1, ["wechatWriterSession"])).wechatWriterSession;
    expect(saved.lastDraft.title).toBe(`rewrite-${iteration}`);
    expect(saved.lastBodyHtml).toBe(`<p>edit-${iteration}</p>`);
    expect(saved.lastTheme).toBe("existing-theme");
  }
  await page1.close();
  await page2.close();
});
