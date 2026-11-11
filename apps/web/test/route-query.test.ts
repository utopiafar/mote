import test from 'node:test';
import assert from 'node:assert/strict';
import {settingsCategoryFromHash,pluginTabFromHash,validatedReturnTarget} from '../src/route-query';
import type {PageEntry,CollectionEntry} from '../src/features/types';
const pages=['ask','activity','settings','archive','extensions','insights','search'].map(id=>({id,route:({settings:'system/models',archive:'library',extensions:'system/plugins',insights:'library/insights'} as Record<string,string>)[id]??id})) as PageEntry[];
const collections=[{id:'files'},{id:'materials'}] as CollectionEntry[];
test('category and plugin state handle query removal and exact allowlists',()=>{
 assert.equal(settingsCategoryFromHash('#/system/models?category=providers'),'providers');
 assert.equal(settingsCategoryFromHash('#/system/models?category=memory'),'memory');
 assert.equal(settingsCategoryFromHash('#/system/models'),null);
 assert.equal(settingsCategoryFromHash('#/system/models?category=unknown'),null);
 assert.equal(pluginTabFromHash('#/system/plugins?tab=discover'),'discover');
 assert.equal(pluginTabFromHash('#/system/plugins'),'discover');
});
test('contextual task and question returns preserve the registered route and identifier',()=>{
 for(const hash of ['#/ask?question=generated','#/search?query=generated&cursor=generated-page&evidence=material%3Agenerated','#/library?view=materials&cursor=generated-page','#/library?view=materials&memory=generated','#/library?view=materials&selected=capture%3Agenerated','#/library?view=materials&type=image','#/activity?work=generated','#/library?view=files&evidence=generated','#/system/models?category=model','#/library/insights?insight=generated-report'])assert.equal(validatedReturnTarget(hash,pages,collections),hash);
});
test('invalid, removed or mismatched return destinations never gain a fallback link',()=>{
 for(const hash of ['https://example.test','javascript:alert(1)','#//example.test','#/missing','#/ask?selected=capture%3Agenerated','#/ask?query=generated','#/ask?cursor=generated-page','#/search?memory=generated','#/ask?type=image','#/library?type=unknown','#/library?view=missing','#/ask?category=providers','#/ask?work=generated','#/ask?question=a&question=b','#/ask?returnTo=https://example.test','#/ask?insight=generated-report'])assert.equal(validatedReturnTarget(hash,pages,collections),undefined);
 assert.equal(validatedReturnTarget('#/ask',pages.filter(page=>page.id!=='ask'),collections),undefined);
});
