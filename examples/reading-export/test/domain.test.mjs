import test from 'node:test';
import assert from 'node:assert/strict';
import {createReadingExportService, normalizeReadingExportArchive} from '../domain.mjs';
import {createFixtureStateStore} from './fixture-state.mjs';

const clockAt = value => () => new Date(value);
const strategies = [
  {id: 'spaced', label: 'Spaced', description: 'Generated spaced strategy'},
  {id: 'daily', label: 'Daily', description: 'Generated daily strategy'},
  {id: 'intensive', label: 'Intensive', description: 'Generated intensive strategy'},
];

function card(overrides = {}) {
  return {
    id: 'generated-card-1',
    prompt: 'Generated prompt',
    answer: 'Generated answer',
    createdAt: '2026-11-04T08:00:00.000Z',
    dueAt: '2026-11-07T08:00:00.000Z',
    intervalDays: 3,
    reviewCount: 1,
    lastReviewedAt: '2026-11-04T08:00:00.000Z',
    lastRating: 'good',
    ...overrides,
  };
}

function round(overrides = {}) {
  return {
    id: 'generated-round-1',
    cardId: 'generated-card-1',
    strategy: 'spaced',
    rating: 'good',
    reviewedAt: '2026-11-04T08:00:00.000Z',
    dueAtBefore: '2026-11-04T08:00:00.000Z',
    dueAtAfter: '2026-11-07T08:00:00.000Z',
    intervalDays: 3,
    ...overrides,
  };
}

function plan(overrides = {}) {
  const cards = overrides.cards ?? [card()];
  const rounds = overrides.rounds ?? [round()];
  return {
    version: 1,
    stateRevision: 2,
    observedAt: '2026-11-04T08:00:00.000Z',
    strategy: 'spaced',
    strategies,
    ratings: ['again', 'hard', 'good', 'easy'],
    cards,
    rounds,
    historyCount: rounds.length,
    dueCardIds: [],
    nextDueAt: cards[0]?.dueAt ?? null,
    ...overrides,
  };
}

test('the export copies the source strategy, intervals and due dates without recalculating', async () => {
  const state = createFixtureStateStore();
  const source = {state: async () => plan()};
  const service = createReadingExportService({state, source, clock: clockAt('2026-11-04T09:00:00.000Z')});
  const result = await service.exportNow();
  assert.equal(result.exported, true);
  const material = result.material;
  assert.equal(material.source.service, 'example.reading-review.plan');
  assert.equal(material.source.apiVersion, '1');
  assert.deepEqual(material.source.strategy, strategies[0]);
  assert.equal(material.cards[0].intervalDays, 3);
  assert.equal(material.cards[0].dueAt, '2026-11-07T08:00:00.000Z');
  assert.equal(material.content.format, 'markdown');
  assert.match(material.content.text, /Algorithm: Spaced \(spaced\)/);
  assert.match(material.content.text, /interval: 3 day\(s\)/);
  assert.match(material.content.text, /does not schedule or recompute reviews/);

  const listed = await service.list();
  assert.equal(listed.materials.length, 1);
  assert.equal(listed.materials[0].id, material.id);
  assert.deepEqual((await service.read(material.id)).content, material.content);
});

test('unchanged source revisions are deduplicated and the archive stays bounded', async () => {
  const state = createFixtureStateStore();
  let current = plan();
  const source = {state: async () => current};
  const service = createReadingExportService({state, source, clock: clockAt('2026-11-04T09:00:00.000Z'), limit: {maxExports: 2}});
  const first = await service.exportNow();
  const second = await service.exportNow();
  assert.equal(first.exported, true);
  assert.equal(second.exported, false);
  assert.equal(second.materialId, first.materialId);
  assert.equal((await service.list()).materials.length, 1);

  current = plan({stateRevision: 3, observedAt: '2026-11-05T08:00:00.000Z', cards: [card({dueAt: '2026-11-08T08:00:00.000Z'})]});
  assert.equal((await service.exportNow()).exported, true);
  current = plan({stateRevision: 4, observedAt: '2026-11-06T08:00:00.000Z', cards: [card({dueAt: '2026-11-09T08:00:00.000Z'})]});
  assert.equal((await service.exportNow()).exported, true);
  const bounded = await service.list();
  assert.equal(bounded.materials.length, 2);
  assert.equal(bounded.materials.at(-1).source.stateRevision, 4);
  assert.equal(bounded.materials[0].source.stateRevision, 3);
});

test('a source with another domain API version fails before replacing the archive', async () => {
  const state = createFixtureStateStore();
  let current = plan();
  const source = {state: async () => current};
  const service = createReadingExportService({state, source, clock: clockAt('2026-11-04T09:00:00.000Z')});
  const first = await service.exportNow();

  current = plan({version: 2, stateRevision: 3});
  await assert.rejects(service.exportNow(), error => error.code === 'reading_export_source_incompatible');
  const after = await service.list();
  assert.equal(after.materials.length, 1);
  assert.equal(after.materials[0].id, first.materialId);
  assert.equal(after.source.state, 'unavailable');
  assert.equal(after.source.reason, 'api_incompatible');
  assert.equal((await service.read(first.materialId)).fingerprint, first.material.fingerprint);
});

test('source loss stops new exports while published materials stay readable and unchanged', async () => {
  const state = createFixtureStateStore();
  let revoked = false;
  const source = {state: async () => {
    if (revoked) throw Error('generated provider revocation');
    return plan();
  }};
  const service = createReadingExportService({state, source, clock: clockAt('2026-11-04T09:00:00.000Z')});
  const published = await service.exportNow();
  const before = await service.list();
  revoked = true;

  await assert.rejects(service.exportNow(), error => error.code === 'reading_export_source_unavailable');
  const after = await service.list();
  assert.equal(after.materials.length, before.materials.length);
  assert.equal(after.materials[0].id, published.materialId);
  assert.equal(after.source.state, 'unavailable');
  assert.equal(after.source.reason, 'source_unavailable');
  assert.deepEqual((await service.read(published.materialId)).content, published.material.content);
  assert.equal(service.summary().lastStrategy, 'spaced', 'the last published algorithm stays visible');
  assert.doesNotMatch(JSON.stringify(after), /firstInterval|nextInterval/);
});

test('a source that never selected a strategy is exported as unselected, not defaulted', async () => {
  const state = createFixtureStateStore();
  const source = {state: async () => plan({strategy: null, cards: [], rounds: [], historyCount: 0, nextDueAt: null})};
  const service = createReadingExportService({state, source, clock: clockAt('2026-11-04T09:00:00.000Z')});
  const result = await service.exportNow();
  assert.equal(result.material.source.strategy, null);
  assert.match(result.material.content.text, /Algorithm: not selected by the reading plan source/);
  assert.doesNotMatch(result.material.content.text, /Spaced|Daily|Intensive/);
});

test('the archive survives a new activation and an archive-only service', async () => {
  const state = createFixtureStateStore();
  const first = createReadingExportService({state, source: {state: async () => plan()}, clock: clockAt('2026-11-04T09:00:00.000Z')});
  const published = await first.exportNow();
  first.close();

  const second = createReadingExportService({state, clock: clockAt('2026-11-05T09:00:00.000Z')});
  const resumed = await second.list();
  assert.equal(resumed.materials.length, 1);
  assert.equal(resumed.materials[0].id, published.materialId);
  assert.deepEqual((await second.read(published.materialId)).content, published.material.content);
  const record = await state.get('reading-export-archive');
  assert.equal(normalizeReadingExportArchive(record.value).exports[0].id, published.materialId);
  await assert.rejects(second.exportNow(), error => error.code === 'reading_export_source_unavailable');
  assert.equal((await second.list()).materials.length, 1);
});
