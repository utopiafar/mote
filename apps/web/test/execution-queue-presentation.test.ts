import test, {after} from 'node:test';
import assert from 'node:assert/strict';
import React, {act} from 'react';
import {JSDOM} from 'jsdom';
import {configureLocale} from '@mote/shared/i18n';
import type {Api} from '../src/api.js';
import {resources} from '../src/resource-cache.js';

// Generated telemetry only. This is a mounted component/resource lifecycle check.
const dom = new JSDOM('<html><body></body></html>', {url: 'http://localhost/'});
Object.assign(globalThis, {window: dom.window, document: dom.window.document,
  HTMLElement: dom.window.HTMLElement, IS_REACT_ACT_ENVIRONMENT: true});
configureLocale(() => 'zh-CN');
const {createRoot} = await import('react-dom/client');
const {ExecutionQueueOverview} = await import('../src/RuntimeSettings.js');
const tick = () => new Promise(resolve => setTimeout(resolve, 20));
after(() => dom.window.close());

test('queue summary preserves its Agent lane and a refresh failure remains visible outside closed details', async t => {
  const generated = {queues: {
    agents: {active: 3, waiting: 5, limit: 8},
    llm: {active: 9, waiting: 11, limit: 40},
    interactive: {active: 2, waiting: 7, limit: 4},
    interactiveHarness: {active: 13, waiting: 17, limit: 32},
    delegated: {background: {running: 19, waiting: 23, limit: 24}, interactive: {running: 29, waiting: 31, limit: 32}},
  }};
  let unavailable = false, calls = 0;
  const api = {request: async (path: string) => {
    assert.equal(path, '/api/execution-settings'); calls++;
    if (unavailable) throw Error('Generated queue refresh failed');
    return structuredClone(generated);
  }} as unknown as Api;
  const element = document.createElement('div'); document.body.appendChild(element);
  const root = createRoot(element);
  t.after(async () => { await act(async () => root.unmount()); element.remove(); });
  await act(async () => { root.render(React.createElement(ExecutionQueueOverview, {api})); await tick(); });
  assert.equal(calls, 1);
  const details = element.querySelector('details')!;
  const summary = details.querySelector('summary')!;
  assert.equal(details.open, false, 'Normal telemetry starts compact');
  assert.equal(summary.textContent, '执行队列后台 Agent：执行中 3 / 8，排队 5',
    'The summary represents the Agent lane, not Agent plus nested Harness activity');
  await act(async () => { summary.click(); await tick(); });
  assert.equal(details.open, true);
  const expanded = details.querySelector('p')!.textContent!;
  for (const lane of ['后台 Agent：执行中 3 / 8，排队 5', '后台 Harness：执行中 9 / 40，排队 11',
    '交互 Agent：执行中 2 / 4，排队 7', '交互 Harness：执行中 13 / 32，排队 17',
    '后台工作步骤：执行中 19 / 24，等待 23', '交互工作步骤：执行中 29 / 32，等待 31']) {
    assert.ok(expanded.includes(lane), 'Expanded telemetry retains its separate lane: ' + lane);
  }
  await act(async () => { summary.click(); await tick(); });
  assert.equal(details.open, false);
  unavailable = true;
  await act(async () => { resources(api).invalidate(path => path === '/api/execution-settings'); await tick(); });
  assert.equal(calls, 2);
  assert.deepEqual(resources(api).get('/api/execution-settings').getSnapshot().data, generated,
    'A transient read failure exercises the real cache that retains the last successful data');
  assert.equal(details.open, false, 'Refresh does not open the details');
  assert.equal(summary.textContent, '执行队列暂不可用', 'Stale telemetry is not presented as a current measurement');
  assert.equal(details.querySelector('p'), null, 'Expanded content cannot assert old counts during an error');
  const alert = element.querySelector('[role=alert]')!;
  assert.equal(alert.textContent, 'Generated queue refresh failed');
  assert.equal(alert.closest('details'), null, 'A closed details control cannot hide a refresh failure');
  unavailable = false; generated.queues.agents.active = 1; generated.queues.agents.waiting = 0;
  await act(async () => { resources(api).invalidate(path => path === '/api/execution-settings'); await tick(); });
  assert.equal(summary.textContent, '执行队列后台 Agent：执行中 1 / 8，排队 0');
  assert.equal(element.querySelector('[role=alert]'), null, 'A successful refresh clears the error');
  assert.equal(details.open, false);
});

test('a server with only mandatory queue telemetry does not invent optional execution lanes', async t => {
  const api = {request: async () => ({queues: {
    agents: {active: 0, waiting: 0, limit: 8}, llm: {active: 1, waiting: 2, limit: 4},
  }})} as unknown as Api;
  const element = document.createElement('div'); document.body.appendChild(element);
  const root = createRoot(element);
  t.after(async () => { await act(async () => root.unmount()); element.remove(); });
  await act(async () => { root.render(React.createElement(ExecutionQueueOverview, {api})); await tick(); });
  const details = element.querySelector('details')!;
  await act(async () => { details.querySelector('summary')!.click(); await tick(); });
  assert.equal(details.open, true);
  assert.match(details.textContent!, /后台 Agent：执行中 0 \/ 8，排队 0/);
  assert.match(details.textContent!, /后台 Harness：执行中 1 \/ 4，排队 2/);
  assert.doesNotMatch(details.textContent!, /交互 Agent|交互 Harness|工作步骤/);
});
