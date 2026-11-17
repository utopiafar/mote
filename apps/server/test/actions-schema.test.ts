import test,{type TestContext} from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {installSchemaPlan,type SchemaInstallation} from '../src/schema-installation.js';
import {actionsSchemaInstallation,actionsExecutionSchemaInstallation,actionsRetirementSchemaInstallation} from '../src/actions-schema.js';
import {Actions} from '../src/actions.js';
import {actionsRuntimeSettingsSchema} from '../src/actions-configuration.js';
import {ConfigService} from '../src/config-service.js';
import {ExecutionEngine} from '../src/execution-engine.js';
import {EvidenceStore as Store} from '../src/evidence-store.js';
import {SourceStore} from '../src/sources.js';
import {FileStore} from '../src/files.js';

const schema=(db:DatabaseSync)=>db.prepare("SELECT type,name,tbl_name,sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type,name").all();
const exists=(db:DatabaseSync,name:string)=>Boolean(db.prepare('SELECT 1 FROM sqlite_master WHERE name=?').get(name));
function foreignOwners(db:DatabaseSync){db.exec('CREATE TABLE file_chunks(id TEXT PRIMARY KEY,artifact_id TEXT); CREATE TABLE file_artifacts(id TEXT PRIMARY KEY,current INTEGER); CREATE TABLE context_artifacts(id TEXT PRIMARY KEY)');}
function executionOwner(db:DatabaseSync){db.exec('CREATE TABLE execution_steps(id TEXT PRIMARY KEY,kind TEXT,state TEXT,attempts INTEGER,input TEXT)');}
const phases=[actionsSchemaInstallation,actionsExecutionSchemaInstallation,actionsRetirementSchemaInstallation] as const;
const install=(db:DatabaseSync,phase:SchemaInstallation)=>installSchemaPlan(db,[phase]);

test('Actions phases check actual external schema facts before writing and never activate an Engine, seed or recover jobs',()=>{
 const db=new DatabaseSync(':memory:');try{
  for(const phase of phases){const before=schema(db);assert.throws(()=>install(db,phase),/actions schema requires/);assert.deepEqual(schema(db),before);}
  foreignOwners(db);install(db,actionsSchemaInstallation);assert.ok(exists(db,'action_meta'));assert.ok(exists(db,'action_chunk_added'));assert.equal(exists(db,'execution_steps'),false);assert.deepEqual(db.prepare('SELECT * FROM action_meta').all(),[]);assert.deepEqual(db.prepare('SELECT * FROM action_jobs').all(),[]);
  const core=schema(db);assert.throws(()=>install(db,actionsExecutionSchemaInstallation),/execution.*execution_steps/);assert.deepEqual(schema(db),core);executionOwner(db);install(db,actionsExecutionSchemaInstallation);assert.ok(exists(db,'action_execution_changed'));assert.equal(exists(db,'operation_progress'),false);
  const execution=schema(db);assert.throws(()=>install(db,actionsRetirementSchemaInstallation),/capture.*captures/);assert.deepEqual(schema(db),execution);db.exec('CREATE TABLE captures(id TEXT PRIMARY KEY)');install(db,actionsRetirementSchemaInstallation);assert.ok(exists(db,'actions_captures_deleted'));assert.ok(exists(db,'actions_related_file_chunks_deleted'));assert.equal(db.isTransaction,false);
 }finally{db.close();}
});

for(const nested of [false,true])test(`a real late Actions core SQL failure rolls back its whole stage${nested?' without consuming the caller savepoint':''} and the same handle retries`,()=>{
 const db=new DatabaseSync(':memory:');try{
  foreignOwners(db);db.exec("CREATE TABLE action_jobs(marker TEXT PRIMARY KEY); INSERT INTO action_jobs VALUES('retained'); CREATE TABLE generated_outer(value TEXT)");if(nested)db.exec("BEGIN; SAVEPOINT generated_caller; INSERT INTO generated_outer VALUES('before')");const before=schema(db);
  assert.throws(()=>install(db,actionsSchemaInstallation),/no such column: status/);assert.deepEqual(schema(db),before);assert.equal(db.prepare('SELECT marker FROM action_jobs').get()!.marker,'retained');assert.equal(db.isTransaction,nested);
  for(const name of ['action_meta','action_proposals','action_chunk_changes','action_chunk_added'])assert.equal(exists(db,name),false);
  if(nested){db.exec("INSERT INTO generated_outer VALUES('after'); RELEASE generated_caller; COMMIT");assert.equal(db.prepare('SELECT count(*) n FROM generated_outer').get()!.n,2);}
  db.exec('DROP TABLE action_jobs');install(db,actionsSchemaInstallation);assert.ok(exists(db,'action_jobs_status'));assert.ok(exists(db,'action_artifact_changed'));assert.equal(db.isTransaction,false);
 }finally{db.close();}
});

for(const [index,phase] of phases.entries())test(`Actions ${phase===actionsSchemaInstallation?'core':phase===actionsExecutionSchemaInstallation?'execution':'retirement'} re-installs on the same handle after an outer rollback`,()=>{
 const db=new DatabaseSync(':memory:');try{
  foreignOwners(db);db.exec("CREATE TABLE captures(id TEXT PRIMARY KEY); CREATE TABLE generated_existing(value TEXT); INSERT INTO generated_existing VALUES('retained')");
  if(index>0){install(db,actionsSchemaInstallation);executionOwner(db);}if(index>1)install(db,actionsExecutionSchemaInstallation);const before=schema(db);
  db.exec('BEGIN');install(db,phase);assert.equal(db.isTransaction,true);db.exec('ROLLBACK');assert.deepEqual(schema(db),before);install(db,phase);const installed=schema(db);install(db,phase);assert.deepEqual(schema(db),installed);assert.equal(db.prepare('SELECT value FROM generated_existing').get()!.value,'retained');assert.equal(db.isTransaction,false);
 }finally{db.close();}
});

test('the original file, execution and deletion projections remain active after staged installation',()=>{
 const db=new DatabaseSync(':memory:');try{
  foreignOwners(db);db.exec('CREATE TABLE captures(id TEXT PRIMARY KEY)');install(db,actionsSchemaInstallation);executionOwner(db);install(db,actionsExecutionSchemaInstallation);install(db,actionsRetirementSchemaInstallation);
  db.exec("INSERT INTO file_artifacts VALUES('generated-artifact',1); INSERT INTO file_chunks VALUES('generated-chunk','generated-artifact'); UPDATE file_artifacts SET current=0 WHERE id='generated-artifact'");assert.deepEqual(db.prepare('SELECT id FROM action_chunk_changes ORDER BY seq').all().map(row=>row.id),['generated-chunk','generated-chunk']);
  db.prepare("INSERT INTO action_jobs(key,id,offset,length,fingerprint) VALUES(?,?,0,1,'generated')").run('generated-job','generated-original');db.prepare('INSERT INTO execution_steps VALUES(?,?,?,?,?)').run('generated-step','actions.extract','waiting',0,JSON.stringify({jobKey:'generated-job'}));assert.equal(db.prepare('SELECT status FROM action_jobs').get()!.status,'pending');
  for(const [state,status,attempts] of [['running','running',1],['blocked','blocked',2],['waiting','pending',2],['succeeded','completed',3]] as const){db.prepare('UPDATE execution_steps SET state=?,attempts=? WHERE id=?').run(state,attempts,'generated-step');assert.deepEqual({...db.prepare('SELECT status,attempts FROM action_jobs').get()},{status,attempts});}
  db.prepare('INSERT INTO execution_steps VALUES(?,?,?,?,?)').run('generated-unrelated','generated.other','failed',99,JSON.stringify({jobKey:'generated-job'}));assert.equal(db.prepare('SELECT status FROM action_jobs').get()!.status,'completed');
  const event={title:'Generated private appointment',start:null,end:null,timeZone:null,allDay:false,location:'Generated room',description:'Generated original-only detail'},put=(id:string,sourceId:string,status='proposed',related=false)=>db.prepare('INSERT INTO action_proposals VALUES(?,?)').run(id,JSON.stringify({id,status,version:1,event,evidence:[{id:sourceId,quote:'Generated private quotation'}],uncertainty:'Generated uncertainty',...(related?{related:{actionId:'generated-parent',event}}:{})}));
  db.exec("INSERT INTO captures VALUES('generated-original')");put('generated-proposed','generated-original');put('generated-related','generated-original','approved',true);put('generated-executing','generated-original','executing');put('generated-chunk-proposal','generated-chunk');
  db.exec("DELETE FROM captures WHERE id='generated-original'");const read=(id:string)=>JSON.parse(String(db.prepare('SELECT json FROM action_proposals WHERE id=?').get(id)!.json));
  for(const id of ['generated-proposed','generated-related']){const item=read(id);assert.equal(item.status,'stale');assert.equal(item.version,2);assert.deepEqual(item.evidence,[]);assert.equal(item.event.description,'');assert.equal(item.uncertainty,'');}assert.equal(read('generated-related').related.event.description,'');assert.equal(read('generated-executing').status,'executing');assert.deepEqual(read('generated-executing').event,event);assert.deepEqual(read('generated-executing').evidence,[]);assert.equal(db.prepare('SELECT count(*) n FROM action_jobs').get()!.n,0);
  db.exec("DELETE FROM file_chunks WHERE id='generated-chunk'");assert.equal(read('generated-chunk-proposal').status,'stale');assert.equal(read('generated-chunk-proposal').event.description,'');
 }finally{db.close();}
});

function realOwners(t:TestContext){
 const directory=mkdtempSync(join(tmpdir(),'mote-actions-schema-')),store=new Store(directory),sources=new SourceStore(store),files=new FileStore(store,sources),actions:Actions[]=[],engines:ExecutionEngine[]=[];
 t.after(async()=>{for(const action of actions.reverse())await action.close();for(const engine of engines.reverse())await engine.close();store.close();rmSync(directory,{recursive:true,force:true});});
 let modelCalls=0;const query=async()=>{modelCalls++;throw Error('A constructor must not start model work');};
 return {directory,store,files,actions,engines,query,modelCalls:()=>modelCalls};
}

for(const borrowed of [false,true])test(`the real Actions constructor installs execution projections after its ${borrowed?'borrowed':'owned'} Engine and recovers without executing`,async t=>{
 const f=realOwners(t),engine=borrowed?new ExecutionEngine(f.store):undefined;if(engine)f.engines.push(engine);
 install(f.store.db,actionsSchemaInstallation);const key='a'.repeat(64),id=randomUUID();f.store.db.prepare("INSERT INTO action_jobs VALUES(?,?,0,1,?,'completed',2)").run(key,id,'b'.repeat(64));
 const action=new Actions(f.store,f.files,f.query,()=>false,{executor:engine});f.actions.push(action);
 assert.equal(action.engine===engine,borrowed);assert.ok(exists(f.store.db,'action_execution_created'));assert.ok(exists(f.store.db,'actions_captures_deleted'));assert.equal(action.engine.get('actions:'+key)!.state,'succeeded');assert.equal(action.engine.get('actions:'+key)!.attempts,2);assert.equal(JSON.parse(String(f.store.db.prepare("SELECT json FROM action_meta WHERE key='chunksInitialized'").get()!.json)),true);
 await new Promise<void>(resolve=>setImmediate(resolve));assert.equal(f.modelCalls(),0);assert.equal(f.store.db.isTransaction,false);
});

test('a failed retirement stage releases only this registration and a borrowed Engine still executes its sibling before same-handle retry',async t=>{
 const f=realOwners(t),engine=new ExecutionEngine(f.store);f.engines.push(engine);let siblingRuns=0,closeCalls=0;const close=engine.close.bind(engine);t.mock.method(engine,'close',()=>{closeCalls++;return close();});
 const unregisterSibling=engine.register({kind:'generated.sibling',pool:'generated.sibling',concurrency:()=>1,validate:()=>true,execute:async()=>{siblingRuns++;},commit:()=>{}});t.after(unregisterSibling);
 const drains:Promise<void>[]=[],register=engine.register.bind(engine);t.mock.method(engine,'register',(...args:Parameters<ExecutionEngine['register']>)=>{const unregister=register(...args);return ()=>{const drain=unregister();drains.push(drain);return drain;};});
 const captureSql=String(f.store.db.prepare("SELECT sql FROM sqlite_master WHERE name='captures'").get()!.sql);f.store.db.exec('DROP TABLE captures');
 assert.throws(()=>new Actions(f.store,f.files,f.query,()=>true,{executor:engine}),/^Error: actions schema requires capture object\(s\): table:captures$/);assert.equal(drains.length,1);await Promise.all(drains);assert.equal(engine.closed,false);assert.equal(closeCalls,0);assert.equal(f.store.db.isTransaction,false);assert.equal(f.modelCalls(),0);assert.throws(()=>engine.enqueue(randomUUID(),'actions.extract',{jobKey:'not-admitted'}),/Execution handler unavailable/);
 const step=engine.enqueue(randomUUID(),'generated.sibling',{});await engine.drain([step]);assert.equal(engine.get(step)!.state,'succeeded');assert.equal(siblingRuns,1);
 f.store.db.exec(captureSql);const action=new Actions(f.store,f.files,f.query,()=>false,{executor:engine});f.actions.push(action);assert.ok(exists(f.store.db,'actions_related_captures_deleted'));assert.equal(f.modelCalls(),0);
 // A second failed constructor must not unregister the first successful owner.
 assert.throws(()=>new Actions(f.store,f.files,f.query,()=>false,{executor:engine}),/Duplicate execution handler/);assert.equal(closeCalls,0);const retained=engine.enqueue(randomUUID(),'actions.extract',{jobKey:'retained-owner'},{initial:{state:'succeeded',attempts:0,availableAt:0}});assert.equal(engine.get(retained)!.state,'succeeded');
});

test('a failed constructor closes its owned Engine once, settles cleanup and preserves the original schema error',async t=>{
 const f=realOwners(t),closed:{engine:ExecutionEngine;drain:Promise<void>}[]=[],close=ExecutionEngine.prototype.close;
 t.mock.method(ExecutionEngine.prototype,'close',function(this:ExecutionEngine){const drain=close.call(this);closed.push({engine:this,drain});return drain;});
 const captureSql=String(f.store.db.prepare("SELECT sql FROM sqlite_master WHERE name='captures'").get()!.sql);f.store.db.exec('DROP TABLE captures');
 assert.throws(()=>new Actions(f.store,f.files,f.query,()=>true),/^Error: actions schema requires capture object\(s\): table:captures$/);assert.equal(closed.length,1);assert.equal(closed[0]!.engine.closed,true);await closed[0]!.drain;assert.equal(f.modelCalls(),0);assert.equal(f.store.db.isTransaction,false);
 f.store.db.exec(captureSql);const action=new Actions(f.store,f.files,f.query,()=>false);f.actions.push(action);assert.notEqual(action.engine,closed[0]!.engine);assert.equal(action.engine.closed,false);await action.close();assert.equal(closed.length,2);assert.equal(closed.filter(value=>value.engine===closed[0]!.engine).length,1);
});

test('only a successful constructor publishes its ConfigService handler and failure leaves the prior live owner callable',async t=>{
 const f=realOwners(t),service=new ConfigService({path:join(f.directory,'mote.yaml'),watch:false,initialDocument:{version:1,revision:0,actions:{enabled:true,timeZone:'UTC'}}});service.register({id:'actions',schema:actionsRuntimeSettingsSchema,defaultValue:{},updatePaths:['enabled','timeZone']});await service.initialize();t.after(()=>service.close());
 const setHandler=service.setHandler.bind(service);let publications=0;t.mock.method(service,'setHandler',(...args:Parameters<ConfigService['setHandler']>)=>{publications++;return setHandler(...args);});
 const previous=new Actions(f.store,f.files,f.query,()=>false,{configService:service});f.actions.push(previous);assert.equal(publications,1);
 const captureSql=String(f.store.db.prepare("SELECT sql FROM sqlite_master WHERE name='captures'").get()!.sql);f.store.db.exec('DROP TABLE captures');assert.throws(()=>new Actions(f.store,f.files,f.query,()=>true,{configService:service}),/actions schema requires capture/);assert.equal(publications,1);
 await service.update('actions',{enabled:true,timeZone:'Europe/Paris'},service.revision);assert.equal(previous.settings().timeZone,'Europe/Paris');
 f.store.db.exec(captureSql);const replacement=new Actions(f.store,f.files,f.query,()=>false,{configService:service});f.actions.push(replacement);assert.equal(publications,2);await service.update('actions',{enabled:false,timeZone:'UTC'},service.revision);assert.equal(replacement.settings().timeZone,'UTC');assert.equal(replacement.settings().enabled,false);assert.equal(previous.settings().timeZone,'Europe/Paris');assert.equal(f.modelCalls(),0);
});
