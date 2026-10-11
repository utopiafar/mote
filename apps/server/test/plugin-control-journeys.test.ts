import test, {type TestContext} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {mkdtempSync, readFileSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import {strToU8, zipSync} from 'fflate';
import type {PluginInstanceView, QueryResult} from '@mote/shared';
import {Store, sha256} from '../src/store.js';
import {ExecutionEngine} from '../src/execution-engine.js';
import {GitHubPluginReleases, type PluginManifest, type PluginReleaseTransport} from '../src/plugin-release.js';
import {PluginCenter} from '../src/plugin-center.js';
import {WorkerMemoryProvider} from '../src/worker-memory-provider.js';
import {WorkerPluginRuntime} from '../src/plugin-runtime.js';
import {MemoryAutomation} from '../src/memory-automation.js';
import {MemoryInputAuthorization} from '../src/memory-input-authorization.js';
import {MemoryBindings} from '../src/memory-bindings.js';
import {MemoryPublication} from '../src/memory-publication.js';
import {MemoryPipeline} from '../src/memory-pipeline.js';
import {MemoryLifecycle} from '../src/memory-lifecycle.js';
import {MemoryIntegrationSettings} from '../src/memory-integration-settings.js';
import {registerMemoryIntegration, requestMemoryIntegration} from '../src/memory-integration.js';
import {MemoryStore} from '../src/memory.js';
import {reviewMemory, memoryReviewReceipt} from '../src/memory-review.js';
import {SourceStore} from '../src/sources.js';
import {memoryProviderKey} from '../src/memory-provider-contract.js';
import {fixtureMemoryResult} from './fixtures/memory-result.js';
import {buildApp} from '../src/app.js';
import type {Config} from '../src/config.js';

// Generated executable release, not a Mem0/Hindsight substitute or capability
// claim. It exercises the real download/integrity/worker/persistence boundary.
const generatedWorker = String.raw`
import {readFile,writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
const hash=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const same=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
export async function createMemoryProvider(configuration){
 let state;try{state=JSON.parse(await readFile(configuration.recordFile,'utf8'));}catch{state={records:[],receipts:{}};}
 const save=()=>writeFile(configuration.recordFile,JSON.stringify(state));
 const matches=(record,input)=>same(record.namespace,input.namespace)&&same(record.key,input.key);
 const selected=input=>state.records.filter(record=>same(record.namespace,input.namespace));
 const receipt=(input,status)=>({opId:input.opId,namespace:input.namespace,key:input.key,payloadDigest:hash({namespace:input.namespace,key:input.key,memory:input.memory}),state:status,eraseVerified:false,recordedAt:'2026-10-12T00:00:00Z',...(status==='removed'?{currentRemoved:true,historyRetained:true}:{})});
 return {
  async health(){return {providerId:'generated.fixed-release',version:configuration.label,ready:true,verified:{persistentCrud:true,scopedRetrieval:true,immutableRecords:true,idempotentReplay:true,history:true,physicalErase:false},problems:[]};},
  async put(input){
   let control;try{control=JSON.parse(await readFile(configuration.controlFile,'utf8'));}catch{control={};}
   while(control.holdPut){control.putEntered=true;await writeFile(configuration.controlFile,JSON.stringify(control));await new Promise(resolve=>setTimeout(resolve,5));control=JSON.parse(await readFile(configuration.controlFile,'utf8'));}
   if(control.failPut){control.failPut--;await writeFile(configuration.controlFile,JSON.stringify(control));throw Error('Generated transport failure');}
   const fingerprint=hash(input),prior=state.receipts[input.opId];
   if(prior){if(prior.fingerprint!==fingerprint)throw Error('Generated intent conflict');return prior.value;}
   const existing=state.records.find(record=>matches(record,input));if(existing&&!same(existing.memory,input.memory))throw Error('Generated immutable conflict');
   if(!existing)state.records.push({namespace:input.namespace,key:input.key,memory:input.memory});
   const value=receipt(input,'applied');state.receipts[input.opId]={fingerprint,value};await save();
   if(control.losePutAck){control.losePutAck--;await writeFile(configuration.controlFile,JSON.stringify(control));throw Error('Generated committed write lost acknowledgement');}
   return value;
  },
  async read(input){return state.records.find(record=>matches(record,input))?.memory??null;},
  async remove(input){let control;try{control=JSON.parse(await readFile(configuration.controlFile,'utf8'));}catch{control={};}if(control.failRemove){control.failRemove--;await writeFile(configuration.controlFile,JSON.stringify(control));throw Error('Generated erase transport failure');}state.records=state.records.filter(record=>!matches(record,input));const value=receipt(input,'removed');await save();return value;},
  async search(input){const records=selected(input);return records.filter(record=>!input.keys||input.keys.some(key=>same(key,record.key))).slice(0,input.limit??records.length);},
  async export(input){return selected(input);},
  async close(){await save();}
 };
}
`;

function generatedRelease(options: {configuration?: PluginManifest['configuration']; entries?: Record<string, Uint8Array>; outsideAsset?: boolean} = {}) {
  const repository = 'generated-fixture/mote-adapter', tag = 'v1.0.0', commit = 'a'.repeat(40);
  let archive = zipSync(options.entries ?? {'provider.mjs': strToU8(generatedWorker)});
  const manifest: PluginManifest = {
    schemaVersion: 1, id: 'generated.fixed-release', name: 'Generated fixture adapter', version: '1.0.0', runtime: 'worker', entry: 'provider.mjs',
    archive: {asset: 'adapter.zip', sha256: sha256(archive)}, capabilities: ['repository', 'retrieval'],
    configuration: options.configuration ?? [
      {id: 'recordFile', label: 'Generated record file', type: 'text', required: true},
      {id: 'controlFile', label: 'Generated control file', type: 'text', required: true},
      {id: 'label', label: 'Generated runtime revision', type: 'text', required: true},
    ], dependencies: [], access: ['Generated fixture directory only'],
  };
  const base = `https://github.com/${repository}/releases/download/${tag}/`;
  let downloads = 0, downloadFailures = 0;
  const transport: PluginReleaseTransport = async url => {
    if (url === `https://api.github.com/repos/${repository}/releases/tags/${tag}`) return {bytes: strToU8(JSON.stringify({tag_name: tag, draft: false, assets: [
      {name: 'mote-plugin.json', browser_download_url: base + 'mote-plugin.json'},
      {name: 'adapter.zip', browser_download_url: options.outsideAsset ? 'https://untrusted.invalid/adapter.zip' : base + 'adapter.zip'},
    ]}))};
    if (url === `https://api.github.com/repos/${repository}/commits/${tag}`) return {bytes: strToU8(JSON.stringify({sha: commit}))};
    if (url === base + 'mote-plugin.json') return {bytes: strToU8(JSON.stringify(manifest))};
    if (url === base + 'adapter.zip') {downloads++; if (downloadFailures) {downloadFailures--; throw Error('Generated release download interruption');} return {bytes: archive};}
    throw new Error('Fixture transport rejects every unregistered URL: ' + url);
  };
  return {repository, tag, commit, manifest, transport, downloads: () => downloads, failNextDownload() {downloadFailures++;}, mutateArchive() {archive = strToU8('Generated changed release bytes');}};
}

async function waitFor(check: () => boolean, description: string) {
  const until = Date.now() + 5000;
  while (!check()) {assert.ok(Date.now() < until, description); await delay(5);}
}

function fixture(t: TestContext, release = generatedRelease(), durablePublication = false) {
  const directory = mkdtempSync(join(tmpdir(), 'mote-plugin-control-generated-'));
  let clock = Date.now(), store: Store, executor: ExecutionEngine, plugins: PluginCenter, automation: MemoryAutomation, memories: MemoryStore, bindings: MemoryBindings, publication: MemoryPublication | undefined;
  let tail = 0;
  function open() {
    store = new Store(directory); executor = new ExecutionEngine(store, () => clock);
    plugins = new PluginCenter(store, executor, new GitHubPluginReleases(join(directory, 'packages'), release.transport));
    automation = new MemoryAutomation(store, () => clock); memories = new MemoryStore(store);
    bindings = new MemoryBindings(store, memories, automation, plugins, executor);
    publication = durablePublication ? new MemoryPublication(store, memories, bindings) : undefined;
    bindings.pendingTail = () => tail + (publication?.pending() ?? 0);
    // The generated provider's actual worker health is projected into the
    // control view just as a host compatibility adapter projects its probe.
    plugins.probe = async (id, signal) => {
      const health = await bindings.provider(id).recover({namespace: {ownerId: 'mote-owner', instanceId: id, bindingRevision: 1}});
      signal.throwIfAborted();
      return {capabilities: plugins.packageForInstance(id).manifest.capabilities.map(capability => ({id: capability, state: health.ready && (capability === 'repository' ? health.verified.persistentCrud && health.verified.immutableRecords && health.verified.idempotentReplay : capability === 'retrieval' && health.verified.scopedRetrieval) ? 'verified' as const : 'unknown' as const})), issues: health.problems};
    };
  }
  async function close() {await executor.close(); await publication?.close(); await bindings.close(); await plugins.close(); store.close();}
  open(); t.after(async () => {await close(); rmSync(directory, {recursive: true, force: true});});
  return {
    directory, release, get store() {return store;}, get executor() {return executor;}, get plugins() {return plugins;}, get automation() {return automation;}, get memories() {return memories;}, get bindings() {return bindings;}, get publication() {return publication;},
    setTail(value: number) {tail = value;}, async advance() {clock += 1001; await executor.tick();}, async restart() {await close(); open();},
    configuration(label = 'one') {return {recordFile: join(directory, 'generated-records.json'), controlFile: join(directory, 'generated-control.json'), label};},
    failNextWrite() {writeFileSync(join(directory, 'generated-control.json'), JSON.stringify({failPut: 1}));},
    failNextRemoval() {writeFileSync(join(directory, 'generated-control.json'), JSON.stringify({failRemove: 1}));},
    holdWrites() {writeFileSync(join(directory, 'generated-control.json'), JSON.stringify({holdPut: true}));},
    writeEntered() {try {return JSON.parse(readFileSync(join(directory, 'generated-control.json'), 'utf8')).putEntered === true;} catch {return false;}},
    releaseWrites(losePutAck = false) {writeFileSync(join(directory, 'generated-control.json'), JSON.stringify({holdPut: false, losePutAck: Number(losePutAck)}));},
  };
}
type Fixture = ReturnType<typeof fixture>;
const pluginCommand = (f: Fixture) => ({operationId: randomUUID(), expectedRevision: f.plugins.revision()});
const instanceCommand = (f: Fixture, id: string) => ({operationId: randomUUID(), expectedRevision: f.plugins.instanceView(id).revision});
const bindingCommand = (f: Fixture) => ({operationId: randomUUID(), expectedRevision: f.bindings.view().revision});

async function install(f: Fixture) {
  const preview = await f.plugins.resolve({repository: f.release.repository, tag: f.release.tag});
  const command = {...pluginCommand(f), previewId: preview.id};
  f.plugins.install(command);
  await waitFor(() => f.plugins.view().packages[0]?.state !== 'installing', 'generated release installation settles');
  assert.equal(f.plugins.view().packages[0]?.state, 'installed');
  return {preview, command, packageId: f.plugins.view().packages[0]!.id};
}
async function enabled(f: Fixture): Promise<PluginInstanceView> {
  const {packageId} = await install(f);
  const instance = f.plugins.configure(undefined, {...pluginCommand(f), packageId, name: 'Generated storage/retrieval', scope: 'default', configuration: f.configuration()});
  f.plugins.action(instance.id, 'check', instanceCommand(f, instance.id));
  await waitFor(() => f.plugins.instanceView(instance.id).observed !== 'checking', 'generated worker check settles');
  assert.equal(f.plugins.instanceView(instance.id).observed, 'ready');
  return f.plugins.action(instance.id, 'enable', instanceCommand(f, instance.id));
}
async function generatedMemory(f: Fixture, externalId: string, statement = 'The generated observatory has a violet telescope.', independentlyReviewed = true) {
  const sources = new SourceStore(f.store);
  if (!f.store.db.prepare('SELECT 1 FROM source_connections WHERE id=?').get('generated')) sources.register({id: 'generated', name: 'Generated originals', kind: 'custom', deviceId: 'generated', platform: 'import'});
  const record = await sources.upsert('generated', {externalId, revision: '1', observedAt: '2026-10-12T00:00:00Z', text: statement, kind: 'message', layer: 'original'});
  const result: QueryResult = {runId: 'generated-model-' + externalId, answer: JSON.stringify({memories: [{title: 'Generated ' + externalId, statement: statement + ` [${record.id}]`, uncertainty: 'Generated fixture only', evidenceIds: [record.id]}]}), citations: [{id: record.id, capturedAt: '2026-10-12T00:00:00Z', appName: 'Generated', excerpt: statement}], trace: []};
  const draft = fixtureMemoryResult(f.memories, result);
  if (!independentlyReviewed) return f.memories.get(f.memories.extract(draft, 'generated-model').items[0]!.id);
  // A generated model makes the explicit independent/deletion verdict. These
  // transport fixtures make no assertion about a real model's interpretation.
  const reviewed = await reviewMemory({question: 'Review generated fixture evidence', skill: 'memory-extraction', responseMode: 'memory-extraction', evidenceIds: [record.id]}, draft, async input => input.question.startsWith('Host Memory deletion review.') ? {...draft, answer: JSON.stringify({sameConclusion: false, newSupportEvidenceIds: []})} : {...draft, runId: 'generated-independent-review-' + externalId}, {deletions: f.memories.deletions});
  const saved = f.memories.extract(reviewed, 'generated-model', {reviewReceipt: memoryReviewReceipt(reviewed)}).items[0]!;
  return f.memories.get(saved.id);
}
async function verifiedPreparation(f: Fixture, targetPlanId: string) {
  const result = f.bindings.prepare({...bindingCommand(f), targetPlanId, scope: 'default', feeAcknowledged: true});
  await waitFor(() => ['verified', 'blocked', 'failed'].includes(f.bindings.view().preparation?.state ?? ''), 'generated content migration settles');
  assert.equal(f.bindings.view().preparation?.state, 'verified');
  assert.ok(f.bindings.view().allowedActions.includes('activate'), 'the shared owner descriptor must expose verified activation to actual clients');
  assert.ok(f.bindings.view().allowedActions.includes('cancel'), 'verified preparation remains cancellable through the global descriptor');
  return result.preparation!.operationId;
}

test('fixed GitHub preview, install and lost-response replay remain durable; check and enable never bind', async t => {
  const f = fixture(t), {preview, command, packageId} = await install(f);
  assert.deepEqual(preview.source, {repository: f.release.repository, tag: f.release.tag, commit: f.release.commit, digest: f.release.manifest.archive.sha256});
  assert.ok(preview.capabilities.every(capability => capability.state === 'unknown'));
  const downloads = f.release.downloads(), revision = f.plugins.revision();
  f.plugins.install(command); assert.equal(f.plugins.revision(), revision); assert.equal(f.release.downloads(), downloads);
  await f.restart(); f.plugins.install(command); assert.equal(f.plugins.view().packages[0]!.id, packageId); assert.equal(f.release.downloads(), downloads);
  const create = {...pluginCommand(f), packageId, name: 'Generated instance', scope: 'default', configuration: f.configuration()};
  const instance = f.plugins.configure(undefined, create);
  assert.deepEqual(f.plugins.configure(undefined, create), instance); assert.equal(f.plugins.view().instances.length, 1);
  assert.equal(instance.desired, false); assert.ok(instance.capabilities.every(value => value.state === 'unknown'));
  assert.throws(() => f.plugins.action(instance.id, 'enable', instanceCommand(f, instance.id)), /unavailable/);
  const check = instanceCommand(f, instance.id); f.plugins.action(instance.id, 'check', check);
  await waitFor(() => f.plugins.instanceView(instance.id).observed !== 'checking', 'real generated worker health completes');
  f.plugins.action(instance.id, 'check', check);
  const enable = instanceCommand(f, instance.id); f.plugins.action(instance.id, 'enable', enable); f.plugins.action(instance.id, 'enable', enable);
  assert.equal(f.plugins.instanceView(instance.id).desired, true);
  assert.equal(f.bindings.binding().planId, 'mote.builtin', 'enabled instance is not an authoritative binding');
  await f.restart(); assert.equal(f.plugins.instanceView(instance.id).desired, true); assert.equal(f.bindings.binding().planId, 'mote.builtin');
});

test('scope, undeclared credentials, missing model references, revisions and reused intents cannot bypass control', async t => {
  const release = generatedRelease({configuration: [
    {id: 'model', label: 'Model profile', type: 'model-profile', required: true},
    {id: 'secret', label: 'Opaque credential reference', type: 'secret-reference'},
  ]}), f = fixture(t, release), {packageId} = await install(f);
  f.plugins.configurationAllowed = (field, value) => field.id === 'model' ? value === 'generated-existing-profile' : value === 'model:generated-existing-profile';
  const create = () => ({...pluginCommand(f), packageId, name: 'Generated references', scope: 'default', configuration: {model: 'generated-existing-profile', secret: 'model:generated-existing-profile'}});
  assert.throws(() => f.plugins.configure(undefined, {...create(), scope: 'another-owner'}));
  assert.throws(() => f.plugins.configure(undefined, {...create(), configuration: {model: 'missing-profile'}}), /unavailable/);
  assert.throws(() => f.plugins.configure(undefined, {...create(), configuration: {model: 'generated-existing-profile', secret: 'plaintext-generated-not-a-secret'}}), /unavailable/);
  assert.throws(() => f.plugins.configure(undefined, {...create(), configuration: {...create().configuration, apiKey: 'undeclared'}}), /Unknown/);
  assert.equal(f.plugins.view().instances.length, 0);
  const intent = create(), instance = f.plugins.configure(undefined, intent), current = f.plugins.revision();
  assert.throws(() => f.plugins.configure(undefined, {...intent, name: 'Changed payload'}), /identity conflict/);
  assert.throws(() => f.plugins.configure(instance.id, {...create(), expectedRevision: instance.revision + 20}), /changed/);
  assert.equal(f.plugins.revision(), current); assert.equal(f.plugins.instanceView(instance.id).secretStatus.secret, true);
  assert.ok(!JSON.stringify(f.plugins.view()).includes('plaintext-generated-not-a-secret'));
  assert.throws(() => f.bindings.prepare({...bindingCommand(f), targetPlanId: 'instance:' + instance.id, scope: 'another-owner', feeAcknowledged: true}));
});

test('pause drains existing source authority, resume never authorizes the gap, and immediate stop revokes the old work', async t => {
  const f = fixture(t), grants = new MemoryInputAuthorization(f.store, () => f.bindings.accepting()), sources = new SourceStore(f.store, undefined, grants);
  sources.register({id: 'generated', name: 'Generated admission', kind: 'custom', deviceId: 'generated', platform: 'import'});
  const receive = (externalId: string) => sources.upsert('generated', {externalId, revision: '1', observedAt: '2026-10-12T00:00:00Z', text: 'Generated ' + externalId, kind: 'message', layer: 'original'});
  const old = await receive('before-pause'); let running = 1;
  f.automation.counts = () => ({queued: 0, running, checkpointed: 0, resultUnknown: 0});
  const pause = bindingCommand(f); assert.equal(f.automation.command('pause', pause).state, 'draining');
  f.automation.command('pause', pause); assert.equal(grants.available('generated', old.id), true);
  const gap = await receive('paused-gap'); assert.equal(grants.available('generated', gap.id), false);
  running = 0; assert.equal(f.automation.view().state, 'paused');
  const generation = f.automation.state().generation;
  f.automation.command('resume', bindingCommand(f)); assert.equal(f.automation.state().generation, generation + 1);
  assert.equal(grants.available('generated', old.id), true); assert.equal(grants.available('generated', gap.id), false);
  assert.equal((await receive('paused-gap')).id, gap.id); assert.equal(grants.available('generated', gap.id), false);
  const next = await receive('after-resume'); assert.equal(grants.available('generated', next.id), true);
  f.automation.onStop = () => {f.store.db.prepare('UPDATE memory_input_authorizations SET revoked_at=1 WHERE authorized=1 AND revoked_at IS NULL').run();};
  f.automation.command('stop', bindingCommand(f)); assert.equal(grants.available('generated', old.id), false); assert.equal(grants.available('generated', next.id), false);
  await f.restart(); assert.equal(f.automation.view().state, 'paused'); assert.equal(f.automation.state().desired, false);
});

test('failed migration keeps the old plan; retry freezes admission, reconciles the tail, verifies exact correction history, then activates by CAS', async t => {
  const f = fixture(t), instance = await enabled(f), original = await generatedMemory(f, 'original');
  const correction = f.memories.get((await f.memories.correct(original.id, {version: original.version, title: 'Generated correction', statement: 'The generated telescope is silver.', uncertainty: 'Explicit generated fixture correction'})).id);
  const rejected = await generatedMemory(f, 'deleted', 'The generated observatory has a red roof.');
  f.memories.delete(rejected.id); const tombstones = f.memories.deletions.snapshot();
  f.failNextWrite(); const request = {...bindingCommand(f), targetPlanId: 'instance:' + instance.id, scope: 'default', feeAcknowledged: true};
  f.bindings.prepare(request);
  await waitFor(() => f.bindings.view().preparation?.state === 'blocked', 'generated copy failure is projected');
  assert.ok(f.bindings.view().allowedActions.includes('retry')); assert.ok(f.bindings.view().allowedActions.includes('cancel'));
  assert.ok(!f.bindings.view().allowedActions.includes('activate'), 'a failed preparation must not advertise activation');
  assert.equal(f.bindings.binding().planId, 'mote.builtin'); assert.equal(f.bindings.accepting(), true);
  assert.equal(f.bindings.view().preparation?.oldAdmissionFrozen, false);
  f.setTail(1); f.bindings.action('retry', {...bindingCommand(f), preparationId: request.operationId});
  await waitFor(() => f.bindings.view().preparation?.phase === 'drain' && f.executor.get('memory-prepare:' + request.operationId)?.state === 'waiting', 'cutover holds for the authorized tail');
  assert.equal(f.bindings.binding().planId, 'mote.builtin'); assert.equal(f.automation.state().desired, true); assert.equal(f.bindings.accepting(), false);
  assert.equal(f.bindings.view().preparation?.tail, 1);
  assert.throws(() => f.automation.command('resume', bindingCommand(f)), /prepared switch/);
  const tail = await generatedMemory(f, 'authorized-tail', 'An already authorized generated task adds a blue door.');
  f.setTail(0); await f.advance();
  await waitFor(() => f.bindings.view().preparation?.state === 'verified', 'the exact tail is copied before ready');
  const ready = f.bindings.view(); assert.ok(ready.allowedActions.includes('activate')); assert.ok(ready.allowedActions.includes('cancel')); assert.equal(ready.activePlan.id, 'mote.builtin'); assert.equal(ready.preparation?.tail, 0); assert.ok(ready.preparation!.checks.every(check => check.state === 'verified'));
  const activate = {...bindingCommand(f), preparationId: request.operationId};
  assert.throws(() => f.bindings.action('activate', {...activate, operationId: randomUUID(), expectedRevision: activate.expectedRevision - 1}), /changed/);
  f.bindings.action('activate', activate); const generation = f.bindings.binding().generation;
  f.bindings.action('activate', activate); assert.equal(f.bindings.binding().generation, generation);
  assert.equal(f.bindings.binding().planId, 'instance:' + instance.id); assert.equal(f.bindings.accepting(), true);
  assert.deepEqual(await f.bindings.read(correction.id), correction); assert.deepEqual(await f.bindings.read(tail.id), tail);
  assert.deepEqual(await f.bindings.read(original.id), f.memories.get(original.id));
  const namespace = f.bindings.binding().namespace!;
  assert.equal(await f.bindings.provider(instance.id).read({namespace, key: memoryProviderKey(rejected)}), null);
  assert.equal(f.memories.deletions.snapshot(), tombstones, 'the host deletion ledger is retained');
  await f.restart(); assert.equal(f.bindings.binding().planId, 'instance:' + instance.id); assert.deepEqual(await f.bindings.read(correction.id), correction);
});

test('verified preparation cannot apply after metadata changes; cancel releases admission without switching', async t => {
  const f = fixture(t), instance = await enabled(f), memory = await generatedMemory(f, 'prepared');
  const preparationId = await verifiedPreparation(f, 'instance:' + instance.id);
  await f.memories.correct(memory.id, {version: memory.version, title: 'Changed after verification', statement: 'Generated changed body', uncertainty: 'Generated race'});
  assert.throws(() => f.bindings.action('activate', {...bindingCommand(f), preparationId}), /changed after verification/);
  assert.equal(f.bindings.binding().planId, 'mote.builtin'); assert.equal(f.bindings.accepting(), false);
  f.bindings.action('cancel', {...bindingCommand(f), preparationId}); assert.equal(f.bindings.accepting(), true); assert.equal(f.bindings.binding().planId, 'mote.builtin');
});

for (const lostAcknowledgement of [false, true]) test(`real worker migration cancelled after submission ${lostAcknowledgement ? 'with a lost acknowledgement' : 'with an acknowledgement'} preserves the old binding and reconciles later source deletion after restart`, async t => {
  const f = fixture(t, generatedRelease(), true), instance = await enabled(f), memory = await generatedMemory(f, 'cancelled-migration');
  const sourceBinding = f.bindings.binding(), targetNamespace = {ownerId: 'mote-owner', instanceId: instance.id, bindingRevision: sourceBinding.generation + 1};
  f.holdWrites();
  const preparationId = randomUUID();
  f.bindings.prepare({...bindingCommand(f), operationId: preparationId, targetPlanId: 'instance:' + instance.id, scope: 'default', feeAcknowledged: true});
  await waitFor(() => f.writeEntered(), 'the actual generated release worker entered the submitted migration put');
  const intent = f.store.db.prepare("SELECT id,json,state FROM memory_provider_writes WHERE json_extract(json,'$.namespace.bindingRevision')=? AND json_extract(json,'$.key.memoryId')=?").get(targetNamespace.bindingRevision, memory.id)!;
  assert.ok(intent, 'the host journals the target write before the real worker acknowledges it');
  assert.equal(intent.state, 'submitted');
  assert.deepEqual(JSON.parse(String(intent.json)).namespace, targetNamespace);
  f.bindings.action('cancel', {...bindingCommand(f), preparationId});
  f.releaseWrites(lostAcknowledgement);
  await waitFor(() => !f.executor.isActiveStep('memory-prepare:' + preparationId), 'cancelled migration transport settles without activating');
  // A cancelled host step may settle before a submitted worker RPC. Observe
  // the actual native commit rather than equating its local state with rollback.
  await waitFor(() => {
    try {return JSON.parse(readFileSync(f.configuration().recordFile, 'utf8')).records.some((record: {namespace: unknown;key: unknown}) => JSON.stringify(record.namespace) === JSON.stringify(targetNamespace) && JSON.stringify(record.key) === JSON.stringify(memoryProviderKey(memory)));} catch {return false;}
  }, 'the cancelled worker put commits its exact late body');
  if (!lostAcknowledgement) await waitFor(() => f.store.db.prepare('SELECT state FROM memory_provider_writes WHERE id=?').get(intent.id)!.state === 'acknowledged', 'the exact late worker acknowledgement reaches its durable host journal');
  assert.equal(f.store.db.prepare('SELECT state FROM memory_provider_writes WHERE id=?').get(intent.id)!.state, lostAcknowledgement ? 'submitted' : 'acknowledged');
  assert.deepEqual(f.bindings.binding(), sourceBinding);
  assert.equal(f.bindings.view().preparation?.state, 'cancelled');
  assert.deepEqual(await f.bindings.provider(instance.id).read({namespace: targetNamespace, key: memoryProviderKey(memory)}), memory, 'cancellation does not silently add an external retention policy');
  if (lostAcknowledgement) {
    f.plugins.action(instance.id, 'disable', instanceCommand(f, instance.id));
    assert.throws(() => f.plugins.uninstall(instance.packageId, pluginCommand(f)), /migrate|unresolved|retained/i, 'an unknown target write retains the release needed for reconciliation');
  }
  await f.restart();
  assert.deepEqual(f.bindings.binding(), sourceBinding);
  assert.deepEqual(await f.bindings.read(memory.id), memory, 'owner reads retain the old authority after host restart');
  const snapshot = f.bindings.retainSnapshot();
  assert.equal(snapshot.binding.namespace, undefined, 'read snapshots never expose the unactivated target namespace');
  assert.deepEqual(snapshot.records?.[memory.id], memory);
  snapshot.release();
  await f.publication!.reconcile();
  assert.equal(f.publication!.pending(), 0);
  assert.equal(f.store.db.prepare('SELECT state FROM memory_provider_writes WHERE id=?').get(intent.id)!.state, 'acknowledged', 'recovery observes the exact committed body without another migration put');
  assert.deepEqual(await f.bindings.provider(instance.id).read({namespace: targetNamespace, key: memoryProviderKey(memory)}), memory, 'reconciliation preserves the cancelled canonical stage until an actual revocation');
  f.store.delete(memory.evidenceIds[0]!);
  await f.publication!.reconcile();
  assert.equal(f.publication!.pending(), 0);
  assert.equal(await f.bindings.provider(instance.id).read({namespace: targetNamespace, key: memoryProviderKey(memory)}), null, 'explicit source deletion erases the retained target through its durable namespace journal');
  const retired = JSON.parse(String(f.store.db.prepare('SELECT json FROM memory_provider_writes WHERE id=?').get(intent.id)!.json));
  assert.equal(retired.privateRetired, true);
  assert.equal(retired.memory, undefined);
  assert.deepEqual(f.bindings.binding(), sourceBinding);
});

test('a query snapshot retains the former provider through reverse migration and prevents uninstall until released', async t => {
  const f = fixture(t), instance = await enabled(f), memory = await generatedMemory(f, 'reader');
  const outward = await verifiedPreparation(f, 'instance:' + instance.id);
  f.bindings.action('activate', {...bindingCommand(f), preparationId: outward});
  const reader = f.bindings.retainSnapshot(), inward = await verifiedPreparation(f, 'mote.builtin');
  f.bindings.action('activate', {...bindingCommand(f), preparationId: inward});
  f.plugins.action(instance.id, 'disable', instanceCommand(f, instance.id));
  assert.equal(f.plugins.instanceView(instance.id).observed, 'draining');
  assert.ok(f.plugins.instanceView(instance.id).issues.some(issue => issue.includes('queries')));
  assert.deepEqual(await f.bindings.read(memory.id, reader.binding, reader.catalog[memory.id]), memory);
  assert.throws(() => f.plugins.uninstall(instance.packageId, pluginCommand(f)), /migrate/);
  reader.release(); reader.release();
  assert.ok(f.plugins.view().packages[0]!.allowedActions.includes('uninstall'));
  f.plugins.uninstall(instance.packageId, pluginCommand(f)); assert.equal(f.plugins.view().packages.length, 0);
  assert.deepEqual(await f.bindings.read(memory.id), memory, 'uninstall never deletes retained host memory');
});

test('external staged bodies do not publish metadata until committed, and a previous binding receipt is fenced after cutover', async t => {
  const f = fixture(t), instance = await enabled(f), outward = await verifiedPreparation(f, 'instance:' + instance.id);
  f.bindings.action('activate', {...bindingCommand(f), preparationId: outward});
  const sources = new SourceStore(f.store); sources.register({id: 'generated', name: 'Generated publication', kind: 'custom', deviceId: 'generated', platform: 'import'});
  const record = await sources.upsert('generated', {externalId: 'publication', revision: '1', observedAt: '2026-10-12T00:00:00Z', text: 'Generated publication evidence.', kind: 'message', layer: 'original'});
  const result = fixtureMemoryResult(f.memories, {answer: JSON.stringify({memories: [{title: 'Generated staged body', statement: `Generated publication [${record.id}]`, uncertainty: 'Generated fixture only', evidenceIds: [record.id]}]}), citations: [{id: record.id, capturedAt: '2026-10-12T00:00:00Z', appName: 'Generated', excerpt: 'Generated publication evidence.'}], trace: [], runId: 'generated-publication'});
  const publication = new MemoryPublication(f.store, f.memories, f.bindings), operationId = randomUUID();
  let authorized = true; const assertAuthority = () => {assert.ok(authorized, 'generated original operation authority remains current');};
  const receipt = await publication.stageExtract(operationId, result, 'generated-model', {}, assertAuthority);
  assert.ok(receipt); assert.equal(f.memories.list().length, 0, 'external staging is not host publication');
  assert.equal(JSON.stringify(await publication.stageExtract(operationId, result, 'generated-model', {}, assertAuthority)), JSON.stringify(receipt), 'response loss replays the exact body');
  publication.assert(receipt, result);
  const changed = receipt.prepared.changed[0]!;
  assert.equal(JSON.stringify(await f.bindings.provider(instance.id).read({namespace: receipt.binding.namespace!, key: memoryProviderKey(changed)})), JSON.stringify(changed));
  const inward = await verifiedPreparation(f, 'mote.builtin'); f.bindings.action('activate', {...bindingCommand(f), preparationId: inward}); authorized = false;
  assert.throws(() => publication.assert(receipt, result), /binding changed/);
  assert.equal(f.memories.list().length, 0, 'late previous-provider writer cannot commit host metadata');
});

test('reviewed archives reject substituted bytes, traversal paths and assets outside the selected release', async t => {
  const f = fixture(t), release = await f.plugins.releases.resolve({repository: f.release.repository, tag: f.release.tag});
  f.release.mutateArchive(); await assert.rejects(f.plugins.releases.install(release), /changed after review/);
  const traversal = generatedRelease({entries: {'provider.mjs': strToU8(generatedWorker), '../escape.mjs': strToU8('generated')}});
  await assert.rejects(new GitHubPluginReleases(join(f.directory, 'traversal'), traversal.transport).resolve({repository: traversal.repository, tag: traversal.tag}), /Invalid package path|archive is invalid/);
  const outside = generatedRelease({outsideAsset: true});
  await assert.rejects(new GitHubPluginReleases(join(f.directory, 'outside'), outside.transport).resolve({repository: outside.repository, tag: outside.tag}), /outside the selected/);
});

test('reconfiguring a checked disabled instance recreates the worker with the new configuration', async t => {
  const f = fixture(t), {packageId} = await install(f);
  const instance = f.plugins.configure(undefined, {...pluginCommand(f), packageId, name: 'Generated reconfiguration', scope: 'default', configuration: f.configuration('one')});
  const health = () => f.plugins.runtime(instance.id).call('health', {namespace: {ownerId: 'mote-owner', instanceId: instance.id, bindingRevision: 1}}) as Promise<{version: string}>;
  assert.equal((await health()).version, 'one');
  f.plugins.configure(instance.id, {...instanceCommand(f, instance.id), name: instance.name, scope: 'default', configuration: f.configuration('two')});
  assert.equal((await health()).version, 'two', 'the old process must not retain replaced instance configuration');
});

test('reusing a pinned cached archive verifies executable file bytes, not merely its digest lock', async t => {
  const f = fixture(t), release = await f.plugins.releases.resolve({repository: f.release.repository, tag: f.release.tag});
  const directory = await f.plugins.releases.install(release), entry = join(directory, 'provider.mjs');
  writeFileSync(entry, '// Generated tampering regression\n');
  await assert.rejects(f.plugins.releases.install(release), /integrity|changed|tamper/i);
  assert.notEqual(readFileSync(entry, 'utf8'), generatedWorker, 'test really substituted the cached executable');
});

test('an explicitly retried failed install of the same reviewed artifact schedules fresh execution', async t => {
  const f = fixture(t), preview = await f.plugins.resolve({repository: f.release.repository, tag: f.release.tag});
  f.release.failNextDownload(); const failedIntent = {...pluginCommand(f), previewId: preview.id}; f.plugins.install(failedIntent);
  await waitFor(() => f.plugins.view().packages[0]?.state === 'failed', 'generated download failure settles');
  f.plugins.install(failedIntent); assert.equal(f.plugins.view().packages[0]!.state, 'failed', 'lost-response replay must not invent a new retry intent');
  const retried = f.plugins.install({...pluginCommand(f), previewId: preview.id});
  assert.equal(retried.packages[0]!.state, 'installing', 'explicit retry must not return the permanently failed package unchanged');
  await waitFor(() => f.plugins.view().packages[0]?.state !== 'installing', 'explicit installation retry settles');
  assert.equal(f.plugins.view().packages[0]!.state, 'installed');
});

test('actual HTTP plugin controls authorize owner sessions, reject MCP credentials, and enforce revision plus scope before mutation', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'mote-plugin-http-generated-')), owner = 'generated-plugin-owner-' + randomUUID();
  const config: Config = {dataDir: directory, token: owner, tokenPath: join(directory, 'owner-token'), host: '127.0.0.1', port: 0, profile: 'test', tokenFromEnvironment: true, maxStorageBytes: 30 * 1024 * 1024, maxExportBytes: 1024 * 1024, retentionDays: 0, insightIntervalHours: 0, allowedOrigins: [], model: '', modelBaseUrl: 'https://api.deepseek.com', apiKey: '', allowUnauthenticatedLocal: false, embeddingModel: '', embeddingBaseUrl: '', embeddingApiKey: '', logLevel: 'silent', connectors: {directory: join(directory, 'connectors'), mcpEnabled: true, mcpReadToken: 'generated-static-read-mcp-token', mcpWriteEnabled: true, mcpWriteToken: 'generated-static-write-mcp-token', mcpWriteSourceIds: ['generated']}};
  const node = await buildApp(config, {backgroundWorker: false, agent: {configured: false, async query() {throw Error('No model request belongs in this HTTP authorization fixture');}, async close() {}}});
  t.after(async () => {await node.app.close(); rmSync(directory, {recursive: true, force: true});});
  const headers = (token: string) => ({authorization: 'Bearer ' + token});
  const session = await node.connections.session('http://127.0.0.1:47832', 'Generated paired owner', {deviceId: 'generated-owner-phone', deviceName: 'Generated owner phone', platform: 'android'});
  const mcp = await node.connections.mintMcp({serverUrl: 'http://127.0.0.1:47832', label: 'Generated read-only context credential', access: 'read'}, config.connectors);
  const readToken = mcp.config.mcpServers.mote.headers.Authorization.slice(7);
  const routes: Array<{method: 'GET' | 'POST' | 'PATCH'; url: string}> = [
    {method: 'GET', url: '/api/plugins'}, {method: 'GET', url: '/api/memory-spaces/default/binding'},
    ...['resolve', 'install', 'generated/uninstall'].map(path => ({method: 'POST' as const, url: '/api/plugins/' + path})),
    {method: 'POST', url: '/api/plugin-instances'}, {method: 'PATCH', url: '/api/plugin-instances/generated'},
    ...['check', 'enable', 'disable'].map(action => ({method: 'POST' as const, url: '/api/plugin-instances/generated/' + action})),
    ...['pause', 'resume', 'stop', 'prepare', 'activate', 'retry', 'cancel'].map(action => ({method: 'POST' as const, url: '/api/memory-spaces/default/binding/' + action})),
  ];
  for (const route of routes) {
    const payload = route.method === 'GET' ? undefined : {};
    assert.equal((await node.app.inject({...route, payload})).statusCode, 401, route.url);
    assert.equal((await node.app.inject({...route, payload, headers: headers(readToken)})).statusCode, 403, route.url);
  }
  for (const token of [owner, session.token]) {
    assert.equal((await node.app.inject({url: '/api/plugins', headers: headers(token)})).statusCode, 200);
    assert.equal((await node.app.inject({url: '/api/memory-spaces/default/binding', headers: headers(token)})).statusCode, 200);
  }
  const initial = node.memoryBindings.view(), pause = {operationId: randomUUID(), expectedRevision: initial.revision};
  const request = (action: string, payload: unknown) => node.app.inject({method: 'POST', url: '/api/memory-spaces/default/binding/' + action, headers: headers(session.token), payload});
  assert.equal((await request('pause', pause)).statusCode, 200);
  assert.equal((await request('pause', pause)).json().revision, node.memoryBindings.view().revision);
  assert.equal((await request('resume', {operationId: randomUUID(), expectedRevision: initial.revision})).statusCode, 409);
  const revision = node.memoryBindings.view().revision;
  assert.equal((await request('prepare', {operationId: randomUUID(), expectedRevision: revision, targetPlanId: 'mote.builtin', scope: 'another-owner', feeAcknowledged: true})).statusCode, 400);
  assert.equal(node.memoryBindings.view().revision, revision);
  const resumed = await request('resume', {operationId: randomUUID(), expectedRevision: revision}); assert.equal(resumed.statusCode, 200);
  assert.equal(resumed.json().admission.generation, initial.admission.generation + 1);
  await node.connections.revoke(session.credentialId);
  assert.equal((await node.app.inject({url: '/api/plugins', headers: headers(session.token)})).statusCode, 401);
});

test('real integration retries exact externally staged reviewed output without regeneration and admits no new manual write behind cutover', async t => {
  const f = fixture(t), instance = await enabled(f), first = await generatedMemory(f, 'integration-one'), second = await generatedMemory(f, 'integration-two', 'The generated dome uses a silver telescope.');
  const outward = await verifiedPreparation(f, 'instance:' + instance.id); f.bindings.action('activate', {...bindingCommand(f), preparationId: outward});
  const publication = new MemoryPublication(f.store, f.memories, f.bindings), lifecycle = new MemoryLifecycle(f.store, () => true, Date.now, f.executor);
  const pipeline = new MemoryPipeline({store: f.store, memories: f.memories, executor: f.executor, publication, assertNewManualWork: () => f.bindings.assertNewManualWork(), model: () => 'generated-model', configured: () => true, requireAdmission: true, async query() {throw Error('Integration must use its independently supplied generated query');}});
  const settings = new MemoryIntegrationSettings(f.store, pipeline.strategies);
  const originals = f.memories.readEvidence([...new Set([...first.evidenceIds, ...second.evidenceIds])]); let calls = 0;
  const result: QueryResult = {answer: JSON.stringify({memories: [{domain: 'personal', title: 'Generated integrated observatory', statement: 'The generated fixtures describe two telescope observations. ' + originals.map(record => `[${record.id}]`).join(' '), uncertainty: 'Generated transport fixture only', evidenceIds: originals.map(record => record.id), evidence: originals.map(record => ({id: record.id, quote: record.ocrText})), relatedMemoryIds: [first.id, second.id], admission: {layer: 'memory', reason: 'Generated model selects a synthetic integration', scope: 'Generated fixture only', attribution: 'observed'}}]}), citations: originals.map(record => ({id: record.id, capturedAt: record.capturedAt, appName: 'Generated', excerpt: record.ocrText})), trace: [], runId: 'generated-integration'};
  registerMemoryIntegration({lifecycle, memories: f.memories, pipeline, settings, query: async () => ({...result, runId: 'generated-integration-pass-' + ++calls})});
  try {
    const recipe = pipeline.strategies.listIntegrations()[0]!;
    const selected = {recipe: {id: recipe.id, version: recipe.version}, inputs: [first, second].map(memory => ({id: memory.id, version: memory.version, fingerprint: memory.fingerprint}))};
    f.failNextWrite(); const request = requestMemoryIntegration(selected, {lifecycle, memories: f.memories, pipeline});
    await lifecycle.tick(); assert.equal(calls, 2, 'generation and independent review ran once');
    assert.equal(f.memories.list().filter(memory => memory.tier === 'consolidated').length, 0);
    assert.equal(f.store.db.prepare("SELECT state FROM memory_publications WHERE id=?").get(request.operationId + ':integration:personal')?.state, 'staged');
    lifecycle.retry('consolidation', request.id); await lifecycle.tick();
    assert.equal(calls, 2, 'provider retry does not create another paid generation or review');
    const integrated = f.memories.list().filter(memory => memory.tier === 'consolidated'); assert.equal(integrated.length, 1);
    assert.deepEqual(await f.bindings.read(integrated[0]!.id), f.memories.get(integrated[0]!.id));
    assert.equal(f.store.db.prepare("SELECT state FROM memory_publications WHERE id=?").get(request.operationId + ':integration:personal')?.state, 'committed');
    const inward = await verifiedPreparation(f, 'mote.builtin');
    assert.throws(() => requestMemoryIntegration(selected, {lifecycle, memories: f.memories, pipeline}), /Finish or cancel/);
    f.bindings.action('cancel', {...bindingCommand(f), preparationId: inward});
  } finally {await pipeline.close(); await lifecycle.close();}
});

test('archive entry budget is checked before expanding an oversized generated bundle', async t => {
  const entries: Record<string, Uint8Array> = {'provider.mjs': strToU8(generatedWorker)};
  for (let index = 0; index < 20_000; index++) entries['generated-' + index] = new Uint8Array();
  const release = generatedRelease({entries}), f = fixture(t, release);
  await assert.rejects(f.plugins.releases.resolve({repository: release.repository, tag: release.tag}), /resource budget/);
  assert.equal(f.plugins.view().packages.length, 0, 'oversized metadata never reaches installation');
});

test('a worker whose close never resolves has a bounded physical shutdown and rejects future requests', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'mote-plugin-close-generated-')), entry = join(directory, 'blocked-close.mjs');
  writeFileSync(entry, `export async function createMemoryProvider(){setInterval(()=>{},1000);return {async health(){return {generated:true};},async close(){await new Promise(()=>{});}};}`);
  const runtime = new WorkerPluginRuntime(entry, {}, directory);
  // Independent timeout reports a regression; the test-only kill ensures a
  // broken implementation cannot leave a generated worker behind after failure.
  const process = (runtime as unknown as {process: {kill(signal: string): void}}).process;
  t.after(async () => {process.kill('SIGKILL'); await runtime.close(); rmSync(directory, {recursive: true, force: true});});
  assert.deepEqual(await runtime.call('health', {}), {generated: true});
  const until = Date.now(); let deadline: NodeJS.Timeout | undefined;
  try {
    await Promise.race([runtime.close(), new Promise<never>((_, reject) => {deadline = setTimeout(() => reject(Error('Generated worker close did not finish')), 8000);})]);
  } finally {clearTimeout(deadline);}
  assert.ok(Date.now() - until < 8000, 'host teardown cannot depend forever on plugin cooperation');
  await assert.rejects(runtime.call('health', {}), /closed|unavailable/);
});

test('owner publish and correction stage exact immutable revisions first; failed writes keep the authoritative original unchanged', async t => {
  const f = fixture(t), instance = await enabled(f), proposal = await generatedMemory(f, 'owner-proposal', 'Generated owner proposal evidence.', false);
  const outward = await verifiedPreparation(f, 'instance:' + instance.id); f.bindings.action('activate', {...bindingCommand(f), preparationId: outward});
  const publication = new MemoryPublication(f.store, f.memories, f.bindings);
  f.failNextWrite(); await assert.rejects(publication.withOwnerWork(() => publication.publish(proposal.id, proposal.version)), /failure|unavailable/);
  assert.deepEqual(f.memories.get(proposal.id), proposal); assert.deepEqual(await f.bindings.read(proposal.id), proposal);
  const published = await publication.withOwnerWork(() => publication.publish(proposal.id, proposal.version));
  assert.equal(published.status, 'published'); assert.equal(published.version, proposal.version + 1);
  assert.deepEqual(await f.bindings.read(published.id), f.memories.get(published.id));
  const before = f.memories.get(published.id), input = {version: before.version, title: 'Generated owner correction', statement: 'The generated owner explicitly corrects the telescope color.', uncertainty: 'Generated fixture only'};
  f.failNextWrite(); await assert.rejects(publication.withOwnerWork(() => publication.correct(before.id, input)), /failure|unavailable/);
  assert.deepEqual(f.memories.get(before.id), before); assert.deepEqual(await f.bindings.read(before.id), before);
  const correction = await publication.withOwnerWork(() => publication.correct(before.id, input)), corrected = f.memories.get(correction.id), superseded = f.memories.get(before.id);
  assert.equal(superseded.supersededBy, corrected.id); assert.equal(superseded.version, before.version + 1);
  assert.deepEqual(await f.bindings.read(corrected.id), corrected); assert.deepEqual(await f.bindings.read(superseded.id), superseded);
  const namespace = f.bindings.binding().namespace!, provider = f.bindings.provider(instance.id);
  assert.deepEqual(await provider.read({namespace, key: memoryProviderKey(proposal)}), proposal, 'earlier proposal history remains exact');
  assert.deepEqual(await provider.read({namespace, key: memoryProviderKey(before)}), before, 'superseding metadata never overwrites the earlier immutable revision');
  const count = f.memories.list().length, correctionNotes = Number(f.store.db.prepare("SELECT count(*) n FROM captures").get()!.n);
  await f.restart(); const recovered = new MemoryPublication(f.store, f.memories, f.bindings);
  const replay = await recovered.withOwnerWork(() => recovered.correct(before.id, input));
  assert.equal(replay.id, corrected.id, 'lost correction response replays the same durable identity after actual host restart');
  assert.equal(f.memories.list().length, count);
  assert.equal(Number(f.store.db.prepare("SELECT count(*) n FROM captures").get()!.n), correctionNotes, 'response loss never creates a second correction original');
});

test('privacy deletion during an external owner correction fences its late response without resurrecting a Memory card', async t => {
  const f = fixture(t), instance = await enabled(f), original = await generatedMemory(f, 'late-owner-correction');
  const outward = await verifiedPreparation(f, 'instance:' + instance.id); f.bindings.action('activate', {...bindingCommand(f), preparationId: outward});
  const publication = new MemoryPublication(f.store, f.memories, f.bindings); f.holdWrites();
  const work = publication.withOwnerWork(() => publication.correct(original.id, {version: original.version, title: 'Generated late correction', statement: 'Generated late external write', uncertainty: 'Generated fixture only'}));
  // Attach the rejection observer before changing authority to avoid treating
  // the intended asynchronous refusal as an unhandled process rejection.
  const refused = assert.rejects(work, /changed|not found|original|evidence/i);
  try {
    await waitFor(() => f.writeEntered(), 'generated worker has received the staged correction');
    f.store.delete(original.evidenceIds[0]!); f.releaseWrites(); await refused;
    assert.throws(() => f.memories.get(original.id), {statusCode: 404});
    assert.equal(f.memories.list().length, 0); await assert.rejects(f.bindings.read(original.id), {statusCode: 404});
  } finally {f.releaseWrites(); await work.catch(() => {});}
});

test('failed provider deletion retains its unknown erase intent while the host tombstone revokes reads immediately', async t => {
  const f = fixture(t), instance = await enabled(f), original = await generatedMemory(f, 'pending-owner-delete');
  const outward = await verifiedPreparation(f, 'instance:' + instance.id); f.bindings.action('activate', {...bindingCommand(f), preparationId: outward});
  const publication = new MemoryPublication(f.store, f.memories, f.bindings), namespace = f.bindings.binding().namespace!;
  f.failNextRemoval(); const deleted = await publication.delete(original.id);
  assert.equal(deleted.externalErase, 'pending'); assert.equal(deleted.physicalEraseVerified, false);
  assert.throws(() => f.memories.get(original.id), {statusCode: 404}); await assert.rejects(f.bindings.read(original.id), {statusCode: 404});
  assert.ok(f.memories.deletions.export().some(value => value.memoryId === original.id));
  assert.deepEqual(await f.bindings.provider(instance.id).read({namespace, key: memoryProviderKey(original)}), original, 'the fixture demonstrates an unconfirmed remote removal');
  assert.ok(publication.pending() > 0, 'unconfirmed deletion must remain durable and observable after host revocation');
  await f.restart(); const recovered = new MemoryPublication(f.store, f.memories, f.bindings);
  assert.ok(recovered.pending() > 0, 'an erase transport failure cannot disappear on restart');
  await recovered.delete(original.id); assert.equal(await f.bindings.provider(instance.id).read({namespace, key: memoryProviderKey(original)}), null);
  assert.equal(recovered.pending(), 0);
});


test('a late external publication cannot turn an earlier empty erase observation into completed deletion', async t => {
  const f = fixture(t), instance = await enabled(f), proposal = await generatedMemory(f, 'late-deleted-publication', 'Generated delayed publication evidence.', false);
  const outward = await verifiedPreparation(f, 'instance:' + instance.id); f.bindings.action('activate', {...bindingCommand(f), preparationId: outward});
  const publication = new MemoryPublication(f.store, f.memories, f.bindings), namespace = f.bindings.binding().namespace!;
  f.holdWrites(); const work = publication.withOwnerWork(() => publication.publish(proposal.id, proposal.version));
  const refused = assert.rejects(work, /changed|not found|original|publication/i);
  try {
    await waitFor(() => f.writeEntered(), 'generated publication write has reached the independent worker');
    const deleted = await publication.delete(proposal.id);
    assert.equal(deleted.externalErase, 'pending', 'an empty export cannot settle deletion while its earlier write is unresolved');
    assert.ok(publication.pending() > 0); assert.throws(() => f.memories.get(proposal.id), {statusCode: 404});
    f.releaseWrites(); await refused;
    const lateKey = {...memoryProviderKey(proposal), version: proposal.version + 1};
    assert.ok(await f.bindings.provider(instance.id).read({namespace, key: lateKey}), 'fixture actually exposes the late remote body');
    assert.ok(publication.pending() > 0, 'host publication refusal cannot acknowledge physical cleanup');
    await f.restart(); const recovered = new MemoryPublication(f.store, f.memories, f.bindings);
    assert.ok(recovered.pending() > 0); await recovered.reconcile(); assert.equal(recovered.pending(), 0);
    assert.equal(await f.bindings.provider(instance.id).read({namespace, key: lateKey}), null);
    assert.throws(() => f.memories.get(proposal.id), {statusCode: 404}); await assert.rejects(f.bindings.read(proposal.id), {statusCode: 404});
  } finally {f.releaseWrites(); await work.catch(() => {});}
});

test('an unresolved erase in a retained old namespace blocks configure and uninstall until reconciled', async t => {
  const f = fixture(t), instance = await enabled(f), memory = await generatedMemory(f, 'retained-delete');
  const outward = await verifiedPreparation(f, 'instance:' + instance.id); f.bindings.action('activate', {...bindingCommand(f), preparationId: outward});
  const oldNamespace = f.bindings.binding().namespace!, inward = await verifiedPreparation(f, 'mote.builtin');
  f.bindings.action('activate', {...bindingCommand(f), preparationId: inward}); f.plugins.action(instance.id, 'disable', instanceCommand(f, instance.id));
  const publication = new MemoryPublication(f.store, f.memories, f.bindings); f.failNextRemoval();
  assert.equal((await publication.delete(memory.id)).externalErase, 'pending');
  assert.deepEqual(await f.bindings.provider(instance.id).read({namespace: oldNamespace, key: memoryProviderKey(memory)}), memory);
  assert.ok(!f.plugins.view().packages[0]!.allowedActions.includes('uninstall'));
  assert.ok(!f.plugins.instanceView(instance.id).allowedActions.includes('configure'));
  assert.throws(() => f.plugins.uninstall(instance.packageId, pluginCommand(f)), /migrate/);
  await f.restart(); const recovered = new MemoryPublication(f.store, f.memories, f.bindings);
  assert.ok(!f.plugins.view().packages[0]!.allowedActions.includes('uninstall'), 'durable pending erase keeps the actual release retained after restart');
  await recovered.reconcile(); assert.equal(recovered.pending(), 0);
  assert.equal(await f.bindings.provider(instance.id).read({namespace: oldNamespace, key: memoryProviderKey(memory)}), null);
  assert.ok(f.plugins.view().packages[0]!.allowedActions.includes('uninstall'));
  f.plugins.uninstall(instance.packageId, pluginCommand(f)); assert.equal(f.plugins.view().packages.length, 0);
});

test('uninstalled private provider history remains erasable after restart without restoring an enabled plugin', async t => {
  const f = fixture(t), instance = await enabled(f), memory = await generatedMemory(f, 'uninstalled-history-delete');
  const outward = await verifiedPreparation(f, 'instance:' + instance.id); f.bindings.action('activate', {...bindingCommand(f), preparationId: outward});
  const oldNamespace = f.bindings.binding().namespace!, inward = await verifiedPreparation(f, 'mote.builtin');
  f.bindings.action('activate', {...bindingCommand(f), preparationId: inward}); f.plugins.action(instance.id, 'disable', instanceCommand(f, instance.id));
  f.plugins.uninstall(instance.packageId, pluginCommand(f)); assert.equal(f.plugins.view().instances.length, 0);
  await f.restart(); const recovered = new MemoryPublication(f.store, f.memories, f.bindings);
  assert.deepEqual(await f.bindings.read(memory.id), memory, 'migrated host history remains readable after uninstall');
  assert.ok(await f.bindings.provider(instance.id).read({namespace: oldNamespace, key: memoryProviderKey(memory)}));
  f.failNextRemoval(); assert.equal((await recovered.delete(memory.id)).externalErase, 'pending');
  await f.restart(); const reconciled = new MemoryPublication(f.store, f.memories, f.bindings); await reconciled.reconcile();
  assert.equal(reconciled.pending(), 0); assert.equal(await f.bindings.provider(instance.id).read({namespace: oldNamespace, key: memoryProviderKey(memory)}), null);
  assert.deepEqual(f.plugins.view().packages, []); assert.deepEqual(f.plugins.view().instances, []);
  assert.equal(f.plugins.instanceView(instance.id).desired, false); assert.deepEqual(f.plugins.instanceView(instance.id).allowedActions, []);
  assert.throws(() => f.memories.get(memory.id), {statusCode: 404});
});

test('the pinned Hindsight recipe installs its official API source wheel without downloading the oversized repository zipball', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'mote-hindsight-release-generated-'));
  t.after(() => rmSync(directory, {recursive: true, force: true}));
  const repository = 'vectorize-io/hindsight', tag = 'v0.10.2', commit = 'b'.repeat(40), name = 'hindsight_api_slim-0.10.2-py3-none-any.whl';
  const url = `https://github.com/${repository}/releases/download/${tag}/${name}`, assetUrl = `https://api.github.com/repos/${repository}/releases/assets/170`;
  const bytes = zipSync({'hindsight_api/server.py': strToU8('# Generated source fixture; never executed\n')});
  const requested: string[] = [];
  const transport: PluginReleaseTransport = async address => {
    requested.push(address);
    if (address.endsWith('/releases/tags/' + tag)) return {bytes: strToU8(JSON.stringify({tag_name: tag, draft: false, assets: [{id: 170, name, browser_download_url: url}]}))};
    if (address.endsWith('/commits/' + tag)) return {bytes: strToU8(JSON.stringify({sha: commit}))};
    if (address === assetUrl) return {bytes};
    throw Error('Generated fixed recipe refuses any repository archive or unregistered URL');
  };
  const releases = new GitHubPluginReleases(directory, transport), preview = await releases.resolve({repository, tag});
  assert.equal(preview.hostAdapter, 'mote.hindsight@1'); assert.equal(preview.archiveUrl, assetUrl);
  assert.equal(preview.preview.source.commit, commit); assert.equal(preview.preview.source.digest, sha256(bytes));
  assert.ok(preview.preview.issues.some(issue => issue.includes(name)));
  const installed = await releases.install(preview); releases.verifyInstalled(installed, preview.preview.source.digest, preview.manifest, true);
  assert.equal(await releases.install(preview), installed); assert.ok(requested.every(address => !address.includes('/zipball/')));
  writeFileSync(join(installed, 'hindsight_api/server.py'), '# Generated tampered cache');
  await assert.rejects(releases.install(preview), /integrity/);
});

test('the Hindsight source-wheel exception still rejects assets outside its exact fixed official release', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'mote-hindsight-release-origin-generated-'));
  t.after(() => rmSync(directory, {recursive: true, force: true}));
  const transport: PluginReleaseTransport = async address => ({bytes: strToU8(JSON.stringify(address.includes('/commits/') ? {sha: 'c'.repeat(40)} : {tag_name: 'v0.10.2', draft: false, assets: [{name: 'hindsight_api_slim-0.10.2-py3-none-any.whl', browser_download_url: 'https://untrusted.invalid/generated.whl'}]}))});
  await assert.rejects(new GitHubPluginReleases(directory, transport).resolve({repository: 'vectorize-io/hindsight', tag: 'v0.10.2'}), /outside the selected/);
});
