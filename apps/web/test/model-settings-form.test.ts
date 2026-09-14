import test from 'node:test';
import assert from 'node:assert/strict';
import type {ModelSettingsView} from '@mote/shared/models';
import {createModelDraft, modelDraftChanged, modelSettingsRequest, retainedCredentialsNeedConfirmation} from '../src/model-settings-form.js';

const snapshot: ModelSettingsView = {
  version: 1, revision: 3, source: 'saved',
  settings: {
    provider: 'custom', protocol: 'openai-completions', baseUrl: 'https://fixture.example/v1', model: 'generated-model',
    reasoningEffort: 'auto', maxTokens: 4096, timeoutMs: 120000, allowUnauthenticatedLocal: false,
    apiKeyConfigured: true, headersConfigured: true, extraBodyConfigured: true,
  },
};

test('model defaults carry no existing secrets and omitted operations preserve credentials', () => {
  const draft = createModelDraft(snapshot.settings), request = modelSettingsRequest(snapshot, draft);
  assert.equal(draft.apiKey, ''); assert.equal(draft.headers, ''); assert.equal(draft.extraBody, '');
  assert.equal(modelDraftChanged(draft, snapshot.settings), false);
  assert.equal(request.revision, 3);
  for (const secret of ['apiKey', 'headers', 'extraBody']) assert.equal(Object.hasOwn(request.settings, secret), false);
  assert.equal(Object.hasOwn(request, 'allowCredentialReuse'), false);
});

test('each credential field distinguishes replacing, preserving and clearing', () => {
  const draft = createModelDraft(snapshot.settings);
  const replaced = modelSettingsRequest(snapshot, {...draft, apiKeyAction: 'replace', apiKey: 'generated-key', headersAction: 'replace', headers: '{"X-Fixture":"generated-value"}', extraBodyAction: 'replace', extraBody: '{"temperature":0.7,"nested":{"value":"one\'s \\"quoted\\" text"}}'});
  assert.equal(replaced.settings.apiKey, 'generated-key');
  assert.deepEqual(replaced.settings.headers, {'X-Fixture': 'generated-value'});
  assert.equal(replaced.settings.extraBody?.temperature, 0.7);
  const cleared = modelSettingsRequest(snapshot, {...draft, apiKeyAction: 'clear', headersAction: 'clear', extraBodyAction: 'clear'});
  assert.equal(cleared.settings.apiKey, null); assert.equal(cleared.settings.headers, null); assert.equal(cleared.settings.extraBody, null);
});

test('changing a credential destination requires explicit reuse for every retained secret', () => {
  const draft = createModelDraft(snapshot.settings);
  for (const patch of [{provider: 'openai'}, {protocol: 'openai-responses' as const}, {baseUrl: 'https://other.fixture.example/v1'}]) {
    const changed = {...draft, ...patch};
    assert.equal(retainedCredentialsNeedConfirmation(changed, snapshot.settings), true);
    assert.throws(() => modelSettingsRequest(snapshot, changed), /请填写新凭据/);
    assert.equal(modelSettingsRequest(snapshot, {...changed, allowCredentialReuse: true}).allowCredentialReuse, true);
    assert.doesNotThrow(() => modelSettingsRequest(snapshot, {...changed, apiKeyAction: 'clear', headersAction: 'clear', extraBodyAction: 'clear'}));
  }
  const bodyOnly = {...snapshot.settings, apiKeyConfigured: false, headersConfigured: false};
  assert.equal(retainedCredentialsNeedConfirmation({...draft, baseUrl: 'https://other.fixture.example/v1'}, bodyOnly), true);
  assert.equal(retainedCredentialsNeedConfirmation({...draft, baseUrl: 'https://fixture.example/v1/'}, snapshot.settings), true, 'match the server destination comparison even for a trailing slash');
});

test('JSON and credential validation errors never repeat supplied secret values', () => {
  const draft = createModelDraft(snapshot.settings), secret = 'generated-do-not-echo';
  for (const patch of [
    {headersAction: 'replace' as const, headers: `{"broken":"${secret}`},
    {extraBodyAction: 'replace' as const, extraBody: `{"broken":"${secret}`},
    {headersAction: 'replace' as const, headers: JSON.stringify({'X-Fixture': `${secret}\nsecond`})},
    {apiKeyAction: 'replace' as const, apiKey: `${secret}\nsecond`},
  ]) {
    assert.throws(() => modelSettingsRequest(snapshot, {...draft, ...patch}), error => error instanceof Error && !error.message.includes(secret));
  }
  for (const value of ['[]', 'null', '42', '"string"']) assert.throws(() => modelSettingsRequest(snapshot, {...draft, extraBodyAction: 'replace', extraBody: value}), /JSON 对象/);
});

test('endpoint safety and numeric bounds are checked before any request', () => {
  const draft = createModelDraft(snapshot.settings);
  for (const baseUrl of ['https://u:p@fixture.example/v1', 'https://fixture.example/v1?key=secret', 'https://fixture.example/v1#key', 'file:///tmp/fixture', 'http://remote.fixture.example/v1']) assert.throws(() => modelSettingsRequest(snapshot, {...draft, baseUrl, allowCredentialReuse: true}));
  assert.throws(() => modelSettingsRequest(snapshot, {...draft, allowUnauthenticatedLocal: true}), /回环地址/);
  for (const maxTokens of ['', '0', '128001', 'NaN']) assert.throws(() => modelSettingsRequest(snapshot, {...draft, maxTokens}), /token 上限/);
  for (const timeoutSeconds of ['', '4', '601', 'NaN']) assert.throws(() => modelSettingsRequest(snapshot, {...draft, timeoutSeconds}), /等待时间/);
  const local = modelSettingsRequest(snapshot, {...draft, baseUrl: 'http://127.0.0.1:11434/v1', allowUnauthenticatedLocal: true, apiKeyAction: 'clear', headersAction: 'clear', extraBodyAction: 'clear'});
  assert.equal(local.settings.timeoutMs, 120000);
});
