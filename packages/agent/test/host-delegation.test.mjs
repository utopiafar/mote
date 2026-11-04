import test from 'node:test';
import assert from 'node:assert/strict';
import {
  HOST_DELEGATION_CONTROL_DEFINITIONS,HOST_DELEGATION_MAX_DEPTH,
  HostDelegationRegistrationError,HostDelegationScopeError,
  assertHostDelegationCapability,createHostDelegationChannel,narrowHostDelegationScope,
} from '../dist/index.js';

test('capability registration allows only one bounded level with a real host executor',()=>{
 assert.doesNotThrow(()=>assertHostDelegationCapability({id:'context.research',version:'1',execute:async()=>({value:null})}));
 assert.throws(()=>assertHostDelegationCapability({id:'Invalid ID',version:'1',execute:async()=>({value:null})}),HostDelegationRegistrationError);
 assert.throws(()=>assertHostDelegationCapability({id:'context.research',version:'',execute:async()=>({value:null})}),HostDelegationRegistrationError);
 assert.throws(()=>assertHostDelegationCapability({id:'context.research',version:'1'}),HostDelegationRegistrationError);
 assert.throws(()=>assertHostDelegationCapability({id:'context.research',version:'1',maxDepth:HOST_DELEGATION_MAX_DEPTH+1,execute:async()=>({value:null})}),HostDelegationRegistrationError);
});

test('a child scope can narrow time, device and evidence but never widen one bound',()=>{
 const parent={deviceId:'generated-device',after:'2026-01-02T00:00:00Z',before:'2026-02-01T00:00:00Z',evidenceIds:['generated-a','generated-b'],evidenceRanges:[{id:'generated-a',offset:0,length:100}]};
 assert.deepEqual(narrowHostDelegationScope(parent,undefined),parent);
 const narrowed=narrowHostDelegationScope(parent,{deviceId:'generated-device',after:'2026-01-10T00:00:00Z',before:'2026-01-20T00:00:00Z',evidenceIds:['generated-a']});
 assert.equal(narrowed.after,'2026-01-10T00:00:00Z');assert.equal(narrowed.before,'2026-01-20T00:00:00Z');assert.deepEqual(narrowed.evidenceIds,['generated-a']);
 assert.deepEqual(narrowed.evidenceRanges,[{id:'generated-a',offset:0,length:100}]);
 for(const requested of [
  {after:'2026-01-01T00:00:00Z'},{before:'2026-02-02T00:00:00Z'},{deviceId:'generated-other'},
  {evidenceIds:['generated-a','generated-forged']},{evidenceRanges:[{id:'generated-a',offset:0,length:101}]},
  {after:'2026-03-01T00:00:00Z',before:'2026-03-02T00:00:00Z'},
 ])assert.throws(()=>narrowHostDelegationScope(parent,requested),HostDelegationScopeError);
 assert.throws(()=>narrowHostDelegationScope(parent,{after:'not-a-date'}),error=>error.code==='invalid_delegation_arguments');
 assert.throws(()=>narrowHostDelegationScope(parent,{unknown:'generated'}),error=>error.code==='invalid_delegation_arguments');
});

test('the Host channel owns its tool names and argument surface; a filtered surface cannot add delegation tools',async()=>{
 const calls=[];const channel=createHostDelegationChannel({phase:'proposal',execute:async(name,args)=>{calls.push([name,args]);return {data:{saved:true}};}});
 assert.equal(channel.phase,'proposal');assert.deepEqual(channel.definitions,HOST_DELEGATION_CONTROL_DEFINITIONS);
 assert.equal(HOST_DELEGATION_CONTROL_DEFINITIONS.every(tool=>tool.name.startsWith('delegation_')),true);
 assert.deepEqual((await channel.execute('delegation_submit',{units:[]})).data,{saved:true});
 await assert.rejects(channel.execute('delegation_submit',{units:[],scope:{}}),error=>error.code==='invalid_delegation_arguments');
 await assert.rejects(channel.execute('delegation_forged',{}),error=>error.code==='invalid_delegation_arguments');
 const filtered=createHostDelegationChannel({definitions:HOST_DELEGATION_CONTROL_DEFINITIONS.filter(tool=>tool.name!=='delegation_workspace'),execute:async()=>({data:{}})});
 await assert.rejects(filtered.execute('delegation_workspace',{}),error=>error.code==='invalid_delegation_arguments');
 assert.throws(()=>createHostDelegationChannel({definitions:[{name:'delegation_forged',description:'Generated forged control',fields:{}}],execute:async()=>({data:{}})}),HostDelegationRegistrationError);
});
