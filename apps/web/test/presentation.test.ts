import assert from 'node:assert/strict';
import test from 'node:test';
import React, { act, useEffect, useState } from 'react';
import { JSDOM } from 'jsdom';
import { UiPresentationHost, defaultUiLayout, linearUiTheme } from '@mote/shared';
import { PluginI18nRegistry } from '@mote/shared/plugin-i18n';
import { parseUiContribution } from '@mote/shared/plugin-ui';
import {webAppearance} from '../src/appearance';
import { PresentationSurface, WorkspaceShell, type WebShellProps, type WebShellRenderer } from '../src/presentation';

test('a real shell and theme replacement preserves the mounted draft, selection, focus and lifecycle', async t => {
  const dom = new JSDOM('<div id="root"></div>', { url: 'http://localhost/#/library?sourceId=fixture&evidence=generated' });
  const previous = new Map<string, PropertyDescriptor | undefined>();
  for (const [key, value] of Object.entries({ window: dom.window, document: dom.window.document, HTMLElement: dom.window.HTMLElement, IS_REACT_ACT_ENVIRONMENT: true })) {
    previous.set(key, Object.getOwnPropertyDescriptor(globalThis, key)); Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
  }
  dom.window.scrollTo = () => {};
  const { createRoot } = await import('react-dom/client'), root = createRoot(dom.window.document.getElementById('root')!);
  const host = new UiPresentationHost<WebShellRenderer>({ theme: linearUiTheme, layout: { ...defaultUiLayout, implementation: WorkspaceShell } });
  let starts = 0, stops = 0;
  function Draft() {
    const [text, setText] = useState('Generated unsaved draft');
    useEffect(() => { starts++; return () => { stops++; }; }, []);
    return React.createElement('textarea', { value: text, onChange: event => setText(event.target.value), 'aria-label': 'Generated draft' });
  }
  function OtherShell({ navigation, toolbar, content, footer }: WebShellProps) {
    return React.createElement('section', { 'data-replacement-shell': true }, toolbar, navigation, React.createElement('article', null, content), footer);
  }
  const theme = { ...linearUiTheme, id: 'fixture.alternate', schemes:undefined, tokens: { ...linearUiTheme.tokens, accent: '#abcdef' } };
  const removeTheme = host.registerTheme(theme), removeLayout = host.registerLayout({ ...defaultUiLayout, id: 'fixture.top', navigation: 'top', detail: 'stack', implementation: OtherShell });
  t.after(async () => { await act(async () => root.unmount()); removeLayout(); removeTheme(); for (const [key, value] of previous) { if (value) Object.defineProperty(globalThis, key, value); else Reflect.deleteProperty(globalThis, key); } dom.window.close(); });
  await act(async () => root.render(React.createElement(PresentationSurface, { host, navigation: () => 'Generated navigation', toolbar: 'Generated toolbar', footer: 'Generated footer' }, React.createElement(Draft))));
  const field = dom.window.document.querySelector('textarea')!;
  field.focus(); field.setSelectionRange(4, 12); const hash = dom.window.location.hash;
  for(const preference of ['dark','light','auto'] as const){
    await act(async()=>webAppearance.select(preference));
    assert.equal(dom.window.document.querySelector('textarea'),field);assert.equal(field.selectionStart,4);assert.equal(dom.window.document.activeElement,field);assert.equal(dom.window.location.hash,hash);assert.equal(starts,1);assert.equal(stops,0);
  }
  await act(async () => host.activate({ theme, layout: { id: 'fixture.top', version: '1' } }));
  assert.ok(dom.window.document.querySelector('[data-replacement-shell] article textarea'));
  assert.equal(dom.window.document.querySelector('textarea'), field, 'the draft subtree is moved rather than reconstructed');
  assert.equal(field.value, 'Generated unsaved draft'); assert.equal(field.selectionStart, 4); assert.equal(field.selectionEnd, 12);
  assert.equal(dom.window.document.activeElement, field); assert.equal(dom.window.location.hash, hash);
  assert.equal(dom.window.document.documentElement.style.getPropertyValue('--mote-accent'), '#abcdef');
  assert.equal(starts, 1); assert.equal(stops, 0, 'presentation never cancels the mounted work');
  await act(async () => removeLayout());
  assert.ok(dom.window.document.querySelector('.app-shell textarea')); assert.equal(dom.window.document.querySelector('textarea'), field);
  await act(async () => removeTheme());
  assert.equal(dom.window.document.documentElement.style.getPropertyValue('--mote-accent'), linearUiTheme.schemes!.light.accent);
  assert.throws(() => host.activate({ theme: { id: 'missing.theme', version: '1' }, layout: defaultUiLayout }), /unavailable/);
  assert.equal(dom.window.document.querySelector('textarea'), field); assert.equal(stops, 0);
});

test('contributed presentation labels reach the shell and the removal notice', async t => {
  const dom = new JSDOM('<div id="root"></div>', { url: 'http://localhost/' });
  const previous = new Map<string, PropertyDescriptor | undefined>();
  for (const [key, value] of Object.entries({ window: dom.window, document: dom.window.document, HTMLElement: dom.window.HTMLElement, IS_REACT_ACT_ENVIRONMENT: true })) {
    previous.set(key, Object.getOwnPropertyDescriptor(globalThis, key)); Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
  }
  dom.window.scrollTo = () => {};
  const { createRoot } = await import('react-dom/client'), root = createRoot(dom.window.document.getElementById('root')!);
  const host = new UiPresentationHost<WebShellRenderer>({ theme: linearUiTheme, layout: { ...defaultUiLayout, implementation: WorkspaceShell } });
  const catalogs = new PluginI18nRegistry();
  catalogs.register('fixture.plugin', 'en', { 'theme.name': 'Studio' });
  const facts = { requirementsAvailable: true, registeredNativeCapabilities: new Set<string>() };
  const theme = { ...linearUiTheme, id: 'fixture.theme', version: '1' };
  const contribution = {
    packageId: 'fixture.pkg',
    descriptor: parseUiContribution({
      id: 'fixture.theme', kind: 'theme', apiVersion: '1', platforms: ['web'],
      presentation: { labelKey: 'theme.name', i18nNamespace: 'fixture.plugin' },
    }),
  };
  const removeTheme = host.registerContribution(contribution, { id: 'fixture.theme', version: '1' }, theme, catalogs, 'web', facts, 'en');
  t.after(async () => {
    await act(async () => root.unmount());
    removeTheme();
    for (const [key, value] of previous) { if (value) Object.defineProperty(globalThis, key, value); else Reflect.deleteProperty(globalThis, key); }
    dom.window.close();
  });
  await act(async () => root.render(React.createElement(PresentationSurface, { host, navigation: () => 'Generated navigation', toolbar: 'Generated toolbar', footer: 'Generated footer' }, React.createElement('p', null, 'Generated content'))));
  await act(async () => host.activate({ theme, layout: defaultUiLayout }));
  assert.equal(dom.window.document.documentElement.dataset.uiThemeLabel, 'Studio');
  await act(async () => removeTheme());
  assert.equal(dom.window.document.documentElement.dataset.uiThemeLabel, undefined);
  assert.match(dom.window.document.querySelector('.presentation-notice')?.textContent ?? '', /Studio/);
});
