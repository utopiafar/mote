import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createAgent, AgentNotConfiguredError} from '../dist/index.js';

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
