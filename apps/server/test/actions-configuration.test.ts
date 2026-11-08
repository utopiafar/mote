import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import Fastify from 'fastify';
import { serializeConfigDocument } from '@mote/shared/config-file';
import type { QueryInput } from '@mote/agent';
import type { QueryResult } from '@mote/shared';
import { Actions, registerActions } from '../src/actions.js';
import { ConfigService } from '../src/config-service.js';
import { parseConfigDocument, readConfigDocument, registerBuiltinDomains } from '../src/config.js';
import { Store } from '../src/store.js';
import { SourceStore } from '../src/sources.js';
import { FileStore } from '../src/files.js';
import type { Connections } from '../src/connections.js';

const text = 'Generated appointment requires confirmation.';
const event = { title: 'Generated event', start: '2099-02-01T09:00:00Z', end: '2099-02-01T10:00:00Z', timeZone: 'UTC', allDay: false, location: '', description: '' };
const empty = (): QueryResult => ({ answer: '{"actions":[]}', citations: [], trace: [], runId: randomUUID() });
const answer = (id: string): QueryResult => ({ ...empty(), answer: JSON.stringify({ actions: [{ kind: 'calendar.create', event, uncertainty: 'proposal', sameAs: null, evidence: [{ id, quote: text }] }] }), citations: [{ id, capturedAt: '2026-01-01T00:00:00Z', appName: 'Generated', excerpt: text }] });
async function fixture(t: TestContext, query?: (input: QueryInput) => Promise<QueryResult>) {
  const directory = mkdtempSync(join(tmpdir(), 'mote-actions-config-')), file = join(directory, 'mote.yaml'), store = new Store(join(directory, 'vault'));
  const sources = new SourceStore(store), files = new FileStore(store, sources);
  const service = new ConfigService({ path: file, watch: false, initialDocument: parseConfigDocument('version: 1\nrevision: 0\nactions:\n  enabled: true\n  timeZone: UTC\n') });
  registerBuiltinDomains(service); await service.initialize();
  store.db.exec('CREATE TABLE action_meta(key TEXT PRIMARY KEY,json TEXT NOT NULL)');
  store.db.prepare("INSERT INTO action_meta VALUES('review-devices',?)").run(JSON.stringify({ revision: 0, reviewDeviceIds: ['phone'] }));
  const actions = new Actions(store, files, query ?? (async input => answer(input.evidenceIds![0])), () => true, { configService: service });
  sources.register({ id: 'fixture', kind: 'custom', name: 'Generated', deviceId: 'fixture', platform: 'import' });
  const add = () => sources.upsert('fixture', { externalId: randomUUID(), revision: '1', observedAt: '2026-01-01T00:00:00Z', kind: 'message', layer: 'original', text });
  t.after(async () => { await actions.close(); await service.close(); store.close(); rmSync(directory, { recursive: true, force: true }); });
  return { directory, file, store, sources, files, service, actions, add };
}
const save = (f: Awaited<ReturnType<typeof fixture>>, settings = f.actions.settings()) => f.actions.saveSettings({ revision: f.service.revision, authorizationRevision: f.actions.authorizationRevision(), settings });

test('Actions runtime policy reloads from YAML while historical confirmations and device review authorization stay in the database', async t => {
  const f = await fixture(t);
  assert.deepEqual(f.actions.settings(), { enabled: true, timeZone: 'UTC', reviewDeviceIds: ['phone'] });
  assert.throws(() => f.actions.configure(f.actions.settings()), /configuration transaction/);
  f.actions.registerTarget({ deviceId: 'phone', deviceName: 'Generated', calendars: [{ id: 'calendar', title: 'Generated' }] });
  await f.add(); await f.actions.tick();
  const proposal = f.actions.list()[0], confirmed = f.actions.confirm(proposal.id, { version: proposal.version, event: proposal.event, target: { deviceId: 'phone', calendarId: 'calendar' } });
  await save(f, { ...f.actions.settings(), timeZone: 'America/New_York' });
  assert.equal(f.service.revision, 1); assert.equal(f.actions.authorizationRevision(), 0);
  assert.equal(readFileSync(f.file, 'utf8').includes('phone'), false);
  const changed = readConfigDocument(f.file); changed.actions = { enabled: false, timeZone: 'Europe/Paris' };
  writeFileSync(f.file, serializeConfigDocument(changed)); await f.service.reload();
  assert.deepEqual(f.actions.settings(), { enabled: false, timeZone: 'Europe/Paris', reviewDeviceIds: ['phone'] });
  assert.equal(f.actions.get(proposal.id).operationId, confirmed.operationId); assert.equal(f.actions.get(proposal.id).status, 'approved');
  await assert.rejects(f.service.update('actions', { ...f.service.saved<object>('actions'), reviewDeviceIds: ['outsider'] }, f.service.revision), (error: { code?: string }) => error.code === 'config_invalid');
  assert.deepEqual(f.actions.settings().reviewDeviceIds, ['phone']);
  await f.actions.close(); await f.service.close();
  const reopened = new ConfigService({ path: f.file, watch: false }); registerBuiltinDomains(reopened); await reopened.initialize();
  const restored = new Actions(f.store, f.files, async () => empty(), () => false, { configService: reopened });
  t.after(async () => { await restored.close(); await reopened.close(); });
  assert.deepEqual(restored.settings(), { enabled: false, timeZone: 'Europe/Paris', reviewDeviceIds: ['phone'] });
  assert.equal(restored.get(proposal.id).operationId, confirmed.operationId);
});

test('invalid runtime files still permit revocation, never grant a replacement device, and report the committed partial state', async t => {
  const f = await fixture(t), app = Fastify(); t.after(() => app.close());
  let credential: { deviceId: string } | undefined;
  registerActions(app, f.actions, { assertActive() {} } as unknown as Connections, () => credential as never);
  const view = (await app.inject('/api/actions')).json(); assert.equal(view.revision, 0); assert.equal(view.authorizationRevision, 0);
  writeFileSync(f.file, 'version: 1\nrevision: 0\nactions:\n  timeZone: Invalid/Synthetic\n');
  const response = await app.inject({ method: 'PUT', url: '/api/actions/settings', payload: { revision: 0, authorizationRevision: 0, settings: { enabled: false, timeZone: 'UTC', reviewDeviceIds: ['outsider'] } } });
  assert.equal(response.statusCode, 400, response.body); assert.equal(response.json().authorizationRevoked, true); assert.deepEqual(response.json().revokedDeviceIds, ['phone']);
  assert.equal(response.json().authorizationRevision, 1); assert.deepEqual(f.actions.settings(), { enabled: true, timeZone: 'UTC', reviewDeviceIds: [] });
  credential = { deviceId: 'phone' }; assert.equal((await app.inject('/api/actions')).statusCode, 403);
  credential = { deviceId: 'outsider' }; assert.equal((await app.inject('/api/actions')).statusCode, 403);
  await assert.rejects(f.actions.saveSettings({ revision: 0, authorizationRevision: 0, settings: { ...f.actions.settings(), reviewDeviceIds: ['phone'] } }), (error: { statusCode?: number }) => error.statusCode === 409);
  await assert.rejects(save(f, { ...f.actions.settings(), reviewDeviceIds: ['outsider'] }), (error: { code?: string }) => error.code === 'config_invalid');
  assert.deepEqual(f.actions.settings().reviewDeviceIds, []);
});

test('independent authorization revisions prevent two permission editors from overwriting a newer grant', async t => {
  const f = await fixture(t), settings = f.actions.settings();
  await save(f, { ...settings, reviewDeviceIds: ['phone', 'tablet'] });
  assert.equal(f.service.revision, 0, 'permission changes do not fake a configuration diff'); assert.equal(f.actions.authorizationRevision(), 1);
  await assert.rejects(f.actions.saveSettings({ revision: 0, authorizationRevision: 0, settings: { ...settings, reviewDeviceIds: [] } }), (error: { statusCode?: number }) => error.statusCode === 409);
  assert.deepEqual(f.actions.settings().reviewDeviceIds, ['phone', 'tablet']);
});

test('a stale runtime revision cannot grant a device but does not postpone an authorized withdrawal', async t => {
  const f = await fixture(t);
  await f.service.update('execution', { ...f.service.saved<object>('execution'), agentConcurrency: 2 }, 0);
  await assert.rejects(f.actions.saveSettings({ revision: 0, authorizationRevision: 0, settings: { enabled: false, timeZone: 'UTC', reviewDeviceIds: ['outsider'] } }), (error: { code?: string; revokedDeviceIds?: string[] }) => error.code === 'config_conflict' && JSON.stringify(error.revokedDeviceIds) === '["phone"]');
  assert.deepEqual(f.actions.settings(), { enabled: true, timeZone: 'UTC', reviewDeviceIds: [] });
  assert.equal(f.service.revision, 1); assert.equal(f.actions.authorizationRevision(), 1);
});

test('permission withdrawal does not reserve additional logical storage', async t => {
  const f = await fixture(t), reserve = f.store.reserveMetadata;
  f.store.reserveMetadata = () => { throw new Error('Generated full quota'); };
  try { await save(f, { ...f.actions.settings(), reviewDeviceIds: [] }); }
  finally { f.store.reserveMetadata = reserve; }
  assert.deepEqual(f.actions.settings().reviewDeviceIds, []); assert.equal(f.actions.authorizationRevision(), 1);
});

test('permission grants validate again after the runtime await; failures leave newer authorization intact', async t => {
  const f = await fixture(t), second = new Actions(f.store, f.files, async () => empty(), () => false);
  t.after(() => second.close());
  let entered!: () => void, release!: () => void;
  const ready = new Promise<void>(resolve => { entered = resolve; });
  f.service.setHandler('actions', async () => { entered(); await new Promise<void>(resolve => { release = resolve; }); return { apply() {} }; });
  const update = save(f, { ...f.actions.settings(), timeZone: 'Europe/Paris', reviewDeviceIds: ['phone', 'outsider'] });
  await ready; second.configure({ enabled: false, timeZone: 'UTC', reviewDeviceIds: [] }); release();
  await assert.rejects(update, (error: { statusCode?: number }) => error.statusCode === 409);
  assert.deepEqual(f.actions.settings().reviewDeviceIds, []); assert.equal(f.actions.authorizationRevision(), 1);
});

test('a failed grant write exposes a safe failure and preserves the prior device set', async t => {
  const f = await fixture(t);
  f.store.db.exec("CREATE TRIGGER generated_action_authorization_write_failure BEFORE INSERT ON action_meta WHEN NEW.key='review-devices' BEGIN SELECT RAISE(ABORT,'Generated private storage failure'); END");
  await assert.rejects(save(f, { ...f.actions.settings(), enabled: false, reviewDeviceIds: ['phone', 'outsider'] }), (error: { statusCode?: number; message?: string }) => error.statusCode === 503 && !error.message?.includes('Generated private'));
  assert.deepEqual(f.actions.settings().reviewDeviceIds, ['phone']); assert.equal(f.actions.settings().enabled, false); assert.equal(f.service.revision, 1);
});

test('unrelated global configuration edits do not invalidate an admitted Actions generation', async t => {
  let entered!: () => void, release!: () => void;
  const ready = new Promise<void>(resolve => { entered = resolve; });
  const f = await fixture(t, async input => { entered(); await new Promise<void>(resolve => { release = resolve; }); return answer(input.evidenceIds![0]); });
  t.after(() => release?.()); await f.add(); const running = f.actions.tick(); await ready;
  await f.service.update('execution', { ...f.service.saved<object>('execution'), agentConcurrency: 2 }, f.service.revision);
  release(); await running; assert.equal(f.actions.list().length, 1); assert.equal(f.actions.list()[0].status, 'proposed');
  assert.equal(f.actions.progress().errorCode, undefined);
});

test('time-zone changes retain the existing field-specific commit fence for an admitted Actions generation', async t => {
  let entered!: () => void, release!: () => void;
  const ready = new Promise<void>(resolve => { entered = resolve; });
  const f = await fixture(t, async input => { entered(); await new Promise<void>(resolve => { release = resolve; }); return answer(input.evidenceIds![0]); });
  t.after(() => release?.()); await f.add(); const running = f.actions.tick(); await ready;
  await save(f, { ...f.actions.settings(), timeZone: 'Europe/Paris' }); release(); await running;
  assert.equal(f.actions.list().length, 0); assert.equal(f.actions.progress().errorCode, 'action_settings_changed');
});
