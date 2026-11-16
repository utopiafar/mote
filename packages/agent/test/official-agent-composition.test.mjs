import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {mkdtemp,readFile,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {writeMessagesResponse} from '../../../scripts/fixtures/messages-provider.ts';
import {
  CODEX_OFFICIAL_RUNTIME,
  DSH_OFFICIAL_RUNTIME,
  OFFICIAL_AGENT_COMPOSITION_VERSION,
  OFFICIAL_AGENT_CONTRIBUTIONS,
  OfficialCompositionUnavailableError,
  createAgent,
  createImportAgent,
  createOfficialAgent,
  resolveOfficialAgentComposition,
} from '../dist/index.js';

const ids = OFFICIAL_AGENT_CONTRIBUTIONS.map(contribution => contribution.id);
const reader = {
  search: async () => [], timeline: async () => ({items: [], nextCursor: null}), evidence: async () => [],
  activity: async () => ({}), devices: async () => [],
};

test('the official composition declares the complete base dependency graph', () => {
  assert.equal(OFFICIAL_AGENT_COMPOSITION_VERSION, '1.0.0');
  assert.equal(new Set(ids).size, ids.length, 'contribution ids must be unique');
  const declared = new Set(ids);
  for (const contribution of OFFICIAL_AGENT_CONTRIBUTIONS) {
    assert.ok(contribution.version, `${contribution.id} has no version`);
    for (const dependency of contribution.requires) {
      assert.ok(declared.has(dependency), `${contribution.id} requires an undeclared dependency: ${dependency}`);
    }
  }
  // Exact-cycle detection: a dependency chain may not return to its origin.
  const visit = (id, chain) => {
    assert.ok(!chain.includes(id), `official dependency cycle: ${[...chain, id].join(' -> ')}`);
    const contribution = OFFICIAL_AGENT_CONTRIBUTIONS.find(value => value.id === id);
    for (const dependency of contribution?.requires ?? []) visit(dependency, [...chain, id]);
  };
  for (const id of ids) visit(id, []);

  const resolved = resolveOfficialAgentComposition();
  assert.equal(resolved.available, true);
  assert.deepEqual(resolved.contributions.map(contribution => contribution.id), ids);
  assert.deepEqual(resolved.runtimes.map(runtime => runtime.id), ['mote.runtime.dsh', 'mote.runtime.codex']);
  assert.deepEqual(new Set(resolved.runtimes.flatMap(runtime => runtime.capabilities.modelTransports)),
    new Set(['deepseek', 'openai-completions', 'openai-responses', 'anthropic-messages', 'google-generative-ai', 'codex-app-server']));
  assert.equal(DSH_OFFICIAL_RUNTIME.capabilities.hostDelegation, true);
  assert.equal(CODEX_OFFICIAL_RUNTIME.capabilities.nativeDelegation, false);

  for (const id of ['host.output', 'host.usage', 'host.privacy', 'model.adapters', 'runtime.dsh', 'runtime.codex',
    'tools.official', 'tasks.official', 'skills.official', 'import.capabilities', 'host.delegation']) {
    assert.ok(ids.includes(id), `missing official base contribution: ${id}`);
  }
});

const nativeReference = contributionId => ({contribution:{instance:{packageId:'generated.native',installationId:'generated-install',instanceId:'generated-instance'},contributionId},revision:1,artifactDigest:'a'.repeat(64),exportName:'default'});

test('public Agent rejects unavailable native references and a revoked Host snapshot before model or context use',async t=>{
 const reference=nativeReference('generated.root'),revoked=new AbortController(),reason=new Error('Generated native activation revoked');
 const unavailable=createAgent({reader,model:'generated',protocol:'deepseek',baseUrl:'http://127.0.0.1:9/v1',apiKey:'generated',nativeDsh:{revision:1,assembly:{packages:[reference],hooks:[]},installedModules:[],signal:revoked.signal,assertCurrent(){revoked.signal.throwIfAborted();}}});t.after(()=>unavailable.close());
 await assert.rejects(unavailable.query({question:'Generated unavailable native query'}),error=>error.code==='runtime_module_unavailable');
 revoked.abort(reason);await assert.rejects(unavailable.query({question:'Generated revoked native query'}),error=>error===reason);
 assert.throws(()=>createAgent({reader,protocol:'codex-app-server',nativeDsh:{revision:1,assembly:{packages:[],hooks:[]},installedModules:[],signal:new AbortController().signal,assertCurrent(){}}}),error=>error.code==='dsh_profile_invalid');
});

test('public createAgent loads native package, Hook and Factory through the actual SDK and Host tool/output lifecycle',{timeout:30000},async t=>{
 const root=await mkdtemp(join(tmpdir(),'mote-official-native-')),trace=join(root,'trace.jsonl'),requests=[];
 let agent;
 const server=createServer(async(req,res)=>{let body='';for await(const part of req)body+=part;const request=JSON.parse(body);requests.push(request);
  const skill=request.tools.find(tool=>tool.name==='skill');
  writeMessagesResponse(res,{stage:requests.length-1,model:'generated-native',...(requests.length===1?{tool:{name:'skill',args:{name:skill.input_schema.properties.name.enum[0]}}}:{}),text:JSON.stringify({answer:'Generated native package, Hook and Factory reached the Host output.',citationIds:[]}),reasoning:true});
 });
 t.after(async()=>{await agent?.close();server.closeAllConnections();if(server.listening)await new Promise(resolve=>server.close(resolve));await rm(root,{recursive:true,force:true});});
 await writeFile(join(root,'package.json'),JSON.stringify({name:'@mote/generated-official-native',version:'0.0.0',type:'module',exports:{'.':'./index.mjs','./hook':'./hook.mjs','./factory':'./factory.mjs'},dsh:{native:{capabilities:['hooks','factory','agents']}}}));
 const log=`const trace=event=>appendFileSync(${JSON.stringify(trace)},JSON.stringify({event,pid:process.pid})+'\\n');`;
 await writeFile(join(root,'index.mjs'),`import {appendFileSync} from 'node:fs';${log}export const name='generated-native-package';export function apply(ctx){trace('package-loaded');ctx.effect(()=>()=>trace('package-disposed'));}`);
 await writeFile(join(root,'hook.mjs'),`import {appendFileSync} from 'node:fs';${log}export const name='generated-native-hook';export function apply(ctx){trace('hook-loaded');ctx.on('agent/request',async(_,next)=>{trace('hook-request');return next();});ctx.effect(()=>()=>trace('hook-disposed'));}`);
 await writeFile(join(root,'factory.mjs'),`import {appendFileSync} from 'node:fs';import AgentLoop from ${JSON.stringify(import.meta.resolve('@deepseek-ai/dsh-agent-loop'))};${log}export const name='generated-native-factory';export const inject=['agents','sessions','sessionProjections','systemPrompt','tools','llm','sessionPersistence'];export function apply(ctx){class GeneratedLoop extends AgentLoop{async createAgent(owner,options){trace('factory-create');return super.createAgent(owner,options);}}new GeneratedLoop(ctx,{agents:[],maxParallelToolCalls:{get:()=>10}});ctx.effect(()=>()=>trace('factory-disposed'));}`);
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 const references=['package','hook','factory'].map(name=>nativeReference('generated.'+name)),activation=new AbortController();let assertions=0;
 const nativeDsh={revision:7,assembly:{packages:[references[0]],hooks:[references[1]],factory:references[2]},installedModules:references.map((reference,index)=>({reference,packageRoot:root,packageName:'@mote/generated-official-native',packageVersion:'0.0.0',subpath:['.','./hook','./factory'][index],grantedCapabilities:['hooks','factory','agents']})),signal:activation.signal,assertCurrent(){assertions++;activation.signal.throwIfAborted();}};
 agent=createAgent({reader,model:'generated-native',protocol:'deepseek',baseUrl:`http://127.0.0.1:${server.address().port}`,apiKey:'generated-native-key',maxTokens:1024,requestTimeoutMs:10000,agentTimeoutMs:20000,nativeDsh});
 const result=await agent.query({question:'Use the permitted bundled skill and return the generated native assembly output.'});assert.match(result.answer,/Generated native package/);assert.equal(requests.length,2);assert.ok(requests[1].messages.some(message=>Array.isArray(message.content)&&message.content.some(block=>block.type==='tool_result')));assert.ok(assertions>0);
 await agent.close();const events=(await readFile(trace,'utf8')).trim().split('\n').map(line=>JSON.parse(line));
 for(const name of ['package-loaded','hook-loaded','factory-create','hook-request','factory-disposed','hook-disposed','package-disposed'])assert.ok(events.some(event=>event.event===name),name);
 for(const pid of new Set(events.map(event=>event.pid)))assert.throws(()=>process.kill(pid,0),error=>error.code==='ESRCH','the real SDK child is released');
});

test('removing any one base contribution reports unavailable without falling back', () => {
  for (const removed of ids) {
    const available = ids.filter(id => id !== removed);
    const resolution = resolveOfficialAgentComposition({available});
    assert.equal(resolution.available, false, `${removed} must not resolve as available`);
    assert.equal(resolution.code, 'official_composition_unavailable');
    assert.ok(resolution.missing.includes(removed), `${removed} must be named as the missing dependency`);
    assert.equal('contributions' in resolution, false);
    assert.equal('runtimes' in resolution, false);

    // Exercise the real public creation entry, not only the pure resolver.
    assert.throws(
      () => createOfficialAgent({reader, protocol: 'deepseek', model: 'generated-model', apiKey: 'generated-key', baseUrl: 'http://127.0.0.1:9/v1'}, {available}),
      error => error instanceof OfficialCompositionUnavailableError &&
        error.code === 'official_composition_unavailable' && error.missing.includes(removed),
      `${removed} removal must fail the real composition instead of selecting a built-in path`,
    );
    if (removed === 'import.capabilities') {
      assert.throws(
        () => createImportAgent({model: 'generated-model', apiKey: 'generated-key'}, undefined, {available}),
        error => error instanceof OfficialCompositionUnavailableError && error.missing.includes(removed),
        'the official import facade must not fall back to a private capability registry',
      );
    }
  }
});

test('an unknown or incomplete selection is unavailable', () => {
  const unknown = resolveOfficialAgentComposition({available: [...ids, 'runtime.legacy']});
  assert.equal(unknown.available, false);
  assert.ok(unknown.missing.includes('runtime.legacy'));

  const missingRequirement = resolveOfficialAgentComposition({available: ids.filter(id => id !== 'tasks.official' && id !== 'runtime.dsh')});
  assert.equal(missingRequirement.available, false);
  assert.ok(missingRequirement.missing.includes('tasks.official'));
});

test('runtime selection follows declared model transports rather than a protocol branch', () => {
  const dshOnly = ids.filter(id => id !== 'runtime.codex');
  assert.throws(() => createOfficialAgent({reader, protocol: 'openai-completions', model: 'generated', apiKey: 'generated', baseUrl: 'http://127.0.0.1:9/v1'}, {available: dshOnly}),
    error => error instanceof OfficialCompositionUnavailableError && error.missing.includes('runtime.codex'),
    'the complete official composition is required even when the current transport matches one runtime');

  const codex = createOfficialAgent({reader, protocol: 'codex-app-server'});
  assert.equal(codex.configured, false);
  return codex.close();
});
