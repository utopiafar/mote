import test from 'node:test';
import assert from 'node:assert/strict';
import {cpSync,mkdtempSync,readFileSync,rmSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';
import {checkSqlOwnership} from './sql-ownership.mjs';
import {consumerScopes,finiteInstallations,schemaMaintenance} from './sql-ownership-policy.mjs';

const repository=fileURLToPath(new URL('../..',import.meta.url)),cli=fileURLToPath(new URL('./sql-ownership.mjs',import.meta.url));
const processor='apps/server/src/processor-admission.ts',provider='apps/server/src/provider-admission.ts',schema='apps/server/src/admission-schema.ts';

test('admission owners cover only their cooldown tables and independent constructor boundaries',()=>{
 const result=checkSqlOwnership(repository);assert.deepEqual(result.violations,[]);assert.deepEqual(result.stale,[]);
 assert.equal(result.tables.processor_cooldowns.owner,'processor-admission');
 assert.equal(result.tables.processor_cooldowns.installer,'processorAdmissionSchemaInstallation');
 assert.equal(result.tables.provider_cooldowns.owner,'provider-admission');
 assert.equal(result.tables.provider_cooldowns.installer,'providerAdmissionSchemaInstallation');
 assert.ok([processor,provider].every(file=>result.coveredFiles.includes(file)&&!result.uncoveredFiles.includes(file)));
 assert.equal(result.exceptions.filter(issue=>[processor,provider,schema].includes(issue.from)).length,0);
 assert.equal(result.retainedClassificationDebt.filter(item=>[processor,provider,schema].includes(item.issue.from)).length,0);
 assert.equal(result.pendingRawWrites.filter(issue=>[processor,provider,schema].includes(issue.from)).length,0);
 assert.deepEqual(consumerScopes['processor-admission.ts'],{'ProcessorAdmission.check':'processor-admission','ProcessorAdmission.run':'processor-admission'});
 assert.deepEqual(consumerScopes['provider-admission.ts'],{'ProviderAdmission.check':'provider-admission','ProviderAdmission.run':'provider-admission','ProviderAdmission.snapshot':'provider-admission'});
 assert.ok(finiteInstallations.includes('processorAdmissionSchemaInstallation'));
 assert.ok(finiteInstallations.includes('providerAdmissionSchemaInstallation'));
 assert.ok(!schemaMaintenance.some(item=>item.from===schema),'admission installers grant no foreign maintenance effect');
});

test('production entry rejects admission foreign effects, copied reads and raw installer runtime calls',t=>{
 const root=mkdtempSync(join(tmpdir(),'mote-admission-state-ownership-'));t.after(()=>rmSync(root,{recursive:true,force:true}));
 cpSync(resolve(repository,'apps/server/src'),resolve(root,'apps/server/src'),{recursive:true});
 cpSync(resolve(repository,'scripts/ci'),resolve(root,'scripts/ci'),{recursive:true});
 const run=()=>spawnSync(process.execPath,[cli],{cwd:root,encoding:'utf8'});
 let result=run();assert.equal(result.status,0,result.stderr);assert.match(result.stdout,/SQL ownership: 40 schema owners/);
 const baselinePath=resolve(root,'scripts/ci/sql-ownership-baseline.json'),baseline=readFileSync(baselinePath,'utf8');
 const originals=new Map([processor,provider,schema].map(file=>[file,readFileSync(resolve(root,file),'utf8')]));
 const cases=[
  [processor,originals.get(processor).replace('check(endpoint:string){',"check(endpoint:string){this.store.db.prepare('UPDATE provider_cooldowns SET code=code').run();"),/sql-cross-owner.*processor-admission.ts.*provider_cooldowns.*write/],
  [provider,originals.get(provider).replace('check(settings:Identity){this.assertOpen();',"check(settings:Identity){this.assertOpen();this.store.db.prepare('SELECT scope FROM processor_cooldowns').get();"),/sql-cross-owner.*provider-admission.ts.*processor_cooldowns.*read/],
  [schema,originals.get(schema).replace('function providerAdmissionSchema(db:DatabaseSync){',"function providerAdmissionSchema(db:DatabaseSync){db.prepare('UPDATE processor_cooldowns SET until=until').run();"),/sql-schema-maintenance.*admission-schema.ts.*processor_cooldowns.*update/],
  [schema,originals.get(schema)+'\nfunction generatedRuntime(db:DatabaseSync){providerAdmissionSchema(db);}',/schema installer cannot acquire another runtime call path/],
  [processor,originals.get(processor)+'\nfunction generatedUnownedRead(db){db.prepare(\'SELECT code FROM provider_cooldowns WHERE scope=?\');}',/sql-uncovered-consumer.*processor-admission.ts/],
 ];
 for(const [file,changed,diagnostic]of cases){
  const original=originals.get(file);assert.notEqual(changed,original);writeFileSync(resolve(root,file),changed);
  result=run();assert.equal(result.status,1,result.stderr);assert.match(result.stderr,diagnostic);assert.equal(readFileSync(baselinePath,'utf8'),baseline);writeFileSync(resolve(root,file),original);
 }
 const restored=run();assert.equal(restored.status,0,restored.stderr);assert.equal(readFileSync(baselinePath,'utf8'),baseline);
});
