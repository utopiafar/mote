const test=require('node:test');
const assert=require('node:assert/strict');
const {mkdtempSync,writeFileSync,readFileSync,existsSync,mkdirSync}=require('node:fs');
const {tmpdir}=require('node:os');
const {join,resolve}=require('node:path');
const {spawn}=require('node:child_process');
const {startArrivals}=require('./material-load-arrivals.cjs');
const {makeFixture}=require('./material-load-fixture.cjs');
const delay=ms=>new Promise(r=>setTimeout(r,ms));
async function until(fn){for(let i=0;i<200;i++){if(await fn())return;await delay(25);}throw Error('Small fixture deadline');}
test('independent schedule survives held ACK, producer-only outage and accepted lost ACK replay against actual source route',async t=>{
 const root=mkdtempSync(join(tmpdir(),'mote-arrivals-')); // Kept as private diagnostic evidence, including failures.
 const fixture=makeFixture('interactive-400'),fixturePath=join(root,'fixture.json'),ready=join(root,'ready.json'),token='generated-only-token-'.repeat(3);
 writeFileSync(fixturePath,JSON.stringify(fixture),{mode:0o600});
 const config={dataDir:join(root,'vault'),token,tokenPath:join(root,'token'),host:'127.0.0.1',port:0,maxStorageBytes:150000000,maxExportBytes:1000000,retentionDays:0,insightIntervalHours:0,allowedOrigins:[],model:'fixture',modelProvider:'custom',modelProtocol:'openai-completions',modelBaseUrl:'http://127.0.0.1:1/v1',apiKey:'',allowUnauthenticatedLocal:false,embeddingModel:'',embeddingBaseUrl:'',embeddingApiKey:'',logLevel:'silent',diagnosticsEnabled:false};
 const configPath=join(root,'config.json');writeFileSync(configPath,JSON.stringify({config,fixturePath,ready}),{mode:0o600});
 const child=spawn(process.execPath,[resolve('scripts/material-load-fixture-server.mjs'),configPath],{stdio:['ignore','pipe','pipe'],env:{PATH:process.env.PATH,HOME:process.env.HOME}});let errors='';child.stderr.on('data',b=>{errors+=b;writeFileSync(join(root,'server-stderr.log'),errors,{mode:0o600});});child.stdout.resume();
 let proxy,run,release;const held=new Promise(r=>{release=r;});t.after(async()=>{release();run?.stop();await proxy?.close();child.kill('SIGTERM');await Promise.race([new Promise(r=>child.once('exit',r)),delay(3000)]);if(child.exitCode===null)child.kill('SIGKILL');});
 await until(()=>{if(child.exitCode!==null)throw Error(errors);return existsSync(ready);});const endpoint=JSON.parse(readFileSync(ready)).url;
 const request=async(base,path,body)=>{const r=await fetch(base+path,{method:body?'POST':'GET',headers:{authorization:'Bearer '+token,'content-type':'application/json','x-mote-ingress-version':'2'},...(body?{body:JSON.stringify(body)}:{})});assert.ok(r.ok);return r.json();};
 await request(endpoint,'/api/sources',{id:'generated-load',name:'Generated',kind:'coding-agent',deviceId:'fixture-load',platform:'import'});await request(endpoint,'/api/fixture/configure',{});
 const {startProxy,command}=await import('./journey-network-proxy.mjs');const control=join(root,'proxy/control.json');proxy=await startProxy({upstream:endpoint,control,sourceBatchAck:true,timeoutMs:2000});await command(control,'arm');
 let attempts=0;
 run=startArrivals({records:fixture.records.slice(0,12),ledgerPath:join(root,'arrivals.jsonl'),intervalMs:10,dispatchMs:25,batchSize:4,maxPending:12,deadlineMs:10000,send:async(source,items)=>{attempts++;if(attempts===1)await held;return request(proxy.url,'/api/sources/'+source+'/items/batch',{items});}});
 await until(()=>run.snapshot().enqueued===12);assert.equal(run.snapshot().uniqueAcknowledged,0);assert.equal(attempts,1,'ACK delay cannot throttle arrivals');
 release();await until(()=>existsSync(proxy.receiptPath));assert.equal((await request(endpoint,'/api/fixture/state')).calls.length,0,'Direct UI endpoint remains available while producer offline; no model');
 await command(control,'offline');await assert.rejects(request(proxy.url,'/api/fixture/state'));await command(control,'recover');
 const result=await run.done;assert.equal(result.uniqueAcknowledged,12);assert.ok(Object.values(result.attempts).some(n=>n>1));
 let state;await until(async()=>{state=await request(endpoint,'/api/fixture/drain',{});return state.count===13;});assert.equal(new Set(state.catalog.map(r=>r.id)).size,13);assert.equal(state.calls.length,0);
 assert.equal(new Set(state.publications.map(e=>JSON.stringify([e.materialId,e.revision]))).size,13);assert.ok(state.publications.every(e=>Number.isFinite(Date.parse(e.publishedAt))&&Date.parse(e.publishedAt)>Date.parse('2026-09-01T00:00:00Z')),'Publication clock is runtime, not source observedAt');
 assert.deepEqual(state.catalog.filter(x=>x.id!==fixture.control.materialId).map(x=>x.id).sort(),fixture.records.slice(0,12).map(x=>x.materialId).sort());
 const events=readFileSync(join(root,'arrivals.jsonl'),'utf8').trim().split('\n').map(JSON.parse);assert.deepEqual(events.filter(x=>x.event==='enqueued').map(x=>x.plannedMs),Array.from({length:12},(_,i)=>i*10));
 writeFileSync(join(root,'receipt.json'),JSON.stringify({status:'passed',realModels:0,planned:12,uniqueAcknowledged:12,uniqueMaterials:12,result},null,2),{mode:0o600});t.diagnostic('Private small-run evidence: '+root);
});

test('wrong receipt identity fails closed, and late success cannot change a deadline failure',async t=>{
 const root=mkdtempSync(join(tmpdir(),'mote-arrival-boundary-')),records=makeFixture('interactive-400').records.slice(0,1);
 const wrong=startArrivals({records,ledgerPath:join(root,'wrong.jsonl'),intervalMs:5,dispatchMs:5,deadlineMs:500,maxPending:1,send:async()=>({receipts:[{sourceId:'other',externalId:'0',revision:'1',receipt:{state:'received'}}]})});
 await assert.rejects(wrong.done,/identity/);assert.equal(wrong.snapshot().uniqueAcknowledged,0);
 let release;const held=new Promise(r=>{release=r;});const late=startArrivals({records,ledgerPath:join(root,'late.jsonl'),intervalMs:5,dispatchMs:5,deadlineMs:50,maxPending:1,send:()=>held});
 await assert.rejects(late.done,/deadline/);release({receipts:[{sourceId:records[0].sourceId,externalId:'0',revision:'1',receipt:{state:'received'}}]});await late.settled();assert.equal(late.snapshot().uniqueAcknowledged,0);assert.ok(!readFileSync(join(root,'late.jsonl'),'utf8').includes('"event":"acknowledged"'));
 t.diagnostic('Private failure-boundary evidence: '+root);
});

test('publication timestamps reveal commits between unchanged drain samples and reconstruct the pending queue', () => {
 const {publicationOverlap}=require('./material-load-arrivals.cjs');
 const schedule=Array.from({length:4},(_,i)=>({key:'key'+i,materialId:'material'+i,plannedMs:i*10}));
 const ledger=[{event:'plan',schedule},...schedule.map((x,i)=>({event:'enqueued',key:x.key,at:1000+i*10})),{event:'acknowledged',key:'key0',at:1100},{event:'acknowledged',key:'key1',at:1150},{event:'acknowledged',key:'key2',at:1300},{event:'acknowledged',key:'key3',at:1350}];
 // Both bounded drain call samples see zero internal change. A real publication lies between them.
 const drainSamples=[{start:1160,end:1170,beforeCount:1,afterCount:1},{start:1240,end:1250,beforeCount:2,afterCount:2}];
 assert.ok(drainSamples.every(x=>x.beforeCount===x.afterCount));
 const publications=[{materialId:'material1',revision:'1',publishedAt:new Date(1200).toISOString()},{materialId:'not-planned',revision:'1',publishedAt:new Date(1200).toISOString()}];
 const result=publicationOverlap({ledger,publications,actions:[{name:'wheel',start:1190,end:1230},{name:'later',start:1400,end:1450}],recoveredAt:1180});
 assert.throws(()=>publicationOverlap({ledger,publications,actions:[],recoveredAt:NaN}),/Recovery/);
 const cleared=[...ledger,{event:'acknowledged',key:'key2',at:1175},{event:'acknowledged',key:'key3',at:1180}];
 const clearedResult=publicationOverlap({ledger:cleared,publications,actions:[{name:'wheel',start:1190,end:1230}],recoveredAt:1180});
 assert.equal(clearedResult.events.length,1);assert.equal(clearedResult.events[0].pendingAtPublication,0);assert.equal(clearedResult.overlappingActions.length,0);
 assert.equal(result.events.length,1);assert.equal(result.events[0].pendingAtPublication,2);assert.deepEqual(result.overlappingActions.map(x=>x.name),['wheel']);
 assert.equal(publicationOverlap({ledger,publications,actions:[{name:'before',start:1100,end:1170}],recoveredAt:1180}).overlappingActions.length,0);
 assert.equal(publicationOverlap({ledger,publications,actions:[{name:'wide',start:1000,end:1400}],recoveredAt:1250}).events.length,0);
});
