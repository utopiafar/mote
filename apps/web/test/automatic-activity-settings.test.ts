import test from 'node:test';
import assert from 'node:assert/strict';
import React, {act} from 'react';
import {JSDOM} from 'jsdom';
import {configureLocale} from '@mote/shared/i18n';
import type {Api} from '../src/api.js';
import {resources} from '../src/resource-cache.js';
configureLocale(() => 'zh-CN');
const dom = new JSDOM('<!doctype html><html><body></body></html>', {url: 'http://localhost/'});
Object.assign(globalThis, {window: dom.window, document: dom.window.document, HTMLElement: dom.window.HTMLElement, IS_REACT_ACT_ENVIRONMENT: true});
const {createRoot} = await import('react-dom/client');
const {AutomaticActivitySettings} = await import('../src/plugins/models-processing/AutomaticActivitySettings.js');
const tick = () => new Promise(resolve => setTimeout(resolve, 10));
const path = '/api/processing/activity';
const view = (revision = 1, enabled = false, modelProfileId: string | null = null) => ({revision, settings: {enabled, modelProfileId}, configured: !!modelProfileId, counts: {waiting: 2, running: 0, blocked: 0, failed: 0, succeeded: 3}});
async function setup(t: any) {
  let state = view(), fail = false, hold: ((value: unknown) => void) | undefined;
  const calls: {path: string; init?: RequestInit}[] = [];
  const api = {request: async (requestPath: string, init?: RequestInit) => {
    calls.push({path: requestPath, init});
    if (requestPath === '/api/model-settings') return {profiles: [{id: 'generated-profile', name: 'Generated model'}]};
    if (init?.method === 'PUT') {
      if (fail) throw Error('generated write failure');
      const body = JSON.parse(String(init.body));
      state = {...state, revision: state.revision + 1, settings: body.settings};
      if (hold) return new Promise(resolve => {hold = resolve;});
    }
    return structuredClone(state);
  }} as unknown as Api;
  const container = document.createElement('div'); document.body.appendChild(container);
  const root = createRoot(container);
  const render = async (current: Api = api) => {await act(async () => {root.render(React.createElement(AutomaticActivitySettings, {api: current})); await tick();});};
  await render();
  t.after(async () => {await act(async () => root.unmount()); container.remove();});
  return {api, container, render, calls, set state(value: typeof state) {state = value;}, set fail(value: boolean) {fail = value;}, holdSave() {hold = () => {};}, resolveSave(value: unknown) {hold?.(value);}};
}
async function choose(container: HTMLElement) {await act(async () => {const select = container.querySelector('select')!; select.value = 'generated-profile'; select.dispatchEvent(new dom.window.Event('change', {bubbles: true})); await tick();});}
async function toggle(container: HTMLElement) {await act(async () => {container.querySelector<HTMLInputElement>('input[type=checkbox]')!.click(); await tick();});}
const save = (container: HTMLElement) => [...container.querySelectorAll('button')].find(button => button.textContent === '保存并应用')!;
async function submit(container: HTMLElement) {await act(async () => {save(container).click(); await tick();});}

test('owner explicitly selects a model and enables activity without changing Memory; read refresh preserves draft', async t => {
  const fixture = await setup(t);
  assert.match(fixture.container.textContent!, /自动记忆可单独开启或暂停/);
  await toggle(fixture.container); assert.equal(save(fixture.container).disabled, true);
  await choose(fixture.container);
  fixture.state = view(2);
  await act(async () => {resources(fixture.api).invalidate(key => key === path); await tick();});
  assert.equal(fixture.container.querySelector<HTMLInputElement>('input')!.checked, true);
  assert.equal(fixture.container.querySelector('select')!.value, 'generated-profile');
  await submit(fixture.container);
  assert.deepEqual(JSON.parse(String(fixture.calls.find(call => call.init?.method === 'PUT')?.init?.body)), {revision: 1, settings: {enabled: true, modelProfileId: 'generated-profile'}});
  assert.ok(fixture.calls.every(call => !call.path.includes('memory')));
  assert.match(fixture.container.textContent!, /已保存，立即生效/);
});

test('failed save retains explicit draft and a late save from the previous server cannot overwrite the new server', async t => {
  const fixture = await setup(t); await choose(fixture.container); await toggle(fixture.container);
  fixture.fail = true; await submit(fixture.container);
  assert.match(fixture.container.textContent!, /generated write failure/);
  assert.equal(fixture.container.querySelector<HTMLInputElement>('input')!.checked, true);
  fixture.fail = false; fixture.holdSave(); await submit(fixture.container);
  const secondApi = {request: async (requestPath: string) => requestPath === '/api/model-settings' ? {profiles: []} : view(8)} as unknown as Api;
  await fixture.render(secondApi);
  await act(async () => {fixture.resolveSave(view(3, true, 'generated-profile')); await tick();});
  assert.equal(fixture.container.querySelector<HTMLInputElement>('input')!.checked, false);
  assert.equal(fixture.container.querySelector('select')!.value, '');
  assert.doesNotMatch(fixture.container.textContent!, /已保存，立即生效/);
});
