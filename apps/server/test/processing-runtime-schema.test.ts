import {workflowConfigDomain} from '../src/config.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync,constants} from 'node:sqlite';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import type {Context} from '@deepseek-ai/cordis';
import type {HostScope} from '@mote/plugin-host';
import {Store} from '../src/store.js';
import {ExecutionEngine} from '../src/execution-engine.js';
import {ProcessingRuntime} from '../src/processing-runtime.js';
import {ConfigService} from '../src/config-service.js';
import {workflowConfigurationSchema,defaultWorkflowConfiguration,type WorkflowConfiguration} from '../src/workflow-configuration.js';
import {installSchemaPlan} from '../src/schema-installation.js';
import {processingRuntimeSchemaInstallation} from '../src/processing-runtime-schema.js';
import {createTestScope} from './fixtures/plugin-scope.js';

const catalog=(db:DatabaseSync)=>db.prepare("SELECT type,name,tbl_name,sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type,name").all();
const exists=(db:DatabaseSync,name:string)=>Boolean(db.prepare('SELECT 1 FROM sqlite_master WHERE name=?').get(name));

for(const nested of [false,true])test(`late Processing DDL failure preserves prior state and retries${nested?' inside the caller transaction':''}`,()=>{
 const db=new DatabaseSync(':memory:');
 try{
  db.exec('PRAGMA foreign_keys=ON;CREATE TABLE generated_outer(value TEXT);CREATE INDEX processing_dependencies ON generated_outer(value)');
  if(nested)db.exec("BEGIN;INSERT INTO generated_outer VALUES('before');SAVEPOINT generated_caller");
  const before=catalog(db),prefix={owner:'generated-prefix',requires:[],install:(db:DatabaseSync)=>db.exec('CREATE TABLE generated_partial(value)')};
  assert.throws(()=>installSchemaPlan(db,[prefix,processingRuntimeSchemaInstallation]),/already an index named processing_dependencies/);
  assert.deepEqual(catalog(db),before);assert.equal(db.isTransaction,nested);
  assert.equal(exists(db,'generated_partial'),false);assert.equal(exists(db,'processing_jobs'),false);assert.equal(exists(db,'processing_ready'),false);assert.equal(exists(db,'processing_parent_grant'),false);
  if(nested){db.exec("INSERT INTO generated_outer VALUES('after');ROLLBACK TO generated_caller;RELEASE generated_caller");assert.deepEqual(db.prepare('SELECT value FROM generated_outer').all().map(row=>row.value),['before']);}
  db.exec('DROP INDEX processing_dependencies');installSchemaPlan(db,[prefix,processingRuntimeSchemaInstallation]);const installed=catalog(db);
  assert.ok(exists(db,'processing_jobs'));assert.ok(exists(db,'processing_dependencies'));assert.equal(exists(db,'execution_steps'),false);assert.equal(exists(db,'material_heads'),false);
  assert.deepEqual(db.prepare('PRAGMA foreign_key_list(processing_dependencies)').all().map(row=>row.table),['processing_jobs','processing_jobs']);assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(),[]);
  installSchemaPlan(db,[processingRuntimeSchemaInstallation]);assert.deepEqual(catalog(db),installed);
  if(nested){
   db.exec('ROLLBACK');assert.equal(exists(db,'processing_jobs'),false);assert.equal(exists(db,'generated_partial'),false);assert.ok(exists(db,'processing_dependencies'),'the pre-existing index survives caller rollback');
   db.exec('DROP INDEX processing_dependencies');installSchemaPlan(db,[prefix,processingRuntimeSchemaInstallation]);assert.deepEqual(catalog(db),installed);
  }
 }finally{db.close();}
});

for(const nested of [false,true])test(`failed Processing constructor publishes no bindings and keeps borrowed resources usable${nested?' with caller rollback':''}`,async t=>{
 const directory=mkdtempSync(join(tmpdir(),'mote-processing-schema-')),store=new Store(directory),db=store.db,engine=new ExecutionEngine(store),owner=createTestScope();
 const service=new ConfigService({path:join(directory,'mote.yaml'),watch:false,initialDocument:{version:1,revision:0,workflows:defaultWorkflowConfiguration()}});
 let runtime:ProcessingRuntime|undefined,oldHandler=0,deferred=0,plugins=0,siblingReleased=0,siblingRuns=0;
 const originalPlugin=owner.scope.cordis.plugin,descriptor=Object.getOwnPropertyDescriptor(owner.scope.cordis,'plugin');
 t.after(async()=>{
  db.setAuthorizer(null);if(db.isTransaction)db.exec('ROLLBACK');await runtime?.close();
  if(descriptor)Object.defineProperty(owner.scope.cordis,'plugin',descriptor);else Reflect.deleteProperty(owner.scope.cordis,'plugin');
  await owner.close();await service.close();await engine.close();store.close();rmSync(directory,{recursive:true,force:true});
 });
 service.register({id:'workflows',schema:workflowConfigurationSchema,defaultValue:defaultWorkflowConfiguration()});await service.initialize();
 service.setHandler(workflowConfigDomain,()=>({apply(){},publish(){oldHandler++;}}));
 owner.scope.defer(()=>{siblingReleased++;});
 const releaseSibling=engine.register({kind:'generated.processing-sibling',pool:'generated.processing-sibling',concurrency:()=>1,validate:()=>true,execute:async()=>{siblingRuns++;return {};},commit(){}});
 const scope:HostScope={...owner.scope,defer(dispose){deferred++;owner.scope.defer(dispose);}};
 Object.defineProperty(scope.cordis,'plugin',{configurable:true,value:function(this:Context,...args:unknown[]){plugins++;return Reflect.apply(originalPlugin,this,args);}});
 if(nested)db.exec("BEGIN;INSERT INTO settings VALUES('generated-before','before');SAVEPOINT generated_caller");
 const before=catalog(db);
 db.setAuthorizer((code,name)=>code===constants.SQLITE_CREATE_TABLE&&name==='processing_dependencies'?constants.SQLITE_DENY:constants.SQLITE_OK);
 assert.throws(()=>new ProcessingRuntime(store,[],{},Date.now,engine,undefined,scope,service),/not authorized/);db.setAuthorizer(null);
 assert.deepEqual(catalog(db),before);assert.equal(db.isTransaction,nested);assert.equal(deferred,0);assert.equal(plugins,0);assert.equal(engine.closed,false);assert.equal(scope.signal.aborted,false);assert.equal(siblingReleased,0);
 const prior=service.current(workflowConfigDomain),next={...prior,extract:{...prior.extract,concurrency:prior.extract.concurrency===1?2:1}};
 await service.replace('workflows',next,service.revision);assert.equal(oldHandler,1,'a failed constructor did not replace the existing configuration owner');
 runtime=new ProcessingRuntime(store,[],{},Date.now,engine,undefined,scope,service);await runtime.ready;assert.equal(runtime.settings().extract.concurrency,next.extract.concurrency);assert.equal(deferred,1);assert.equal(plugins,1);
 const changed={...next,extract:{...next.extract,concurrency:next.extract.concurrency===1?2:1}};
 await service.replace('workflows',changed,service.revision);assert.equal(runtime.settings().extract.concurrency,changed.extract.concurrency);assert.equal(oldHandler,1);
 await runtime.close();runtime=undefined;assert.equal(engine.closed,false);assert.equal(scope.signal.aborted,false);assert.equal(siblingReleased,0);
 if(nested){
  db.exec('ROLLBACK TO generated_caller;RELEASE generated_caller');assert.deepEqual(catalog(db),before);assert.equal(db.prepare("SELECT value FROM settings WHERE key='generated-before'").get()?.value,'before');
  runtime=new ProcessingRuntime(store,[],{},Date.now,engine,undefined,scope,service);await runtime.ready;await runtime.close();runtime=undefined;db.exec('ROLLBACK');assert.equal(exists(db,'processing_jobs'),false);
 }
 runtime=new ProcessingRuntime(store,[],{},Date.now,engine,undefined,scope,service);await runtime.ready;await runtime.close();runtime=undefined;
 const id='generated-processing-sibling-'+nested;engine.enqueue('generated-processing-sibling','generated.processing-sibling',{}, {id});await engine.drain([id]);assert.equal(engine.get(id)?.state,'succeeded');assert.equal(siblingRuns,1);await releaseSibling();
 assert.equal(engine.closed,false);assert.equal(scope.signal.aborted,false);assert.equal(siblingReleased,0);
});
