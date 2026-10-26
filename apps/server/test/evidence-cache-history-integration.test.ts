import {withFixtureOwnerModelWork} from './fixtures/model-authorization.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {DatabaseSync} from 'node:sqlite';
import type {QueryInput} from '@mote/agent';
import {buildApp} from '../src/app.js';
import type {Config} from '../src/config.js';
import {defaultLifecycleSettings} from '../src/memory-lifecycle.js';
import {restoreProfile} from '../../../scripts/profile-lib.mjs';

const token='generated-cache-history-owner',headers={authorization:`Bearer ${token}`,'content-type':'application/json'};
const config=(dataDir:string):Config=>({dataDir,token,tokenPath:'fixture',host:'127.0.0.1',port:0,maxStorageBytes:50_000_000,maxExportBytes:1_000_000,retentionDays:0,insightIntervalHours:0,allowedOrigins:[],model:'',modelBaseUrl:'',apiKey:'',allowUnauthenticatedLocal:false,embeddingModel:'',embeddingBaseUrl:'',embeddingApiKey:''});
const result=(ids:string[],answer='Generated answer based on the first interpretation.')=>({answer,citations:[],trace:[],runId:randomUUID(),evidenceDependencies:{version:1 as const,complete:true,ids}});
async function fixture(t:any){
 const directory=await mkdtemp(join(tmpdir(),'mote-cache-history-integration-'));let ids:string[]=[],calls=0,hook:(()=>void)|undefined;const seen:QueryInput[]=[];
 const agent={configured:true,close:async()=>{},query:async(input:QueryInput)=>{calls++;seen.push(input);hook?.();return result(ids);}};
 let node=await buildApp(config(directory),{backgroundWorker:false,agent}),base=await node.app.listen({host:'127.0.0.1',port:0});
 t.after(async()=>{await node.app.close();await rm(directory,{recursive:true,force:true});});
 const request=async(path:string,payload?:unknown)=>{const response=await fetch(base+path,{headers,...(payload?{method:'POST',body:JSON.stringify(payload)}:{})});return {status:response.status,body:await response.json() as any};};
 const original=randomUUID();await node.store.ingest({id:original,deviceId:'generated',deviceName:'Generated',platform:'import',source:'note',capturedAt:'2026-10-01T00:00:00Z',durationMs:0,ocrText:'Generated original evidence.'});
 const artifactId='a'.repeat(64),inputs=[{id:original,fingerprint:node.store.archive.fingerprint(original)!}],save=(revision='1'.repeat(64),text='Generated first interpretation.')=>node.store.archive.save(artifactId,'generated-group',revision,{kind:'semantic',text,metadata:{}},inputs,'generated','1','generated');
 save();ids=[artifactId];
 const saved=await request('/api/query',{question:'Generated initial question'});assert.equal(saved.status,200,JSON.stringify(saved.body));
 return {get node(){return node;},original,artifactId,save,request,conversationId:saved.body.conversationId as string,seen,calls:()=>calls,setIds:(value:string[])=>{ids=value;},setHook:(value?:()=>void)=>{hook=value;},async restart(){await node.app.close();node=await buildApp(config(directory),{backgroundWorker:false,agent});base=await node.app.listen({host:'127.0.0.1',port:0});}};
}

for(const operation of ['replacement','eviction','parent-cascade'] as const)test(`context ${operation} preserves historical HTTP answers, revokes snapshots and summaries, and still erases on original deletion`,async t=>{
 const f=await fixture(t),history=async()=>(await f.request('/api/conversations/'+f.conversationId)).body;
 const before=await history();f.save();assert.deepEqual(await history(),before,'exact replay must not expire dialogue');
 await f.node.working.compact(f.conversationId,{...defaultLifecycleSettings,recentTurns:0},async()=>result([],'Generated historical summary.'));
 assert.ok(f.node.working.get(f.node.featureServices.conversations.get(f.conversationId)));
 const frozen=f.node.working.context(f.node.featureServices.conversations.get(f.conversationId),defaultLifecycleSettings);
 if(operation==='replacement')f.save('2'.repeat(64),'Generated corrected interpretation.');
 else if(operation==='eviction')f.node.store.db.prepare('DELETE FROM context_artifacts WHERE id=?').run(f.artifactId);
 else {
  const parent=f.node.store.archive.save('b'.repeat(64),'generated-parent','1'.repeat(64),{kind:'semantic',text:'Generated parent',metadata:{}},[{id:f.original,fingerprint:f.node.store.archive.fingerprint(f.original)!}],'generated','1','generated');
  f.node.store.db.prepare('INSERT INTO artifact_dependencies VALUES(?,?,?)').run(f.artifactId,parent.id,parent.revision);
  f.node.store.db.prepare('DELETE FROM context_artifacts WHERE id=?').run(parent.id);
 }
 const after=await history();assert.deepEqual(after.turns[0].result,before.turns[0].result);assert.equal(after.turns[0].evidenceDeleted,undefined);assert.equal(after.turns[0].evidenceStale,true);assert.ok(after.revision>before.revision);
 assert.equal(f.node.working.get(f.node.featureServices.conversations.get(f.conversationId)),undefined);
 const calls=f.calls();await assert.rejects(withFixtureOwnerModelWork(f.node,()=>f.node.featureServices.queryAgent({question:'Generated frozen replay',conversation:frozen})),/Conversation changed/);assert.equal(f.calls(),calls,'expired snapshots never enter the provider');
 f.setIds([]);await f.restart();const followup=await f.request('/api/query',{conversationId:f.conversationId,question:'Discuss the earlier proposal'});assert.equal(followup.status,200,JSON.stringify(followup.body));assert.equal(f.seen.at(-1)!.conversation!.turns[0].evidenceStale,true);
 f.node.store.delete(f.original);const erased=await history();assert.ok(erased.turns.every((turn:any)=>turn.evidenceDeleted));assert.doesNotMatch(JSON.stringify(erased),/Generated answer based/);
});

for(const stage of ['model-result','summary'] as const)test(`changed context rejects a late ${stage} against the frozen conversation`,async t=>{
 const f=await fixture(t),change=()=>f.save('2'.repeat(64),'Generated corrected interpretation.');f.setIds([]);
 if(stage==='model-result'){
  f.setHook(change);const response=await f.request('/api/query',{conversationId:f.conversationId,question:'Generated in-flight follow-up'});assert.equal(response.status,409,JSON.stringify(response.body));f.setHook();
 }else await assert.rejects(f.node.working.compact(f.conversationId,{...defaultLifecycleSettings,recentTurns:0},async()=>{change();return result([],'Generated late summary.');}),/Conversation changed/);
 const conversation=f.node.featureServices.conversations.get(f.conversationId);assert.equal(conversation.turns.filter(turn=>turn.result).length,1);assert.equal(conversation.turns[0].evidenceStale,true);assert.equal(f.node.working.get(conversation),undefined);
});

test('startup installs the context-history lifecycle and a failed expiry rolls back the artifact and dialogue together',async t=>{
 const f=await fixture(t);f.node.store.db.exec('DROP TRIGGER context_history_invalidation; CREATE TRIGGER context_history_invalidation BEFORE DELETE ON context_artifacts BEGIN SELECT mote_context_history_invalidate(old.id); END;');await f.restart();
 const db=f.node.store.db,before=f.node.featureServices.conversations.get(f.conversationId),artifact=f.node.store.archive.get(f.artifactId);
 db.exec("CREATE TRIGGER generated_context_expiry_failure BEFORE UPDATE ON conversations BEGIN SELECT RAISE(ABORT,'Generated snapshot expiry failure'); END");
 assert.throws(()=>f.save('2'.repeat(64),'Generated corrected interpretation.'),/Generated snapshot expiry failure/);
 assert.deepEqual(f.node.featureServices.conversations.get(f.conversationId),before,'failed deletion cannot commit partial history invalidation');assert.deepEqual(f.node.store.archive.get(f.artifactId),artifact,'the previous artifact remains intact for retry');
 db.exec('DROP TRIGGER generated_context_expiry_failure');f.save('2'.repeat(64),'Generated corrected interpretation.');assert.equal(f.node.featureServices.conversations.get(f.conversationId).turns[0].evidenceStale,true);
});

for(const nested of [false,true])test(`failed context lifecycle replacement preserves the installed SQL trigger (${nested?'nested':'standalone'})`,async t=>{
 const f=await fixture(t),db=f.node.store.db,execute=db.exec.bind(db),prior=db.prepare("SELECT sql FROM sqlite_master WHERE name='context_history_invalidation'").get()!.sql;
 if(nested)execute('BEGIN IMMEDIATE');
 db.exec=(sql:string)=>{if(sql.includes('CREATE TRIGGER context_history_invalidation')){execute('DROP TRIGGER context_history_invalidation');throw Error('Generated lifecycle schema failure');}execute(sql);};
 try{assert.throws(()=>f.node.store.installContextHistoryInvalidation(),/Generated lifecycle schema failure/);}finally{db.exec=execute;}
 assert.equal(db.isTransaction,nested);assert.equal(db.prepare("SELECT sql FROM sqlite_master WHERE name='context_history_invalidation'").get()!.sql,prior);
 if(nested)execute('COMMIT');f.save('2'.repeat(64),'Generated corrected interpretation.');assert.equal(f.node.featureServices.conversations.get(f.conversationId).turns[0].evidenceStale,true);
});

test('real backup and restore retain conversation authority while raw SQLite cache eviction stays atomic and later original deletion erases every generation',async t=>{
 const f=await fixture(t),directory=await mkdtemp(join(tmpdir(),'mote-context-history-backup-')),snapshot=join(directory,'snapshot'),target=join(directory,'restored');
 let restored:Awaited<ReturnType<typeof buildApp>>|undefined;
 t.after(async()=>{await restored?.app.close();await rm(directory,{recursive:true,force:true});});
 const childId='c'.repeat(64);f.node.store.archive.save(childId,'generated-child','1'.repeat(64),{kind:'semantic',text:'Generated child context',metadata:{}},[],'generated','1','generated',[],[{id:f.artifactId,revision:'1'.repeat(64)}]);
 await f.node.working.compact(f.conversationId,{...defaultLifecycleSettings,recentTurns:0},async()=>result([],'Generated retained summary.'));
 const before=f.node.featureServices.conversations.get(f.conversationId);await f.node.app.close();
 execFileSync(process.execPath,['--import','tsx',fileURLToPath(new URL('../../../scripts/backup.ts',import.meta.url)),'--data',f.node.store.directory,'--out',snapshot],{stdio:'pipe'});
 await restoreProfile({meta:{runtime:'native'},dataDir:target,processFile:join(directory,'missing-process')},snapshot);
 const seen:QueryInput[]=[],agent={configured:true,close:async()=>{},query:async(input:QueryInput)=>{seen.push(input);return result([]);}};
 restored=await buildApp(config(target),{backgroundWorker:false,agent});
 const ask=async()=>{const response=await restored!.app.inject({method:'POST',url:'/api/query',headers,payload:{conversationId:f.conversationId,question:'Discuss the retained generated proposal'}});assert.equal(response.statusCode,200,response.body);};
 assert.deepEqual(restored.featureServices.conversations.get(f.conversationId),before);await ask();assert.match(seen.at(-1)!.conversation!.workingMemory!.text,/retained summary/);
 const db=new DatabaseSync(join(target,'mote.sqlite'));
 try{
  db.exec('PRAGMA foreign_keys=ON; PRAGMA recursive_triggers=ON');
  const trigger=String(db.prepare("SELECT sql FROM sqlite_master WHERE name='context_history_invalidation'").get()!.sql);assert.doesNotMatch(trigger,/mote_context_history_invalidate/,'offline writers require no connection-local history callback');
  const turns=db.prepare('SELECT id,json FROM conversation_turns ORDER BY id').all(),revision=db.prepare('SELECT json FROM conversations WHERE id=?').get(f.conversationId)!.json;
  db.exec("CREATE TRIGGER generated_raw_expiry_failure BEFORE UPDATE ON conversation_turns BEGIN SELECT RAISE(ABORT,'Generated raw expiry failure'); END; BEGIN IMMEDIATE");
  assert.throws(()=>db.prepare('DELETE FROM context_artifacts WHERE id=?').run(f.artifactId),/Generated raw expiry failure/);
  assert.equal(db.isTransaction,true);assert.deepEqual(db.prepare('SELECT id,json FROM conversation_turns ORDER BY id').all(),turns);assert.equal(db.prepare('SELECT json FROM conversations WHERE id=?').get(f.conversationId)!.json,revision);
  assert.equal(db.prepare('SELECT count(*) n FROM context_artifacts WHERE id IN (?,?)').get(f.artifactId,childId)!.n,2);assert.ok(db.prepare('SELECT id FROM working_memories WHERE id=?').get(f.conversationId));
  db.exec('ROLLBACK; DROP TRIGGER generated_raw_expiry_failure');db.prepare('DELETE FROM context_artifacts WHERE id=?').run(f.artifactId);
  assert.equal(db.prepare('SELECT count(*) n FROM context_artifacts WHERE id IN (?,?)').get(f.artifactId,childId)!.n,0);assert.equal(db.prepare('SELECT id FROM working_memories WHERE id=?').get(f.conversationId),undefined);
 }finally{db.close();}
 const changed=restored.featureServices.conversations.get(f.conversationId);assert.ok(changed.turns.every(turn=>turn.evidenceStale&&!turn.evidenceDeleted));assert.deepEqual(changed.turns[0].result,before.turns[0].result);
 await restored.app.close();restored=await buildApp(config(target),{backgroundWorker:false,agent});await ask();assert.equal(seen.at(-1)!.conversation!.turns[0].evidenceStale,true);
 restored.store.delete(f.original);const erased=restored.featureServices.conversations.get(f.conversationId);assert.equal(erased.turns.length,3);assert.ok(erased.turns.every(turn=>turn.evidenceDeleted));assert.doesNotMatch(JSON.stringify(erased),/Generated answer based|Generated retained summary/);
});
