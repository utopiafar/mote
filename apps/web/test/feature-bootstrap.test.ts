import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {webFeatures} from '../src/features/registry.js';
import type {Api} from '../src/api.js';

test('view imports leave the host empty until application bootstrap; repeated startup preserves registrations', async () => {
  const runtime = await import('../src/features/runtime.js');
  await import('../src/plugins/library/Archive.js');
  await import('../src/Materials.js');
  await import('../src/FeatureInventory.js');
  assert.deepEqual(webFeatures.registry.inventory().features, [], 'a detail helper must not start unrelated builtin features');
  assert.deepEqual(webFeatures.pages(), []);
  assert.deepEqual(webFeatures.collections(), []);
  const props = {api: {} as Api, onOpen: () => {}, value: {kind: 'mote.operation', schemaVersion: 1, representation: 'saved-record', ref: 'operation:generated', revision: 'generated-revision', title: '', text: 'Generated saved record'}};
  assert.equal(renderToStaticMarkup(React.createElement(runtime.FeaturePanels, props)), '');

  const bootstrap = await import('../src/features/bootstrap.js');
  await bootstrap.featuresReady;
  const inventory = webFeatures.registry.inventory();
  assert.ok(webFeatures.page('archive'));
  assert.ok(webFeatures.page('agentView'));
  assert.ok(webFeatures.collections().some(entry => entry.id === 'materials'));
  assert.ok(webFeatures.homes().some(entry => entry.id === 'agent-view'));
  assert.match(renderToStaticMarkup(React.createElement(runtime.FeaturePanels, props)), /Generated saved record/);
  assert.deepEqual(webFeatures.views('renderer', {kind: 'mote.message', schemaVersion: 1, representation: 'owner-material'}).map(entry => entry.id), ['source-item.message']);
  assert.ok(inventory.features.some(feature => feature.id === 'mote.owner-questions'));

  const repeated = await import('../src/features/bootstrap.js');
  assert.equal(repeated.featuresReady, bootstrap.featuresReady);
  await repeated.featuresReady;
  assert.deepEqual(webFeatures.registry.inventory(), inventory, 'repeated application imports must not duplicate or replace contributions');
});
