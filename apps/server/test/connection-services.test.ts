import test,{type TestContext} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {servicesViewSchema} from '@mote/shared';
import {buildApp,type QueryAgent} from '../src/app.js';
import type {ConfigurationPlatformOptions} from '../src/config.js';
import type {ConnectorManifest} from '../src/connectors/registry.js';

const inactive:QueryAgent={configured:false,query:async()=>{throw Error('No model calls belong in connection-service tests');},close:async()=>{}};
const owner='synthetic-owner-for-connection-services';
const headers={authorization:`Bearer ${owner}`,'x-mote-ingress-version':'2'};
const sourceId='generated-connector-source';
const sourceKind='generated.connector';

function config(directory:string):ConfigurationPlatformOptions{return {
  path:join(directory,'mote.yaml'),privateCredential:{token:owner,tokenPath:join(directory,'owner-token')},
  initialDocument:{version:1,revision:0,storage:{dataDir:directory,maxExportBytes:4*1024*1024},
    server:{host:'127.0.0.1',port:0,profile:'test',allowedOrigins:['https://synthetic.invalid']},
    execution:{insightIntervalHours:0},
    models:{deployment:{model:'',baseUrl:'https://api.deepseek.com',apiKey:'',allowUnauthenticatedLocal:false,protocol:'deepseek',reasoningEffort:'high'},embedding:{model:'',baseUrl:'',apiKey:''}},
    diagnostics:{enabled:true},
    connectors:{directory:join(directory,'connectors'),mcpEnabled:true,mcpReadToken:'synthetic-generated-read-mcp-token-123456789',mcpWriteEnabled:false,mcpWriteToken:'',mcpWriteSourceIds:[],syncIntervalMs:300000}},
};}

function generatedConnector():ConnectorManifest{
  return {apiVersion:1,id:'generated-connector',statusKey:'generated',
    sourceKinds:[{kind:sourceKind,capabilities:{lifecycle:'continuous',discovery:'explicit-selection',listening:'polling',readOriginal:'none',synchronization:'revisions',externalWrite:false}}],
    create:ctx=>{
      const now=()=>new Date().toISOString();
      const sync=async()=>{
        ctx.sources.register({id:sourceId,name:'Generated connector',kind:sourceKind,deviceId:'generated-device',platform:'import',retention:'snapshot',enabled:true});
        for(const externalId of ['one','two'])await ctx.sources.upsert(sourceId,{externalId,revision:'1',observedAt:now(),title:'Generated '+externalId,text:'Generated body',kind:'file',layer:'snapshot'});
        const at=now();
        ctx.sources.reportStatus(sourceId,{state:'idle',lastSyncAt:at,coverage:{state:'complete',window:{to:at},processed:2,remaining:0,failed:0,limitations:[],updatedAt:at}});
        return {imported:2};
      };
      return {
        init:async()=>{},status:()=>({connected:true}),
        configure:host=>{
          host.ownerRoute({method:'POST',path:'/api/connectors/generated-connector/sync',handler:()=>sync()});
          host.ownerRoute({method:'POST',path:'/api/connectors/generated-connector/preview',handler:()=>({count:2})});
          host.ownerRoute({method:'POST',path:'/api/connectors/generated-connector/expire',handler:()=>{ctx.sources.reportStatus(sourceId,{state:'permission_required',code:'generated_permission_required'});return {state:'permission_required'};}});
        },
      };
    }};
}

async function fixture(t:TestContext){
  const directory=await mkdtemp(join(tmpdir(),'mote-connection-services-'));
  const node=await buildApp(config(directory),{backgroundWorker:false,agent:inactive,connectorManifests:[generatedConnector()]});
  t.after(async()=>{await node.app.close();await rm(directory,{recursive:true,force:true});});
  const services=async()=>{
    const response=await node.app.inject({url:'/api/connections/services',headers});
    assert.equal(response.statusCode,200,response.body);
    return servicesViewSchema.parse(response.json());
  };
  return {...node,directory,services};
}

test('CN1-01 a generated connector run projects its last time and item count',async t=>{
  const {app,services}=await fixture(t);
  const sync=await app.inject({method:'POST',url:'/api/connectors/generated-connector/sync',headers,payload:{}});
  assert.equal(sync.statusCode,200,sync.body);assert.equal(sync.json().imported,2);
  const view=await services(),item=view.services.find(service=>service.id===sourceKind);
  assert.ok(item,'the generated connector has a service card');
  assert.equal(item.kind,'service');assert.equal(item.state,'connected');
  assert.deepEqual(item.actions,['sync','dry-run','pause','remove']);
  assert.equal(item.jobs.length,1);
  assert.equal(item.jobs[0]!.kind,sourceKind);assert.equal(item.jobs[0]!.every,'5m');
  assert.ok(item.jobs[0]!.lastAt);assert.equal(item.jobs[0]!.lastCount,2);
  assert.deepEqual(item.tools,[]);
  assert.match(view.revision,/^[A-Za-z0-9_-]{43}$/);
});

test('CN1-02 an expired authorization changes state and the navigation badge',async t=>{
  const {app,services}=await fixture(t);
  assert.equal((await app.inject({method:'POST',url:'/api/connectors/generated-connector/sync',headers,payload:{}})).statusCode,200);
  const expired=await app.inject({method:'POST',url:'/api/connectors/generated-connector/expire',headers,payload:{}});
  assert.equal(expired.statusCode,200,expired.body);
  const item=(await services()).services.find(service=>service.id===sourceKind);
  assert.equal(item?.state,'reauth');
  assert.deepEqual(item?.actions,['reauth','remove']);
  assert.equal(item?.jobs[0]?.lastCount,2,'the last bounded fetch remains visible after authorization expires');
  const nav=await app.inject({url:'/api/nav-state',headers});
  assert.equal(nav.statusCode,200,nav.body);
  assert.equal(nav.json().badges.connections,true);
});

test('CN1-03 a dry run returns the count without writing source state',async t=>{
  const {app,store,services}=await fixture(t);
  assert.equal((await app.inject({method:'POST',url:'/api/connectors/generated-connector/sync',headers,payload:{}})).statusCode,200);
  const before={heads:store.db.prepare('SELECT COUNT(*) AS count FROM source_heads').get() as {count:number},
    versions:store.db.prepare('SELECT COUNT(*) AS count FROM source_versions').get() as {count:number},
    changes:store.db.prepare('SELECT COALESCE(MAX(seq),0) AS seq FROM changes').get() as {seq:number}};
  const dry=await app.inject({method:'POST',url:'/api/connections/services/'+encodeURIComponent(sourceKind)+'/dry-run',headers,payload:{}});
  assert.equal(dry.statusCode,200,dry.body);
  assert.deepEqual(dry.json(),{count:2});
  const after={heads:store.db.prepare('SELECT COUNT(*) AS count FROM source_heads').get() as {count:number},
    versions:store.db.prepare('SELECT COUNT(*) AS count FROM source_versions').get() as {count:number},
    changes:store.db.prepare('SELECT COALESCE(MAX(seq),0) AS seq FROM changes').get() as {seq:number}};
  assert.deepEqual(after,before);
  const item=(await services()).services.find(service=>service.id===sourceKind);
  assert.equal(item?.jobs[0]?.lastCount,2);
});

test('CN1-04 disabling a bundled connector removes its fetch jobs',async t=>{
  const {app,sources,services}=await fixture(t);
  const at=new Date().toISOString();
  sources.register({id:'generated-gmail-source',name:'Generated Gmail',kind:'gmail',deviceId:'generated-device',platform:'import',retention:'snapshot',enabled:true});
  sources.reportStatus('generated-gmail-source',{state:'idle',lastSyncAt:at,coverage:{state:'complete',window:{to:at},processed:3,remaining:0,failed:0,limitations:[],updatedAt:at}});
  const before=(await services()).services.find(service=>service.id==='gmail');
  assert.equal(before?.state,'connected');assert.equal(before?.jobs[0]?.lastCount,3);
  const path='/api/plugin-builds/'+encodeURIComponent('bundled:gmail'),current=await app.inject({url:path,headers});
  assert.equal(current.statusCode,200,current.body);
  const build=current.json();
  const disabled=await app.inject({method:'PATCH',url:path,headers,payload:{operationId:randomUUID(),expectedRevision:build.revision,selection:null}});
  assert.equal(disabled.statusCode,200,disabled.body);
  const item=(await services()).services.find(service=>service.id==='gmail');
  assert.equal(item?.state,'paused');assert.deepEqual(item?.jobs,[]);
  assert.deepEqual(item?.actions,['resume','remove']);
});

test('installed connector tools come from the manifest action declaration',async t=>{
  const {sources,store,services}=await fixture(t);
  const packageId='mote.official.generated',kind='mote.official.generated';
  sources.capabilities.register(kind,{lifecycle:'continuous',discovery:'explicit-selection',listening:'polling',readOriginal:'none',synchronization:'revisions',externalWrite:false});
  const at=new Date().toISOString();
  sources.register({id:'generated-package-source',name:'Generated package source',kind,deviceId:'generated-device',platform:'import',retention:'snapshot',enabled:true});
  sources.reportStatus('generated-package-source',{state:'idle',lastSyncAt:at,coverage:{state:'complete',window:{to:at},processed:1,remaining:0,failed:0,limitations:[],updatedAt:at}});
  store.db.prepare('INSERT INTO plugin_build_instances VALUES(?,?) ON CONFLICT(id) DO UPDATE SET json=excluded.json').run(packageId,JSON.stringify({
    id:packageId,packageId,kind:'package',desired:null,observed:'stopped',blockers:[],
    package:{view:{state:'installed'},manifest:{name:'Generated package',sourceCatalog:[{id:'generated-package',title:'Generated package',kinds:[kind]}],actionCapabilities:[{id:'generated.tool'}]}},
  }));
  store.db.prepare('INSERT INTO plugin_build_instances VALUES(?,?) ON CONFLICT(id) DO UPDATE SET json=excluded.json').run('generated-package-instance',JSON.stringify({
    id:'generated-package-instance',packageId,kind:'instance',desired:{packageId,version:'1',configurationRevision:1},observed:'active',blockers:[],
    instance:{view:{packageId,desired:true,observed:'ready',issues:[],capabilities:[{id:'generated.tool',state:'verified'}]}},
  }));
  const item=(await services()).services.find(service=>service.id==='generated-package');
  assert.equal(item?.name,'Generated package');assert.equal(item?.state,'connected');
  assert.deepEqual(item?.tools,['generated.tool']);
});

test('AI access tokens are projected as removable AI access cards',async t=>{
  const {app,services}=await fixture(t);
  const minted=await app.inject({method:'POST',url:'/api/connections/mcp',headers,payload:{serverUrl:'https://synthetic.invalid',label:'Generated agent',access:'read'}});
  assert.equal(minted.statusCode,200,minted.body);
  const item=(await services()).services.find(service=>service.kind==='ai-access');
  assert.equal(item?.name,'Generated agent');assert.equal(item?.state,'connected');
  assert.deepEqual(item?.actions,['remove']);assert.deepEqual(item?.jobs,[]);assert.deepEqual(item?.tools,[]);
  assert.equal(item?.id,minted.json().credential.id);
});
