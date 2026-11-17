import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {captureSchema} from '@mote/shared';
import {installSchemaPlan} from '../src/schema-installation.js';
import {insightRunsSchemaInstallation,recordContextSchemaInstallation} from '../src/auxiliary-state-schema.js';
import {EvidenceStore as Store} from '../src/evidence-store.js';
import {ExecutionEngine} from '../src/execution-engine.js';
import {InsightRuns} from '../src/insight-runs.js';
import {RecordContextStore} from '../src/record-context.js';
import {IngressService} from '../src/ingress.js';
import {SourceStore} from '../src/sources.js';
import {FileStore} from '../src/files.js';
import {MaterialStore,materialId,type MaterialDraft} from '../src/materials.js';

const schema=(db:DatabaseSync)=>db.prepare("SELECT type,name,tbl_name,sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type,name").all();
const exists=(db:DatabaseSync,name:string)=>Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name));
const captures=(db:DatabaseSync)=>db.exec('CREATE TABLE captures(id TEXT PRIMARY KEY)');
const installations=[
 {installation:insightRunsSchemaInstallation,last:'insight_runs',first:'insight_runs'},
 {installation:recordContextSchemaInstallation,last:'record_context_declarations',first:'record_context_declarations'},
];
const at='2026-10-01T00:00:00Z',description='  Generated auxiliary owner description.\nExact wording.  ';
const capture=()=>captureSchema.parse({id:randomUUID(),deviceId:'generated-auxiliary-phone',deviceName:'Generated auxiliary phone',platform:'android',source:'note',durationMs:0,capturedAt:at,ocrText:'Generated auxiliary original note',metadata:{version:1,observedAt:at,ownerDescription:description}});

test('auxiliary owners check their real capture parent and activate independently',()=>{
 const db=new DatabaseSync(':memory:');
 try{
  let entered=false;
  const prefix={owner:'generated-prefix',requires:[],install:(db:DatabaseSync)=>{entered=true;db.exec('CREATE TABLE generated_partial(value)');}};
  assert.throws(()=>installSchemaPlan(db,[prefix,recordContextSchemaInstallation]),/record-context schema requires capture object\(s\): table:captures/);
  assert.equal(entered,false);assert.deepEqual(schema(db),[]);
  db.exec("CREATE VIEW captures AS SELECT 'generated' id");const before=schema(db);
  assert.throws(()=>installSchemaPlan(db,[prefix,recordContextSchemaInstallation]),/table:captures/);assert.deepEqual(schema(db),before);assert.equal(entered,false);
  db.exec('DROP VIEW captures');
  installSchemaPlan(db,[insightRunsSchemaInstallation]);
  assert.ok(exists(db,'insight_runs'));assert.equal(exists(db,'record_context_declarations'),false);assert.equal(exists(db,'captures'),false);
  captures(db);installSchemaPlan(db,[recordContextSchemaInstallation]);
  assert.ok(exists(db,'record_context_declarations'));
  const installed=schema(db);installSchemaPlan(db,[insightRunsSchemaInstallation,recordContextSchemaInstallation]);assert.deepEqual(schema(db),installed);
 }finally{db.close();}
});

for(const {installation,last,first} of installations)for(const nested of [false,true])test(`native final DDL failure rolls back ${installation.owner}${nested?' while preserving caller transaction and savepoint':''}`,()=>{
 const db=new DatabaseSync(':memory:');
 try{
  db.exec('PRAGMA foreign_keys=ON');captures(db);
  db.exec(`CREATE TABLE generated_outer(value TEXT); CREATE INDEX ${last} ON generated_outer(value)`);
  if(nested)db.exec("BEGIN; INSERT INTO generated_outer VALUES('before'); SAVEPOINT generated_caller");
  const before=schema(db),plan=[{owner:'generated-prefix',requires:[],install:(db:DatabaseSync)=>db.exec('CREATE TABLE generated_partial(value)')},installation];
  assert.throws(()=>installSchemaPlan(db,plan),new RegExp('there is already an index named '+last));
  assert.deepEqual(schema(db),before);assert.equal(exists(db,first),false);assert.equal(db.isTransaction,nested);
  if(nested){
   db.exec("INSERT INTO generated_outer VALUES('after'); ROLLBACK TO generated_caller; RELEASE generated_caller");
   assert.deepEqual(db.prepare('SELECT value FROM generated_outer').all().map(row=>row.value),['before']);
  }
  db.exec(`DROP INDEX ${last}`);installSchemaPlan(db,plan);assert.ok(exists(db,first));assert.ok(exists(db,last));assert.equal(db.isTransaction,nested);
  if(nested){
   db.exec('ROLLBACK');assert.equal(exists(db,first),false);assert.equal(exists(db,'generated_partial'),false);
   assert.ok(db.prepare("SELECT 1 FROM sqlite_master WHERE type='index' AND name=?").get(last));
   db.exec(`DROP INDEX ${last}`);installSchemaPlan(db,plan);assert.ok(exists(db,first));assert.equal(db.isTransaction,false);
  }
  const installed=schema(db);installSchemaPlan(db,[installation]);assert.deepEqual(schema(db),installed);
 }finally{db.close();}
});

test('constructors install only their own table and a failed install publishes no external state',async t=>{
 const directory=mkdtempSync(join(tmpdir(),'mote-auxiliary-boundary-')),store=new Store(directory);
 t.after(()=>{store.close();rmSync(directory,{recursive:true,force:true});});
 assert.equal(exists(store.db,'insight_runs'),false);assert.equal(exists(store.db,'record_context_declarations'),false);
 store.db.exec('CREATE TABLE generated_collision(value TEXT); CREATE INDEX insight_runs ON generated_collision(value)');
 assert.throws(()=>new InsightRuns(store),/there is already an index named insight_runs/);
 assert.equal(exists(store.db,'insight_runs'),false);assert.equal(exists(store.db,'run_execution_owners'),false);
 store.db.exec('DROP INDEX insight_runs');
 const executor=new ExecutionEngine(store),runs=new InsightRuns(store,{executor});assert.ok(exists(store.db,'insight_runs'));assert.ok(exists(store.db,'run_execution_owners'));assert.equal(exists(store.db,'record_context_declarations'),false);
 await runs.close();await executor.close();
 store.db.exec('CREATE INDEX record_context_declarations ON generated_collision(value)');
 assert.throws(()=>new RecordContextStore(store),/there is already an index named record_context_declarations/);
 assert.equal(exists(store.db,'record_context_declarations'),false);
 store.db.exec('DROP INDEX record_context_declarations');
 store.db.exec('BEGIN');new RecordContextStore(store);store.db.exec('ROLLBACK');
 assert.equal(exists(store.db,'record_context_declarations'),false);
 new RecordContextStore(store);assert.ok(exists(store.db,'record_context_declarations'));
});

function draft(ids:string[]):MaterialDraft {
 const sourceId='generated-auxiliary-material',externalId='generated-auxiliary-note';
 return {id:materialId(sourceId,externalId),origin:{sourceId,externalId},title:'Generated auxiliary notes',kind:'mote.note',schemaVersion:1,
  members:ids.map(id=>({id,kind:'capture',ref:'capture:'+id})),blocks:ids.map((id,index)=>({id:'body-'+index,kind:'text',format:'plain',text:'Generated auxiliary original note',memberIds:[id],evidenceContext:{observedAt:at,document:{}}})),
  artifacts:[],coverage:{state:'complete'},fidelity:{state:'lossless'},retention:{original:'retained',policy:'keep'}};
}

test('Ingress record context, Material publication and an Insight review share one real durable chain',async t=>{
 const directory=mkdtempSync(join(tmpdir(),'mote-auxiliary-chain-')),store=new Store(directory),sources=new SourceStore(store),files=new FileStore(store,sources),materials=new MaterialStore(store),ingress=new IngressService(store,sources,files),executor=new ExecutionEngine(store),runs=new InsightRuns(store,{executor});
 t.after(async()=>{await runs.close();await executor.close();store.close();rmSync(directory,{recursive:true,force:true});});
 const input=capture(),receipt=await ingress.capture(input);assert.equal(receipt.duplicate,false);assert.equal(receipt.id,input.id);
 const declaration=new RecordContextStore(store).export().declarations[0];assert.equal(declaration.captureId,input.id);assert.equal(declaration.description,description);
 const material=materials.publish(draft([input.id]));assert.equal(materials.read(material.ref).spans[0].attributionContext.recordContextDeclarations?.[0].captureId,input.id);
 const id=randomUUID(),resultRunId=randomUUID();
 const result=await runs.perform(id,{prompt:'Generated auxiliary review'},async(observe,signal,snapshot)=>{
  signal.throwIfAborted();observe({stage:'tool',tool:'materials',count:1});
  const read=materials.read(material.ref);return {answer:JSON.stringify({title:'Generated auxiliary report',markdown:read.text,html:`<p>${read.text}</p>`}),citations:[],trace:[],runId:resultRunId,snapshot};
 });
 assert.equal(result.runId,resultRunId);assert.equal(runs.get(id).status,'completed');
 const detail=runs.detail(id);assert.equal(detail.status,'completed');assert.equal(detail.result?.runId,resultRunId);
 assert.match(String(detail.result?.answer),/Generated auxiliary original note/);assert.equal(store.insights().items.length,1);
 assert.equal(store.db.prepare('SELECT count(*) n FROM insight_runs').get()!.n,1);assert.equal(store.db.prepare('SELECT count(*) n FROM record_context_declarations').get()!.n,1);
});
