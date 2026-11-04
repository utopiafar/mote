import test from 'node:test';
import assert from 'node:assert/strict';
import {createReadingExportService} from '../domain.mjs';
import {createCustomPageInvoker, createCustomPageSession, customPageMethods} from '../web/bridge.mjs';
import {createFixtureStateStore} from './fixture-state.mjs';

const plan = {
  version: 1,
  stateRevision: 4,
  observedAt: '2026-11-04T08:00:00.000Z',
  strategy: 'daily',
  strategies: [{id: 'daily', label: 'Daily', description: 'Generated daily strategy'}],
  ratings: ['again', 'hard', 'good', 'easy'],
  cards: [{
    id: 'generated-card', prompt: 'Generated prompt', answer: 'Generated answer',
    dueAt: '2026-11-05T08:00:00.000Z', intervalDays: 1, reviewCount: 1,
    lastReviewedAt: '2026-11-04T08:00:00.000Z', lastRating: 'good',
  }],
  rounds: [],
  historyCount: 0,
  dueCardIds: [],
  nextDueAt: '2026-11-05T08:00:00.000Z',
};

test('the custom page exposes exactly the declared archive methods', async () => {
  const service = createReadingExportService({
    state: createFixtureStateStore(), source: {state: async () => plan},
    clock: () => new Date('2026-11-04T09:00:00.000Z'),
  });
  const invoke = createCustomPageInvoker(service);
  assert.deepEqual([...customPageMethods], ['materials', 'read', 'export-now']);
  const published = await invoke('export-now');
  assert.equal(published.materials.length, 1);
  assert.equal(published.materials[0].source.strategy.id, 'daily');
  assert.equal((await invoke('materials')).materials[0].id, published.materialId);
  assert.equal((await invoke('read', {id: published.materialId})).id, published.materialId);
  await assert.rejects(invoke('exec', {}), /undeclared/);
});

test('closing a page session only detaches the page and does not stop archive work', async () => {
  const service = createReadingExportService({
    state: createFixtureStateStore(), source: {state: async () => plan},
    clock: () => new Date('2026-11-04T09:00:00.000Z'),
  });
  const page = createCustomPageSession(service);
  assert.equal(page.open, true);
  await page.invoke('materials');
  page.close();
  assert.equal(page.open, false);
  await assert.rejects(page.invoke('materials'), /custom page is closed/);
  const published = await service.exportNow();
  assert.equal(published.exported, true);
  assert.equal((await service.list()).materials.length, 1);
});
