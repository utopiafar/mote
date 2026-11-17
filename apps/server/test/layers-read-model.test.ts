import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {buildApp} from '../src/app.js';
import type {ConfigurationPlatformOptions} from '../src/config.js';
import {fixtureMemoryResult} from './fixtures/memory-result.js';

const token='generated-layers-owner-token',headers={authorization:`Bearer ${token}`};
const config=(dataDir:string):ConfigurationPlatformOptions=>({path:(dataDir)+'/mote.yaml',privateCredential:{token:token,tokenPath:'fixture-only'},initialDocument:{version:1,revision:0,storage:{dataDir:dataDir,maxExportBytes:1_000_000},server:{host:'127.0.0.1',port:0,allowedOrigins:[]},execution:{insightIntervalHours:0},models:{deployment:{model:'',apiKey:'',allowUnauthenticatedLocal:false,protocol:'deepseek',reasoningEffort:'high'},embedding:{model:'',baseUrl:'',apiKey:''}}}});

test('assembled source HTTP overview retains exact layer totals and native Memory inventory through staleness, restart and deletion',async t=>{
 const directory=mkdtempSync(join(tmpdir(),'mote-layers-read-model-'));let running=await buildApp(config(directory));
 t.after(async()=>{await running.app.close();rmSync(directory,{recursive:true,force:true});});
 const read=async()=>{const response=await running.app.inject({url:'/api/layers',headers});assert.equal(response.statusCode,200);return response.json();};
 assert.equal((await running.app.inject({url:'/api/layers'})).statusCode,401);
 assert.deepEqual(await read(),{...running.sources.summary(),memories:0});
 const {sources,memories,store}=running;
 sources.register({id:'generated-source',name:'Generated',kind:'custom',deviceId:'generated',platform:'import'});
 const item={externalId:'generated-item',revision:'1',observedAt:'2026-10-01T00:00:00Z',kind:'message',layer:'original',text:'Generated exact owner statement'};
 const original=await sources.upsert('generated-source',item);
 const memory=memories.extract(fixtureMemoryResult(memories,{answer:JSON.stringify({memories:[{title:'Generated owner statement',statement:`Generated exact owner statement [${original.id}]`,uncertainty:'Generated fixture only',evidenceIds:[original.id]}]}),citations:[{id:original.id,capturedAt:item.observedAt,appName:'generated',excerpt:item.text}],trace:[],runId:'generated-layers-memory'}),'fixture-model').items[0];
 assert.equal((await read()).memories,1);
 await sources.upsert('generated-source',{...item,revision:'2',observedAt:'2026-10-01T01:00:00Z',layer:'snapshot',text:'Generated revised owner statement'});
 assert.equal(memories.get(memory.id).status,'stale');assert.equal(memories.list().length,0);
 const expected={...sources.summary(),memories:1},overview=await read();
 assert.deepEqual(overview,JSON.parse(JSON.stringify(expected)));
 assert.deepEqual(overview.layers,[{layer:'original',count:1},{layer:'snapshot',count:1}]);assert.equal(overview.sources,1);
 await running.app.close();running=await buildApp(config(directory));
 assert.deepEqual(await read(),overview);
 running.store.delete(original.id);
 assert.deepEqual(await read(),JSON.parse(JSON.stringify({...running.sources.summary(),memories:0})));
 assert.equal(running.memories.list({includeStale:true}).length,0);
});
