import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,rmSync,readFileSync,realpathSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';
import {moduleReferences,checkArchitecture} from './architecture.mjs';

const cli=fileURLToPath(new URL('./architecture.mjs',import.meta.url));
const repository=fileURLToPath(new URL('../..',import.meta.url));
function fixture(t){
  const root=realpathSync(mkdtempSync(join(tmpdir(),'mote-architecture-')));
  t.after(()=>rmSync(root,{recursive:true,force:true}));
  const write=(path,text)=>{mkdirSync(join(root,path,'..'),{recursive:true});writeFileSync(join(root,path),text);};
  write('tsconfig.json',JSON.stringify({compilerOptions:{module:'ESNext',moduleResolution:'Bundler',baseUrl:'.',paths:{'@agent-entry':['packages/agent/src/index.ts'],'@host/*':['apps/server/src/*']}}}));
  write('packages/agent/src/index.ts','export const value=1; export interface Shape {}');
  write('packages/agent/src/consumer.ts','export const ready=true;');
  write('apps/server/src/index.ts',"import {buildApp} from './app.js'; buildApp();");
  write('apps/server/src/app.ts','export interface QueryAgent {} export const buildApp=()=>{};');
  write('apps/server/src/domain.ts',"const domainSql='DELETE FROM domain_rows WHERE id = ?'; export {domainSql};");
  write('apps/desktop/src/contracts.ts',"export type {AskCommand} from './contracts/ask';");
  write('apps/desktop/src/contracts/ask.ts',"export type AskCommand='start';");
  write('apps/desktop/src/ask.ts',"export const run=()=>{}; export type AskCommand='start';");
  write('apps/web/src/main.tsx',"import './features/bootstrap';");
  write('apps/web/src/features/bootstrap.tsx',"import {view} from './runtime'; export const ready=Promise.resolve(view);");
  write('apps/web/src/features/runtime.tsx','export const view=()=>null;');
  write('apps/web/src/features/entries.ts','export const entries=[];');
  write('apps/web/src/consumer.ts',"import {view} from './features/runtime'; export {view};");
  const current=JSON.parse(readFileSync(new URL('../../packages/shared/package.json',import.meta.url),'utf8'));
  const exports=Object.fromEntries(Object.keys(current.exports).map(name=>[name,{import:name==='./config-file'?'./dist/config-file.js':'./dist/index.js'}]));
  write('packages/shared/package.json',JSON.stringify({name:'@mote/shared',exports}));
  write('packages/shared/src/index.ts',"export * from './browser-helper.js'; export type {Configuration} from './config-file.js';");
  write('packages/shared/src/browser-helper.ts','export const browserValue=1;');
  write('packages/shared/src/config-file.ts',"import {readFileSync} from 'node:fs'; export interface Configuration {} export {readFileSync};");
  write('scripts/ci/architecture-baseline.json','[]');
  return {root,write,check:baseline=>checkArchitecture(root,baseline??[]),run:()=>spawnSync(process.execPath,[cli],{cwd:root,encoding:'utf8'})};
}
const rule=result=>result.violations.map(issue=>issue.rule);

test('AST classifies explicit type dependencies separately from runtime aliases, exports, require and dynamic import',()=>{
  const source=`
    import type {Shape as Renamed} from './one';
    import {type Shape,type Other as Alias} from './two';
    import {type Shape,value as runtimeAlias} from './three';
    import './four';
    export type * from './five';
    export {type Shape as Alias} from './six';
    export {type Shape,value as renamedValue} from './seven';
    export * as namespace from './eight';
    type Inline = typeof import('./nine').value;
    import type OldShape = require('./ten');
    import OldRuntime = require('./eleven');
    const target='./twelve' as const; const alias=target; await import(alias);
    const load=require; load('./thirteen');
    // import('./not-a-module');
    const prose="import('./also-not-a-module')";
  `;
  assert.deepEqual(moduleReferences('generated.ts',source).map(({specifier,kind})=>[specifier,kind]),[
    ['./one','type'],['./two','type'],['./three','runtime'],['./four','runtime'],['./five','type'],['./six','type'],['./seven','runtime'],['./eight','runtime'],['./nine','type'],['./ten','type'],['./eleven','runtime'],['./twelve','runtime'],['./thirteen','runtime'],
  ]);
  assert.equal(moduleReferences('generated.d.ts',"import {Shape} from './one'; export {Shape};")[0].kind,'type');
});

test('Agent runtime import cycles are rejected while erased type cycles stay valid',t=>{
  const f=fixture(t);
  f.write('packages/agent/src/cycle-a.ts',"import './cycle-b.js'; export const a=1;");
  f.write('packages/agent/src/cycle-b.ts',"import './cycle-a.js'; export const b=1;");
  const cyclic=f.check();
  assert.deepEqual(rule(cyclic),['agent-import-cycle']);
  assert.equal(cyclic.violations[0].kind,'runtime');
  const chain=cyclic.violations[0].chain;
  assert.ok(chain.includes('packages/agent/src/cycle-a.ts')&&chain.includes('packages/agent/src/cycle-b.ts'));
  assert.equal(chain[0],chain.at(-1));
  f.write('packages/agent/src/cycle-b.ts',"import type {a} from './cycle-a.js'; export const b=1;");
  assert.deepEqual(f.check().violations,[]);
});

test('every runtime assembly syntax is rejected, including tsconfig aliases and computed constant paths',async t=>{
  const sources=[
    "import './index.js';",
    "import {value as alias} from './index.js'; alias();",
    "export * from './index.js';",
    "export {value as alias} from './index.js';",
    "export * as namespace from './index.js';",
    "await import('./index.js');",
    "const target='./ind'+'ex.js'; const alias=target; await import(alias);",
    "import {value} from '@agent-entry';",
    "require('./index.js');",
    "const load=require; load('./index.js');",
  ];
  for(const source of sources)await t.test(source,t=>{
    const f=fixture(t);f.write('packages/agent/src/consumer.ts',source);
    const result=f.check();assert.deepEqual(rule(result),['agent-no-assembly-import']);
    assert.equal(result.violations[0].to,'packages/agent/src/index.ts');
  });
});

test('erased type edges, legal Server composition and domain SQL remain valid',t=>{
  const f=fixture(t);
  f.write('packages/agent/src/consumer.ts',"import type {Shape} from '@agent-entry'; export {type Shape as Alias} from './index.js'; export type * from './index.js'; type Inline=import('./index.js').Shape;");
  f.write('apps/server/src/domain.ts',"import {type QueryAgent} from './app.js'; type Agent=typeof import('./app.js').buildApp; const sql='DELETE FROM domain_rows';");
  assert.deepEqual(f.check().violations,[]);
});

test('Server domain aliases and re-export barrels cannot import runtime assembly',t=>{
  const f=fixture(t);
  f.write('apps/server/src/domain.ts',"export {buildApp as build} from '@host/app';");
  assert.deepEqual(rule(f.check()),['server-no-assembly-import']);
  f.write('apps/server/src/domain.ts',"export * from './index.js';");
  assert.deepEqual(rule(f.check()),['server-no-assembly-import']);
});

test('Desktop contracts allow domain leaves and external DTOs, but reject implementation types and runtime imports',t=>{
  const f=fixture(t);
  f.write('apps/desktop/src/contracts/ask.ts',"import type {DiagnosticsStatus} from '@mote/diagnostics'; export type AskCommand='start';");
  assert.deepEqual(f.check().violations,[]);
  f.write('apps/desktop/src/contracts/ask.ts',"export type {AskCommand} from '../ask';");
  assert.deepEqual(rule(f.check()),['desktop-contract-leaf']);
  assert.equal(f.check().violations[0].kind,'type');
  f.write('apps/desktop/src/contracts/ask.ts',"import {run} from '../ask'; export {run};");
  assert.deepEqual(rule(f.check()),['desktop-contract-leaf']);
  assert.equal(f.check().violations[0].kind,'runtime');
});

test('Web consumers can import view runtime; bootstrap and builtin assembly stay at their owners',t=>{
  const f=fixture(t);assert.deepEqual(f.check().violations,[]);
  f.write('apps/web/src/consumer.ts',"export * from './features/bootstrap';");
  assert.deepEqual(rule(f.check()),['web-no-bootstrap-import']);
  f.write('apps/web/src/consumer.ts',"import {view} from './features/runtime'; export {view};");
  f.write('apps/web/src/features/runtime.tsx',"export * from './entries';");
  assert.deepEqual(rule(f.check()),['web-runtime-no-builtins']);
});

test('Web locale boot may load main while consumers and boot cannot bypass main assembly',t=>{
  const f=fixture(t);
  f.write('apps/web/src/boot.ts',"void import('./main');");
  assert.deepEqual(f.check().violations,[]);
  f.write('apps/web/src/consumer.ts',"void import('./main');");
  let result=f.check();
  assert.deepEqual(rule(result),['web-no-bootstrap-import']);
  assert.equal(result.violations[0].from,'apps/web/src/consumer.ts');
  f.write('apps/web/src/consumer.ts',"import './boot';");
  result=f.check();
  assert.deepEqual(rule(result),['web-no-bootstrap-import']);
  assert.equal(result.violations[0].to,'apps/web/src/boot.ts');
  f.write('apps/web/src/consumer.ts','export {};');
  f.write('apps/web/src/boot.ts',"void import('./features/bootstrap');");
  assert.deepEqual(rule(f.check()),['web-no-bootstrap-import']);
});

test('browser export graphs follow runtime barrels to Node builtins while ignoring erased and unused Node-only entries',t=>{
  const f=fixture(t);assert.deepEqual(f.check().violations,[]);
  f.write('packages/shared/src/browser-helper.ts',"export * from './barrel.js';");
  f.write('packages/shared/src/barrel.ts',"export {readFileSync} from 'fs';");
  let result=f.check();assert.deepEqual(rule(result),['browser-no-node']);
  assert.deepEqual(result.violations[0].chain,['packages/shared/src/index.ts','packages/shared/src/browser-helper.ts','packages/shared/src/barrel.ts','fs']);
  f.write('packages/shared/src/barrel.ts',"export type {Stats} from 'node:fs';");
  assert.deepEqual(f.check().violations,[]);
  f.write('apps/web/src/consumer.ts',"import type {Configuration} from '@mote/shared/config-file';");
  assert.deepEqual(f.check().violations,[]);
  f.write('apps/web/src/consumer.ts',"const selected='@mote/shared/config-file'; await import(selected);");
  result=f.check();assert.deepEqual(rule(result),['browser-no-node']);
  assert.equal(result.violations[0].from,'packages/shared/src/config-file.ts');
});

test('workspace main and conditional root exports resolve without builds; external DTO type imports stay erased',t=>{
  const f=fixture(t);
  f.write('packages/diagnostics/package.json',JSON.stringify({name:'@mote/diagnostics',main:'dist/index.js'}));
  f.write('packages/diagnostics/src/index.ts',"import {platform} from 'node:os'; export interface DiagnosticsStatus {} export {platform};");
  f.write('apps/web/src/consumer.ts',"import type {DiagnosticsStatus} from '@mote/diagnostics';");
  assert.deepEqual(f.check().violations,[]);
  f.write('apps/web/src/consumer.ts',"export {platform} from '@mote/diagnostics';");
  assert.deepEqual(rule(f.check()),['browser-no-node']);
  for(const exports of ['./dist/index.js',{import:'./dist/index.js'}]){
    f.write('packages/diagnostics/package.json',JSON.stringify({name:'@mote/diagnostics',exports}));
    assert.deepEqual(rule(f.check()),['browser-no-node']);
  }
});

test('nested workspace npm declarations and JavaScript stay outside the repository source graph',t=>{
  const f=fixture(t);
  f.write('apps/server/node_modules/generated-types/package.json',JSON.stringify({name:'generated-types',types:'index.d.ts'}));
  f.write('apps/server/node_modules/generated-types/index.d.ts',"export type {ThirdParty} from './not-a-repository-source';");
  f.write('apps/server/src/domain.ts',"import type {ThirdParty} from 'generated-types';");
  f.write('packages/agent/node_modules/generated-runtime/package.json',JSON.stringify({name:'generated-runtime',main:'index.js'}));
  f.write('packages/agent/node_modules/generated-runtime/index.js','export const load=target=>import(target);');
  f.write('packages/agent/src/consumer.ts',"import 'generated-runtime';");
  f.write('apps/web/node_modules/generated-browser/package.json',JSON.stringify({name:'generated-browser',main:'index.js'}));
  f.write('apps/web/node_modules/generated-browser/index.js',"import 'node:fs';");
  f.write('apps/web/src/consumer.ts',"import 'generated-browser'; import {browserValue} from '@mote/shared';");
  assert.deepEqual(f.check().violations,[]);
});

test('exceptions apply to exact edge and kind, reject duplicates, and must be removed after the edge is fixed',t=>{
  const f=fixture(t);f.write('packages/agent/src/consumer.ts',"import './index.js';");
  const issue=f.check().violations[0],exception={rule:issue.rule,from:issue.from,to:issue.to,kind:issue.kind,reason:'Generated existing debt'};
  let result=f.check([exception]);assert.deepEqual(result.violations,[]);assert.equal(result.exceptions.length,1);
  f.write('packages/agent/src/another.ts',"import './index.js';");
  result=f.check([exception]);assert.equal(result.violations.length,1);assert.equal(result.violations[0].from,'packages/agent/src/another.ts');
  f.write('packages/agent/src/another.ts','export {};');
  f.write('packages/agent/src/consumer.ts',"export type {Shape} from './index.js';");
  result=f.check([exception]);assert.deepEqual(result.violations,[]);assert.deepEqual(result.stale,[exception]);
  assert.throws(()=>f.check([exception,exception]),/unique concrete edge/);
  assert.throws(()=>f.check([{...exception,reason:''}]),/require a reason/);
});

test('unresolved local and computed modules fail visibly; syntax errors do not become empty green graphs',t=>{
  const f=fixture(t);
  f.write('packages/agent/src/consumer.ts',"import './missing.js';");
  assert.deepEqual(rule(f.check()),['resolve-local-module']);
  f.write('packages/agent/src/consumer.ts',"export const load=(target:string)=>import(target);");
  assert.deepEqual(rule(f.check()),['analyzable-module-reference']);
  f.write('packages/agent/src/consumer.ts',"const target='./index.js'; export const load=(target:string)=>import(target);");
  assert.deepEqual(rule(f.check()),['analyzable-module-reference'],'a shadowing parameter is not a constant module target');
  f.write('packages/agent/src/consumer.ts',"import '@mote/shared/not-an-export';");
  assert.deepEqual(rule(f.check()),['resolve-local-module']);
  f.write('packages/agent/src/consumer.ts','export const = ;');
  assert.throws(()=>f.check(),/generated|consumer\.ts/);
});

test('actual CLI fails a controlled browser leak, then passes the same fixture after a type-only correction',t=>{
  const f=fixture(t);
  f.write('packages/shared/src/browser-helper.ts',"export {Stats} from 'node:fs';");
  const failed=f.run();assert.equal(failed.status,1);assert.match(failed.stderr,/browser-no-node.*node:fs/);assert.doesNotMatch(failed.stdout,/passed/);
  f.write('packages/shared/src/browser-helper.ts',"export type {Stats} from 'node:fs';");
  const passed=f.run();assert.equal(passed.status,0,passed.stderr);assert.match(passed.stdout,/Architecture boundaries passed/);
});

test('Server plugins cannot import Store by value or type, and exceptions go stale when only Store is removed',t=>{
  const f=fixture(t);
  f.write('apps/server/src/store.ts','export class Store {} export class StoreError {}');
  f.write('apps/server/src/plugins/example.ts',"import {StoreError} from '../store.js'; export const error=StoreError;");
  assert.deepEqual(f.check().violations,[]);
  f.write('apps/server/src/plugins/example.ts',"import {Store} from '../store.js'; export const store=new Store();");
  let result=f.check();
  assert.deepEqual(rule(result),['server-plugins-no-store']);
  assert.equal(result.violations[0].kind,'runtime');
  f.write('apps/server/src/plugins/example.ts',"import {Store as Borrowed} from '../store.js'; export const store=new Borrowed();");
  assert.deepEqual(rule(f.check()),['server-plugins-no-store']);
  f.write('apps/server/src/plugins/example.ts',"import * as store from '../store.js'; export const concrete=store.Store;");
  assert.deepEqual(rule(f.check()),['server-plugins-no-store']);
  f.write('apps/server/src/plugins/example.ts',"import type {Store} from '../store.js'; export type Borrowed=Store;");
  result=f.check();
  assert.deepEqual(rule(result),['server-plugins-no-store']);
  assert.equal(result.violations[0].kind,'type');
  f.write('apps/server/src/plugins/example.ts',"import {StoreError,type Store} from '../store.js'; export type Borrowed=Store; export const error=StoreError;");
  const exception={...f.check().violations[0],reason:'Existing Vault boundary debt'};
  f.write('apps/server/src/plugins/example.ts',"import {StoreError} from '../store.js'; export const error=StoreError;");
  result=f.check([exception]);
  assert.deepEqual(result.violations,[]);
  assert.deepEqual(result.stale,[exception]);
  assert.throws(()=>f.check([exception,exception]),/unique concrete edge/);
});

test('repository boundaries pass with only exact reviewed existing exceptions',()=>{
  const result=checkArchitecture(repository);
  assert.deepEqual(result.violations,[]);assert.deepEqual(result.stale,[]);
});
