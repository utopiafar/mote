import test from 'node:test';
import assert from 'node:assert/strict';
import {configureLocale} from '@mote/shared/i18n';
import {readMemoryHistory,savedMemoryValidAt} from '../src/plugins/memory/index';
import {ApiError,type Api} from '../src/api';
import type {Memory} from '../src/plugins/memory/index';
configureLocale(()=>'zh-CN');
const old={id:'generated-old',title:'Original',status:'published',createdAt:'2026-10-29T01:00:00Z',validFrom:'2026-10-29T08:00:00+08:00',supersededBy:'generated-new',supersededAt:'2026-10-29T02:00:00Z',relations:[{kind:'contradicts',memoryId:'generated-unrelated'}]} as Memory;
const current={id:'generated-new',title:'Correction',status:'published',createdAt:'2026-10-29T03:00:00Z',validFrom:'2026-10-29T02:00:00Z',validUntil:'2026-10-30T02:00:00Z',relations:[{kind:'supersedes',memoryId:old.id}]} as Memory;
test('history follows only explicit replacement identities and uses saved validity with exact offset and exclusive end boundaries',async()=>{
 const reads:string[]=[],api={request:async(path:string)=>{reads.push(path);return path.endsWith(old.id)?old:current;}} as Api;
 const value=await readMemoryHistory(api,old.id,new AbortController().signal);assert.deepEqual(value.items.map(item=>item.id),[current.id,old.id]);assert.deepEqual(reads,['/api/memories/'+old.id,'/api/memories/'+current.id]);assert.equal(value.unavailable.length,0);
 assert.equal(savedMemoryValidAt(old,Date.parse('2026-10-29T00:00:00Z')),true);assert.equal(savedMemoryValidAt(old,Date.parse('2026-10-29T02:00:00.000Z')),false);assert.equal(savedMemoryValidAt(current,Date.parse('2026-10-29T02:00:00.000Z')),true);assert.equal(savedMemoryValidAt(current,Date.parse('2026-10-30T02:00:00.000Z')),false);
});
test('an unavailable predecessor is disclosed without replacing the readable record; an authorization failure never preserves a partial history',async()=>{
 const api={request:async(path:string)=>{if(path.endsWith(current.id))return current;throw new ApiError('Generated deleted old record',404);}} as Api;
 const value=await readMemoryHistory(api,current.id,new AbortController().signal);assert.deepEqual(value.items,[current]);assert.equal(value.unavailable[0].id,old.id);
 const revoked={request:async(path:string)=>{if(path.endsWith(current.id))return current;throw new ApiError('Generated history denied',403);}} as Api;await assert.rejects(readMemoryHistory(revoked,current.id,new AbortController().signal),/Generated history denied/);
});
test('cancelled history ignores a late record and never expands its next explicit reference',async()=>{
 let finish!:(value:Memory)=>void;const pending=new Promise<Memory>(resolve=>finish=resolve),controller=new AbortController(),reads:string[]=[],api={request:async(path:string)=>{reads.push(path);return pending;}} as Api;
 const result=readMemoryHistory(api,old.id,controller.signal);controller.abort();finish(old);await assert.rejects(result);assert.deepEqual(reads,['/api/memories/'+old.id]);
});
