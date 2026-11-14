import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,readFileSync,readdirSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {buildApp} from '../src/app.js';
import {defaultDistribution,defaultFeatures,defaultPlugins,storageProvider} from '../src/distribution/default.js';
import {plugins as platformPlugins} from '../src/assembly/platform.js';
import {plugins as sourcePlugins} from '../src/assembly/sources.js';
import {plugins as materialPlugins} from '../src/assembly/materials.js';
import {plugins as processingPlugins} from '../src/assembly/processing.js';
import {plugins as activityPlugins} from '../src/assembly/activity.js';
import {plugins as memoryPlugins} from '../src/assembly/memory.js';
import {plugins as queryPlugins} from '../src/assembly/query.js';
import {plugins as agentPlugins} from '../src/assembly/agent.js';
import {plugins as workPlugins} from '../src/assembly/work.js';
import {plugins as importPlugins} from '../src/assembly/imports.js';
import type {CentralDistribution,FoundationProvider} from '../src/bootstrap.js';
import type {Config} from '../src/config.js';
import {FUNASR_PINS} from '../src/funasr-contract.js';

function fixture(t:{after(fn:()=>void):void}){
  const dataDir=mkdtempSync(join(tmpdir(),'mote-central-distribution-'));
  t.after(()=>rmSync(dataDir,{recursive:true,force:true}));
  const config:Config={dataDir,token:'generated-central-distribution-token',tokenPath:'fixture-only',host:'127.0.0.1',port:0,
    maxStorageBytes:10_000_000,maxExportBytes:1_000_000,retentionDays:0,insightIntervalHours:0,allowedOrigins:[],
    model:'',modelBaseUrl:'',apiKey:'',allowUnauthenticatedLocal:false,embeddingModel:'',embeddingBaseUrl:'',embeddingApiKey:'',logLevel:'silent'};
  return {config,headers:{authorization:`Bearer ${config.token}`}};
}
function note(){return {id:randomUUID(),deviceId:'generated-central-distribution-device',deviceName:'Generated central distribution fixture',platform:'android',capturedAt:'2026-11-02T12:00:00.000Z',text:'Generated original note retained across a reduced default composition.'};}
const agent={configured:false,query:async()=>{throw Error('No model in central distribution fixture');},close:async()=>{}};

const assemblyPlugins=[...platformPlugins,...sourcePlugins,...materialPlugins,...processingPlugins,...activityPlugins,...memoryPlugins,...queryPlugins,...agentPlugins,...workPlugins,...importPlugins];

test('default distribution is the exact, duplicate-free selection built from every domain-owned plugin list',()=>{
  assert.deepEqual(defaultDistribution.foundations.map(provider=>provider.kind).sort(),['authorization','configuration','storage']);
  assert.equal(defaultDistribution.features,defaultFeatures);
  assert.equal(new Set(defaultFeatures).size,defaultFeatures.length);
  assert.ok(defaultFeatures.includes('mote.memory')&&defaultFeatures.includes('mote.ask'));
  assert.equal(defaultDistribution.plugins,defaultPlugins);
  assert.deepEqual(defaultPlugins.map(plugin=>plugin.contribution.id),assemblyPlugins.map(plugin=>plugin.contribution.id));
  assert.equal(new Set(assemblyPlugins.map(plugin=>plugin.contribution.id)).size,assemblyPlugins.length);
  for(const id of ['mote.plugin-control','evidence-context-reader'])assert.ok(defaultPlugins.some(plugin=>plugin.contribution.id===id),`missing default domain plugin ${id}`);
  for(const plugin of defaultDistribution.plugins){
    assert.equal(plugin.contribution.id,plugin.declaration.id);
    assert.match(plugin.contribution.version,/^\d+\.\d+\.\d+$/);
    assert.ok(plugin.contribution.surface==='data'||plugin.contribution.surface==='command');
    assert.equal(plugin.contribution.runtime,'host');
    assert.ok(plugin.replacement==='hot'||plugin.replacement==='restart');
  }
});

// The metric is intentionally the same file set and framework-primitive list
// used by the plan's plugin-metrics.sh command, so this audit cannot drift into
// a friendlier definition of "business object".
test('[R] no business class is constructed outside plugin-owned modules',()=>{
  const root=join(import.meta.dirname,'..','src');
  const files=['app.ts','bootstrap.ts',...readdirSync(join(root,'assembly')).filter(file=>file.endsWith('.ts')).map(file=>join('assembly',file)),
    ...readdirSync(join(root,'distribution')).filter(file=>file.endsWith('.ts')).map(file=>join('distribution',file))];
  const framework=/(Error|Failure)$|^(Set|Map|WeakMap|WeakSet|URL|URLSearchParams|Date|Promise|AbortController|TextEncoder|TextDecoder|Uint8Array|RegExp|Context|PluginHost|ServerResources|PluginResourceScope|ServerFeatureHost|EvidenceExposurePolicy)$/;
  const constructed=[...new Set(files.flatMap(file=>[...readFileSync(join(root,file),'utf8').matchAll(/new ([A-Z][A-Za-z0-9_]*)\(/g)].map(match=>match[1])))]
    .filter(name=>!framework.test(name)).sort();
  assert.deepEqual(constructed,[],`business construction must live in a plugin module; found ${constructed.join(', ')}`);
});

test('[K] the real default manifest discovers every feature, connector, processor, Memory and Actions owner in one startup',async t=>{
  const {config,headers}=fixture(t),node=await buildApp(config,{agent,backgroundWorker:false});
  t.after(()=>node.app.close());await node.app.ready();
  const inventory=(await node.app.inject({url:'/api/features',headers})).json();
  assert.equal(inventory.schemaVersion,1);
  assert.equal(typeof inventory.revision,'number');

  assert.equal((await node.app.inject({url:'/api/usage?from=2026-11-01&to=2026-11-03',headers})).statusCode,200);
  assert.equal((await node.app.inject({url:'/api/diagnostics',headers})).statusCode,200);
  for(const id of defaultFeatures){
    const feature=inventory.features.find((value:{id:string})=>value.id===id);
    assert.ok(feature,`missing default feature ${id}`);
    assert.ok(inventory.capabilities.some((value:{featureId:string;state:string})=>value.featureId===id&&value.state==='active'),`default feature ${id} has no active capability`);
  }

  const connectors=inventory.features.filter((feature:{id:string})=>feature.id.startsWith('mote.connector.'));
  assert.equal(connectors.length,6,JSON.stringify(connectors.map((feature:{id:string})=>feature.id)));
  for(const connector of connectors)assert.ok(inventory.capabilities.some((value:{featureId:string;state:string})=>value.featureId===connector.id&&value.state==='active'),`connector ${connector.id} has no active capability`);

  const processors=node.processing.view().processors,fileProcessors=processors.map((processor:{id:string})=>processor.id);
  for(const id of ['audio.http','audio.local-dialogue','text.utf8','document.generic','image.http','audio.diarize'])assert.ok(fileProcessors.includes(id),`missing file processor ${id}`);
  for(const pin of [FUNASR_PINS.extract,FUNASR_PINS.diarize])assert.equal(processors.find(processor=>processor.id===pin.id)?.version,pin.version,`default startup must expose the current ${pin.id} processor`);
  assert.equal(fileProcessors.includes('audio.diarize-wespeaker'),false,'the retired WeSpeaker processor cannot be installed by the default manifest');
  const contextProcessors=node.workflows.view().processors.map((processor:{id:string})=>processor.id);
  for(const id of ['mote.segment-understanding','mote.coding-conversation-understanding'])assert.ok(contextProcessors.includes(id),`missing context processor ${id}`);

  assert.ok(inventory.features.some((feature:{id:string})=>feature.id==='mote.memory'));
  assert.ok(inventory.capabilities.some((value:{featureId:string;state:string})=>value.featureId==='mote.memory'&&value.state==='active'));
  assert.ok(node.memoryPublication&&node.memoryPipeline&&node.memoryBindings);
  assert.ok(inventory.features.some((feature:{id:string})=>feature.id==='mote.actions'));
  assert.ok(inventory.capabilities.some((value:{featureId:string;state:string})=>value.featureId==='mote.actions'&&value.state==='active'));
  assert.equal(typeof node.actions.list,'function');

  // One common PluginHost owns every selected domain contribution. The
  // inventory projects those activations plus the HTTP feature and connector
  // capabilities into one revision instead of a second package authority.
  const snapshot=node.bootstrap.snapshot(),hostId=snapshot.host.id;
  assert.ok(snapshot.contributions.length>0);
  assert.ok(snapshot.contributions.every(contribution=>contribution.identity.scope.host.id===hostId));
  const declareFoundation=new Set(defaultDistribution.foundations.map(provider=>provider.contribution.id));
  const declarePlugin=new Set(defaultDistribution.plugins.map(plugin=>plugin.contribution.id));
  for(const contribution of snapshot.contributions){
    const id=contribution.identity.contributionId;
    if(declareFoundation.has(id)||id==='observability-platform'||id==='source-integration')continue;
    assert.ok(declarePlugin.has(id),`installed contribution ${id} is absent from the default distribution`);
  }
});

test('[M] removing an ordinary business plugin leaves its feature unavailable, retains data and restores through the full manifest',async t=>{
  const {config,headers}=fixture(t),input=note();
  const full=await buildApp(config,{agent,backgroundWorker:false});t.after(()=>full.app.close());
  assert.equal((await full.app.inject({method:'POST',url:'/api/notes',headers,payload:input})).statusCode,201);
  await full.app.close();

  const reduced:CentralDistribution={...defaultDistribution,
    features:defaultDistribution.features.filter(id=>id!=='mote.notes'),
    plugins:defaultDistribution.plugins.filter(plugin=>plugin.contribution.id!=='notes-source')};
  const partial=await buildApp(config,{agent,backgroundWorker:false,distribution:reduced});t.after(()=>partial.app.close());
  const inventory=(await partial.app.inject({url:'/api/features',headers})).json();
  assert.ok(!inventory.features.some((feature:{id:string})=>feature.id==='mote.notes'),'the removed feature must not be synthesized from the old adapter list');
  assert.throws(()=>partial.notesSource.assemblyForRoutes().list({} as never),/notes-source plugin is not selected/);
  assert.equal((await partial.app.inject({method:'POST',url:'/api/notes',headers,payload:note()})).statusCode,404);
  assert.equal(partial.store.evidence([input.id]).length,1,'removing a plugin cannot delete retained originals');

  const restored=await buildApp(config,{agent,backgroundWorker:false});t.after(()=>restored.app.close());
  assert.equal((await restored.app.inject({url:`/api/notes/${input.id}`,headers})).json().ocrText,input.text);
  await restored.app.close();
});

test('[M] a missing required platform provider refuses startup before any app or resource is published',async t=>{
  const {config}=fixture(t);
  const missing:CentralDistribution={...defaultDistribution,foundations:defaultDistribution.foundations.filter(provider=>provider.kind!=='storage')};
  await assert.rejects(buildApp(config,{agent,backgroundWorker:false,distribution:missing}),{code:'MOTE_BOOTSTRAP_INVALID'});
});

test('[M] a same-contract replacement provider is selected on restart and the previous vault resource is closed',async t=>{
  const {config,headers}=fixture(t),writes={first:0,second:0};
  const provider=(which:'first'|'second'):FoundationProvider<'storage'>=>({...storageProvider,id:`fixture.vault-${which}`,async create(context,input){
    const value=await storageProvider.create(context,input);
    const ingest=value.store.ingest.bind(value.store);
    value.store.ingest=async(...args)=>{writes[which]++;return ingest(...args);};return value;
  }});
  const distribution=(which:'first'|'second'):CentralDistribution=>({...defaultDistribution,foundations:defaultDistribution.foundations.map(entry=>entry.kind==='storage'?provider(which):entry)});
  const first=await buildApp(config,{agent,backgroundWorker:false,distribution:distribution('first')});t.after(()=>first.app.close());
  const input=note();
  assert.equal((await first.app.inject({method:'POST',url:'/api/notes',headers,payload:input})).statusCode,201);
  await first.app.close();
  assert.throws(()=>first.store.stats(),'the replaced provider must release its vault');

  const second=await buildApp(config,{agent,backgroundWorker:false,distribution:distribution('second')});t.after(()=>second.app.close());
  assert.ok(second.bootstrap.hostDependencies.some(provider=>provider.id==='fixture.vault-second'));
  assert.ok(!second.bootstrap.hostDependencies.some(provider=>provider.id==='fixture.vault-first'));
  assert.equal((await second.app.inject({url:`/api/notes/${input.id}`,headers})).json().ocrText,input.text);
  assert.equal((await second.app.inject({method:'POST',url:'/api/notes',headers,payload:note()})).statusCode,201);
  assert.deepEqual(writes,{first:1,second:1});
});

test('[M] disabling Memory or Ask surfaces keeps capture and legitimate reads live',async t=>{
  const {config,headers}=fixture(t),input=note();
  const reduced:CentralDistribution={...defaultDistribution,features:defaultFeatures.filter(id=>id!=='mote.memory'&&id!=='mote.ask'&&id!=='mote.insights'&&id!=='mote.agent-view')};
  const node=await buildApp(config,{agent,backgroundWorker:false,distribution:reduced});t.after(()=>node.app.close());await node.app.ready();
  assert.equal((await node.app.inject({method:'POST',url:'/api/notes',headers,payload:input})).statusCode,201);
  assert.equal((await node.app.inject({url:`/api/notes/${input.id}`,headers})).json().ocrText,input.text);
  assert.equal((await node.app.inject({method:'POST',url:'/api/captures',headers,payload:{id:randomUUID(),deviceId:'generated-reduced-device',deviceName:'Generated reduced fixture',platform:'macos',source:'activity',capturedAt:'2026-11-02T13:00:00.000Z',durationMs:0,appId:'generated',appName:'Generated',privacy:{excluded:false,redacted:false,mode:'none',collection:'activity'}}})).statusCode,201);
  const inventory=(await node.app.inject({url:'/api/features',headers})).json();
  for(const id of ['mote.memory','mote.ask','mote.insights','mote.agent-view']){
    assert.ok(!inventory.capabilities.some((capability:{featureId:string;id:string})=>capability.featureId===id&&capability.id.startsWith('http:')),`disabled feature ${id} must not mount HTTP routes`);
  }
  assert.equal((await node.app.inject({url:'/api/memory-jobs',headers})).statusCode,404);
  assert.equal((await node.app.inject({url:'/api/query-runs',headers})).statusCode,404);
  assert.equal((await node.app.inject({url:'/api/context/search?query=Generated',headers})).statusCode,200);
});
