import {pageHash,pageRoutes} from '@mote/shared';
import test from 'node:test';
import assert from 'node:assert/strict';
import {settingsCategoryFromHash,pluginTabFromHash,validatedReturnTarget} from '../src/route-query';
import type {PageEntry,CollectionEntry} from '../src/features/types';
const pages=['ask','activity','settings','archive','extensions','insights','search'].map(id=>({id,route:({ask:pageRoutes.chat,settings:'system/models',archive:'library',extensions:'system/plugins',insights:'library/insights'} as Record<string,string>)[id]??id})) as PageEntry[];
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
 for(const hash of [pageHash('chat',{question:'generated'}),'#/search?query=generated&cursor=generated-page&evidence=material%3Agenerated','#/library?view=materials&cursor=generated-page','#/library?view=materials&memory=generated','#/library?view=materials&selected=capture%3Agenerated','#/library?view=materials&type=image','#/activity?work=generated','#/library?view=files&evidence=generated','#/system/models?category=model','#/library/insights?insight=generated-report'])assert.equal(validatedReturnTarget(hash,pages,collections),hash);
});
test('invalid, removed or mismatched return destinations never gain a fallback link',()=>{
 for(const hash of ['https://example.test','javascript:alert(1)','#//example.test','#/missing',pageHash('chat')+'?selected=capture%3Agenerated',pageHash('chat')+'?query=generated',pageHash('chat')+'?cursor=generated-page','#/search?memory=generated',pageHash('chat')+'?type=image','#/library?type=unknown','#/library?view=missing',pageHash('chat')+'?category=providers',pageHash('chat')+'?work=generated',pageHash('chat')+'?question=a&question=b',pageHash('chat')+'?returnTo=https://example.test',pageHash('chat')+'?insight=generated-report'])assert.equal(validatedReturnTarget(hash,pages,collections),undefined);
 assert.equal(validatedReturnTarget('#/ask?question=generated',pages,collections),undefined);
 assert.equal(validatedReturnTarget(pageHash('chat'),pages.filter(page=>page.id!=='ask'),collections),undefined);
});
