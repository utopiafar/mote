import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {PassThrough,Writable} from 'node:stream';
import type {spawn} from 'node:child_process';
import {providerModels,codexModels} from '../src/model-catalog.js';
import type {ModelSettings} from '@mote/shared/models';
const settings:ModelSettings={provider:'custom',protocol:'openai-completions',model:'',baseUrl:'https://fixture.invalid/v1',apiKey:'generated-secret',headers:{'X-Fixture':'yes'},extraBody:{},reasoningEffort:'auto',maxTokens:8192,modelRequestTimeoutMs:10000,agentTimeoutMs:10000,allowUnauthenticatedLocal:false};
test('provider catalog supports account headers, pagination, Google names and generation filtering',async()=>{
  let calls=0;
  const result=await providerModels({...settings,protocol:'anthropic-messages',baseUrl:'https://fixture.invalid'},(async(url,init)=>{
    calls++;assert.equal(new Headers(init?.headers).get('x-api-key'),'generated-secret');assert.equal(init?.redirect,'error');
    assert.equal(new URL(String(url)).pathname,'/v1/models');
    return Response.json(calls===1?{data:[{id:'one',display_name:'One'}],has_more:true,last_id:'one'}:{data:[{id:'two'}],has_more:false});
  }) as typeof fetch);
  assert.deepEqual(result.items,[{id:'one',name:'One'},{id:'two',name:'two'}]);assert.equal(calls,2);
  const google=await providerModels({...settings,protocol:'google-generative-ai'},(async(_url,init)=>{
    assert.equal(new Headers(init?.headers).get('x-goog-api-key'),'generated-secret');
    return Response.json({models:[{name:'models/generated',displayName:'Generated',supportedGenerationMethods:['generateContent']},{name:'models/embedding',supportedGenerationMethods:['embedContent']}]});
  }) as typeof fetch);assert.deepEqual(google.items,[{id:'generated',name:'Generated'}]);
});
test('catalog failure does not echo remote errors or credentials',async()=>{
  await assert.rejects(providerModels(settings,(async()=>new Response('generated-secret',{status:401})) as typeof fetch),e=>!String(e).includes('generated-secret'));
  await assert.rejects(providerModels(settings,(async()=>Response.json({bad:'generated-secret'})) as typeof fetch));
});
test('Codex discovery only initializes and pages model/list, then closes the child',async()=>{
  const methods:string[]=[];let killed=false;
  const launch=((command:string,args:string[])=>{
    assert.equal(command,'codex');assert.deepEqual(args,['app-server']);
    const child=new EventEmitter() as any;child.stdout=new PassThrough();child.stderr=new PassThrough();
    child.kill=()=>{killed=true;queueMicrotask(()=>child.emit('close',0));return true;};
    child.stdin=new Writable({write(chunk,_encoding,done){const request=JSON.parse(chunk.toString());methods.push(request.method);
      if(request.method==='initialize')queueMicrotask(()=>child.stdout.write(JSON.stringify({id:request.id,result:{}})+'\n'));
      if(request.method==='model/list')queueMicrotask(()=>child.stdout.write(JSON.stringify({id:request.id,result:{data:[{model:request.params.cursor?'model-two':'model-one',displayName:'Model',supportedReasoningEfforts:[{reasoningEffort:'high'}]}],nextCursor:request.params.cursor?null:'next'}})+'\n'));
      done();}});return child;
  }) as typeof spawn;
  const catalog=await codexModels(launch);assert.equal(catalog.items.length,2);assert.deepEqual(methods,['initialize','initialized','model/list','model/list']);assert.equal(killed,true);
});

test('draft catalogs use the selected preset credentials, not the legacy default',async t=>{
  const {createServer}=await import('node:http');
  const {mkdtemp,rm}=await import('node:fs/promises');
  const {tmpdir}=await import('node:os');const {join}=await import('node:path');
  const {ModelSettingsStore}=await import('../src/model-settings.js');
  const received:string[]=[];
  const server=createServer((req,res)=>{received.push(req.headers.authorization??'');res.setHeader('content-type','application/json');res.end(JSON.stringify({data:[{id:'generated-model'}]}));});
  await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
  const directory=await mkdtemp(join(tmpdir(),'mote-catalog-credentials-'));
  const baseUrl=`http://127.0.0.1:${(server.address() as {port:number}).port}/v1`;
  const store=new ModelSettingsStore({directory,environment:{...settings,baseUrl,headers:{}},prepare:async()=>({activate(){},async dispose(){}}),probe:async()=>({ok:true,code:'ok',message:'',durationMs:0})});
  t.after(async()=>{await store.close();await new Promise<void>(resolve=>server.close(()=>resolve()));await rm(directory,{recursive:true,force:true});});
  await store.initialize();
  const view=await store.updateProfile('second',{revision:0,name:'Second account',settings:{...settings,baseUrl,apiKey:'second-generated-key',headers:{}}});
  const {apiKey:_key,headers:_headers,extraBody:_body,...parameters}=settings;
  await store.models({revision:view.revision,settings:{...parameters,baseUrl}},'second');
  assert.deepEqual(received,['Bearer second-generated-key']);
  await assert.rejects(store.models({revision:view.revision,settings:{...parameters,baseUrl:'https://different.invalid/v1'}},'second'),{code:'model_settings_credential_reuse'});
  assert.equal(received.length,1,'blocked destinations must not receive saved credentials');
});
