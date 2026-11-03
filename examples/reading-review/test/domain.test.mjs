import test from 'node:test';
import assert from 'node:assert/strict';
import {createReadingReviewService, readingReviewRatings, readingReviewStrategies} from '../domain.mjs';
import {createFixtureStateStore} from './fixture-state.mjs';

const clockAt = value => () => new Date(value);

test('a plan starts empty and requires an explicit strategy before a review round', async () => {
  const store = createFixtureStateStore();
  const service = createReadingReviewService({state: store, clock: clockAt('2026-11-04T08:00:00.000Z')});
  const initial = await service.state();
  assert.equal(initial.strategy, null);
  assert.equal(initial.cards.length, 0);
  assert.equal(initial.stateRevision, 1);
  assert.deepEqual(initial.ratings, [...readingReviewRatings]);
  assert.deepEqual(initial.strategies.map(entry => entry.id), Object.keys(readingReviewStrategies));

  const added = await service.addCard({prompt: 'Generated prompt', answer: 'Generated answer'});
  assert.equal(added.cards.length, 1);
  await assert.rejects(service.review({cardId: added.cards[0].id, rating: 'good'}),
    error => error.name === 'ConnectorError' && error.code === 'reading_review_strategy_required' && error.statusCode === 409);
});

test('each selected strategy produces its own interval and persists across activation', async () => {
  const cases = [['spaced', 3], ['daily', 1], ['intensive', 1]];
  for (const [strategy, firstInterval] of cases) {
    const store = createFixtureStateStore();
    let service = createReadingReviewService({state: store, clock: clockAt('2026-11-04T08:00:00.000Z')});
    const selected = await service.selectStrategy(strategy);
    assert.equal(selected.strategy, strategy);
    const added = await service.addCard({prompt: 'Generated prompt', answer: 'Generated answer'});
    const reviewed = await service.review({cardId: added.cards[0].id, rating: 'good'});
    assert.equal(reviewed.rounds.length, 1);
    assert.equal(reviewed.rounds[0].strategy, strategy);
    assert.equal(reviewed.rounds[0].intervalDays, firstInterval, strategy + ' first interval');
    assert.equal(reviewed.cards[0].reviewCount, 1);
    assert.equal(reviewed.cards[0].lastRating, 'good');

    const revision = reviewed.stateRevision;
    service = createReadingReviewService({state: store, clock: clockAt('2026-11-05T08:00:00.000Z')});
    const resumed = await service.state();
    assert.equal(resumed.strategy, strategy);
    assert.equal(resumed.stateRevision, revision, 'a new activation reads the committed state revision');
    assert.equal(resumed.cards[0].id, added.cards[0].id);
    assert.equal(resumed.rounds[0].id, reviewed.rounds[0].id);

    const advanced = await service.review({cardId: added.cards[0].id, rating: 'good'});
    const secondInterval = strategy === 'spaced' ? 7 : strategy === 'daily' ? 1 : 2;
    assert.equal(advanced.rounds.at(-1).intervalDays, secondInterval, strategy + ' second interval');
  }
});

test('again keeps a card due today, hard is bounded by the selected strategy, and history stays bounded', async () => {
  const store = createFixtureStateStore();
  const service = createReadingReviewService({state: store, clock: clockAt('2026-11-04T08:00:00.000Z')});
  await service.selectStrategy('spaced');
  const added = await service.addCard({prompt: 'Generated prompt', answer: 'Generated answer'});
  const again = await service.review({cardId: added.cards[0].id, rating: 'again'});
  assert.equal(again.rounds[0].intervalDays, 0);
  assert.equal(again.cards[0].dueAt, '2026-11-04T08:00:00.000Z');
  const hard = await service.review({cardId: added.cards[0].id, rating: 'hard'});
  assert.equal(hard.rounds[1].intervalDays, 1);

  for (let index = 0; index < 60; index++)
    await service.review({cardId: added.cards[0].id, rating: 'good'});
  const bounded = await service.state();
  assert.equal(bounded.historyCount, 40, 'state keeps a bounded history, not unbounded rows');
  assert.equal(bounded.rounds.length, 20, 'the view exposes only the most recent page');
});

test('invalid inputs and unknown cards fail with stable domain codes, not partial writes', async () => {
  const store = createFixtureStateStore();
  const service = createReadingReviewService({state: store, clock: clockAt('2026-11-04T08:00:00.000Z')});
  const before = await service.state();
  await assert.rejects(service.selectStrategy('unknown'), error => error.code === 'reading_review_strategy_invalid');
  await assert.rejects(service.addCard({prompt: '', answer: 'Generated'}), error => error.code === 'reading_review_input_invalid');
  await assert.rejects(service.addCard({prompt: 'Generated', answer: 'x'.repeat(3000)}), error => error.code === 'reading_review_input_invalid');
  await service.selectStrategy('spaced');
  const added = await service.addCard({prompt: 'Generated prompt', answer: 'Generated answer'});
  await assert.rejects(service.review({cardId: 'missing', rating: 'good'}), error => error.code === 'reading_review_card_missing' && error.statusCode === 404);
  await assert.rejects(service.review({cardId: added.cards[0].id, rating: 'unknown'}), error => error.code === 'reading_review_rating_invalid');
  const after = await service.state();
  assert.equal(after.historyCount, 0);
  assert.notEqual(after.stateRevision, before.stateRevision, 'the successful strategy/card writes are the only committed changes');

  const value = JSON.stringify(after);
  assert.doesNotMatch(value, /\[Function|undefined/, 'the public view is plain JSON');
});
