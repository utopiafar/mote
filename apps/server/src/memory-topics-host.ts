import {AsyncLocalStorage} from 'node:async_hooks';
import type {QueryInput} from '@mote/agent';
import type {QueryResult} from '@mote/shared';
import {TOPIC_CLASSIFICATION_INSTRUCTION,topicClassificationSchema,type AutomaticTopics} from './automatic-topics.js';
import {type BackgroundModelAuthorization,type ModelConnection} from './background-model-authorization.js';
import type {ModelAuthorizationHost} from './model-authorization-host.js';
import {ExecutionEngine,ExecutionFailure,type ExecutionStep} from './execution-engine.js';
import {EXECUTION_POLICIES} from './execution-policy.js';
import type {Memory} from './memory-schema.js';
import {memoryBodyDigest} from './memory-provider-contract.js';
import {sha256,type Store} from './store.js';
import type {MemoryStore} from './memory.js';

type Selection={profileId:string;model:string;connection:ModelConnection};
type Pin={id:string;version:number;fingerprint:string;digest:string};
type Input={parentId:string;selection:Selection;memories:Pin[]};
const pin=(memory:Memory):Pin=>({id:memory.id,version:memory.version,fingerprint:memory.fingerprint,digest:memoryBodyDigest(memory)});
const classifierId='mote.memory-topics';

/** A durable dependent of the publishing Memory task. No timer, GET, retry or
 * recovery path creates admission or consumes fresh original triggers. */
export class MemoryTopicsHost {
 private context=new AsyncLocalStorage<{input:Input;assert:()=>void}>();
 private disposers:Array<()=>void|Promise<void>>=[];
 constructor(private options:{store:Store;memories:MemoryStore;executor:ExecutionEngine;control:BackgroundModelAuthorization;host:ModelAuthorizationHost;topics:AutomaticTopics;assertReadable:(memories:Memory[])=>void;select:(profileId?:string,model?:string)=>Selection;query:(input:QueryInput)=>Promise<QueryResult>}){
  const {topics,executor,control,host}=options;
  this.disposers.push(topics.register({id:classifierId,version:'1',classify:async({memories,signal})=>{
   const context=this.context.getStore();if(!context)throw new ExecutionFailure('blocked','topic_admission_missing');
   context.assert();host.assertEvidence(memories.flatMap(memory=>memory.evidenceIds));
   const input:QueryInput={question:TOPIC_CLASSIFICATION_INSTRUCTION+'\n'+JSON.stringify(memories.map(memory=>({id:memory.id,title:memory.title,statement:memory.statement,uncertainty:memory.uncertainty,attribution:memory.admission?.attribution}))),modelProfileId:context.input.selection.profileId,modelOverride:context.input.selection.model,signal,assertContextAuthority:context.assert};
   const result=await options.query(input);context.assert();return topicClassificationSchema.parse(JSON.parse(result.answer));
  }}));
  this.disposers.push(executor.register({kind:'memory.topics',pool:'memory.topics',concurrency:()=>1,policy:EXECUTION_POLICIES.modelCall,
   validate:step=>this.current(step),
   execute:async(step,signal,grant)=>{
    const input=step.input as unknown as Input,admissionId=control.currentId;
    if(!admissionId)throw new ExecutionFailure('blocked','topic_admission_missing');
    const assert=()=>{grant.assert();if(!this.current(step))throw new ExecutionFailure('stale','topic_input_changed');control.assertCurrent({id:input.selection.connection.id,fingerprint:input.selection.connection.fingerprint});const memories=input.memories.map(saved=>options.memories.get(saved.id));options.assertReadable(memories);host.assertEvidence(memories.flatMap(memory=>memory.evidenceIds));};
    assert();return this.context.run({input,assert},()=>topics.classify({operationId:step.id,classifierId,memoryIds:input.memories.map(memory=>memory.id)},{admissionId,signal,assertCurrent:assert}));
   },commit:()=>{},classify:error=>error instanceof ExecutionFailure?error:new ExecutionFailure('blocked','topic_classification_failed'),
  }));
 }
 private current(step:ExecutionStep){
  try{const input=step.input as unknown as Input,selected=this.options.select(input.selection.profileId,input.selection.model);
   return selected.profileId===input.selection.profileId&&selected.model===input.selection.model&&selected.connection.id===input.selection.connection.id&&selected.connection.fingerprint===input.selection.connection.fingerprint&&input.memories.every(saved=>{const current=pin(this.options.memories.get(saved.id));return current.id===saved.id&&current.version===saved.version&&current.fingerprint===saved.fingerprint&&current.digest===saved.digest;});
  }catch{return false;}
 }
 enqueue(parent:ExecutionStep,memories:readonly Memory[],profileId?:string,model?:string){
  const {store,executor,control}=this.options;
  if(!store.db.isTransaction)throw Error('Topic dependent work requires the Memory publication transaction');
  // A local fixture/manual store write is not an admitted model task.
  if(!control.stepAuthority(parent.id))return;
  const selected=this.options.select(profileId,model),published=memories.filter(memory=>memory.status==='published'&&!memory.supersededBy).sort((a,b)=>a.id.localeCompare(b.id));
  for(let offset=0;offset<published.length;offset+=100){
   const input:Input={parentId:parent.id,selection:selected,memories:published.slice(offset,offset+100).map(pin)},id='memory-topics:'+sha256(JSON.stringify([parent.id,input]));
   executor.enqueue(parent.operationId,'memory.topics',input as unknown as Record<string,unknown>,{id,dependencies:[parent.id],optional:true});
   control.inheritStep(parent.id,id);
  }
 }
 async close(){for(const dispose of this.disposers.reverse())await dispose();}
}
