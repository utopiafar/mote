import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Store} from '../src/store.js';
import {MemoryStrategies} from '../src/memory-strategies.js';
import {MemoryRecipeSettings} from '../src/memory-recipe-settings.js';
import {RANGE_SELECTION_PERSONAL_RECIPE,RANGE_SELECTION_CODING_RECIPE,RANGE_SELECTION_DAILY_RECIPE} from '../src/memory-range-selection-policy.js';
import {uiPageCaptureSource} from '../src/capture-memory-source.js';

function fixture(t:import('node:test').TestContext){
  const dir=mkdtempSync(join(tmpdir(),'mote-bounded-defaults-')),store=new Store(dir),strategies=new MemoryStrategies();
  t.after(()=>{store.close();rmSync(dir,{recursive:true,force:true});});
  const capture=uiPageCaptureSource('generated');
  for(const id of ['ordinary','override',capture])store.db.prepare('INSERT INTO source_connections VALUES(?,?)').run(id,JSON.stringify({id,deviceId:'generated'}));
  return {store,strategies,capture};
}

test('fresh defaults select only the current personal and daily-event recipes',t=>{
  const f=fixture(t),settings=new MemoryRecipeSettings(f.store,f.strategies);
  assert.deepEqual(settings.selection().map(b=>({id:b.recipe.id,version:b.recipe.version})),[RANGE_SELECTION_PERSONAL_RECIPE]);
  assert.deepEqual(settings.selection(f.capture).map(b=>({id:b.recipe.id,version:b.recipe.version})),[RANGE_SELECTION_PERSONAL_RECIPE,RANGE_SELECTION_DAILY_RECIPE]);
  assert.ok(settings.selection(f.capture).every(binding=>binding.workContract==='range-evaluation@1'));
  const personal=f.strategies.resolve(RANGE_SELECTION_PERSONAL_RECIPE);
  assert.equal(personal.binding.extract.id,'mote.personal-extraction');
  assert.equal(personal.binding.extract.version,'3');
  assert.equal(personal.binding.review.version,'5');
  assert.equal(personal.binding.workContract,'range-evaluation@1');
  assert.match(personal.extract.prompt,/context_evidence/);assert.match(personal.review.policy,/Use context_evidence yourself/);
  assert.match(personal.extract.prompt,/explicit retrospective interval or year/);assert.match(personal.extract.prompt,/Selection is not incomplete evaluation/);
  const coding=f.strategies.resolve(RANGE_SELECTION_CODING_RECIPE);
  assert.equal(coding.binding.extract.id,'mote.selected-context-extraction');assert.equal(coding.binding.review.version,'3');
  const daily=f.strategies.resolve(RANGE_SELECTION_DAILY_RECIPE);
  assert.equal(daily.binding.extract.version,'2');assert.equal(daily.binding.review.version,'2');
  for(const ref of [{id:'mote.personal-memory',version:'2'},{id:'mote.personal-memory',version:'3'},{id:'mote.personal-memory',version:'4'},{id:'mote.coding-memory',version:'2'},{id:'mote.daily-event-memory',version:'1'}])assert.throws(()=>f.strategies.resolve(ref),/not installed/);
  assert.equal(f.store.db.prepare("SELECT count(*) n FROM sqlite_master WHERE name='memory_input_authorizations'").get()!.n,0,'installation creates no model authority');
});

test('source overrides stay pinned and explicit inheritance returns the current default',t=>{
  const f=fixture(t),settings=new MemoryRecipeSettings(f.store,f.strategies);
  settings.configure({sourceId:'override',recipes:[RANGE_SELECTION_CODING_RECIPE]});
  assert.deepEqual(settings.selection('override').map(binding=>binding.recipe.id),[RANGE_SELECTION_CODING_RECIPE.id]);
  const chosen=settings.selection('override');
  const restarted=new MemoryRecipeSettings(f.store,new MemoryStrategies());
  assert.deepEqual(restarted.selection('override'),chosen,'restart preserves the owner override');
  assert.deepEqual(restarted.selection('ordinary'),[restarted.selection()[0]]);
  restarted.configure({sourceId:'override',recipes:null});
  assert.equal(restarted.view('override').inherited,true);
  assert.deepEqual(restarted.selection('override'),restarted.selection());
  assert.equal(f.store.db.prepare("SELECT count(*) n FROM sqlite_master WHERE name='memory_input_authorizations'").get()!.n,0);
});

test('customized default combinations are preserved across restart',t=>{
  const f=fixture(t),settings=new MemoryRecipeSettings(f.store,f.strategies);
  settings.configure({recipes:[RANGE_SELECTION_PERSONAL_RECIPE,RANGE_SELECTION_CODING_RECIPE]});
  const chosen=settings.selection();
  const restarted=new MemoryRecipeSettings(f.store,new MemoryStrategies());
  assert.deepEqual(restarted.selection(),chosen);
  assert.equal(restarted.selection(f.capture)[0].recipe.version,'5','capture default remains independently established');
});
