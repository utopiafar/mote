import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {buildApp} from '../src/app.js';
import type {Config} from '../src/config.js';
import {AssistantMatters} from '../src/assistant-matters.js';

test('owner matter routes preserve revision conflicts, explicit empty scope and fresh evidence disclosure',async t=>{
 const dataDir=mkdtempSync(join(tmpdir(),'mote-u2-routes-')),token='generated-u2-owner',headers={authorization:'Bearer '+token};
 const config:Config={dataDir,token,tokenPath:'fixture',host:'127.0.0.1',port:0,maxStorageBytes:20_000_000,maxExportBytes:1_000_000,
  retentionDays:0,insightIntervalHours:0,allowedOrigins:[],model:'',modelBaseUrl:'',apiKey:'',allowUnauthenticatedLocal:false,embeddingModel:'',embeddingBaseUrl:'',embeddingApiKey:'',logLevel:'silent'};
 const node=await buildApp(config,{backgroundWorker:false,agent:{configured:false,query:async()=>{throw Error('Unexpected model call');},close:async()=>{}}});
 t.after(async()=>{await node.app.close();rmSync(dataDir,{recursive:true,force:true});});await node.app.ready();
 const id=randomUUID(),created=await node.app.inject({method:'POST',url:'/api/notes',headers,payload:{id,deviceId:'generated-device',deviceName:'Generated',platform:'import',capturedAt:'2026-11-01T00:00:00Z',text:'Generated U2 original'}});
 assert.equal(created.statusCode,201,created.body);
 const service=new AssistantMatters(node.store),matter=service.command({type:'create',requestId:randomUUID(),goal:'Generated meeting preparation and follow-up',scope:{kind:'all'},evidenceIds:[id]},
  {currentEvidence:()=>[{id,title:'Generated U2 original',at:'2026-11-01T00:00:00Z'}],currentTask:()=>undefined});
 const read=(scope:unknown={kind:'all'})=>node.app.inject({method:'GET',url:'/api/assistant/matters/'+matter.id+'?'+new URLSearchParams({scope:JSON.stringify(scope)}),headers});
 const detail=await read();assert.equal(detail.statusCode,200,detail.body);assert.equal(detail.json().linkedEvidence[0].id,id);
 const command={type:'edit',matterId:matter.id,expectedRevision:1,goal:'Generated owner edit'};
 const edited=await node.app.inject({method:'POST',url:'/api/assistant/matter-commands',headers,payload:command});assert.equal(edited.statusCode,200,edited.body);
 const conflict=await node.app.inject({method:'POST',url:'/api/assistant/matter-commands',headers,payload:{...command,goal:'Generated outdated edit'}});assert.equal(conflict.statusCode,409,conflict.body);assert.equal((await read()).json().matter.goal,'Generated owner edit');
 assert.equal((await read({kind:'selection',sourceIds:[]})).statusCode,404);
 const empty=await node.app.inject({method:'GET',url:'/api/assistant/matters?'+new URLSearchParams({scope:JSON.stringify({kind:'selection',sourceIds:[]})}),headers});assert.equal(empty.statusCode,200,empty.body);assert.deepEqual(empty.json().items,[]);
 const configured=await node.app.inject({method:'POST',url:'/api/assistant/routines',headers,payload:{requestId:randomUUID(),goal:'Generated meeting review',scope:{kind:'all'},timeZone:'Asia/Shanghai',trigger:{kind:'daily',localTime:'09:00'},matterId:matter.id}});assert.equal(configured.statusCode,200,configured.body);
 for(const [scope,status] of [[{kind:'all'},200],[{kind:'selection',sourceIds:[]},404],[{kind:'selection',evidenceIds:[id]},404]] as const){
  const rule=await node.app.inject({method:'GET',url:'/api/assistant/routines/'+configured.json().id+'?'+new URLSearchParams({scope:JSON.stringify(scope)}),headers});assert.equal(rule.statusCode,status,rule.body);
 }
 const rules=await node.app.inject({method:'GET',url:'/api/assistant/routines?'+new URLSearchParams({scope:JSON.stringify({kind:'all'}),matterId:matter.id}),headers});assert.equal(rules.statusCode,200,rules.body);assert.deepEqual(rules.json().items.map((item:{id:string})=>item.id),[configured.json().id]);
 const paused=await node.app.inject({method:'POST',url:'/api/assistant/matter-commands',headers,payload:{type:'pause',matterId:matter.id,expectedRevision:2}});assert.equal(paused.statusCode,200,paused.body);assert.equal(paused.json().state,'paused');assert.equal(node.modelAuthorization.view().state,'off');
 const removed=await node.app.inject({method:'DELETE',url:'/api/notes/'+id,headers});assert.equal(removed.statusCode,200,removed.body);
 const withdrawn=await read();assert.equal(withdrawn.statusCode,200,withdrawn.body);assert.deepEqual(withdrawn.json().linkedEvidence,[]);assert.equal(withdrawn.json().coverage.evidence,'partial');assert.doesNotMatch(withdrawn.body,/Generated U2 original/);
 const unauthenticated=await node.app.inject({method:'GET',url:'/api/assistant/matters?scope=%7B%22kind%22%3A%22all%22%7D'});assert.equal(unauthenticated.statusCode,401);
});
