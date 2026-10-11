import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {mkdtemp,rm,readFile} from 'node:fs/promises';
import {spawn} from 'node:child_process';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import type {ModelSettings} from '@mote/shared/models';
import {HindsightModelRelay} from '../src/hindsight-model-relay.js';
import {HindsightService,ManagedHindsightRuntime,HindsightRuntimeLease,hindsightModelFingerprint} from '../src/hindsight-runtime.js';
import {HindsightEngine,hindsightEvidenceRanges} from '../src/hindsight-engine.js';
const profile:ModelSettings={provider:'openai',protocol:'openai-completions',baseUrl:'http://127.0.0.1:1/v1',model:'generated-transport-model',reasoningEffort:'medium',serviceTier:'default',maxTokens:1000,modelRequestTimeoutMs:null,agentTimeoutMs:1000,allowUnauthenticatedLocal:true,apiKey:'generated-fixture',headers:{},extraBody:{}};

test('one live process cannot claim its configuration twice, and an unclaimed close cannot release its owner',async()=>{
 const directory=await mkdtemp(join(tmpdir(),'mote-hindsight-lease-')),path=join(directory,'runtime-host.json'),owner=new HindsightRuntimeLease(path),other=new HindsightRuntimeLease(path);
 try{await owner.claim();assert.equal(await owner.owns(),true);await assert.rejects(other.claim(),/Another live host/);await other.release();assert.equal(await owner.owns(),true);await owner.release();await other.claim();assert.equal(await other.owns(),true);}finally{await owner.release();await other.release();await rm(directory,{recursive:true,force:true});}
});

test('a crashed native host lease is reclaimed with a new token',async()=>{
 const directory=await mkdtemp(join(tmpdir(),'mote-hindsight-crash-')),path=join(directory,'runtime-host.json');
 const child=spawn(process.execPath,['--input-type=module','-e',`import{writeFileSync}from'node:fs';import{execFileSync}from'node:child_process';writeFileSync(process.argv[1],JSON.stringify({pid:process.pid,started:execFileSync('ps',['-p',String(process.pid),'-o','lstart='],{encoding:'utf8'}).trim(),token:'generated-crashed-token-'.repeat(3)}));setInterval(()=>{},1000)`,path],{stdio:'ignore'});
 try{for(let attempt=0;;attempt++){try{await readFile(path);break;}catch{assert.ok(attempt<100);await new Promise(resolve=>setTimeout(resolve,10));}}const prior=JSON.parse(await readFile(path,'utf8'));const exited=new Promise(resolve=>child.once('exit',resolve));child.kill('SIGKILL');await exited;const replacement=new HindsightRuntimeLease(path);await replacement.claim();assert.notEqual(JSON.parse(await readFile(path,'utf8')).token,prior.token);await replacement.release();}finally{child.kill('SIGKILL');await rm(directory,{recursive:true,force:true});}
});

test('legal long originals retain every exact UTF-16 range across native transport partitions',()=>{
 const text='outside|'+'x'.repeat(11999)+'🌱'+'y'.repeat(20000)+'|outside',record={id:'generated',ocrText:text} as any,offset=8,length=text.length-16;
 const {originals,transport}=hindsightEvidenceRanges([{record,offset,length}]);assert.equal(originals[0].text,text.slice(offset,offset+length));assert.equal(transport.map(range=>range.text).join(''),originals[0].text);let next=offset;
 for(const range of transport){assert.equal(range.offset,next);assert.ok(range.length<=12000);assert.equal(range.text,text.slice(range.offset,range.offset+range.length));assert.ok(!/^[\uDC00-\uDFFF]|[\uD800-\uDBFF]$/.test(range.text));next+=range.length;}assert.equal(next,offset+length);
 assert.throws(()=>hindsightEvidenceRanges([{record,offset:0,length:text.length+1}]),/bounded exact/);
});

test('configuration generations own distinct native runtime identities while credential rotation keeps semantics',()=>{
 assert.equal(hindsightModelFingerprint(profile),hindsightModelFingerprint({...profile,apiKey:'rotated',headers:{Authorization:'rotated'}}));
 assert.notEqual(hindsightModelFingerprint(profile),hindsightModelFingerprint({...profile,model:'different-model'}));
 const first=new ManagedHindsightRuntime({directory:'/generated/a',instanceId:'generated-instance',configurationIdentity:'generation-a',settings:profile}),second=new ManagedHindsightRuntime({directory:'/generated/b',instanceId:'generated-instance',configurationIdentity:'generation-b',settings:profile});
 assert.notEqual(first.container,second.container);assert.notEqual(first.volume,second.volume);
});

test('remote native service requires TLS and a strong token; aborted transport is not a successful receipt',async()=>{
 assert.throws(()=>new HindsightService('http://example.com','x'.repeat(64)),/loopback HTTP/);
 assert.throws(()=>new HindsightService('https://example.com','short'),/strong access token/);
 assert.doesNotThrow(()=>new HindsightService('https://example.com','x'.repeat(64)));
 const controller=new AbortController();controller.abort(new Error('Generated cancel'));
 await assert.rejects(new HindsightService('http://127.0.0.1:1').request('POST','/fixture',{},controller.signal),/Generated cancel/);
});

test('relay shutdown interrupts a pending configured HTTP request and records unknown usage as failed',async()=>{
 let requestReady!:()=>void;const ready=new Promise<void>(resolve=>requestReady=resolve);
 const upstream=createServer(async(req)=>{for await(const _ of req){}requestReady();});
 await new Promise<void>(resolve=>upstream.listen(0,'127.0.0.1',resolve));
 const events:unknown[]=[],relay=new HindsightModelRelay({...profile,baseUrl:`http://127.0.0.1:${(upstream.address() as {port:number}).port}/v1`},{onRequestStarted:r=>events.push({type:'started',...r}),onRequestFinished:r=>events.push({type:'finished',...r}),onUsage:usage=>events.push({type:'usage',usage})});
 try{
  const endpoint=await relay.start(),pending=fetch(endpoint.baseUrl+'/chat/completions',{method:'POST',headers:{Authorization:'Bearer '+endpoint.token,'Content-Type':'application/json'},body:JSON.stringify({messages:[{role:'user',content:'Generated transport fixture'}]})}).catch(()=>null);
  await ready;await relay.close();await pending;await new Promise(resolve=>setImmediate(resolve));
  assert.equal(events.filter((event:any)=>event.type==='started').length,1);assert.equal(events.filter((event:any)=>event.type==='finished'&&event.status==='failed').length,1);assert.equal(events.filter((event:any)=>event.type==='usage').length,0);
 }finally{await relay.close();upstream.closeAllConnections();await new Promise<void>(resolve=>upstream.close(()=>resolve()));}
});

test('an initially aborted capability probe does not initialize a native service or model',async()=>{
 const directory=await mkdtemp(join(tmpdir(),'mote-hindsight-aborted-'));let starts=0;
 const engine=new HindsightEngine({directory,runtime:{service:async()=>{starts++;throw Error('Unexpected startup');},startWorker:async()=>{},stopWorker:async()=>{},close:async()=>{}}});
 try{const controller=new AbortController();controller.abort(new Error('Generated probe abort'));await assert.rejects(engine.probe(controller.signal),/Generated probe abort/);assert.equal(starts,0);}finally{await engine.close();await rm(directory,{recursive:true,force:true});}
});

test('queued native inference rechecks revoked evidence authority before reaching the configured endpoint',async()=>{
 let release!:()=>void,queued!:()=>void,revoked=false,upstreamCalls=0;
 const waiting=new Promise<void>(resolve=>queued=resolve),admitted=new Promise<void>(resolve=>release=resolve);
 const upstream=createServer((_req,res)=>{upstreamCalls++;res.end('{}');});await new Promise<void>(resolve=>upstream.listen(0,'127.0.0.1',resolve));
 const relay=new HindsightModelRelay({...profile,baseUrl:`http://127.0.0.1:${(upstream.address() as {port:number}).port}/v1`},{runModel:async task=>{queued();await admitted;return task();},assertModelAuthority:()=>{if(revoked)throw Error('Generated evidence authorization revoked');}});
 try{const endpoint=await relay.start(),pending=fetch(endpoint.baseUrl+'/chat/completions',{method:'POST',headers:{Authorization:'Bearer '+endpoint.token,'Content-Type':'application/json'},body:JSON.stringify({messages:[{role:'user',content:'Generated evidence'}]})});await waiting;revoked=true;release();assert.equal((await pending).status,502);assert.equal(upstreamCalls,0);}finally{release();await relay.close();upstream.closeAllConnections();await new Promise<void>(resolve=>upstream.close(()=>resolve()));}
});

test('host model admission remains occupied until the complete inference body arrives',async()=>{
 let finish!:()=>void,headers!:()=>void,slotActive=false;
 const bodyReady=new Promise<void>(resolve=>finish=resolve),headersSent=new Promise<void>(resolve=>headers=resolve);
 const upstream=createServer(async(req,res)=>{for await(const _ of req){}res.writeHead(200,{'Content-Type':'application/json'});res.flushHeaders();headers();await bodyReady;res.end(JSON.stringify({choices:[{message:{role:'assistant',content:'Generated response'}}]}));});await new Promise<void>(resolve=>upstream.listen(0,'127.0.0.1',resolve));
 const relay=new HindsightModelRelay({...profile,baseUrl:`http://127.0.0.1:${(upstream.address() as {port:number}).port}/v1`},{runModel:async task=>{slotActive=true;try{return await task();}finally{slotActive=false;}}});
 try{const endpoint=await relay.start(),pending=fetch(endpoint.baseUrl+'/chat/completions',{method:'POST',headers:{Authorization:'Bearer '+endpoint.token,'Content-Type':'application/json'},body:JSON.stringify({messages:[{role:'user',content:'Generated evidence'}]})});await headersSent;await new Promise(resolve=>setImmediate(resolve));assert.equal(slotActive,true);finish();assert.equal((await pending).status,200);assert.equal(slotActive,false);}finally{finish();await relay.close();upstream.closeAllConnections();await new Promise<void>(resolve=>upstream.close(()=>resolve()));}
});
