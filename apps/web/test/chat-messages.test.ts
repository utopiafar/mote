import assert from 'node:assert/strict';
import test from 'node:test';
import {act} from 'react';
import sharp from 'sharp';
import {isCentralConnectorActionTarget, pageHash, type ActionProposal} from '@mote/shared';
import type {Answer} from '../src/api';
import {ApiError} from '../src/api';
import {resources} from '../src/resource-cache';
import {currentInstructionFixture, gate} from '../../server/test/fixtures/current-owner-instruction';
import {currentOwnerCalendarFixture} from '../../server/test/fixtures/current-owner-calendar';
import {taskSteeringFixture} from '../../server/test/fixtures/assistant-task-steering';
import {at, chatDom, chatId, chatPath, generatedApi, injectedApi, turnId} from './fixtures/chat-dom';

for (const loseReceipt of [false, true]) test(
  'CH1-02 and CH1-11 stop the active answer through its exact durable message receipt' + (loseReceipt ? ' after a lost response' : ''),
  {timeout: 30000}, async t => {
  const entered = gate(), release = gate();
  t.after(release.release);
  const server = await currentInstructionFixture(t, async () => {
    entered.release();
    await release.promise;
    return {answer: 'Generated late answer', citationIds: []};
  });
  const f = await chatDom(t);
  const writes: string[] = [];
  const checks: string[] = [];
  const central = injectedApi(server.node.app, server.headers, (path, init) => {
    if (init.method === 'POST') writes.push(path);
  });
  const api = {...central, request: async <T>(path: string, init?: RequestInit) => {
    const result = await central.request<T>(path, init);
    if (loseReceipt && path.endsWith('/cancel')) throw new TypeError('Generated lost cancellation response');
    if (writes.at(-1) === path + '/cancel') checks.push(path);
    return result;
  }};
  await f.render(api);
  await f.waitFor(() => f.d.querySelector('.chat-page[aria-busy="false"]'), 'open main conversation');
  await f.field('.chat-compose-form textarea', 'Generated long owner instruction');
  await f.submit();
  await act(async () => {await entered.promise;});
  await f.waitFor(() => f.d.querySelector('[data-message-kind="progress"]'), 'server-confirmed progress');
  const messageId = f.element('.chat-message').id.slice('conversation-turn-'.length);
  const progress = f.element('[data-message-kind="progress"]');
  assert.equal(progress.querySelectorAll('button').length, 1);
  assert.equal(f.d.querySelector('.chat-answer-actions'), null);
  await f.click('[data-message-kind="progress"] button');
  await f.waitFor(() => f.d.querySelector('.chat-message[data-state="cancelled"]'), 'cancelled receipt rendered');
  assert.equal(server.node.conversations.message(messageId).status, 'cancelled');
  const messagePath = chatPath(server.conversationId) + '/messages/' + messageId;
  assert.deepEqual(writes, ['/api/conversations/messages', messagePath + '/cancel']);
  if (loseReceipt) assert.ok(checks.includes(messagePath));
  assert.equal(f.d.querySelector('.chat-error'), null);
  release.release();
  const cancelled = f.element('[data-message-kind="progress"][data-state="cancelled"][role="status"]');
  assert.equal(cancelled.closest('.chat-message')?.id, 'conversation-turn-' + messageId);
  assert.equal(cancelled.querySelector('button, .spin'), null);
  assert.doesNotMatch(f.d.body.textContent!, /Generated late answer/);
});

test('CH1-03 sends a follow-up through the message queue and shows the real Steering relationship without a second progress row',
  {timeout: 30000}, async t => {
    const server = await taskSteeringFixture(t);
    const original = await server.start();
    server.setMode('hold-terminal');
    const f = await chatDom(t);
    const writes: {path: string; body: {clientRequestId: string}}[] = [];
    const api = injectedApi(server.node.app, server.headers, (path, init) => {
      if (init.method === 'POST') writes.push({path, body: JSON.parse(String(init.body))});
    });
    await f.render(api);
    await f.waitFor(() => f.d.querySelector('.assistant-task-result [data-message-kind="progress"][data-state="running"]'),
      'original task progress');
    await f.field('.chat-compose-form textarea', 'GENERATED-FORMAL-TASK-CORRECTION');
    assert.equal(f.element<HTMLButtonElement>('.send-button').disabled, false);
    await f.submit();
    assert.equal(writes.length, 1);
    assert.equal(writes[0].path, '/api/conversations/messages');
    await f.waitFor(() => server.node.conversations.messageByClientRequestId(writes[0].body.clientRequestId),
      'follow-up admission committed');
    const accepted = server.node.conversations.messageByClientRequestId(writes[0].body.clientRequestId)!;
    const receipt = await act(async () => await server.settle(accepted.id));
    assert.equal(receipt.taskSteering?.targetTaskId, original.taskId);
    assert.equal(receipt.taskSteering?.state, 'accepted');
    await f.waitFor(() => f.d.querySelector('#conversation-turn-' + receipt.id + ' .conversation-task-amendment'),
      'the host-projected supplement is visible');
    assert.equal(f.d.querySelector('#conversation-turn-' + receipt.id + ' [data-message-kind="progress"]'), null);
    assert.equal(server.rpc().filter(record => record.method === 'turn/steer').length, 1);
    assert.equal(f.d.querySelectorAll('.assistant-task-result').length, 1);
    assert.equal(f.d.querySelectorAll('[data-message-kind="progress"]').length, 1);
  });

test('CH1-04 the calendar card uses the Action receipt time and connector name, and retries a failed read', {timeout: 30000}, async t => {
  const server = await currentOwnerCalendarFixture(t);
  const accepted = await server.post();
  const message = await server.settled(accepted.message.id);
  const id = message.result?.currentAction?.id;
  assert.ok(id);
  const f = await chatDom(t);
  await f.waitFor(() => server.node.actions.get(id).status === 'succeeded', 'durable successful write outcome');
  const actionPath = '/api/actions/' + id;
  const receipt = await server.api('GET', actionPath);
  assert.equal(receipt.statusCode, 200, receipt.body);
  const {target} = receipt.json<ActionProposal>();
  assert.ok(isCentralConnectorActionTarget(target));
  assert.equal(target.calendarId, undefined);

  const releaseInventory = gate();
  t.after(releaseInventory.release);
  let actionReads = 0;
  const writes: string[] = [];
  const central = injectedApi(server.node.app, server.headers, (path, init) => {
    if (init.method === 'POST') writes.push(path);
  });
  await f.render({...central, request: async <T>(path: string, init?: RequestInit) => {
    if (path === actionPath && ++actionReads === 1) throw new ApiError('Generated action read failure', 503);
    if (path === '/api/actions') await releaseInventory.promise;
    return central.request<T>(path, init);
  }});
  const failedReceipt = '[data-message-kind="calendar"][data-state="read-failed"][role="alert"]';
  await f.waitFor(() => f.d.querySelector(failedReceipt), 'failed calendar receipt read');
  assert.equal(f.d.querySelector('.chat-answer'), null);
  await f.click(failedReceipt + ' button');
  const selector = '[data-action-id="' + id + '"][data-state="succeeded"]';
  await f.waitFor(() => f.d.querySelector(selector), 'successful calendar receipt');
  const card = f.element(selector);
  assert.match(card.textContent!, /15:00.*16:00/);
  assert.equal(card.querySelector('[role="status"]')?.textContent, '已创建');
  assert.ok(!card.textContent!.includes(target.instanceId), 'the connector ID stays hidden while its name is loading');
  releaseInventory.release();
  await f.waitFor(() => card.textContent?.includes('Generated owner calendar'), 'calendar name from the Action list');
  assert.equal(card.querySelector('a')?.getAttribute('href'), pageHash('actions', {action: id}));
  assert.equal(actionReads, 2);
  assert.deepEqual(writes, []);
  assert.equal(server.calls.length, 1);
});

test('CH1-04 a lost connector receipt shows the exact event for verification', {timeout: 30000}, async t => {
  const server = await currentOwnerCalendarFixture(t);
  server.dropReceipt();
  const accepted = await server.post();
  const message = await server.settled(accepted.message.id);
  const id = message.result?.currentAction?.id;
  assert.ok(id);
  const f = await chatDom(t);
  await f.waitFor(() => server.node.actions.get(id).status === 'uncertain', 'durable unknown write outcome');
  const writes: string[] = [];
  await f.render(injectedApi(server.node.app, server.headers, (path, init) => {
    if (init.method === 'POST') writes.push(path);
  }));
  const selector = '[data-action-id="' + id + '"][data-state="uncertain"]';
  await f.waitFor(() => f.d.querySelector(selector), 'uncertain calendar receipt');
  const card = f.element(selector);
  assert.ok(card.querySelector('[role="alert"]'));
  assert.equal(card.querySelector('button'), null);
  assert.equal(card.querySelector('a')?.getAttribute('href'), pageHash('actions', {action: id}));
  assert.deepEqual(writes, []);
  assert.equal(server.calls.length, 1);
  assert.equal(server.effects.size, 1, 'the appointment may already exist after a lost receipt');
});

test('CH1-06 archive upload precedes message admission and the saved message reads its thumbnail', {timeout: 30000}, async t => {
  const server = await currentInstructionFixture(t, () => ({answer: 'Generated archived image reply', citationIds: []}));
  const f = await chatDom(t);
  const calls: {path: string; body?: string}[] = [];
  const api = injectedApi(server.node.app, server.headers, (path, init) => {
    calls.push({path, body: typeof init.body === 'string' ? init.body : undefined});
  });
  await f.render(api);
  await f.waitFor(() => f.d.querySelector('.chat-page[aria-busy="false"]'), 'open generated conversation');
  const image = await sharp({create: {width: 3, height: 3, channels: 3, background: '#224466'}}).png().toBuffer();
  const file = new File([image], 'generated-review.png', {type: 'image/png', lastModified: Date.parse(at)});
  const picker = f.element<HTMLInputElement>('input[type="file"]');
  async function select(files: File[]) {
    await act(async () => {
      Object.defineProperty(picker, 'files', {value: files, configurable: true});
      picker.dispatchEvent(new f.w.Event('change', {bubbles: true}));
    });
  }
  await select([file, file, file, file, file]);
  assert.equal(calls.some(call => call.path.includes('file-sync')), false);
  assert.equal(f.d.querySelector('.chat-error')?.getAttribute('role'), 'alert');
  await select([file]);
  await f.waitFor(() => f.d.querySelector('.chat-attachment-list .chat-attachment:not(.chat-image-upload)'),
    'durable archive acknowledgement');
  await f.field('.chat-compose-form textarea', 'Generated message with an image');
  await f.submit();
  const uploaded = calls.findIndex(call => call.path.endsWith('/commit'));
  const sent = calls.findIndex(call => call.path === '/api/conversations/messages');
  assert.ok(uploaded >= 0 && uploaded < sent);
  const [attachmentId] = JSON.parse(calls[sent].body!).attachmentIds;
  await act(async () => {
    const archive = await server.api('GET', '/api/files?mimePrefix=image%2F');
    assert.equal(archive.statusCode, 200, archive.body);
    assert.equal(archive.json().items.filter((item: {captureId: string}) => item.captureId === attachmentId).length, 1);
  });
  await f.waitFor(() => f.d.querySelector('.conversation-turn .chat-attachment-preview img'), 'authorized conversation image');
  assert.ok(calls.some(call => call.path === '/api/files/' + attachmentId + '/thumbnail'));
  await f.click('.conversation-turn .chat-attachment-preview');
  assert.deepEqual(f.opened, ['capture:' + attachmentId]);
});

const cite = '10000000-0000-4000-8000-000000000005';
const answer: Answer = {answer: 'Generated answer with one original [' + cite + ']', runId: 'generated-answer',
  citations: [{id: cite, appName: 'Generated original', capturedAt: at, excerpt: 'Generated source excerpt'}], trace: []};
const replied = {id: turnId, question: 'Generated owner question', createdAt: at, status: 'completed', result: answer};

test('CH1-09 numbered citations check availability and their exact message before opening the original', async t => {
  const f = await chatDom(t);
  let available = false;
  const reads: string[] = [];
  const api = generatedApi(path => {
    reads.push(path);
    if (path.endsWith('/main')) return {id: chatId};
    if (path.includes('/references/')) return {id: cite, available};
    assert.equal(path, chatPath());
    return {id: chatId, scope: {}, revision: 1, turns: [replied]};
  });
  await f.render(api);
  assert.equal(f.element('.inline-citation').textContent, '1');
  await f.click('.inline-citation');
  assert.equal(f.opened.length, 0);
  await f.click('[role="dialog"] header button');
  available = true;
  await f.click('.inline-citation');
  assert.deepEqual(reads.slice(-2), [chatPath() + '/references/' + cite, chatPath()]);
  assert.deepEqual(f.opened, ['capture:' + cite]);
});

test('CH1-10 copies the answer and saves the original and owner addition separately from More', async t => {
  const f = await chatDom(t);
  const copies: string[] = [], notes: Record<string, any>[] = [];
  const clipboard = Object.getOwnPropertyDescriptor(navigator, 'clipboard');
  Object.defineProperty(navigator, 'clipboard', {configurable: true, value: {writeText: async (text: string) => {copies.push(text);}}});
  t.after(() => clipboard ? Object.defineProperty(navigator, 'clipboard', clipboard) : Reflect.deleteProperty(navigator, 'clipboard'));
  const api = generatedApi((path, init) => {
    if (path.endsWith('/main')) return {id: chatId};
    if (path === '/api/notes') {
      const note = JSON.parse(String(init.body));
      notes.push(note);
      return {id: note.id};
    }
    assert.equal(path, chatPath());
    return {id: chatId, scope: {}, revision: 1, turns: [replied]};
  });
  await f.render(api);
  await f.click('.chat-answer-actions > button');
  assert.deepEqual(copies, [answer.answer]);
  assert.equal(f.element('.chat-answer-actions [role="status"]').textContent, '已复制');
  assert.equal(f.element<HTMLDetailsElement>('.chat-answer-more').open, false);
  await f.click('.chat-answer-more summary');
  await f.click('.chat-answer-menu .save-conversation-record button');
  const panel = f.element('[role="dialog"]');
  assert.ok(panel.querySelector('.quoted-citation'));
  assert.equal(panel.querySelector('.conversation-save-origin .inline-citation'), null);
  await f.field('.conversation-save textarea', 'Generated owner addition');
  await f.click('[role="dialog"] footer button[type="submit"]');
  assert.equal(notes.length, 1);
  assert.equal(notes[0].text, 'Generated owner addition');
  assert.deepEqual(notes[0].metadata.noteOrigin, {
    kind: 'conversation', text: replied.question + '\n\n' + answer.answer, conversationId: chatId, messageIds: [turnId],
  });
});

test('CH1-01 current recording responses carry only answer text and do not supply a receipt type', {timeout: 30000}, async t => {
  const acknowledgement = '记下了，跑了 5 公里。';
  const server = await currentInstructionFixture(t, () => ({answer: acknowledgement, citationIds: [], draft: null}));
  const sent = await server.post('跑了 5 公里');
  const message = await server.settled(sent.message.id);
  assert.equal(message.status, 'completed');
  assert.equal(message.result?.answer, acknowledgement);
  assert.equal(message.result?.draft, undefined);
  assert.equal(message.result?.currentAction, undefined);
  const f = await chatDom(t);
  await f.render(injectedApi(server.node.app, server.headers));
  await f.waitFor(() => f.d.querySelector('.chat-answer .markdown'), 'ordinary server answer');
  assert.equal(f.element('.chat-answer .markdown').textContent, acknowledgement);
});

test('invalidated answers and their controls are withdrawn', async t => {
  const f = await chatDom(t);
  let stale = false;
  const api = generatedApi(path => {
    if (path.endsWith('/main')) return {id: chatId};
    return {id: chatId, scope: {}, revision: stale ? 2 : 1, turns: [{...replied, evidenceDeleted: stale}]};
  });
  await f.render(api);
  assert.ok(f.d.querySelector('.chat-answer-actions'));
  stale = true;
  await act(async () => resources(api).invalidate(path => path === chatPath()));
  assert.ok(f.d.querySelector('[data-message-kind="stale"]'));
  assert.equal(f.d.querySelector('.chat-answer-actions, .chat-answer'), null);
});
