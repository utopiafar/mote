import assert from 'node:assert/strict';
import test from 'node:test';
import React, {act} from 'react';
import {pageHash} from '@mote/shared';
import {ApiError} from '../src/api';
import {resources} from '../src/resource-cache';
import {at, chatDom, chatId, chatPath, generatedApi, turnId} from './fixtures/chat-dom';

test('CH1-07 opens the current main conversation and leaves an empty thread above the composer', async t => {
  const other = '10000000-0000-4000-8000-000000000003';
  const f = await chatDom(t, pageHash('chat', {conversation: other, turn: turnId}));
  const requests: string[] = [];
  const api = generatedApi(path => {
    requests.push(path);
    if (path.endsWith('/main')) return {id: chatId};
    if (path === chatPath() + '/assistant-tasks') return {items: []};
    assert.equal(path, chatPath());
    return {id: chatId, scope: {}, revision: 1, turns: []};
  });
  await f.render(api);
  assert.deepEqual(requests, ['/api/conversations/main', chatPath(), chatPath() + '/assistant-tasks']);
  assert.equal(f.d.querySelector('.conversation-history, .new-conversation-button, .conversation-turn'), null);
  assert.equal(f.d.querySelector('.chat-thread')?.children.length, 0);
  assert.ok(f.d.querySelector('form.ask-form textarea'));
});

test('CH1-05 searches older pages of the main conversation and selects, scrolls and focuses the matching turn', async t => {
  const f = await chatDom(t);
  const original = '10000000-0000-4000-8000-000000000003';
  const withdrawn = '10000000-0000-4000-8000-000000000004';
  const query = '冷杉';
  const requests: string[] = [];
  const base = {id: chatId, scope: {}, revision: 3};
  const api = generatedApi(path => {
    requests.push(path);
    if (path.endsWith('/main')) return {id: chatId};
    if (path === chatPath()) return {...base, nextCursor: '20', turns: [
      {id: turnId, status: 'completed', question: '生成的近期消息', createdAt: at},
    ]};
    if (path === chatPath() + '?cursor=20') return {...base, nextCursor: null, turns: [
      {id: original, status: 'completed', question: '三周前的冷杉步道记录', createdAt: '2026-10-30T01:00:00.000Z'},
      {id: withdrawn, status: 'completed', question: '另一条生成消息', createdAt: at, evidenceStale: true,
        result: {answer: '已失效的冷杉内容', citations: [], trace: [], runId: 'withdrawn'}},
    ]};
    assert.fail('Unexpected fixture read ' + path);
  });
  await f.render(api);
  await f.click('.chat-search-toggle');
  await f.field('.chat-search-form input', query);
  await f.click('.chat-search-form button');
  assert.equal(requests.filter(path => path.includes('cursor=')).length, 1);
  assert.equal(f.d.querySelectorAll('.chat-search-hits button').length, 1);
  await f.click('.chat-search-hits button');
  const target = f.element('#conversation-turn-' + original);
  assert.equal(target.getAttribute('data-source-turn'), 'true');
  assert.equal(f.d.activeElement, target);
  assert.ok(f.scrolls.includes(target.id));
  assert.equal(f.d.querySelector('#conversation-turn-' + withdrawn + ' [data-message-kind="stale"]')?.getAttribute('role'), 'status');
  assert.doesNotMatch(f.d.body.textContent!, /已失效的冷杉内容/);
});

test('CH1-05 a newer history revision withholds old search text and the cached head during revalidation', async t => {
  const f = await chatDom(t);
  let checked = false;
  let release!: () => void;
  const confirmed = new Promise<void>(resolve => {release = resolve;});
  const original = {id: turnId, status: 'completed', question: '生成的历史问题', createdAt: at,
    result: {answer: 'Generated withdrawn answer', citations: [], trace: [], runId: 'withdrawn'}};
  const api = generatedApi(async path => {
    if (path.endsWith('/main')) return {id: chatId};
    if (path.includes('cursor=')) {
      checked = true;
      return {id: chatId, scope: {}, revision: 2, turns: [original]};
    }
    if (checked) await confirmed;
    return {id: chatId, scope: {}, revision: checked ? 2 : 1, nextCursor: checked ? null : '5',
      turns: [checked ? {...original, evidenceDeleted: true} : original]};
  });
  await f.render(api);
  assert.ok(f.d.querySelector('.chat-answer'));
  await f.click('.chat-search-toggle');
  await f.field('.chat-search-form input', 'withdrawn');
  await f.click('.chat-search-form button');
  assert.equal(f.d.querySelector('.chat-search-hits'), null);
  assert.equal(f.d.querySelector('.chat-answer'), null);
  await act(async () => release());
  assert.ok(f.d.querySelector('[data-message-kind="stale"]'));
});

test('CH1-11 shows a retry on an offline main read and recovers the same page', async t => {
  const f = await chatDom(t);
  let offline = true;
  const reads: string[] = [];
  const api = generatedApi(path => {
    reads.push(path);
    if (offline) throw new TypeError('Generated offline');
    if (path.endsWith('/main')) return {id: chatId};
    if (path === chatPath() + '/assistant-tasks') return {items: []};
    return {id: chatId, scope: {}, revision: 1,
      turns: [{id: turnId, status: 'completed', question: 'Generated persisted message', createdAt: at}]};
  });
  await f.render(api);
  assert.equal(f.d.querySelector('.chat-error')?.getAttribute('role'), 'alert');
  assert.match(f.d.querySelector('.chat-error')!.textContent!, /没连上/);
  assert.equal(f.element<HTMLButtonElement>('.send-button').disabled, true);
  offline = false;
  await f.click('.chat-error button');
  assert.deepEqual(reads, ['/api/conversations/main', '/api/conversations/main', chatPath(), chatPath() + '/assistant-tasks']);
  assert.ok(f.d.querySelector('.conversation-turn[data-state="completed"]'));
  assert.equal(f.d.querySelector('.chat-error'), null);
});

test('CH1-11 a lost admission retries the same message and keeps a later draft', async t => {
  const f = await chatDom(t);
  const attempts: string[] = [];
  let online = false;
  const api = generatedApi((path, init) => {
    if (path.endsWith('/main')) return {id: chatId};
    if (path === chatPath()) return {id: chatId, scope: {}, revision: 1, turns: []};
    assert.equal(path, '/api/conversations/messages');
    attempts.push(String(init.body));
    if (!online) throw new TypeError('Generated lost acknowledgement');
    const input = JSON.parse(String(init.body));
    return {...input, id: turnId, seq: 1, createdAt: at, status: 'accepted'};
  });
  await f.render(api);
  await f.field('.chat-compose-form textarea', 'Generated message with a lost acknowledgement');
  await f.submit();
  assert.equal(attempts.length, 2);
  assert.equal(f.d.querySelector('.chat-error')?.getAttribute('role'), 'alert');
  await f.field('.chat-compose-form textarea', 'Generated later unsent draft');
  online = true;
  await f.click('.chat-error button');
  assert.deepEqual(attempts, [attempts[0], attempts[0], attempts[0]]);
  assert.equal(f.element<HTMLTextAreaElement>('.chat-compose-form textarea').value, 'Generated later unsent draft');
  assert.equal(f.d.querySelector('.chat-error'), null);
});

test('an unavailable main conversation withdraws old messages and can refresh the main identity', async t => {
  const f = await chatDom(t);
  let revoked = false;
  const newId = '10000000-0000-4000-8000-000000000005';
  const api = generatedApi(path => {
    if (path.endsWith('/main')) return {id: revoked ? newId : chatId};
    if (path === chatPath(newId)) return {id: newId, scope: {}, revision: 1, turns: []};
    if (revoked) throw new ApiError('Generated missing conversation', 404);
    return {id: chatId, scope: {}, revision: 1, turns: [{id: turnId, status: 'running', question: 'Generated revoked message', createdAt: at}]};
  });
  await f.render(api);
  assert.ok(f.d.querySelector('.chat-message'));
  revoked = true;
  await act(async () => resources(api).invalidate(path => path === chatPath()));
  assert.equal(f.d.querySelector('.chat-message'), null);
  await f.click('.chat-error button');
  assert.equal(f.d.querySelector('.chat-message, .chat-error'), null);
});
