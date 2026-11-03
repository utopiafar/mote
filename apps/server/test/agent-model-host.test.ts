import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {randomUUID} from 'node:crypto';
import {createAgent, type ContextReader, type QueryInput} from '@mote/agent';
import {ProviderFailure} from '@mote/shared';
import type {ModelSettings} from '@mote/shared/models';
import {createAgentModelHost} from '../src/agent-model-host.js';
import {writeMessagesResponse} from '../../../scripts/fixtures/messages-provider.js';

const connection = {id: 'profile:generated', fingerprint: 'a'.repeat(64)};
const settingsFor = (baseUrl: string): ModelSettings => ({
  provider: 'custom', protocol: 'deepseek', model: 'generated-model', baseUrl, apiKey: 'generated-key', headers: {}, extraBody: {},
  reasoningEffort: 'off', maxTokens: 1024, modelRequestTimeoutMs: 10000, agentTimeoutMs: 15000, allowUnauthenticatedLocal: false,
});

test('native retries, repairs and image sends each require fresh admission and authority', async () => {
  const order: string[] = [];
  let current = true;
  const revoked = new ProviderFailure({category: 'blocked', code: 'model_lease_revoked', executionStarted: false});
  const host = createAgentModelHost(settingsFor('http://127.0.0.1:1'), connection, {
    authorization: {assertCurrent() { order.push('fence'); if (!current) throw revoked; }},
    admission: {check() { order.push('admission'); }},
    runModelFor: () => async task => task(),
    authorizeModelRequest() { order.push('evidence'); },
  });
  await host.authorizeModelRequest!();
  await host.authorizeModelRequest!();
  current = false;
  await assert.rejects(host.authorizeModelRequest!(), error => error === revoked);
  await assert.rejects(host.authorizeModelRequest!(), error => error === revoked);
  assert.deepEqual(order, [
    'fence', 'admission', 'evidence', 'fence', 'admission',
    'fence', 'admission', 'evidence', 'fence', 'admission',
    'fence', 'fence',
  ]);
});

for (const mode of ['repair', 'image'] as const) {
  test(`revocation after the first DSH attempt cancels the run before its ${mode} request`, {timeout: 30000}, async t => {
    const id = randomUUID(), controller = new AbortController(), requests: unknown[] = [], events: Parameters<NonNullable<QueryInput['onHostRunEvent']>>[0][] = [];
    let authorizations = 0, imageReads = 0, current = true;
    const revoked = new ProviderFailure({category: 'blocked', code: 'model_lease_revoked', executionStarted: false});
    const record = {id, capturedAt: '2026-11-01T00:00:00Z', appName: 'Generated source', ocrText: 'Generated authorized text.', provenance: {document: {attachments: [{id: 'generated-image', mimeType: 'image/png'}]}}};
    const reader: ContextReader = {
      search: async () => [record], timeline: async () => ({items: [record], nextCursor: null}), evidence: async () => [record], activity: async () => ({captures: 0}), devices: async () => [],
      ...(mode === 'image' ? {readImage: async () => { imageReads++; return {mimeType: 'image/png', data: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII='}; }} : {}),
    };
    const provider = createServer(async (req, res) => {
      let body = ''; for await (const chunk of req) body += chunk;
      requests.push(JSON.parse(body));
      writeMessagesResponse(res, {stage: 0, model: 'generated-model', ...(mode === 'image' ? {tool: {name: 'read_image', args: {id}}} : {}), text: mode === 'repair' ? 'Generated invalid JSON' : JSON.stringify({answer: `Generated answer [${id}]`, citationIds: [id]})});
    });
    await new Promise<void>(resolve => provider.listen(0, '127.0.0.1', resolve));
    const address = provider.address(); assert.ok(address && typeof address !== 'string');
    const settings = settingsFor(`http://127.0.0.1:${address.port}`);
    const host = createAgentModelHost(settings, connection, {
      authorization: {assertCurrent() { if (!current) throw revoked; }},
      admission: {check() {}},
      runModelFor: () => async task => task(),
      authorizeModelRequest() {
        authorizations++;
        if (authorizations === 2) { current = false; controller.abort(revoked); throw revoked; }
      },
    });
    const agent = createAgent({...settings, reader, runModel: host.runModel, authorizeModelRequest: host.authorizeModelRequest});
    t.after(async () => {
      await agent.close();
      provider.closeAllConnections();
      await new Promise<void>(resolve => provider.close(() => resolve()));
    });
    await assert.rejects(agent.query({
      question: `Generated ${mode} revocation`, signal: controller.signal,
      ...(mode === 'image' ? {directImages: [{id, name: 'Generated image', mimeType: 'image/png' as const, hash: 'b'.repeat(64), sizeBytes: 68}]} : {}),
      onHostRunEvent: event => events.push(structuredClone(event)),
    }));
    assert.equal(requests.length, 1, 'the revoked run cannot send another provider request');
    assert.equal(authorizations, 2);
    assert.equal(imageReads, mode === 'image' ? 1 : 0);
    const terminal = events.filter(event => event.event.type === 'run.terminal').at(-1);
    assert.deepEqual(terminal?.event, {type: 'run.terminal', terminal: {kind: 'cancelled', cause: 'cancelled'}});
  });
}
