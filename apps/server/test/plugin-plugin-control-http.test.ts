import test, {type TestContext} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {mkdtempSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import Fastify, {type FastifyRequest} from 'fastify';
import {PluginHost} from '@mote/plugin-host';
import {serviceContract, type ScopeIdentity} from '@mote/plugin-api/contracts';
import {Store, StoreError, sha256} from '../src/store.js';
import {ExecutionEngine} from '../src/execution-engine.js';
import {GitHubPluginReleases} from '../src/plugin-release.js';
import {createPluginControlPlatform, pluginControlDeclaration, type TrustedPluginBuild} from '../src/plugin-center.js';
import {registerPluginControlHttp} from '../src/plugins/plugin-control-http.js';
import {projectFeatureInventory, type HostContributionDescriptor} from '../src/feature-inventory.js';
import {buildApp} from '../src/app.js';
import type {Config} from '../src/config.js';
import {packageStateLabel} from '../../../apps/web/src/plugin-center-presentation.js';

const read = serviceContract<{read(): number}>('fixture.read', '1');
const selection = (packageId: string) => ({packageId, version: '1.0.0', configurationRevision: 0});

function trustedBuild(packageId: string, replacement: 'hot' | 'restart', broken = false): TrustedPluginBuild {
  return {
    packageId, version: '1.0.0', replacement,
    contribution: {
      id: packageId + '.port', version: '1.0.0', surface: 'data', runtime: 'host',
      provides: [{kind: 'service', id: read.id, apiVersion: '1', cardinality: 'single'}],
    },
    factory: () => ({
      prepare() {},
      start() { if (broken) throw Error('generated start failure'); },
      quiesce() {}, stop() {}, dispose() {},
    }),
  };
}

const owner = (request: FastifyRequest) => {
  const token = request.headers.authorization?.replace(/^Bearer /, '');
  if (!token) throw new StoreError('Owner authorization is required for plugin control', 401);
  if (token !== 'owner-token') throw new StoreError('Owner authorization is required for plugin control', 403);
};

async function platform(t: TestContext) {
  const directory = mkdtempSync(join(tmpdir(), 'mote-c08-'));
  const store = new Store(directory), executor = new ExecutionEngine(store), host = new PluginHost({kind: 'central', id: randomUUID()});
  const control = createPluginControlPlatform({
    store, executor, host, releases: new GitHubPluginReleases(join(directory, 'packages')),
  }, [trustedBuild('fixture.restart', 'restart'), trustedBuild('fixture.broken', 'hot', true)]);
  const identity: ScopeIdentity = {
    host: host.identity, packageId: 'mote.control', installationId: 'control-install', instanceId: 'control-instance', activationId: randomUUID(),
  };
  const handle = await host.install({identity, contributions: [pluginControlDeclaration], factory: control.factory});
  await control.startBuilds();
  const app = Fastify({logger: false});
  app.setErrorHandler((error, _request, reply) => {
    const status = (error as {statusCode?: unknown}).statusCode;
    return reply.code(typeof status === 'number' ? status : 500).send({error: error.message});
  });
  registerPluginControlHttp(app, {
    plugins: control.assembly,
    bindings: {} as never,
    automation: {} as never,
    owner,
  });
  await app.ready();
  t.after(async () => {
    await app.close(); await handle.close('shutdown'); await host.close(); await executor.close(); store.close();
    rmSync(directory, {recursive: true, force: true});
  });
  return {app, control};
}

test('build control HTTP keeps owner auth, CAS and real restart/blocked facts', async t => {
  const {app, control} = await platform(t);
  const ownerHeaders = {authorization: 'Bearer owner-token'}, collector = {authorization: 'Bearer collector-token'};
  const before = control.assembly.revision();
  assert.equal((await app.inject({url: '/api/plugin-builds'})).statusCode, 401);
  assert.equal((await app.inject({url: '/api/plugin-builds', headers: collector})).statusCode, 403);
  assert.equal(control.assembly.revision(), before, 'rejected collector requests never mutate');
  const list = await app.inject({url: '/api/plugin-builds', headers: ownerHeaders});
  assert.equal(list.statusCode, 200);
  assert.deepEqual(list.json(), []);

  const selected = await app.inject({
    method: 'PATCH', url: '/api/plugin-builds/restart', headers: ownerHeaders,
    payload: {operationId: randomUUID(), expectedRevision: control.assembly.revision(), selection: selection('fixture.restart')},
  });
  assert.equal(selected.statusCode, 200);
  const view = selected.json();
  assert.equal(view.observed, 'restart_required');
  assert.equal(view.restartRequired, true);
  assert.equal(view.allowedActions, undefined);
  assert.equal(view.restartPlan, undefined);
  assert.equal(packageStateLabel('restart-required'), '等待节点重启');

  const revision = control.assembly.revision();
  assert.equal((await app.inject({
    method: 'PATCH', url: '/api/plugin-builds/restart', headers: collector,
    payload: {operationId: randomUUID(), expectedRevision: revision, selection: null},
  })).statusCode, 403);
  assert.equal(control.assembly.revision(), revision);
  const stale = await app.inject({
    method: 'PATCH', url: '/api/plugin-builds/restart', headers: ownerHeaders,
    payload: {operationId: randomUUID(), expectedRevision: view.revision + 1, selection: null},
  });
  assert.equal(stale.statusCode, 409, stale.body);

  const stopped = await app.inject({
    method: 'PATCH', url: '/api/plugin-builds/restart', headers: ownerHeaders,
    payload: {operationId: randomUUID(), expectedRevision: view.revision, selection: null},
  });
  assert.equal(stopped.statusCode, 200);
  assert.equal(stopped.json().observed, 'stopped');
  const retired = await app.inject({
    method: 'POST', url: '/api/plugin-builds/restart/retire', headers: ownerHeaders,
    payload: {operationId: randomUUID(), expectedRevision: stopped.json().revision},
  });
  assert.equal(retired.statusCode, 200);
  assert.equal(retired.json().retired, true);

  const blocked = await app.inject({
    method: 'PATCH', url: '/api/plugin-builds/broken', headers: ownerHeaders,
    payload: {operationId: randomUUID(), expectedRevision: control.assembly.revision(), selection: selection('fixture.broken')},
  });
  assert.equal(blocked.statusCode, 200);
  assert.equal(blocked.json().observed, 'blocked');
  assert.ok(blocked.json().blockers.length > 0);
  assert.equal(packageStateLabel('blocked'), '需要处理');
});

test('feature inventory keeps the Web contract and content-hash revision', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'mote-c08-features-'));
  const config: Config = {
    dataDir: directory, token: 'generated-c08-owner', tokenPath: join(directory, 'owner-token'), host: '127.0.0.1', port: 0,
    profile: 'test', tokenFromEnvironment: true, maxStorageBytes: 30 * 1024 * 1024, maxExportBytes: 1024 * 1024,
    retentionDays: 0, insightIntervalHours: 0, allowedOrigins: [], model: '', modelBaseUrl: 'https://api.deepseek.com',
    apiKey: '', allowUnauthenticatedLocal: false, embeddingModel: '', embeddingBaseUrl: '', embeddingApiKey: '', logLevel: 'silent',
  };
  const node = await buildApp(config);
  t.after(async () => { await node.app.close(); rmSync(directory, {recursive: true, force: true}); });
  const response = await node.app.inject({url: '/api/features', headers: {authorization: 'Bearer ' + config.token}});
  assert.equal(response.statusCode, 200);
  const inventory = response.json();
  assert.equal(inventory.schemaVersion, 1);
  assert.equal(typeof inventory.revision, 'number');
  const expected = parseInt(sha256(JSON.stringify({features: inventory.features, capabilities: inventory.capabilities})).slice(0, 12), 16);
  assert.equal(inventory.revision, expected, 'inventory revision is the content digest, not a command CAS revision');
  assert.notEqual(inventory.revision, node.pluginCenter.revision());
  assert.ok(inventory.capabilities.some((capability: {surface: string}) => capability.surface === 'data'));
});

test('common host snapshot drives inventory availability and digest', async t => {
  const host = new PluginHost({kind: 'central', id: randomUUID()});
  const scope = (installationId: string): ScopeIdentity => ({
    host: host.identity, packageId: 'fixture.package', installationId, instanceId: 'fixture-instance', activationId: randomUUID(),
  });
  const install = (identity: ScopeIdentity) => host.install({
    identity, contributions: [{id: 'fixture.contribution', apiVersion: '1'}, {id: 'fixture.contribution.two', apiVersion: '1'}],
    factory: () => ({prepare() {}, start() {}, quiesce() {}, stop() {}, dispose() {}}),
  });
  const oldIdentity = scope('old-install'), newIdentity = scope('new-install');
  const oldHandle = await install(oldIdentity), newHandle = await install(newIdentity);
  t.after(async () => { await newHandle.close('shutdown'); await oldHandle.close('shutdown'); await host.close(); });
  const descriptor = (identity: ScopeIdentity, contributionId = 'fixture.contribution', requires?: HostContributionDescriptor['requires']): HostContributionDescriptor => ({
    scope: identity, contributionId, featureId: 'fixture.feature', featureVersion: '2.0.0', version: '1', surface: 'data', ...(requires ? {requires} : {}),
  });
  const descriptors = (identity: ScopeIdentity) => [descriptor(identity), descriptor(identity, 'fixture.contribution.two', ['fixture.contribution'])];
  const base = {
    server: {schemaVersion: 1 as const, revision: 0, features: [], capabilities: []},
    agent: {schemaVersion: 1 as const, revision: 0, features: [], capabilities: []},
    connectors: [], pipelines: [], processing: [], workflows: [],
  };
  const active = projectFeatureInventory({...base, host: {snapshot: host.snapshot(), descriptors: descriptors(oldIdentity)}});
  assert.deepEqual(active.capabilities.filter(c => c.featureId === 'fixture.feature').map(c => c.state), ['active', 'active']);
  const activeFeature = active.features.find(f => f.id === 'fixture.feature');
  assert.equal(activeFeature?.version, '2.0.0', 'feature version comes from the package, not a contribution');
  assert.deepEqual(activeFeature?.components.map(c => c.id).sort(), ['fixture.contribution', 'fixture.contribution.two']);
  assert.equal(activeFeature?.components.find(c => c.id === 'fixture.contribution.two')?.version, '1');
  assert.deepEqual(activeFeature?.components.find(c => c.id === 'fixture.contribution.two')?.requires, ['fixture.contribution']);
  assert.deepEqual(active.capabilities.find(c => c.id === 'fixture.contribution.two')?.requires, ['fixture.contribution']);
  await newHandle.quiesce('upgrade');
  assert.throws(() => projectFeatureInventory({
    ...base, host: {snapshot: host.snapshot(), descriptors: [...descriptors(oldIdentity), ...descriptors(newIdentity)]},
  }), /Ambiguous host inventory descriptor/, 'the same public key from two scopes must be rejected');
  assert.throws(() => projectFeatureInventory({
    ...base, host: {snapshot: host.snapshot(), descriptors: [descriptor(oldIdentity), descriptor(oldIdentity)]},
  }), /Ambiguous host inventory descriptor/, 'an identical duplicate descriptor is also ambiguous');
  const overlapping = projectFeatureInventory({...base, host: {snapshot: host.snapshot(), descriptors: descriptors(newIdentity)}});
  assert.deepEqual(overlapping.capabilities.filter(c => c.featureId === 'fixture.feature').map(c => c.state), ['unavailable', 'unavailable'], 'the quiesced new scope must not inherit the old active scope');
  assert.equal(projectFeatureInventory({...base, host: {snapshot: host.snapshot(), descriptors: descriptors(oldIdentity)}}).capabilities.find(c => c.id === 'fixture.contribution')?.state, 'active');
  assert.notEqual(overlapping.revision, active.revision, 'availability changes the content digest');
  await oldHandle.close('shutdown');
  assert.equal(projectFeatureInventory({...base, host: {snapshot: host.snapshot(), descriptors: descriptors(oldIdentity)}}).capabilities.find(c => c.id === 'fixture.contribution')?.state, 'unavailable', 'an old installation must not bind the new installation');
  await newHandle.close('revoked');
  const revoked = projectFeatureInventory({...base, host: {snapshot: host.snapshot(), descriptors: descriptors(newIdentity)}});
  assert.deepEqual(revoked.capabilities.filter(c => c.featureId === 'fixture.feature').map(c => c.state), ['unavailable', 'unavailable']);
});
