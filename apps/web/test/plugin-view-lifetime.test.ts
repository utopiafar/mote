import test from 'node:test';
import assert from 'node:assert/strict';
import {PluginViewSession, type DraftWriter, type ViewScheduler} from '../src/plugin-host/view-session.js';

const deferred = <T>() => {
  let resolve!: (value: T) => void, reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return {promise, resolve, reject};
};

const memoryWriter = (fail = false): DraftWriter & {saved: Map<string, unknown>} => {
  const saved = new Map<string, unknown>();
  return {
    saved,
    save: async (key, value) => fail ? {ok: false as const, reason: 'save_failed' as const} : (saved.set(key, value), {ok: true as const}),
    load: async key => saved.get(key) ?? null,
    clear: async key => { saved.delete(key); },
  };
};

const manualScheduler = () => {
  const ticks: Array<{tick: () => void; handle: object}> = [];
  const scheduler: ViewScheduler = {
    schedule: tick => { const handle = {}; ticks.push({tick, handle}); return handle; },
    cancel: handle => { const i = ticks.findIndex(t => t.handle === handle); if (i >= 0) ticks.splice(i, 1); },
  };
  return {scheduler, fire: () => { for (const t of [...ticks]) t.tick(); }, pending: () => ticks.length};
};

test('hidden page stops polling and isolates late responses; resume restores snapshot and draft', async () => {
  const {scheduler, fire, pending} = manualScheduler();
  const session = new PluginViewSession({ownerKey: 'owner-a', writer: memoryWriter(), scheduler});
  session.lifetime.show();
  let reads = 0; const applied: string[] = [];
  const read = () => { reads++; return Promise.resolve(`result-${reads}`); };
  session.poll(read, value => applied.push(value as string), 100);
  fire();
  await Promise.resolve();
  assert.equal(reads, 1);
  assert.deepEqual(applied, ['result-1']);

  // In-flight read completes after suspend: generation check isolates it.
  const slow = deferred<string>();
  const outcome = session.requestRead(() => slow.promise, value => applied.push(value));
  session.saveDraft('note-draft', {text: 'unfinished'});
  session.snapshotView('list', {scroll: 240, filter: 'type:image', more: {cursor: 'c2'}});
  assert.deepEqual(await session.suspend(), {ok: true});
  assert.equal(pending(), 0, 'suspend clears the poll interval');

  fire();
  slow.resolve('late-result');
  assert.equal(await outcome, 'stale');
  assert.equal(reads, 1, 'no new read while hidden');
  assert.deepEqual(applied, ['result-1'], 'late response never rendered');

  session.resume();
  fire();
  await Promise.resolve();
  assert.equal(reads, 2, 'polling resumes after show');
  assert.deepEqual(session.restoreView('list'), {scroll: 240, filter: 'type:image', more: {cursor: 'c2'}});
  assert.deepEqual(session.draft('note-draft'), {text: 'unfinished'});
});

test('detail-stack return preserves question, attachments, refs and turn draft; durable upload survives hide', async () => {
  const session = new PluginViewSession({ownerKey: 'owner-a', writer: memoryWriter()});
  session.lifetime.show();
  const uploads: string[] = [];
  const upload = deferred<string>();
  void session.keepDurable(async signal => { const done = await upload.promise; assert.equal(signal.aborted, false); uploads.push(done); });

  // Ask view draft + in-progress upload leave for the original reader.
  session.saveDraft('ask-turn', {question: 'what changed?', attachments: [{id: 'att-1'}], referenceScope: 'connection:main'});
  assert.deepEqual(await session.suspend(), {ok: true});
  assert.equal(uploads.length, 0);

  // The durable upload finishes while hidden; nothing auto-submits or re-uploads.
  upload.resolve('uploaded');
  await Promise.resolve();
  assert.deepEqual(uploads, ['uploaded']);

  session.resume();
  assert.deepEqual(session.draft('ask-turn'), {question: 'what changed?', attachments: [{id: 'att-1'}], referenceScope: 'connection:main'});
});

test('failed draft save blocks unload and owner switch; old owner never writes new owner draft', async () => {
  const writer = memoryWriter(true);
  const session = new PluginViewSession({ownerKey: 'owner-a', writer});
  session.lifetime.show();
  session.saveDraft('note-draft', {text: 'must not lose'});
  const outcome = await session.suspend();
  assert.deepEqual(outcome, {ok: false, reason: 'save_failed'});
  assert.equal(session.saveFailed, true);
  assert.equal(session.lifetime.state, 'visible', 'failed save blocks the lossy transition');
  const switchOutcome = await session.switchOwner('owner-b');
  assert.deepEqual(switchOutcome, {ok: false, reason: 'save_failed'});

  // With an owner-scoped draft the switch keeps each owner's own partition:
  // the new owner sees an empty draft slot and the old owner draft returns.
  const goodSession = new PluginViewSession({ownerKey: 'owner-a', scope: 'owner', writer: memoryWriter()});
  goodSession.lifetime.show();
  goodSession.saveDraft('note-draft', {text: 'owner-a draft'});
  assert.deepEqual(await goodSession.switchOwner('owner-b'), {ok: true});
  assert.equal(goodSession.ownerKey, 'owner-b');
  assert.equal(goodSession.draft('note-draft'), null, 'new owner never reads the old owner draft');
  assert.deepEqual(await goodSession.switchOwner('owner-a'), {ok: true});
  assert.deepEqual(goodSession.draft('note-draft'), {text: 'owner-a draft'}, 'old-owner draft partition preserved');
});

test('unknown write ack holds request identity without replay', () => {
  const session = new PluginViewSession({ownerKey: 'owner-a', writer: memoryWriter()});
  session.lifetime.show();
  assert.equal(session.resolveWrite('req-1', 'unknown'), 'hold');
  assert.ok(session.pendingWrites.has('req-1'));
  // A later reconcile commits the same identity; nothing was re-sent.
  assert.equal(session.resolveWrite('req-1', 'ack'), 'commit');
  assert.equal(session.pendingWrites.size, 0);
  assert.equal(session.resolveWrite('req-2', 'nack'), 'fail');
});

test('persisted drafts are owner-qualified and hydrate across sessions', async () => {
  const writer = memoryWriter();
  const a1 = new PluginViewSession({ownerKey: 'owner-a', scope: 'owner', writer});
  a1.lifetime.show();
  a1.saveDraft('note-draft', {text: 'A'});
  assert.deepEqual(await a1.suspend(), {ok: true});
  const a2 = new PluginViewSession({ownerKey: 'owner-a', scope: 'owner', writer});
  a2.lifetime.show();
  assert.deepEqual(await a2.loadDraft('note-draft'), {text: 'A'}, 'recreated session hydrates persisted draft');
  const b = new PluginViewSession({ownerKey: 'owner-b', scope: 'owner', writer});
  b.lifetime.show();
  assert.equal(await b.loadDraft('note-draft'), null, 'other owner cannot read the partition');
  b.saveDraft('note-draft', {text: 'B'});
  assert.deepEqual(await b.suspend(), {ok: true});
  assert.deepEqual(await a2.loadDraft('note-draft'), {text: 'A'}, 'B never overwrote A');
});

test('suspended view stays suspended across owner switch and polls are revoked', async () => {
  const {scheduler, fire, pending} = manualScheduler();
  const session = new PluginViewSession({ownerKey: 'owner-a', writer: memoryWriter(), scheduler});
  session.lifetime.show();
  let applied = 0;
  session.poll(() => Promise.resolve('old-owner-data'), () => { applied++; }, 50);
  assert.equal(pending(), 1);
  assert.deepEqual(await session.suspend(), {ok: true});
  assert.deepEqual(await session.switchOwner('owner-b'), {ok: true});
  assert.equal(session.lifetime.state, 'suspended', 'hidden view never reactivates on switch');
  assert.equal(pending(), 0, 'old-owner polls are revoked, not just paused');
  fire();
  await Promise.resolve();
  assert.equal(applied, 0);
  assert.equal(await session.requestRead(() => Promise.resolve('x'), () => { applied++; }), 'skipped');
});

test('edits racing a pending draft save are flushed before suspend resolves', async () => {
  const gate = deferred<void>();
  const saved: Array<unknown> = [];
  const writer: DraftWriter = {
    save: async (_key, value) => { await gate.promise; saved.push(value); return {ok: true as const}; },
    load: async () => null, clear: async () => {},
  };
  const session = new PluginViewSession({ownerKey: 'owner-a', writer});
  session.lifetime.show();
  session.saveDraft('note', {text: 'first'});
  const suspending = session.suspend();
  await Promise.resolve();
  session.saveDraft('note', {text: 'latest'});
  gate.resolve();
  assert.deepEqual(await suspending, {ok: true});
  assert.deepEqual(saved.at(-1), {text: 'latest'}, 'the replacement is persisted, not the stale value');
});

test('poll cancellations are quiet while other failures reach the error path', async () => {
  const {scheduler, fire} = manualScheduler();
  const errors: unknown[] = [];
  const session = new PluginViewSession({ownerKey: 'owner-a', writer: memoryWriter(), scheduler});
  session.lifetime.show();
  const failing = deferred<unknown>();
  session.poll(() => failing.promise, () => {}, 10, error => errors.push(error));
  fire();
  failing.reject(new Error('network down'));
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(errors.length, 1);
  // Abort-driven rejection on suspend does not reach the error path.
  const aborted = deferred<unknown>();
  session.poll(() => aborted.promise, () => {}, 10, error => errors.push(error));
  fire();
  await session.suspend();
  aborted.reject(new DOMException('cancelled', 'AbortError'));
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(errors.length, 1);
});
