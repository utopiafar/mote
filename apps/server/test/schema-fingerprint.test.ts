import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {existsSync,mkdtempSync,readFileSync,renameSync,rmSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import test from 'node:test';
import type {DatabaseSync} from 'node:sqlite';
import {buildApp} from '../src/app.js';
import type {Config} from '../src/config.js';

const SNAPSHOT_FILE=fileURLToPath(new URL('./fixtures/schema-fingerprint.json',import.meta.url));
// Only additive changes or a deliberate backend_epoch reset may regenerate it:
// MOTE_UPDATE_SCHEMA_FINGERPRINT=1 npm run test:file -w @mote/server -- test/schema-fingerprint.test.ts
const UPDATE_ENV='MOTE_UPDATE_SCHEMA_FINGERPRINT';

export type SchemaObjectRow={type:string;name:string;sql:string};
export type FingerprintedSchemaObject={type:string;name:string;fingerprint:string};
export type SchemaSnapshot={backend_epoch:string;objects:FingerprintedSchemaObject[]};
export type SchemaObjectComparison={
  changed:FingerprintedSchemaObject[];
  removed:FingerprintedSchemaObject[];
  added:FingerprintedSchemaObject[];
};
export type SchemaComparison=SchemaObjectComparison&{
  previousEpoch:string;
  currentEpoch:string;
  epochChanged:boolean;
};

type SqlToken={kind:'word'|'quoted'|'symbol';value:string};

const isWordStart=(value:string)=>/[A-Za-z0-9_$]/.test(value)||value.charCodeAt(0)>127;
const isWordPart=(value:string)=>isWordStart(value);
const objectKey=(object:FingerprintedSchemaObject)=>`${object.type}\0${object.name}`;
const objectLabel=(object:FingerprintedSchemaObject)=>`${object.type}:${object.name}`;
const objectLabels=(objects:FingerprintedSchemaObject[])=>objects.map(objectLabel).join(', ');

/** Schema SQL is stored exactly as written. Tokenizing first keeps literal
 * whitespace unchanged while removing formatting differences between runs and
 * SQLite's own rewritten CREATE statements. */
function tokenizeSchemaSql(sql:string):SqlToken[]{
  const tokens:SqlToken[]=[];
  for(let index=0;index<sql.length;){
    const char=sql[index]!;
    if(/\s/.test(char)){index++;continue;}
    if(char==='-'&&sql[index+1]==='-'){
      index+=2;while(index<sql.length&&sql[index]!=='\n')index++;
      continue;
    }
    if(char==='/'&&sql[index+1]==='*'){
      index+=2;while(index<sql.length&&!(sql[index]==='*'&&sql[index+1]==='/'))index++;
      index=Math.min(sql.length,index+2);
      continue;
    }
    if(char==="'"||char==='"'||char==='`'||char==='['){
      const close=char==='['?']':char;
      let value=char;index++;
      while(index<sql.length){
        const next=sql[index]!;value+=next;index++;
        if(next!==close)continue;
        if(close!==']'&&sql[index]===close){value+=sql[index]!;index++;continue;}
        break;
      }
      tokens.push({kind:'quoted',value});
      continue;
    }
    if(isWordStart(char)){
      let value=char;index++;
      while(index<sql.length&&isWordPart(sql[index]!)){value+=sql[index]!;index++;}
      tokens.push({kind:'word',value});
      continue;
    }
    const pair=sql.slice(index,index+2);
    if(['||','<<','>>','<=','>=','==','!=','<>'].includes(pair)){
      tokens.push({kind:'symbol',value:pair});index+=2;
      continue;
    }
    tokens.push({kind:'symbol',value:char});index++;
  }
  return tokens;
}

export function normalizeSchemaSql(sql:string):string{
  const tokens=tokenizeSchemaSql(sql);
  let normalized='';
  for(const [index,token] of tokens.entries()){
    const previous=tokens[index-1];
    if(!previous){normalized=token.value;continue;}
    const separate=previous.kind!=='symbol'&&token.kind!=='symbol';
    const pair=`${previous.value.slice(-1)}${token.value[0]}`;
    const commentBoundary=previous.kind==='symbol'&&token.kind==='symbol'&&(pair==='--'||pair==='/*'||pair==='*/');
    normalized+=(separate||commentBoundary?' ':'')+token.value;
  }
  return normalized;
}

export function fingerprintSchemaObject(object:SchemaObjectRow):FingerprintedSchemaObject{
  if(typeof object.type!=='string'||!object.type||typeof object.name!=='string'||!object.name||typeof object.sql!=='string'){
    throw new Error('Schema object is missing its type, name or SQL');
  }
  const fingerprint=createHash('sha256')
    .update(JSON.stringify([object.type,object.name,normalizeSchemaSql(object.sql)]))
    .digest('hex');
  return {type:object.type,name:object.name,fingerprint};
}

export function collectSchemaSnapshot(db:Pick<DatabaseSync,'prepare'>,backendEpoch:string):SchemaSnapshot{
  const rows=db.prepare("SELECT type,name,sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type,name").all() as unknown as SchemaObjectRow[];
  return {
    backend_epoch:backendEpoch,
    objects:rows.map(fingerprintSchemaObject).sort((left,right)=>objectKey(left)<objectKey(right)?-1:objectKey(left)>objectKey(right)?1:0),
  };
}

export function compareSchemaObjects(previous:readonly FingerprintedSchemaObject[],current:readonly FingerprintedSchemaObject[]):SchemaObjectComparison{
  const previousByKey=new Map(previous.map(object=>[objectKey(object),object]));
  const currentByKey=new Map(current.map(object=>[objectKey(object),object]));
  return {
    changed:current.filter(object=>previousByKey.has(objectKey(object))&&previousByKey.get(objectKey(object))!.fingerprint!==object.fingerprint),
    removed:previous.filter(object=>!currentByKey.has(objectKey(object))),
    added:current.filter(object=>!previousByKey.has(objectKey(object))),
  };
}

export function compareSchemaSnapshots(previous:SchemaSnapshot,current:SchemaSnapshot):SchemaComparison{
  if(previous.backend_epoch!==current.backend_epoch){
    return {previousEpoch:previous.backend_epoch,currentEpoch:current.backend_epoch,epochChanged:true,changed:[],removed:[],added:[]};
  }
  return {
    previousEpoch:previous.backend_epoch,
    currentEpoch:current.backend_epoch,
    epochChanged:false,
    ...compareSchemaObjects(previous.objects,current.objects),
  };
}

export function schemaComparisonError(comparison:SchemaComparison):string|undefined{
  if(comparison.epochChanged){
    return `Schema snapshot backend_epoch ${comparison.previousEpoch} does not match the vault backend_epoch ${comparison.currentEpoch}; reset the schema snapshot with ${UPDATE_ENV}=1`;
  }
  const problems:string[]=[];
  if(comparison.changed.length)problems.push(`Existing schema object(s) changed without a backend_epoch bump; bump backend_epoch and reset the schema snapshot: ${objectLabels(comparison.changed)}`);
  if(comparison.removed.length)problems.push(`Existing schema object(s) were removed without a backend_epoch bump; bump backend_epoch and reset the schema snapshot: ${objectLabels(comparison.removed)}`);
  if(comparison.added.length)problems.push(`New schema object(s); update the schema snapshot with ${UPDATE_ENV}=1: ${objectLabels(comparison.added)}`);
  return problems.length?problems.join('\n'):undefined;
}

function readSchemaSnapshot(path:string):SchemaSnapshot|undefined{
  if(!existsSync(path))return undefined;
  const raw=JSON.parse(readFileSync(path,'utf8')) as Partial<SchemaSnapshot>;
  if(typeof raw.backend_epoch!=='string'||!Array.isArray(raw.objects))throw new Error(`Invalid schema snapshot fixture: ${path}`);
  const objects=raw.objects.map(value=>{
    const object=value as Partial<FingerprintedSchemaObject>;
    if(typeof object.type!=='string'||typeof object.name!=='string'||typeof object.fingerprint!=='string'){
      throw new Error(`Invalid schema snapshot object in ${path}`);
    }
    return {type:object.type,name:object.name,fingerprint:object.fingerprint};
  });
  return {backend_epoch:raw.backend_epoch,objects};
}

/** Update mode may grow the snapshot, but it never rewrites an existing
 * fingerprint: that change requires a deliberate backend_epoch reset. */
export function updateSchemaSnapshot(path:string,previous:SchemaSnapshot|undefined,current:SchemaSnapshot){
  if(previous&&previous.backend_epoch===current.backend_epoch){
    const comparison=compareSchemaSnapshots(previous,current);
    if(comparison.changed.length||comparison.removed.length){
      throw new Error(`Refusing to update the schema snapshot at ${path}: ${schemaComparisonError(comparison)}`);
    }
  }
  const temporary=`${path}.tmp`;
  writeFileSync(temporary,`${JSON.stringify(current,null,2)}\n`);
  renameSync(temporary,path);
}

function fixtureConfig(directory:string):Config{
  return {
    dataDir:directory,token:'generated-schema-fingerprint-owner',tokenPath:'fixture',host:'127.0.0.1',port:0,
    maxStorageBytes:30_000_000,maxExportBytes:1_000_000,retentionDays:0,insightIntervalHours:0,allowedOrigins:[],
    model:'fixture',modelBaseUrl:'',apiKey:'',allowUnauthenticatedLocal:false,embeddingModel:'',embeddingBaseUrl:'',
    embeddingApiKey:'',diagnosticsEnabled:false,
  };
}

function generatedSnapshot(backend_epoch:string,objects:SchemaObjectRow[]):SchemaSnapshot{
  return {
    backend_epoch,
    objects:objects.map(fingerprintSchemaObject).sort((left,right)=>objectKey(left)<objectKey(right)?-1:objectKey(left)>objectKey(right)?1:0),
  };
}

const table=(name:string,sql:string):SchemaObjectRow=>({type:'table',name,sql});

test('G3-01: a newly created vault matches the committed schema fingerprint snapshot',async t=>{
  const directory=mkdtempSync(join(tmpdir(),'mote-schema-fingerprint-'));
  const app=await buildApp(fixtureConfig(directory),{
    backgroundWorker:false,
    agent:{configured:false,close:async()=>{},query:async()=>{throw Error('Generated schema fingerprint fixtures never query a model');}},
  });
  t.after(async()=>{await app.app.close();rmSync(directory,{recursive:true,force:true});});
  await app.app.ready();
  // Feature constructors own tables and quota triggers; stats() installs the
  // remaining lazy triggers before the snapshot is taken.
  app.store.stats();
  const epoch=String(app.store.db.prepare("SELECT value FROM settings WHERE key='backend_epoch'").get()?.value??'');
  assert.match(epoch,/\d+/,'A new vault must persist its backend_epoch');
  const current=collectSchemaSnapshot(app.store.db,epoch);
  assert.ok(current.objects.length>0,'A new vault must expose at least one schema object');
  assert.ok(current.objects.every(object=>/^[a-f0-9]{64}$/.test(object.fingerprint)),'Every schema object needs a fingerprint');
  assert.deepEqual([...new Set(current.objects.map(object=>object.type))].sort(),['index','table','trigger','view'],'Tables, indexes, triggers and views all need fingerprints');
  const previous=readSchemaSnapshot(SNAPSHOT_FILE);
  if(process.env[UPDATE_ENV]==='1'){
    updateSchemaSnapshot(SNAPSHOT_FILE,previous,current);
    return;
  }
  assert.ok(previous,`Schema fingerprint snapshot is missing; create it with ${UPDATE_ENV}=1`);
  const error=schemaComparisonError(compareSchemaSnapshots(previous,current));
  assert.equal(error,undefined,error);
});

test('G3-02: whitespace and line breaks do not change a schema fingerprint',()=>{
  const compact=fingerprintSchemaObject(table('generated_table',"CREATE TABLE generated_table(id TEXT PRIMARY KEY,body TEXT NOT NULL DEFAULT 'a  b',score INTEGER CHECK(score>=0))"));
  const formatted=fingerprintSchemaObject(table('generated_table',`
    CREATE   TABLE generated_table (
      id TEXT PRIMARY KEY,
      body TEXT NOT NULL DEFAULT 'a  b',
      score INTEGER CHECK ( score >= 0 )
    )
  `));
  assert.equal(formatted.fingerprint,compact.fingerprint);
  const differentLiteral=fingerprintSchemaObject(table('generated_table',"CREATE TABLE generated_table(id TEXT PRIMARY KEY,body TEXT NOT NULL DEFAULT 'a b',score INTEGER CHECK(score>=0))"));
  assert.notEqual(differentLiteral.fingerprint,compact.fingerprint,'Normalization must not erase meaningful literal whitespace');
});

test('G3-03: adding a column to an existing table without an epoch bump names the table and asks for a new epoch',()=>{
  const previous=generatedSnapshot('7',[table('generated_table','CREATE TABLE generated_table(id TEXT PRIMARY KEY)')]);
  const current=generatedSnapshot('7',[table('generated_table','CREATE TABLE generated_table(id TEXT PRIMARY KEY,added TEXT)')]);
  assert.deepEqual(compareSchemaObjects(previous.objects,current.objects).changed.map(objectLabel),['table:generated_table']);
  const error=schemaComparisonError(compareSchemaSnapshots(previous,current));
  assert.ok(error);assert.match(error,/table:generated_table/);assert.match(error,/bump backend_epoch/);
});

test('G3-04: removing an existing object without an epoch bump fails for the same reason',()=>{
  const previous=generatedSnapshot('7',[table('generated_removed','CREATE TABLE generated_removed(id TEXT)')]);
  const current=generatedSnapshot('7',[]);
  assert.deepEqual(compareSchemaObjects(previous.objects,current.objects).removed.map(objectLabel),['table:generated_removed']);
  const error=schemaComparisonError(compareSchemaSnapshots(previous,current));
  assert.ok(error);assert.match(error,/table:generated_removed/);assert.match(error,/bump backend_epoch/);
});

test('G3-05: a new object asks for a snapshot update instead of an epoch bump',()=>{
  const previous=generatedSnapshot('7',[table('generated_existing','CREATE TABLE generated_existing(id TEXT)')]);
  const current=generatedSnapshot('7',[
    table('generated_existing','CREATE TABLE generated_existing(id TEXT)'),
    table('generated_addition','CREATE TABLE generated_addition(id TEXT)'),
  ]);
  assert.deepEqual(compareSchemaObjects(previous.objects,current.objects).added.map(objectLabel),['table:generated_addition']);
  const error=schemaComparisonError(compareSchemaSnapshots(previous,current));
  assert.ok(error);assert.match(error,/New schema object/);assert.match(error,/table:generated_addition/);
  assert.match(error,/update the schema snapshot/);assert.doesNotMatch(error,/bump backend_epoch/);
});

test('G3-06: changed trigger and index SQL is also detected',()=>{
  const previous=generatedSnapshot('7',[
    {type:'trigger',name:'generated_trigger',sql:'CREATE TRIGGER generated_trigger AFTER INSERT ON generated_table BEGIN SELECT 1; END'},
    {type:'index',name:'generated_index',sql:'CREATE INDEX generated_index ON generated_table(id)'},
  ]);
  const current=generatedSnapshot('7',[
    {type:'trigger',name:'generated_trigger',sql:'CREATE TRIGGER generated_trigger AFTER UPDATE ON generated_table BEGIN SELECT 1; END'},
    {type:'index',name:'generated_index',sql:'CREATE INDEX generated_index ON generated_table(id,added)'},
  ]);
  assert.deepEqual(compareSchemaObjects(previous.objects,current.objects).changed.map(objectLabel).sort(),['index:generated_index','trigger:generated_trigger']);
  const error=schemaComparisonError(compareSchemaSnapshots(previous,current));
  assert.ok(error);assert.match(error,/trigger:generated_trigger/);assert.match(error,/index:generated_index/);assert.match(error,/bump backend_epoch/);
});

test('G3-07: an epoch change ignores the old snapshot and compares against the new epoch',()=>{
  const oldSnapshot=generatedSnapshot('7',[table('generated_table','CREATE TABLE generated_table(id TEXT)')]);
  const current=generatedSnapshot('8',[table('generated_table','CREATE TABLE generated_table(id TEXT,added TEXT)')]);
  const reset=compareSchemaSnapshots(oldSnapshot,current);
  assert.equal(reset.epochChanged,true);assert.deepEqual(reset.changed,[]);assert.deepEqual(reset.removed,[]);assert.deepEqual(reset.added,[]);
  assert.match(schemaComparisonError(reset)!,/backend_epoch 7/);assert.match(schemaComparisonError(reset)!,/backend_epoch 8/);
  const freshSnapshot=generatedSnapshot('8',[table('generated_table','CREATE TABLE generated_table(id TEXT)')]);
  assert.deepEqual(compareSchemaSnapshots(freshSnapshot,current).changed.map(objectLabel),['table:generated_table']);
});

test('G3-08: update mode refuses to write a changed existing fingerprint under the same epoch',t=>{
  const directory=mkdtempSync(join(tmpdir(),'mote-schema-snapshot-update-'));
  t.after(()=>rmSync(directory,{recursive:true,force:true}));
  const path=join(directory,'schema-fingerprint.json');
  const previous=generatedSnapshot('7',[
    table('generated_existing','CREATE TABLE generated_existing(id TEXT)'),
    {type:'index',name:'generated_index',sql:'CREATE INDEX generated_index ON generated_existing(id)'},
  ]);
  writeFileSync(path,`${JSON.stringify(previous,null,2)}\n`);
  const current=generatedSnapshot('7',[
    table('generated_existing','CREATE TABLE generated_existing(id TEXT,changed TEXT)'),
    {type:'index',name:'generated_index',sql:'CREATE INDEX generated_index ON generated_existing(id)'},
    table('generated_new','CREATE TABLE generated_new(id TEXT)'),
  ]);
  const previousEnvironment=process.env[UPDATE_ENV];
  process.env[UPDATE_ENV]='1';
  try{
    assert.throws(()=>updateSchemaSnapshot(path,previous,current),error=>{
      const message=String((error as Error).message);
      return /Refusing to update/.test(message)&&/table:generated_existing/.test(message)&&/bump backend_epoch/.test(message);
    });
  }finally{
    if(previousEnvironment===undefined)delete process.env[UPDATE_ENV];
    else process.env[UPDATE_ENV]=previousEnvironment;
  }
  assert.deepEqual(JSON.parse(readFileSync(path,'utf8')),previous,'The refused update must leave the snapshot untouched');
});

test('G3 update: update mode appends new objects and resets the snapshot for a new epoch',t=>{
  const directory=mkdtempSync(join(tmpdir(),'mote-schema-snapshot-reset-'));
  t.after(()=>rmSync(directory,{recursive:true,force:true}));
  const path=join(directory,'schema-fingerprint.json');
  const previous=generatedSnapshot('7',[table('generated_existing','CREATE TABLE generated_existing(id TEXT)')]);
  writeFileSync(path,`${JSON.stringify(previous,null,2)}\n`);
  const addition=generatedSnapshot('7',[
    table('generated_existing','CREATE TABLE generated_existing(id TEXT)'),
    table('generated_new','CREATE TABLE generated_new(id TEXT)'),
  ]);
  updateSchemaSnapshot(path,previous,addition);
  assert.deepEqual(JSON.parse(readFileSync(path,'utf8')),addition);
  const nextEpoch=generatedSnapshot('8',[table('generated_existing','CREATE TABLE generated_existing(id TEXT,added TEXT)')]);
  updateSchemaSnapshot(path,addition,nextEpoch);
  assert.deepEqual(JSON.parse(readFileSync(path,'utf8')),nextEpoch);
});
