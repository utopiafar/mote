import test from 'node:test';
import assert from 'node:assert/strict';
import {createAgent,AgentNotConfiguredError} from '../dist/index.js';

const reader = {async search() {return [];}, async timeline() {return {items: [], nextCursor: null};}, async evidence() {return [];}};

test('the Codex leaf reports the shared Host finalizer synchronously and exactly once before query setup', async () => {
  const modes = [];
  const agent = createAgent({reader, protocol: 'codex-app-server'});
  try {
    const query = agent.query({question: 'Generated Codex query'}, {onFinalizer: mode => modes.push(mode)});
    assert.deepEqual(modes, ['host']);
    await assert.rejects(query, AgentNotConfiguredError);
    assert.deepEqual(modes, ['host']);
    await assert.rejects(agent.query({question: 'Generated old caller'}), AgentNotConfiguredError);
    assert.deepEqual(modes, ['host'], 'an old no-lease caller reports nothing');
    await agent.close();
    const closed = agent.query({question: 'Generated closed query'}, {onFinalizer: mode => modes.push(mode)});
    assert.deepEqual(modes, ['host', 'host']);
    await assert.rejects(closed);
  } finally {await agent.close();}
});
