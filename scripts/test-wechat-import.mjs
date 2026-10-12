import assert from 'node:assert/strict';
import { test, beforeEach } from 'node:test';
import { webcrypto } from 'node:crypto';
import { isWechatEditorUrl, newWechatEditorUrl, stageWechatImport, resumeWechatImport, moveWechatImportToNewTab, recordWechatImportResult, publishViaBrowser } from '../src/background/wechat-browser-bridge.js';
if (!globalThis.crypto) globalThis.crypto = webcrypto;
let db, tabs, sent, creates, receiver;
const editorUrl = 'https://mp.weixin.qq.com/cgi-bin/appmsg?action=edit&token=123';
const payload = () => ({ meta: { title: '稿件甲', author: '' }, html: '<p>必须完整保留的正文</p>', selectedArticleId: 'a', profile: { targetProfileName: '目标公众号' }, bundle: { index: 2, total: 3, syncedAt: 1 } });
beforeEach(() => {
  db = {}; sent = []; creates = []; receiver = async () => ({ ok: true, status: 'awaiting-confirmation' });
  tabs = [{ id: 11, url: 'https://mp.weixin.qq.com/cgi-bin/appmsg?action=list_card&token=123', windowId: 1 }, { id: 22, url: editorUrl, windowId: 1 }];
  globalThis.chrome = {
    tabs: {
      query: async () => tabs,
      update: async id => tabs.find(t => t.id === id),
      create: async options => { const tab = { ...options, id: 100 + creates.length, windowId: 1 }; creates.push(tab); tabs.push(tab); return tab; },
      sendMessage: async (id, message) => { sent.push({ id, message }); return receiver(id, message); }
    },
    windows: { update: async () => {} },
    storage: { local: {
      get: async key => ({ [key]: structuredClone(db[key]) }),
      set: async data => Object.assign(db, structuredClone(data)),
      remove: async key => { delete db[key]; }
    } }
  };
});
test('仅识别真实编辑 URL，拒绝草稿列表、伪域名和不完整路径', () => {
  for (const url of [editorUrl, 'https://mp.weixin.qq.com/cgi-bin/appmsg?t=media/appmsg_edit_v2', 'https://mp.weixin.qq.com/cgi-bin/appmsg?action=add']) assert.equal(isWechatEditorUrl(url), true);
  for (const url of [tabs[0].url, 'https://mp.weixin.qq.com/cgi-bin/appmsg', 'https://mp.weixin.qq.com.evil.test/cgi-bin/appmsg?action=edit', 'https://mp.weixin.qq.com/cgi-bin/appmsg?action=edit_fake', 'not a url']) assert.equal(isWechatEditorUrl(url), false);
});
test('新建编辑页只从公众号地址保留数字 token', () => {
  assert.equal(new URL(newWechatEditorUrl(editorUrl)).searchParams.get('token'), '123');
  assert.equal(isWechatEditorUrl(newWechatEditorUrl()), true);
  assert.equal(new URL(newWechatEditorUrl('https://other.test/?token=123')).searchParams.has('token'), false);
});
test('列表页在前也选择真正编辑页，返回待确认而非已写入', async () => {
  const result = await stageWechatImport(payload(), { preferredTabId: 11 });
  assert.equal(result.tabId, 22); assert.equal(result.status, 'awaiting-confirmation'); assert.equal(result.bodyWritten, false);
  assert.equal(creates.length, 0); assert.equal(sent[0].message.payload.profile.targetProfileName, '目标公众号');
});
test('没有编辑页时另开新建页，保留原列表页', async () => {
  tabs.pop(); await stageWechatImport(payload());
  assert.equal(creates.length, 1); assert.equal(isWechatEditorUrl(creates[0].url), true);
  assert.equal(tabs[0].url.includes('list_card'), true);
});
test('脚本未就绪时持久化；页面就绪后恢复同一篇与同一 transferId', async () => {
  receiver = async () => { throw new Error('no receiver'); };
  const first = await stageWechatImport(payload()); assert.equal(first.status, 'awaiting-editor');
  receiver = async () => ({ ok: true, status: 'awaiting-confirmation' });
  const resumed = await resumeWechatImport(22);
  assert.equal(resumed.transferId, first.transferId); assert.equal(sent.at(-1).message.payload.selectedArticleId, 'a');
});
test('连续点击同一稿件不会产生第二份待导入记录，时间戳不影响幂等', async () => {
  const [a,b] = await Promise.all([stageWechatImport(payload()), stageWechatImport({ ...payload(), bundle: { ...payload().bundle, syncedAt: 2 } })]);
  assert.equal(a.transferId, b.transferId); assert.equal(Object.keys(db).length, 1);
});
test('不同稿件不能覆盖尚未确认的稿件', async () => {
  const original = await stageWechatImport(payload());
  await assert.rejects(stageWechatImport({ ...payload(), html: '<p>另一篇</p>' }), /待确认/);
  assert.equal(db['runbiWechatImport:22'].transferId, original.transferId);
});
test('取消只清理匹配的任务；过期回执不能覆盖新稿件状态', async () => {
  const original = await stageWechatImport(payload());
  assert.equal(await recordWechatImportResult(22, { transferId: 'stale', status: 'written' }), null);
  assert.ok(db['runbiWechatImport:22']);
  await recordWechatImportResult(22, { transferId: original.transferId, status: 'cancelled' });
  assert.equal(db['runbiWechatImport:22'], undefined);
  const next = await stageWechatImport({ ...payload(), selectedArticleId: 'b' });
  assert.notEqual(next.transferId, original.transferId);
  assert.equal(await recordWechatImportResult(22, { transferId: original.transferId, status: 'saved' }), null);
});
test('写入、待确认保存、保存成功是分开的回执状态', async () => {
  const { transferId } = await stageWechatImport(payload());
  for (const status of ['written', 'save-unconfirmed', 'saved', 'unsaved', 'restored']) {
    const receipt = await recordWechatImportResult(22, { transferId, status });
    assert.equal(receipt.status, status); assert.equal(receipt.articleTitle, '稿件甲');
  }
});
test('另建一篇保留原稿件及目标账号，清除旧页待导入', async () => {
  const { transferId } = await stageWechatImport(payload());
  const next = await moveWechatImportToNewTab(22, transferId);
  assert.equal(db['runbiWechatImport:22'], undefined); assert.notEqual(next.tabId, 22);
  assert.deepEqual(db['runbiWechatImport:' + next.tabId].payload, payload());
});
test('失效任务和空稿件不会被导入', async () => {
  await assert.rejects(stageWechatImport({ ...payload(), html: '' }), /标题和正文/);
  await stageWechatImport(payload()); db['runbiWechatImport:22'].createdAt = 0;
  assert.equal(await resumeWechatImport(22), null);
  assert.equal(db['runbiWechatImport:22'], undefined);
});
test('浏览器接口拒绝静默丢弃多图文副篇；单篇走同一确认通道', async () => {
  await assert.rejects(publishViaBrowser({ articles: [payload(), payload()] }), /一次处理一篇/);
  const result = await publishViaBrowser({ articles: [payload()], accountName: '目标公众号' });
  assert.equal(result.status, 'awaiting-confirmation'); assert.equal(result.mode, 'browser');
  assert.equal(sent[0].message.payload.profile.targetProfileName, '目标公众号');
});

test('storage 属性重排后仍识别为同一稿件', async () => {
  const first = await stageWechatImport(payload());
  const record = db['runbiWechatImport:22'];
  const sort = value => value && typeof value === 'object' && !Array.isArray(value) ? Object.fromEntries(Object.keys(value).sort().map(key => [key, sort(value[key])])) : value;
  record.payload = sort(record.payload);
  const second = await stageWechatImport(payload());
  assert.equal(second.transferId, first.transferId);
});
