import test from 'node:test';
import assert from 'node:assert/strict';
import {createReadingReviewService} from '../domain.mjs';
import {createCustomPageInvoker, customPageMethods} from '../web/bridge.mjs';
import {createFixtureStateStore} from './fixture-state.mjs';

test('the custom page invoker exposes exactly the declared reading review methods', async () => {
  const service = createReadingReviewService({state: createFixtureStateStore(), clock: () => new Date('2026-11-04T08:00:00.000Z')});
  const invoke = createCustomPageInvoker(service);
  assert.deepEqual([...customPageMethods], ['state', 'select-strategy', 'review']);
  const initial = await invoke('state');
  assert.equal(initial.strategy, null);
  const selected = await invoke('select-strategy', {strategy: 'daily'});
  assert.equal(selected.strategy, 'daily');
  const added = await service.addCard({prompt: 'Generated prompt', answer: 'Generated answer'});
  const reviewed = await invoke('review', {cardId: added.cards[0].id, rating: 'good'});
  assert.equal(reviewed.historyCount, 1);
  assert.equal(reviewed.rounds[0].intervalDays, 1);
  await assert.rejects(invoke('exec', {}), /undeclared/);
});
