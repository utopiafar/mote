/** Independent acceptance of PR153 plus the bounded M05/M06 dependency handoff.
 * Both barriers wrap real production operations; only generated external I/O is
 * held. Domain rows, grants, leases, evidence and publication are never seeded. */
import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {DatabaseSync} from 'node:sqlite';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import sharp from 'sharp';
import {defaultModelDomain,defaultModelSettings} from '../src/model-settings.js';
import {bytesHash} from '../src/scope/originals.js';
import {memoryFixture} from './fixtures/ask-reader-memory.js';
import {deferred,protocol} from './fixtures/ask-reader-host.js';
import {waitForState} from './fixtures/scoped-query-accounts.js';

for(const transition of ['source-withdraw','account-epoch','cancel','same-id-recreate','caller-policy','unknown','completed'] as const){
 test('Ask + processing recheck preserves '+transition+' at asynchronous boundaries',async t=>{
  const handoff=transition!=='unknown'&&transition!=='completed';
  const f=await memoryFixture(t,true),aMaterial=await f.publish(f.a,'A'),bMaterial=await f.publish(f.b,'B');
  assert.equal(aMaterial.id,bMaterial.id,'same IDs must select independent owner rows');
  await f.extract(f.a,aMaterial.id);const directories=await f.externalize([f.a]),memory=(await f.ok(f.a.token,'/api/memories')).items[0];
  let address=await f.node.app.listen({port:0,host:'127.0.0.1'});
  const http=async(token:string|undefined,path:string,method='GET',payload?:unknown)=>{
   const response=await fetch(address+path,{method,headers:{...protocol,...(token?{authorization:'Bearer '+token}:{}),...(payload===undefined?{}:{'content-type':'application/json'})},...(payload===undefined?{}:{body:JSON.stringify(payload)})});
   const body=await response.text();assert.equal(response.status,200,method+' '+path+': '+body);return JSON.parse(body);
  };
  const calls:string[]=[],media=createServer(async(req,res)=>{
   for await(const _ of req){}const key=String(req.headers.authorization);calls.push(key);
   if(key==='Bearer GENERATED_SEAM_OLD'&&transition!=='completed'){res.statusCode=transition==='unknown'?503:400;if(transition!=='unknown')res.setHeader('X-Mote-Execution-Started','false');res.end('{}');return;}
   res.setHeader('X-Mote-Execution','local');res.end(JSON.stringify({durationMs:0,engine:'generated-seam',segments:[{startMs:0,endMs:0,text:key}]}));
  });
  await new Promise<void>(resolve=>media.listen(0,'127.0.0.1',resolve));t.after(async()=>{media.closeAllConnections();await new Promise<void>(resolve=>media.close(()=>resolve()));});
  const endpoint=media.address();assert.ok(endpoint&&typeof endpoint!=='string');
  const settings=(key:string)=>({...defaultModelSettings(),provider:'custom',protocol:'mote-media',model:'',baseUrl:'http://127.0.0.1:'+endpoint.port,apiKey:key});
  const update=async(key:string)=>{const view=await http(f.admin.token,'/api/admin/configuration/models');await http(f.admin.token,'/api/admin/configuration/models','PUT',{revision:view.revision,value:{...defaultModelDomain(),deployment:settings(key)}});};
  await update('GENERATED_SEAM_OLD');
  for(const actor of [f.a,f.b]){
   const page=await http(actor.token,'/api/file-processing');
   await http(actor.token,'/api/file-processing','PUT',{revision:page.revision,settings:{...page.settings,automatic:true,understandingEnabled:false},policy:{version:1,services:[{id:'image',name:'Generated image',kind:'image',reference:actor===f.a?{kind:'shared',id:'env:deployment'}:{kind:'personal',id:'seam-image'}}],profiles:[{id:'image',name:'Generated image',processorId:'image.http',serviceId:'image',parameters:{},summarize:false},{id:'archive',name:'Generated archive',processorId:'archive',parameters:{},summarize:false}],rules:[{type:'image/*',profileId:'image'},{type:'*/*',profileId:'archive'}]},...(actor===f.b?{models:{profiles:[{id:'seam-image',name:'Generated private image',settings:settings('GENERATED_SEAM_B')}],selections:{}}}:{})});
  }
  const png=await sharp({create:{width:2,height:2,channels:3,background:'#345678'}}).png().toBuffer();
  const upload=async(token:string)=>{
   const hash=bytesHash(png),input=await http(token,'/api/ingress/sources/same-source/uploads','POST',{batchId:randomUUID(),revision:{sourceId:'same-source',previousRevision:null,sizeBytes:png.length,sha256:hash,relativePath:'same-seam.png',item:{externalId:'same-seam',revision:'same-r1',observedAt:'2026-10-16T00:00:00Z',title:'Generated seam',text:'',kind:'file',layer:'original',mimeType:'image/png'}}});
   await http(token,'/api/ingress/uploads/'+input.id+'/parts/0','PUT',{bytes:png.toString('base64'),checksum:hash});return (await http(token,'/api/ingress/uploads/'+input.id+'/commit','POST',{})).captures[0];
  };
  const a=await upload(f.a.token),b=await upload(f.b.token);assert.equal(a.id,b.id);
  const path='/api/files/'+a.id,prior=await waitForState(()=>http(f.a.token,path),value=>transition==='completed'?value.processing.indexed:['failed','blocked'].includes(value.job?.state),'original shared intent settles',8000);
  await waitForState(()=>http(f.b.token,path),value=>value.processing.indexed,'B same-ID private positive',8000);
  const bBefore=await http(f.b.token,path+'/chunks');
  const read=<T>(work:(db:DatabaseSync)=>T)=>{const db=new DatabaseSync(join(f.root,'mote.sqlite'),{readOnly:true});try{return work(db);}finally{db.close();}};
  const root=read(db=>db.prepare("SELECT e.id,u.grant_id FROM execution_steps e JOIN user_tasks u ON u.task_id=e.id WHERE e.user_id=? AND e.kind='processing.pipeline' AND json_extract(u.input,'$.originalRef')=? ORDER BY u.user_position DESC LIMIT 1").get(f.a.userId,prior.originalRef))!;
  const entered=deferred(),release=deferred(),original=f.node.configuration!.refreshProcessingDependencies.bind(f.node.configuration);let freshContext:Parameters<typeof original>[0]|undefined;
  f.node.configuration!.refreshProcessingDependencies=async context=>{await original(context);if(context.userId===f.a.userId){freshContext=context;entered.resolve();await release.promise;}};
  t.after(()=>release.resolve());
  await update('GENERATED_SEAM_NEW');if(handoff)await entered.promise;
  const control=handoff?read(db=>db.prepare("SELECT u.task_id,e.state,e.fence,u.model_receipt FROM user_tasks u JOIN execution_steps e ON e.id=u.task_id WHERE u.user_id=? AND u.grant_id=?").get(f.a.userId,freshContext!.credentialId.split(':')[0])):undefined;
  if(handoff){assert.ok(freshContext);assert.equal(f.node.authority.isTask(freshContext),true);assert.notEqual(freshContext.credentialId.split(':')[0],root.grant_id);assert.equal(control!.state,'running');assert.ok(control!.fence);assert.equal(control!.model_receipt,null);}
  if(transition==='unknown')assert.ok(read(db=>Number(db.prepare("SELECT count(*) n FROM task_external_calls WHERE user_id=? AND state IN('issued','unknown')").get(f.a.userId)!.n))>0,'unknown negative contains real unresolved issuance');
  await assert.rejects(f.node.authority.restoreTask(String(root.grant_id)));
  const forged=await fetch(address+'/api/tasks',{method:'POST',headers:{...protocol,authorization:'Bearer '+f.b.token,'content-type':'application/json'},body:JSON.stringify({kind:'processing.recheck',operationId:'generated-forged-seam',input:{intentId:root.id,stamp:1,userId:f.a.userId}})});assert.equal(forged.status,503);await forged.text();
  const context=await f.node.authority.authenticate(f.a.token),abort=new AbortController();let callerCurrent=true;
  const bind=()=>f.node.ask!.bind(context,{sourceIds:['same-source'],assertCurrent:()=>assert.ok(callerCurrent,'generated_seam_caller_revoked')}).reader({signal:abort.signal});
  const synchronous=await bind().read([aMaterial.ref,aMaterial.ref]);assert.ok(synchronous.items.length>0);assert.match(JSON.stringify(synchronous),/GENERATED_MCP_MEMORY_A/);assert.doesNotMatch(JSON.stringify(synchronous),/GENERATED_MCP_MEMORY_B/);
  const gate=f.hold(directories.get(f.a.userId)!,memory.id),pending=bind().read([...(handoff?['capture:'+a.id]:[]),aMaterial.ref,'memory:'+memory.id,aMaterial.ref]).then(result=>({result}),error=>({error:String(error)}));
  await gate.entered();
  // Duplicate instance observations while both operations await cannot create a
  // second control identity, even though the stopped original grant still exists.
  const controls=()=>read(db=>Number(db.prepare("SELECT count(*) n FROM execution_steps WHERE user_id=? AND kind='processing.recheck'").get(f.a.userId)!.n));
  const admitted=controls();await f.node.configuration!.instance.reload();await f.node.configuration!.instance.reload();assert.equal(controls(),admitted);
  let replacement:any;
  if(transition==='source-withdraw')await http(f.a.token,'/api/sources/same-source','PATCH',{enabled:false});
  if(transition==='account-epoch')await http(f.admin.token,'/api/admin/accounts/'+f.a.userId+'/password','POST',{password:'Generated-new-seam-password'});
  if(transition==='cancel'){await http(f.a.token,path+'/cancel','POST',{});abort.abort();}
  if(transition==='caller-policy')callerCurrent=false;
  if(transition==='same-id-recreate'){
   const forgotten=await http(f.a.token,path,'DELETE',{operationId:randomUUID(),originalGeneration:prior.originalGeneration});await http(f.a.token,path+'/allow-again','POST',forgotten.decision);replacement=await upload(f.a.token);assert.equal(replacement.id,a.id);
  }
  gate.release();release.resolve();const outcome=await pending;
  if(handoff){assert.ok('error' in outcome,JSON.stringify(outcome));assert.doesNotMatch(JSON.stringify(outcome),/GENERATED_MCP_MEMORY_A|GENERATED_SEAM_NEW/);}else{assert.ok('result' in outcome);assert.match(JSON.stringify(outcome),/GENERATED_MCP_MEMORY_A/);assert.equal(freshContext,undefined,'unknown or completed intent cannot obtain a control context');assert.equal(admitted,0);}
  if(control)await waitForState(async()=>read(db=>db.prepare("SELECT state FROM execution_steps WHERE id=?").get(control.task_id)),row=>!!row&&!['waiting','running'].includes(String(row.state)),'held recheck settles',8000);
  const aPipelines=()=>read(db=>db.prepare("SELECT u.task_id,u.input FROM user_tasks u JOIN execution_steps e ON e.id=u.task_id WHERE u.user_id=? AND e.kind='processing.pipeline' AND json_extract(u.input,'$.originalRef')=?").all(f.a.userId,prior.originalRef));
  if(transition==='caller-policy'||replacement){
   await waitForState(()=>http(f.a.token,path),value=>value.processing.indexed,'fresh authorized work completes',8000);
   assert.equal(calls.filter(key=>key==='Bearer GENERATED_SEAM_NEW').length,1);
   if(replacement){const current=await http(f.a.token,path);assert.ok(current.originalGeneration>prior.originalGeneration);assert.ok(aPipelines().every(row=>!JSON.parse(String(row.input)).intentTaskId),'replacement is new owner intent, never old continuation');}
  }else{
   assert.equal(aPipelines().length,1,'retired intent cannot admit a replacement pipeline');assert.equal(calls.filter(key=>key==='Bearer GENERATED_SEAM_NEW').length,0);
  }
  assert.deepEqual(await http(f.b.token,path+'/chunks'),bBefore);assert.equal(calls.filter(key=>key==='Bearer GENERATED_SEAM_B').length,1);
  const bReader=f.node.ask!.bind(await f.node.authority.authenticate(f.b.token),{assertCurrent:()=>{}}).reader();assert.match(JSON.stringify(await bReader.read([bMaterial.ref])),/GENERATED_MCP_MEMORY_B/);
  const finalPipelines=aPipelines().length,finalCalls=calls.length;
  await update('GENERATED_SEAM_LATER');await f.node.configuration!.instance.reload();
  await f.restart();address=await f.node.app.listen({port:0,host:'127.0.0.1'});await f.node.configuration!.instance.reload();
  let observations=0;const handoffAfterRestart=f.node.execution!.handoffProcessingRechecks.bind(f.node.execution);
  f.node.execution!.handoffProcessingRechecks=(...args)=>{observations++;return handoffAfterRestart(...args);};
  await waitForState(async()=>observations,value=>value>0,'real periodic dependency observer after restart',5000);await f.node.execution!.tick();
  await waitForState(async()=>read(db=>Number(db.prepare("SELECT count(*) n FROM execution_steps WHERE user_id=? AND kind='processing.recheck' AND state IN('waiting','running')").get(f.a.userId)!.n)),value=>value===0,'restart rechecks settle',8000);
  assert.equal(aPipelines().length,finalPipelines);assert.equal(calls.length,finalCalls,'restart and another dependency change cannot revive completed or retired work');
  if(control)assert.equal(read(db=>Number(db.prepare('SELECT count(*) n FROM task_external_calls WHERE user_id=? AND task_id=?').get(f.a.userId,control.task_id)!.n)),0,'bounded control performs no external I/O');
 });
}
