import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync,constants} from 'node:sqlite';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {installSchemaPlan} from '../src/schema-installation.js';
import {memoryBindingSchemaInstallation} from '../src/memory-binding-schema.js';
import {MemoryBindings} from '../src/memory-bindings.js';
import {Store} from '../src/store.js';
import {MemoryStore} from '../src/memory.js';
import {MemoryAutomation} from '../src/memory-automation.js';
import {ExecutionEngine} from '../src/execution-engine.js';
import {EXECUTION_POLICIES} from '../src/execution-policy.js';
import type {PluginCenter} from '../src/plugin-center.js';
import type {MemoryProvider,MemoryProviderHealth} from '../src/memory-provider-contract.js';

const names=['memory_plan_binding','memory_preparation','memory_binding_commands','memory_provider_receipts'];
const schema=(db:DatabaseSync)=>db.prepare("SELECT type,name,tbl_name,sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type,name").all();
const table=(db:DatabaseSync,name:string)=>Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name));
const columns=(db:DatabaseSync,name:string)=>db.prepare(`PRAGMA table_info(${name})`).all().map(row=>({name:row.name,type:row.type,notnull:row.notnull,pk:row.pk}));
function denyLastTable(db:DatabaseSync){
 db.setAuthorizer((code,name)=>code===constants.SQLITE_CREATE_TABLE&&name==='memory_provider_receipts'?constants.SQLITE_DENY:constants.SQLITE_OK);
}

for(const nested of [false,true])test(`native final-table failure restores the Memory binding owner${nested?' with caller savepoint and outer rollback':''}`,()=>{
 const db=new DatabaseSync(':memory:');
 try{
  db.exec('PRAGMA foreign_keys=ON;CREATE TABLE generated_outer(value TEXT)');
  if(nested)db.exec("BEGIN;INSERT INTO generated_outer VALUES('before');SAVEPOINT generated_caller");
  const before=schema(db);denyLastTable(db);
  assert.throws(()=>installSchemaPlan(db,[memoryBindingSchemaInstallation]),/not authorized/);
  assert.deepEqual(schema(db),before);assert.equal(db.isTransaction,nested);
  for(const name of names)assert.equal(table(db,name),false);
  if(nested){
   db.exec("INSERT INTO generated_outer VALUES('after');ROLLBACK TO generated_caller;RELEASE generated_caller");
   assert.deepEqual(db.prepare('SELECT value FROM generated_outer').all().map(row=>row.value),['before']);
  }
  db.setAuthorizer(null);installSchemaPlan(db,[memoryBindingSchemaInstallation]);const installed=schema(db);
  assert.notDeepEqual(installed,before);assert.equal(db.isTransaction,nested);
  for(const name of names)assert.equal(table(db,name),true);
  assert.deepEqual(columns(db,'memory_plan_binding'),[{name:'id',type:'INTEGER',notnull:0,pk:1},{name:'json',type:'TEXT',notnull:1,pk:0}]);
  assert.deepEqual(columns(db,'memory_preparation'),[{name:'id',type:'INTEGER',notnull:0,pk:1},{name:'json',type:'TEXT',notnull:1,pk:0}]);
  assert.deepEqual(columns(db,'memory_binding_commands'),[{name:'id',type:'TEXT',notnull:0,pk:1},{name:'fingerprint',type:'TEXT',notnull:1,pk:0}]);
  assert.deepEqual(columns(db,'memory_provider_receipts'),[{name:'id',type:'TEXT',notnull:0,pk:1},{name:'json',type:'TEXT',notnull:1,pk:0}]);
  for(const name of names)assert.deepEqual(db.prepare(`PRAGMA foreign_key_list(${name})`).all(),[],'the original tables have no foreign keys');
  assert.equal(db.prepare('SELECT count(*) n FROM memory_plan_binding').get()!.n,0,'the owner installs schema, not a seed');
  if(nested){
   db.exec('ROLLBACK');assert.deepEqual(schema(db),before);
   installSchemaPlan(db,[memoryBindingSchemaInstallation]);assert.deepEqual(schema(db),installed);assert.equal(db.isTransaction,false);
  }
  installSchemaPlan(db,[memoryBindingSchemaInstallation]);assert.deepEqual(schema(db),installed);
 }finally{db.setAuthorizer(null);db.close();}
});

const health:MemoryProviderHealth={providerId:'generated',version:'1',ready:false,verified:{persistentCrud:false,scopedRetrieval:false,immutableRecords:false,idempotentReplay:false,history:false,physicalErase:false},problems:['generated provider remains unavailable']};
const blockedProvider={recover:async()=>health,health:async()=>health,put:async()=>{throw Error('blocked provider cannot write');},read:async()=>null,remove:async()=>{throw Error('blocked provider cannot remove');},search:async()=>[],export:async()=>[],close:async()=>{}} as MemoryProvider;

function generatedPlugins(instanceId:string){
 const reference=(_id:string)=>[] as string[],instance={id:instanceId,name:'Generated target',scope:'default',revision:1,configuration:{},configurationSchema:[],configurationId:'generated-configuration',secretStatus:{},desired:true,observed:'ready',issues:[],allowedActions:[],capabilities:[{id:'engine',state:'verified' as const}]};
 return {references:reference,view:()=>({revision:1,installation:{supported:true,runtime:'worker' as const,restartRequired:false},packages:[],instances:[instance],catalog:[]}),instanceView:(id:string)=>({...instance,id})} as unknown as PluginCenter;
}

test('the real constructor publishes the builtin only after its complete owner, keeps a borrowed sibling, and retries the same handle',async t=>{
 const directory=mkdtempSync(join(tmpdir(),'mote-memory-binding-schema-')),store=new Store(directory),memories=new MemoryStore(store),automation=new MemoryAutomation(store),executor=new ExecutionEngine(store),plugins=generatedPlugins('generated-target'),db=store.db;
 const reference=()=>['generated sentinel'];Object.assign(plugins,{references:reference});
 let siblingRuns=0;
 const disposeSibling=executor.register({kind:'generated.sibling',pool:'plugin-control',concurrency:()=>1,policy:EXECUTION_POLICIES.orchestration,maxAttempts:1,validate:()=>true,execute:async()=>{siblingRuns++;return 'generated-sibling';},commit:()=>{},project:()=>{}});
 const runSibling=async(id:string)=>{executor.enqueue('generated-operation','generated.sibling',{}, {id});await executor.drain([id]);assert.equal(executor.get(id)!.state,'succeeded');};
 let bindings:MemoryBindings|undefined;
 t.after(async()=>{db.setAuthorizer(null);await bindings?.close().catch(()=>{});await disposeSibling();await executor.close();store.close();rmSync(directory,{recursive:true,force:true});});
 await runSibling('generated-sibling-before');assert.equal(siblingRuns,1);

 db.exec("CREATE TABLE generated_outer(value TEXT);BEGIN;INSERT INTO generated_outer VALUES('before');SAVEPOINT generated_caller");
 const before=schema(db);denyLastTable(db);
 assert.throws(()=>new MemoryBindings(store,memories,automation,plugins,executor),/not authorized/);
 assert.deepEqual(schema(db),before);assert.equal(db.isTransaction,true);
 for(const name of names)assert.equal(table(db,name),false);
 assert.equal((plugins as unknown as {references:()=>string[]}).references,reference,'a failed constructor leaves no retained reference callback');
 assert.throws(()=>executor.enqueue('generated-operation','memory.prepare',{}, {id:'generated-memory-step'}),{statusCode:409},'a failed constructor leaves no execution handler');
 db.setAuthorizer(null);
 bindings=new MemoryBindings(store,memories,automation,plugins,executor);
 assert.deepEqual(JSON.parse(String(db.prepare('SELECT json FROM memory_plan_binding WHERE id=1').get()!.json)),{planId:'mote.builtin',generation:1});
 assert.notEqual((plugins as unknown as {references:()=>string[]}).references,reference);
 assert.deepEqual(db.prepare("SELECT name,plugin,expression FROM storage_ledger_meters WHERE plugin='memory-control' AND name IN ('memory_plan_binding','memory_preparation','memory_binding_commands','memory_provider_receipts') ORDER BY name").all().map(row=>({...row})),[
  {name:'memory_binding_commands',plugin:'memory-control',expression:'length(CAST(id AS BLOB))+length(CAST(fingerprint AS BLOB))+128'},
  {name:'memory_plan_binding',plugin:'memory-control',expression:'length(CAST(json AS BLOB))+length(CAST(id AS BLOB))+128'},
  {name:'memory_preparation',plugin:'memory-control',expression:'length(CAST(json AS BLOB))+length(CAST(id AS BLOB))+128'},
  {name:'memory_provider_receipts',plugin:'memory-control',expression:'length(CAST(json AS BLOB))+length(CAST(id AS BLOB))+128'},
 ]);
 for(const name of names)assert.equal(table(db,name),true);
 await bindings.close();bindings=undefined;
 db.exec('ROLLBACK TO generated_caller;RELEASE generated_caller');
 assert.deepEqual(schema(db),before);for(const name of names)assert.equal(table(db,name),false);
 db.exec('ROLLBACK');assert.equal(db.isTransaction,false);

 bindings=new MemoryBindings(store,memories,automation,plugins,executor);
 await runSibling('generated-sibling-after');assert.equal(siblingRuns,2);
 bindings.providerFactory=()=>blockedProvider;
 const operationId=randomUUID();
 bindings.prepare({operationId,expectedRevision:bindings.view().revision,targetPlanId:'instance:generated-target',scope:'default',feeAcknowledged:true});
 await executor.drain(['memory-prepare:'+operationId]);
 assert.equal(bindings.view().preparation?.state,'blocked');assert.equal(bindings.view().preparation?.error,'memory_target_capabilities_unverified');
 assert.deepEqual(bindings.view().preparation?.allowedActions,['retry','cancel']);
 bindings.action('retry',{operationId:randomUUID(),expectedRevision:bindings.view().revision,preparationId:operationId});
 await executor.drain(['memory-prepare:'+operationId]);
 assert.equal(bindings.view().preparation?.state,'blocked');
 automation.command('pause',{operationId:randomUUID(),expectedRevision:automation.state().revision});
 assert.equal(bindings.accepting(),false);assert.equal(bindings.binding().planId,'mote.builtin','pause leaves the durable binding unchanged');
 automation.command('resume',{operationId:randomUUID(),expectedRevision:automation.state().revision});
 assert.equal(bindings.accepting(),true);
 bindings.action('cancel',{operationId:randomUUID(),expectedRevision:bindings.view().revision,preparationId:operationId});
 assert.equal(bindings.view().preparation?.state,'cancelled');
 await bindings.close();bindings=undefined;
});
