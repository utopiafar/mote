import {actionsConfigDomain,memoryConfigDomain} from '../src/config.js';
import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { setImmediate as yieldTurn } from 'node:timers/promises';
import { z } from 'zod';
import { Actions } from '../src/actions.js';
import { actionsRuntimeSettingsSchema } from '../src/actions-configuration.js';
import { ConfigService } from '../src/config-service.js';
import { MemoryLifecycle, storedMemoryLifecycleSettings } from '../src/memory-lifecycle.js';
import { lifecycleSettingsSchema } from '../src/memory-configuration.js';
import { EvidenceStore as Store } from '../src/evidence-store.js';
import { SourceStore } from '../src/sources.js';
import { FileStore } from '../src/files.js';

const generatedResourceDomain={id:'generated-resource',schema:z.object({ generation: z.number().int() }).strict()};

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}

async function fixture(t: TestContext, release: () => void) {
  const directory = mkdtempSync(join(tmpdir(), 'mote-config-publication-'));
  const store = new Store(join(directory, 'vault'));
  const sources = new SourceStore(store), files = new FileStore(store, sources);
  const service = new ConfigService({ path: join(directory, 'mote.yaml'), watch: false, initialDocument: { version: 1, revision: 0 } });
  // Keep the async resource domain last, so admission handlers have already
  // applied when the transaction pauses before its publication barrier.
  service.register({ id: 'actions', schema: actionsRuntimeSettingsSchema, defaultValue: { enabled: false, timeZone: 'UTC' } });
  service.register({ id: 'memory', schema: lifecycleSettingsSchema, defaultValue: { batchCharacters: 1000 } });
  service.register({ ...generatedResourceDomain, defaultValue: { generation: 0 } });
  await service.initialize();
  store.db.exec('CREATE TABLE action_meta(key TEXT PRIMARY KEY,json TEXT NOT NULL)');
  store.db.prepare("INSERT INTO action_meta VALUES('review-devices',?)").run(JSON.stringify({ revision: 7, reviewDeviceIds: ['generated-review-device'] }));
  let modelCalls = 0;
  const actions = new Actions(store, files, async () => {
    modelCalls++;
    return { answer: '{"actions":[]}', citations: [], trace: [], runId: randomUUID() };
  }, () => true, { configService: service });
  const memory = new MemoryLifecycle(store, () => true, Date.now, undefined, undefined, service);
  t.after(async () => {
    release();
    await actions.close(); await memory.close(); await service.close();
    store.close(); rmSync(directory, { recursive: true, force: true });
  });
  sources.register({ id: 'generated', kind: 'custom', name: 'Generated publication fixture', deviceId: 'fixture', platform: 'import' });
  await sources.upsert('generated', { externalId: 'one', revision: '1', observedAt: '2026-01-01T00:00:00Z', kind: 'message', layer: 'original', text: 'Generated appointment evidence used only by a stubbed model.' });
  const read = () => ({
    actions: actions.settings(),
    authorizationRevision: actions.authorizationRevision(),
    memory: memory.settings(),
    // The real Memory pipeline reads its admission budget through this SQL
    // projection, before a lifecycle runtime necessarily exists.
    projectedMemory: storedMemoryLifecycleSettings(store),
    effectiveActions: service.current(actionsConfigDomain),
    effectiveMemory: service.current(memoryConfigDomain),
  });
  return { actions, memory, service, read, modelCalls: () => modelCalls };
}

for (const outcome of ['success', 'apply-failure', 'publish-failure'] as const) {
  test(`Actions admission and Memory budgets remain atomic across a ${outcome} configuration transaction`, async t => {
    const entered = deferred(), release = deferred(), f = await fixture(t, release.resolve);
    const before = f.read(), observations: ReturnType<typeof f.read>[] = [];
    const nextActions = { enabled: true, timeZone: 'Europe/Paris' };
    const nextMemory = { ...before.memory, batchCharacters: 256, contextCharacters: 16000, summaryCharacters: 4000 };
    f.service.setHandler(generatedResourceDomain, () => ({
      async apply() {
        observations.push(f.read()); entered.resolve();
        await release.promise;
        observations.push(f.read());
        if (outcome === 'apply-failure') throw Error('Generated resource installation failure');
      },
      publish() { if (outcome === 'publish-failure') throw Error('Generated synchronous publication failure'); },
      rollback() {},
    }));
    const notifications: ReturnType<typeof f.read>[] = [];
    f.service.onChange(() => { notifications.push(f.read()); });
    const update = f.service.updateMany({ actions: nextActions, memory: nextMemory, 'generated-resource': { generation: 1 } }, 0);
    // Attach both settlement handlers before releasing the async failure, and
    // surface an unexpected prepare/save failure instead of hanging on entry.
    const settled = update.then(() => ({ ok: true as const }), error => ({ ok: false as const, error }));
    await Promise.race([entered.promise, settled.then(() => assert.fail('Transaction never entered the generated async apply'))]);
    assert.deepEqual(f.read(), before);
    assert.equal(f.service.revision, 0);
    await f.actions.tick(); await yieldTurn();
    assert.deepEqual(f.read(), before);
    assert.equal(f.modelCalls(), 0, 'pending Actions enablement cannot admit model work');
    assert.deepEqual(f.actions.progress().jobs, []);
    assert.deepEqual(notifications, [], 'pending resource installation cannot announce effective settings');
    release.resolve();
    const result = await settled;
    assert.deepEqual(observations, [before, before], 'neither admission nor the SQL budget projection exposes a candidate during apply');
    if (outcome === 'success') {
      assert.equal(result.ok, true);
      const after = { ...before, actions: { ...nextActions, reviewDeviceIds: before.actions.reviewDeviceIds }, memory: nextMemory, projectedMemory: nextMemory, effectiveActions: nextActions, effectiveMemory: nextMemory };
      assert.deepEqual(f.read(), after);
      assert.deepEqual(notifications, [after]);
      assert.equal(f.service.revision, 1);
      await f.actions.tick();
      assert.equal(f.modelCalls(), 1, 'published enablement admits the generated original once');
      assert.equal(f.actions.progress().jobs[0].status, 'completed');
    } else {
      assert.equal(result.ok, false);
      if (result.ok) assert.fail('Generated failed apply unexpectedly succeeded');
      assert.equal(result.error.code, 'config_apply_failed');
      assert.deepEqual(f.read(), before);
      assert.ok(notifications.length > 0);
      for (const notification of notifications) assert.deepEqual(notification, before);
      assert.deepEqual(f.service.saved('actions'), nextActions);
      assert.deepEqual(f.service.saved('memory'), nextMemory);
      await f.actions.tick(); await yieldTurn();
      assert.equal(f.modelCalls(), 0, 'failed Actions enablement never admits a model call');
      assert.deepEqual(f.read(), before);
    }
  });
}
