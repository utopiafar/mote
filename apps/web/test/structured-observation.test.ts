import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import type {UiPage} from '@mote/shared';
import {StructuredObservation} from '../src/StructuredObservation';

test('structured evidence keeps named values, repeated text and source distinctions without rendering captured markup', () => {
  const page: UiPage = {version: 3, scope: 'visible_window', adapterId: 'generated', adapterVersion: '1', appVersion: '1.0', activity: '', status: 'partial', truncated: false, observations: {firstAt: '2026-10-24T00:00:00Z', lastAt: '2026-10-24T00:00:00Z', count: 1}, objects: [{kind: 'generated_message', fields: [{name: 'message_visible_body', values: [{text: '<script>generated</script>', source: 'text'}, {text: '<script>generated</script>', source: 'text'}]}, {name: 'message_description', values: [{text: 'Generated caption', source: 'description'}]}]}]};
  const html = renderToStaticMarkup(React.createElement(StructuredObservation, {page}));
  assert.match(html, /message visible body/);
  assert.equal((html.match(/&lt;script&gt;generated&lt;\/script&gt;/g) ?? []).length, 2);
  assert.match(html, /无障碍描述/); assert.match(html, /显示文字/);
  assert.match(html, /仅为观察时窗内的文字/); assert.ok(!html.includes('<script>'));
});
