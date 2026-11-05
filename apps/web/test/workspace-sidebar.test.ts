import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { JSDOM } from 'jsdom';
import { desktopUiLayout, uiDestinationPresentation } from '@mote/shared';
import { configureLocale } from '@mote/shared/i18n';
import { WorkspaceSidebar } from '../src/WorkspaceSidebar';
import { webPresentation } from '../src/presentation';

function render(page: string) {
  const markup = renderToStaticMarkup(React.createElement(WorkspaceSidebar, {
    layout: desktopUiLayout, page, onPage: () => {}, connection: null, verified: false, onConnect: () => {},
  }));
  return new JSDOM(markup).window.document;
}

test('web and Mac share the desktop primary and lower navigation destinations', () => {
  assert.equal(webPresentation.getSnapshot().layout.id, desktopUiLayout.id);
  assert.deepEqual(webPresentation.getSnapshot().layout.primary, ['home', 'library', 'sources', 'ask']);
  assert.deepEqual(webPresentation.getSnapshot().layout.secondary, ['connections', 'activity']);
});

test('the sidebar keeps four primary text labels and moves AI access and activity to the bottom', () => {
  configureLocale(() => 'zh-CN');
  const document = render('sources');
  const primary = Array.from(document.querySelectorAll('#primary-navigation > nav button'));
  assert.deepEqual(primary.map(button => button.textContent), ['首页', '资料库', '来源', '问一问']);
  assert.deepEqual(primary.map(button => button.querySelector('svg') !== null), [true, true, true, true]);
  assert.equal(document.querySelector('.nav-glyph'), null);
  assert.equal(primary.find(button => button.getAttribute('aria-current') === 'page')?.textContent, '来源');

  const lower = Array.from(document.querySelectorAll('.sidebar-bottom > button'));
  assert.deepEqual(lower.map(button => button.textContent), ['AI 接入', '活动', '设置']);
  assert.deepEqual(lower.map(button => button.querySelector('svg') !== null), [true, true, true]);
  assert.equal(lower[0].className, 'utility-nav');
  assert.equal(lower[1].className, 'utility-nav');
  assert.match(lower[0].innerHTML, /lucide-bot/);
  assert.match(lower[1].innerHTML, /lucide-chart-no-axes-column/);
});

test('AI access and activity report their own selected state in the lower region', () => {
  configureLocale(() => 'zh-CN');
  for (const [page, label] of [['connections', 'AI 接入'], ['activity', '活动']] as const) {
    const document = render(page);
    const active = Array.from(document.querySelectorAll('.sidebar-bottom > button'))
      .filter(button => button.getAttribute('aria-current') === 'page');
    assert.deepEqual(active.map(button => button.textContent), [label]);
    assert.equal(document.querySelector('#primary-navigation > nav [aria-current=page]'), null);
    assert.equal(uiDestinationPresentation[page === 'connections' ? 'connections' : 'activity'].label, label);
  }
});
