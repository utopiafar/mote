import test from 'node:test';
import assert from 'node:assert/strict';
import {copyFileSync,mkdirSync,mkdtempSync,readFileSync,rmSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {execFileSync,spawnSync} from 'node:child_process';
import {nonSqlCalls} from './sql-ownership-policy.mjs';
import {sqlStatements} from './sql-ownership.mjs';

const repository=fileURLToPath(new URL('../..',import.meta.url)),architecture=fileURLToPath(new URL('./architecture.mjs',import.meta.url));
const proofs=nonSqlCalls.filter(proof=>proof.kind==='local-resource-method');
const sources=new Map(proofs.map(proof=>[proof.from,readFileSync(resolve(repository,proof.from),'utf8')]));
const agent=proofs.find(proof=>proof.receiver==='super'),models=proofs.find(proof=>proof.receiver==='this');
const agentCall='super.prepare(candidate,options.activate??(()=>{}),options.rollback)',modelsCall='this.prepare(this.options.configService.current(modelsConfigDomain))';
function replace(source,before,after){assert.ok(source.includes(before),before);return source.replace(before,after);}
function scan(proof,source){const evidence=[];const statements=sqlStatements(proof.from,source,{nonSqlProofs:[proof],nonSqlEvidence:evidence});return {evidence,statements};}

test('the two local resource calls bind their actual class, implementation and arguments without hashing unrelated source',()=>{
 assert.deepEqual(proofs.map(proof=>[proof.scope,proof.receiver,proof.parameterType]),[
  ['AgentRuntimeRegistry.prepareModels','super','QueryAgent'],['ModelSettingsStore.initialize','this','ModelDomain'],
 ]);
 for(const proof of proofs){
  const source=sources.get(proof.from),original=scan(proof,source);
  assert.equal(original.evidence.length,1);assert.equal(original.statements.filter(statement=>statement.scope===proof.scope).length,0);
  assert.equal(scan(proof,source+'\nconst generatedUnrelatedResourceCheck=true;').evidence.length,1,'unrelated source does not invalidate the bound call');
  assert.equal(scan(proof,source+'\nclass GeneratedUnrelatedResource{constructor(){this.prepare=()=>{};}}').evidence.length,1,'another class cannot change this receiver binding');
  const database=source+"\nfunction generatedSqlReceiver(db,sql){return db.prepare(sql);}";
  const checked=scan(proof,database);assert.equal(checked.evidence.length,1);assert.ok(checked.statements.some(statement=>statement.scope==='generatedSqlReceiver'&&statement.values.includes('__dynamic__')),'another prepare still reaches the SQL scanner');
 }
});

test('local resource proofs reject changed slots, lexical receivers, direct argument bindings and duplicate calls',()=>{
 const modelSource=sources.get(models.from),agentSource=sources.get(agent.from);
 const cases=[
  [models,replace(modelSource,modelsCall,"this.options.db.prepare('SELECT value FROM settings')")],
  [agent,replace(agentSource,agentCall,"super.prepare('SELECT value FROM settings',options.activate??(()=>{}),options.rollback)")],
  [models,replace(modelSource,'this.serialize(async () => {','this.serialize(async function() {')],
  [models,replace(modelSource,"id:'models',schema:modelDomainSchema","id:'generated-other',schema:modelDomainSchema")],
  [models,replace(modelSource,'private readonly options: ModelSettingsStoreOptions','private readonly options: GeneratedStoreOptions')],
  [models,replace(modelSource,'private tail: Promise<void>',"'prepare'=generatedDatabasePrepare;\n  private tail: Promise<void>")],
  [models,replace(modelSource,'if(this.initialized)return this.view();','Object.assign(this,{prepare:generatedDatabasePrepare});if(this.initialized)return this.view();')],
  [models,modelSource+'\nObject.setPrototypeOf(ModelSettingsStore.prototype,generatedDatabasePrototype);'],
  [agent,replace(agentSource,'async prepare(agent: QueryAgent,','async prepare(agent: string,')],
 ];
 for(const [proof,changed] of cases){const checked=scan(proof,changed);assert.equal(checked.evidence.length,0,proof.scope);assert.ok(checked.statements.some(statement=>statement.scope===proof.scope),'withdrawn proof leaves the original sink visible');}
 for(const [proof,call] of [[agent,agentCall],[models,modelsCall]]){
  const checked=scan(proof,replace(sources.get(proof.from),call,'('+call+','+call+')'));
  assert.ok(checked.statements.some(statement=>statement.scope===proof.scope),'an additional invocation cannot inherit the one exact call proof');
 }
});

test('the actual architecture CLI accepts both calls and rejects receiver, arguments, definition, heritage, binding and callee SQL mutants',{timeout:120000},t=>{
 const root=mkdtempSync(join(tmpdir(),'mote-resource-prepare-cli-'));t.after(()=>rmSync(root,{recursive:true,force:true}));
 const tracked=execFileSync('git',['ls-files','-z','--','apps','packages','scripts','*.json'],{cwd:repository,encoding:'utf8'}).split('\0').filter(file=>/\.(?:[cm]?[jt]sx?|json)$/.test(file));
 for(const file of tracked){mkdirSync(resolve(root,file,'..'),{recursive:true});copyFileSync(resolve(repository,file),resolve(root,file));}
 const run=()=>spawnSync(process.execPath,[architecture],{cwd:root,encoding:'utf8'});
 let result=run();assert.equal(result.status,0,result.stderr);assert.match(result.stdout,/Architecture boundaries passed/);t.diagnostic(JSON.stringify({name:'production baseline',exitCode:result.status,stdout:result.stdout.trim(),stderr:result.stderr.trim()}));
 const agentSource=sources.get(agent.from),modelSource=sources.get(models.from);
 const cases=[
  {name:'receiver',proof:agent,source:replace(agentSource,agentCall,"this.dependencies.db.prepare('SELECT value FROM settings')"),scope:agent.scope},
  {name:'arguments',proof:models,source:replace(modelSource,modelsCall,"this.prepare('SELECT value FROM settings')"),scope:models.scope},
  {name:'definition',proof:models,source:replace(modelSource,'private async prepare(state:ModelDomain,previous=state): Promise<PreparedModelSettings> {','private async prepare(state:ModelDomain,previous=state): Promise<PreparedModelSettings> {\n    void state;'),scope:models.scope},
  {name:'heritage',proof:agent,source:replace(agentSource,'export class AgentRuntimeRegistry extends ReloadableAgent {','const GeneratedBase=ReloadableAgent;\nexport class AgentRuntimeRegistry extends GeneratedBase {'),scope:agent.scope},
  {name:'binding',proof:agent,source:replace(agentSource,'const candidate=await this.createModelRegistry(profiles,reader,options.initialAgent,options.defaultProfileId??DEPLOYMENT_MODEL_PROFILE_ID);','const candidate=options.initialAgent!;'),scope:agent.scope},
  {name:'callee SQLite',proof:models,source:replace(modelSource,'private async prepare(state:ModelDomain,previous=state): Promise<PreparedModelSettings> {',"private async prepare(state:ModelDomain,previous=state): Promise<PreparedModelSettings> {\n    const generatedDb=new (await import('node:sqlite')).DatabaseSync(':memory:');\n    try{generatedDb.prepare('SELECT value FROM settings');}finally{generatedDb.close();}"),scope:'ModelSettingsStore.prepare',sql:'SELECT value FROM settings'},
 ];
 for(const mutant of cases){
  const path=resolve(root,mutant.proof.from);writeFileSync(path,mutant.source);
  try{
   const checked=scan(mutant.proof,mutant.source),statement=checked.statements.find(statement=>statement.scope===mutant.scope&&(!mutant.sql||statement.values.includes(mutant.sql)));
   assert.ok(statement,mutant.name+' exposes its actual SQL sink');
   result=run();assert.equal(result.status,1,mutant.name+': '+result.stderr);assert.match(result.stdout,/SQL ownership:/,mutant.name+' reaches the real ownership gate');
   assert.ok(result.stderr.includes('sql-uncovered-consumer: '+mutant.proof.from+':'+statement.line+' -> [owner pending] (coverage)'),mutant.name+': '+result.stderr);
   t.diagnostic(JSON.stringify({name:mutant.name,exitCode:result.status,actualSqlScope:statement.scope,actualSqlLine:statement.line,stdout:result.stdout.trim(),stderr:result.stderr.trim()}));
  }finally{writeFileSync(path,sources.get(mutant.proof.from));}
 }
 result=run();assert.equal(result.status,0,result.stderr);t.diagnostic(JSON.stringify({name:'production restored',exitCode:result.status,stdout:result.stdout.trim(),stderr:result.stderr.trim()}));
});
