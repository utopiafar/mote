import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';

test('the shared root does not load rule data; the explicit builtin subpath loads all current rules',()=>{
 const child=spawnSync(process.execPath,['--input-type=module','--eval',`
  import assert from 'node:assert/strict';
  import {registerHooks} from 'node:module';
  let explicit=false,loads=0;
  const hooks=registerHooks({load(url,context,nextLoad){
   if(url.endsWith('/ui-builtins.js')){
    assert.ok(explicit,'importing the shared root must not load or parse builtin UI rules');
    loads++;
   }
   return nextLoad(url,context);
  }});
  const shared=await import('@mote/shared');
  assert.equal(loads,0);
  assert.equal('builtinUiRules' in shared,false);
  explicit=true;
  const {builtinUiRules}=await import('@mote/shared/ui-builtins');
  assert.equal(loads,1);
  assert.equal(builtinUiRules.length,120);
  assert.ok(builtinUiRules.every(rule=>shared.uiRuleSchema.safeParse(rule).success));
  assert.equal((await import('@mote/shared/ui-builtins')).builtinUiRules,builtinUiRules);
  assert.equal(loads,1);
  hooks.deregister();
 `],{cwd:new URL('..',import.meta.url),encoding:'utf8',timeout:120000});
 assert.equal(child.status,0,child.stderr||child.stdout||String(child.error));
});
