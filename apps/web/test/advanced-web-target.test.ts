import test from 'node:test';
import assert from 'node:assert/strict';
import {recordingToolFromHash,preparationTargetFromHash} from '../src/advanced-web-target';
import {validatedReturnTarget} from '../src/route-query';
import type {PageEntry} from '../src/features/types';
const id='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',other='bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
test('advanced recording targets require the exact capture, canonical page and a single allowed tool',()=>{
 const valid='#/library?evidence=capture%3A'+id+'&recordingTool=speakers';assert.equal(recordingToolFromHash(valid,id),'speakers');
 for(const hash of [valid.replace(id,other),valid+'&recordingTool=compare',valid+'&evidence=capture%3A'+id,valid.replace('speakers','delete'),valid.replace('#/library','#/ask'),valid.replace('capture%3A','memory%3A')])assert.equal(recordingToolFromHash(hash,id),null,hash);
});
test('preparation targets are exact roles for the actual models category and never execution records',()=>{
 for(const [kind,role]of [['audio','dialogue'],['images','ocr'],['images','local-image']] as const)assert.equal(preparationTargetFromHash('#/system/models?category='+kind+'&prepare='+role,kind),role);
 for(const hash of ['#/system/processing?category=audio&prepare=dialogue','#/system/models?category=audio&prepare=ocr','#/system/models?category=images&prepare=speaker','#/system/models?category=audio&prepare=dialogue&prepare=ocr','#/system/models?category=audio&category=images&prepare=dialogue'])assert.equal(preparationTargetFromHash(hash,'audio'),null,hash);
});
test('normal settings return links retain only validated public advanced targets without credentials',()=>{
 const pages=[{id:'archive',route:'library'},{id:'settings',route:'system/models'}] as PageEntry[];
 for(const target of ['#/library?evidence=capture%3A'+id+'&recordingTool=compare','#/system/models?category=audio&prepare=dialogue'])assert.equal(validatedReturnTarget(target,pages,[]),target);
 for(const target of ['https://evil.example/#/library','#/library?evidence=capture%3A'+id+'&recordingTool=execute','#/system/models?category=audio&prepare=local-image','#/system/models?category=audio&prepare=dialogue&loginTicket=forged'])assert.equal(validatedReturnTarget(target,pages,[]),undefined,target);
});
