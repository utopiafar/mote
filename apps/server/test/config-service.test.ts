import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { parse, stringify } from 'yaml';
import { z } from 'zod';
import { ConfigService, ConfigServiceError, type ConfigDocument, type ConfigServiceOptions } from '../src/config-service.js';
import { registerBuiltinDomains } from '../src/config.js';
import { ScopeError } from '../src/scope/baseline.js';

async function fixture(t: { after(fn: () => Promise<void>): void }, options: Partial<ConfigServiceOptions> = {}) {
  const directory = await fs.mkdtemp(join(tmpdir(), 'mote-unified-config-'));
  const service = new ConfigService({ path: join(directory, 'mote.yaml'), initialDocument: { version: 1, revision: 0 }, ...options });
  service.register({ id: 'execution', schema: z.object({ limit: z.number().int().min(1).max(10) }).strict(), defaultValue: { limit: 3 }, fields: [{ path: 'limit', effect: 'next-admission' }] });
  service.register({ id: 'server', schema: z.object({ port: z.number().int().min(1).max(65535) }).strict(), defaultValue: { port: 47832 }, fields: [{ path: 'port', effect: 'restart' }] });
  service.register({ id: 'secret', schema: z.object({ key: z.string(), label: z.string() }).strict(), defaultValue: { key: '${FIXTURE_KEY}', label: 'fixture' }, resolve: raw => ({ ...raw as object, key: (raw as { key: string }).key === '${FIXTURE_KEY}' ? 'synthetic-private-key' : (raw as { key: string }).key }), fields: [{ path: 'key', sensitive: true }] });
  // The reserved namespace is opaque until each plugin declares its own credentials.
  service.register({ id: 'plugins', schema: z.object({ configuration: z.record(z.unknown()).default({}) }).strict(), defaultValue: { configuration: {} }, resolve: raw => raw, fields: [{ path: 'configuration', sensitive: true }] });
  t.after(async () => { await service.close(); await fs.rm(directory, { recursive: true, force: true }); });
  await service.initialize();
  return { service, directory, file: service.path };
}
async function edit(file: string, change: (document: ConfigDocument) => void) { const document = parse(await fs.readFile(file, 'utf8')) as ConfigDocument; change(document); await fs.writeFile(file, stringify(document)); }
async function until(check: () => boolean) { for (let count = 0; count < 100; count++) { if (check()) return; await delay(25); } assert.fail('Configuration watcher did not settle'); }

test('API and external edits share one revision, preserve secrets, and restart reads the same authoritative file', async t => {
  const { service, file } = await fixture(t);
  let applied = 0;
  service.setHandler<{ limit: number }>('execution', next => ({ apply: () => { applied = next.limit; } }));
  await service.update('execution', { limit: 4 }, 0);
  assert.equal(applied, 4); assert.equal(service.revision, 1);
  await service.update('secret', { label: 'changed' }, 1);
  const contents = await fs.readFile(file, 'utf8');
  assert.ok(contents.includes('${FIXTURE_KEY}')); assert.ok(!contents.includes('synthetic-private-key'));
  assert.ok(!JSON.stringify(service.view()).includes('synthetic-private-key'));
  assert.equal((service.view().domains.find(domain => domain.id === 'secret')!.saved as { key: boolean }).key, true);
  await edit(file, document => { document.execution = { limit: 5 }; });
  await service.reload(); assert.equal(applied, 5); assert.equal(service.revision, 3);
  assert.equal((parse(await fs.readFile(file, 'utf8')) as ConfigDocument).revision, 3);
  await service.close();
  const restarted = await fixture(t, { path: file });
  assert.deepEqual(restarted.service.current('execution'), { limit: 5 }); assert.equal(restarted.service.revision, 3);
});
test('invalid file, partial YAML, duplicate keys and symlink input keep the last valid runtime without echoing values', async t => {
  const { service, file } = await fixture(t);
  const valid = await fs.readFile(file, 'utf8');
  for (const invalid of ['secret: synthetic-private-key\n', valid + 'execution: {limit: 4}\n', valid.replace('limit: 3', 'limit: synthetic-private-key'), 'version: 1\nrevision: 0\nexecution: [']) {
    await fs.writeFile(file, invalid);
    await assert.rejects(service.reload(), (error: unknown) => error instanceof ConfigServiceError && error.code === 'config_invalid' && !error.message.includes('synthetic-private-key'));
    assert.deepEqual(service.current('execution'), { limit: 3 }); assert.equal(service.revision, 0);
  }
  await fs.writeFile(file, valid); await service.reload(); assert.equal(service.view().lastError, null);
  await fs.rename(file, file + '.real'); await fs.symlink(file + '.real', file);
  await assert.rejects(service.reload(), { code: 'config_invalid' }); assert.equal(service.revision, 0);
});
test('semantic no-op edits, object key ordering and self writes do not reapply or increment revision', async t => {
  const { service, file } = await fixture(t);
  let applications = 0; service.setHandler('execution', () => ({ apply: () => { applications++; } }));
  await service.startWatching();
  await service.update('execution', { limit: 4 }, 0); await delay(300);
  assert.equal(applications, 1); assert.equal(service.revision, 1);
  const doc = parse(await fs.readFile(file, 'utf8')) as ConfigDocument;
  await fs.writeFile(file, stringify(Object.fromEntries(Object.entries(doc).reverse()))); await service.reload();
  assert.equal(applications, 1); assert.equal(service.revision, 1);
});
test('pending external edits and two concurrent API editors conflict instead of overwriting each other', async t => {
  const { service, file } = await fixture(t);
  await edit(file, document => { document.execution = { limit: 7 }; });
  await assert.rejects(service.update('execution', { limit: 2 }, 0), { code: 'config_conflict' });
  assert.deepEqual(service.current('execution'), { limit: 7 }); assert.equal(service.revision, 1);
  const results = await Promise.allSettled([service.update('execution', { limit: 4 }, 1), service.update('execution', { limit: 5 }, 1)]);
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
  assert.equal((results.find(result => result.status === 'rejected') as PromiseRejectedResult).reason.code, 'config_conflict');
  const bytes = await fs.readFile(file, 'utf8');
  await fs.writeFile(file, 'version: 1\nrevision: 2\nexecution: {limit: wrong}\n');
  await assert.rejects(service.update('execution', { limit: 3 }, 2));
  assert.equal((await fs.readFile(file, 'utf8')).includes('wrong'), true);
  await fs.writeFile(file, bytes);
});
test('restart-required values are saved with their old effective value until another process initializes', async t => {
  const { service, file } = await fixture(t);
  await service.update('server', { port: 49000 }, 0);
  assert.deepEqual(service.current('server'), { port: 47832 }); assert.deepEqual(service.saved('server'), { port: 49000 });
  assert.equal(service.view().domains.find(domain => domain.id === 'server')!.status, 'restart-required');
  assert.equal((parse(await fs.readFile(file, 'utf8')).server as { port: number }).port, 49000);
  await service.close(); const restarted = await fixture(t, { path: file });
  assert.deepEqual(restarted.service.current('server'), { port: 49000 });
});
test('prepare failure disposes candidates and leaves both file and all effective domains unchanged', async t => {
  const { service, file } = await fixture(t); let disposed = 0, applied = 0;
  service.setHandler('execution', () => ({ apply: () => { applied++; }, dispose: () => { disposed++; } }));
  service.setHandler('secret', () => { throw new Error('synthetic-private-key'); });
  const bytes = await fs.readFile(file, 'utf8');
  await edit(file, doc => { doc.execution = { limit: 8 }; doc.secret = { key: '${FIXTURE_KEY}', label: 'new' }; });
  const external = await fs.readFile(file, 'utf8');
  await assert.rejects(service.reload(), { code: 'config_prepare_failed' });
  assert.equal(disposed, 1); assert.equal(applied, 0); assert.equal(service.revision, 0);
  assert.deepEqual(service.current('execution'), { limit: 3 }); assert.equal(await fs.readFile(file, 'utf8'), external);
  await fs.writeFile(file, bytes);
});
test('apply failure rolls back prior domains and exposes the saved candidate without claiming it is effective', async t => {
  const { service, file } = await fixture(t); let live = 3;
  service.setHandler<{ limit: number }>('execution', (next, previous) => ({ apply: () => { live = next.limit; }, rollback: () => { live = previous.limit; } }));
  service.setHandler('secret', () => ({ apply: () => { throw Error('synthetic-private-key'); }, rollback: () => {} }));
  await edit(file, doc => { doc.execution = { limit: 8 }; doc.secret = { key: '${FIXTURE_KEY}', label: 'new' }; });
  await assert.rejects(service.reload(), { code: 'config_apply_failed' });
  assert.equal(live, 3); assert.deepEqual(service.current('execution'), { limit: 3 });
  assert.deepEqual(service.saved('execution'), { limit: 8 }); assert.equal(service.view().lastError?.code, 'config_apply_failed');
});
test('watcher reloads stable writes and atomic replacements and close removes the watcher', async t => {
  const { service, file } = await fixture(t); await service.startWatching();
  const original = parse(await fs.readFile(file, 'utf8')) as ConfigDocument; original.execution = { limit: 6 };
  const bytes = stringify(original), half = Math.floor(bytes.length / 2);
  await fs.writeFile(file, bytes.slice(0, half)); await delay(40); await fs.appendFile(file, bytes.slice(half));
  await until(() => service.revision === 1); assert.deepEqual(service.current('execution'), { limit: 6 });
  const replacement = parse(await fs.readFile(file, 'utf8')) as ConfigDocument; replacement.execution = { limit: 9 };
  await fs.writeFile(file + '.tmp', stringify(replacement)); await fs.rename(file + '.tmp', file);
  await until(() => service.revision === 2); assert.deepEqual(service.current('execution'), { limit: 9 });
  await service.close(); await fs.writeFile(file, 'invalid');
  await assert.rejects(service.reload(), { code: 'config_unavailable' });
});
test('registered plugin defaults, validation, apply, secret redaction and disposal use the same YAML namespace', async t => {
  const { service, file } = await fixture(t); let interval = 0;
  const unregister = await service.registerPlugin({ id: 'fixture', schema: z.object({ interval: z.number().int().min(1), token: z.string() }).strict(), defaultValue: { interval: 3, token: 'synthetic-plugin-secret' }, fields: [{ path: 'token', sensitive: true }], prepare: (next, previous) => ({ apply: () => { interval = next.interval; }, rollback: () => { interval = previous.interval; } }) });
  assert.equal(interval, 3); assert.ok(!JSON.stringify(service.view()).includes('synthetic-plugin-secret'));
  await service.update('plugin.fixture', { interval: 7 }, 0); assert.equal(interval, 7);
  assert.equal(parse(await fs.readFile(file, 'utf8')).plugins.configuration.fixture.interval, 7);
  await assert.rejects(service.update('plugin.fixture', { interval: 0 }, 1), { code: 'config_invalid' });
  await unregister(); await assert.rejects(service.update('plugin.fixture', { interval: 2 }, 1), { code: 'config_invalid' });
});

test('registering a plugin retains pending module changes and only publishes its own effective namespace', async t => {
  const directory = await fs.mkdtemp(join(tmpdir(), 'mote-config-plugin-registration-'));
  const service = new ConfigService({ path: join(directory, 'mote.yaml'), watch: false, initialDocument: { version: 1, revision: 0, plugins: { backendModules: [], configuration: {} } } });
  t.after(async () => { await service.close(); await fs.rm(directory, { recursive: true, force: true }); });
  service.register({ id: 'plugins', schema: z.object({ backendModules: z.array(z.string()), configuration: z.record(z.unknown()) }), defaultValue: { backendModules: [], configuration: {} }, restartRequired: true, fields: [{ path: 'backendModules', effect: 'restart' }], resolve: raw => raw });
  await service.initialize(); await service.update('plugins', { backendModules: ['pending-plugin.mjs'] }, 0);
  await service.registerPlugin({ id: 'added', schema: z.object({ interval: z.number().default(3) }), defaultValue: {} });
  assert.deepEqual(service.current('plugins'), { backendModules: [], configuration: { added: { interval: 3 } } });
  assert.deepEqual(service.saved('plugins'), { backendModules: ['pending-plugin.mjs'], configuration: { added: { interval: 3 } } });
  assert.equal(service.view().domains.find(domain => domain.id === 'plugins')?.status, 'restart-required');
  await service.update('plugin.added', { interval: 3 }, 1); assert.equal(service.revision, 1);
});

test('failed plugin activation cannot leave an uncertain runtime accepting new configuration', async t => {
  const {service}=await fixture(t); let disposed=0;
  await assert.rejects(service.registerPlugin({ id:'failed', schema:z.object({enabled:z.boolean()}), defaultValue:{enabled:true}, prepare:()=>({apply:()=>{throw Error('synthetic-private-apply-fault');},rollback:()=>{throw Error('synthetic-private-rollback-fault');},dispose:()=>{disposed++;}}) }), {code:'config_commit_uncertain'});
  assert.equal(disposed,1);
  await assert.rejects(service.update('execution',{limit:4},0),{code:'config_unavailable'});
});

test('runtime publication waits for every async resource install and rolls snapshots back without yielding', async t => {
  const {service,file}=await fixture(t); let live=3,entered=false,release!:()=>void;
  service.setHandler<{limit:number}>('execution',(next,previous)=>({apply:()=>{},publish:()=>{live=next.limit;},rollback:()=>{live=previous.limit;}}));
  const hold=new Promise<void>(resolve=>{release=resolve;});
  await service.registerPlugin({id:'fault',schema:z.object({n:z.number()}),defaultValue:{n:0},prepare:next=>({apply:async()=>{if(next.n===1){entered=true;await hold;throw Error('synthetic-private-install-fault');}},rollback:()=>{}})});
  await edit(file,doc=>{doc.execution={limit:8};(doc.plugins as {configuration:Record<string,unknown>}).configuration.fault={n:1};});
  const failed=service.reload(); await until(()=>entered);
  assert.equal(live,3); assert.deepEqual(service.current('execution'),{limit:3});
  release(); await assert.rejects(failed,{code:'config_apply_failed'}); assert.equal(live,3);
  let observedAfterFailure=-1;
  service.setHandler('secret',()=>({apply:()=>{},publish:()=>{queueMicrotask(()=>{observedAfterFailure=live;});throw Error('synthetic-private-publish-fault');},rollback:()=>{}}));
  await edit(file,doc=>{doc.execution={limit:9};doc.secret={key:'${FIXTURE_KEY}',label:'new'};(doc.plugins as {configuration:Record<string,unknown>}).configuration.fault={n:0};});
  await assert.rejects(service.reload(),{code:'config_apply_failed'});
  assert.equal(live,3); assert.equal(observedAfterFailure,3);
});

test('async publication protocol violations report uncertainty and consume private promise rejections', async t => {
  for(const asynchronousPublish of [false,true]) {
    const {service}=await fixture(t);
    service.setHandler('execution',()=>({apply:()=>{},publish:asynchronousPublish?async()=>{throw Error('synthetic-private-publish-fault');}:()=>{},rollback:async()=>{throw Error('synthetic-private-rollback-fault');}}));
    service.setHandler('secret',()=>({apply:()=>{},publish:()=>{throw Error('synthetic-private-later-fault');},rollback:()=>{}}));
    await assert.rejects(service.updateMany({execution:{limit:5},secret:{label:'new'}},0),{code:'config_commit_uncertain'});
    await assert.rejects(service.update('execution',{limit:7},0),{code:'config_unavailable'});
  }
});

test('a concurrent file replacement during resource preparation aborts the API write and disposes its candidate', async t => {
  const { service, file } = await fixture(t); let disposed = 0, live = 3;
  service.setHandler<{ limit: number }>('execution', async next => {
    await edit(file, doc => { doc.execution = { limit: 8 }; });
    return { apply: () => { live = next.limit; }, dispose: () => { disposed++; } };
  });
  await assert.rejects(service.update('execution', { limit: 5 }, 0), { code: 'config_conflict' });
  assert.equal(live, 3); assert.equal(disposed, 1); assert.equal(service.revision, 0);
  assert.equal(parse(await fs.readFile(file, 'utf8')).execution.limit, 8);
});
test('rename acknowledgement failure reads back the committed file and advances the active revision exactly once', async t => {
  let fail = false;
  const { service, file } = await fixture(t, { fileSystem: { rename: async (source, destination) => { await fs.rename(source, destination); if (fail) throw Error('synthetic-private-key'); } } });
  fail = true;
  await assert.rejects(service.update('execution', { limit: 5 }, 0), { code: 'config_commit_uncertain' });
  assert.equal(service.revision, 1); assert.deepEqual(service.current('execution'), { limit: 5 });
  assert.equal(parse(await fs.readFile(file, 'utf8')).revision, 1);
  assert.ok(!JSON.stringify(service.view()).includes('synthetic-private-key'));
});
test('failed atomic replacement keeps the previous file, effective settings, and revision', async t => {
  let fail = false, disposed = 0;
  const { service, file } = await fixture(t, { fileSystem: { rename: async (source, destination) => { if (fail) throw Error('synthetic-private-key'); await fs.rename(source, destination); } } });
  service.setHandler('execution', () => ({ apply: () => { assert.fail('A failed save must not activate'); }, dispose: () => { disposed++; } }));
  const original = await fs.readFile(file, 'utf8'); fail = true;
  await assert.rejects(service.update('execution', { limit: 5 }, 0), { code: 'config_save_failed' });
  assert.equal(service.revision, 0); assert.deepEqual(service.current('execution'), { limit: 3 });
  assert.equal(await fs.readFile(file, 'utf8'), original); assert.equal(disposed, 1);
});
test('CLI revision successors reload and subsequent API edits continue from the same version', async t => {
  const { service, file } = await fixture(t);
  await edit(file, doc => { doc.execution = { limit: 8 }; doc.revision++; });
  await service.reload(); assert.equal(service.revision, 1); assert.deepEqual(service.current('execution'), { limit: 8 });
  await service.update('execution', { limit: 5 }, 1); assert.equal(service.revision, 2);
  await edit(file, doc => { doc.revision++; }); await service.reload();
  assert.equal(service.revision, 2); assert.equal(parse(await fs.readFile(file, 'utf8')).revision, 2);
  await edit(file, doc => { doc.revision += 2; doc.execution = { limit: 7 }; });
  await assert.rejects(service.reload(), { code: 'config_conflict' }); assert.deepEqual(service.current('execution'), { limit: 5 });
});
test('credential templates survive an unchanged prefixed value and deletion or reordering of identified profiles', async t => {
  const { service, file } = await fixture(t);
  await service.registerPlugin({ id: 'templates', schema: z.object({ profiles: z.array(z.object({ id: z.string(), token: z.string() })) }), defaultValue: { profiles: [{ id: 'first', token: '${A}' }, { id: 'remaining', token: 'Bearer ${B}' }] }, fields: [{ path: 'profiles.*.token', sensitive: true }], resolve: raw => ({ profiles: (raw as { profiles: { id: string; token: string }[] }).profiles.map(item => ({ ...item, token: item.token.replace('${A}', 'synthetic-key-A').replace('${B}', 'synthetic-key-B') })) }) });
  await service.update('plugin.templates', { profiles: [{ id: 'remaining', token: 'Bearer synthetic-key-B' }] }, 0);
  const bytes = await fs.readFile(file, 'utf8');
  assert.ok(bytes.includes('Bearer ${B}')); assert.ok(!bytes.includes('synthetic-key-B'));
});
test('real profile CLI changes are observed by the watcher and allow subsequent runtime API saves', async t => {
  // Exercise the same CLI writer used for tunnel/public URL updates, without starting a node or a tunnel.
  const { profilePaths, initialize, loadProfile, setPublicUrl } = await import('../../../scripts/profile-lib.mjs');
  const directory = await fs.mkdtemp(join(tmpdir(), 'mote-cli-config-watch-'));
  const paths = profilePaths('test', directory); await initialize(paths, { port: 49157 });
  const profile = await loadProfile(paths);
  const service = new ConfigService({ path: paths.configFile }); registerBuiltinDomains(service);
  t.after(async () => { await service.close(); await fs.rm(directory, { recursive: true, force: true }); });
  await service.initialize(); await service.startWatching();
  await setPublicUrl(profile, 'https://synthetic-node.example.invalid');
  await until(() => service.revision === 1);
  assert.equal((service.saved('server') as { publicUrl: string }).publicUrl, 'https://synthetic-node.example.invalid');
  assert.equal((service.current('server') as { publicUrl: string }).publicUrl, '');
  await service.update('execution', { agentConcurrency: 4 }, 1); assert.equal(service.revision, 2);
});
test('complete domain replacements preserve intentional object deletions, including credentials', async t => {
  const { service } = await fixture(t);
  await service.registerPlugin({ id: 'objects', schema: z.object({ headers: z.record(z.string()), extraBody: z.record(z.unknown()) }), defaultValue: { headers: { Authorization: 'synthetic-key', removed: 'old' }, extraBody: { secret: 'synthetic-key' } }, fields: [{ path: 'headers', sensitive: true }, { path: 'extraBody', sensitive: true }] });
  await service.replace('plugin.objects', { headers: { Authorization: 'new' }, extraBody: {} }, 0);
  assert.deepEqual(service.current('plugin.objects'), { headers: { Authorization: 'new' }, extraBody: {} });
  await service.replace('plugin.objects', { headers: {}, extraBody: {} }, 1);
  assert.deepEqual(service.current('plugin.objects'), { headers: {}, extraBody: {} });
});
test('optional hot additions and restart-only deletions obey the declared effect without inventing empty parents', async t => {
  const { service } = await fixture(t);
  let active = '';
  await service.registerPlugin({ id: 'hot', schema: z.object({ label: z.string().optional() }), defaultValue: {}, restartRequired: true, fields: [{ path: 'label', effect: 'immediate' }], prepare: next => ({ apply: () => { active = next.label ?? ''; } }) });
  await service.update('plugin.hot', { label: 'added' }, 0); assert.equal(active, 'added'); assert.deepEqual(service.current('plugin.hot'), { label: 'added' });
  await service.registerPlugin({ id: 'cold', schema: z.object({ nested: z.object({ frozen: z.string().optional() }).optional(), hot: z.number().default(0) }), defaultValue: {}, fields: [{ path: 'nested.frozen', effect: 'restart' }] });
  await service.update('plugin.cold', {}, 1); assert.equal(service.revision, 1); assert.deepEqual(service.current('plugin.cold'), { hot: 0 });
  await service.update('plugin.cold', { nested: { frozen: 'pending' } }, 1); assert.deepEqual(service.current('plugin.cold'), { hot: 0 });
});
test('watcher readiness reconciles bootstrap edits and plugin credential registration works without a custom resolver', async t => {
  const { service, file } = await fixture(t);
  await edit(file, document => { document.execution = { limit: 8 }; }); await service.startWatching();
  assert.equal(service.revision, 1); assert.deepEqual(service.current('execution'), { limit: 8 });
  const before = process.env.MOTE_SYNTHETIC_PLUGIN_KEY; process.env.MOTE_SYNTHETIC_PLUGIN_KEY = 'generated-plugin-key';
  t.after(() => { if (before === undefined) delete process.env.MOTE_SYNTHETIC_PLUGIN_KEY; else process.env.MOTE_SYNTHETIC_PLUGIN_KEY = before; });
  await service.registerPlugin({ id: 'credentials', schema: z.object({ token: z.string() }), defaultValue: { token: 'Bearer ${MOTE_SYNTHETIC_PLUGIN_KEY}' }, fields: [{ path: 'token', sensitive: true }] });
  assert.deepEqual(service.current('plugin.credentials'), { token: 'Bearer generated-plugin-key' });
  await assert.rejects(service.registerPlugin({ id: 'missing', schema: z.object({ token: z.string() }), defaultValue: { token: '${MOTE_SYNTHETIC_UNSET_KEY}' }, fields: [{ path: 'token', sensitive: true }] }), { code: 'config_invalid' });
});
test('synchronous disposal errors leave the original safe error and continue cleaning every candidate', async t => {
  const { service, file } = await fixture(t); let disposed = 0;
  service.setHandler('execution', () => ({ apply: () => {}, dispose: () => { disposed++; throw Error('generated-private-cleanup-error'); } }));
  service.setHandler('secret', () => ({ apply: () => {}, dispose: () => { disposed++; } }));
  await service.registerPlugin({ id: 'failing', schema: z.object({ n: z.number() }), defaultValue: { n: 0 } });
  service.setHandler('plugin.failing', () => { throw Error('generated-private-prepare-error'); });
  await edit(file, doc => { doc.execution = { limit: 8 }; doc.secret = { key: '${FIXTURE_KEY}', label: 'new' }; (doc.plugins as { configuration: Record<string, unknown> }).configuration.failing = { n: 1 }; });
  await assert.rejects(service.reload(), { code: 'config_prepare_failed' }); assert.equal(disposed, 2); assert.equal(service.revision, 0);
});

test('request revocation during preparation rejects before atomic rename and disposes the private candidate', async t => {
  let renames = 0;
  const { service, file, directory } = await fixture(t, { fileSystem: { rename: async (source, destination) => { renames++; await fs.rename(source, destination); } } });
  const original = await fs.readFile(file, 'utf8'); renames = 0;
  let current = true, entered = false, applied = 0, disposed = 0, release!: () => void;
  const hold = new Promise<void>(resolve => { release = resolve; });
  const assertCurrent = () => { if (!current) { const error = new ScopeError('invalid_identity', 401); error.message = 'synthetic-private-key'; throw error; } };
  service.setHandler('execution', async () => {
    entered = true; await hold;
    return { apply: () => { applied++; }, dispose: () => { disposed++; } };
  });
  const update = service.updateMany({ execution: { limit: 8 } }, 0, false, assertCurrent);
  await until(() => entered); current = false; release();
  await assert.rejects(update, (error: unknown) => error instanceof ScopeError && error.code === 'invalid_identity' && error.statusCode === 401 && error.message === 'invalid_identity');
  assert.equal(applied, 0); assert.equal(disposed, 1); assert.equal(renames, 0);
  assert.equal(service.revision, 0); assert.deepEqual(service.current('execution'), { limit: 3 });
  assert.equal(await fs.readFile(file, 'utf8'), original);
  assert.deepEqual(await fs.readdir(directory), ['mote.yaml']);
});

test('queued request guards remain attached to their own transaction and reject a revoked editor', async t => {
  const { service, file } = await fixture(t);
  let entered = false, current = true, release!: () => void;
  const hold = new Promise<void>(resolve => { release = resolve; });
  service.setHandler('execution', async () => { entered = true; await hold; return { apply: () => {} }; });
  const first = service.update('execution', { limit: 4 }, 0, () => {});
  await until(() => entered);
  const queued = service.update('secret', { label: 'revoked-candidate' }, 1, () => { if (!current) throw new ScopeError('invalid_identity', 401); });
  const rejected = assert.rejects(queued, { code: 'invalid_identity', statusCode: 401 });
  current = false; release(); await first; await rejected;
  assert.equal(service.revision, 1); assert.deepEqual(service.current('execution'), { limit: 4 });
  assert.equal((service.saved('secret') as { label: string }).label, 'fixture');
  assert.ok(!(await fs.readFile(file, 'utf8')).includes('revoked-candidate'));
});

test('revocation during an async resource install rolls it back before publication and restores the saved file', async t => {
  for (const rejectsInstall of [false, true]) {
    const { service, file } = await fixture(t); const original = await fs.readFile(file, 'utf8');
    let current = true, entered = false, live = 3, installed = 3, published = 0, disposed = 0, release!: () => void;
    const hold = new Promise<void>(resolve => { release = resolve; });
    const assertCurrent = () => { if (!current) throw new ScopeError('invalid_identity', 401); };
    service.setHandler<{ limit: number }>('execution', (next, previous) => ({
      apply: async () => { installed = next.limit; entered = true; await hold; if (rejectsInstall) throw Error('synthetic-private-install-fault'); },
      publish: () => { published++; live = next.limit; },
      rollback: () => { installed = previous.limit; live = previous.limit; },
      dispose: () => { disposed++; },
    }));
    const update = service.replace('execution', { limit: 8 }, 0, assertCurrent);
    await until(() => entered); assert.equal(installed, 8); assert.equal(live, 3);
    assert.deepEqual(service.current('execution'), { limit: 3 });
    current = false; release(); await assert.rejects(update, { code: 'invalid_identity', statusCode: 401 });
    assert.equal(published, 0); assert.equal(disposed, 1); assert.equal(installed, 3); assert.equal(live, 3);
    assert.equal(service.revision, 0); assert.deepEqual(service.saved('execution'), { limit: 3 });
    assert.equal(await fs.readFile(file, 'utf8'), original);
    current = true; await service.reload(assertCurrent);
    assert.equal(published, 0); assert.deepEqual(service.current('execution'), { limit: 3 });
    await service.close(); const restarted = await fixture(t, { path: file });
    assert.deepEqual(restarted.service.current('execution'), { limit: 3 });
  }
});

test('an owner generation fence blocks private reads and file reload publication after account revocation', async t => {
  let enabled = true;
  const { service, file } = await fixture(t, { assertAccess: () => { if (!enabled) throw new ScopeError('invalid_identity', 401); } });
  let entered = false, installed = 3, published = 0, release!: () => void;
  const hold = new Promise<void>(resolve => { release = resolve; });
  service.setHandler<{ limit: number }>('execution', (next, previous) => ({
    apply: async () => { installed = next.limit; entered = true; await hold; },
    publish: () => { published++; }, rollback: () => { installed = previous.limit; },
  }));
  await edit(file, document => { document.execution = { limit: 8 }; });
  const reload = service.reload(); await until(() => entered); enabled = false;
  for (const read of [() => service.current('execution'), () => service.saved('secret'), () => service.document(), () => service.view(), () => service.revision]) {
    assert.throws(read, { code: 'invalid_identity', statusCode: 401 });
  }
  const queued = assert.rejects(service.update('execution', { limit: 9 }, 1), { code: 'invalid_identity', statusCode: 401 });
  release(); await assert.rejects(reload, { code: 'invalid_identity', statusCode: 401 }); await queued;
  assert.equal(installed, 3); assert.equal(published, 0);
  enabled = true; assert.equal(service.revision, 0); assert.deepEqual(service.current('execution'), { limit: 3 });
  assert.equal(parse(await fs.readFile(file, 'utf8')).execution.limit, 3);
});

test('revocation while rolling an async install back also restores its saved candidate', async t => {
  const { service, file } = await fixture(t); const original = await fs.readFile(file, 'utf8');
  let entered = false, current = true, release!: () => void;
  const hold = new Promise<void>(resolve => { release = resolve; });
  service.setHandler('execution', () => ({
    apply: () => { throw Error('synthetic-private-install-fault'); },
    rollback: async () => { entered = true; await hold; },
  }));
  const update = service.update('execution', { limit: 8 }, 0, () => { if (!current) throw new ScopeError('invalid_identity', 401); });
  await until(() => entered); current = false; release();
  await assert.rejects(update, { code: 'invalid_identity', statusCode: 401 });
  assert.equal(service.revision, 0); assert.deepEqual(service.current('execution'), { limit: 3 });
  assert.equal(await fs.readFile(file, 'utf8'), original);
});

test('revoked reload restoration uses CAS and never overwrites an external replacement', async t => {
  const { service, file } = await fixture(t);
  let entered = false, current = true, installed = 3, disposed = 0, release!: () => void;
  const hold = new Promise<void>(resolve => { release = resolve; });
  service.setHandler<{ limit: number }>('execution', (next, previous) => ({
    apply: async () => { installed = next.limit; entered = true; await hold; },
    publish: () => { assert.fail('A revoked reload must not publish'); },
    rollback: () => { installed = previous.limit; }, dispose: () => { disposed++; },
  }));
  await edit(file, document => { document.execution = { limit: 8 }; });
  const reload = service.reload(() => { if (!current) throw new ScopeError('invalid_identity', 401); });
  await until(() => entered);
  await edit(file, document => { document.execution = { limit: 9 }; }); const external = await fs.readFile(file, 'utf8');
  current = false; release(); await assert.rejects(reload, { code: 'config_commit_uncertain' });
  assert.equal(installed, 3); assert.equal(disposed, 1); assert.equal(await fs.readFile(file, 'utf8'), external);
  assert.throws(() => service.current('execution'), { code: 'config_unavailable' });
});

test('unknown authorization callback failures return only a fixed safe error', async t => {
  const { service, file } = await fixture(t); const original = await fs.readFile(file, 'utf8');
  for (const guard of [() => { throw Error('synthetic-private-authorization-fault'); }, async () => { throw Error('synthetic-private-authorization-fault'); }]) {
    await assert.rejects(service.reload(guard), (error: unknown) => error instanceof ConfigServiceError && error.code === 'config_unavailable' && error.message === 'config_unavailable');
  }
  assert.equal(await fs.readFile(file, 'utf8'), original); assert.equal(service.revision, 0);
});
