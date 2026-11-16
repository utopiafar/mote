import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, readFile, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {DEPLOYMENT_MODEL_PROFILE_ID} from '@mote/shared/models';
import {type RuntimeModuleReference} from '@mote/shared/agent-runtimes';
import {PluginHost} from '@mote/plugin-host';
import {serviceContract, type ServiceBinding} from '@mote/plugin-api/contracts';
import {ConfigService} from '../src/config-service.js';
import {configFromDocument, registerBuiltinDomains} from '../src/config.js';
import {dshConfigurationSchema} from '../src/dsh-configuration.js';
import {nativeDshSource, type InstalledDshAuthority} from '../src/dsh-native.js';
import {activateInstalledDsh, installedDshModule, nativeDshCatalog, projectInstalledDshModules} from '../src/dsh-installed-modules.js';

const instance = {packageId: 'generated.native', installationId: 'generated-install', instanceId: 'generated-instance'};
const reference: RuntimeModuleReference = {contribution: {instance, contributionId: 'generated.root'}, revision: 0, artifactDigest: 'a'.repeat(64), exportName: 'default'};
const selected = (capabilities = ['hooks']) => ({modelProfileId: DEPLOYMENT_MODEL_PROFILE_ID, assembly: {packages: [reference], hooks: []}, grants: [{instance, capabilities}]});

test('native selections use the authoritative config file and become effective only after restart', async t => {
  const root = await mkdtemp(join(tmpdir(), 'mote-native-config-')), path = join(root, 'mote.yaml');
  const service = new ConfigService({path, initialDocument: {version: 1, revision: 0}, watch: false});
  registerBuiltinDomains(service);
  t.after(async () => {await service.close(); await rm(root, {recursive: true, force: true});});
  await service.initialize();
  await service.update('dsh', {profiles: [selected()]}, 0);
  assert.deepEqual(service.current('dsh'), {profiles: []});
  const view = service.view().domains.find(domain => domain.id === 'dsh')!;
  assert.equal(view.status, 'restart-required');
  assert.deepEqual(view.saved, {profiles: [selected()]});
  const restarted = new ConfigService({path, watch: false}); registerBuiltinDomains(restarted);
  t.after(() => restarted.close());
  await restarted.initialize();
  assert.deepEqual(restarted.current('dsh'), {profiles: [selected()]});
  assert.deepEqual(configFromDocument(restarted.document(), path, undefined, {initializeCredentials: false}).dsh, {profiles: [selected()]});
  assert.equal((await readFile(path, 'utf8')).includes('packageRoot'), false);
  await assert.rejects(service.update('dsh', {profiles: [{...selected(), modelProfileId: 'missing-profile'}]}, 1), {code: 'config_invalid'});
  const codex = {provider: 'codex', protocol: 'codex-app-server', baseUrl: '', model: 'generated-codex', apiKey: '', reasoningEffort: 'high', maxTokens: 8192, modelRequestTimeoutMs: null, agentTimeoutMs: null, serviceTier: 'default', allowUnauthenticatedLocal: false, headers: {}, extraBody: {}};
  await assert.rejects(service.update('models', {deployment: codex}, 1), {code: 'config_invalid'});
  assert.equal(service.revision, 1);
});

test('native configuration rejects duplicate selections/grants and executable or activation input', () => {
  const value = selected();
  for (const profiles of [
    [value, value],
    [{...value, grants: []}],
    [{...value, grants: [...value.grants, ...value.grants]}],
    [{...value, assembly: {...value.assembly, hooks: [reference]}}],
    [{...value, packageRoot: '/generated/executable'}],
    [{...value, grants: [{instance: {...instance, activationId: 'generated-activation'}, capabilities: ['hooks']}]}],
    [{...value, grants: [{instance, capabilities: ['hooks', 'hooks']}]}],
  ]) assert.equal(dshConfigurationSchema.safeParse({profiles}).success, false);
});

test('live native snapshots require the exact installed artifact and explicit complete owner grants', async t => {
  const root = await mkdtemp(join(tmpdir(), 'mote-native-authority-'));
  t.after(() => rm(root, {recursive: true, force: true}));
  await writeFile(join(root, 'package.json'), JSON.stringify({name: '@mote/generated-native', version: '1.0.0', type: 'module', exports: './index.mjs', dsh: {native: {capabilities: ['hooks']}}}));
  await writeFile(join(root, 'index.mjs'), 'export function apply() {}');
  let activation = new AbortController(), resolved = 0;
  const resolve = async () => {
    resolved++; const current = activation;
    const authority: InstalledDshAuthority = {module: {reference, packageRoot: root, packageName: '@mote/generated-native', packageVersion: '1.0.0', subpath: '.'}, signal: current.signal, assertCurrent() {current.signal.throwIfAborted();}};
    return authority;
  };
  assert.equal(nativeDshSource({profiles: [selected()]}, 'another-model', 2, resolve), undefined);
  for (const capabilities of [[], ['hooks', 'factory']]) {
    await assert.rejects(nativeDshSource({profiles: [selected(capabilities)]}, DEPLOYMENT_MODEL_PROFILE_ID, 2, resolve)!(), {code: 'dsh_profile_invalid'});
  }
  const configuration = dshConfigurationSchema.parse({profiles: [selected()]});
  const source = nativeDshSource(configuration, DEPLOYMENT_MODEL_PROFILE_ID, 2, resolve)!;
  configuration.profiles.length = 0;
  const first = await source();
  assert.equal(first.installedModules.length, 1); assert.deepEqual(first.installedModules[0]!.grantedCapabilities, ['hooks']);
  const stopped = new Error('Generated installed activation stopped'); activation.abort(stopped);
  assert.throws(() => first.assertCurrent(), error => error === stopped);
  await assert.rejects(source(), error => error === stopped);
  activation = new AbortController(); const next = await source(); next.assertCurrent();
  assert.notEqual(first.signal, next.signal); assert.ok(resolved >= 5);
  const stale = nativeDshSource({profiles: [selected()]}, DEPLOYMENT_MODEL_PROFILE_ID, 2, async () => ({...(await resolve()), module: {...(await resolve()).module, reference: {...reference, artifactDigest: 'b'.repeat(64)}}}));
  await assert.rejects(stale!(), {code: 'dsh_module_unavailable'});
});

test('installed native metadata accepts public aliases without executing the original package', async t => {
  const root = await mkdtemp(join(tmpdir(), 'mote-native-alias-'));
  t.after(() => rm(root, {recursive: true, force: true}));
  await writeFile(join(root, 'package.json'), JSON.stringify({name: '@mote/generated-alias', version: '1.0.0', type: 'module', exports: {'./root-alias': './index.mjs', '.': {import: './index.mjs'}, './z-hook': './hook.mjs', './a-hook': './hook.mjs'}, dsh: {native: {capabilities: ['hooks']}}}));
  await writeFile(join(root, 'index.mjs'), "throw new Error('Native code must not execute while checking metadata');");
  await writeFile(join(root, 'hook.mjs'), 'export function apply() {}');
  const manifest = {schemaVersion: 1 as const, id: instance.packageId, name: 'Generated native alias package', version: '1.0.0', runtime: 'service' as const, entry: 'index.mjs', archive: {asset: 'generated.zip', sha256: 'a'.repeat(64)}, capabilities: ['hooks'], configuration: [], dependencies: [], access: [], contributions: [
    {id: 'generated.root', version: '1.0.0', surface: 'agent' as const, runtime: 'native' as const, entry: 'index.mjs'},
    {id: 'generated.hook', version: '1.0.0', surface: 'agent' as const, runtime: 'native' as const, entry: 'hook.mjs', requires: [{kind: 'contribution' as const, id: 'generated.root', version: '1.0.0'}]},
  ]};
  const projection = await projectInstalledDshModules({manifest, directory: root, artifactDigest: 'a'.repeat(64), instance});
  assert.deepEqual(projection.modules.map(module => module.subpath), ['.', './a-hook']);
  assert.deepEqual(projection.modules[1]!.requires, [projection.modules[0]!.reference]);
  assert.equal(installedDshModule(projection, reference)?.subpath, '.');
  assert.equal(installedDshModule(projection, {...reference, artifactDigest: 'b'.repeat(64)}), undefined);
  const catalog = JSON.stringify(nativeDshCatalog(projection));
  assert.ok(catalog.includes('requestedCapabilities')); assert.ok(!catalog.includes(root)); assert.ok(!catalog.includes('grantedCapabilities'));
  await assert.rejects(projectInstalledDshModules({manifest: {...manifest, contributions: [{...manifest.contributions[0]!, entry: 'private.mjs'}]}, directory: root, artifactDigest: 'a'.repeat(64), instance}), {code: 'dsh_module_unavailable'});
});

test('native installation metadata borrows actual Host dependency and activation lifetimes', async t => {
  const host = new PluginHost({kind: 'central', id: 'generated-native-host'});
  t.after(() => host.close());
  const contract = serviceContract('generated.authority', '1'); let binding!: ServiceBinding;
  const provider = await host.install({identity: {...instance, instanceId: 'authority-instance', host: host.identity, activationId: 'authority-activation'}, contributions: [contract], factory(context) {
    return {prepare() {}, start() {binding = context.provide(contract.id, contract, {});}, quiesce() {}, stop() {}, dispose() {}};
  }});
  const stop = new AbortController();
  const activation = await activateInstalledDsh({host, instance, projection: {modules: [{reference, packageRoot: '/generated/private-artifact', packageName: '@mote/generated', packageVersion: '1.0.0', subpath: '.'}], capabilities: [], dependencies: []}, required: [binding], optional: [], signal: stop.signal, assertCurrent() {}});
  const authority = activation.module(reference)!;
  assert.ok(authority); authority.assertCurrent(); assert.equal(authority.signal.aborted, false);
  assert.equal(activation.module({...reference, revision: 1}), undefined);
  assert.ok(host.snapshot().contributions.some(contribution => contribution.identity.contributionId === 'generated.root' && contribution.availability.state === 'active'));
  await provider.close('disabled');
  assert.equal(authority.signal.aborted, true);
  assert.throws(() => authority.assertCurrent());
  assert.throws(() => activation.module(reference));
  await activation.close();
});
