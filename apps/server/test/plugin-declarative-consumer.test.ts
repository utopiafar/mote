import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {mkdtempSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import {strToU8, zipSync} from 'fflate';
import type {PluginManifest, PluginReleaseTransport} from '../src/plugin-release.js';
import {Store, sha256} from '../src/store.js';
import {ExecutionEngine} from '../src/execution-engine.js';
import {GitHubPluginReleases} from '../src/plugin-release.js';
import {PluginCenter} from '../src/plugin-center.js';
import {pluginInstanceDescriptor, pluginInstanceSpec, pluginInstanceInvoker} from '../../web/src/features/runtime.js';
import {DeclarativeViewSession} from '../../web/src/plugin-host/declarative-view.js';

const worker = `export async function createMemoryProvider(){return {async health(){return {providerId:'generated',version:'1',ready:true,verified:{},problems:[]};},async read(){return null;},async search(){return [];},async export(){return [];},async put(){return {state:'applied'};},async remove(){return {state:'removed'};},async close(){}};}`;

async function waitFor(check: () => boolean, what: string) {
  const until = Date.now() + 5000;
  while (!check()) {assert.ok(Date.now() < until, what); await delay(5);}
}

// T3: a real PluginCenter pipeline emits the actual PluginCenterView, which
// the web declarative adapter and invoker consume — not a hand-shaped view
// model. Only the GitHub release transport and the worker probe are
// generated stubs; the view, revision and allowedActions are producer code.
test('a real producer-emitted instance drives the declarative adapter and precise commands', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'mote-declarative-consumer-'));
  t.after(() => rmSync(directory, {recursive: true, force: true}));
  const archive = zipSync({'provider.mjs': strToU8(worker)});
  const repository = 'generated-fixture/mote-adapter', tag = 'v1.0.0', commit = 'a'.repeat(40);
  const manifest: PluginManifest = {schemaVersion: 1, id: 'generated.t3', name: 'T3 adapter', version: '1.0.0', runtime: 'worker', entry: 'provider.mjs',
    archive: {asset: 'adapter.zip', sha256: sha256(archive)}, capabilities: ['repository'], configuration: [{id: 'label', label: 'Label', type: 'text', required: true}], dependencies: [], access: ['Generated only']};
  const base = `https://github.com/${repository}/releases/download/${tag}/`;
  const transport: PluginReleaseTransport = async url => {
    if (url.endsWith(`/releases/tags/${tag}`)) return {bytes: strToU8(JSON.stringify({tag_name: tag, draft: false, assets: [{name: 'mote-plugin.json', browser_download_url: base + 'mote-plugin.json'}, {name: 'adapter.zip', browser_download_url: base + 'adapter.zip'}]}))};
    if (url.endsWith(`/commits/${tag}`)) return {bytes: strToU8(JSON.stringify({sha: commit}))};
    if (url === base + 'mote-plugin.json') return {bytes: strToU8(JSON.stringify(manifest))};
    if (url === base + 'adapter.zip') return {bytes: archive};
    throw new Error('fixture transport rejects: ' + url);
  };
  const store = new Store(directory), executor = new ExecutionEngine(store, () => Date.now());
  const plugins = new PluginCenter(store, executor, new GitHubPluginReleases(join(directory, 'packages'), transport));
  plugins.probe = async () => ({capabilities: [{id: 'repository', state: 'verified'}], issues: []});
  t.after(async () => {await executor.close(); await plugins.close(); store.close();});

  const preview = await plugins.resolve({repository, tag});
  plugins.install({previewId: preview.id, operationId: randomUUID(), expectedRevision: plugins.revision()});
  await waitFor(() => plugins.view().packages[0]?.state === 'installed', 'generated release installs');
  const instance = plugins.configure(undefined, {packageId: plugins.view().packages[0]!.id, name: 'T3 instance', scope: 'default', configuration: {label: 'one'}, operationId: randomUUID(), expectedRevision: plugins.revision()});
  plugins.action(instance.id, 'check', {operationId: randomUUID(), expectedRevision: plugins.instanceView(instance.id).revision});
  await waitFor(() => plugins.instanceView(instance.id).observed === 'ready', 'generated worker check settles');
  plugins.action(instance.id, 'enable', {operationId: randomUUID(), expectedRevision: plugins.instanceView(instance.id).revision});
  await waitFor(() => plugins.instanceView(instance.id).desired === true, 'generated instance desired flips');

  // The real emitted view — identity, revision and allowedActions produced
  // by the producer itself.
  const emitted = plugins.instanceView(instance.id);
  assert.ok(emitted.allowedActions.length > 0, 'real view carries allowedActions');
  assert.ok(emitted.revision > 0);

  const spec = pluginInstanceSpec(emitted);
  const declared = new Set(pluginInstanceDescriptor(emitted).commands?.map(c => c.id));
  for (const component of spec.components) if (component.type === 'action') assert.ok(emitted.allowedActions.includes(component.command), 'every rendered action is DOMAIN-allowed');

  const calls: [string, number][] = [];
  const session = new DeclarativeViewSession(pluginInstanceDescriptor(emitted), spec, pluginInstanceInvoker(emitted, (path, revision) => {calls.push([path, revision]);}));
  session.lifetime.show();
  if (declared.has('enable')) {
    await session.command('enable');
    assert.deepEqual(calls, [[`/api/plugin-instances/${encodeURIComponent(emitted.id)}/enable`, emitted.revision]], 'command carries the emitted identity + revision');
  } else if (declared.has('disable')) {
    await session.command('disable');
    assert.deepEqual(calls, [[`/api/plugin-instances/${encodeURIComponent(emitted.id)}/disable`, emitted.revision]]);
  } else assert.fail('emitted instance must expose at least one lifecycle command');
  assert.equal(await session.command('uninstall').then(r => r.ok), false, 'undeclared command never fires');
});
