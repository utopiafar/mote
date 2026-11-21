import assert from 'node:assert/strict';
import type {TestContext} from 'node:test';
import React, {act} from 'react';
import {createRoot} from 'react-dom/client';
import {JSDOM} from 'jsdom';
import {pageHash} from '@mote/shared';
import {configureLocale} from '@mote/shared/i18n';
import {ApiError, type Api} from '../../src/api';
import {Conversations} from '../../src/plugins/ask/Conversations';
import {AnswerView} from '../../src/shell-components';

configureLocale(() => 'zh-CN');

export const at = '2026-11-20T01:00:00.000Z';
export const chatId = '10000000-0000-4000-8000-000000000001';
export const turnId = '10000000-0000-4000-8000-000000000002';
export const chatPath = (id = chatId) => '/api/conversations/' + id;

export async function chatDom(t: TestContext, hash = pageHash('chat')) {
  const dom = new JSDOM('<div id="root"></div>', {url: 'http://localhost/' + hash, pretendToBeVisual: true});
  const d = dom.window.document;
  const globals = new Map<string, PropertyDescriptor | undefined>();
  for (const [key, value] of Object.entries({window: dom.window, document: d, HTMLElement: dom.window.HTMLElement,
    localStorage: dom.window.localStorage, IS_REACT_ACT_ENVIRONMENT: true})) {
    globals.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, {value, writable: true, configurable: true});
  }
  const scrolls: string[] = [];
  Object.assign(dom.window.HTMLElement.prototype, {
    attachEvent() {}, detachEvent() {},
    scrollIntoView(this: HTMLElement) {scrolls.push(this.id);},
  });
  const root = createRoot(d.querySelector('#root')!);
  t.after(async () => {
    await act(async () => root.unmount());
    for (const [key, value] of globals) {
      if (value) Object.defineProperty(globalThis, key, value);
      else Reflect.deleteProperty(globalThis, key);
    }
    dom.window.close();
  });

  function element<T extends HTMLElement>(selector: string): T {
    const value = d.querySelector<T>(selector);
    assert.ok(value, selector);
    return value;
  }
  const opened: string[] = [];
  const render = (api: Api) => act(async () => root.render(React.createElement(Conversations, {
    api, configured: true, devices: [], onOpen: ref => opened.push(ref),
    renderAnswer: (answer, onOpen) => React.createElement(AnswerView, {answer, onOpen, compact: true}),
  })));
  const click = (selector: string) => act(async () => element(selector).click());
  async function field(selector: string, value: string) {
    const input = element<HTMLInputElement | HTMLTextAreaElement>(selector);
    const type = input.tagName === 'TEXTAREA' ? dom.window.HTMLTextAreaElement : dom.window.HTMLInputElement;
    await act(async () => {
      input.focus();
      Object.getOwnPropertyDescriptor(type.prototype, 'value')!.set!.call(input, value);
      input.dispatchEvent(new dom.window.Event('input', {bubbles: true}));
      input.dispatchEvent(new dom.window.KeyboardEvent('keyup', {bubbles: true, key: 'a'}));
    });
  }
  async function submit() {
    await act(async () => element('form.ask-form').dispatchEvent(new dom.window.Event('submit', {bubbles: true, cancelable: true})));
  }
  async function waitFor(check: () => unknown, label: string) {
    const end = Date.now() + 8000;
    while (Date.now() < end) {
      if (check()) return;
      await act(async () => {await new Promise(resolve => setTimeout(resolve, 20));});
    }
    assert.fail(label);
  }
  return {d, w: dom.window, root, render, click, field, submit, waitFor, opened, scrolls, element};
}

export const changes = () => ({cursor: 1, ids: [], hasMore: false});

export function generatedApi(read: (path: string, init: RequestInit) => unknown): Api {
  return {request: async (path: string, init: RequestInit = {}) => {
    if (path.startsWith('/api/operations/changes?')) return changes();
    return read(path, init);
  }} as Api;
}

export function injectedApi(app: Awaited<ReturnType<typeof import('../../../server/src/app').buildApp>>['app'],
  authorization: Record<string, string>, observe: (path: string, init: RequestInit) => void = () => {}) {
  async function raw(path: string, init: RequestInit = {}) {
    init.signal?.throwIfAborted();
    observe(path, init);
    const headers = new Headers(init.headers);
    for (const [key, value] of Object.entries(authorization)) headers.set(key, value);
    const content = init.body;
    if (typeof content === 'string') headers.set('Content-Type', 'application/json');
    const body = content instanceof Blob ? Buffer.from(await content.arrayBuffer()) : content;
    const reply = await app.inject({
      url: path, method: (init.method ?? 'GET') as 'GET' | 'POST' | 'PUT',
      headers: Object.fromEntries(headers),
      ...(typeof body === 'string' || body instanceof ArrayBuffer || Buffer.isBuffer(body) ? {payload: Buffer.isBuffer(body) ? body : body instanceof ArrayBuffer ? Buffer.from(body) : body} : {}),
    });
    init.signal?.throwIfAborted();
    if (reply.statusCode >= 400) throw new ApiError(reply.body, reply.statusCode);
    return new Response(reply.rawPayload, {status: reply.statusCode, headers: reply.headers as Record<string, string>});
  }
  const request = async <T>(path: string, init?: RequestInit): Promise<T> => (await raw(path, init)).json() as Promise<T>;
  return {request, raw};
}
