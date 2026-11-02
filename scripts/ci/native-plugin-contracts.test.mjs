import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {checkArchitecture} from './architecture.mjs';
import {affectedComponents} from '../release/affected-components.mjs';
import {selectScopes,automaticTasks} from './select.mjs';

/** Generated source trees use the merged H07 scanner and workspace exports. */
function fixture(t){
  const root=mkdtempSync(join(tmpdir(),'mote-native-plugin-contracts-'));
  t.after(()=>rmSync(root,{recursive:true,force:true}));
  const write=(path,text)=>{mkdirSync(join(root,path,'..'),{recursive:true});writeFileSync(join(root,path),text);};
  write('tsconfig.json',JSON.stringify({compilerOptions:{module:'ESNext',moduleResolution:'Bundler'}}));
  write('packages/plugin-sdk/package.json',JSON.stringify({name:'@mote/plugin-sdk',exports:{
    '.':{import:'./dist/browser.js'},
    './browser':{import:'./dist/browser.js'},
  }}));
  write('packages/plugin-sdk/src/browser.ts','export const value=1;\n');
  write('apps/server/src/app.ts','export const buildApp=()=>{};\n');
  write('scripts/ci/architecture-baseline.json','[]');
  return {root,write,check:(baseline=[])=>checkArchitecture(root,baseline)};
}

const rules=result=>result.violations.map(issue=>issue.rule);

test('public SDK runtime cannot reverse-import app assembly; exact baseline exception is removable',t=>{
  const f=fixture(t);
  f.write('packages/plugin-sdk/src/browser.ts',"export {buildApp} from '../../../apps/server/src/app.js';\n");
  const result=f.check(),issue=result.violations[0];
  assert.deepEqual(rules(result),['sdk-public-boundary']);
  assert.equal(issue.from,'packages/plugin-sdk/src/browser.ts');
  assert.equal(issue.to,'apps/server/src/app.ts');
  const exception={rule:issue.rule,from:issue.from,to:issue.to,kind:issue.kind,reason:'Generated exact existing debt'};
  const allowed=f.check([exception]);
  assert.deepEqual(allowed.violations,[]);
  assert.equal(allowed.exceptions.length,1);
  assert.deepEqual({rule:allowed.exceptions[0].rule,from:allowed.exceptions[0].from,to:allowed.exceptions[0].to,kind:allowed.exceptions[0].kind,reason:allowed.exceptions[0].reason},
    {rule:issue.rule,from:issue.from,to:issue.to,kind:issue.kind,reason:exception.reason});
  f.write('packages/plugin-sdk/src/browser.ts','export const value=1;\n');
  const stale=f.check([exception]);
  assert.deepEqual(stale.violations,[]);
  assert.deepEqual(stale.stale,[exception],'a resolved edge must not remain a permanent allowlist entry');
});

test('public SDK browser entry rejects Node runtime edges while keeping erased type imports legal',t=>{
  const f=fixture(t);
  f.write('packages/plugin-sdk/src/browser.ts',"export {readFileSync} from 'node:fs';\n");
  const leaked=f.check();
  assert.deepEqual(rules(leaked),['browser-no-node']);
  assert.deepEqual(leaked.violations[0].chain,['packages/plugin-sdk/src/browser.ts','node:fs']);
  f.write('packages/plugin-sdk/src/browser.ts',"import type {Stats} from 'node:fs'; export type {Stats};\n");
  assert.deepEqual(f.check().violations,[]);
});

test('affected selection routes new plugin paths to their real consumers, never heavy suites',()=>{
  const api=affectedComponents(['packages/plugin-api/src/index.ts']);
  assert.deepEqual(api,{central:true,desktop:false,android:false,protocol:false,tooling:true});
  const host=affectedComponents(['packages/plugin-host/src/host.ts']);
  assert.deepEqual(host,{central:true,desktop:false,android:false,protocol:false,tooling:true});
  const sdk=affectedComponents(['packages/plugin-sdk/src/browser.ts']);
  assert.deepEqual(sdk,{central:false,desktop:false,android:false,protocol:false,tooling:true});
  for(const path of ['packages/plugin-api/src/index.ts','packages/plugin-host/src/host.ts']){
    const selection=selectScopes([path]);
    assert.deepEqual(selection,{scopes:['server','tooling'],fallback:[],serverGroups:['all']},path);
    const tasks=automaticTasks(selection).tasks;
    assert.ok(tasks.includes('server-build')&&tasks.includes('server-4'),path);
    assert.ok(!tasks.some(task=>/benchmark|scale|recovery/.test(task)),path);
  }
  assert.deepEqual(selectScopes(['packages/plugin-sdk/src/browser.ts']),{scopes:['tooling'],fallback:[]});
  assert.deepEqual(automaticTasks(selectScopes(['packages/plugin-sdk/src/browser.ts'])).tasks,['architecture','tooling']);
});
