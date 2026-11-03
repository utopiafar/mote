import test from 'node:test';
import assert from 'node:assert/strict';
import {createCollectionService} from '../domain.mjs';
import {createFixtureStateStore} from './fixture-state.mjs';

test('the collection service persists items through the injected state store', async () => {
  const state = createFixtureStateStore();
  const service = createCollectionService({state, clock: () => '2026-11-04T00:00:00.000Z'});
  await service.load();
  assert.equal(service.port.summary().items, 0);

  const added = await service.port.add({text: 'Generated item'});
  assert.equal(added.text, 'Generated item');
  assert.equal(service.port.state().items.length, 1);

  const reopened = createCollectionService({state});
  await reopened.load();
  assert.equal(reopened.port.state().items[0].id, added.id);
});

test('quiesce refuses new writes while reads stay available', async () => {
  const service = createCollectionService({state: createFixtureStateStore()});
  await service.load();
  service.quiesce();
  await assert.rejects(() => service.port.add({text: 'Rejected'}), {code: 'collection_quiesced'});
  assert.equal(service.port.summary().items, 0);
});

test('invalid input and malformed stored state fail closed', async () => {
  const service = createCollectionService({state: createFixtureStateStore()});
  await service.load();
  await assert.rejects(() => service.port.add({text: 42}), {code: 'invalid_item_text'});

  const state = createFixtureStateStore();
  await state.compareAndSet('collection', null, {version: 99, items: 'not-an-array'});
  const broken = createCollectionService({state});
  await assert.rejects(() => broken.load(), {code: 'invalid_record'});
});
