import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createAgent, AgentNotConfiguredError} from '../dist/index.js';
import {PluginHost} from '@mote/plugin-host';
import {runtimeService} from '../dist/runtime/contracts.js';

const reader = {async search() { return []; }, async timeline() { return {items: [], nextCursor: null}; }, async evidence() { return []; }};

test('the Host leaf reports once synchronously before query setup, and the old query call remains valid', async () => {
  const modes = [];
  const agent = createAgent({reader: {...reader, contextTools() {
    assert.deepEqual(modes, ['host']);
    return [];
  }}});
  try {
    const query = agent.query({question: 'Generated query'}, {onFinalizer: mode => modes.push(mode)});
    assert.deepEqual(modes, ['host']);
    await assert.rejects(query, AgentNotConfiguredError);
    assert.deepEqual(modes, ['host']);
    await assert.rejects(agent.query({question: 'Generated old caller'}), AgentNotConfiguredError);
  } finally { await agent.close(); }
});

test('each Host query reports its own lease while preserving caller cancellation and closed-agent failures', async () => {
  const agent = createAgent({reader});
  const modes = [], lease = {onFinalizer: mode => modes.push(mode)};
  const controller = new AbortController(), cancellation = new Error('Generated caller cancellation');
  controller.abort(cancellation);
  try {
    const cancelled = agent.query({question: 'Generated cancelled query', signal: controller.signal}, lease);
    assert.deepEqual(modes, ['host']);
    await assert.rejects(cancelled, error => error === cancellation);
    await agent.close();
    const closed = agent.query({question: 'Generated closed query'}, lease);
    assert.deepEqual(modes, ['host', 'host']);
    await assert.rejects(closed, /Agent is closed/);
    await assert.rejects(agent.query({question: 'Generated empty lease'}, {}), /Agent is closed/);
    assert.deepEqual(modes, ['host', 'host']);
  } finally { await agent.close(); }
});

test('a mutating and throwing public Host observer cannot change the run, finalizer or legacy usage', async t => {
  // Replace only the external runtime boundary: the public facade still owns
  // the real PluginHost, leases, HostRunSession, output validation and cleanup.
  const install = PluginHost.prototype.install;
  let runtimeRuns = 0, handleCloses = 0, readyToolCount = 0;
  t.mock.method(PluginHost.prototype, 'install', function(definition) {
    return install.call(this, {...definition, factory: context => definition.factory({...context,
      provide(id, contract, value, revision) {
        if (contract.id === runtimeService.id) value = {...value, async prepare(_profile, _model, host) {
          readyToolCount = host.tools.definitions.length;
          host.emit({type: 'tools.ready', tools: host.tools.definitions}, null);
          return {
            run: request => host.runModel(request.attempt, async () => {
              runtimeRuns++;
              host.emit({type: 'progress', progress: {stage: 'model', message: 'Generated runtime progress'}}, request.attempt);
              host.emit({type: 'usage', usage: {inputTokens: 900, outputTokens: 100, totalTokens: 1000, requests: 1, reportedRequests: 1}}, request.attempt);
              return {terminal: {kind: 'completed'}, candidate: {text: JSON.stringify({answer: 'Generated accepted answer.', citationIds: []})}};
            }),
            async repair() { throw new Error('Unexpected repair'); },
            async cancel() {},
            async close() { handleCloses++; },
          };
        }};
        return context.provide(id, contract, value, revision);
      },
    })});
  });
  const modes = [], envelopes = [], usage = [], progress = [], ready = [];
  const agent = createAgent({reader, model: 'generated-model', apiKey: 'generated-key', baseUrl: 'http://127.0.0.1:9/v1'});
  try {
    const query = agent.query({question: 'Generated public observer fixture',
      onUsage: sample => usage.push(structuredClone(sample)),
      onProgress: event => progress.push(structuredClone(event)),
      onTrace: event => { if (event.type === 'bridge.ready') ready.push(structuredClone(event)); },
      onHostRunEvent(envelope) {
        assert.deepEqual(modes, ['host']);
        envelopes.push(structuredClone(envelope));
        envelope.identity.runId = 'observer-forged-run';
        if (envelope.event.type === 'usage') envelope.event.usage.totalTokens = 99999;
        if (envelope.event.type === 'progress') envelope.event.progress.message = 'Observer-forged progress';
        if (envelope.event.type === 'tools.ready') envelope.event.tools.splice(0);
        if (envelope.event.type === 'run.terminal') envelope.event.terminal.kind = 'failed';
        throw new Error('Generated observer failure');
      },
    }, {onFinalizer: mode => modes.push(mode)});
    assert.deepEqual(modes, ['host']);
    const answer = await query;
    assert.equal(answer.answer, 'Generated accepted answer.');
    assert.notEqual(answer.runId, 'observer-forged-run');
    assert.equal(runtimeRuns, 1);
    assert.equal(handleCloses, 1);
    assert.deepEqual(modes, ['host']);
    assert.equal(usage.length, 1);
    assert.equal(usage[0].totalTokens, 1000);
    assert.equal(progress.filter(event => event.message === 'Generated runtime progress').length, 1);
    assert.ok(!JSON.stringify(progress).includes('Observer-forged'));
    assert.equal(ready.length, 1);
    assert.ok(readyToolCount > 0);
    assert.equal(ready[0].payload.tools, readyToolCount);
    assert.ok(envelopes.length >= 4);
    assert.ok(envelopes.every(envelope => envelope.identity.runId === answer.runId));
    assert.equal(envelopes.filter(envelope => envelope.event.type === 'run.terminal').length, 1);
    assert.equal(envelopes.at(-1).event.type, 'run.terminal');
    assert.equal(envelopes.at(-1).event.terminal.kind, 'completed');
  } finally { await agent.close(); }
});
