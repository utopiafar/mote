import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,readFileSync,writeFileSync,copyFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {execFileSync,spawnSync} from 'node:child_process';
import {checkSqlOwnership} from './sql-ownership.mjs';
import {consumerScopes,consumers,sharedReads,schemaMaintenance,retainedClassificationScopes} from './sql-ownership-policy.mjs';

const repository=fileURLToPath(new URL('../..',import.meta.url)),cli=fileURLToPath(new URL('./architecture.mjs',import.meta.url));
const schema='apps/server/src/background-model-authorization-schema.ts',consumer='apps/server/src/background-model-authorization.ts';
const tables=['background_model_authorization','background_model_receipts','background_model_lineage','background_model_work','background_model_trigger_claims','background_model_step_authority'];

test('background authorization owns six tables while complete routine consumers keep their original pending identities',()=>{
 const result=checkSqlOwnership(repository);assert.deepEqual(result.violations,[]);assert.deepEqual(result.stale,[]);
 for(const table of tables){assert.equal(result.tables[table].owner,'background-model-authorization');assert.equal(result.tables[table].installer,'backgroundModelAuthorizationSchemaInstallation');}
 assert.equal(consumers['background-model-authorization.ts'],undefined);
 const scopes=consumerScopes['background-model-authorization.ts'];
 assert.deepEqual(scopes,{
  'BackgroundModelAuthorization.state':'background-model-authorization',
  'BackgroundModelAuthorization.transaction':'background-model-authorization',
  'BackgroundModelAuthorization.command':'background-model-authorization',
  'BackgroundModelAuthorization.receive':'background-model-authorization',
  'BackgroundModelAuthorization.derive':'background-model-authorization',
  'BackgroundModelAuthorization.roots':'background-model-authorization',
  'BackgroundModelAuthorization.freshTriggers':'background-model-authorization',
  'BackgroundModelAuthorization.save':'background-model-authorization',
  'BackgroundModelAuthorization.saved':'background-model-authorization',
  'BackgroundModelAuthorization.automatic':'background-model-authorization',
  'BackgroundModelAuthorization.bindStep':'background-model-authorization',
  'BackgroundModelAuthorization.stepAuthority':'background-model-authorization',
  'BackgroundModelAuthorization.assertStep':'background-model-authorization',
  'BackgroundModelAuthorization.runStep':'background-model-authorization',
 });
 assert.equal(scopes['BackgroundModelAuthorization.eligible'],undefined);assert.equal(scopes['BackgroundModelAuthorization.receiveRoutineOccurrence'],undefined);
 assert.deepEqual(result.exceptions.filter(issue=>issue.from===consumer).map(issue=>[issue.rule,issue.scope,issue.symbol]).sort(),[
  ['sql-uncovered-consumer','BackgroundModelAuthorization.eligible','194855c2d8e299964bf2997be7324bffcfa6159765013c07b97c39de0929cd93'],
  ['sql-uncovered-consumer','BackgroundModelAuthorization.eligible','e6348b1927665d91d4955a880743d65f480833f295de238c526a410538aa4ab5'],
  ['sql-uncovered-consumer','BackgroundModelAuthorization.receiveRoutineOccurrence','24505e29c9b9867a055a2ec818ae718579fbd86233dbeaa231ed10f587c1b82e'],
 ].sort());
 for(const entries of [sharedReads,schemaMaintenance,retainedClassificationScopes])assert.ok(!entries.some(item=>[schema,consumer].includes(item.from)));
 assert.equal(result.pendingRawWrites.length,4);
});

test('production entry rejects background foreign effects, moved scopes, changed pending SQL and installer escape',t=>{
 const root=mkdtempSync(join(tmpdir(),'mote-background-ownership-'));t.after(()=>rmSync(root,{recursive:true,force:true}));
 const tracked=execFileSync('git',['ls-files','-z','--','apps','packages','scripts','*.json'],{cwd:repository,encoding:'utf8'}).split('\0').filter(file=>/\.(?:[cm]?[jt]sx?|json)$/.test(file));
 for(const file of new Set([...tracked,schema])){mkdirSync(resolve(root,file,'..'),{recursive:true});copyFileSync(resolve(repository,file),resolve(root,file));}
 const run=()=>spawnSync(process.execPath,[cli],{cwd:root,encoding:'utf8'}),originals=new Map([schema,consumer].map(file=>[file,readFileSync(resolve(root,file),'utf8')]));
 const baselinePath=resolve(root,'scripts/ci/sql-ownership-baseline.json'),baseline=readFileSync(baselinePath,'utf8');
 let result=run();assert.equal(result.status,0,result.stderr);assert.match(result.stdout,/Architecture boundaries passed/);
 const cases=[
  [consumer,originals.get(consumer).replace('private saved(id:string):Work|undefined{',"private saved(id:string):Work|undefined{this.store.db.prepare('DELETE FROM execution_steps WHERE id=?');"),/sql-cross-owner.*background-model-authorization.ts.*execution_steps.*write/],
  [consumer,originals.get(consumer).replace('stepAuthority(stepId:string){',"stepAuthority(stepId:string){this.store.db.prepare('SELECT id FROM material_heads');"),/sql-cross-owner.*background-model-authorization.ts.*material_heads.*read/],
  [consumer,originals.get(consumer).replace('private state():State{','private movedState():State{'),/sql-uncovered-consumer.*background-model-authorization.ts/],
  [consumer,originals.get(consumer)+"\nfunction copiedReceiptRead(db){db.prepare('SELECT 1 FROM background_model_receipts WHERE identity=?');}",/sql-uncovered-consumer.*background-model-authorization.ts/],
  [consumer,originals.get(consumer).replace('WHERE r.id=? AND r.revision=?','WHERE r.id=? AND r.enabled=1 AND r.revision=?'),/sql-uncovered-consumer.*background-model-authorization.ts/],
  [schema,originals.get(schema).replace('install(db){',"install(db){db.prepare('DELETE FROM execution_steps WHERE id=?');"),/sql-schema-maintenance.*execution_steps.*delete/],
  [schema,originals.get(schema)+"\nconst escaped=backgroundModelAuthorizationSchemaInstallation['install'];",/inline installer cannot escape its registered declaration/],
 ];
 for(const[file,changed,diagnostic]of cases){assert.notEqual(changed,originals.get(file));writeFileSync(resolve(root,file),changed);result=run();assert.equal(result.status,1,result.stderr);assert.match(result.stderr,diagnostic);writeFileSync(resolve(root,file),originals.get(file));}
 assert.equal(readFileSync(baselinePath,'utf8'),baseline);result=run();assert.equal(result.status,0,result.stderr);
});
