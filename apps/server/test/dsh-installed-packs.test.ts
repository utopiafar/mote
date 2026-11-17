import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {createServer} from 'node:http';
import {existsSync} from 'node:fs';
import {mkdtemp, readFile, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {strToU8, zipSync} from 'fflate';
import {serializeConfigDocument} from '@mote/shared/config-file';
import type {RuntimeModuleReference} from '@mote/shared/agent-runtimes';
import {buildApp} from '../src/app.js';
import {configurationFromFile} from '../src/config.js';
import type {PluginManifest, PluginReleaseTransport} from '../src/plugin-release.js';
import {sha256} from '../src/evidence-store.js';
import {writeMessagesResponse} from '../../../scripts/fixtures/messages-provider.js';

async function waitFor(check: () => boolean | Promise<boolean>, label: string) {
  const until = Date.now() + 8000;
  while (Date.now() < until) {if (await check()) return; await new Promise(resolve => setTimeout(resolve, 10));}
  assert.fail('Generated native pack did not settle: ' + label);
}

function generatedRelease(trace: string) {
  const repository = 'generated-fixture/native-dsh', tag = 'v1.0.0';
  const log = `import {appendFileSync} from 'node:fs';const trace=event=>appendFileSync(${JSON.stringify(trace)},JSON.stringify({event,pid:process.pid})+'\\n');`;
  const archive = zipSync({
    'package.json': strToU8(JSON.stringify({name: '@mote/generated-installed-native', version: '1.0.0', type: 'module', exports: {'.': './index.mjs', './alias': './index.mjs', './hook': './hook.mjs', './factory': './factory.mjs'}, dsh: {native: {capabilities: ['hooks', 'factory', 'agents']}}})),
    'index.mjs': strToU8(`${log}export const name='installed-native-package';export function apply(ctx){trace('package-loaded');ctx.effect(()=>()=>trace('package-disposed'));}`),
    'hook.mjs': strToU8(`${log}export const name='installed-native-hook';export function apply(ctx){trace('hook-loaded');ctx.on('agent/request',async(_,next)=>{trace('hook-request');return next();});ctx.effect(()=>()=>trace('hook-disposed'));}`),
    'factory.mjs': strToU8(`${log}import AgentLoop from ${JSON.stringify(import.meta.resolve('@deepseek-ai/dsh-agent-loop'))};export const name='installed-native-factory';export const inject=['agents','sessions','sessionProjections','systemPrompt','tools','llm','sessionPersistence'];export function apply(ctx){class InstalledLoop extends AgentLoop{async createAgent(owner,options){trace('factory-create');return super.createAgent(owner,options);}}new InstalledLoop(ctx,{agents:[],maxParallelToolCalls:{get:()=>10}});ctx.effect(()=>()=>trace('factory-disposed'));}`),
  });
  const manifest: PluginManifest = {schemaVersion: 1, id: 'generated.installed-native', name: 'Generated original native DSH package', version: '1.0.0', runtime: 'service', entry: 'index.mjs', archive: {asset: 'native.zip', sha256: sha256(archive)}, capabilities: ['hooks', 'factory', 'agents'], configuration: [], dependencies: [], access: ['Trusted native code selected explicitly by the owner'], contributions: [
    {id: 'generated.native-package', version: '1.0.0', surface: 'agent', runtime: 'native', entry: 'index.mjs'},
    {id: 'generated.native-hook', version: '1.0.0', surface: 'agent', runtime: 'native', entry: 'hook.mjs'},
    {id: 'generated.native-factory', version: '1.0.0', surface: 'agent', runtime: 'native', entry: 'factory.mjs'},
  ]};
  const base = `https://github.com/${repository}/releases/download/${tag}/`;
  const transport: PluginReleaseTransport = async url => {
    if (url === `https://api.github.com/repos/${repository}/releases/tags/${tag}`) return {bytes: strToU8(JSON.stringify({tag_name: tag, draft: false, assets: ['mote-plugin.json', 'native.zip'].map(name => ({name, browser_download_url: base + name}))}))};
    if (url === `https://api.github.com/repos/${repository}/commits/${tag}`) return {bytes: strToU8(JSON.stringify({sha: 'a'.repeat(40)}))};
    if (url === base + 'mote-plugin.json') return {bytes: strToU8(JSON.stringify(manifest))};
    if (url === base + 'native.zip') return {bytes: archive};
    throw new Error('Unexpected generated release transport');
  };
  return {repository, tag, transport};
}

test('installed native packs reach the official Agent through owner configuration and restart, then revoke in flight', {timeout: 30000}, async t => {
  const root = await mkdtemp(join(tmpdir(), 'mote-installed-dsh-')), path = join(root, 'mote.yaml'), trace = join(root, 'native-trace.jsonl');
  const release = generatedRelease(trace), owner = 'generated-native-owner-' + randomUUID(), headers = {authorization: 'Bearer ' + owner};
  const requests: unknown[] = [];
  let hold = false, entered!: () => void, releaseLate!: () => void;
  const waiting = new Promise<void>(resolve => {entered = resolve;}), late = new Promise<void>(resolve => {releaseLate = resolve;});
  const model = createServer(async (req, res) => {
    let body = ''; for await (const part of req) body += part;
    const request = JSON.parse(body); requests.push(request);
    if (hold) {entered(); await late;}
    const first = !request.messages.some((message: {content: unknown}) => Array.isArray(message.content) && message.content.some((block: {type: string}) => block.type === 'tool_result'));
    const skill = request.tools.find((tool: {name: string}) => tool.name === 'skill');
    writeMessagesResponse(res, {stage: first ? 0 : 1, model: 'generated-native-model', ...(first ? {tool: {name: 'skill', args: {name: skill.input_schema.properties.name.enum[0]}}} : {}), text: JSON.stringify({answer: 'Generated installed native pack reached the permitted Host output.', citationIds: []}), reasoning: true});
  });
  await new Promise<void>(resolve => model.listen(0, '127.0.0.1', resolve));
  const address = model.address() as {port: number};
  await writeFile(path, serializeConfigDocument({version: 1, revision: 0, server: {profile: 'test', token: owner}, storage: {dataDir: 'vault'}, diagnostics: {level: 'silent'}, execution: {insightIntervalHours: 0}, models: {deployment: {provider: 'deepseek', protocol: 'deepseek', baseUrl: `http://127.0.0.1:${address.port}`, model: 'generated-native-model', apiKey: 'generated-model-key', maxTokens: 1024, modelRequestTimeoutMs: 10000, agentTimeoutMs: 20000}}}));
  let node: Awaited<ReturnType<typeof buildApp>> | undefined;
  const open = async () => {node = await buildApp(configurationFromFile(path), {backgroundWorker: false}); Object.defineProperty(node.pluginCenter.releases, 'transport', {value: release.transport}); return node;};
  const restart = async () => {await node?.app.close(); return open();};
  t.after(async () => {releaseLate(); await node?.app.close(); model.closeAllConnections(); await new Promise<void>(resolve => model.close(() => resolve())); await rm(root, {recursive: true, force: true});});
  await open();
  const resolved = await node!.app.inject({method: 'POST', url: '/api/plugins/resolve', headers, payload: {repository: release.repository, tag: release.tag}});
  assert.equal(resolved.statusCode, 200, resolved.body);
  const installed = await node!.app.inject({method: 'POST', url: '/api/plugins/install', headers, payload: {previewId: resolved.json().id, expectedRevision: node!.pluginCenter.revision(), operationId: randomUUID()}});
  assert.equal(installed.statusCode, 200, installed.body);
  await waitFor(() => node!.pluginCenter.view().packages.some(pkg => pkg.state === 'installed'), 'install');
  const packageId = node!.pluginCenter.view().packages.find(pkg => pkg.state === 'installed')!.id;
  const configured = await node!.app.inject({method: 'POST', url: '/api/plugin-instances', headers, payload: {packageId, name: 'Generated native instance', scope: 'default', configuration: {}, expectedRevision: node!.pluginCenter.revision(), operationId: randomUUID()}});
  assert.equal(configured.statusCode, 200, configured.body);
  const instanceId = configured.json().id as string;
  const action = (name: 'check' | 'enable' | 'disable') => node!.app.inject({method: 'POST', url: '/api/plugin-instances/' + instanceId + '/' + name, headers, payload: {expectedRevision: node!.pluginCenter.instanceView(instanceId).revision, operationId: randomUUID()}});
  assert.equal((await action('check')).statusCode, 200);
  await waitFor(() => node!.pluginCenter.instanceView(instanceId).observed === 'ready', 'metadata check');
  assert.equal(existsSync(trace), false, 'install/check must not import trusted native entrypoints on the Central process');
  assert.equal((await action('enable')).statusCode, 200);
  await waitFor(() => node!.pluginCenter.instanceView(instanceId).desired && node!.pluginCenter.instanceView(instanceId).observed === 'ready', 'activation');
  assert.equal(existsSync(trace), false, 'enablement alone does not grant/load a native query pack');
  const sibling = await node!.app.inject({method: 'POST', url: '/api/plugin-instances', headers, payload: {packageId, name: 'Generated separate native instance', scope: 'default', configuration: {}, expectedRevision: node!.pluginCenter.revision(), operationId: randomUUID()}});
  assert.equal(sibling.statusCode, 200, sibling.body); const siblingId = sibling.json().id as string;
  const siblingAction = (name: 'check' | 'enable' | 'disable') => node!.app.inject({method: 'POST', url: '/api/plugin-instances/' + siblingId + '/' + name, headers, payload: {expectedRevision: node!.pluginCenter.instanceView(siblingId).revision, operationId: randomUUID()}});
  assert.equal((await siblingAction('check')).statusCode, 200); await waitFor(() => node!.pluginCenter.instanceView(siblingId).observed === 'ready', 'sibling check');
  assert.equal((await siblingAction('enable')).statusCode, 200);
  assert.equal((await node!.app.inject({url: '/api/agent-runtime/native-modules'})).statusCode, 401);
  const directory = await node!.app.inject({url: '/api/agent-runtime/native-modules', headers});
  assert.equal(directory.statusCode, 200, directory.body);
  assert.ok(!directory.body.includes(root), 'owner selection catalog contains no executable path');
  const allModules = directory.json().items as {reference: RuntimeModuleReference; requestedCapabilities: string[]}[];
  assert.equal(allModules.length, 6); const modules = allModules.filter(module => module.reference.contribution.instance.instanceId === instanceId);
  assert.equal(modules.length, 3);
  const byId = (id: string) => modules.find(module => module.reference.contribution.contributionId === id)!.reference;
  const modelProfileId = 'selected-native';
  const modelProfile = await node!.app.inject({method: 'PUT', url: '/api/configuration/models', headers, payload: {revision: node!.configService.revision, value: {profiles: [{id: modelProfileId, name: 'Generated selected native model', settings: node!.modelSettings.select('chat').settings}]}}});
  assert.equal(modelProfile.statusCode, 200, modelProfile.body);
  const profile = {modelProfileId, assembly: {packages: [byId('generated.native-package')], hooks: [byId('generated.native-hook')], factory: byId('generated.native-factory')}, grants: [{instance: modules[0]!.reference.contribution.instance, capabilities: modules[0]!.requestedCapabilities}]};
  const savedRevision = node!.configService.revision;
  for (const [invalid, status] of [
    [{...profile, grants: []}, 400],
    [{...profile, grants: [...profile.grants, ...profile.grants]}, 400],
    [{...profile, grants: [{...profile.grants[0]!, capabilities: ['hooks']}]}, 409],
    [{...profile, grants: [{...profile.grants[0]!, capabilities: [...profile.grants[0]!.capabilities, 'undeclared']}]}, 409],
    [{...profile, assembly: {...profile.assembly, factory: {...profile.assembly.factory, artifactDigest: 'b'.repeat(64)}}}, 409],
    [{...profile, assembly: {...profile.assembly, hooks: [allModules.find(module => module.reference.contribution.instance.instanceId === siblingId && module.reference.contribution.contributionId === 'generated.native-hook')!.reference]}}, 400],
  ] as const) {
    const rejected = await node!.app.inject({method: 'PUT', url: '/api/configuration/dsh', headers, payload: {revision: savedRevision, value: {profiles: [invalid]}}});
    assert.equal(rejected.statusCode, status, rejected.body); assert.equal(node!.configService.revision, savedRevision);
  }
  assert.equal((await node!.app.inject({method: 'PUT', url: '/api/configuration/dsh', headers, payload: {revision: node!.configService.revision, value: {profiles: [profile]}}})).statusCode, 200);
  const pending = node!.configService.view().domains.find(domain => domain.id === 'dsh')!;
  assert.equal(pending.status, 'restart-required'); assert.deepEqual(pending.effective, {profiles: []});
  const beforeRestart = await node!.app.inject({method: 'POST', url: '/api/query', headers, payload: {question: 'Generated query before applying native settings', modelProfileId}});
  assert.equal(beforeRestart.statusCode, 200, beforeRestart.body); assert.equal(existsSync(trace), false);
  await restart();
  const otherProfile = await node!.app.inject({method: 'POST', url: '/api/query', headers, payload: {question: 'Generated unselected deployment profile keeps its own assembly'}});
  assert.equal(otherProfile.statusCode, 200, otherProfile.body); assert.equal(existsSync(trace), false, 'native selection is attached to one exact model profile');
  const result = await node!.app.inject({method: 'POST', url: '/api/query', headers, payload: {question: 'Generated query through the installed original native package', modelProfileId}});
  assert.equal(result.statusCode, 200, result.body); assert.match(result.json().answer, /Generated installed native pack/);
  assert.equal(requests.length, 6); assert.equal(node!.pluginCenter.instanceView(instanceId).desired, true);
  const events = (await readFile(trace, 'utf8')).trim().split('\n').map(line => JSON.parse(line) as {event: string; pid: number});
  for (const name of ['package-loaded', 'hook-loaded', 'hook-request', 'factory-create', 'factory-disposed', 'hook-disposed', 'package-disposed']) assert.ok(events.some(event => event.event === name), name);
  for (const pid of new Set(events.map(event => event.pid))) assert.throws(() => process.kill(pid, 0), (error: unknown) => (error as {code: string}).code === 'ESRCH');
  const queryPath = await node!.app.inject({method: 'POST', url: '/api/query', headers, payload: {question: 'Generated rejected executable input', nativeDsh: {packageRoot: root}}});
  assert.equal(queryPath.statusCode, 400);
  hold = true;
  let settled = false;
  const inFlight = node!.app.inject({method: 'POST', url: '/api/query', headers, payload: {question: 'Generated installed activation revoked with a late model response', modelProfileId}}).finally(() => {settled = true;});
  await waiting; assert.equal((await siblingAction('disable')).statusCode, 200); await new Promise(resolve => setImmediate(resolve));
  assert.equal(settled, false, 'a sibling installation scope cannot revoke the selected native instance');
  assert.equal((await action('disable')).statusCode, 200);
  const rejected = await inFlight; assert.notEqual(rejected.statusCode, 200); releaseLate();
  assert.equal(requests.length, 7, 'withdrawn installed code cannot perform another tool/model turn');
  assert.equal((await action('enable')).statusCode, 200);
  await waitFor(async () => (await node!.app.inject({url: '/api/agent-runtime/native-modules', headers})).json().items.some((module: {active: boolean; reference: RuntimeModuleReference}) => module.active && module.reference.contribution.instance.instanceId === instanceId), 'fresh native activation');
  hold = false;
  const next = await node!.app.inject({method: 'POST', url: '/api/query', headers, payload: {question: 'Generated query reuses the configured immutable installation with a fresh activation', modelProfileId}});
  assert.equal(next.statusCode, 200, next.body); assert.equal(requests.length, 9);
  const finalEvents = (await readFile(trace, 'utf8')).trim().split('\n').map(line => JSON.parse(line) as {event: string; pid: number});
  assert.equal(finalEvents.filter(event => event.event === 'package-loaded').length, 3); assert.equal(finalEvents.filter(event => event.event === 'package-disposed').length, 3);
  for (const pid of new Set(finalEvents.map(event => event.pid))) assert.throws(() => process.kill(pid, 0), (error: unknown) => (error as {code: string}).code === 'ESRCH');
});
